# T-011: Animate the year with cohort layers instead of a live filter
**Goal:** Make playback run at an even, fast rate by splitting each domain's layers into one cohort
per year with build-time-fixed filters, animated by constant opacity — so moving the slider never
re-parses a tile.

**Files in scope:**
- `web/src/domains/layerSpec.ts`
- `web/src/map/useDomainLayers.ts`
- `CLAUDE.md` (invariant 2)

**Do NOT touch:**
- `web/src/domains/colors.ts` — `styleFor` stays the sole colour authority
- `web/src/components/*`, `web/src/store/*` — the requested/rendered split from T-010 is unchanged
- `pipeline/**`, `data/**` — no data change

**Background:** T-010 made playback correct (every year renders, in order) but not even. The change
view's filter is cumulative, so each step re-tessellated every loss feature from 2001 to the current
year: 2,656 at 2001 against 91,088 at 2025, a 34x growth that showed up as playback starting fast
and gradually slowing. Verified in maplibre-gl 5.24: `setFilter`, a `global-state` filter, a
data-driven paint property and a visibility change all route to `_reloadSource`. Only a *constant*
paint value skips it, which is what cohorts make possible. This amends CLAUDE.md invariant 2, which
previously forbade stacked yearly layers; one tileset per domain and time-as-attribute are kept.

**Acceptance criteria:**
- [ ] Layers are built one per role per year; a cohort's filter is fixed and identical whatever year
      is being shown
- [ ] The first cohort takes `valid_from <= temporal.start`, so a pre-range baseline is not orphaned
- [ ] The year is applied only as constant `fill-opacity` / `line-opacity`, read back off each
      role's own paint rather than restated
- [ ] Draw order still groups by role, so cleared patches paint over the extent they cut
- [ ] Hit-testing and the hover cursor ignore cohorts after the shown year — they are present at
      zero opacity and `queryRenderedFeatures` reads geometry, not paint
- [ ] Opacity transitions are instant, so a year is never shown half-drawn
- [ ] CLAUDE.md invariant 2 describes what the code actually does

**Verify:** `cd web && npm run typecheck && npm run format:check`
**Owner:** claude
