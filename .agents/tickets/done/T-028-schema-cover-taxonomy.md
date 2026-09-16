# T-028: `change_type` becomes two kinds — `cover`, and `change` → stable / gain / loss
**Goal:** Make the cover/change hierarchy a documented, machine-readable part of the feature
schema, mirrored once in Python and once in TypeScript, with one test that fails if any of the
three drift — and rename `extent` to `cover` everywhere, with no behaviour change.

**Context:** Today `change_type` is a flat enum `extent | gain | loss | stable`. `extent` was added
by T-009 as "not a change but the baseline state" — the schema's own description says it is "the
odd one out". That is the distinction this ticket makes explicit:

```
cover   — the state that exists in year Y. Carries its own validity [valid_from, valid_to);
          valid_to is the FIRST year the state no longer holds (half-open), null = open.
change  — a verdict accumulated since the record's first year. valid_to is always null;
          once drawn, drawn for every later year.
  ├ stable — present throughout the record
  ├ gain   — arrived at valid_from
  └ loss   — went (or was reduced) at valid_from
```

Two rules come with it. **This ticket documents them in the schema; it does not enforce them
in code.** Enforcement is T-031's job, because today's water extractor violates both (42,417
closed `loss` features; 376 with `valid_to == valid_from`) and `TraceFeature.__post_init__`
validates at construction — enforcing here would make `cli all` raise for water until T-031
re-dates it, and `derive_valid_to` is out of this ticket's scope.

1. **`valid_to` is half-open.** `schema.py:197` currently allows `valid_to == valid_from`, and
   `test_schema.py:198-200` pins a single-year pond as `1995→1995`. Under half-open that pond is
   `[1995, 1996)`. Half-open is what lets a forest cover piece `[2000, L)` and the forest loss
   `[L, null)` hand off with no overlap — T-029/T-030 emit exactly that. **Leave the `<` check
   and the same-year test as they are**; give the test a docstring saying equality is tolerated
   until T-031, which is the last emitter of it.
2. **A change-kind feature cannot carry `valid_to`.** Change is cumulative, so it never closes.
   Will be enforced in `_check_properties` by T-031 (not JSON Schema — the same split
   `schema.py:185-192` explains for the ordering rule). Here: state it in the `$comment`, and
   ship `kind_of()` so T-031 has the lookup.

Nothing in this ticket changes the data or the extraction. It is the foundation the pipeline
tickets (T-029 forest cover, T-030 water cover, T-031 water re-dating) and the web tickets
(T-024 interval cohorts, T-032 two-level toggles) build on. Keep it mechanical.

**Files in scope:**
- `schema/feature.schema.json`
- `pipeline/trace_pipeline/schema.py`
- `pipeline/trace_pipeline/domains/forest.py` — the two `"extent"` strings only (`:110`, `:123`)
- `pipeline/trace_pipeline/domains/water.py` — the `# type: ignore[arg-type]` at `:395` only
- `pipeline/tests/test_schema.py`, `pipeline/tests/test_water.py` (`:55` only), `pipeline/tests/test_domains.py`
- `web/src/types/feature.ts`
- `web/src/domains/colors.ts`, `web/src/domains/layerSpec.ts` — rename only
- `web/src/components/LayerToggles.tsx`, `web/src/components/FeatureReadout.tsx` — rename only
- `web/src/domains/colors.test.ts`, `web/src/domains/layerSpec.test.ts`, `web/src/store/useTraceStore.test.ts` — fixture strings only
- `CLAUDE.md`

**Do NOT touch:** any extraction logic in `forest.py` / `water.py` beyond the lines named above;
`data/**`; the cohort model in `layerSpec.ts` (`cohortYears`, `cohortFilter`, `layerIdsFor*`,
`opacityUpdatesFor`, `layersFor`); the `cleared-*` roles — they stay until T-024; the toggle
layout in `LayerToggles.tsx`; the `styleFor` ramp values; any caveat text beyond the word "extent";
`web/node_modules` and `pipeline/.venv` (symlinks into the parent checkout).

**The change, file by file:**

`schema/feature.schema.json`
- `change_type.enum` → `["cover", "gain", "loss", "stable"]`.
- Rewrite `change_type.description`: it still says "loss uses the cross-domain red/amber", which
  T-023 removed. State the two kinds and that colour is `styleFor(hue, change_type)`.
