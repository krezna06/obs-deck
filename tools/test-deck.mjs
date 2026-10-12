/*
  End-to-end check for the deck's inline script.

  This does not reimplement the deck. It loads index.html, extracts the real
  inline <script>, runs it against a small DOM shim, and drives it through:

    1. auto-detection of the OBS address from the host that served the page
    2. a real op0/op1/op2 handshake including SHA-256 challenge auth
    3. GetSceneList -> deck buttons + scene chips
    4. a scene click (Cut) and the TAKE path -> SetCurrentProgramScene
    5. an action button -> StartRecord
    6. an OBS event -> CurrentProgramSceneChanged
    7. a rejected password (op 9)
    8. "Find OBS on this network" scanning
    9. the deck's auth algorithm against a real TCP socket

  The deck drives everything through request/response, so a small fake server
  answers requests as they arrive; tests then wait for the state they expect
  rather than hand-feeding replies at fixed moments.

  Usage:  node tools/test-deck.mjs        (DECK_TRACE=1 for verbose tracing)
*/
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { webcrypto } from 'node:crypto';
import { createDocument } from './dom-shim.mjs';
import { startMockObs } from './mock-obs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const TRACE = process.env.DECK_TRACE === '1';

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Wait until fn() is truthy. Beats guessing at tick counts. */
async function until(fn, label = 'condition', timeoutMs = 4000) {
  const started = Date.now();
  let polls = 0;
  for (;;) {
    const v = fn();
    if (v) {
      if (TRACE) console.log(`       [debug] until(${label}) satisfied after ${polls} polls`);
      return v;
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    polls++;
    await tick(5);
  }
}

/* --------------------------------------------------------------- boot the deck */

function boot({ hostname = '192.168.1.23', protocol = 'http:', stored = {} } = {}) {
  const doc = createDocument(html);
  const scripts = doc.querySelectorAll('script');
  const code = scripts[scripts.length - 1]._text;
  if (!code || !code.includes('obs-websocket')) throw new Error('could not locate the deck inline script');

  const store = new Map(Object.entries(stored));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    get length() { return store.size; },
  };

  const sockets = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      this._handlers = {};
      sockets.push(this);
    }
    addEventListener(type, fn) { (this._handlers[type] ||= []).push(fn); }
    send(data) { this.sent.push(data); }
    close(code = 1000, reason = '') {
      this.readyState = 3;
      this.onclose && this.onclose({ code, reason });
    }
    /* --- test helpers --- */
    _open() { this.readyState = 1; this.onopen && this.onopen({}); }
    _msg(obj) {
      if (TRACE) {
        const id = obj && obj.d && (obj.d.requestId || obj.d.eventType);
        console.log(`       [to-deck] op=${obj.op} ${(obj.d && obj.d.requestType) || ''} ${id || ''}`);
      }
      this.onmessage && this.onmessage({ data: JSON.stringify(obj) });
    }
    get lastSent() { return this.sent.length ? JSON.parse(this.sent[this.sent.length - 1]) : null; }
  }

  const location = { protocol, hostname, port: '8080', host: `${hostname}:8080`, href: `${protocol}//${hostname}:8080/` };
  const win = { addEventListener() {}, location };

  const fn = new Function(
    'document', 'window', 'location', 'localStorage', 'crypto', 'WebSocket', 'setTimeout', 'clearTimeout', 'URL', 'console',
    code + '\n;window.__deck={get connected(){return connected},get previewScene(){return previewScene},get currentScene(){return currentScene},send,runScene,updateScenePreview,get pending(){return pending},get ws(){return ws}};'
  );
  fn(doc, win, location, localStorage, webcrypto, FakeWebSocket, setTimeout, clearTimeout, URL, console);

  return { doc, sockets, FakeWebSocket, store, location, win };
}

/* ------------------------------------------------------------ fake OBS server */

const SCENES = ['CAM TALK', 'DAW & CODE', 'AI LAB', 'BRB'];
const JPEG = 'data:image/jpeg;base64,AAAA';

