/*
  Mock obs-websocket v5 server, used to validate the deck's connection logic
  without OBS installed. It speaks the real handshake:

    op 0 Hello (version, rpcVersion, optional salt+challenge)
    op 1 Identify (rpcVersion, optional authentication)
    op 2 Identified
    op 5 Event
    op 6 Request
    op 7 RequestResponse
    op 9 AuthenticationFailure

  Auth uses the real algorithm from the obs-websocket protocol reference:

    authentication = base64(sha256(base64(sha256(password + salt)) + challenge))

  Usage:  node tools/mock-obs.mjs [port] [password]
*/
import { createHash, randomBytes } from 'node:crypto';
import { createRawWSServer } from './raw-ws.mjs';

const PORT = Number(process.argv[2] || 4455);
const PASSWORD = process.argv[3] ?? 'test-password';

// base64, not hex — this is what real obs-websocket requires.
const sha256 = (t) => createHash('sha256').update(t).digest('base64');

const SCENES = ['CAM TALK', 'DAW & CODE', 'AI LAB', 'BRB'];

// The deck only ever assigns this to img.src, so a tiny valid data URL suffices.
const FAKE_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL' +
  'DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
  'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function startMockObs({ port = PORT, password = PASSWORD } = {}) {
  const clients = new Set();
  const shared = {
    program: SCENES[0],
    transition: 'Fade',
    duration: 300,
    studioMode: true,
    streaming: false,
    recording: false,
    paused: false,
  };

  function broadcast(eventType, eventData) {
    for (const ws of clients) {
      if (ws.readyState === 1 && ws.authed) {
        ws.send(JSON.stringify({ op: 5, d: { eventType, eventIntent: 1, eventData } }));
      }
    }
  }

  function handleRequest(ws, requestType, requestData) {
    const ok = (responseData = {}) => ({ result: true, responseData });

    switch (requestType) {
      case 'GetSceneList':
        return ok({
          currentProgramSceneName: shared.program,
          currentPreviewSceneName: shared.program,
          scenes: SCENES.map((sceneName) => ({ sceneName, sceneIndex: SCENES.indexOf(sceneName) })),
        });

      case 'SetCurrentProgramScene': {
        if (!SCENES.includes(requestData.sceneName)) {
          return { result: false, comment: `No scene named ${requestData.sceneName}` };
        }
        shared.program = requestData.sceneName;
        broadcast('CurrentProgramSceneChanged', { sceneName: shared.program });
        return ok();
      }

      case 'GetTransitionList':
        return ok({
          currentSceneTransitionName: shared.transition,
          transitions: [
            { transitionName: 'Cut', transitionKind: 'cut', transitionFixed: true },
            { transitionName: 'Fade', transitionKind: 'fade', transitionFixed: false },
            { transitionName: 'Stinger', transitionKind: 'stinger', transitionFixed: false },
          ],
        });

      case 'SetCurrentSceneTransition':
        shared.transition = requestData.transitionName;
        return ok();

      case 'SetCurrentSceneTransitionDuration':
        shared.duration = requestData.transitionDuration;
        return ok();

      case 'TriggerStudioModeTransition':
        if (!shared.studioMode) return { result: false, comment: 'Studio mode is not enabled' };
        return ok();

      case 'GetStudioModeEnabled':
        return ok({ studioModeEnabled: shared.studioMode });

      case 'SetStudioModeEnabled':
        shared.studioMode = !!requestData.studioModeEnabled;
        return ok();

      case 'StartStream':
        if (shared.streaming) return { result: false, comment: 'Stream already active' };
        shared.streaming = true;
        return ok();

      case 'StopStream':
        if (!shared.streaming) return { result: false, comment: 'Stream is not active' };
        shared.streaming = false;
        return ok();

      case 'GetRecordStatus':
        return ok({ outputActive: shared.recording, outputPaused: shared.paused, outputTimecode: '00:00:00.000' });

      case 'StartRecord':
        shared.recording = true;
        return ok();

      case 'StopRecord':
        shared.recording = false;
        return ok();

      case 'PauseRecord':
        shared.paused = true;
        return ok();

      case 'ResumeRecord':
        shared.paused = false;
        return ok();

      case 'GetSourceScreenshot':
        if (!SCENES.includes(requestData.sourceName)) {
          return { result: false, comment: `No source named ${requestData.sourceName}` };
        }
        return ok({ imageData: FAKE_JPEG });

      default:
        return { result: false, comment: `Unsupported request type: ${requestType}` };
    }
  }

  const server = createRawWSServer({ host: '0.0.0.0', port });

  server.on('connection', (ws) => {
    const salt = randomBytes(16).toString('base64');
    const challenge = randomBytes(16).toString('base64');
    ws.authed = false;

    ws.send(
      JSON.stringify({
        op: 0,
        d: {
          obsWebSocketVersion: '5.5.2',
          rpcVersion: 1,
          ...(password ? { authentication: { challenge, salt } } : {}),
        },
      })
    );

    ws.on('message', (text) => {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return log('ignoring malformed JSON');
      }

      if (msg.op === 1) {
        const d = msg.d || {};
        if (d.rpcVersion !== 1) {
          return log(`rejecting rpcVersion ${d.rpcVersion}`);
        }
        if (password) {
          const expected = sha256(sha256(password + salt) + challenge);
          if (d.authentication !== expected) {
            log('identify REJECTED: bad password');
            ws.send(JSON.stringify({ op: 9, d: { obsWebSocketVersion: '5.5.2', rpcVersion: 1 } }));
            ws.close(4009, 'Authentication failed.');
            return;
          }
        }
        ws.authed = true;
        clients.add(ws);
        log('identify OK: auth accepted');
        ws.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }

      if (msg.op === 6) {
        if (!ws.authed) return log('request before identify, ignored');
        const { requestType, requestId, requestData } = msg.d;
        const { result, responseData, comment } = handleRequest(ws, requestType, requestData || {});
        log(`request ${requestType} -> ${result ? 'ok' : `FAIL (${comment})`}`);
        ws.send(
          JSON.stringify({
            op: 7,
            d: {
              requestType,
              requestId,
              requestStatus: result ? { result: true, code: 100 } : { result: false, code: 600, comment },
              responseData: responseData || {},
            },
          })
        );
        return;
      }

      log('unhandled op', msg.op);
    });

    ws.on('close', (e) => {
      clients.delete(ws);
      log(`client disconnected (code ${e && e.code})`);
    });
  });

  return new Promise((resolve) => {
    server.on('listening', () => {
      log(`mock OBS WebSocket listening on 0.0.0.0:${port}` + (password ? ` (password required)` : ' (no password)'));
      resolve({ server, close: () => server.close(), shared, SCENES, PASSWORD: password });
    });
  });
}

// Only self-start when run directly, so the test harness can import it.
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/mock-obs.mjs')) {
  startMockObs();
}
