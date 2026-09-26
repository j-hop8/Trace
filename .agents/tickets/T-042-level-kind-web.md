# T-042: draw `level` domains — web spine
**Goal:** The web draws any manifest domain whose states are `level` as a ramp of its hue with a
legend and a readout, with no domain literals, and with year steps still costing only constant
opacity writes.

**Depends on:** T-041 merged (manifest v4, `measure`, `level:*` source layers).

**Design (decided with the user):**
- `ChangeType` / `Kind` gain `level`; `KIND_ORDER = ['level','cover','change']` — a level domain
  is a backdrop and categorical domains draw over it. `level` uses the interval cohort model.
- `colors.ts`: `rampFor(hue, bandCount): FeatureStyle[]` — lightness ramp of the domain hue,
  dark → hue → light, no pattern. Still the only file with colour literals.
- Paint: one fill (+ outline) style layer per level node; `fill-color` is a build-time
  `['step', ['get','band'], …]` from `rampFor`, never passed to `setPaintProperty`. MapLibre
  decides reload per property being set (`style_layer.ts` `setPaintProperty`), and this app only
  ever writes constant opacity (`opacityChannel`). Relax `layerSpec.test.ts` "paint never reads a
  feature" to *level layers may read `band` in colour only*; every other layer keeps no `get`, and
  opacity never reads a feature anywhere. Fallback if the browser check shows reloads: one style
  layer per band × node, no data-driven paint.
- Level domains are **off at load** and **mutually exclusive** (`useTraceStore`); categorical
  domains still start on.
- `LevelLegend.tsx`: swatches, break labels, unit, baseline — all from `measure`.
- `FeatureReadout.tsx`: explicit level branch — value + unit + band range + `measure.readout`
  extras; pooled → band range and "zoom in past …". Today the last `else` would silently word a
  level feature as `stable`.

**Files in scope:** `web/src/types/feature.ts`; `web/src/domains/{manifest,colors,layerSpec}.ts`
and their tests; `web/src/store/useTraceStore.ts`; `web/src/components/{LayerToggles,
FeatureReadout,LevelLegend}.tsx`; `web/src/map/useDomainLayers.ts` only if staging needs it;
this ticket.

**Do NOT touch:** `pipeline/**`; `schema/**`; the basemap style.

**Acceptance criteria:**
- [ ] Typecheck passes with every `Record<Kind|ChangeType, …>` table completed (the compiler is
      the audit).
- [ ] `colors.test.ts`: ramps monotone in lightness, disjoint from every other domain's palette,
      domain hues kept apart.
- [ ] `layerSpec.test.ts`: level roles exist only when the manifest lists `level`; step cost stays
      bounded with a level domain present; the scoped paint rule above.
- [ ] `layerSpec.tiles.test.ts` runs against level archives (`inYear` accepts `level`).
- [ ] Browser: over 20 slider steps with a level domain on, zero source reloads; step time no
      worse than `main`; legend and readout correct at z ≥ detailZoom and when pooled.

**Verify:** `cd web && npm run typecheck && npm test && npm run format:check`, then the
`web-worktree` preview on 5174 against `web` on 5173.
**Owner:** claude
