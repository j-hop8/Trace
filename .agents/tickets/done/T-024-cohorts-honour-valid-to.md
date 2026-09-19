# T-024: cover switches off at `valid_to` — canonical interval cohorts
**Goal:** Draw a cover feature for exactly the years in `[valid_from, valid_to)`, while the year
stays a constant paint change and the writes a step costs are bounded independently of the year.

**Context (rewritten after T-028/T-029 — the original is in git history):** `cohortFilter` keys on
`valid_from` alone and a cohort, once on, never switches off. That was a stated precondition —
"features are open-ended" — and it held for forest until T-029, which now emits 91,087 closed
cover pieces `[2000, L)`. Water's `lost *` / `ephemeral *` classes have carried a `valid_to` all
along (42,417 features drawn past their end), and T-031 will re-date those to open-ended change
features. So after the taxonomy lands, **only `cover` carries `valid_to`**, and this ticket is
scoped to the cover kind — `KIND_OF[changeType] === 'cover'` — not to any domain.

The original design note (b) — "only the ephemeral classes need pairs" — is false under T-031
and is dropped.

**The constraint** is the one the design exists for: the year must stay a *constant paint
change*. A live `valid_to >= year` filter re-tessellates every tile per step, which is the
regression T-011 removed. And a data-driven `fill-opacity` expression is the same regression in
different clothes: MapLibre 5.24 `style_layer.ts:283-311` returns `isDataDriven || wasDataDriven`
from `setPaintProperty`, and `style.ts:1363-1367` then calls `_updateLayer` → `_updatedSources[src]
= 'reload'`. Verified in `node_modules`, not assumed.

**Mechanism — canonical interval cohorts.** A binary tree over the half-open range
`[temporal.start, temporal.end + 1)`; every node is one layer whose filter selects the features
whose validity *covers* that node but *not* its parent — the canonical (maximal) decomposition of
`[valid_from, valid_to)` into tree nodes. Properties, all of which the tests pin:

- Each year in a feature's validity is covered by **exactly one** of its canonical nodes, so
  nothing is drawn twice and nothing is missed.
- A node is shown at year Y iff `node.start <= Y < node.end`. The shown set for Y is the
  root-to-leaf path for Y, so stepping Y → Y+1 flips at most `2·(depth − 1)` nodes per cover
  role — **≤ 10 for forest (N=25), ≤ 12 for water (N=38–41)** — and the count is symmetric under
  reversal, which is "no accumulation" in one assertion.
- `2N − 1` layers per cover role (49 forest, 75–81 water); bounds hold for any data with no
  measurement and no manifest field. The common cases (`[2000, null)`, `[1984, null)`) land in
  the root alone.
- Absent `valid_to` (tippecanoe drops nulls) reads as open via
  `['coalesce', ['get', 'valid_to'], OPEN_ENDED_YEAR]`. Verified against
  `@maplibre/maplibre-gl-style-spec`'s `featureFilter` before writing a line.

Rejected: paired `(from, to)` cohorts — quadratic, data-dependent family count (up to 861 for
water), and every family's `populate` walks every feature in the tile, a first-load regression
T-013 exists to prevent. One layer per year with `from ≤ Y < to` — duplicates forest's canopy 26×
in GPU memory.

**`cleared-*` goes.** The hole-punching roles were the web deriving cover from loss. With cover
honouring `valid_to` the holes are in the data (T-029), and the tiles test below asserts cover
selection == `from ≤ Y < to`, which the paint trick cannot satisfy. `CLEARED` in `colors.ts` goes
with them — the one colour literal that was not a function of a hue.

**Files in scope:** `web/src/domains/layerSpec.ts`, `web/src/domains/layerSpec.test.ts`,
`web/src/domains/layerSpec.tiles.test.ts`, `web/src/domains/colors.ts` (delete `CLEARED` and its
comment only), `web/src/map/useDomainLayers.ts` (comments only — return shapes are unchanged),
`CLAUDE.md` (the cohort paragraph and the "one colour that is not a hue" sentence if any), this
ticket.

**Do NOT touch:** `styleFor` and the ramp values; the toggle UI (`LayerToggles.tsx`,
`useTraceStore.ts`); `FeatureReadout.tsx`; `schema/**`; `pipeline/**`; `manifest.ts`.

