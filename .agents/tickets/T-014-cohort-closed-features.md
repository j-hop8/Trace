# T-014: Cohorts draw closed-ended features at the wrong year (water loss)

**Goal:** Make a feature's mark appear in the year its change is observed, not the year the feature
first came into existence — so water loss stops being drawn decades before it happens.

**Files in scope:**
- `web/src/domains/layerSpec.ts` (`cohortFilter`, `cohortYears`, `layerIdsForYear`)
- `web/src/components/*` readout, only if it quotes the same year
- `CLAUDE.md` (invariant 2, the open-ended precondition)
- tests under `web/src/**/__tests__` or equivalent

**Do NOT touch:**
- `web/src/domains/colors.ts` — `styleFor` stays the sole colour authority
- `pipeline/**` — `valid_from` / `valid_to` keep their B4 meanings; this is a rendering fix
- `data/**` — no re-extraction required

**Background:** Invariant 2 states the precondition outright: "Cohorts assume features are
open-ended (`valid_to: null`) ... A domain that ends a feature's validity needs this revisited, not
merely re-run." T-004's water domain is exactly that domain and shipped without the revisit.

`WaterDomain` sets `valid_to = last_year` for every `loss` patch (15,170 of 30,606 features in the
current extract) while `valid_from` stays the first year the patch was seen as water.
`cohortFilter` buckets on `valid_from` alone, so a pond that was water from 1988 and dried up in
1996 joins the **1988** cohort and is painted in loss red, with the A5 hatch, from 1988 onward.
Verified in the browser: at year 1990 the forest layer correctly reads "no data 1990" and the map
is still covered in loss red, all of it water whose loss year is anywhere up to 2021.

Two consequences, both silent:
- The change view overstates loss for early years by up to the full length of the record.
- `layerIdsForYear` makes those patches clickable at 1990, opening a readout for a loss that has
  not happened yet.

Forest is unaffected — its loss features carry `valid_from` = the loss year and `valid_to: null`.

**Suggested approach:** keep the filter constant per cohort (that property is what makes playback
free) and bucket on the year the mark becomes true rather than on `valid_from` alone — e.g.
`["coalesce", ["get", "valid_to"], ["get", "valid_from"]]`, which is a no-op for every open-ended
feature and therefore leaves forest byte-identical. Note tippecanoe omits null properties, so
`valid_to` is absent rather than null in the tiles. Decide and write down whether a loss observed
through `last_year` should show at `valid_to` or `valid_to + 1`; the pipeline documents `valid_to`
as the last year the patch was *still water*.

**Acceptance criteria:**
- [ ] A closed-ended feature first draws in the year its change is observed, not at `valid_from`
- [ ] Open-ended features are unchanged; forest's cohort assignment is identical to today
- [ ] Cohort filters remain constant at build time — no `setFilter` during playback, no
      data-driven paint property
- [ ] Hit-testing at year Y excludes closed-ended features whose change is later than Y
- [ ] A test covers a closed-ended feature: absent before its change year, present after
- [ ] CLAUDE.md invariant 2 describes the new rule rather than the open-ended precondition

**Verify:** `cd web && npm test && npm run typecheck && npm run format:check`
**Owner:** unassigned — human to triage
