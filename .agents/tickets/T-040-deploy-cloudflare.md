# T-040: Deploy — one Cloudflare Worker serves the build, and `/data/*` from R2, on one origin
**Goal:** Make Trace deployable as a public site: the static build and the generated data served
from one origin, the web app redeployed on every merge to `main`, and the data published by one
command that uploads exactly what the app references.

**Why one origin, and why no app change.** Every data URL the app knows is root-relative:
`/data/domains.json` (`loadManifest`), `pmtiles:///data/taiwan-base.pmtiles` (basemap
`style.json`), and `pmtiles:///data/<domain>.pmtiles` (written into the manifest by
`pipeline/trace_pipeline/manifest.py`). `web/vite-plugin-serve-data.ts` already states the
production contract: *the host serves the same `/data` path, so nothing about the build has to
know*. This ticket is that host. Serving `/data` from another origin would mean CORS, a base-URL
setting, and a pipeline change to the manifest's URLs — none of which is needed if `/data` is on
the same origin as the page.

**Why a Worker and R2, not static assets alone.** Cloudflare's static assets cap each file at
25 MiB; the tilesets are 48 MB, 80 MB and 91 MB. So the build goes out as the Worker's static
assets, the tilesets and manifest live in an R2 bucket, and a small Worker answers `/data/*` from
the bucket. (This is the proposal's "Cloudflare Pages/R2", using Workers static assets — the
successor to Pages — so there is one config and one deploy command.)

**Shape**

`web/wrangler.json` — plain JSON, not JSONC, because `publish-data.mjs` reads the bucket name from
it and the bucket name must live in exactly one place:
```json
{
  "name": "trace",
  "main": "worker/index.ts",
  "compatibility_date": "2026-09-01",
  "assets": { "directory": "./dist", "binding": "ASSETS", "run_worker_first": ["/data/*"] },
  "r2_buckets": [{ "binding": "DATA", "bucket_name": "trace-data" }]
}
```
No `routes`: it deploys to `trace.<account>.workers.dev`. A custom domain later is a `routes`
entry and nothing else.

`web/worker/index.ts` — the `/data/*` handler. **No new dependencies**: wrangler would put the
workerd runtime into every `npm ci` for a tool only deploys use, so it runs through `npx` at the
version pinned once in `config.wrangler` in `web/package.json`. Declare the small subset of the R2
/ assets types the worker uses as local interfaces rather than adding
`@cloudflare/workers-types`. Put the logic in pure functions the tests can call. Rules:
- A path under `/data/` → R2 key = the rest of the path, decoded. Anything else →
  `env.ASSETS.fetch(request)`.
- `GET` and `HEAD` only; anything else → 405 with `Allow: GET, HEAD`.
- **A missing key is an honest 404 with a JSON body, never `index.html`.** Use the same shape as
  the dev plugin's 404 (`error` + `hint`); the hint is `cd web && npm run publish:data`. The dev
  plugin's comment explains why: an HTML 200 for a missing manifest shows up as
  `Unexpected token '<'`.
- **Range requests are required** — PMTiles is one file read by byte range. The worker parses
  `Range` itself (a pure `parseRange`) into R2's `{ offset, length }` / `{ offset }` /
  `{ suffix }` and passes that to `bucket.get`. It does not pass the raw headers through, so the
  parsing can be tested. Single ranges only: a malformed or multi-range header is ignored, and the
  worker answers 200 with the whole object, as RFC 9110 allows. A satisfiable range →
  206 + `Content-Range: bytes <start>-<end>/<size>` + `Content-Length`. A range starting past the
  end → 416 + `Content-Range: bytes */<size>` (R2 rejects it; catch that and `head()` for the
  size).
