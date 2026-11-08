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

## Limits
- Range requests (video seeks) pass through to Framer each time; they are not cached at the edge.
- Every non-hashed `200` page is cached for 5 minutes, so a republish shows up within about 5 minutes.