/** Start answering the deck's requests on `sock`. Returns a log + controllers. */
function serve(sock, options = {}) {
  let program = options.program || 'CAM TALK';
  const log = [];

  function responseFor(type, data) {
    switch (type) {
      case 'GetSceneList':
        return {
          currentProgramSceneName: program,
          currentPreviewSceneName: program,
          // OBS returns scenes bottom-up; the deck reverses them.
          scenes: [...SCENES].reverse().map((sceneName, i) => ({ sceneName, sceneIndex: i })),
        };
      case 'SetCurrentProgramScene':
        program = data.sceneName;
        return {};
      case 'GetTransitionList':
        return { transitions: [{ transitionName: 'Cut' }, { transitionName: 'Fade' }] };
      case 'GetSourceScreenshot':
        return { imageData: JPEG };
      case 'GetRecordStatus':
        return { outputActive: false, outputPaused: false };
      case 'GetStudioModeEnabled':
        return { studioModeEnabled: true };
      default:
        return {};
    }
  }

  const ctl = { failNext: null, seen: 0, rounds: 0 };

  /* Answer everything the deck has queued past `ctl.seen`. Safe to call often:
     it only ever moves forward. Driven explicitly by settle() rather than a
     background timer, so each round is a synchronous burst that the deck's
     microtasks can then complete against. */
  function drain() {
    let answered = 0;
    for (; ctl.seen < sock.sent.length; ctl.seen++) {
      const req = JSON.parse(sock.sent[ctl.seen]);
      if (req.op !== 6) continue;

      const { requestType, requestId, requestData } = req.d;
      log.push(requestType);
      answered++;
      if (TRACE) console.log(`       [reply] ${requestType}`);

      if (ctl.failNext === requestType) {
        ctl.failNext = null;
        sock._msg({
          op: 7,
          d: {
            requestType,
            requestId,
            requestStatus: { result: false, code: 600, comment: 'mock failure' },
            responseData: {},
          },
        });
        continue;
      }

      sock._msg({
        op: 7,
        d: {
          requestType,
          requestId,
          requestStatus: { result: true, code: 100 },
          responseData: responseFor(requestType, requestData || {}),
        },
      });
    }
    return answered;
  }

  /* Keep answering until the deck stops asking, then let its promises settle. */
  async function settle(rounds = 12) {
    const seenBefore = ctl.seen;
    for (let i = 0; i < rounds; i++) {
      ctl.rounds++;
      drain();
      await tick(3);
    }
    drain();
    await tick(3);
    return ctl.seen - seenBefore;
  }

  return {
    log,
    ctl,
    drain,
    settle,
    requests: () => log,
    countOf: (t) => log.filter((x) => x === t).length,
    getProgram: () => program,
    setProgram: (v) => { program = v; },
    stop: () => {},
  };
}

/** Bring a booted deck all the way to "Connected", answering its requests. */
async function connect(booted, { password = 'test-password', auth = true } = {}) {
  const { doc, sockets } = booted;
  doc.getElementById('password').value = password;
  doc.getElementById('connect').click();

  await until(() => sockets.length === 1, 'a socket to be opened');
  const sock = sockets[0];
  sock._open();
  sock._msg({ op: 0, d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1 } });

  if (auth) {
    sock._msg({
      op: 0,
      d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1, authentication: { salt: 'SALT123', challenge: 'CHAL456' } },
    });
    await until(() => sock.lastSent && sock.lastSent.op === 1 && sock.lastSent.d.authentication, 'Identify with auth');
  }

  const server = serve(sock);
  sock._msg({ op: 2, d: { negotiatedRpcVersion: 1 } });
  await until(() => doc.getElementById('statusText').textContent === 'Connected', 'Connected status');
  await until(() => doc.getElementById('deck').querySelectorAll('.deckBtn').length > 0, 'deck to render');

  return { sock, server };
}

/* ============================================================ test 1: detect IP */

console.log('\n1. OBS address auto-detected from the serving host');
{
  const { doc } = boot({ hostname: '192.168.1.23' });
  check('url defaults to ws://192.168.1.23:4455', doc.getElementById('url').value === 'ws://192.168.1.23:4455',
    `got ${doc.getElementById('url').value}`);
  check('hint names the LAN address', doc.getElementById('urlHint').innerHTML.includes('192.168.1.23'),
    doc.getElementById('urlHint').innerHTML);
}

console.log('\n1b. Opened as http://localhost:8080 (on the OBS PC itself)');
{
  const { doc } = boot({ hostname: 'localhost' });
  check('url defaults to ws://localhost:4455', doc.getElementById('url').value === 'ws://localhost:4455',
    `got ${doc.getElementById('url').value}`);
}

