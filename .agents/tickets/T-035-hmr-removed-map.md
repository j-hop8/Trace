# T-035: Fast Refresh runs the layer hook against a map the cleanup just removed
**Goal:** Stop a dev-server edit of `MapCanvas.tsx` from crashing the app with
`TypeError: Cannot read properties of undefined (reading 'getImage')`, which unmounts the React
root until the page is reloaded by hand.

**Cause:** Vite's React Fast Refresh re-runs every effect of the edited component in one pass:
the map effect's cleanup calls `map.remove()` (which does `setStyle(null)`) and schedules
`setReadyMap(null)`, but the state update only lands on the *next* render, so `useDomainLayers`'
effects re-run in the same pass with `readyMap` still pointing at the removed map.
`map.hasImage(HATCH_IMAGE)` in the hatch effect then reads `this.style.getImage` off an undefined
style. Dev-only: outside HMR a map is removed only on unmount, when no effect runs again.

**Files in scope:** `web/src/map/useDomainLayers.ts` (a guard at the top of each effect that
touches the map — `if (!map || map._removed)`, or the public `map.getStyle()` returning undefined
— with a comment saying it is for Fast Refresh), or `web/src/map/MapCanvas.tsx` if a cleaner
shape is to null the ref before removal.

**Do NOT touch:** the staging, commit loop or loading report in `useDomainLayers.ts` beyond the
guard; `layerSpec.ts`; anything in `pipeline/`.

**Acceptance criteria:**
- [ ] Editing and saving `MapCanvas.tsx` with the dev server running and the map loaded logs no
      uncaught error and the map rebuilds with its domain layers.
- [ ] `cd web && npm run typecheck && npm test && npm run format:check` passes.

**Verify:** `cd web && npm run typecheck && npm test && npm run format:check`, then the manual HMR
check above.
**Owner:** codex
