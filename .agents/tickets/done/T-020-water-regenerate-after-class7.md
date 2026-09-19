# T-020: Re-extract the water layer and confirm the two derived percentages

**Goal:** Bring `data/` back in step with the code after T-019's review fix changed `valid_from`
for JRC class 7, and replace the two constants that were computed by arithmetic rather than
measured with real probes.

**Files in scope:**
- `pipeline/trace_pipeline/config.py` (`WATER_SOURCE_RETAINED_PCT`, `WATER_LOST_PERMANENT_PCT`
  and its per-class composition comment)
- `pipeline/tests/test_config.py` if a bound changes
- `data/**` — regenerate (gitignored)

**Do NOT touch:** `web/`, `schema/feature.schema.json`, `domains/forest.py`, and none of the
extraction logic — the classification is settled, this ticket only re-measures it.

**Background.** The review pass on the T-015..T-019 stack found JRC class 7
(`seasonal to permanent`) missing from `PRESENT_AT_START`. It reads as an arrival — it is a
`gain` — so it was grouped with `new permanent` / `new seasonal` and given a measured onset, which
put water JRC says was already there in epoch 1 back into the blind 1988-93 years. Fixed in
`67ac3f1`, but the fix changes `valid_from` on every class-7 feature, so the extract that shipped
with T-019 no longer matches the code that produced the claims about it.

Two constants were also corrected without a probe, from figures recorded in earlier commit
messages rather than measured:

- `WATER_SOURCE_RETAINED_PCT` = 75.5 (101,567 / 134,600 ha) — the layer's completeness against
  what JRC records, which neither `WATER_RETAINED_PCT` nor `WATER_MANAGED_SEASONAL_DROPPED_PCT`
  states on its own. Both its terms predate the class 7 fix.
- `WATER_LOST_PERMANENT_PCT` = 3.5 (3,547 / 101,567 ha) — was 3.0 against T-017's 117,204 ha layer
  and rode through T-018 and T-019 unchanged while they cut the layer by 12.6%. The numerator is
  believed unchanged (class 3 is kept by the managed-land rule, and T-019 measured every non-masked
  class unchanged to the hectare) but that has not been re-verified since.

The per-class composition behind `WATER_LOST_PERMANENT_PCT` (ephemeral / lost seasonal / permanent
to seasonal shares) was dropped rather than rescaled: it was measured on the stale denominator and
two of its classes are cut by the managed-land rule, so it is not rescalable.

**Also worth doing while the numbers are open:** `extract` counts regions it skips as undatable and
prints the count, and the caveat now admits that count is not folded into any published percentage.
This run is the chance to measure it and either fold it in or state it.

**Acceptance criteria:**
- [x] `data/` regenerated end to end — extract, tiles, manifest — on the current code
- [x] Class 7 features carry `valid_from = range_first`, and a named control that is
      `seasonal to permanent` is checked by hand in the output
- [x] `WATER_SOURCE_RETAINED_PCT` and `WATER_LOST_PERMANENT_PCT` replaced with measured values,
      each comment stating its numerator and denominator as run
- [x] The `lost permanent` numerator re-verified rather than assumed
- [x] The undatable count measured, and either folded into the published percentages or stated
      in the caveat with a figure
- [x] Every other T-015..T-019 acceptance criterion still holds on the new extract — the named-body
      regression table especially

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check .`
**Owner:** claude

**Closed by T-031 (2026-09-19).** `data/` was regenerated end to end on T-030 and again on T-031.
`WATER_SOURCE_RETAINED_PCT` is 76.5 — 101,339 of 132,440 ha, raster to raster with a real probe
for the denominator (the old 134,600 came from a commit message and was 1.6% high).
`WATER_LOST_PERMANENT_PCT` re-verified at 3.5 (3,538 of 101,339 ha raster; 3,547 of 101,567
vector). The undatable count was measured at zero on both runs and is quoted as
`WATER_UNDATABLE_DROPPED_PCT`; the caveat says "dropped none" rather than deferring to the log.
Class 7 no longer carries `range_first` — T-031 dates it to the epoch boundary, 2000, for the
reasons in `water.py`'s partition comment; the named-body regression table's premise for class 7
is therefore superseded, not violated.
