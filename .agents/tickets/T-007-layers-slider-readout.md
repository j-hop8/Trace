# T-007: Domain layers, time slider, feature readout, attribution
**Goal:** The Phase 0 payoff — change you can see move, click, and read.

**Files in scope:**
- `web/src/domains/layerSpec.ts` (new)
- `web/src/components/{TimeSlider,LayerToggles,FeatureReadout,Attribution}.tsx` (new)
- `web/src/map/MapCanvas.tsx` (extend)

**Do NOT touch:** `pipeline/`, `schema/`.

**The rule that matters:** no component may contain a domain literal. Every layer is built by
mapping over `manifest.domains`. If a component needs to know something domain-specific, that
something belongs in the manifest.

**Time slider:** writes `year` to the store; each layer filters
`["<=", ["get", "valid_from"], year]` combined with a `valid_to` test. One tileset per domain,
filtered on the GPU — never swap tile sources per year.

**Feature readout:** renders the B4 properties as a plain-language sentence, e.g.
*"this pond: permanent in 1990, gone by 2008, −3.2 ha."* Use `readMetric()` from
`types/feature.ts` — vector tiles flatten `metric` to `metric.area_ha`, so reading
`props.metric.area_ha` returns undefined and silently renders a dash.

**Acceptance criteria:**
- [ ] Both domains render, coloured by `colorFor(hue, change_type)` — no colour literals outside
      `colors.ts`.
- [ ] Loss carries the hatch pattern from `patternFor`, so it is not signalled by colour alone.
- [ ] Dragging the slider animates loss accumulating, with no tile reload flicker.
- [ ] Slider bounds come from `combinedRange()` and change when domains are toggled — water from
      1984, forest from 2000.
- [ ] A domain not covering the current year is visibly "no data", not silently blank.
- [ ] Clicking a feature shows area in hectares and a date range.
- [ ] Attribution concatenates basemap + every active domain's `source.attribution`, and each
      layer's `caveat` is reachable from the UI.

**Verify:** `cd web && npm run typecheck && npm run build`, then drive it in the browser.
**Owner:** claude
