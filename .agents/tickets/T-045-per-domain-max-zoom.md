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
- Measure it on the synthetic field from `pipeline/tests/test_levels.py` (scaled up to the
  island). Record the archive size at 14 and at `DETAIL_ZOOM`, and confirm in the browser that
  z14 overzooms cleanly.
- Water and forest keep 14.

**Files in scope:** `pipeline/trace_pipeline/domains/base.py`, `pipeline/trace_pipeline/tiles.py`,
`pipeline/tests/test_tiles.py`, `pipeline/tests/test_levels.py`, `docs/adding-a-domain.md`.

**Do NOT touch:** `web/**`, `schema/**`, `cohorts.py`, any domain module.

**Acceptance criteria:**
- [ ] A domain with `max_zoom = DETAIL_ZOOM` builds, verifies, and yields an archive holding no
      tile deeper than that zoom.
- [ ] A `max_zoom` below `DETAIL_ZOOM` or above `MAX_ZOOM` is refused before tippecanoe runs.
- [ ] Water and forest archives are byte-for-byte unaffected (same flags).

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check .`
**Owner:** codex
