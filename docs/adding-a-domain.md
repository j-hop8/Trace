# Adding a domain

A domain is a pipeline module plus a manifest entry. Nothing in `web/` changes: the web learns a
domain's name, hue, years, states, legend, caveat and credit from `data/domains.json`. If adding
a domain seems to need a web change, the domain is asking for a new *kind* of state. That is a
spine change with its own ticket, never a per-domain branch.

## 1. Decide what kind of state it is

| The source says… | Kind | `change_type` | Example |
|---|---|---|---|
| what is there in a year, as a category | cover | `cover` | forest canopy, water surface, land-use class |
| what changed since the record began | change | `loss` / `gain` / `stable` | Hansen loss year, JRC transitions |
| a measured number for a year | level | `level` | temperature anomaly, population density |

A categorical source such as land use (國土利用) is **cover**, one domain per subject. A value
source is **level**.

## 2. The module

`pipeline/trace_pipeline/domains/<id>.py`: subclass `Domain`, decorate with `@register`, and
import it in `domains/__init__.py`.

- **`id`, `label`**: the id is the PMTiles filename and every feature's `domain`. Never rename one
  without a manifest version bump.
- **`source`**: `attribution` is the credit the licence requires, verbatim. `licence` is the
  licence's actual name. The manifest refuses an empty attribution.
- **`caveat`**: one paragraph of plain prose (no markup) saying what the layer *cannot* tell you.
  It states the **retained percentage**, measured and not guessed, plus the honesty point
  particular to the source: tree-cover loss is not deforestation, and registered population is
  not where people live.
- **`temporal_range()`**: read from the data or the source, never hardcoded. A shorter fallback
  must show up here.
- **`change_types`**: the states it is designed to emit. The manifest publishes what the built
  archive actually holds.
- **`needs_earth_engine`**: set it `False` for a domain that reads local files. `trace extract`
  then never authenticates for it and passes it the `(west, south, east, north)` bbox tuple, not
  an `ee.Geometry`.
- **`extract()`**: returns a FeatureCollection whose every feature satisfies
  `schema/feature.schema.json`. Build features through `schema.TraceFeature`, or through
  `levels.level_feature` for a level, so a bad one fails at the line that built it.

Constants such as asset IDs, raw file names, thresholds and breaks go in `config.py` and nowhere
else. Downloaded sources live in `data/raw/<id>/` (`extract.RAW_DIR`), which is gitignored with
the rest of `data/`. A missing file fails with the instructions to download it.

## 3. A level domain

- **`measure`**: set `Domain.measure` to a `Measure` with the metric key, unit, bilingual label,
  **fixed breaks**, an optional baseline, and any extra `readout` values. The manifest refuses
  levels without a measure.
- **Breaks are chosen, not fitted, and the same for every year.** Per-year quantiles would make
  one colour mean different values in different years. A value on a break belongs to the band
  above it (`levels.band_of`).
- **One feature per region per year**: `valid_from = Y`, `valid_to = Y + 1`, always closed.
- **A grid is dissolved, not drawn cell by cell.** Use `levels.grid_cells` and
  `levels.dissolve_grid`: one year's same-band cells merge into connected regions, each quoting
  the area-weighted mean of what it covers. A missing cell stays a gap, never filled.
- **Admin units** (townships, villages): one feature per unit per year, keyed to the current
  boundary through a committed crosswalk. A unit the crosswalk cannot place fails the run.
- A level domain is a **backdrop**: off when the map opens, one at a time, drawn beneath every
  other domain. That comes from the kind; the module does nothing for it.

## 4. The hue

Add `config.DOMAIN_HUES[<id>]`. Every state, including a level's whole ramp, is a lighter or
darker version of this one hue, so hue is how the reader tells domains apart.
`test_domain_hues_sit_apart_on_the_wheel` requires 30° between any two.

The budget is small, and parts of it are taken:

- **Blue is water and green is forest.** The basemap draws neither, so those hues keep their
  meaning. A rainfall layer cannot be blue and NDVI cannot be green.
- Red is temperature, gold is population. The proposal sets aside teal/sand for coast,
  magenta/grey for urban and violet for transport.
- When a measured layer's natural colour is taken, pick an unclaimed hue and say why in the
  ticket, or group related measures under one family domain. Decide this before writing the
  module, because renaming a domain later costs a manifest version bump.

## 5. Verify

```bash
cd pipeline && pytest && ruff check . && ruff format --check .
python -m trace_pipeline.cli all        # or: extract <id>, tiles <id>, manifest
cd ../web && npm test                   # layerSpec.tiles.test.ts decodes every built archive
```

`tiles verify` has to pass. It counts every detail copy back out of the archive and measures the
island view's retained area per kind. Then check the domain in the browser: toggle, legend,
slider range, readout at and below `tiles.detailZoom`, caveat, and credit line.
