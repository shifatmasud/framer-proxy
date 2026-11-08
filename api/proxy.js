// Framer edge proxy (Vercel Edge Function). Fetches a Framer site from its origin
// and serves it from Vercel's edge cache with long, correct Cache-Control headers.
// Config (env vars, see README): FRAMER_ORIGIN (required for any site other than the default),
// optional FRAMER_HOST_2 + FRAMER_ORIGIN_2 for a second site on its own domain.
export const config = { runtime: 'edge' };

const DEFAULT_ORIGIN = 'https://shifatmasud.framer.website';
const FRAMER_ORIGIN = (process.env.FRAMER_ORIGIN || DEFAULT_ORIGIN).replace(/\/+$/, '');
const SITE2_HOST = process.env.FRAMER_HOST_2 || '';
const SITE2_ORIGIN = (process.env.FRAMER_ORIGIN_2 || '').replace(/\/+$/, '');

const ASSET_HOST = 'https://framerusercontent.com'; // Framer's CDN for images, fonts, scripts
const ASSET_PREFIX = '/__fc';                       // proxy path that maps to ASSET_HOST

const PAGE_CACHE = 'public, max-age=0, s-maxage=300, stale-while-revalidate=86400'; // HTML: 5 min, then stale
const IMMUTABLE = 'public, max-age=31536000, s-maxage=31536000, immutable';         // hashed assets
const SHORT = 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400';     // other 200s
const NO_STORE = 'no-store';                                                        // errors, redirects, 206, 405

const TEXT_TYPES = /text\/html|text\/css|javascript|application\/json|application\/xml|text\/xml|text\/plain|application\/xhtml|manifest/i;

// Video: one full copy per file, kept in the edge cache; Range requests are answered from that copy.
const VIDEO_RE = /\.(mp4|webm|mov|m4v)$/i;
const MAX_COPY_BYTES = Number(process.env.VIDEO_CACHE_MAX_BYTES) || 512 * 1024 * 1024; // size gate, see README
const FILL_MARK = 'https://fill.framer-proxy.internal/?u='; // one-attempt marker per file, 24 h

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function originFor(host) {
  return SITE2_HOST && SITE2_ORIGIN && host === SITE2_HOST ? SITE2_ORIGIN : FRAMER_ORIGIN;
}

function cacheControl(kind, path, status, ctype) {
  if (status !== 200) return NO_STORE; // partial (206), redirects, errors: never cached at the edge
  if (/text\/html/i.test(ctype)) return PAGE_CACHE;
  if (kind === 'asset') return IMMUTABLE;
  if (path.startsWith('/_framer/') || path.startsWith('/sites/') || /\.[0-9a-f]{8,}\.[a-z0-9]+$/i.test(path)) return IMMUTABLE;
  return SHORT;
}

// Absolute Framer-origin and Framer-CDN URLs become the proxy's own host, so navigation stays here.
function rewriteText(text, proxyOrigin, siteOrigin) {
  let out = text.replace(new RegExp('(?:https?:)?//framerusercontent\\.com', 'g'), proxyOrigin + ASSET_PREFIX);
  out = out.replace(new RegExp('(?:https?:)?//' + esc(new URL(siteOrigin).host), 'g'), proxyOrigin);
  return out;
}

function rewriteLocation(loc, proxyOrigin, siteOrigin) {
  if (loc.startsWith(siteOrigin)) return proxyOrigin + loc.slice(siteOrigin.length);
  if (loc.startsWith(ASSET_HOST)) return proxyOrigin + ASSET_PREFIX + loc.slice(ASSET_HOST.length);
  return loc;
}

function edgeCache() {
  try {
    return typeof caches !== 'undefined' && caches.default ? caches.default : null;
  } catch {
    return null;
  }
}

// Background work: Vercel's waitUntil when present, otherwise run and forget (errors swallowed).
function later(context, promise) {
  const p = promise.catch(() => {});
  if (context && typeof context.waitUntil === 'function') context.waitUntil(p);
}

// Full size of the file from an origin answer: content-length of a 200, the part after '/' of a 206.
function totalLength(up) {
  if (up.status === 206) {
    const m = /\/(\d+)$/.exec(up.headers.get('content-range') || '');
    return m ? Number(m[1]) : 0;
  }
  return Number(up.headers.get('content-length')) || 0;
}

// Fetch the whole file once (no Range), store it. A marker keeps a failed or oversized file from refetching for a day.
async function fillCopy(cache, target, total) {
  const mark = FILL_MARK + encodeURIComponent(target);
  if (await cache.match(mark).catch(() => undefined)) return;
  await cache.put(mark, new Response('1', { headers: { 'cache-control': 'public, s-maxage=86400' } })).catch(() => {});
  const full = await fetch(target, { redirect: 'manual' });
  if (full.status !== 200 || !full.body || Number(full.headers.get('content-length')) !== total) {
    full.body?.cancel();
    return;
  }
  const headers = new Headers({
    'content-type': full.headers.get('content-type') || 'video/mp4',
    'content-length': String(total),
    'accept-ranges': 'bytes',
    'cache-control': IMMUTABLE,
  });
  await cache.put(target, new Response(full.body, { status: 200, headers }));
  await cache.delete(mark).catch(() => {});
}

// Single byte range: { start, end } inclusive; 'unsatisfiable'; or null for anything else (passed to origin).
function parseRange(h, total) {
  const m = /^bytes=(\d*)-(\d*)$/i.exec(h.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? total - 1 : Math.min(Number(m[2]), total - 1);
  }
  if (start >= total || start > end) return 'unsatisfiable';
  return { start, end };
}

