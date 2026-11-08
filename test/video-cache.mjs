// Video copy tests: no Framer call needed. The edge cache is an in-memory stand-in and Framer's CDN is a fake origin.
import assert from 'node:assert/strict';
import { pending } from './local-server.mjs';

const P = 'http://localhost:8787';
const CLIP = 'https://framerusercontent.com/videos/test-clip.mp4';
const FILL = 'https://framerusercontent.com/videos/fill-clip.mp4';

// Deterministic bytes, so a wrong slice is visible.
const pattern = (n, k) => Buffer.from(Array.from({ length: n }, (_, i) => (i * k + 3) % 251));
const CLIP_BODY = pattern(4096, 7);
const FILL_BODY = pattern(10000, 13);

class MemCache {
  constructor() { this.m = new Map(); }
  async match(req) {
    const e = this.m.get(String(req));
    if (!e) return undefined;
    return new Response(new ReadableStream({ start(c) { for (const ch of e.chunks) c.enqueue(ch); c.close(); } }), { status: 200, headers: e.headers });
  }
  async put(req, res) {
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); }
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    this.m.set(String(req), { chunks, headers });
  }
  async delete(req) { return this.m.delete(String(req)); }
}

// Split into uneven chunks so range slicing has to cross chunk boundaries.
function chunked(buf, sizes) {
  const out = [];
  let at = 0;
  for (const s of sizes) { out.push(buf.subarray(at, at + s)); at += s; }
  if (at < buf.length) out.push(buf.subarray(at));
  return out;
}

export async function runVideoTests(check) {
  const cache = new MemCache();
  const realCaches = globalThis.caches;
  const realFetch = globalThis.fetch;
  const originCalls = [];
  const fakeBodies = { 'test-clip.mp4': CLIP_BODY, 'fill-clip.mp4': FILL_BODY };

  globalThis.caches = { default: cache };
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input.url;
    if (!url.startsWith('https://framerusercontent.com/videos/')) return realFetch(input, init);
    const body = fakeBodies[url.split('/videos/')[1]];
    const range = new Headers(init?.headers).get('range');
    originCalls.push(range || 'full');
    if (!range) {
      return new Response(body, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(body.length), 'accept-ranges': 'bytes' } });
    }
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    const s = Number(m[1]);
    const e = m[2] === '' ? body.length - 1 : Math.min(Number(m[2]), body.length - 1);
    return new Response(body.subarray(s, e + 1), {
      status: 206,
      headers: { 'content-type': 'video/mp4', 'content-length': String(e - s + 1), 'content-range': `bytes ${s}-${e}/${body.length}`, 'accept-ranges': 'bytes' },
    });
  };

  try {
    // Seed a cached full copy of the clip (as a fill would have left it).
    cache.m.set(CLIP, {
      chunks: chunked(CLIP_BODY, [300, 1000, 77, 2048]),
      headers: { 'content-type': 'video/mp4', 'content-length': String(CLIP_BODY.length), 'accept-ranges': 'bytes', 'cache-control': 'public, max-age=31536000, s-maxage=31536000, immutable' },
    });

    const rangeGet = async (path, range) => {
      const r = await fetch(P + path, { headers: { range } });
      return { r, body: Buffer.from(await r.arrayBuffer()) };
    };

    await check('Range on a cached video returns 206 with the exact bytes', async () => {
      const { r, body } = await rangeGet('/__fc/videos/test-clip.mp4', 'bytes=1000-1999');
      assert.equal(r.status, 206);
      assert.equal(r.headers.get('content-range'), 'bytes 1000-1999/4096');
      assert.equal(r.headers.get('content-length'), '1000');
      assert.deepEqual(body, CLIP_BODY.subarray(1000, 2000));
      assert.equal(r.headers.get('cache-control'), 'no-store');
    });

    await check('open-ended and suffix Range on a cached video return the right tail bytes', async () => {
      const a = await rangeGet('/__fc/videos/test-clip.mp4', 'bytes=4000-');
      assert.equal(a.r.status, 206);
      assert.deepEqual(a.body, CLIP_BODY.subarray(4000));
      const b = await rangeGet('/__fc/videos/test-clip.mp4', 'bytes=-100');
      assert.equal(b.r.headers.get('content-range'), 'bytes 3996-4095/4096');
      assert.deepEqual(b.body, CLIP_BODY.subarray(3996));
    });

    await check('a range across chunk boundaries of the copy is exact', async () => {
      const { body } = await rangeGet('/__fc/videos/test-clip.mp4', 'bytes=295-1400');
      assert.deepEqual(body, CLIP_BODY.subarray(295, 1401));
    });

    await check('Range past the end of a cached video returns 416', async () => {
      const { r } = await rangeGet('/__fc/videos/test-clip.mp4', 'bytes=5000-6000');
      assert.equal(r.status, 416);
      assert.equal(r.headers.get('content-range'), 'bytes */4096');
    });

    await check('full GET of a cached video is 200, immutable, full length, no origin call', async () => {
      const before = originCalls.length;
      const r = await fetch(P + '/__fc/videos/test-clip.mp4');
      assert.equal(r.status, 200);
      assert.match(r.headers.get('cache-control'), /immutable/);
      assert.deepEqual(Buffer.from(await r.arrayBuffer()), CLIP_BODY);
      assert.equal(originCalls.length, before);
    });

    await check('Range on an uncached video goes to origin once, then the full file is kept and later Ranges need no origin', async () => {
      const first = await rangeGet('/__fc/videos/fill-clip.mp4', 'bytes=10-19');
      assert.equal(first.r.status, 206);
      assert.deepEqual(first.body, FILL_BODY.subarray(10, 20));
      await Promise.all(pending.splice(0)); // the background fill
      assert.ok(cache.m.has(FILL), 'full copy stored');
      const calls = originCalls.filter((c) => c === 'full' || c.startsWith('bytes=10-'));
      assert.deepEqual(calls, ['bytes=10-19', 'full']);
      const mark = originCalls.length;
      const later = await rangeGet('/__fc/videos/fill-clip.mp4', 'bytes=5000-5099');
      assert.equal(later.r.status, 206);
      assert.deepEqual(later.body, FILL_BODY.subarray(5000, 5100));
      assert.equal(originCalls.length, mark, 'served from the copy, no origin call');
    });
  } finally {
    globalThis.caches = realCaches;
    globalThis.fetch = realFetch;
  }
}
