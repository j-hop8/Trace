# T-002: Python-side schema validation and manifest emitter
**Goal:** Give the pipeline a validated feature dataclass and a `domains.json` writer, so no
extraction module can emit a feature that the web app cannot read.

**Files in scope:**
- `pipeline/trace_pipeline/schema.py` (new)
- `pipeline/trace_pipeline/manifest.py` (new)
- `pipeline/tests/test_schema.py` (new)
- `pipeline/tests/fixtures/*.geojson` (new)

**Do NOT touch:** `schema/feature.schema.json` (it is the contract — if it looks wrong, raise it,
don't edit it), `web/`, any `domains/` extraction module.

**Context:** `schema/feature.schema.json` is authoritative and already written.
`web/src/types/feature.ts` is its hand-maintained TypeScript mirror.

**Acceptance criteria:**
- [ ] `schema.py` exposes a `TraceFeature` dataclass matching the JSON Schema's `properties`, and
      `to_geojson_feature(geometry) -> dict`.
- [ ] `validate(feature_collection)` raises with a readable message naming the offending feature
      index and field. A bare `jsonschema.ValidationError` traceback is not acceptable — the
      person reading it is debugging a 40k-feature export.
- [ ] Ordering rule the JSON Schema cannot express is enforced in code: `valid_to` is either
      `None` or `>= valid_from`.
- [ ] `metric` must be non-empty — a feature with no number cannot answer "how much".
- [ ] `manifest.py` writes `data/domains.json` with `version` from `config.MANIFEST_VERSION`,
      assembling entries via each domain's `manifest_entry()`.
- [ ] A test asserts the TS mirror has not drifted: parse the required-field list out of
      `schema/feature.schema.json` and assert each name appears in `web/src/types/feature.ts`.
- [ ] Fixtures cover one valid feature and at least three distinct invalid ones.

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check .`
**Owner:** codex
