# T-045: a coarse source stops tiling at the zoom its resolution supports
**Goal:** Let a domain declare the deepest zoom its data means anything at, and tile it no
deeper. MapLibre overzooms the last level, so the map is unchanged and the archive shrinks.

**Found in T-041.** A synthetic 5 km level field for 1960–2023 is 378 features and built to a
**46 MB** archive. Every year covers the whole island at every zoom up to `tiles.MAX_ZOOM` (14),
and z12–z14 are ~98% of the tiles. For a 30 m source that depth is the data. For a 1 km grid
(TCCIP) or a township polygon it is the same shapes re-cut into 64× more tiles. The real 1 km
temperature field will be larger than the synthetic one.

**Shape:**
- `Domain.max_zoom: int = tiles.MAX_ZOOM`, validated in `tiles.build` to lie in
  `[config.DETAIL_ZOOM, tiles.MAX_ZOOM]`. The detail regime must still exist, because `verify`
  counts it at `DETAIL_ZOOM`.
- `tiles.build` passes `--maximum-zoom` from the domain.
- Measure it on the synthetic field from `pipeline/tests/test_levels.py`, scaled up to the
  island (build it in a temp dir, never in `data/`). Record the archive size at 14 and at
  `DETAIL_ZOOM` in this ticket under a **Measured** heading. The reviewer checks in the browser
  that z14 overzooms cleanly; you don't need a browser.
- Water and forest keep 14: the default leaves the tippecanoe command exactly as it is today.

**Environment (read before running anything):**
- `pipeline/.venv` in this worktree is a **symlink to the main checkout's venv, shared with it.
  Do not install into it, upgrade it, or delete it.**
- Its package is an *editable install of the main checkout*, so plain `pytest` imports the main
  checkout's `trace_pipeline` and **silently tests the wrong code**. Always use
  `.venv/bin/python -m pytest` from `pipeline/`, which puts this worktree's code first.
- `tippecanoe`, `tippecanoe-decode` and `pmtiles` are in `/opt/homebrew/bin`. Keep that on
  `PATH`, because without it the archive-building tests *skip* rather than fail, and the Verify
  command would pass without testing this ticket.

**Files in scope:** `pipeline/trace_pipeline/domains/base.py`, `pipeline/trace_pipeline/tiles.py`,
`pipeline/tests/test_tiles.py`, `pipeline/tests/test_levels.py`, `docs/adding-a-domain.md`.

**Do NOT touch:** `web/**`, `schema/**`, `cohorts.py`, any domain module.

**Acceptance criteria:**
- [x] A domain with `max_zoom = DETAIL_ZOOM` builds, verifies, and yields an archive holding no
      tile deeper than that zoom.
- [x] A `max_zoom` below `DETAIL_ZOOM` or above `MAX_ZOOM` is refused before tippecanoe runs.
- [x] Water and forest archives are byte-for-byte unaffected (same flags), pinned by a test on
      the command `tiles.build` would run.
- [x] The new archive-building test runs (does not skip) under the Verify command.
- [x] Ticket file moved to `.agents/tickets/done/`.

**Verify:** `cd pipeline && PATH="/opt/homebrew/bin:$PATH" .venv/bin/python -m pytest -rs && .venv/bin/ruff check . && .venv/bin/ruff format --check .`
**Owner:** codex

## Measured

Measured on 2026-09-27 with tippecanoe v2.79.0, using the `SyntheticGrid` domain and `grid`
helper from `pipeline/tests/test_levels.py`, expanded to 57 columns × 78 rows of 5 km cells
over 1960–2023. The grid's top-left cell centre is TWD97
`(76769.1375585483, 2803132.2543088943)`, covering the projected Taiwan bounding box.
Values are `-1.5 + 0.025 * (year - 1960) + 0.05 * column`, with fixed breaks
`(-1, -0.5, 0, 0.5, 1, 1.5)`. Same-band cells dissolve through `levels.dissolve_grid`, then
regions are clipped to `config.TAIWAN_BBOX` (the island's extent, not a land mask), yielding
368 level features. Both builds use the same extracted GeoJSON; only `max_zoom` differs.

| Maximum zoom | Archive bytes | Decimal MB |
|---|---:|---:|
| 14 (default) | 33,031,865 | 33.03 |
| 11 (`DETAIL_ZOOM`) | 1,080,014 | 1.08 |

Stopping at 11 saves **96.73%** of the archive bytes (30.58× smaller). Both builds pass
`tiles.verify`: all 368 detail copies survive, and retained area rounds to 100.0% at both
checked island zooms (7 and 10). Their PMTiles headers advertise maximum zooms 14 and 11
respectively. The end-to-end test separately decodes zooms 12–14 of the capped fixture and
finds no features, while checking every detail copy at zoom 11.

Temporary benchmark artifacts for review are in `/private/tmp/trace-T-045-l329zxod/`:
`temperature.geojson`, `temperature-z14.pmtiles`, and `temperature-z11.pmtiles`.
Nothing was built in `data/`. The browser overzoom check remains with the reviewer as specified.

The exact Verify command passed: **339 passed, 3 skipped**, plus Ruff lint and format checks.
Both archive-building parameter cases (`[14]` and `[11]`) ran. The three skips are existing
tests requiring generated `forest.geojson` or `water.geojson`, absent from this worktree.
The shared `pipeline/.venv` symlink and its packages were left unchanged.
