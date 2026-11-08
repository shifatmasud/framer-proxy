// Live test against the real Framer origin, through the local stand-in for Vercel.
import assert from 'node:assert/strict';
import { startServer } from './local-server.mjs';
import { runVideoTests } from './video-cache.mjs';

const PORT = 8787;
const P = `http://localhost:${PORT}`;
const server = await startServer(PORT);
const results = [];
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]); }
  catch (e) { results.push(['FAIL', name + ' :: ' + e.message.split('\n')[0]]); }
}

let html = '';
await check('HTML loads 200 with page cache header', async () => {
  const r = await fetch(P + '/');
  html = await r.text();
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /s-maxage=300.*stale-while-revalidate/);
  assert.match(html, /<html/i);
});

await check('HTML links stay on the proxy host (no origin or CDN links left)', async () => {
  assert.equal(html.includes('https://shifatmasud.framer.website'), false);
  assert.equal(html.includes('https://framerusercontent.com'), false);
  assert.ok(html.includes(P + '/__fc/'), 'CDN links rewritten to proxy path');
});

let jsPath = null;
await check('JS asset 200 with immutable cache header', async () => {
  jsPath = html.match(/src="(http:\/\/localhost:8787\/__fc\/sites\/[^"]*\.mjs)"/)?.[1];
  assert.ok(jsPath, 'found script_main via proxy path');
  const r = await fetch(jsPath);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.match(r.headers.get('content-type'), /javascript/);
});

let imgPath = null;
await check('image 200 with immutable cache header', async () => {
  imgPath = html.match(/href="(http:\/\/localhost:8787\/__fc\/images\/[^"]*)"/)?.[1];
  assert.ok(imgPath, 'found image via proxy path');
  const r = await fetch(imgPath);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /immutable/);
  assert.ok(r.headers.get('content-type').startsWith('image/'));
  await r.arrayBuffer();
});

await check('Range request returns 206 with the byte range', async () => {
  const r = await fetch(jsPath, { headers: { range: 'bytes=0-99' } });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  assert.match(r.headers.get('content-range'), /^bytes 0-99\//);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

await check('404 is never cached', async () => {
  const r = await fetch(P + '/this-page-does-not-exist-xyz');
  assert.equal(r.status, 404);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  await r.arrayBuffer();
});

await check('POST refused and not cached', async () => {
  const r = await fetch(P + '/', { method: 'POST', body: 'x' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.get('cache-control'), 'no-store');
});

await check('HEAD answers with headers and no body', async () => {
  const r = await fetch(P + '/', { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /s-maxage=300/);
});

await check('gzip is applied to HTML when accepted', async () => {
  const r = await fetch(P + '/', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(r.headers.get('content-encoding'), 'gzip');
  assert.equal(r.headers.get('vary'), 'Accept-Encoding');
  assert.match(await r.text(), /<html/i);
});

await runVideoTests(check);

for (const [s, n] of results) console.log(s, n);
server.close();
const failed = results.filter(([s]) => s === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
