/*
  Confirm the custom domain is served by Vercel (through Cloudflare) and read
  the deck's own mixed-content guard from the live bytes.
*/

async function headers(url, extra = {}) {
  const res = await fetch(url, { redirect: 'manual', ...extra });
  const buf = Buffer.from(await res.arrayBuffer());
  return { res, buf };
}

console.log('=== remote.krezna.web.id response headers (cache-bypassed) ===');
const { res, buf } = await headers('https://remote.krezna.web.id/?cb=' + Date.now(), {
  headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
});
for (const k of ['server', 'x-vercel-id', 'x-vercel-cache', 'x-vercel-execution-region', 'cf-ray', 'cf-cache-status', 'age', 'content-type']) {
  console.log(`  ${k.padEnd(26)}: ${res.headers.get(k)}`);
}
console.log(`  body length               : ${buf.length}`);

console.log('\n=== the deck\'s own mixed-content guard, read from the LIVE bytes ===');
const text = buf.toString('utf8');
const marker = 'This page is served over HTTPS';
const idx = text.indexOf(marker);
if (idx >= 0) {
  console.log('  found the guard:');
  console.log('   ', text.slice(idx, idx + 190).replace(/\s+/g, ' '));
} else {
  console.log('  guard text NOT found');
}
console.log('\n  live page decides isHttps from location.protocol:');
const protoLine = text.split('\n').find((l) => l.includes('isHttps=location.protocol'));
console.log('   ', (protoLine || '(not found)').trim());
console.log('\n  default websocket target logic:');
for (const l of text.split('\n')) {
  if (l.includes('function defaultUrl')) console.log('    (definition follows)');
}
const dflt = text.match(/function defaultUrl\(\)\{[\s\S]{0,120}?\}/);
console.log('   ', dflt ? dflt[0].replace(/\s+/g, ' ') : '(not found)');

console.log('\n=== sibling host status ===');
for (const u of ['https://remote-obs.krezna.web.id/', 'https://obs-deck.krezna.web.id/']) {
  try {
    const r = await fetch(u, { redirect: 'manual' });
    const b = Buffer.from(await r.arrayBuffer());
    console.log(`  ${u.padEnd(40)} -> ${r.status}  ${b.length} bytes`);
  } catch (e) {
    console.log(`  ${u.padEnd(40)} -> error: ${e.message}`);
  }
}
