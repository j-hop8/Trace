# T-000: Repo scaffold, structural contracts, and dual-agent workflow
**Goal:** Turn a directory holding two documents into a working two-stack repo whose module
boundaries make Phase 0's remaining tickets independent of each other.

*(Written retroactively — this ticket is the spec the delivered scaffold is measured against.)*

**Files in scope:** repo root, `.agents/`, `.github/`, `.claude/`, `docs/`, `schema/`,
`pipeline/**`, `web/**`

**Do NOT touch:** the content of `docs/Trace_proposal.md` and `docs/trace_architecture.svg` —
they are the source design documents and move unmodified.

## Context

Phase 0 of the approved plan: prove the extraction → tile → render loop with two domains (Water,
Forest). This ticket is the foundation it runs on. Decisions already taken with the user: React +
Vite + Tailwind, public repo under `j-hop8`, Earth Engine account already registered.

## The three invariants this must establish

1. **The domain manifest is the spine.** The pipeline emits `data/domains.json`; the web app
   iterates it. No domain literal in `web/`. The manifest also drives the attribution line, the
   per-layer caveats, and the per-layer slider ranges.
2. **Time is a feature attribute, not a layer.** Features carry `valid_from` / `valid_to` so the
   slider is a filter expression over one tileset per domain — which is what removes the tile
   server from Phase 0.
3. **Every feature carries the full B4 schema**, defined once. PostGIS is deferred to Phase 2;
   the schema is not.

## Acceptance criteria

- [ ] `git init`, public repo under `j-hop8`, scaffold lands via PR — never committed to main.
- [ ] `CLAUDE.md` records commands, the three invariants, and the honesty rules; `AGENTS.md` is a
      symlink to it.
- [ ] `.agents/tickets/` with `_template.md`, `done/`, and a ticket per remaining Phase 0 task.
- [ ] `schema/feature.schema.json` defines the B4 spine; `web/src/types/feature.ts` mirrors it.
- [ ] `pipeline/trace_pipeline/domains/base.py` defines a `Domain` ABC + registry, so
      interchangeability is enforced by a type rather than a convention.
- [ ] `config.py` holds every Earth Engine asset id and threshold — verified against the live
      catalog, not copied from the proposal on trust.
- [ ] `web/src/domains/colors.ts` is the only file in `web/` with a data colour literal, and
      returns the accessible pattern alongside the colour (A5).
- [ ] CI runs both stacks and passes: web typecheck + build, pipeline ruff + pytest.
- [ ] Tests assert structural invariants, not placeholders.
- [ ] `data/`, `node_modules/`, `.venv/`, `*.pmtiles` are gitignored and untracked.

**Verify:**
`cd pipeline && ruff check . && ruff format --check . && pytest` and
`cd web && npm run format:check && npm run typecheck && npm run build`

**Owner:** claude
