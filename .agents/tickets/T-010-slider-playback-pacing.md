# T-010: Pace time-slider playback to the map
**Goal:** Make the play button animate year by year instead of freezing and snapping to the final
year, by never issuing a new year while a MapLibre source reload is still in flight.

**Files in scope:**
- `web/src/store/useTraceStore.ts`
- `web/src/map/useDomainLayers.ts`
- `web/src/components/TimeSlider.tsx`
- `web/src/components/LayerToggles.tsx`

**Do NOT touch:**
- `web/src/domains/layerSpec.ts` — the filter expressions and paint specs are correct as they are
- `web/src/domains/colors.ts` — no colour logic changes
- `pipeline/**`, `data/**` — this is a frontend scheduling fix, not a data change

**Background:** Every MapLibre style mutation (`setFilter`, data-driven `setPaintProperty`,
`setLayoutProperty('visibility')`, and `global-state` in a filter) routes through
`Style._updateLayer` → `_reloadSource` → a full worker re-parse of every loaded tile. With 158,118
polygons in `forest.pmtiles` that re-parse cannot finish inside the ~167 ms tick budget at
6 yr/s, so reloads supersede each other and only the last year ever paints. Only a *constant*
`setPaintProperty` skips the reload, and it cannot express a per-feature year test — so the fix is
to stop queueing reloads faster than they complete.

**Acceptance criteria:**
- [ ] `year` (requested, drives the thumb) and `renderedYear` (drawn, drives the readout) are
      separate store fields; both are clamped on domain toggle
- [ ] At most one year commit is in flight at a time; intermediate requests are coalesced, not
      queued, so a fast drag lands on the released year
- [ ] Playback advances only once the map has settled, capped at a maximum of 6 yr/s
- [ ] Playback cannot wedge: a settle timeout recovers, and toggling a domain mid-playback recovers
- [ ] Pressing play at the end of the range restarts at `range.start` and that year is actually
      shown (today the first visible frame is `range.start + 1`)
- [ ] The numeric readout never names a year the map has not drawn
- [ ] Comments claiming year changes are GPU-side / "cheap enough to run on every tick" are corrected

**Verify:** `cd web && npm run typecheck && npm run format:check`
**Owner:** claude
