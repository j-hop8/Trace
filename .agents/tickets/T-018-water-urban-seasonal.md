# T-018: Seasonal water on built-up ground is building shadow, not water

**Goal:** Stop central Taipei rendering a dense scatter of water where only a few park ponds exist,
without deleting Taiwan's real seasonal water (rice paddy, 埤塘, aquaculture) to do it.

**Files in scope:**
- `pipeline/trace_pipeline/domains/water.py` (`built_up`, `MASK_ON_BUILT_UP`, `water_stats_image`,
  `caveat`)
- `pipeline/trace_pipeline/config.py` (`WORLDCOVER_*`, re-measured percentages)
- `pipeline/tests/test_water.py`
- `data/**` — regenerate

**Do NOT touch:** `web/`, `schema/feature.schema.json`, `domains/forest.py`, the T-015 land mask,
T-017's transition-class derivation.

**Background — measured, not suspected.** Over Taipei's urban core (121.515–121.575E,
25.025–25.070N, river excluded): **204 ha of water in 30 km²**, about 7× what 大安森林公園,
中正紀念堂 and 植物園 actually hold. 59.5% of it is JRC class 5 `new seasonal`, 14.2% class 10
`ephemeral seasonal`, 11.7% class 4 `seasonal`; only 4.8% `permanent`. 17.3 features/km², median
0.24 ha — the signature of 30 m pixels reading the shadow between towers as water.

**The obvious fix is wrong.** Dropping the seasonal classes everywhere cuts real data harder than
the artefact, because the same classes carry Taiwan's genuine seasonal water:

| region | now | drop 4,5 | drop 4,5,10 |
|---|---|---|---|
| Taipei urban core (**want gone**) | 204 ha | keeps 29% | keeps 15% |
| Yilan paddy plain (**want kept**) | 3,742 ha | keeps 21% | keeps 7% |
| Taoyuan 埤塘 belt | 445 ha | keeps 73% | keeps 68% |
| Chiayi aquaculture | 9,145 ha | keeps 67% | keeps 62% |

Yilan is 75.8% `new seasonal` and correctly so — paddy floods seasonally. The class drop costs
41–52% of the layer and still leaves Taipei ~2× its real pond area. GSW's own quality bands do not
separate them either: over class 4/5 pixels, occurrence is p50=12% in Taipei against p50=20% in
Yilan; recurrence p50=77% against p50=89%.

**The artefact is spatial.** Against ESA WorldCover, **94%** of Taipei's seasonal-class pixels sit
on built-up ground, against **2%** in Yilan, 5% in Chiayi, 13% in Taoyuan — and **0%** of
`permanent`-class pixels are built-up in any of them, so the rule cannot reach a real urban lake.

**Approach:** drop classes 4, 5, 10 where WorldCover says built-up. Keep 3, 6, 9 there — WorldCover
is a 2021 snapshot, so "built-up" is a claim about today, and water that *ended* on land that is now
built is a 埤塘 filled in for housing (15% of `lost permanent` and 12% of `lost seasonal` sit there
for exactly that reason). Keep 8 as well: it involves permanent water, so it is a pond encroached
on, not a shadow.

**Acceptance criteria:**
- [ ] Taipei urban core falls to roughly its real park-pond area (~40 ha from 204 ha)
- [ ] Yilan keeps ≥95%, Chiayi ≥95%, Taoyuan ≥85%
- [ ] 大湖公園 and 碧潭 — real water inside built-up areas — survive as `permanent`
- [ ] No `permanent`-class area lost anywhere; `lost permanent` on built-up ground unchanged
- [ ] Caveat states the rule, its measured cost, that ended water is kept, and the 2021-snapshot
      limitation
- [ ] `data/` regenerated, `WATER_RETAINED_PCT` re-measured

**Verify:** `cd pipeline && pytest && ruff check .`
**Owner:** claude
