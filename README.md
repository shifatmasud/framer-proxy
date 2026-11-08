# framer-proxy

Serves a Framer site through your own Vercel edge cache, so repeat visits stop pulling from Framer's bandwidth.
HTML is cached 5 minutes (then served stale while it refreshes), hashed JS, CSS, images and fonts are cached for a year.
Errors, redirects and partial (Range) responses are never cached.

## Setup (5 lines)
1. In Vercel: Add New Project, import this GitHub repo `shifatmasud/framer-proxy`, and keep the defaults.
2. Environment Variables: set `FRAMER_ORIGIN` to your Framer site, e.g. `https://shifatmasud.framer.website` (no trailing slash).
3. Click Deploy.
4. Project Settings, Domains: add your domain (optional; the `*.vercel.app` URL works too).
5. Second Framer site: also set `FRAMER_HOST_2` (the domain that serves it) and `FRAMER_ORIGIN_2`, and attach that domain to the same project.

## Test locally
    npm test          # runs against the live Framer origin via a local stand-in for Vercel

## Files
- `api/proxy.js`: the edge function (fetch from origin, rewrite origin links, cache headers, gzip text).
- `vercel.json`: sends every path to the function.
- `test/`: live checks (HTML, JS, image, Range, 404, POST, HEAD, gzip).

## Video copy (saves Framer bandwidth on video)
- The first Range request for a video goes to Framer as before; in the background the proxy fetches the whole file once and keeps it in the Vercel edge cache.
- Later Range requests (seeks, replays) are answered from that copy with 206, so Framer is not billed for them.
- Files over `VIDEO_CACHE_MAX_BYTES` (default 512 MB) are not copied. A file that fails to copy is not retried for 24 hours.
- Unverified until deployed: whether the edge cache keeps a copy this large. If it does not, video falls back to pass-through (no saving, no breakage).

## Limits
- Video seeks are served from the copy only if the edge cache keeps it; otherwise they pass through to Framer.
- Every non-hashed `200` page is cached for 5 minutes, so a republish shows up within about 5 minutes.
