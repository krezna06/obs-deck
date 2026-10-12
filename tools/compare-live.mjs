/*
  Compare live remote.krezna.web.id against the obs-deck repository revisions,
  byte for byte. Uses Node's fetch so the bytes are not re-encoded by PowerShell.
*/
import { createHash } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');

const sha = (b) => createHash('sha256').update(b).digest('hex');

async function grab(url) {
  const res = await fetch(url, { redirect: 'follow' });
  const buf = Buffer.from(await res.arrayBuffer());
  return { url, status: res.status, buf, len: buf.length, sha: sha(buf) };
}

function stats(buf) {
  const t = buf.toString('utf8');
  return {
    hexAuth: t.includes('padStart(2,"0")'),
    base64Auth: t.includes('btoa('),
    // the fixed version wraps the digest in a binary string loop
    binaryLoop: t.includes('String.fromCharCode'),
    audioFix: t.includes('loadedmetadata'),
    webAudio: t.includes('AudioContext'),
    cacheBustV3: t.includes('?v=3'),
    cacheBustV2: t.includes('?v=2'),
    audioFile: t.includes('Cilukba.mp3'),
    serverIsHttpsHint: t.includes('wss://your-tunnel-address'),
    kreznaWord: /krezna/i.test(t),
    title: (t.match(/<title>([^<]*)<\/title>/) || [])[1] || null,
    lines: t.split('\n').length,
    lfOnly: (t.match(/\n/g) || []).length - (t.match(/\r\n/g) || []).length,
    crlf: (t.match(/\r\n/g) || []).length,
  };
}

console.log('Fetching live site and repository revisions...\n');

const live = await grab('https://remote.krezna.web.id/');
const repoIndex = await grab('https://raw.githubusercontent.com/krezna06/obs-deck/main/index.html');
const repoProto = await grab('https://raw.githubusercontent.com/krezna06/obs-deck/main/prototype.html');
const localIndex = readFileSync(join(repo, 'index.html'));
const localProto = readFileSync(join(repo, 'prototype.html'));

const rows = [
  ['live remote.krezna.web.id', live.buf],
  ['repo main/index.html', repoIndex.buf],
  ['repo main/prototype.html', repoProto.buf],
  ['local index.html', localIndex],
  ['local prototype.html', localProto],
];

console.log('sha256 (first 16)   bytes  lines  crlf  source');
console.log('-'.repeat(78));
for (const [name, buf] of rows) {
  const s = stats(buf);
  console.log(
    `${sha(buf).slice(0, 16)}  ${String(buf.length).padStart(6)}  ${String(s.lines).padStart(5)}  ${String(s.crlf).padStart(4)}  ${name}`
  );
}

console.log('\n--- feature markers ---');
console.log('source'.padEnd(30), 'hex  b64  binLoop audioFix webAudio v2 v3 audioFile httpsHint');
for (const [name, buf] of rows) {
  const s = stats(buf);
  const y = (b) => (b ? ' Y ' : ' . ');
  console.log(
    name.padEnd(30),
    y(s.hexAuth), y(s.base64Auth), y(s.binaryLoop), y(s.audioFix), y(s.webAudio), y(s.cacheBustV2), y(s.cacheBustV3), y(s.audioFile), y(s.serverIsHttpsHint)
  );
}

console.log('\n--- verdicts ---');
const eq = (a, b) => sha(a) === sha(b);
console.log(`live  ==  repo main/index.html      : ${eq(live.buf, repoIndex.buf)}`);
console.log(`live  ==  repo main/prototype.html  : ${eq(live.buf, repoProto.buf)}`);
console.log(`live  ==  local index.html          : ${eq(live.buf, localIndex)}`);
console.log(`live  ==  local prototype.html      : ${eq(live.buf, localProto)}`);
console.log(`repo  prototype == previous obs-deck index.html release: ${eq(repoProto.buf, localProto)}`);

// Where do live and repo/prototype actually diverge?
const liveText = live.buf.toString('utf8');
const protoText = repoProto.buf.toString('utf8');
if (liveText !== protoText) {
  const a = liveText.split('\n');
  const b = protoText.split('\n');
  console.log(`\n--- live vs repo prototype divergence ---`);
  console.log(`line counts: live=${a.length} proto=${b.length}`);
  let shown = 0;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max && shown < 12; i++) {
    if (a[i] !== b[i]) {
      shown++;
      console.log(`  line ${i + 1}:`);
      console.log(`    live : ${(a[i] ?? '<none>').trim().slice(0, 120)}`);
      console.log(`    proto: ${(b[i] ?? '<none>').trim().slice(0, 120)}`);
    }
  }
  if (shown === 0) console.log('  no line-by-line differences found (only encoding?)');
}

writeFileSync(join(here, '..', '.live-remote.html'), live.buf);
console.log('\nSaved live copy to .live-remote.html for inspection.');
