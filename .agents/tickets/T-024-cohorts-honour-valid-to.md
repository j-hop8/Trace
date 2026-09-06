# T-024: cohorts must honour valid_to — 42k water features draw past the year they ended
**Goal:** Make the cohort layer model switch a feature *off* at `valid_to`, so JRC's `lost *` and
`ephemeral *` water classes stop rendering for years in which they no longer existed.

**Context:** `cohortFilter` keys on `valid_from` alone and a cohort, once on, never switches off —
stated as a precondition at `web/src/domains/layerSpec.ts:81-85` and in `CLAUDE.md`:
"Cohorts assume features are open-ended (`valid_to: null`), which is what the pipeline emits."
That is no longer true. `data/water.geojson` carries **42,417** features with a non-null `valid_to`
(`derive_valid_to`, `pipeline/trace_pipeline/domains/water.py:353`, for the `ENDED` classes
3 `lost permanent`, 6 `lost seasonal`, 9 `ephemeral permanent`, 10 `ephemeral seasonal`).
A patch that ended in 1998 keeps drawing through 2021.

Present in `main` — not introduced by T-023, but T-023 makes water loss independently selectable,
which puts it in front of the reader.

**Files in scope:** `web/src/domains/layerSpec.ts`, `web/src/domains/layerSpec.test.ts`,
`web/src/domains/layerSpec.tiles.test.ts`, and `CLAUDE.md`'s cohort paragraph. Possibly
`pipeline/trace_pipeline/domains/water.py` if the fix is better made at emission time.

**Do NOT touch:** the colour system, the toggle UI, `schema/**`.

**Design notes (not a decision — the ticket owner picks):**
- The constraint that makes this hard is the one the design exists for: the year must stay a
  *constant paint change*. A live `valid_to >= year` filter re-tessellates every tile per step,
  which is the regression T-011 removed.
- Two shapes worth costing: (a) a second cohort axis keyed on `valid_to`, giving paired
  `(from, to)` cohorts — correct but combinatorial, up to 38×38 for water; (b) note that classes 3
  and 6 always carry `valid_from == range_first`, so only the ephemeral classes (9, 10 — ~18.8k
  features) genuinely need pairs, and the rest can be a single "ends in year E" cohort set.
- Whatever lands must keep `layerSpec.test.ts`'s "cost of a step" property: writes per step must
  not grow with the year.

**Acceptance criteria:**
- [ ] A feature with a non-null `valid_to` is not drawn for any year after it.
- [ ] Per-step paint writes stay constant in the year (the existing `cost of a step` test still passes).
- [ ] `layerSpec.tiles.test.ts` checks the cohort/`valid_to` agreement for **every** domain in the
      manifest, not just `domains[0]` — today it reads forest only, which is why this went unnoticed.
- [ ] `CLAUDE.md`'s open-ended-cohort paragraph is rewritten to describe what actually happens.

**Verify:** `cd web && npm test`
**Owner:** unassigned — triage
