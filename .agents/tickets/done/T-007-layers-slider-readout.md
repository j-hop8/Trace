# T-007: Domain layers, time slider, feature readout, attribution
**Goal:** The Phase 0 payoff — change you can see move, click, and read.

**Files in scope:**
- `web/src/domains/layerSpec.ts` (new)
- `web/src/components/{TimeSlider,LayerToggles,FeatureReadout,Attribution}.tsx` (new)
- `web/src/map/MapCanvas.tsx` (extend)
- **Scope amended** — three files beyond the list, with reasons:

  | File | Why |
  |---|---|
  | `web/src/map/useDomainLayers.ts` (new) | Layer add/remove/filter has a different lifetime from the map itself. Putting it in `MapCanvas`'s effect would rebuild the map on every layer toggle. |
  | `web/src/types/feature.ts` | `readMetric()` was wrong — see below. The ticket instructs using it, and as written it returned `undefined` for every tiled feature. |
  | `web/src/App.tsx` | Has to mount the four new components; the ticket named them without naming their host. |

**Do NOT touch:** `pipeline/`, `schema/`.

## `readMetric` was wrong, and T-005 proved it

This ticket says vector tiles flatten `metric` to `metric.area_ha`. Measured against the real
tileset, they do not: MVT has no nested values, so tippecanoe serialises the object to a **JSON
string**, `'{"area_ha":0.1397}'`. The original helper handled flattened and nested shapes only, so
it returned `undefined` for every tiled feature — and because it returns rather than throws, the
readout would have shown "—" for a number the pipeline definitely measured, with nothing to say
the value was lost in transit. All three shapes are handled now.

`valid_to` also never reaches the tiles: every forest value is null and tippecanoe drops null
attributes. The time filter therefore tests `["!", ["has", "valid_to"]]` rather than comparing the
key, since a feature whose state has not ended carries no `valid_to` at all.

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
- [ ] Both domains render, styled by `styleFor(hue, change_type)` — no colour literals outside
      `colors.ts`.
- [ ] Loss carries the hatch pattern that `styleFor` returns alongside the colour, so it is never
      signalled by colour alone.
- [ ] Dragging the slider animates loss accumulating, with no tile reload flicker.
- [ ] Slider bounds come from `combinedRange()` and change when domains are toggled — water from
      1984, forest from 2000.
- [ ] A domain not covering the current year is visibly "no data", not silently blank.
- [ ] Clicking a feature shows area in hectares and a date range.
- [ ] Attribution concatenates basemap + every active domain's `source.attribution`, and each
      layer's `caveat` is reachable from the UI.

**Verify:** `cd web && npm run typecheck && npm run build`, then drive it in the browser.
**Owner:** claude
