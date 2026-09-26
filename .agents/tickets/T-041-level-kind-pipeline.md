# T-041: a third kind of state, `level` — pipeline spine
**Goal:** Let the pipeline emit, tile, verify and publish *measured values* (temperature,
population density, later rainfall, NDVI, admin-unit statistics) on the existing spine, so each
such layer is afterwards a domain module plus a manifest entry and nothing else.

**Why:** Every feature today is a category — `cover` (a state with its own validity) or a
`change` verdict (`stable`/`gain`/`loss`, never closes). A measured quantity is neither: it is a
value held for a period. `change_type` is a closed enum, extraction assumes Earth Engine
(`cli.py` and `extract.run` initialise it unconditionally), and nothing publishes a unit or class
breaks for the web to draw a ramp and legend from.

**Design (decided with the user):**
- `change_type: "level"`, `x-kind: "level"`. A level feature is one polygon for **one year**:
  `valid_from = Y`, `valid_to = Y + 1`, never null — a measurement describes a period, it does
  not stay open.
- A top-level integer property **`band`**, required iff `change_type == "level"`: the index of the
  domain's fixed class the value falls in. Top-level, not in `metric`, because island pooling
  strips only `metric` (`tiles.py`), so the class survives at island view and the web can colour
  by it at every zoom.
- The value lives in `metric` under the domain's own key (`temp_anomaly_c`, `density_per_km2`…),
  alongside `area_ha` so the island-area check has something to measure against.
- **Breaks are fixed per domain and identical for every year** — a colour must mean the same in
  1965 as in 2023. Never per-year quantiles.
- Cohorts: level uses the cover interval tree, tile layers named `level:S-E`. One-year features
  sit in leaf nodes.
- Manifest: optional `measure: {key, unit, label{en,zh}, breaks[], baseline?, readout[]}` on the
  domain entry; `MANIFEST_VERSION` 3 → 4.
- `Domain.needs_earth_engine` (default `True`). `extract` initialises Earth Engine only for
  domains that need it; a local-source domain reads from `data/raw/<domain>/` (paths in
  `config.py`, like asset IDs).
- `levels.py`: shared helpers so no measured domain re-implements banding or grid dissolving.

**Files in scope:** `schema/feature.schema.json`; `pipeline/trace_pipeline/{schema,cohorts,tiles,
manifest,config,extract,cli,levels}.py`; `pipeline/trace_pipeline/domains/base.py`;
`pipeline/tests/**`; `web/src/types/feature.ts` (type mirror only — kept in step by
`test_ts_and_json_schema_agree`); `docs/adding-a-domain.md` (new); `CLAUDE.md` ("Two kinds of
state"); this ticket.

**Do NOT touch:** `web/src/**` beyond the type mirror (T-042); `domains/water.py`,
`domains/forest.py` behaviour; any built archive under `data/`.

**Acceptance criteria:**
- [ ] Schema accepts a level feature with `band` and a one-year closed interval; rejects level
      without `band`, with `valid_to` null, or spanning ≠ 1 year; rejects `band` on non-level.
- [ ] `cohorts` places a level feature in the `level:` leaf node for its year, and `is_layer` /
      `all_layers` know `level:` nodes; water and forest layers unchanged.
- [ ] A test-only synthetic grid domain goes extract → tiles → verify → manifest end to end with
      no Earth Engine client; the manifest carries `measure` and `level:*` source layers.
- [ ] The island-area floor is measured on the synthetic level archive, not assumed.
- [ ] Water and forest builds, manifest entries and tests are unchanged apart from the version.
- [ ] `docs/adding-a-domain.md` states the checklist, including the hue budget (blue and green
      are taken, so rainfall and NDVI need a decision).

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check .`
**Owner:** claude
