# T-036: a lighter island view — pooled tiles below the detail zoom
**Goal:** Make the opening view draw in seconds by giving the low zooms tiles they can parse:
below a detail zoom, one feature per cohort and attribute group per tile, with patches smaller
than a screen pixel pooled into squares of the same total area; from the detail zoom up, every
feature exactly as today.

**Symptom:** After T-034 the opening view still takes 13–17 s to draw cover on the dev Mac. Every
zoom from z5 holds every feature — 408k tile features for forest, 1.16 M for water — and at z7 a
30 m patch is a quarter of a pixel. Cover fill and cover outline each cost ~5.5 s per domain
(T-034's numbers), so the cost is per feature and per ring, not tessellation.

**Decided with the user:** below the detail zoom, sub-pixel patches may be pooled
(tippecanoe's area-preserving tiny-polygon reduction) and one cohort's shapes merged per tile.
The caveat says so. Extraction, the GeoJSON, the schema's spine and the web's cohort/opacity
model are unchanged.

**Mechanism:**
- `config.DETAIL_ZOOM = 11`, published as `tiles.detailZoom`; `MANIFEST_VERSION` 3.
- Every source feature is written twice for tippecanoe: the *detail copy* as today, restricted
  to `minzoom = DETAIL_ZOOM`; and an *island copy* restricted to `maxzoom = DETAIL_ZOOM - 1`,
  carrying every property except `metric` and `id`, plus `pooled: true`. `--coalesce --reorder`
  merge a tile's island copies of one group into one feature; tiny-polygon reduction
  (`--tiny-polygon-size=6`) pools rings under 36 tile units² into squares of the same total
  area.
- Provably lossless above the split: a `MIN_PATCH_PIXELS` patch is ~72 units² at z11, ~18 at
  z10; `tiles.py` computes the floor from `config` and refuses to build under 1.5× the threshold.
  `verify` decodes the z11 tiles and counts distinct `(layer, id)` against the copies written.
- `verify` decodes the z7 and z10 tiles, clips to the tile, sums geodesic area per kind against
  Σ `area_ha` of the copies written, prints the retained share, and fails under 90%.
- Web: `SUPPORTED_VERSION` 3, `tiles.detailZoom`, a `pooled` readout sentence with no area, the
  tiles test decoding both regimes.

**Found while building:**
- The plan's zoom arithmetic was one level off: a 2-pixel patch is ~18 tile units² at z10 and
  ~72 at z11, so with the 36-unit² pooling threshold the split is z11, not z10 — which is also
  the web's `SCALE_SPLIT_ZOOM`, so the tiles' detail regime and the web's visible-fill regime
  coincide.
- `tilestats.count` counts the features tippecanoe *read*, not what it kept: a fixture with two
  tiny polygons pooled away still reported them. So the count check that T-033 leaned on never
  detected a tile-level drop. `verify` now decodes the `DETAIL_ZOOM` tiles and counts distinct
  `(layer, id)` against the copies written — the real guarantee — and keeps the tilestats count
  as input accounting (two copies per cohort copy).
- Build time: forest went from ~2 min to 22 min (15 min in tippecanoe's reorder/coalesce over
  817k copies, ~5 min decoding the tiles for `verify`). Tolerable for a batch step that already
  waits on Earth Engine, but worth a look: the low zooms coalesce every island copy into one tile.

**Measured, forest (opening-view z7 tile 106/55):**

| | before | after |
|---|---|---|
| features | 230,463 | 90 |
| rings | 248,801 | 23,270 |
| archive | 76 MB | 50 MB |

z10 tile 855/440: 90 features, all `pooled`, no ids, no metrics; z11 tile 1710/881 over the same
ground: 2,098 features, every one with an id and a metric. Island area held (per `verify`): z7
100.7 % of change, 101.5 % of cover; z10 94.9 % of change, 99.8 % of cover.

**Measured, water:** 1,163,698 cohort copies, 20 min build, archive 137 → 76.5 MB. Island area
held: z7 94.9 % of change, 97.8 % of cover; z10 97.2 % of change, 95.9 % of cover — all above the
90 % floor, none at 100 %, hence "about the same total area" in the caveat.

**Opening view, both domains, dev Mac, z7.05, times from the cover sources going on:**

| | before (after T-034) | after |
|---|---|---|
| water cover loaded | 14.8 s | 0.7 s |
| forest cover loaded | 11.2 s | 1.5 s |
| change stages loaded | 18.7 s | 2.5 s |
| everything, `idle` | 18.9 s | 3.4 s |

Forest alone (water off): cover loaded in 2.5 s on an earlier, busier run. Readout at z7:
"Forest, lost in 2025 — several patches pooled at this zoom; zoom in past 11 to see them one by
one."; at z12: "This forest: lost in 2024, 1,409 m²." No map errors in any run.

**Found in the tiles test:** tippecanoe writes a feature into every tile whose *buffer* it
touches, and a sliver in that never-rendered band is now pooled per layer, so a tile-scoped
identity read it as a copy missing from one node layer. The test now decodes only what a tile
draws (bounding box inside the tile's own extent). And in the island regime a group's copies
are pooled per layer independently, so a group can pool to nothing in one node layer and to a
square in another: the island regime promises that nothing is drawn where it is not valid
(`extra == 0`, `missing == 0` against the filter), while presence of every copy in every layer
stays a detail-regime promise. `verify`'s whole-archive count is what proves no copy is lost.

**Files in scope:**
- `pipeline/trace_pipeline/config.py`, `tiles.py`, `domains/base.py` (`manifest_entry`: the
  `detailZoom` field and the caveat sentence).
- `pipeline/tests/test_tiles.py`, `test_config.py`, and whichever test builds a manifest entry.
- `web/src/domains/manifest.ts`, `types/feature.ts`, `components/FeatureReadout.tsx`,
  `domains/layerSpec.tiles.test.ts`, `domains/manifest.test.ts`, `store/useTraceStore.test.ts`
  (fixture version).
- `CLAUDE.md`: rule 2, one paragraph on the two regimes.

**Do NOT touch:** `extract.py`, `domains/forest.py`, `domains/water.py` — the GeoJSON is not
re-extracted; `schema/**` — the tile-only `pooled` marker never appears in the GeoJSON;
`cohorts.py` — layer naming is the same in both regimes; `colors.ts`; T-034's staging and the
year model in `useDomainLayers.ts` / `layerSpec.ts`.

**Acceptance criteria:**
- [x] z11–z14 tiles are the same contract as before: every feature, its `id`, its `metric` —
      now proven by decoding the z11 tiles, since tilestats never could.
- [x] z5–z10 tiles hold one feature per cohort layer and attribute group per tile, `pooled`, no
      `metric`, no `id`.
- [x] The build refuses to run if a `MIN_PATCH_PIXELS` patch could be pooled at `DETAIL_ZOOM`.
- [x] `verify` prints the island retained-area share per zoom and fails under 90%.
- [x] The caveat states the pooling; the readout for a pooled feature quotes no area and says
      where individual patches begin.
- [x] `layerSpec.tiles.test.ts` passes on both regimes against the rebuilt archives.
- [x] Opening view, dev Mac: cover on screen under ~3 s and everything under ~6 s (from
      13–17 s / 21 s) — cover in 0.7–1.5 s, everything in 3.4 s.

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check .` and
`cd web && npm run typecheck && npm test && npm run format:check`, with rebuilt archives.
**Owner:** claude
