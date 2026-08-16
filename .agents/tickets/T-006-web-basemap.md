# T-006: Map canvas and the muted Protomaps basemap
**Goal:** A MapLibre canvas over Taiwan on a basemap that shows no blue and no green, so those
hues stay free to mean "water domain" and "forest domain".

**Files in scope:**
- `web/src/map/MapCanvas.tsx`, `web/src/map/usePmtilesProtocol.ts` (new)
- `web/src/map/basemap/style.json` (new)
- `web/src/App.tsx` (replace the Phase 0 placeholder body)
- **Scope amended** — every file below is outside the original list. Reasons recorded, per group:

  | File(s) | Why it is here |
  |---|---|
  | `web/vite-plugin-serve-data.ts`, `web/vite.config.ts` | The app has no route to `data/` otherwise. Started as a `web/public/data` symlink; that broke CI, see below. |
  | `web/src/domains/manifest.ts` | Its error handling never fired in the one case it was written for. |
  | `web/scripts/check-basemap-palette.mjs`, `web/package.json`, `.github/workflows/ci.yml` | Mechanical enforcement of this ticket's own acceptance criterion. One coherent addition: the script, the npm script that runs it, and the CI step that makes it binding. Removing any one of the three leaves the rule unenforced. |
  | `web/src/vite-env.d.ts` | Required for `import.meta.env` to typecheck, which the DEV-guarded map handle uses. Without it `npm run build` fails. |
  | `.claude/launch.json` | How the dev server is started for verification. Small and tooling-only; drop it if that is preferred. |

**Do NOT touch:** `web/src/domains/colors.ts`, `web/src/types/feature.ts`, `pipeline/`.

## Two defects to fix here, found by running the app

**The web app has no route to `data/`.** `web/public/` does not exist, so `fetch('/data/domains.json')`
cannot resolve.

A `web/public/data -> ../../data` symlink looked like the fix and passed locally — then failed CI.
`data/` is gitignored, so on a clean checkout the symlink **dangles**, and Vite's build copies
`publicDir` into the output, dying on `statSync` before producing anything. It only ever worked on
a machine where `data/` happened to exist.

The deeper problem is that `public/` means "copy into the bundle", and `data/` holds ~100 MB of
generated tilesets that must never be bundled. So `/data` is served in dev by
`vite-plugin-serve-data.ts`, and by the host at the same path in production — identical URLs, and
the build never touches it. Range requests are mandatory there rather than a nicety: PMTiles is a
single file read by byte range, so without 206 support the basemap cannot load at all.

That plugin answers every `/data` request terminally instead of calling `next()`, because falling
through hands the request to Vite's SPA fallback, which replies `index.html` at HTTP 200 — the
exact behaviour that made a missing manifest surface as `Unexpected token '<'`.

**`loadManifest`'s error handling never fires when it matters.** It guards on `response.ok`, but
Vite's dev server answers unknown paths with `index.html` at **HTTP 200** (SPA fallback). So the
guard passes, `response.json()` chokes on `<!doctype`, and the user gets
`Unexpected token '<', "<!doctype "... is not valid JSON` instead of the written-for-this-exact-case
message telling them to run the pipeline. Detect a non-JSON response explicitly.

**Why not OpenFreeMap:** the restyle *is* the work, and OpenFreeMap (OpenMapTiles schema) and
Protomaps use incompatible layer names — staging through it means doing the restyle twice.

**Steps:**
1. Fetch a Taiwan extract once (lands in `data/`, gitignored):
   `pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles data/taiwan-base.pmtiles --bbox=119.3,21.85,122.05,25.35 --maxzoom=14`

   **Do not hardcode a build date.** Protomaps retains only about a week of daily builds plus the
   latest patch per release — a pinned date 404s a month later, and the failure looks like a
   broken script rather than an expired URL. Read the current list from
   https://maps.protomaps.com/builds/ and record the date you used in the manifest for
   provenance. Verified 2026-08-10: the URL pattern is `https://build.protomaps.com/YYYYMMDD.pmtiles`,
   the planet file is ~137 GB, and it serves `accept-ranges: bytes` — so `extract` pulls only the
   Taiwan window over HTTP range requests. Never download the planet.
2. Register the pmtiles protocol on MapLibre before the first map instance is constructed.
3. Start from a Protomaps CC0 style, then suppress: water fills → neutral grey, landuse/park/
   forest greens → the same greys, labels dimmed, roads thinned.

**Acceptance criteria:**
- [ ] Map opens over Taiwan and pans/zooms smoothly.
- [ ] **No blue and no green pixel anywhere on the basemap.** Verify by screenshot, not by
      reading the style file — a missed `landcover` layer is exactly the kind of thing that
      survives a code read.
- [ ] Attribution shows "© OpenStreetMap contributors".
- [ ] The style's tile source URL is one field, swappable for a hosted URL at deploy time.
- [ ] No domain literal appears in this code — the canvas knows nothing about water or forest.

**Verify:** `cd web && npm run typecheck && npm run build`, then `npm run dev` and look at it.
**Owner:** claude
