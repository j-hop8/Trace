# T-019: Seasonal water on managed land is irrigation, not a water body

**Goal:** Stop Taiwan's farmed plains rendering as solid water, by generalising T-018's built-up
rule to all managed ground — one per-pixel rule applied identically across the island.

**Files in scope:**
- `pipeline/trace_pipeline/domains/water.py` (`managed_land`, `MASK_ON_MANAGED_LAND`,
  `water_stats_image`, `caveat`)
- `pipeline/trace_pipeline/config.py` (`WORLDCOVER_MANAGED_CLASSES`, re-measured percentages)
- `pipeline/tests/test_water.py`
- `data/**` — regenerate

**Do NOT touch:** `web/`, `schema/feature.schema.json`, `domains/forest.py`, the T-015 land mask,
T-017's transition-class derivation.

**Background.** 宜蘭 rendered as almost solid water. It is the region T-018 deliberately protected —
the argument then was that its `new seasonal` class is real flooded paddy. Half right, and the wrong
half matters: the water is real but it is not a *water body*, and the layer presents it as one.

This is not local to Yilan. Island-wide, against ESA WorldCover:

- **permanent-grade classes (1,2,3,7,8,9): 79.5% sit on WorldCover water** (39,342 of 49,498 ha)
- **seasonal-grade classes (4,5,6,10): only 32.1% do** (27,357 of 85,101 ha) — the rest is grass
  15.2%, cropland 14.6%, tree 13.5%, built-up 9.3%

Yilan is just where it shows most: 74.7% of its mapped water is on cropland, 8.6% on actual water.

**The `gain` label is separately weak.** JRC compares epoch 1 (1984–1999) against epoch 2
(2000–2021), and Taiwan's no-data years are almost all in epoch 1 — 1984 68%, **1985 100%**, 1986
99.5%, 1987 89.8%, plus 1997 21.7%, 1998 65.3%, 1999 26.5% — while epoch 2 runs under 1%. For pixels
JRC calls `new seasonal`, the median was **already water in 46% of the epoch-1 years GSW could see**
(`new permanent`: 78%). Landsat revisit also roughly doubled (L7 1999, L8 2013), and catching a
paddy's short flooded window depends on revisit frequency. Handled in the caveat, not by changing
the data — comparing two well-observed windows (1989–96 vs 2014–21) still puts Yilan at 47% gain,
which is the confound rather than a correction of it.

**Approach:** extend `MASK_ON_BUILT_UP` → `MASK_ON_MANAGED_LAND` over
`WORLDCOVER_MANAGED_CLASSES = (40, 50)` — cropland and built-up. Same class set {4,5,10}, so classes
that say the water *ended* survive on managed ground and a pond filled in for housing or converted
to a field still appears. Removal is 4.7% (built-up) + 7.8% (cropland) = **12.6%** of JRC's classed
water; the layer keeps 87%.

Rejected by measurement: requiring seasonal water to sit on WorldCover water/wetland (Yilan 11% but
Taoyuan 76%, Chiayi 90%); dropping seasonal-only classes outright (Yilan 4% but Taoyuan 52%,
Chiayi 74%, costing 63% island-wide).

**Acceptance criteria:**
- [ ] One rule, no place named in the pipeline — enforced by a test that water.py holds no
      coordinate literals
- [ ] Yilan's plain falls to roughly a quarter of JRC's raw water; Taoyuan ≥88%, Chiayi ≥96%,
      Taipei unchanged
- [ ] Island-wide 10 km sweep: no cell retains an implausible water share, and the cells that lose
      most are farmland
- [ ] Only classes 4, 5 and 10 change; every other class unchanged to the hectare
- [ ] 蘭陽溪 and 冬山河 survive, as do the T-018 controls (大湖公園, 碧潭, 淡水河, 石門水庫, 翡翠水庫)
- [ ] Caveat states the managed-land rule, its 12.6% cost, that ended water is kept, the
      2021-snapshot limit, and that `gain` is not "water where there was none"
- [ ] `data/` regenerated, `WATER_RETAINED_PCT` re-measured

**Verify:** `cd pipeline && pytest && ruff check .`
**Owner:** claude
