# T-017: Water change_type is a homemade statistic that contradicts its own source

**Goal:** Take the water layer's change signal from JRC's `transition` class instead of deriving it
here from a mean of per-pixel year extremes, and stop dating water the record was too blind to see —
so 淡水河 stops rendering as a red loss ribbon and reservoirs built before 1984 stop "arriving" in
the late 1980s. Subsumes T-016.

**Files in scope:**
- `pipeline/trace_pipeline/domains/water.py`
- `pipeline/trace_pipeline/config.py` (`WATER_RETAINED_PCT`)
- `pipeline/tests/test_water.py`
- `data/**` — regenerate

**Do NOT touch:** `web/`, `schema/feature.schema.json`, `domains/forest.py`, the T-015 land mask.

**Background — measured, not suspected.** Against the shipped `data/water.geojson` (36,721
features, 130,777 ha):

1. **`change_type` was decided by a mean at the third decimal place.** `patches_for_cell` reduced
   per-pixel first/last water year with `mean` over the whole polygon; `derive_change_type` then
   tested `last_year < range_last`. Dry margin pixels on every river and drawdown reservoir pulled
   that mean under the endpoint and flipped the entire polygon to loss. **82.8% of the layer's area
   was `loss`, 1.7% `stable`.** 95.4% of loss area ended in 2015 or later and 52% of it landed on
   exactly 2020 — a boundary artefact, not hydrology.
2. **The source's own answer was loaded and then overruled.** JRC's `transition` band was reduced
   with `mode` and filed as decorative `subtype`, while the homemade rule drove the colour. 淡水河
   shipped `subtype: permanent` and `change_type: loss` on the same feature. **66.0% of the layer
   was called `loss` while its own JRC class said the water was still there**; JRC calls 6.5% lost
   or declining.
3. **"No data" was indistinguishable from "not water".** `waterClass == 0` is *No data*. Measured
   over the pixels GSW tracks, the no-data share is 68.3% in 1984, **100.0% in 1985**, 99.5% in
   1986, 89.8% in 1987, collapsing through 1988 (33.5%) to under 1% from 1994. In 1986, 87.2% of
   pixels that *were* observed were water. So `min(year seen as water)` dated the observation, not
   the water: only 2.4% of area dated to 1984, the mass piled into 1988–1993, and 石門水庫 (dam
   1964) and 曾文水庫 (1973) came back as arrivals.
4. **T-016, folded in.** Vectorizing ran off one uniform ever-water mask, so 淡水河 + 新店溪 +
   大漢溪 + 基隆河 was **one** 1,886 ha feature spanning 24×21 km, and the largest feature was
   30,305 ha over 28×67 km — 23.2% of the layer under one date pair.

**Approach:** `CHANGE_TYPE_BY_TRANSITION` maps JRC's ten classes onto the schema's
`extent|gain|loss|stable` (unchanged). `reduceToVectors` segments on the integer `transition` band,
so each polygon is one class — which makes `change_type` exact and splits the merged blobs.
`PRESENT_AT_START` classes take `valid_from = range_first` and are never dated by measurement;
only arriving classes get a measured onset, via `median` rather than `mean`. `ENDED` classes are
the only ones that close, so `permanent to seasonal` is `loss` but stays open-ended.

**Acceptance criteria:**
- [ ] `change_type` comes from JRC's transition class; `subtype` and `change_type` cannot disagree
- [ ] An unknown transition class raises rather than defaulting to a colour
- [ ] Water present before the record is dated to the record's start, not to a measured year
- [ ] No single feature carries a double-digit percentage of the layer's total area (T-016)
- [ ] Caveat states the change window, what a feature's boundary now means, the retained
      percentage, and that the early record is blind
- [ ] Named-body regression table passes, including 翡翠水庫 staying a `gain` (~1987–88) — the
      control that the fix did not simply flatten everything to `stable`
- [ ] `data/` regenerated

**Verify:** `cd pipeline && pytest && ruff check .`
**Owner:** claude