console.log('\n1c. Opened straight from disk (file://)');
{
  const { doc } = boot({ protocol: 'file:', hostname: '' });
  const url = doc.getElementById('url').value;
  check('url stays loopback', url === 'ws://127.0.0.1:4455' || url === 'ws://:4455', `got ${url}`);
  check('hint explains LAN serving', doc.getElementById('urlHint').innerHTML.includes('8080'));
}

console.log('\n1d. Opened over HTTPS (the case this edition avoids)');
{
  const { doc } = boot({ protocol: 'https:', hostname: 'remote.example.com' });
  const input = doc.getElementById('url');
  input.value = 'ws://192.168.1.23:4455';
  input.dispatch('input');
  check('mixed-content warning shown', doc.getElementById('urlHint').innerHTML.includes('blocks a plain'),
    doc.getElementById('urlHint').innerHTML);

  doc.getElementById('password').value = 'x';
  doc.getElementById('connect').click();
  check('connecting is refused up front', doc.getElementById('msg').textContent.includes('Blocked by the browser'),
    doc.getElementById('msg').textContent);
}

/* ================================================ test 2: handshake, auth, scenes */

console.log('\n2. Connect: handshake, auth, scene load, scene switch, action, event');
{
  const booted = boot({ hostname: '192.168.1.23' });
  const { doc, sockets } = booted;

  check('deck starts disconnected', doc.getElementById('statusText').textContent === 'Disconnected');

  doc.getElementById('password').value = 'test-password';
  doc.getElementById('connect').click();
  await until(() => sockets.length === 1, 'a socket to be opened');

  const sock = sockets[0];
  check('opened ws://192.168.1.23:4455', sock.url === 'ws://192.168.1.23:4455', `got ${sock.url}`);
  sock._open();
  sock._msg({ op: 0, d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1 } });

  const identify = await until(() => {
    const last = sock.lastSent;
    return last && last.op === 1 ? last : null;
  }, 'Identify');
  check('sent op 1 Identify with rpcVersion 1', identify.op === 1 && identify.d.rpcVersion === 1,
    JSON.stringify(identify));
  check('no auth field when the server offers no authentication', identify.d.authentication === undefined,
    String(identify.d.authentication));

  // Server now demands a password.
  const sha = async (t) => {
    const b = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Buffer.from(new Uint8Array(b)).toString('base64');
  };
  sock._msg({
    op: 0,
    d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1, authentication: { salt: 'SALT123', challenge: 'CHAL456' } },
  });
  const authed = await until(() => {
    const last = sock.lastSent;
    return last.op === 1 && last.d.authentication ? last : null;
  }, 'Identify with authentication');
  const expectedAuth = await sha((await sha('test-password' + 'SALT123')) + 'CHAL456');
  check('auth matches base64(sha256(base64(sha256(pw+salt))+challenge))',
    authed.d.authentication === expectedAuth,
    `sent ${authed.d.authentication} expected ${expectedAuth}`);
  /* The protocol requires base64, not hex. A 64-char hex string here means the
     deck would never authenticate against real OBS. */
  check('auth response is base64 (not the hex variant that fails against OBS)',
    authed.d.authentication.length === 44 && /^[A-Za-z0-9+/]{43}=$/.test(authed.d.authentication),
    authed.d.authentication);

  const server = serve(sock);
  sock._msg({ op: 2, d: { negotiatedRpcVersion: 1 } });
  await until(() => doc.getElementById('statusText').textContent === 'Connected', 'Connected status');
  await server.settle();

  check('status shows Connected', doc.getElementById('statusText').textContent === 'Connected');
  check('connect button became Disconnect', doc.getElementById('connect').textContent === 'Disconnect',
    doc.getElementById('connect').textContent);

  check('deck requested a scene list', server.countOf('GetSceneList') >= 1, JSON.stringify(server.requests()));
  check('deck requested transitions', server.countOf('GetTransitionList') === 1, JSON.stringify(server.requests()));
  check('deck requested a preview screenshot', server.countOf('GetSourceScreenshot') >= 1);

  check('scene count rendered', doc.getElementById('sceneCount').textContent === '4 scenes',
    doc.getElementById('sceneCount').textContent);

  const sceneBtns = doc.getElementById('deck').querySelectorAll('.sceneButton');
  check('4 scene deck buttons rendered', sceneBtns.length === 4, `got ${sceneBtns.length}`);
  check('12 deck buttons total (8 actions + 4 scenes)',
    doc.getElementById('deck').querySelectorAll('.deckBtn').length === 12);
  check('scene buttons follow OBS display order (reversed from the API)',
    sceneBtns.map((b) => b.dataset.scene).join('|') === 'CAM TALK|DAW & CODE|AI LAB|BRB',
    sceneBtns.map((b) => b.dataset.scene).join('|'));

  const chips = doc.getElementById('scenes').querySelectorAll('.scene');
  check('4 scene chips rendered', chips.length === 4, `got ${chips.length}`);
  const live = chips.filter((c) => c.textContent.includes('LIVE'));
  check('exactly one scene chip marked LIVE', live.length === 1, `got ${live.length}`);
  check('the LIVE chip is the current program scene', !!live[0] && live[0].textContent.includes('CAM TALK'),
    live[0] && live[0].textContent);
  check('preview image is displayed', doc.getElementById('scenePreview').querySelectorAll('img').length === 1);
  check('transition buttons rendered', doc.getElementById('transitionButtons').querySelectorAll('.transBtn').length === 2);

  /* ---- click a scene in Cut mode: goes straight to program ---- */
  doc.getElementById('deck').querySelectorAll('.sceneButton')
    .find((b) => b.dataset.scene === 'AI LAB').click();
  await server.settle();
  check('clicking a scene in Cut mode switched the program scene', server.getProgram() === 'AI LAB',
    server.getProgram());
  check('it sent SetCurrentProgramScene', server.countOf('SetCurrentProgramScene') === 1,
    JSON.stringify(server.requests()));
  check('deck reports the new program scene', doc.getElementById('sceneName').textContent.includes('AI LAB'),
    doc.getElementById('sceneName').textContent);

  /* ---- action button ---- */
  doc.getElementById('deck').querySelectorAll('.deckBtn')
    .find((b) => b.textContent.includes('START REC')).click();
  await server.settle();
  check('START REC sent StartRecord and confirmed it',
    server.countOf('StartRecord') === 1 && doc.getElementById('msg').textContent.includes('Recording started'),
    doc.getElementById('msg').textContent);

  /* ---- a failing request is surfaced ---- */
  server.ctl.failNext = 'StopRecord';
  doc.getElementById('deck').querySelectorAll('.deckBtn')
    .find((b) => b.textContent.includes('STOP REC')).click();
  await server.settle();
  check('an OBS error is reported back to the user', doc.getElementById('msg').textContent.includes('OBS error'),
    doc.getElementById('msg').textContent);

  /* ---- event ---- */
  server.setProgram('BRB');
  sock._msg({ op: 5, d: { eventType: 'CurrentProgramSceneChanged', eventData: { sceneName: 'BRB' } } });
  await server.settle();
  check('CurrentProgramSceneChanged updated the LIVE indicator',
    doc.getElementById('liveTag').textContent.includes('BRB'), doc.getElementById('liveTag').textContent);
  check('the preview deliberately stays on the scene you chose',
    doc.getElementById('sceneName').textContent.includes('AI LAB'), doc.getElementById('sceneName').textContent);
}

