# T-029: forest cover carries its own validity — `[2000, L)` where Hansen records loss in L
**Goal:** Emit forest `cover` features that say for themselves which years they hold, so the web
never has to derive cover from loss — with zero additional Earth Engine requests.

**Context:** Today forest emits one `cover` feature per baseline block (`[2000, null)`) and one
`loss` feature per loss patch (`[L, null)`), and the web punches the loss holes into the cover at
paint time (`cleared-*` roles in `layerSpec.ts`). That is the web deriving cover from loss, which
T-028's taxonomy says it must not: a cover feature carries `[valid_from, valid_to)` and is drawn
for exactly those years.

The data to do it is already in the loss download. A loss patch `[L, null)` is, by construction,
tree cover that stood `[2000, L)` — same pixels, same sieve, same geometry. So:

- **Closed cover rides the loss download.** For every loss patch, also emit a cover piece with
  the same geometry and `valid_to = L`. No new request.
- **Open cover replaces the extent pass.** The baseline blocks are cut by *mapped* loss before
  vectorising, so what remains is `[2000, null)` with the holes already in the geometry — the
  same 16 requests as before, carrying interior rings now.

`cleared-*` is not touched here; T-024 deletes it once cover honours `valid_to` in the web.

**Files in scope:**
- `pipeline/trace_pipeline/domains/forest.py`
- `pipeline/trace_pipeline/config.py` — `FOREST_EXTENT_RETAINED_PCT` → `FOREST_COVER_RETAINED_PCT`, re-measured
- `pipeline/tests/test_forest.py`, `pipeline/tests/test_config.py`
- `pipeline/tests/test_tiles.py` (`:272,286,313`) and `pipeline/trace_pipeline/manifest.py` (`:56`) — the four
  inert `extent` strings T-028's review left for this ticket; rename only
- `data/forest.geojson`, `data/forest.pmtiles`, `data/domains.json` — regenerated, gitignored

**Do NOT touch:** `web/**`; `schema/**`; `water.py`; `MIN_PATCH_PIXELS`; the loss pass's sieve,
grid, or `build_feature`; `extract.py`; `tiles.py`.

**The change:**

`forest.py`
- `build_extent_feature(geometry, area_ha)` → `build_cover_feature(geometry, area_ha, *, valid_to: int | None)`.
  `valid_from = HANSEN_BASELINE_YEAR`; `change_type = "cover"`; `method = COVER_METHOD`
  (`"Hansen treecover2000, ended by lossyear"`, replacing `EXTENT_METHOD`). A `valid_to` that is
  not `None` and not `> HANSEN_BASELINE_YEAR` raises `ValueError` — a cover piece that ends the
  year it begins is not a state, and `lossyear` cannot produce one.
- `extract`: inside the loss loop, for every downloaded item append **both**
  `build_feature(geometry, calendar_year, area_ha)` and
  `build_cover_feature(geometry, area_ha, valid_to=calendar_year)`.
- `extent_blocks_for_cell` → `cover_blocks_for_cell`. Mask becomes `forest_2000 ∧ ¬mapped_loss`:
  ```
  lossyear     = image.select("lossyear").updateMask(forest_2000)
  same_year    = lossyear.connectedPixelCount(maxSize=16, eightConnected=False)
  mapped_loss  = same_year.gte(MIN_PATCH_PIXELS).And(lossyear.gte(1)).unmask(0)
  cover        = forest_2000.And(mapped_loss.Not()).selfMask()
  ```
  `connectedPixelCount` counts *same-valued* 4-connected neighbours, so a component here is a
  run of pixels with the same `lossyear` — exactly the per-year component `loss_patches_for_year`
  sieves on. Only loss the loss layer maps is punched; sub-MMU loss stays in the cover, so cover
  says "still there" precisely where loss says "not mapped". Then the existing block sieve and
  `reduceToVectors`, unchanged.
- `extract_extent` → `extract_cover`; `EXTENT_GRID` → `COVER_GRID`; `extent_grid_cells` →
  `cover_grid_cells`. Re-measure the grid comment: open blocks carry interior rings now, so the
  request per cell grows. Record the new numbers; move 4×4 → 6×6 only if 4×4 fails.
- Caveat: replace the "cover view draws the baseline with mapped loss removed … estimate rather
  than a fresh observation" passage with: "The cover layer draws the {baseline} baseline forward
  year by year: a patch is drawn until the year Hansen records its loss and not after, so a given
  year shows the baseline minus the loss mapped by then. Regrowth is not added back (Hansen's gain
  band ends in 2012 and is not comparable year for year), and loss too small to map — about
  {100 − FOREST_RETAINED_PCT}% of it — stays in the cover. The baseline passes the same
  single-pixel sieve and keeps about {FOREST_COVER_RETAINED_PCT}% of the canopy area the source
  records."

`config.py`
- `FOREST_EXTENT_RETAINED_PCT` → `FOREST_COVER_RETAINED_PCT`. Numerator = Σ `area_ha` of every
  cover feature in the shipped `forest.geojson` (open blocks + closed pieces — what frame 2000
  draws). Denominator = the raster baseline area the current comment quotes (2,340,266 ha), unless
  re-measured. State both terms and the ratio. **If the ratio exceeds 100%, say so in the comment
  and explain why** — the shipped extent vectors already sum to 2,341,516 ha against that
  denominator, so the old 99.8% does not reproduce from the shipped file.

Tests
- `test_forest.py`: `build_cover_feature(SQUARE, 0.72, valid_to=None)` → `2000 / None / cover /
  COVER_METHOD`, schema-valid; `valid_to=2014` → `2014`, schema-valid; `valid_to=2000` and
  `valid_to=1999` → `ValueError`. `extract` with `loss_patches_for_year`, `cover_grid_cells`,
  `cover_blocks_for_cell` and `extract.download_features` stubbed: every loss item yields exactly
  one `loss` and one `cover` sharing geometry and `area_ha`, and the cover's `valid_to` equals the
  loss's `valid_from`. Caveat contains "until the year" and "not after" and the cover-retained
  figure. Update `test_manifest_entry_is_well_formed` to pass `("cover", "loss")`.
- `test_config.py`: `FOREST_COVER_RETAINED_PCT` plausibility (pattern at `:106-111`).
- `test_tiles.py:272,286,313`, `manifest.py:56`: `extent` → `cover`.

**Acceptance criteria:**
- [ ] `build_cover_feature` behaves as specified above, including the `ValueError` guard.
- [ ] For every downloaded loss patch, one `loss` and one `cover` share geometry and `area_ha`
      (stubbed-`download_features` test).
- [ ] No cover feature in the shipped output has `valid_to <= valid_from` (checked on
      `data/forest.geojson` by a test that skips when the file is absent).
- [ ] Manifest measures forest `changeTypes = ["cover", "loss"]` from tilestats.
- [ ] `FOREST_COVER_RETAINED_PCT` re-measured from the shipped output; comment states numerator,
      denominator and ratio.
- [ ] Caveat says cover is drawn until the loss year and not after.
- [ ] `grep -rn "extent" pipeline/tests/test_tiles.py pipeline/trace_pipeline/manifest.py` → empty.
- [ ] `tiles.verify` passes with no drops on the regenerated archive.

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check . && python -m trace_pipeline.cli extract forest && python -m trace_pipeline.cli tiles forest`
**Owner:** claude

**Known consequence, state it in the PR:** `web/src/domains/layerSpec.tiles.test.ts:114-125`
("never sees a feature that expires") goes red locally against the regenerated tiles until T-024
lands. CI never sees `data/`, so it stays green there.
