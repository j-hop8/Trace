# T-023: unify layer selection on change_type, and make colour a pure domain ramp
**Goal:** Replace forest's exclusive `變化`/`覆蓋` view switch with one multi-select toggle per
`change_type` for every domain, and replace the shared cross-domain loss red with a per-domain
colour ramp so hue always names the domain.

**Files in scope:**
- `web/src/domains/colors.ts` (+ new `web/src/domains/colors.test.ts`)
- `web/src/domains/layerSpec.ts`, `web/src/domains/layerSpec.test.ts`, `web/src/domains/layerSpec.tiles.test.ts`
- `web/src/domains/manifest.ts`
- `web/src/store/useTraceStore.ts`
- `web/src/components/LayerToggles.tsx`
- `web/src/map/useDomainLayers.ts`
- `CLAUDE.md`

**Do NOT touch:** `pipeline/**`, `data/**`, `schema/**`, `web/src/map/basemap/**`. The manifest
contract is unchanged — `changeTypes` is already measured and emitted; version stays 1.

**Acceptance criteria:**
- [ ] Each domain shows one toggle per entry in its measured `changeTypes`, multi-select, iterated
      from the manifest. No domain id appears in any component.
- [ ] `ViewMode` and `supportsExtentView` are gone; nothing imports them.
- [ ] `styleFor(hue, changeType)` returns `{ color, mark, stroke, pattern }` and contains no colour
      that is shared between two different hues — every state is a transform of the domain's own hue.
      `loss.pattern === 'hatch'` still holds (A5).
- [ ] `loss.mark` and `loss.stroke` are lighter than `loss.color`, so a sub-pixel loss patch is
      visible against the near-black basemap at island zoom.
- [ ] Layer roles are derived from `entry.changeTypes`: a domain without `extent` builds no
      `extent-*` or `cleared-*` layers. `cleared-*` is gated by the extent toggle, not the loss one.
- [ ] No `fill-color` or `line-color` is a `match` expression — every paint colour is a constant.
- [ ] Every domain and every change type is on at first load; un-checking a domain's last change
      type switches the domain off.
- [ ] Each toggle carries a swatch drawn from `styleFor`, so the control doubles as the legend.
- [ ] `CLAUDE.md`'s "Colour is a pure function" section describes the ramp, not the shared red.

**Verify:** `cd web && npm run typecheck && npm test && npx prettier --check .`
**Owner:** claude
