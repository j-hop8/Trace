# T-006: Map canvas and the muted Protomaps basemap
**Goal:** A MapLibre canvas over Taiwan on a basemap that shows no blue and no green, so those
hues stay free to mean "water domain" and "forest domain".

**Files in scope:**
- `web/src/map/MapCanvas.tsx`, `web/src/map/usePmtilesProtocol.ts` (new)
- `web/src/map/basemap/style.json` (new)
- `web/src/App.tsx` (replace the Phase 0 placeholder body)
- **Scope amended:** `web/public/data` symlink and `web/src/domains/manifest.ts` — see below.

**Do NOT touch:** `web/src/domains/colors.ts`, `web/src/types/feature.ts`, `pipeline/`.

## Two defects to fix here, found by running the app

**The web app has no route to `data/`.** `web/public/` does not exist, so `fetch('/data/domains.json')`
cannot resolve. A `web/public/data -> ../../data` symlink fixes it and *is* trackable by git
despite the `data/` ignore rule, because git records the symlink as a file entry rather than a
directory. Verified.

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
