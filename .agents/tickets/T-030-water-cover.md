# T-030: water cover from JRC `YearlyHistory` — run-length encoded, one shape per stretch of years
**Goal:** Emit water `cover` features: each one contiguous region of pixels that were water over
the same half-open run of years `[from, to)`, from the per-year `waterClass` stack the module
already loads — so a year's water is what the cover features say holds in that year.

**Context:** Water has no cover layer. Its change features come from JRC's `transition` band — one
verdict over the whole record — and say *what moved*, never *what was there in year Y*. The
two-level taxonomy (T-028) needs both, and the user chose a fresh per-year extraction over
deriving cover from the change features' validity: honest observed water for each year, not a
reading of an epoch comparison.

`YearlyHistory` is one image per year, each pixel `waterClass ∈ {0 nodata, 1 not water, 2
seasonal, 3 permanent}`. Cover is `waterClass ≥ 2`, run-length encoded per pixel and vectorised
per run so adjacent pixels with the same `(from, to)` become one polygon.

**Files in scope:** `pipeline/trace_pipeline/domains/water.py`, `pipeline/trace_pipeline/config.py`
(new measured constants), `pipeline/tests/test_water.py`, `pipeline/tests/test_config.py`,
`data/water.*` and `data/domains.json` (regenerated, gitignored). Also the four stale comments in
`water.py` that still cite forest's `EXTENT_GRID` / `extent_grid_cells` (renamed by T-029).

**Do NOT touch:** `CHANGE_TYPE_BY_TRANSITION`, `PRESENT_AT_START`, `ENDED`, `derive_valid_from`,
`derive_valid_to`, `build_feature` — the change pass is T-031's; `MASK_ON_MANAGED_LAND`
membership; `MIN_PATCH_PIXELS`; `web/**`; `schema/**`; `forest.py`; `extract.py`; `tiles.py`.

## The Earth Engine design

**Stack.** `_yearly_water_class(aoi)` already returns v1.4 1984–2021, extended with v1.5
2022–2024 when reachable. Sort by `year`, `toList(N)`, index `0..N−1`.

**1. Observed water, under the same pixel mask as change.** Per year: `known = waterClass ≠ 0`,
`obs = waterClass ≥ 2`. The managed-land rule at `water_stats_image` (`transition ∈
MASK_ON_MANAGED_LAND ∧ managed_land()`) is factored into a module-level `managed_seasonal_keep()`
and applied to every year's `obs`. One pixel mask, decided by the transition class, shared by both
passes: a `lost seasonal` pond on now-built ground is *kept* by change, so its cover must exist
too. Cover and change cannot disagree about which pixels exist.

**2. Impute blind years so nodata never splits a run.** `state_i = known_i ? obs_i :
(last observation before i, else first observation after i, else not water)`. Built as a forward
fill and a backward fill over the N images — `obs_i.updateMask(known_i).unmask(ffill_{i−1})
.unmask(bfill_{i+1}).unmask(0)`. The rule is a pure Python function (`impute_nearest`) the tests
exercise; the EE graph mirrors it. Consequences the caveat states: 1985 (100% blind) inherits
1984; a pixel first *observed* as water in 1988 with blind years before it is water from 1984 —
the same rule `PRESENT_AT_START` applies to change; a pond that dried in a blind year is carried
one year too far. Measured → `WATER_COVER_IMPUTED_PCT`.

**3. Run starts and ends per pixel.** `starts_i = state_i ∧ ¬state_{i−1}`. Backward pass
`next_dry_i = ¬state_i ? i : next_dry_{i+1}`, `next_dry_N = N` (open). A run starting at `i` ends
at `next_dry_{i+1}`.

**4. One integer per run; vectorise per start-year pair.** `encode_run(from, to) = from·100 +
(to ?? 99)`, pure and round-trip tested. `label_i = encode(i, end_i)` masked to `starts_i`. A
pixel cannot start runs in two consecutive years (a run lasts ≥ 1 year and a dry year must follow
it), so `label_i.unmask(label_{i+1})` is disjoint per pixel and one band carries two start years —
`⌈N/2⌉` requests per cell rather than N, with no change to what gets segmented. Then
`connectedPixelCount(16, False) ≥ MIN_PATCH_PIXELS` (same sieve as the change pass; components
are same-label, i.e. same `(from, to)`), `reduceToVectors(labelProperty="run")` with **no
reducer** — the label carries both dates — and `tag_area`. `grid_cells` reused unchanged.

*Why per start year and not per k-th run:* adjacent pixels with identical `[1995, null)` runs whose
run *ordinals* differ (one flickered earlier) would land in different bands and fragment one
region into two. Per start year segments purely on `(from, to)`.

