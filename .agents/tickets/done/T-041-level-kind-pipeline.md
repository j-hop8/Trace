# T-041: a third kind of state, `level` — pipeline and web spine
**Goal:** Let the pipeline emit, tile, verify and publish *measured values* (temperature,
population density, later rainfall, NDVI, admin-unit statistics), and let the web draw them, on
the existing spine. After this, each such layer is a domain module plus a manifest entry and
nothing else.

**Why:** Every feature was a category: `cover` (a state with its own validity) or a `change`
verdict (`stable`/`gain`/`loss`, never closes). A measured quantity is neither. It is a value
held for a period. `change_type` was a closed enum, extraction assumed Earth Engine, and nothing
published a unit or class breaks for the web to draw a ramp and legend from.

**One ticket, not two.** This was planned as T-041 (pipeline) plus T-042 (web). They cannot
merge apart: `test_ts_and_json_schema_agree` pins `web/src/types/feature.ts` to the schema, the
new TypeScript union fails `npm run typecheck` until every `Record<Kind, …>` is completed, and a
v4 manifest is refused by a v3 web build. T-036 shipped its contract change the same way.

**Design (decided with the user):**
- `change_type: "level"`, `x-kind: "level"`. A level feature is one polygon for **one year**,
  `[Y, Y + 1)`, never open.
- A top-level integer **`band`**, required on level and refused elsewhere: the class of the
  domain's fixed breaks. Top-level because island pooling strips only `metric`.
- The value lives in `metric` under the domain's key, beside `area_ha`.
- **Breaks are fixed per domain and identical for every year.**
- Cohorts: level shares the interval tree, with tile layers `level:S-E`.
- Manifest v4: optional `measure: {key, unit, label, breaks, baseline?, readout}`.
- `Domain.needs_earth_engine` (default `True`) gates Earth Engine in `extract`. Local sources
  live in `data/raw/<id>/` (`extract.RAW_DIR`).
- `levels.py`: `band_of`, `grid_cells`, `dissolve_grid`, `level_feature`.
- Web: `rampFor(hue, bands)` is a lightness ramp of the hue. The band colour is a build-time
  `step` on `band`, the one data-driven paint allowed, and it is never written again. Level is
  first in `KIND_ORDER`. Level domains are backdrops: off at load, one at a time, and slid
  beneath the other domains when switched on. The toggle's legend is the ramp. The readout has a
  level sentence (value, unit, band, baseline; pooled gives the band only).
- Hues: temperature `#dc2626`, population `#eab308`. Any two domain hues sit at least 30° apart.

**Files in scope:** `schema/feature.schema.json`; `pipeline/trace_pipeline/{schema,cohorts,
manifest,config,extract,cli,levels}.py`; `pipeline/trace_pipeline/domains/{base,__init__}.py`;
`pipeline/tests/**`; `web/src/types/feature.ts`;
`web/src/domains/{manifest,colors,layerSpec}.ts` and their tests; `web/src/store/useTraceStore.ts`
and its test; `web/src/components/{LayerToggles,FeatureReadout}.tsx`;
`web/src/map/useDomainLayers.ts` (`beforeIdFor` only); `docs/adding-a-domain.md` (new);
`CLAUDE.md`; this ticket and T-042..T-045.

**Do NOT touch:** `domains/water.py` and `domains/forest.py` behaviour; any built archive under
`data/`; the basemap style.

**Acceptance criteria:**
- [x] The schema accepts a level with `band` and a closed one-year interval. It rejects a level
      without `band`, one with `valid_to` null, and one spanning more than a year, and rejects
      `band` on any other kind.
- [x] `cohorts` places a level in the `level:` leaf for its year, and `MODEL_OF_KIND` names a
      model for every kind. Water and forest layers are unchanged.
- [x] A test-only synthetic grid domain goes extract → tiles → verify → manifest with no Earth
      Engine client (`test_levels.py`, skipped where tippecanoe is absent).
- [x] Island-area floor measured, not assumed. On the synthetic level archives z7 and z10 hold
      100.0–100.2% of level area, so the 0.9 floor carries over.
- [x] The web typechecks with every `Record<Kind|ChangeType, …>` completed.
- [x] `colors.test.ts`: ramps are monotone in lightness, keep the domain's hue, and share no
      colour with any other domain.
- [x] `layerSpec.test.ts`: level roles appear only with a measure. MapLibre's own evaluator
      colours each band as `rampFor` says. The paint exception is scoped to level colour on
      `band`. A step costs two writes per level role.
- [x] Browser (synthetic 5 km field, 1960–2023): off at load; the ramp legend and slider range
      are right; water and forest draw over the backdrop when it is switched on after load;
      **zero worker messages over 10 year steps** (zooming, as a control, sent 12 tile loads);
      the readout reads correctly pooled and at detail.
- [x] `docs/adding-a-domain.md` states the checklist and the hue budget.

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check .` and
`cd web && npm run format:check && npm run typecheck && npm test && npm run check:palette`
**Owner:** claude