**The change, `layerSpec.ts`:**
- Keep `cohortYears` / `cohortFilter` for change roles, unchanged.
- Add `IntervalNode { start; end; parent }`, `intervalNodes(entry)` (pre-order, `2N − 1` nodes,
  cached per entry like `rolesFor`), `intervalFilter(node, test)`:
  ```
  endOf  = ['coalesce', ['get', 'valid_to'], OPEN_ENDED_YEAR]
  covers = n => ['all', ['<=', ['get','valid_from'], n.start], ['>=', endOf, n.end]]
  filter = n.parent ? ['all', covers(n), ['!', covers(n.parent)], test] : ['all', covers(n), test]
  ```
- `Role` gains `cohorts: 'from' | 'interval'`, set from `KIND_OF[role.changeType]` in
  `buildRoles` — the taxonomy decides the model, not the domain. Cover roles: `cover-fill`
  (0.85) and `cover-outline`, both interval. Delete `cleared-fill` / `cleared-outline`.
- `layerIdsFor`, `layerIdsForSelection`, `layerIdsForYear`, `opacityUpdatesFor`, `layersFor`
  iterate `role.cohorts === 'interval' ? intervalNodes(entry) : cohortYears(entry)`. Interval
  layer id: `trace-${domain}-${key}-${start}-${end}`. Shown iff `start <= year < end`.
- Export `maxWritesPerStep(entry)` = Σ roles (`'from'` → 1; `'interval'` → `2·(depth − 1)`).
- Rewrite the `cohortFilter` precondition doc and the `buildRoles` draw-order doc.

**Tests, `layerSpec.test.ts`:**
- "cost of a step" → (i) `max(perStep) <= maxWritesPerStep(entry)`; (ii) writes for `Y→Y+1`
  equal writes for `Y+1→Y` for every Y; (iii) mean writes per step over a full sweep
  `<= changeRoles + 4·coverRoles`.
- New: every year is covered by exactly one shown node per interval role; a synthetic feature
  `[f, t)` is selected by exactly the nodes whose union is `[f, t) ∩ range` — evaluated with
  `featureFilter` over synthetic features, for open, closed, pre-range and post-range cases.
- Update `ROLES`, `roleOf`, `YEARS`-based counts; delete the `cleared` assertions
  (`:143, :176-185, :299-308`); fixtures gain `changeTypes: ['cover', 'gain', 'loss', 'stable']`
  for water once T-030 lands — until then the water fixture stays change-only and the forest
  fixture carries cover.

**Tests, `layerSpec.tiles.test.ts`:**
- Iterate **every** entry in `data/domains.json`, not `domains[0]`; skip per domain when its
  archive is absent.
- Reference per role: `type && from <= Y && (to absent || Y < to)` for interval roles;
  `type && from <= Y` for from-roles.
- Assert no feature is selected by two shown layers of one role in one year.
- Replace "never sees a feature that expires" with "no change-kind feature carries `valid_to`"
  — the open-ended precondition, now scoped to the kind that still relies on it. **This will be
  red for water until T-031 lands**; mark it `it.skipIf` on that condition with the ticket cited,
  so the suite says why rather than failing silently.

**Acceptance criteria:**
- [x] A feature with non-null `valid_to` is not drawn for `valid_to` or any later year, and is
      drawn for every year from `max(valid_from, start)` to `valid_to − 1`.
- [x] No feature is drawn twice in one year by one role.
- [x] Per-step paint writes ≤ `maxWritesPerStep(entry)` and symmetric under reversal; no
      `setPaintProperty` value is an expression (`opacityChannel` still throws on one).
- [x] `layerSpec.tiles.test.ts` covers every manifest domain and passes against the T-029 tiles.
- [x] `grep -rn CLEARED web/src` is empty; no `cleared-*` role exists.
- [x] `CLAUDE.md` describes what the code does: change roles are `valid_from` cohorts; cover roles
      are canonical interval cohorts; both fixed at build time; per-step writes bounded by
      `2·(depth − 1)` per cover role.

**Verify:** `cd web && npm run typecheck && npm test && npm run format:check` — with the T-029
forest tiles present locally so the tiles test runs.
**Owner:** claude