**Assembly.** `build_cover_feature(geometry, *, run_label, range_first, area_first?, area_ha,
gsw_asset)` → `TraceFeature(change_type="cover", valid_from, valid_to, method=COVER_METHOD,
subtype=None, …)`. `COVER_METHOD = "JRC GSW YearlyHistory run-length, nearest-year imputed"`.
`subtype` **omitted**: runs flip seasonal↔permanent yearly at drawdown reservoirs, and splitting
on class would fragment every reservoir; a dominant-class summary is a follow-up.

## Measure before deciding anything (mandatory gate)

Raster-side, island-wide, one `reduceRegion` batch — recorded in `config.py` comments:
- total water pixel-years; imputed water pixel-years → `WATER_COVER_IMPUTED_PCT`;
- pixel-years in same-label components `≥ MIN_PATCH_PIXELS` ÷ pixel-years reaching the sieve →
  `WATER_COVER_RETAINED_PCT` (**pixel-years, not hectares**: a run is area × time, and every
  year boundary is now a region boundary, so this bites harder than the change pass's 87.7%);
- run-length histogram in pixel-years (1, 2, 3–5, 6+) and the share of *runs* that are one year;
- water pixel-years at `transition == 0` (flicker JRC never classed) — if material, gate cover on
  `transition ≥ 1` for the v1.4 window and say so;
- max runs per pixel.

Then the densest cell (from the change pass's run log, the one that carried 59,443 regions) end to
end: feature count and download size, extrapolated island-wide. Only if the island-wide count is
unshippable through `tiles.py`'s no-drop rule, introduce `WATER_COVER_MIN_RUN_YEARS` with
`WATER_COVER_RUN_FLOOR_RETAINED_PCT`, stated in the caveat.

## `temporal_range()` / manifest

Unchanged. With v1.5 the slider runs to 2024 while `transition` stops at 2021; change is cumulative
and open, so 2022–24 draw the 2021 verdict. One caveat clause: after `GSW_V14_LAST_YEAR` the change
classes carry no new change; cover continues to `last`.

## Caveat sentences (constants interpolated)

1. "The cover layer is a year-by-year record from JRC's yearly history: each shape is a stretch of
   years over which the same ground was classed as water every year, and it is drawn only for those
   years — a pond that dried and refilled is several shapes, one per stretch."
2. "Where the source could not see a pixel, the nearest observed year's state is carried over — the
   record is blind for all of 1985 and most of 1984–1987 — so about {WATER_COVER_IMPUTED_PCT}% of
   the water-years behind this layer are carried rather than observed, and a stretch beginning in
   {first} may have begun earlier."
3. "Stretches pass the same single-pixel sieve, keeping about {WATER_COVER_RETAINED_PCT}% of the
   water-years that survive the managed-land rule."
4. "Cover and change come from two JRC products and can disagree at a body's edge by a year or two."
5. The temporal clause above, when `last > GSW_V14_LAST_YEAR`.

## Tests

- `encode_run` / `decode_run` round-trip incl. the open sentinel; `decode_run` refuses a label it
  cannot have produced.
- `impute_nearest`: blind years inside a run don't split it; leading blind years take the first
  observation; trailing blind years carry the last; all-blind is not water.
- `runs_of(states)` (pure): `[T,T,F,T]` → `[(0,2),(3,None)]`; single-year run is `(i, i+1)`;
  never `to == from`.
- `build_cover_feature`: schema-valid, `subtype` absent, `valid_to > valid_from` or null, `method`.
- `WaterDomain.change_types` includes `cover`; `test_manifest_entry_is_well_formed` passes it.
- Caveat contains each new constant's rendering; the plain-prose guard covers the new sentences.
- `test_config.py`: plausibility bounds on both constants.
- Shipped-data guard (skips if `data/water.geojson` absent): every cover feature has
  `valid_to > valid_from` or null, `subtype` absent, `valid_from ≥ range_first`.

**Acceptance criteria:**
- [x] Every cover feature `[valid_from, valid_to)` with `valid_to > valid_from` or null; `method`
      names run-length and imputation; `subtype` absent.
- [x] A blind year does not end a run; water first observed after only blind years starts at
      `range_first` (unit tests on the pure rule).
- [x] Cover and change apply the identical pixel mask (`managed_seasonal_keep()` called from both).
- [x] `WATER_COVER_RETAINED_PCT` and `WATER_COVER_IMPUTED_PCT` measured island-wide, quoted in the
      caveat, comments state numerator, denominator and basis.
- [x] Manifest measures water `changeTypes = ["cover", "gain", "loss", "stable"]` from tilestats.
- [x] `tiles.verify` passes with no drops.
- [x] The web tiles test passes for water against the regenerated archive (cover selection ==
      `from ≤ Y < to`, no double-draw); the change-kind expiry check now fails for water rather than
      warning — that is T-031's pressure, and the PR says so.

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check . && python -m trace_pipeline.cli extract water && python -m trace_pipeline.cli tiles water`
**Owner:** claude