- Add a sibling keyword beside `enum`, which the validator ignores (draft 2020-12 tolerates
  unknown keywords; `_validator()`'s `check_schema` at `schema.py:63-68` will not object):
  ```json
  "x-kind": { "cover": "cover", "gain": "change", "loss": "change", "stable": "change" }
  ```
  with a `$comment` stating: cover carries its own validity; change accumulates and never
  closes; `valid_to` is half-open.
- `valid_from.description`: drop the `["<=", ["get", "valid_from"], year]` sentence — the year
  is opacity now, not a filter (`CLAUDE.md`, invariant 2).
- `valid_to.description` → "The first year the state no longer holds — half-open. null means
  open-ended: the state is current as of the source's last observed year." Add a `$comment` that
  change-kind features must carry `null`, enforced in code.

`pipeline/trace_pipeline/schema.py`
- `ChangeType = Literal["cover", "gain", "loss", "stable"]` (it is stale today — missing
  `extent`, which is why `water.py:395` carries a `# type: ignore`).
- Add `Kind = Literal["cover", "change"]` and `kind_of() -> dict[str, str]`, read from
  `load_schema()["$defs"]["properties"]["properties"]["change_type"]["x-kind"]` — derived, the
  way `required_property_names()` (`:83-88`) is, so it cannot drift.
- `_check_properties` (`:194-204`): **unchanged.** Both new rules are documented in the schema
  and enforced by T-031 (see Context). Do not add them here — they reject today's water output.

`pipeline/trace_pipeline/domains/forest.py` — `"extent"` → `"cover"` at `:110` and `:123`.
Here rather than in T-029 so `forest.extract` stays runnable against the new enum.

`pipeline/trace_pipeline/domains/water.py` — delete the `# type: ignore[arg-type]` and its
trailing comment at `:395`; the Literal is correct now.

`pipeline/tests/test_schema.py`
- `test_same_year_start_and_end_is_allowed` (`:198-200`): keep the assertion; add a docstring
  stating that `valid_to` is documented half-open, that equality is an empty interval under that
  reading, and that it is tolerated until T-031 re-dates water, which is the last emitter of it.
- New: `kind_of()` returns exactly `{"cover": "cover", "gain": "change", "loss": "change",
  "stable": "change"}` (read from the schema, so this is the x-kind ↔ enum agreement check).
- `test_change_type_values_match_the_typescript_union` (`:265-271`) → a three-way check:
  schema `enum` == `x-kind` keys == the values parsed from the TS union in
  `web/src/types/feature.ts` == the keys parsed from `KIND_OF` in the same file (regex
  `(\w+):\s*'(cover|change)'`), and each key's kind in `x-kind` equals its kind in `KIND_OF`.

`pipeline/tests/test_water.py:55` — replace the hardcoded `allowed = {...}` with the enum read
from `schema.load_schema()`.

`pipeline/tests/test_domains.py` — new test, parametrized over `domains.all_ids()` (pattern at
`:49`): every registered domain's declared `change_types` is a subset of the schema enum. This is
the gap that let `schema.py`'s Literal go stale.

`web/src/types/feature.ts`
- `:15` → `export type ChangeType = 'cover' | 'gain' | 'loss' | 'stable';`
- `:25` → `CHANGE_TYPE_ORDER = ['cover', 'stable', 'gain', 'loss']`; update its doc comment
  ("the baseline first" → "cover first").
- Add, beside them:
  ```ts
  /** The two kinds of state. Cover carries its own validity; change accumulates and never closes. */
  export type Kind = 'cover' | 'change';
  export const KIND_OF: Record<ChangeType, Kind> = { cover: 'cover', stable: 'change', gain: 'change', loss: 'change' };
  ```
  `Record<ChangeType, …>` is exhaustive by type; the Python test makes it agree with the schema.

Mechanical rename `extent` → `cover` — same assertions must pass afterwards:
- `web/src/domains/colors.ts:102` case label; its doc comment ("Extent is the hue itself") → cover.
- `web/src/domains/layerSpec.ts`: `:231` `present.has('cover')`; `:235` key `'cover-fill'`;
  `:236-237,240` `'cover'`; `:243` `outlineRole('cover-outline', 'cover', isType('cover'))`;
  `:252,262` the `changeType: 'cover'` on the two `cleared-*` roles (the roles themselves stay);
  `:276` `if (changeType === 'cover') continue;`; comments at `:167,218`.
- `web/src/components/LayerToggles.tsx:17` key `cover:`; the comment at `:10` ("whatever the
  domain's extent is" → cover).
- `web/src/components/FeatureReadout.tsx:31,49`.
- Test fixtures: `colors.test.ts:76-77`; `layerSpec.test.ts:35,180,259,302,319,325` (`'-cover-'`,
  `'cover-'`, `trace-…-cover-fill-2013`); `useTraceStore.test.ts:98,119,125,131,146,156,161,167,192`.

`CLAUDE.md`
- Under invariant 3 ("Every feature carries the full B4 schema"), add a short paragraph "Two
  kinds of state" — the block at the top of this ticket, plus the half-open rule.
- `:69` "Extent is the hue itself" → "Cover is the hue itself".

**Known consequence, state it in the PR:** until T-029 re-runs the pipeline, the local
`data/domains.json` still advertises `extent`, so `selectableTypes` (`manifest.ts:153-156`)
filters it out and forest shows no cover toggle locally. `data/` is gitignored; CI never sees it.

**Acceptance criteria:**
- [ ] Schema `enum`, `x-kind` keys, `schema.ChangeType`, the TS `ChangeType` union and `KIND_OF`
      all name exactly `{cover, gain, loss, stable}`, and one test checks all five against each other.
- [ ] The schema's `valid_to` description and `$comment` state the half-open rule and the
      change-never-closes rule; `_check_properties` is unchanged; `kind_of()` exists and is tested.
      (Enforcement of both rules is a T-031 acceptance criterion, not this one.)
- [ ] `grep -rn "'extent'\|\"extent\"" web/src pipeline schema CLAUDE.md` returns nothing.
- [ ] Every registered domain's `change_types` is a subset of the schema enum (new test).
- [ ] `CLAUDE.md` carries the two-kinds paragraph and the half-open `valid_to` rule.
- [ ] No `web/` test assertion was weakened — only the string `extent` changed in fixtures.
- [ ] Ticket file moved to `.agents/tickets/done/`.

**Verify** (must be green — 196 pytest, 52 vitest with 3 tiles-test skips when `data/` is absent): `cd pipeline && pytest && ruff check . && ruff format --check . && cd ../web && npm run typecheck && npm test && npm run format:check`
**Owner:** codex