- Conditional requests: `If-None-Match` equal to the object's etag → 304.
- Response headers: `object.writeHttpMetadata(headers)` (Content-Type is stored at upload),
  `ETag: object.httpEtag`, `Accept-Ranges: bytes`. `Cache-Control`: **`no-cache` for `.json`**,
  because the manifest is the contract and must always be revalidated against the tiles it
  describes. `public, max-age=3600` for everything else: a tileset's ranges carry its ETag, and
  the pmtiles client rereads the archive header when that changes.

`web/worker/index.test.ts` — vitest, with a fake `DATA` bucket (an in-memory map that slices by
the `R2Range` it receives) and a fake `ASSETS`. It covers every rule above: 200 manifest with
`no-cache`, 206 for `bytes=0-15`, correct `Content-Range` for `bytes=100-` and `bytes=-10`, 416,
malformed and multi-range → 200 whole object, 404 JSON (asserting it is not HTML), 405, 304, HEAD
with no body, and a non-`/data` path reaching `ASSETS`.

`web/scripts/publish-data.mjs` — uploads the data the app references. **It derives the file list;
it does not hardcode one.** Nothing in `web/` may name a domain (CLAUDE.md rule 1), so the list is:
every `tiles.url` in `../data/domains.json`, plus every `pmtiles:///data/…` source in
`src/map/basemap/style.json`, plus `domains.json` itself.
- A URL not under `pmtiles:///data/` → exit 1 naming it, rather than skipping it silently.
- A referenced file missing from `data/` → exit 1 naming it and the pipeline command that makes it.
- Upload order: **tilesets first, `domains.json` last**, so the live manifest never names a tile
  layer that isn't uploaded yet.
- Each upload: `npx --yes wrangler@<config.wrangler> r2 object put <bucket>/<key> --file <path>
  --content-type <type> --remote`. **The target flag is always explicit**: in wrangler 4,
  `r2 object` defaults to the local simulator, and an upload without `--remote` "succeeds" into a
  bucket the live site never reads. Bucket from `wrangler.json`.
- `--local` uploads to wrangler's local simulator instead, so `npm run preview:worker` can serve
  the production stack on this machine.
  Content type: `application/json` for `.json`, `application/octet-stream` for `.pmtiles`.
- `--dry-run` prints the plan (key, local path, size, content type, in upload order) and uploads
  nothing.
- Never uploads `*.geojson` (600 MB of pipeline intermediates the app never reads). Deriving the
  list from references guarantees this. Don't also add a deny-list.

`web/package.json` — **no dependency changes**: `"config": { "wrangler": "4.140.0" }` (the one
pinned version), `"deploy": "npm run build && npx --yes wrangler@$npm_package_config_wrangler
deploy"`, `"preview:worker"` (build, then `wrangler dev --port 8787` over the local R2),
`"publish:data": "node scripts/publish-data.mjs"`, and widen `format` / `format:check` to include
`worker/`.

`.claude/launch.json` — a `web-worker` entry running `preview:worker` on 8787, so the production
worker can be checked in the preview pane before a deploy.

`web/tsconfig.json` — add `"worker"` to `include`, so `npm run typecheck` covers it.

