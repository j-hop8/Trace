# T-043: population domain — registered population density per township
**Goal:** Add a `population` domain: annual registered-population density per township
(鄉鎮市區), as `level` features, following `docs/adding-a-domain.md`.

**Depends on:** T-041 merged. The human has placed the raw files in `data/raw/population/`.

**Sources (local files, not Earth Engine — `needs_earth_engine = False`):**
- Township population by year, 內政部戶政司 / data.gov.tw — the longest machine-readable annual
  series available. `temporal_range()` is read from the file, never hardcoded.
- Current township boundaries: NLSC 鄉鎮市區界線 (TWD97 經緯度) SHP, reprojected to EPSG:4326.
- File paths as constants in `config.py`; a missing file fails with the download instructions.

**Rules:**
- A committed `pipeline/trace_pipeline/domains/township_crosswalk.csv` maps historic names and
  codes (2010 / 2014 municipality upgrades, 鄉→區 renames, merges) onto current units. A name the
  crosswalk cannot place **fails the run** — never a silent drop.
- Density = population / geodesic area of the current polygon (`pyproj.Geod`, as `tiles.py`
  measures). `metric`: `density_per_km2`, `population`, `area_ha`.
- Fixed log breaks `[10, 30, 100, 300, 1000, 3000, 10000]` people/km² (8 bands) in `config.py`;
  `band` via `levels.band_of`.
- One feature per township per year, `valid_from = Y`, `valid_to = Y + 1`.
- `measure`: key `density_per_km2`, unit `people/km²`, label 人口密度 / Population density,
  readout extra `population`.
- Hue: amber/gold in `config.DOMAIN_HUES` (orange-red is temperature's; blue and green are taken).
- Caveat (the honesty point): this is **registered (戶籍) population, not where people live
  (常住)** — students and workers often stay registered at home. Every township is mapped, so the
  caveat says the layer shows 100% of registered population.
- Attribution per 政府資料開放授權條款第1版.

**Files in scope:** `pipeline/trace_pipeline/domains/population.py` (new),
`pipeline/trace_pipeline/domains/township_crosswalk.csv` (new),
`pipeline/trace_pipeline/domains/__init__.py`, `pipeline/trace_pipeline/config.py`,
`pipeline/tests/test_population.py` (new) with small fixtures under `pipeline/tests/fixtures/`.

**Do NOT touch:** `schema/**`, `cohorts.py`, `tiles.py`, `levels.py`, `base.py`, other domains,
`web/**`.

**Acceptance criteria:**
- [ ] Unit tests on fixtures: crosswalk renames and merges sum correctly; an unknown name raises;
      band edges fall into the upper band; density uses geodesic area.
- [ ] `python -m trace_pipeline.cli all` builds `data/population.pmtiles`; `tiles verify` passes.
- [ ] `data/domains.json` lists `population` with `measure`, `level:*` source layers, the caveat
      and the attribution.

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check .`
**Owner:** codex
