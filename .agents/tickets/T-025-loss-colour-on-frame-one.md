# T-025: the first frame paints 71% of the layer's loss — a record-long verdict wearing a 1984 date
**Goal:** Stop the water layer's opening frame from reading as "in 1984 a third of Taiwan's west
coast was lost", when what it actually shows is water that *existed* in 1984 and was lost sometime
over the following 37 years.

**Context:** Reported by the user looking at the slider's first frame and asking whether 1984 was
being compared against 1983. It is not — nothing in this layer is a year-on-year diff, and the
question is the evidence that the frame implies one.

Three things compose into the misread, each individually correct:

1. JRC's `transition` band is **one verdict over the whole record** — epoch 1 (1984-1999) against
   epoch 2 (2000-2021). `CHANGE_TYPE_BY_TRANSITION`
   (`pipeline/trace_pipeline/domains/water.py:99`) maps `lost permanent` (3), `lost seasonal` (6)
   and `permanent to seasonal` (8) to `loss`.
2. All three are in `PRESENT_AT_START`, so `derive_valid_from`
   (`pipeline/trace_pipeline/domains/water.py:335`) gives them `valid_from = range_first = 1984`
   unconditionally — the T-021 decision, and the right one: GSW has no usable observation of
   Taiwan in 1985, so a measured onset dates the satellite, not the water.
3. Cohorts accumulate from `valid_from` (`cohort <= year`,
   `web/src/domains/layerSpec.ts:465`), and the first cohort sweeps up everything `<= start`.

So every feature whose class says "was water in epoch 1, and later went" lights up on frame one, in
the loss colour, hatched. Measured from the shipped `data/water.geojson`:

| subtype | features | area | dated 1984 |
|---|---|---|---|
| `lost seasonal` | 18,880 | 10,995 ha | 100% |
| `permanent to seasonal` | 15,614 | 9,936 ha | 100% |
| `lost permanent` | 4,758 | 3,547 ha | 100% |
| **on frame one** | **39,252** | **24,477 ha** | **70.9% of all loss area** |

That is 24.1% of the entire layer. The remaining loss is the two `ephemeral *` classes, which do
get measured onsets and so arrive across the record as they should.

It reads as coastal because it is: gridded at 0.1°, the 1984 loss is the west-coast strip from
Pingtung to Changhua — 濁水溪 mouth (120.2, 23.8) at 1,997 ha and 65% of its cell, 大肚溪 /彰化
(120.4, 24.1) at 1,458 ha and 68%, then the 嘉義/台南 aquaculture belt. Tidal flats, braided river
mouths and fish ponds are exactly the surfaces JRC classes seasonal-grade. Mountain reservoirs are
`permanent`/stable, so they stay out of the red and the pattern reads as a coastline.

**Distinct from T-024, and the opposite end of the same feature.** T-024 is that `lost *` features
keep drawing *after* their `valid_to`. This is that they draw at their *start* wearing an end-state
colour. Fixing T-024 does not fix this: a feature that ended in 1998 would correctly vanish in 1999
and still be red in 1984.

**Why this is a product bug and not a nitpick:** it is the same failure the retained-percentage
rule in `CLAUDE.md` exists to prevent — a true number arranged so the reader takes a much stronger
claim from it. The caveat already says loss is broader than disappearance and that pre-record water
is dated 1984, but it never connects the two, and a reader watching the animation will not read a
600-word caveat to reinterpret what the first frame just showed them.

**Files in scope:** `pipeline/trace_pipeline/domains/water.py` (`caveat`),
`pipeline/trace_pipeline/config.py` (a measured constant for the share), `pipeline/tests/test_water.py`,
`pipeline/tests/test_config.py`. If the render fix is taken: `web/src/domains/layerSpec.ts`,
`web/src/domains/layerSpec.test.ts`.

**Do NOT touch:** `derive_valid_from` / `PRESENT_AT_START` — the 1984 dating is correct and T-021
settled it. The colour system. `schema/**`. The extraction itself: this needs no re-run.

**Design notes (not a decision — the ticket owner picks):**

- **(a) Say it, in the caveat.** Cheapest, independently shippable, no dependency on T-024. One
  sentence in `WaterDomain.caveat` stating that loss is dated from when the water was *there*, not
  when it went, so the earliest years show water that would later be lost — with the share as a
  measured constant beside `WATER_LOST_PERMANENT_PCT` rather than a literal, per the config
  convention. Re-measure on any run that changes the class composition.
- **(b) Colour it for the year.** A loss feature draws in the domain's extent colour from
  `valid_from` until `valid_to`, switching to the loss colour and hatch only at the year it ends.
  Truthful frame by frame and it makes the animation carry the change instead of the legend — but
  it needs the `valid_to` cohort axis T-024 is costing, so it depends on T-024 landing first, and
  it is a change to what a `change_type` toggle means: selecting "loss" would show extent-coloured
  features in early years. Check that against `selectableTypes` and the toggle copy before
  committing to it.
- (b) does not remove the need for (a): even with per-year colouring, `permanent to seasonal` is
  9,936 ha of water that never ended and is still called loss.
- The three classes carry no information about *when* they went — that is what an epoch comparison
  costs. Any fix that implies a loss year for classes 3/6/8 beyond the `ENDED` measurement is
  inventing one; class 8 has no `valid_to` at all.

**Status:** option (a) landed on `claude/T-025-loss-colour-on-frame-one`. The layer now states
the fact and its size. Option (b) is still open and still blocked on T-024's `valid_to` axis —
the first frame is now *explained*, not yet *correct*.

**Acceptance criteria:**
- [ ] A reader looking at the first frame of the water timeline can tell that the red is water
      present then and lost later, not water lost that year — from the UI, without the caveat.
- [x] If (a): the share is a named constant in `config.py`, measured from the shipped output, with
      the comment stating what it is a share of (loss area, not layer area — the two are 70.9% and
      24.1% and quoting the wrong one misstates the layer).
- [ ] If (b): the existing `cost of a step` property in `layerSpec.test.ts` still passes.
- [x] No change to any feature's `valid_from`, `change_type` or `subtype`.

**Verify:** `cd pipeline && pytest && ruff check .` (plus `cd web && npm test` if (b) is taken)
**Owner:** unassigned — triage
