# T-009: Forest extent layer + per-domain view toggle

**Goal:** Let a domain be read either way — what changed, or what is left — with one toggle per
layer. Forest gains a green baseline extent, and the cover view shows that baseline with every
mapped loss up to the selected year removed.

**Files in scope:**
- `pipeline/trace_pipeline/domains/forest.py`, `domains/base.py`, `cli.py`
- `schema/feature.schema.json`
- `web/src/domains/{colors,layerSpec,manifest}.ts`, `web/src/types/feature.ts`
- `web/src/map/useDomainLayers.ts`, `web/src/store/useTraceStore.ts`
- `web/src/components/{LayerToggles,FeatureReadout}.tsx`

**Do NOT touch:** the loss extraction path or its minimum mapping unit; the `LOSS` constant.

## Decisions, as resolved

**1. `extent` is its own change type.** The schema promised "extent uses the domain hue" while
`styleFor` mapped `stable` → grey and only `gain` → the hue — a three-way disagreement. Resolved by
adding `extent` to the enum and mapping it to the domain hue, rather than overloading `stable`,
which means "unchanged between two epochs" and is not the same claim as "present at the baseline".

**2. Volume: vectors at full 30 m resolution, chunked 4×4.** Measured rather than assumed:
`treecover2000 ≥ 30%` over Taiwan is 2,340,266 ha and vectorises to 113,097 polygons / ~2.5M
vertices in 16 s — the same order as the 91,087 loss patches, so no coarsening was needed. After
the shared `MIN_PATCH_PIXELS` sieve it lands at 67,031 blocks. One request cannot carry it (HTTP
400 at whole-AOI, 2×2 and 3×3); a 4×4 grid's worst cell is 11,889 features / 22 MB / 13 s.

**3. Draw order: extent, then cleared, then the change layers.** MapLibre fills cannot subtract, so
the cover view paints the lost patches over the baseline in the basemap's ground colour and the
holes are what you see. Both views' layers are built once and switched with `visibility`, so the
toggle never refetches a tile.

**4. The slider drives both views.** Extent carries `valid_from: 2000`, so it passes the existing
time filter unchanged and the *cleared* layer is what animates — the green shrinks as the year
advances. Nothing about the slider needed special-casing.

**Acceptance criteria:**
- [x] Extent features validate against the B4 schema, carrying `area_ha`.
- [x] Extent renders in the domain hue; loss stays red with its hatch.
- [x] The caveat states that cover is derived — regrowth not added back, unmapped loss not removed.
- [x] No domain literal in `web/`: the toggle is driven by the manifest's `changeTypes`.
- [x] Tiling verifies feature counts in and out.

**Verify:** `cd pipeline && pytest && ruff check .` · `npm run typecheck --prefix web`

**Owner:** claude

## Follow-ups (not in this ticket)

- **An island-wide forest area per year.** "That year's forest area" is currently shown as a shape,
  not a number. The honest number cannot be summed from extent features — the 4×4 grid splits real
  blocks, so their areas are grid artefacts (see `EXTENT_GRID`). It has to be measured in the
  pipeline as baseline minus cumulative mapped loss and carried in the manifest as a per-year
  series.
- **Water has no extent pass yet**, so it shows no toggle. `supportsExtentView` handles that
  correctly, but the asymmetry is worth closing once T-004 lands.
