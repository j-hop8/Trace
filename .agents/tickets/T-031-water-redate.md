# T-031: water change dated at the year its verdict applies — loss when it went, never before
**Goal:** Date every water change feature at the year its verdict applies, make every change
feature open-ended, and enforce the two validity rules the schema has documented since T-028 — so
nothing is red on frame one that had not yet happened, and the first frame is *correct*, not
merely explained.

**Context:** Under the two-level taxonomy, `change` is a verdict accumulated since the record's
first year: drawn from the year it applies and for every year after. Water's change pass predates
that. It dates the `lost *` classes to when the water *was there* (`PRESENT_AT_START` →
`range_first`) and closes them at `valid_to`, so 71% of the loss layer paints on frame one and
then switches off — the opposite of accumulating. T-025(a) explained this in the caveat; this
ticket makes it right, and T-030's cover layer is what makes it safe: the water that existed
before it went is now carried by cover, so re-dating loss to the loss event loses nothing.

**Files in scope:** `pipeline/trace_pipeline/domains/water.py`, `pipeline/trace_pipeline/config.py`,
`pipeline/trace_pipeline/schema.py` (the two deferred rules), `pipeline/tests/test_water.py`,
`pipeline/tests/test_config.py`, `pipeline/tests/test_schema.py`, `pipeline/tests/fixtures/*.geojson`
(closed `loss` examples become `cover`), `.agents/tickets/T-020-*.md` and `T-025-*.md` (closed),
`data/water.*` and `data/domains.json` (regenerated).

**Do NOT touch:** the cover pass (`cover_states`, `cover_runs`, `cover_run_labels`,
`cover_patches_for_cell`, `extract_cover`, `build_cover_feature`, `impute_nearest`); `ENDED`;
`CHANGE_TYPE_BY_TRANSITION`; `MASK_ON_MANAGED_LAND`; `MIN_PATCH_PIXELS`; `web/**`;
`schema/feature.schema.json`; `forest.py`.

## The dating rule

`PRESENT_AT_START` is replaced by a four-way partition of JRC's roster, each derivable from JRC's
own class names (the test derives it, as T-021 did for `ENDED`):

| set | classes | `valid_from` |
|---|---|---|
| `STABLE_FROM_START` | 1 `permanent`, 4 `seasonal` | `range_first` — present throughout |
| `ARRIVED` | 2 `new permanent`, 5 `new seasonal` | `max(first_seen, range_first)` — today's rule |
| `ENDED` | 3, 6 `lost *`; 9, 10 `ephemeral *` | **`last_seen + 1`** — the first year the yearly record no longer sees water |
| `EPOCH_VERDICT` | 7 `seasonal to permanent`, 8 `permanent to seasonal` | **`GSW_EPOCH_2_FIRST_YEAR` = 2000** |

`valid_to` is always `None`. `derive_valid_to` is deleted.

**Why `last_seen + 1`.** `last_seen` is the median last year a pixel was *seen* as water — the last
year it existed. Under half-open cover its run is `[f, last_seen + 1)`, so the loss must begin at
`last_seen + 1` for cover and loss to hand off with no year in common, the relation forest has
between `[2000, L)` and `[L, null)`. If `last_seen + 1 > range_last` the end was not observed
inside the record: the region is **undatable** and counted, not capped — capping would assert an
end the source never saw. Measured on the shipped output: zero such regions.

**Why 2000 for classes 7 and 8.** They are verdicts JRC reaches by comparing its two epochs, and
carry no year of their own. The one date the class itself carries is the first year of the epoch
in which JRC made the judgement. Dating them 1984 asserts the decline (or the gain) held in the
epoch where the pixel was the *other* thing — the frame-one complaint. Measuring a year attaches
a Trace-invented date to a JRC verdict, which T-025 warned against. Class 7 → 2000 extends the
class-8 decision by the same reasoning; T-021's 1984 for it was about not losing the water from
the map, and cover carries that now.

## The two rules, enforced

Deferred from T-028 because the water extractor violated both; after this ticket no domain does:

- `_check_properties`: `valid_to <= valid_from` is an empty interval → rejected.
- `_check_properties`: a change-kind feature (`kind_of()[change_type] == "change"`) with a
  non-null `valid_to` → rejected.
- `test_same_year_start_and_end_is_allowed` flips to rejected; fixtures whose closed example was a
  `loss` become `cover`, so each fixture still exercises exactly one rule.

## Bookkeeping

- `extract`: `needs_onset = code in ARRIVED`; `needs_end = code in ENDED`; plus the end-beyond-record
  case; count and sum the area of what is skipped. → `WATER_UNDATABLE_DROPPED_PCT` (share of
  post-sieve change area), quoted in the caveat, replacing "not yet folded into the percentages".
- Delete `WATER_LOSS_DATED_AT_START_PCT`, its comment, its caveat passage, and the three T-025(a)
  tests. Add `GSW_EPOCH_2_FIRST_YEAR`.
- Re-measure `WATER_SOURCE_RETAINED_PCT` and `WATER_LOST_PERMANENT_PCT` from this run, stating
  numerator and denominator — the denominator with a real probe this time (T-020).
- Caveat: replace "loss is dated from when the water was there…" with: "Change accumulates: a
  change is drawn from the year it applies and for every later year; the cover layer is where to
  see what existed in a given year. Loss is dated to the first year the yearly record no longer
  sees water where JRC says it was lost or ephemeral. The two classes JRC judges by comparing its
  epochs — seasonal water that became permanent, and permanent water that dropped to seasonal —
  carry no year of their own and are drawn from {GSW_EPOCH_2_FIRST_YEAR}, the first year of the
  epoch in which JRC made that judgement."
- Close T-020 (its re-measure items are done here) and T-025 ((a)'s artefacts deleted, (b)
  dissolved: frame one shows no loss that has not happened).

**Acceptance criteria:**
- [ ] No water change feature carries a non-null `valid_to` (shipped-data test).
- [ ] `derive_valid_from(6, first_seen=1984, last_seen=2015, range_first=1984) == 2016`;
      `(8, …) == GSW_EPOCH_2_FIRST_YEAR`; `(2, first_seen=1988, …) == 1988`; `(1, …) == range_first`.
- [ ] The four sets partition the roster and are derived from JRC's names by a test.
- [ ] An `ENDED` region with `last_seen == range_last` is counted undatable, not dated.
- [ ] `_check_properties` rejects an empty interval and a closed change feature; every fixture
      exercises exactly one rule.
- [ ] `WATER_SOURCE_RETAINED_PCT`, `WATER_LOST_PERMANENT_PCT`, `WATER_UNDATABLE_DROPPED_PCT`
      measured on this run; `WATER_LOSS_DATED_AT_START_PCT` gone.
- [ ] The web tiles test's change-kind expiry check passes for water; frame 1984 draws no loss.
- [ ] T-020 and T-025 in `done/` with a closing note.

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check . && python -m trace_pipeline.cli extract water && python -m trace_pipeline.cli tiles water`
**Owner:** claude
