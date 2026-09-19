# Trace · 描痕

Interactive map of Taiwan's long-term change. Extracts dated, comparable features from satellite
imagery so change becomes computable. See [docs/Trace_proposal.md](docs/Trace_proposal.md) for the
full design and build proposal.

## Commands

| | Pipeline (`pipeline/`) | Web (`web/`) |
|---|---|---|
| Test | `pytest` | `npm test` |
| Lint | `ruff check .` | — |
| Format | `ruff format .` | `prettier --write .` |
| Typecheck | — | `npm run typecheck` |
| Build | `python -m trace_pipeline.cli all` | `npm run build` |
| Dev | — | `npm run dev` |

Pipeline runs on Python 3.12 in `pipeline/.venv`. Activate with `source pipeline/.venv/bin/activate`.
Web runs on the Node version pinned in `web/.nvmrc`. CI reads the same file, so the two can't drift
apart; `web/.npmrc` (`engine-strict=true`) makes a mismatch a hard `npm install` failure everywhere
else. Locally, install [fnm](https://github.com/Schniz/fnm) and run `fnm use` after `cd web` — no
shell hook is configured to trigger it on `cd` automatically, so this is a manual step per shell.

## Architecture — three rules that matter

The spine is **sources → extraction → feature store → analysis → serving → frontend**. Three
invariants keep it modular; breaking any of them is what turns this back into a layer-toggler.

**1. The domain manifest is the spine.** The pipeline *emits* `data/domains.json`; the web app
*iterates* it. Nothing in `web/` may hardcode `water` or `forest` — no domain literals in
components, no per-domain branches. Adding a domain is a pipeline module plus a manifest entry.
The manifest also drives the attribution line, per-layer caveats, per-layer slider ranges, and
**which states each domain offers** — the `changeTypes` the pipeline measures out of the built
tileset become one toggle each (`selectableTypes` in
[manifest.ts](web/src/domains/manifest.ts)) and one set of map layers each. So a control can never
appear for a state the data cannot fill, and a layer is never built with no way to switch it off.

**2. Time is a feature attribute, not a tileset.** Each feature carries `valid_from` / `valid_to`,
and one tileset per domain covers every year — never a tileset per year. This is why there is no
tile server.

Inside that tileset the slider animates **opacity, not filters**. Every layer carries a filter
fixed at build time, and a year is shown by setting a constant opacity on the layers it falls in.
This replaced a single layer with a live `["<=", ["get", "valid_from"], year]` filter, because
`setFilter` makes MapLibre re-parse every loaded tile in the worker: each step re-tessellated
everything from the start of the range to the current year — 2,656 features at 2001 against
91,088 at 2025 — so playback started fast and slowed to a crawl. A constant paint value is the
only style change MapLibre applies without touching tile data. A data-driven paint expression is
*not* one: MapLibre reloads the source for that too (`style_layer.ts` returns `isDataDriven` from
`setPaintProperty`, and `style.ts` then reloads), so the year can never be an expression either.

The split follows the kind of state ([layerSpec.ts](web/src/domains/layerSpec.ts)):

- **Change roles** are one *cohort per year*, selecting on `valid_from` (`cohortFilter`). A cohort
  switches on at its year and never off, which is correct precisely because change never closes.
- **Cover roles** are the nodes of an *interval tree* over the range — `2N − 1` layers, each
  selecting the features whose `[valid_from, valid_to)` covers that node but not its parent
  (`intervalFilter`). That is the canonical decomposition, so each year of a feature is claimed
  by exactly one node and a feature that ends is drawn for exactly its years. Shown at year Y is
  the root-to-leaf path through Y, so a step flips at most `2·(depth − 1)` layers per cover role
  — about 10 — whatever the data holds. `layerSpec.test.ts` pins this with MapLibre's own filter
  evaluator; `layerSpec.tiles.test.ts` checks it against every built tileset.

Cover used to be drawn by painting loss patches over a never-ending baseline in the ground colour
to cut holes in it (`cleared-*`). That was the web deriving cover from loss; it is gone.

**3. Every feature carries the full B4 schema.** `domain`, `subtype`, `valid_from`, `valid_to`,
`change_type`, `metric`, `source`, `method`, `confidence` — defined once in
[schema/feature.schema.json](schema/feature.schema.json). PostGIS is deferred to Phase 2, but the
schema is not, so that migration stays a data load rather than a redesign.

### Two kinds of state

`cover` is the state that exists in year Y and carries its own half-open validity interval
`[valid_from, valid_to)`; `valid_to` is the first year the state no longer holds, and `null` means
open. `change` is a verdict accumulated since the record's first year, so `stable`, `gain`, and
`loss` always carry `valid_to: null` and remain drawn in every later year. Water's change
features do not yet satisfy this (see the cohort note above); T-031 re-dates them.

### Colour is a pure function, and hue means the domain

`web/src/domains/colors.ts` exports one function, `styleFor(hue, changeType)`, returning
`{ color, mark, stroke, pattern }`.

**Every state is a transform of the domain's own hue — there is no cross-domain change colour.**
Cover is the hue itself; `stable` is pulled toward the basemap's grey so it recedes; `gain` is
lifted toward white; `loss` is the hue emptied almost to black. This replaced a rule where loss in
every domain was one shared red, which reads correctly at two domains and stops scaling at six: a
shared red says only that *something, somewhere* was lost, and the hue no longer says what. The
palettes of any two domains are disjoint, and `colors.test.ts` asserts it.

`mark` is the third channel and it exists for one reason: below `SCALE_SPLIT_ZOOM` a 30 m patch is
sub-pixel, so the **line is the feature**, and loss is the darkest thing the ramp produces. A
hairline in forest's loss green on the near-black basemap is invisible — at island view, the zoom
the map opens at, loss would simply not be there. So loss draws its sub-pixel mark at the *bright*
end of the same hue. Every other state has `mark === color`.

Colour and pattern come back together on purpose — a split API lets a caller take the loss colour
and skip the hatch, which is the exact accessibility failure A5 exists to prevent. **No colour
literals anywhere else in `web/`.**
The basemap must show no blue and no green — those hues are reserved to mean "water domain" and
"forest domain", so the Protomaps style suppresses its own water and vegetation fills.

### Honesty rules (these are product requirements, not politeness)

- Hansen loss is **tree-cover loss**, never "deforestation" — it includes plantation harvest,
  fire, and typhoon damage.
- Every layer shows its source attribution and its resolution caveat — and the caveat states the
  **retained percentage**, not just the threshold. "Patches under 0.18 ha are not mapped" sounds
  negligible; "this shows 89% of measured loss" is the fact a reader needs. Minimum mapping units
  are set by measuring what they discard, never by intuition: the first guess at 0.5 ha would
  have dropped a third of Taiwan's recorded tree-cover loss.
- Loss is never signalled by colour alone — pair with pattern or icon. Now load-bearing rather
  than belt-and-braces: with no shared loss red, the hatch is the only cross-domain signal that a
  patch means *gone*.

## Dual-Agent Workflow

This repo follows the global Claude+Codex standard (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md).

- Tickets: `.agents/tickets/T-xxx-<slug>.md` (template: `_template.md`). Done → `.agents/tickets/done/`.
- Branches: `claude/T-xxx-slug` | `codex/T-xxx-slug`. Commits: `claude:` / `codex:` prefix.
- All merges to main via squash PR. Codex worktrees live in `.worktrees/` (gitignored).
- Test: `cd pipeline && pytest` / `cd web && npm test` · Lint: `ruff check .` · Format: `ruff format .` / `prettier --write .`

## Gotchas

- **Earth Engine asset versions drift.** Asset IDs live in `pipeline/trace_pipeline/config.py`
  and nowhere else. GSW v1.5 is a *project-hosted* asset, not a catalog one — access is not
  guaranteed, so the water pipeline falls back to v1.4 (1984–2021) and records the reduced range
  in the manifest.
- **Water and forest timelines differ** (1984– vs 2000–). The slider range is per-layer, driven
  by the manifest. Never force a shared range.
- `data/` is generated and gitignored. Never commit `.pmtiles` or `.tif`.