`.github/workflows/ci.yml` — a `deploy` job: `needs: web`, only on `push` to `main`, in its own
`concurrency` group (`deploy-production`, `cancel-in-progress: false`) so deploys queue rather than
overlap. Steps: checkout, setup-node from `web/.nvmrc`, `npm ci`, then **`npm run deploy`** with
`CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` from secrets — the same command a person runs, so
there is one deploy path and one pinned wrangler. **Skip, don't fail, while the secrets aren't
set**: guard the deploy step on the token being non-empty and emit a `::notice::` saying so, so
`main` stays green until the human finishes setup.
The workflow-level group becomes `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`.
A job-level group cannot protect a deploy on its own: cancelling a run cancels every job in it,
so a run on `main` must never be cancelled for being superseded. Data is never published from CI — generating it needs
Earth Engine credentials, and CI has none by design (see the `pipeline` job's comment).

`.gitignore` — add `.wrangler/` (wrangler's local state directory).

`docs/deploy.md` — the runbook:
1. **One-time setup (human):** a Cloudflare account; `cd web && npx wrangler login`;
   `npx wrangler r2 bucket create trace-data`; `npm run publish:data`; `npm run deploy`. Then,
   for auto-deploy, create an API token from the "Edit Cloudflare Workers" template and add
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions secrets.
2. **Routine:** merging to `main` deploys the web app. Regenerating data →
   `npm run publish:data`.
3. **The version rule.** The app refuses a manifest whose `version` isn't its `SUPPORTED_VERSION`
   (`web/src/domains/manifest.ts`), and that has changed three times already. A PR that bumps it
   is a release of **both** halves: merge, then run `npm run publish:data` immediately. Until both
   are out, the live site shows the version error — loudly, which is the point.
4. **Cost:** R2 storage (~220 MB) and egress are free. Every `/data` request is a Worker
   invocation, and one map session makes hundreds of tile requests: the free plan's
   100k requests/day is the first limit a traffic spike hits, and $5/month removes it.

`CLAUDE.md` — a `Deploy` row in the Commands table (data: `npm run publish:data`; app:
`npm run deploy`) linking `docs/deploy.md`. Nothing else. (`AGENTS.md` is a symlink to it.)

**Files in scope:** `web/wrangler.json` (new), `web/worker/index.ts` (new),
`web/worker/index.test.ts` (new), `web/scripts/publish-data.mjs` (new), `web/package.json`
(`config` and `scripts` only), `web/tsconfig.json` (`include` only), `.github/workflows/ci.yml`
(new `deploy` job; workflow-level `cancel-in-progress`), `.claude/launch.json` (`web-worker`
entry), `.gitignore` (one line), `docs/deploy.md` (new), `CLAUDE.md` (Commands row only), this
ticket file.

**Do NOT touch:** `web/src/**` — the app already uses same-origin `/data` URLs, so if it seems to
need a change, stop and report instead. Also: `web/vite-plugin-serve-data.ts`,
`web/vite.config.ts`, `pipeline/**`, `data/`, `web/package-lock.json`, the `dependencies` /
`devDependencies` in `web/package.json`, and the steps of the existing `web` / `pipeline` CI jobs.

**Acceptance criteria:**
- [ ] `web/worker/index.test.ts` covers every worker rule listed above, and passes.
- [ ] A missing `/data` key returns a JSON 404; no path under `/data/` can return `index.html`.
- [ ] `publish-data.mjs` derives its upload list from the manifest and the basemap style, with no
      domain name or tileset filename written in the script. Tilesets upload before
      `domains.json`, every upload names its target (`--remote` unless `--local`), and
      `--dry-run` uploads nothing.
- [ ] Under `npm run preview:worker` (real workerd, local R2), the map draws with no console
      errors and every `/data` tile read is a 206.
- [ ] No dependency added: the `dependencies`, `devDependencies` and `package-lock.json` are
      unchanged.
- [ ] The `deploy` job runs only on push to `main`, cannot be cancelled by a newer run, and skips
      with a notice (not a failure) when `CLOUDFLARE_API_TOKEN` is unset.
- [ ] `npx wrangler@<config.wrangler> deploy --dry-run` accepts `wrangler.json` and bundles the
      worker.
- [ ] `docs/deploy.md` covers setup, routine, the version rule, rollback and cost. `CLAUDE.md`
      gains the Deploy row.
- [ ] Ticket file moved to `.agents/tickets/done/`.

**After merge (human, not part of this ticket's acceptance):** the one-time setup in
`docs/deploy.md`, then check on the live URL that the basemap and both domains draw, and that
`curl -sI -H 'Range: bytes=0-15' <url>/data/domains.json` returns 206.

**Verify:** `cd web && npm run typecheck && npm test && npm run format:check && npm run build`
**Owner:** claude (delegated to Codex, which was out of quota; reassigned)
