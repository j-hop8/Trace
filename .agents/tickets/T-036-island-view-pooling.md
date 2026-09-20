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
- `config.DETAIL_ZOOM = 10`, published as `tiles.detailZoom`; `MANIFEST_VERSION` 3.
- Every source feature is written twice for tippecanoe: the *detail copy* as today, restricted
  to `minzoom = DETAIL_ZOOM`; and an *island copy* restricted to `maxzoom = DETAIL_ZOOM - 1`,
  carrying every property except `metric` and `id`, plus `pooled: true`. `--coalesce --reorder`
  merge a tile's island copies of one group into one feature; tiny-polygon reduction
  (`--tiny-polygon-size=6`) pools rings under 36 tile units² into squares of the same total
  area.
- Provably lossless above the split: a `MIN_PATCH_PIXELS` patch is ~73 units² at z10, ~18 at z9;
  `tiles.py` computes the floor from `config` and refuses to build under 1.5× the threshold.
  `verify`'s count check at max zoom stays the detail-regime guarantee.
- `verify` decodes the z7 and z9 tiles, clips to the tile, sums geodesic area per layer against
  Σ `area_ha` of the members, prints the retained share, and fails under 90%.
- Web: `SUPPORTED_VERSION` 3, `tiles.detailZoom`, a `pooled` readout sentence with no area, the
  tiles test decoding both regimes.

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
- [ ] z10–z14 tiles are byte-for-byte the same contract as before: every feature, its `id`, its
      `metric`; the tilestats count check passes unchanged.
- [ ] z5–z9 tiles hold one feature per cohort layer and attribute group per tile, `pooled`, no
      `metric`, no `id`.
- [ ] The build refuses to run if a `MIN_PATCH_PIXELS` patch could be pooled at `DETAIL_ZOOM`.
- [ ] `verify` prints the island retained-area share per zoom and fails under 90%.
- [ ] The caveat states the pooling; the readout for a pooled feature quotes no area and says
      where individual patches begin.
- [ ] `layerSpec.tiles.test.ts` passes on both regimes against the rebuilt archives.
- [ ] Opening view, dev Mac: cover on screen under ~3 s and everything under ~6 s (from
      13–17 s / 21 s) — numbers in the PR.

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check .` and
`cd web && npm run typecheck && npm test && npm run format:check`, with rebuilt archives.
**Owner:** claude