// Pass only bytes start..end of a streamed body, without buffering the file; stops reading once past end.
function sliceStream(body, start, end) {
  let pos = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, ctl) {
      const cs = pos;
      const ce = pos + chunk.byteLength;
      pos = ce;
      if (ce > start) {
        const a = Math.max(0, start - cs);
        const b = Math.min(chunk.byteLength, end + 1 - cs);
        if (b > a) ctl.enqueue(chunk.subarray(a, b));
      }
      if (ce > end) ctl.terminate();
    },
  }));
}

// Answer from the cached copy. Returns null when the request is not one this path serves (e.g. multi-range).
function fromCopy(hit, method, rangeHeader) {
  const total = Number(hit.headers.get('content-length'));
  if (!(total > 0)) return null;
  const common = { 'content-type': hit.headers.get('content-type') || 'video/mp4', 'accept-ranges': 'bytes' };
  if (!rangeHeader) {
    const headers = new Headers(common);
    headers.set('content-length', String(total));
    headers.set('cache-control', IMMUTABLE);
    return new Response(method === 'HEAD' ? null : hit.body, { status: 200, headers });
  }
  const r = parseRange(rangeHeader, total);
  if (r === null) return null;
  if (r === 'unsatisfiable') {
    return new Response(null, { status: 416, headers: { 'content-range': `bytes */${total}`, 'cache-control': NO_STORE } });
  }
  const headers = new Headers(common);
  headers.set('content-range', `bytes ${r.start}-${r.end}/${total}`);
  headers.set('content-length', String(r.end - r.start + 1));
  headers.set('cache-control', NO_STORE); // the 206 itself is never cached; the copy is
  if (method === 'HEAD') return new Response(null, { status: 206, headers });
  return new Response(sliceStream(hit.body, r.start, r.end), { status: 206, headers });
}

export default async function handler(request, context) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { allow: 'GET, HEAD', 'cache-control': NO_STORE } });
  }

  const url = new URL(request.url);
  const proxyOrigin = url.origin;
  const siteOrigin = originFor(url.host);

  // Vercel rewrite passes the original path as __p; direct calls use the pathname.
  const q = new URLSearchParams(url.search);
  let path = q.get('__p') ?? url.pathname;
  q.delete('__p');
  if (!path.startsWith('/')) path = '/' + path;
  const qs = q.toString() ? '?' + q.toString() : '';

  let kind = 'site';
  let base = siteOrigin;
  let upPath = path;
  if (path === ASSET_PREFIX || path.startsWith(ASSET_PREFIX + '/')) {
    kind = 'asset';
    base = ASSET_HOST;
    upPath = path.slice(ASSET_PREFIX.length) || '/';
  }
  const target = base + upPath + qs;

  // Only what the origin needs; Range passes through so video and big files stream, not buffer.
  const reqHeaders = new Headers();
  for (const h of ['range', 'if-range', 'user-agent', 'accept', 'accept-language']) {
    const v = request.headers.get(h);
    if (v) reqHeaders.set(h, v);
  }

  // Video: answer from the cached full copy when there is one (Framer is not billed for it).
  const isVideo = kind === 'asset' && VIDEO_RE.test(upPath) && (request.method === 'GET' || request.method === 'HEAD');
  const cache = isVideo ? edgeCache() : null;
  const range = request.headers.get('range');
  if (cache) {
    const hit = await cache.match(target).catch(() => undefined);
    if (hit && hit.status === 200 && hit.body) {
      const served = fromCopy(hit, request.method, range);
      if (served) return served;
    }
  }

  let up;
  try {
    up = await fetch(target, { method: request.method, headers: reqHeaders, redirect: 'manual' });
  } catch (err) {
    return new Response('Upstream unavailable', { status: 502, headers: { 'cache-control': NO_STORE } });
  }

  // Video miss: fill the copy once, in the background, so later Range requests come from it.
  if (cache && request.method === 'GET' && (up.status === 200 || up.status === 206)) {
    const total = totalLength(up);
    if (total && total <= MAX_COPY_BYTES) later(context, fillCopy(cache, target, total));
  }

  const status = up.status;
  const ctype = up.headers.get('content-type') || '';
  const headers = new Headers();
  for (const h of ['content-type', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-language']) {
    const v = up.headers.get(h);
    if (v) headers.set(h, v);
  }
  const loc = up.headers.get('location');
  if (loc) headers.set('location', rewriteLocation(loc, proxyOrigin, siteOrigin));
  headers.set('cache-control', cacheControl(kind, upPath, status, ctype));
  headers.set('vary', 'Accept-Encoding');

  // Text (HTML, JS, CSS, JSON): rewrite origin links, then gzip if the client takes it.
  if (request.method === 'GET' && status !== 206 && TEXT_TYPES.test(ctype) && up.body) {
    const text = rewriteText(await up.text(), proxyOrigin, siteOrigin);
    const bytes = new TextEncoder().encode(text);
    // Vercel's edge compresses text responses itself; sending our own gzip here came out as raw bytes in the browser.
    headers.set('content-length', String(bytes.length));
    return new Response(bytes, { status, headers });
  }

  // Everything else (images, fonts, video, ranges, HEAD): stream straight through.
  const enc = up.headers.get('content-encoding');
  if (enc) headers.set('content-encoding', enc);
  const len = up.headers.get('content-length');
  if (len) headers.set('content-length', len);
  return new Response(request.method === 'HEAD' ? null : up.body, { status, headers });
}
