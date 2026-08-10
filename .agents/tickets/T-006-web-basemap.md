# T-006: Map canvas and the muted Protomaps basemap
**Goal:** A MapLibre canvas over Taiwan on a basemap that shows no blue and no green, so those
hues stay free to mean "water domain" and "forest domain".

**Files in scope:**
- `web/src/map/MapCanvas.tsx`, `web/src/map/usePmtilesProtocol.ts` (new)
- `web/src/map/basemap/style.json` (new)
- `web/src/App.tsx` (replace the Phase 0 placeholder body)

**Do NOT touch:** `web/src/domains/colors.ts`, `web/src/types/feature.ts`, `pipeline/`.

**Why not OpenFreeMap:** the restyle *is* the work, and OpenFreeMap (OpenMapTiles schema) and
Protomaps use incompatible layer names — staging through it means doing the restyle twice.

**Steps:**
1. Fetch a Taiwan extract once (checked into `data/`, gitignored):
   `pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles data/taiwan-base.pmtiles --bbox=119.3,21.85,122.05,25.35`
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
