# T-003: Forest domain — Hansen tree-cover loss extraction
**Goal:** Turn Hansen v1.13 into dated loss polygons for Taiwan, satisfying the B4 schema.

**Files in scope:**
- `pipeline/trace_pipeline/domains/forest.py` (new)
- `pipeline/trace_pipeline/extract.py` (new — shared EE helpers)
- `pipeline/tests/test_forest.py` (new)

**Do NOT touch:** `config.py` asset ids (they are verified), `schema/`, `web/`.

**Recipe:**
1. Clip `config.HANSEN_ASSET` to `config.TAIWAN_BBOX`.
2. Mask to `treecover2000 >= config.TREECOVER_THRESHOLD_PCT`.
3. Take `lossyear > 0`; the band encodes 1–25 as 2001–2025.
4. `reduceToVectors` grouped by loss year, at `config.NATIVE_SCALE_M`.
5. Drop patches below `config.MIN_PATCH_HA`.
6. Emit B4 features: `valid_from` = loss year, `valid_to` = null, `change_type` = "loss",
   `metric.area_ha` computed server-side, `source` = the asset id, `method` = "Hansen lossyear".

**Acceptance criteria:**
- [ ] `ForestDomain` subclasses `Domain`, is `@register`ed, and returns a real `temporal_range()`.
- [ ] `caveat` says tree-cover loss, explicitly not deforestation — it includes plantation
      harvest, fire, and typhoon damage.
- [ ] Output validates against `schema/feature.schema.json`.
- [ ] **Report the actual polygon count** in the PR description. This is the number that decides
      whether the vector approach holds or we fall back to the deck.gl raster shader.
- [ ] Unit tests run without Earth Engine credentials — mock `ee`, test the year mapping
      (1 → 2001, 25 → 2025) and the area threshold, not the EE call itself.

**Fallback if `reduceToVectors` hits memory limits:** export the masked raster to Drive and
polygonize locally. Note it in the PR rather than silently switching approach.

**Verify:** `cd pipeline && pytest && ruff check .`
**Owner:** claude
