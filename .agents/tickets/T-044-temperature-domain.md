# T-044: temperature domain — annual mean temperature anomaly, TCCIP 1 km
**Goal:** Add a `temperature` domain: each 1 km cell's annual mean air temperature as the
anomaly from its 1991–2020 normal, as `level` features, following `docs/adding-a-domain.md`.

**Depends on:** T-041 merged, **and** the human has downloaded the TCCIP gridded observations to
`data/raw/temperature/` and recorded the licence terms. Do not start before both.

**First step — the one real unknown:** inspect the downloaded files and record their format here.
NetCDF → add `netCDF4` to `pipeline/pyproject.toml` and read with xarray; GeoTIFF → add
`rioxarray`; CSV grids → pandas suffices. Record the CRS and grid spacing too.

**Rules:**
- `needs_earth_engine = False`; paths in `config.py`; missing file fails with instructions.
- Per cell: annual mean from monthly values (a year with a missing month is dropped for that
  cell and counted, not interpolated); normal = mean of 1991–2020; `temp_anomaly_c` = year −
  normal. Keep `temp_mean_c` too.
- Fixed breaks `[-1.0, -0.5, 0.0, 0.5, 1.0, 1.5]` °C (7 bands) in `config.py`.
- `levels.dissolve_grid` per year → one feature per (year, band) connected polygon; metric =
  area-weighted mean `temp_anomaly_c` and `temp_mean_c` over the polygon, plus `area_ha`.
- `measure`: key `temp_anomaly_c`, unit `°C`, label 年均溫距平 / Annual temperature anomaly,
  baseline `1991–2020`, readout extra `temp_mean_c`.
- Hue: orange-red in `config.DOMAIN_HUES` (the proposal reserves it for climate).
- Caveat: a 1 km grid interpolated from station records — mountain cells rest on few stations,
  especially in early decades; anomaly relative to the 1991–2020 normal; the count of dropped
  cell-years.
- `SourceInfo.licence` / `attribution` carry TCCIP's required wording verbatim. **No
  `npm run publish:data` until the licence permits redistributing derived polygons.**

**Files in scope:** `pipeline/trace_pipeline/domains/temperature.py` (new),
`pipeline/trace_pipeline/domains/__init__.py`, `pipeline/trace_pipeline/config.py`,
`pipeline/pyproject.toml` (reader dependency only), `pipeline/tests/test_temperature.py` (new)
with a tiny synthetic grid fixture.

**Do NOT touch:** `schema/**`, `cohorts.py`, `tiles.py`, `levels.py`, `base.py`, other domains,
`web/**`.

**Acceptance criteria:**
- [ ] Fixture tests: anomaly against a known normal; missing month drops the cell-year; banding
      at edges; dissolve yields one polygon per connected same-band region.
- [ ] `python -m trace_pipeline.cli all` builds `data/temperature.pmtiles`; `tiles verify` passes.
- [ ] `data/domains.json` lists `temperature` with `measure`, baseline, caveat, attribution.

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check .`
**Owner:** codex
