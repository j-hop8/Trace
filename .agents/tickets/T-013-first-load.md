# T-013: Show the basemap before the data on first load
**Goal:** Stop the first visit sitting on a black screen, by holding the domain layers back until the
basemap has painted and saying so while the data is still arriving.

**Files in scope:**
- `web/src/map/useDomainLayers.ts`
- `web/src/store/useTraceStore.ts`
- `web/src/components/LayerToggles.tsx`
- `web/src/store/useTraceStore.test.ts` (new)

**Do NOT touch:**
- `web/src/domains/layerSpec.ts` — cohorts, opacity and draw order stay exactly as T-011 left them.
  This ticket changes *when* sources are added, never how the year is animated.
- The commit loop in `useDomainLayers.ts` (`pump`, settle, `applied`) — same reason.
- `pipeline/**`, `data/**` — the payload is not the problem, the ordering is.

**Background:** At the opening view (`fitBounds` on TAIWAN_BOUNDS, about z8) the basemap needs 12
tiles / 498 KB while forest needs 11 tiles / 7.5 MB — roughly 15x. The domain layers are added on
`styledata`, when the stylesheet finishes parsing and before any tile has been drawn, so MapLibre
starts fetching and parsing 7.5 MB of polygons through 75 visible cohort layers while the basemap is
still trying to make its first paint. The page background (`ink-950`) and the style's own background
layer (`#0a0a09`) are both near-black by design, so there is nothing to look at meanwhile.

**Acceptance criteria:**
- [ ] Domain layers are not added until the basemap has painted
- [ ] A timeout backstop guarantees they are added anyway — MapCanvas uses `styledata` rather than
      `load`/`idle` precisely because a background tab pauses rendering, and gating on `idle` with no
      fallback would reintroduce the "layers never added" bug its comment describes
- [ ] A domain that is active but whose tiles have not loaded says so, reusing the existing badge
      pattern in LayerToggles rather than introducing new visual language
- [ ] The loading badge takes precedence over `no data {year}`
- [ ] Source-readiness updates do not re-render LayerToggles on every `sourcedata` event — the store
      is written only when membership actually changes
- [ ] `isSourceLoaded` is never called for a source the map does not have (it fires an ErrorEvent)
- [ ] Scrubbing during the wait still lands correctly: layers are built with the year current at the
      moment they are added
- [ ] The T-011/T-012 cohort suite still passes untouched

**Verify:** `cd web && npm test && npm run typecheck && npm run format:check`
**Owner:** claude
