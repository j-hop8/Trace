# Trace · 描痕

Interactive map of Taiwan's long-term change. Extracts dated, comparable features from satellite
imagery so change becomes computable. See [docs/Trace_proposal.md](docs/Trace_proposal.md) for the
full design and build proposal.

## Commands

| | Pipeline (`pipeline/`) | Web (`web/`) |
|---|---|---|
| Test | `pytest` | — |
| Lint | `ruff check .` | — |
| Format | `ruff format .` | `prettier --write .` |
| Typecheck | — | `npm run typecheck` |
| Build | `python -m trace_pipeline.cli all` | `npm run build` |
| Dev | — | `npm run dev` |

Pipeline runs on Python 3.12 in `pipeline/.venv`. Activate with `source pipeline/.venv/bin/activate`.

## Architecture — three rules that matter

The spine is **sources → extraction → feature store → analysis → serving → frontend**. Three
invariants keep it modular; breaking any of them is what turns this back into a layer-toggler.

**1. The domain manifest is the spine.** The pipeline *emits* `data/domains.json`; the web app
*iterates* it. Nothing in `web/` may hardcode `water` or `forest` — no domain literals in
components, no per-domain branches. Adding a domain is a pipeline module plus a manifest entry.
The manifest also drives the attribution line, per-layer caveats, and per-layer slider ranges.

**2. Time is a feature attribute, not a layer.** Each feature carries `valid_from` / `valid_to`.
The time slider is a MapLibre filter expression (`["<=", ["get", "valid_from"], year]`) over one
tileset per domain — never 41 stacked yearly layers. This is why there is no tile server.

**3. Every feature carries the full B4 schema.** `domain`, `subtype`, `valid_from`, `valid_to`,
`change_type`, `metric`, `source`, `method`, `confidence` — defined once in
[schema/feature.schema.json](schema/feature.schema.json). PostGIS is deferred to Phase 2, but the
schema is not, so that migration stays a data load rather than a redesign.

### Colour is a pure function

`web/src/domains/colors.ts` exports one function, `colorFor(domain, changeType)`. Extent uses the
domain hue; loss uses the universal red/amber. **No colour literals anywhere else in `web/`.**
The basemap must show no blue and no green — those hues are reserved to mean "water domain" and
"forest domain", so the Protomaps style suppresses its own water and vegetation fills.

### Honesty rules (these are product requirements, not politeness)

- Hansen loss is **tree-cover loss**, never "deforestation" — it includes plantation harvest,
  fire, and typhoon damage.
- Every layer shows its source attribution and its resolution caveat. 30 m means ponds under
  ~0.5 ha may be missed; say so rather than smoothing it over.
- Loss is never signalled by colour alone — pair with pattern or icon.

## Dual-Agent Workflow

This repo follows the global Claude+Codex standard (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md).

- Tickets: `.agents/tickets/T-xxx-<slug>.md` (template: `_template.md`). Done → `.agents/tickets/done/`.
- Branches: `claude/T-xxx-slug` | `codex/T-xxx-slug`. Commits: `claude:` / `codex:` prefix.
- All merges to main via squash PR. Codex worktrees live in `.worktrees/` (gitignored).
- Test: `cd pipeline && pytest` · Lint: `ruff check .` · Format: `ruff format .` / `prettier --write .`

## Gotchas

- **Earth Engine asset versions drift.** Asset IDs live in `pipeline/trace_pipeline/config.py`
  and nowhere else. GSW v1.5 is a *project-hosted* asset, not a catalog one — access is not
  guaranteed, so the water pipeline falls back to v1.4 (1984–2021) and records the reduced range
  in the manifest.
- **Water and forest timelines differ** (1984– vs 2000–). The slider range is per-layer, driven
  by the manifest. Never force a shared range.
- `data/` is generated and gitignored. Never commit `.pmtiles` or `.tif`.
