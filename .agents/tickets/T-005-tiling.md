# T-005: Tiling and manifest emit
**Goal:** Turn each domain's GeoJSON into one PMTiles file plus `data/domains.json`.

**Files in scope:**
- `pipeline/trace_pipeline/tiles.py` (new)
- `pipeline/trace_pipeline/cli.py` (extend — the skeleton already exists)
- `pipeline/tests/test_tiles.py` (new)
- this ticket file — findings from the run are recorded here as the work proceeds

**Do NOT touch:** `web/`, `schema/`, extraction modules.

**CLI shape:** already scaffolded in T-000 with `list` · `extract` · `tiles` · `all`, dispatching
over `domains.all_ids()` — never a hardcoded list. It imports `tiles` lazily inside `cmd_tiles`,
so this ticket only has to supply `tiles.build(domain)`; do not restructure the dispatch.

**Tippecanoe invocation notes:**
- One layer per file, layer name = domain id, so `sourceLayer` in the manifest matches.
- **Do not** use `--drop-densest-as-needed` or `--drop-smallest-as-needed`. Dropping features
  silently changes the area totals the UI reports as fact. Set an explicit zoom range and let file
  size be what it is; if it is too large, raise `MIN_PATCH_PIXELS` deliberately and restate the
  retained percentage, rather than letting the tiler quietly discard data.
- Three defaults must also be disabled, or tippecanoe discards data without being asked:
  `--no-feature-limit` (200k features/tile), `--no-tile-size-limit` (500 KB/tile), and
  `--no-tiny-polygon-reduction` (merges sub-pixel polygons into dots at low zoom).
- Preserve all attributes; the readout depends on them.

## Findings from the first real run

**The staging filename decides the output format.** Tippecanoe picks MBTiles vs PMTiles from the
output *extension*, so staging as `forest.pmtiles.partial` produced an MBTiles database that was
then renamed to `.pmtiles` — the wrong format under the right name, which every later step would
have trusted. Staging is now `forest.partial.pmtiles`, and the built archive's magic bytes are
checked before the move.

**Two attribute changes matter for T-007:**

- `metric` survives as a **JSON string** (`'{"area_ha":0.1397}'`), not a nested object and not
  flattened to `metric.area_ha`. MVT has no nested values. `readMetric()` in
  `web/src/types/feature.ts` currently handles flattened and nested only, so it would return
  `undefined` and the readout would silently show a dash.
- `valid_to` is **absent from the tiles entirely**, because every forest value is null and
  tippecanoe drops null attributes. A filter referencing it must treat *missing* as "still
  current" rather than assuming the key exists.

**Result:** 91,087 features → 13.9 MB, z5–14, tilestats count verified equal to the source.

**Acceptance criteria:**
- [ ] `trace all` produces `data/<domain>.pmtiles` for every registered domain, plus
      `data/domains.json`.
- [ ] Fails loudly with an actionable message if `tippecanoe` is not on PATH.
- [ ] Feature count in the tileset matches the input GeoJSON — assert it, don't assume it.
- [ ] `data/domains.json` validates against what `web/src/domains/manifest.ts` expects.
- [ ] Re-running is idempotent (overwrites cleanly, no `.pmtiles` left half-written on failure).

**Verify:** `cd pipeline && pytest && ruff check .`
**Owner:** codex
