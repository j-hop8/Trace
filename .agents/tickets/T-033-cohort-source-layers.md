# T-033: one source-layer per cohort — the worker stops filtering every feature 589 times
**Goal:** Make the map load in seconds rather than minutes by writing each cohort's features into
its own layer of the tileset, so MapLibre's worker runs a cohort's filter over that cohort's
features instead of over every feature in the tile.

**Symptom:** At the opening view nothing draws; both domains sit on 載入中 indefinitely and
`map.loaded()` is still false after 20 s, although every tile's bytes arrived in the first second.

**Found while building:** forest holds 2,656 cover patches `[2000, 2001)` — in the baseline year,
gone by the first year the slider shows. No node covers a year before the range, so the web
never drew them from a single layer either. The tiler leaves them out and prints the count
(`Cohorts.layers_for` returns no layer); a feature that *begins after* the range is still refused,
because that is the data outrunning the range the domain reports.

**Cause, measured (not guessed):** `worker_tile.ts` decodes a tile's source-layer once and then,
for every style layer on it, walks *every* feature through that layer's filter
(`FillBucket.populate` → `_featureFilter.filter`). The cohort model puts 589 style layers on two
source-layers (forest 173, water 416), and the tilesets are deliberately unthinned, so the largest
z7 water tile holds 400,713 features. Run through MapLibre's own evaluator, that is 416 × 400k =
167M filter evaluations ≈ 43 s of worker time for one tile, and 11 such tiles at the opening view.
Everything else is cheap by comparison: decoding that tile is 1.0 s, earcut on all 400k polygons
0.16 s. The filter pass is ~40× the real work.

Collapsing the layers into an expression is not available: MapLibre 5.24 treats a `global-state`
change on a data-driven paint property as a relayout (`style_layer.ts` `setPaintProperty` returns
`isDataDriven`; `style.ts` `_updatePaintProperty` → `_updateLayer` → reload). The CLAUDE.md
invariant stands — the year is opacity, the layers are O(N). What can change is what each layer's
filter is run *against*, and the worker scopes that by `source-layer`, which is a tile property.

**Mechanism:** The pipeline writes every feature into the tile layer named after its cohort,
using tippecanoe's per-feature `tippecanoe.layer`. The key is the web's own cohort rule, so the
names line up with the style layers by construction:

- change kind (`stable`/`gain`/`loss`): `{change_type}:{year}` with `year = max(valid_from,
  start)` — the web's first cohort takes everything from the start year back, and so does this.
