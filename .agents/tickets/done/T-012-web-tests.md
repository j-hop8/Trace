# T-012: A test suite for the web layer, starting with the cohort model
**Goal:** Give `web/` a test runner and cover the cohort layer properties that decide whether the
time slider animates correctly — including a check against the real tileset, so the claim that
cohorts select what the old live filter selected is enforced rather than argued.

**Files in scope:**
- `web/package.json` (vitest + the tile decoders as devDependencies, `test` script)
- `web/src/domains/layerSpec.test.ts` (new)
- `web/src/domains/layerSpec.tiles.test.ts` (new)
- `CLAUDE.md` (command table)

**Do NOT touch:**
- `web/src/domains/layerSpec.ts`, `web/src/map/**` — this ticket adds tests, it does not change
  behaviour. A test that needed the code changed to pass is a finding, not a licence to edit.
- `pipeline/**`, `data/**` — `data/` is generated; the suite reads it if present and skips if not

**Background:** T-011 replaced the live year filter with per-year cohort layers. Nothing about that
is visible to the typechecker: whether a cohort's selection is fixed rather than rewritten as the
slider moves, whether draw order survives the split, and whether the work per step stays constant
were all confirmed only by looking at the map. The browser available to this session cannot render
(0 animation frames at 0x0, hidden), so those properties were verified with throwaway scripts. This
ticket makes that verification permanent and reproducible.

**Acceptance criteria:**
- [ ] `npm test` runs in `web/` with no prior setup beyond `npm install`
- [ ] Cohort filters are asserted identical whatever year is shown — the property that makes the
      animation free of tile re-parsing
- [ ] Draw order asserted: extent cohorts beneath cleared cohorts, each role's cohorts contiguous
- [ ] Opacity gating asserted, including that a shown cohort uses its role's own opacity and that
      transitions are instant
- [ ] Work per step asserted constant across the range — the regression that caused playback to
      start fast and crawl
- [ ] Hit-test layer list asserted to exclude cohorts after the shown year
- [ ] A test decodes the real `data/forest.pmtiles` and asserts, with MapLibre's own filter
      evaluator, that shown cohorts select exactly what a `valid_from <= year` filter would, for
      every year and role
- [ ] That test **skips** rather than fails when `data/` has not been generated
- [ ] The cohort precondition (no feature carries `valid_to`) is asserted against real tiles, so the
      pipeline emitting one fails the suite instead of silently drawing features past their end

**Verify:** `cd web && npm test && npm run typecheck && npm run format:check`
**Owner:** claude
