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

export default async function handler(request) {
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

  let up;
  try {
    up = await fetch(target, { method: request.method, headers: reqHeaders, redirect: 'manual' });
  } catch (err) {
    return new Response('Upstream unavailable', { status: 502, headers: { 'cache-control': NO_STORE } });
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
    const ae = request.headers.get('accept-encoding') || '';
    if (/\bgzip\b/.test(ae) && typeof CompressionStream !== 'undefined' && bytes.length > 1024) {
      headers.set('content-encoding', 'gzip');
      const gz = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
      return new Response(gz, { status, headers });
    }
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
