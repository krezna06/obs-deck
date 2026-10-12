/*
  How is remote.krezna.web.id actually served now, and where does it point?
*/
import { promises as dns } from 'node:dns';

async function show(url) {
  const res = await fetch(url, { redirect: 'manual' });
  const buf = Buffer.from(await res.arrayBuffer());
  const pick = (k) => res.headers.get(k);
  console.log(`\n=== ${url} ===`);
  console.log(`status        : ${res.status} ${res.statusText}`);
  console.log(`server        : ${pick('server')}`);
  console.log(`x-served-by   : ${pick('x-served-by')}`);
  console.log(`x-cache       : ${pick('x-cache')}`);
  console.log(`via           : ${pick('via')}`);
  console.log(`content-type  : ${pick('content-type')}`);
  console.log(`content-length: ${pick('content-length')}  (body ${buf.length})`);
  console.log(`x-github-req  : ${pick('x-github-request-id')}`);
  console.log(`location      : ${pick('location')}`);
  console.log(`csp           : ${pick('content-security-policy')}`);
  console.log(`cache-control : ${pick('cache-control')}`);
  return buf;
}

const live = await show('https://remote.krezna.web.id/');
const gh = await show('https://krezna06.github.io/obs-deck/');

console.log(`\nlive bytes == github pages bytes : ${live.equals(gh)}`);

console.log('\n=== DNS ===');
for (const name of ['remote.krezna.web.id', 'krezna06.github.io']) {
  try {
    const cname = await dns.resolveCname(name);
    console.log(`CNAME ${name} -> ${JSON.stringify(cname)}`);
  } catch (e) {
    console.log(`CNAME ${name} -> (${e.code})`);
  }
  try {
    const a = await dns.resolve4(name);
    console.log(`A     ${name} -> ${JSON.stringify(a)}`);
  } catch (e) {
    console.log(`A     ${name} -> (${e.code})`);
  }
}

console.log('\n=== certificate ===');
try {
  const tls = await import('node:tls');
  await new Promise((resolve) => {
    const s = tls.connect({ host: 'remote.krezna.web.id', port: 443, servername: 'remote.krezna.web.id' }, () => {
      const c = s.getPeerCertificate();
      console.log(`subject CN : ${c.subject?.CN}`);
      console.log(`issuer     : ${c.issuer?.O} / ${c.issuer?.CN}`);
      console.log(`SAN        : ${JSON.stringify(c.subjectaltname)}`);
      console.log(`valid to   : ${c.valid_to}`);
      s.end();
      resolve();
    });
    s.on('error', (e) => { console.log('tls error:', e.message); resolve(); });
  });
} catch (e) {
  console.log('cert check failed:', e.message);
}
