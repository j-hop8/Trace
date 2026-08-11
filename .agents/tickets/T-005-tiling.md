# T-005: Tiling and manifest emit
**Goal:** Turn each domain's GeoJSON into one PMTiles file plus `data/domains.json`.

**Files in scope:**
- `pipeline/trace_pipeline/tiles.py` (new)
- `pipeline/trace_pipeline/cli.py` (extend — the skeleton already exists)
- `pipeline/tests/test_tiles.py` (new)

**Do NOT touch:** `web/`, `schema/`, extraction modules.

**CLI shape:** already scaffolded in T-000 with `list` · `extract` · `tiles` · `all`, dispatching
over `domains.all_ids()` — never a hardcoded list. It imports `tiles` lazily inside `cmd_tiles`,
so this ticket only has to supply `tiles.build(domain)`; do not restructure the dispatch.

**Tippecanoe invocation notes:**
- One layer per file, layer name = domain id, so `sourceLayer` in the manifest matches.
- **Do not** use `--drop-densest-as-needed` or `--drop-smallest-as-needed`. Dropping features
  silently changes the area totals the UI reports as fact. Use `-zg` with an explicit max zoom
  and let file size be what it is; if it is too large, raise `MIN_PATCH_HA` deliberately and say
  so in the caveat rather than letting the tiler quietly discard data.
- Preserve all attributes; the readout depends on them.

**Acceptance criteria:**
- [ ] `trace all` produces `data/<domain>.pmtiles` for every registered domain, plus
      `data/domains.json`.
- [ ] Fails loudly with an actionable message if `tippecanoe` is not on PATH.
- [ ] Feature count in the tileset matches the input GeoJSON — assert it, don't assume it.
- [ ] `data/domains.json` validates against what `web/src/domains/manifest.ts` expects.
- [ ] Re-running is idempotent (overwrites cleanly, no `.pmtiles` left half-written on failure).

**Verify:** `cd pipeline && pytest && ruff check .`
**Owner:** codex
