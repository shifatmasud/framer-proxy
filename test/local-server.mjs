// Local stand-in for Vercel: maps every path to the edge handler the way vercel.json's rewrite does.
import http from 'node:http';
import { Readable } from 'node:stream';
import handler from '../api/proxy.js';

export function startServer(port) {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, `http://${req.headers.host}`);
    const target = `http://${req.headers.host}/api/proxy?__p=${encodeURIComponent(u.pathname)}${u.search ? '&' + u.search.slice(1) : ''}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const r = await handler(new Request(target, { method: req.method, headers }));
    const out = {};
    r.headers.forEach((v, k) => { out[k] = v; });
    res.writeHead(r.status, out);
    if (r.body && req.method !== 'HEAD') Readable.fromWeb(r.body).pipe(res); else res.end();
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}
