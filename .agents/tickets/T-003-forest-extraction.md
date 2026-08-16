# T-003: Forest domain — Hansen tree-cover loss extraction
**Goal:** Turn Hansen v1.13 into dated loss polygons for Taiwan, satisfying the B4 schema.

**Files in scope:**
- `pipeline/trace_pipeline/domains/forest.py` (new)
- `pipeline/trace_pipeline/extract.py` (new — shared EE helpers)
- `pipeline/tests/test_forest.py` (new)
- `pipeline/trace_pipeline/domains/__init__.py` — one import, so `@register` actually fires
- **Scope amended 2026-08-12** (see "Minimum mapping unit" below): `config.py` `MIN_PATCH_HA`,
  `pipeline/tests/test_config.py`, and the honesty-rules example in `CLAUDE.md`.

**Do NOT touch:** `config.py` asset ids (they are verified), `schema/`, `web/`.

## Minimum mapping unit — decided on measurement, not intuition

`MIN_PATCH_HA` was set to 0.5 in T-000 on the reasoning that under ~5 pixels a patch is mostly
edge effect. Measured against the real data, that was wrong for Taiwan: Hansen loss here is
dominated by small scattered patches (typhoon damage, landslide, selective plantation harvest),
not large clearances.

Island-wide 2001–2025, total measured loss is **51,473 ha**, and the threshold decides how much
of it the map is allowed to show:

| Threshold | Retained | Discarded |
|---|---|---|
| 0.09 ha (1 px) | 51,473 ha — 100% | 0 |
| **0.18 ha (2 px) — chosen** | **45,890 ha — 89.2%** | 5,583 ha |
| 0.27 ha (3 px) | 41,185 ha — 80.0% | 10,288 ha |
| 0.54 ha (6 px) — original | 32,714 ha — 63.6% | 18,759 ha |

0.5 ha would have discarded **over a third of every hectare Hansen records for Taiwan**, on a
product whose headline claim is *how much* changed. 0.18 ha drops only isolated single pixels —
at 30 m the likeliest mixed-pixel and geolocation artefacts — and keeps everything larger.

**The caveat must state the retained percentage, not merely name the threshold.** A user cannot
judge "patches under 0.18 ha are not mapped" without knowing what share of the data that removes.

### The threshold is a pixel count, not an area — and that distinction cost two runs

Hansen is a 1/4000-degree product: its pixels are ~27.8 m tall and ~25.5 m wide at Taiwan's
latitude, about **0.071 ha**, not the 0.09 that "30 m" implies. Two consequences, both of which
produced plausible-looking output that was quietly wrong:

1. Filtering on `area_ha >= 0.18` demands 2.5 pixels, so it silently behaved as a **3-pixel**
   filter — 80.3% retained while the caveat claimed 89%.
2. After switching to a pixel-count filter, `connectedPixelCount` ran on the native 27.83 m grid
   while `reduceToVectors` was pinned to `scale=30`. Different grids, so components and output
   polygons disagreed and 2-pixel components could emerge as single output pixels.

Both are fixed by doing the connectivity analysis and the vectorization in Hansen's **native
projection**, and by filtering on `MIN_PATCH_PIXELS` rather than hectares. `MIN_PATCH_HA` is
deleted, with a guard test asserting it stays deleted.

**Final measured result:** 91,089 polygons, 46,503 ha = **90.3%** of the 51,473 ha recorded.

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