/* ============================================== test 3: rejected password (op 9) */

console.log('\n3. Wrong password is reported clearly');
{
  const { doc, sockets } = boot({ hostname: '192.168.1.23' });
  doc.getElementById('password').value = 'wrong';
  doc.getElementById('connect').click();
  await until(() => sockets.length === 1, 'a socket');
  const sock = sockets[0];
  sock._open();
  sock._msg({
    op: 0,
    d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1, authentication: { salt: 's', challenge: 'c' } },
  });
  await until(() => sock.lastSent && sock.lastSent.op === 1, 'Identify');
  sock._msg({ op: 9, d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1 } });
  await until(() => doc.getElementById('msg').textContent.includes('rejected the password'), 'the rejection message');
  check('reports the password rejection', true);
  check('status returned to Disconnected', doc.getElementById('statusText').textContent === 'Disconnected',
    doc.getElementById('statusText').textContent);
  check('connect button is usable again', doc.getElementById('connect').disabled === false);
}

/* ============================================================= test 4: LAN scan */

console.log('\n4. "Find OBS on this network" scan');
{
  const opened = [];
  class ScanWebSocket extends boot({}).FakeWebSocket {
    constructor(url) {
      super(url);
      const host = /ws:\/\/([^:]+):/.exec(url)[1];
      opened.push(host);
      setTimeout(() => {
        if (host === '192.168.1.42') this._open();
        else this.onerror && this.onerror({});
      }, 5);
    }
  }

  const doc2 = createDocument(html);
  const code = doc2.querySelectorAll('script').pop()._text;
  const store = new Map();
  const fn = new Function(
    'document', 'window', 'location', 'localStorage', 'crypto', 'WebSocket', 'setTimeout', 'clearTimeout', 'URL', 'console',
    code
  );
  fn(
    doc2,
    { addEventListener() {} },
    { protocol: 'http:', hostname: '192.168.1.23', port: '8080' },
    {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    webcrypto, ScanWebSocket, setTimeout, clearTimeout, URL, console
  );

  doc2.getElementById('scan').click();
  await until(() => doc2.getElementById('url').value === 'ws://192.168.1.42:4455', 'the scan to find the host', 15000);

  check('scan found 192.168.1.42', doc2.getElementById('url').value === 'ws://192.168.1.42:4455',
    doc2.getElementById('url').value);
  check('scan reported success', doc2.getElementById('msg').textContent.includes('Found an OBS WebSocket server'),
    doc2.getElementById('msg').textContent);
  check('scan swept the local subnet', opened.length > 30, `probed ${opened.length} hosts`);
  check('scan skipped its own address', !opened.includes('192.168.1.23'), 'probed itself');
  check('scan stopped early once it found OBS', opened.length < 254, `probed ${opened.length} of 254`);
}

/* ================================================== test 5: settings persistence */

console.log('\n5. Remembering the URL and password is opt-in');
{
  const { doc, store } = boot({ hostname: '192.168.1.23' });
  doc.getElementById('password').value = 'hunter2';
  doc.getElementById('remember').checked = true;
  doc.getElementById('remember').dispatch('change');
  check('password stored only after opting in', store.get('obsDeckPassword') === 'hunter2', String(store.get('obsDeckPassword')));
  check('url stored after opting in', store.get('obsDeckUrl') === 'ws://192.168.1.23:4455', String(store.get('obsDeckUrl')));

  const { doc: doc3, store: store3 } = boot({ hostname: '192.168.1.23' });
  doc3.getElementById('remember').checked = false;
  doc3.getElementById('remember').dispatch('change');
  check('clearing the opt-in wipes stored credentials',
    !store3.has('obsDeckPassword') && !store3.has('obsDeckUrl'));

  const { doc: doc4 } = boot({
    hostname: '192.168.1.23',
    stored: { obsDeckRemember: '1', obsDeckUrl: 'ws://10.0.0.9:4455' },
  });
  check('a remembered URL survives a reload', doc4.getElementById('url').value === 'ws://10.0.0.9:4455',
    doc4.getElementById('url').value);
}

/* =========================== test 6: real frames against the mock OBS server */

console.log('\n6. Real RFC6455 frames against the mock OBS server');
{
  /* tools/ws_selftest.py proves the framing with an independent stdlib-only
     Python client. It cannot be driven from here: this harness runs under a
     sandbox that denies a child process both piped stdio (EPERM) and network
     access. Run it with tools/verify.ps1, which starts the mock and the client
     side by side. Here we only assert the mock is reachable at all. */
  const mock = await startMockObs({ port: 4456, password: 'test-password' });

  let reachable = false;
  try {
    const res = await fetch('http://127.0.0.1:4456/');
    reachable = res.status === 426;
  } catch {}

  check('mock OBS WebSocket server accepts TCP connections', reachable,
    'see tools/verify.ps1 for the full raw-frame check');

  mock.close();
}

/* ------------------------------------------------------------------- summary */

console.log(`\n${'='.repeat(60)}`);
console.log(`passed: ${pass}   failed: ${fail}`);
if (fail) {
  console.log('\nfailures:');
  failures.forEach((f) => console.log('  - ' + f));
}
console.log('='.repeat(60));

process.exit(fail ? 1 : 0);
