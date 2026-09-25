# Deploying Trace

Trace deploys as one Cloudflare Worker, `trace`, on one origin:

- **The app** — the Vite build in `web/dist` — is served as the Worker's static assets.
- **The data** — `domains.json` and the `.pmtiles` it and the basemap name — is served at `/data/*`
  from the R2 bucket `trace-data` by [`web/worker/index.ts`](../web/worker/index.ts).

One origin because every data URL the app knows is root-relative (`/data/domains.json`,
`pmtiles:///data/…`), exactly as the dev server serves it, so the build never needs to know where
it runs and nothing needs CORS. R2 rather than static assets because Cloudflare caps an asset at
25 MiB and the tilesets run to 91 MB.

The two halves ship separately. **CI deploys the app** on every merge to `main`. **A person
publishes the data**, because generating it needs Earth Engine credentials and CI has none by
design.

Wrangler is not a dependency — it would put the workerd runtime into every `npm ci` for a tool only
deploys use. Its version is pinned once, in `config.wrangler` in `web/package.json`, and every
script runs that version through `npx`.

## One-time setup

All from `web/`:

1. A Cloudflare account. The free plan is enough to start (see [Cost](#cost)).
2. `npx wrangler login`
3. `npx wrangler r2 bucket create trace-data`
4. `npm run publish:data` — needs `data/` generated first
   (`cd pipeline && .venv/bin/python -m trace_pipeline.cli all`).
5. `npm run deploy` — prints the live URL, `https://trace.<your-subdomain>.workers.dev`.
6. For deploy-on-merge, give CI a token:
   - Cloudflare dashboard → My Profile → API Tokens → create from the **Edit Cloudflare Workers**
     template.
   - `gh secret set CLOUDFLARE_API_TOKEN` and `gh secret set CLOUDFLARE_ACCOUNT_ID` (the account ID
     is on the Workers overview page).

   Until both are set, the `deploy · web app` job skips with a notice rather than failing.

Then check the live site: the basemap and every domain draw, and
`curl -sI -H 'Range: bytes=0-15' <url>/data/domains.json` answers `206`.

## Routine

| When | Do |
|---|---|
| A PR merges to `main` | Nothing — CI deploys the app. |
| The pipeline regenerated `data/` | `npm run publish:data -- --dry-run` to see the plan, then `npm run publish:data`. |
| Before either, to see production locally | `npm run publish:data -- --local`, then `npm run preview:worker` (or the `web-worker` preview entry) and open <http://localhost:8787> — the real Worker in the real runtime, over a local R2. |

`publish:data` uploads exactly what the app reads — each domain's tileset from the manifest, each
`pmtiles://` source in the basemap style, and the manifest — never the GeoJSON beside them in
`data/`. The manifest goes last, so it only goes live once everything it names is there.

## The version rule

The app refuses a manifest whose `version` is not its `SUPPORTED_VERSION`
([`manifest.ts`](../web/src/domains/manifest.ts)), and that has changed three times already. **A PR
that bumps it is a release of both halves:** merge it, then run `npm run publish:data` straight
away. In between, the live site shows the version error — loudly, which is the point; the
alternative is an app reading tiles it does not understand.

## Rollback

- **App:** `npx wrangler deployments list`, then `npx wrangler rollback <version-id>`. Workers keeps
  every deployed version.
- **Data:** R2 keeps no history — an upload replaces the object. Check out the commit you want,
  regenerate `data/`, and publish it.

Mind the version rule in both directions: rolling one half back across a version bump leaves the
site showing the version error until the other half follows.

## Cost

R2 storage (~220 MB) and egress are free, as are requests for the app's static assets. Every
`/data` request is a Worker invocation, though, and one map session makes hundreds of tile requests.
The free plan's 100,000 requests a day is the first limit a burst of traffic hits; the $5/month
paid plan removes it.

## A custom domain

Add a route to `web/wrangler.json` — nothing else changes:

```json
"routes": [{ "pattern": "trace.example.tw", "custom_domain": true }]
```

The domain has to be on Cloudflare DNS.
