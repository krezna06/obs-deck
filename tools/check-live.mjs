/*
  Check what the public deployments are actually serving, and whether they can
  work at all.

  This exists because the deck has a hard constraint that is invisible from the
  repository: browsers forbid an https:// page from opening a plain ws:// socket
  to a non-loopback host, and OBS speaks plain ws:// with no TLS. So any HTTPS
  deployment serves the UI correctly and still cannot connect to OBS.

  Usage:  node tools/check-live.mjs
          node tools/check-live.mjs http://192.168.1.23:8080   # check your LAN host too
*/
import { createHash } from 'node:crypto';

const sha = (b) => createHash('sha256').update(b).digest('hex');

const TARGETS = [
  ['GitHub Pages (https)', 'https://krezna06.github.io/obs-deck/'],
  ['Vercel (https)', 'https://obs-deck.vercel.app/'],
  ['custom domain (https+cloudflare)', 'https://remote.krezna.web.id/'],
  ...process.argv.slice(2).map((u) => [`LAN host (${u})`, u]),
];

async function probe(url) {
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      status: res.status,
      len: buf.length,
      sha: sha(buf).slice(0, 16),
      text: buf.toString('utf8'),
      server: res.headers.get('server'),
      vercel: res.headers.get('x-vercel-id'),
      secure: url.startsWith('https:'),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

console.log('What each deployment serves\n');
console.log('deployment'.padEnd(34), 'status  bytes   sha               connects to OBS?');
console.log('-'.repeat(100));

const results = [];
for (const [label, url] of TARGETS) {
  const r = await probe(url);
  results.push([label, url, r]);
  if (!r.ok) {
    console.log(`${label.padEnd(34)} ${'--'.padEnd(7)} ${''.padEnd(7)} ${''.padEnd(17)} unreachable (${r.error})`);
    continue;
  }
  const isDeck = r.text.includes('Stream Deck-style OBS WebSocket controller');
  const verdict = !isDeck
    ? 'not the deck'
    : r.secure
      ? 'NO - https blocks ws://'
      : 'yes, on the LAN';
  console.log(
    `${label.padEnd(34)} ${String(r.status).padEnd(7)} ${String(r.len).padEnd(7)} ${r.sha.padEnd(17)} ${verdict}`
  );
}

console.log('\nServers:');
for (const [label, , r] of results) {
  if (r.ok) console.log(`  ${label.padEnd(34)} server=${r.server || '-'} vercel=${r.vercel || '-'}`);
}

const served = results.filter(([, , r]) => r.ok && r.text.includes('Stream Deck-style OBS WebSocket controller'));
if (served.length > 1) {
  const hashes = new Set(served.map(([, , r]) => r.sha));
  console.log(`\nAll ${served.length} deployments serve the ${hashes.size === 1 ? 'SAME' : 'DIFFERENT'} build (${[...hashes].join(', ')})`);
}

console.log('\nConclusion:');
console.log('  The deck works only when served over plain http on the LAN, because OBS');
console.log('  WebSocket is a plain ws:// endpoint. The HTTPS deployments above render');
console.log('  the UI but cannot open a ws:// socket to a device on your network.');
