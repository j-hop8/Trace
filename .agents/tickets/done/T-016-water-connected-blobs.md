# T-016: One water feature is 23% of the layer — connected components merge unrelated ponds

**Goal:** Stop a single vectorized patch spanning 67 km and carrying one date pair, so a click on
the southwest coast stops reporting 30,305 ha "lost between 1990 and 2020" as though it were one
thing that happened.

**Files in scope:**
- `pipeline/trace_pipeline/domains/water.py` (`patches_for_cell`, and the vectorizing step)
- `pipeline/tests/test_water.py`
- `data/**` — regenerate

**Do NOT touch:**
- The land mask from T-015 — this is what the mask revealed, not a regression in it
- `pipeline/trace_pipeline/domains/forest.py`, `web/**`, the B4 schema

**Background:** Found while verifying T-015. With the sea removed, the largest remaining feature is
30,305 ha — 23.2% of the layer's total area — spanning (120.035, 22.993) to (120.310, 23.600),
which is 30 x 67 km of the Chiayi–Tainan–Kaohsiung coastal plain. It is the aquaculture pond belt,
joined into one connected component through channels and drains, and `reduceToVectors` gives that
whole component a single `first_year` / `last_year`, hence a single `change_type` and one
`metric.area_ha`.

This is not caused by T-015 — before the land clip this belt was connected to the sea and absorbed
into the 443,109 ha ocean polygon, so it was invisible as a distinct problem. Removing the ocean
made it the largest feature on the map.

Why it matters beyond tidiness: the readout renders one sentence per feature, so this one says
"This permanent: lost between 1990 and 2020, 30,305 ha". Every part of that is an artefact of the
merge. Thousands of separate ponds with their own histories are being described by the envelope of
all of them, and the 1990–2020 span is the union of the earliest and latest water year anywhere in
a 67 km belt.

`WATER_GRID`'s comment already documents the *cell-boundary* half of this ("a water body
straddling a cell edge comes back as two features"). This is the opposite failure — bodies that
should be separate coming back as one — and it is the larger of the two.

**Open questions for whoever takes it:**
- Is there a defensible split? Options include a morphological opening to break one-pixel channel
  connections, splitting on JRC's `transition` class so ponds with different histories separate,
  or a maximum feature size above which a patch is subdivided.
- Any split changes what `area_ha` means and may change `change_type` for the pieces, so the
  caveat has to move with it.
- Whatever is chosen, state the retained percentage — the honesty rule applies here exactly as it
  does to the minimum mapping unit.

**Acceptance criteria:**
- [ ] No single feature carries a double-digit percentage of the layer's total area
- [ ] The chosen split is justified by measurement, not intuition, and recorded in the module
- [ ] The caveat states what a water feature's boundary now means
- [ ] `data/` regenerated

**Verify:** `cd pipeline && pytest && ruff check .`
**Owner:** unassigned — human to triage

**Superseded by T-017**, which splits features per JRC transition class — that segmentation is
the split this ticket asked for, and it was done together with the change_type fix because a
correct class on a 67 km blob is still a wrong answer.