- cover kind: one copy per **canonical interval node** of `[valid_from, valid_to)` clipped to
  `[start, end + 1)`, named `cover:{node.start}-{node.end}`. The tree is the same binary split the
  web builds in `intervalNodes` (T-024), and the canonical decomposition is what `intervalFilter`
  selects — a feature is in node n iff it covers n and not n's parent. Open-ended cover
  (`[2000, null)`, `[1984, null)`) is the root alone; closed stretches average 2.1 copies
  (measured over water's 484k cover features). The copies cost tile bytes once per tile load; the
  alternative — one flat layer per distinct `(from, to)` pair, no copies — is 660 pairs for water
  cover, hundreds of them shown in any one year, and that costs every frame.

The style layers keep their filters. They are the *definition* of a cohort; the source-layer is
the index that makes them cheap, and keeping both means the tiles test can assert the two agree:
for every style layer, its filter over the whole tile selects exactly its source-layer.

**Files in scope:**
- `pipeline/trace_pipeline/cohorts.py` (new): the interval tree, the canonical decomposition, the
  layer-name rule and its parser. One place; `tiles.py` and `manifest.py` both import it.
- `pipeline/trace_pipeline/tiles.py`: write the tippecanoe input as line-delimited features with
  `tippecanoe.layer` set (cover duplicated per node), count what was *emitted*, verify total
  count across layers and that every layer name parses; `change_types_in` reads the layer names.
- `pipeline/trace_pipeline/manifest.py`: `tiles.sourceLayers` measured from the archive's
  `vector_layers`; `_check` refuses a layer that is not a node of the tree over `temporal` (tiles
  built for a different range). The fallback to declared intent applies only when there is no
  archive; one that is present but unreadable, or from before cohort layers, is refused.
- `pipeline/trace_pipeline/config.py`: `MANIFEST_VERSION` → 2.
- `pipeline/trace_pipeline/cli.py`: a `manifest` subcommand, so tiles can be rebuilt and the
  manifest rewritten without re-extracting. `all` calls it.
- `pipeline/trace_pipeline/domains/base.py`: `manifest_entry` takes the source-layer list.
- `pipeline/tests/test_cohorts.py` (new), `test_tiles.py`, `test_cli.py`, and whatever test
  builds a manifest entry.
- `web/src/domains/manifest.ts`: `tiles: { url, sourceLayers: string[] }`; `SUPPORTED_VERSION` 2.
- `web/src/domains/layerSpec.ts`: each cohort carries its source-layer; a cohort whose layer the
  manifest does not list gets no style layer (MapLibre fires an error per style layer naming a
  layer the source lacks, and an empty cohort is empty). Export the enumeration of every cohort's
  source-layer for the tests and the tiles test.
- `web/src/domains/layerSpec.test.ts`, `layerSpec.tiles.test.ts`, `manifest.test.ts`: fixtures
  carry `sourceLayers`; the tiles test decodes every layer of a tile and asserts (a) each style
  layer's filter over the whole tile selects exactly the features of its source-layer, (b) the
  plain-time semantics per year hold with copies counted once. Identity is the tile feature `id`
  — every copy carries the source feature's index (`web/src/types/feature.ts` documents it) —
  because single-pixel patches share every attribute, and tippecanoe simplifies each tile layer
  on its own, so copies of one feature can differ in tile geometry.
- `CLAUDE.md`: the cohort paragraph gains the source-layer sentence.

**Do NOT touch:** `styleFor` / `colors.ts`; the toggle UI; `useDomainLayers.ts` beyond comments;
`schema/**`; the extraction step (`extract.py`, `domains/forest.py`, `domains/water.py`) — the
GeoJSON is unchanged and is not re-extracted; tippecanoe's no-loss flags — the copies are
accounted for in the count check, nothing is dropped.

**Measured after re-tiling** (opening view, both domains, pane visible): basemap painted at
1.3 s, domain sources added at 1.8 s, all 12 domain tiles parsed and `idle` at 18.4 s / 20.0 s
over two runs, no main-thread task longer than 0.43 s. Before: `map.loaded()` still false after
20 s and nothing ever drew. What remains is worker tessellation of ~1.2 M sub-pixel polygons and
their outlines per z7 tileset — a separate question about what the island view should hold
(aggregate, thin, or drop the cover outline below the split), with honesty-rule implications, so
it is not folded into this ticket. Archive sizes: forest 44 → 76 MB, water 59 → 137 MB — the
cover copies plus a per-copy id (~25% of the water increase is the id alone).

**Acceptance criteria:**
- [x] Opening view draws both domains within ~20 s on the existing GeoJSON, re-tiled (was: never).
- [x] Every tile layer name parses back to a cohort the web builds; the tiles test asserts filter
      selection == source-layer membership for every style layer of every domain.
- [x] Per year, the union of shown layers equals the features valid that year, each once.
- [x] `verify` fails when the tiled count differs from the *emitted* count, or a layer name is
      not a cohort.
- [x] `manifest.build` refuses tiles whose layers are not nodes of the tree over the domain's
      current `temporal_range()`.
- [x] `trace manifest` writes `data/domains.json` from built tiles without Earth Engine
      extraction.
- [x] A version-1 manifest is refused by the web with the "regenerate" message.

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check .` and
`cd web && npm run typecheck && npm test && npm run format:check`, with re-tiled archives present
so the tiles test runs.
**Owner:** claude
