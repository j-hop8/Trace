# T-015: Clip the water domain to Taiwan's land boundary

**Goal:** Stop the water domain mapping the sea. Only water inside Taiwan's land boundary is
extracted, so the map no longer paints the Taiwan Strait as a water body that appeared in 1988.

**Files in scope:**
- `pipeline/trace_pipeline/config.py` (the boundary asset id — asset ids live here and nowhere else)
- `pipeline/trace_pipeline/domains/water.py`
- `pipeline/tests/test_water.py`, `pipeline/tests/test_config.py`
- `data/**` — regenerate (gitignored)

**Do NOT touch:**
- `pipeline/trace_pipeline/domains/forest.py` — Hansen is land-only already
- `web/**` — the manifest drives the caveat; no web change is needed
- The B4 schema

**Background:** `water_stats_image` masks to "was this pixel ever water" and clips to the AOI
bbox, and nothing anywhere restricts it to land. JRC GSW classes ocean as water, so every sea
pixel in `TAIWAN_BBOX` is extracted.

Measured against the current extract (30,606 features, 3,348,090 ha): **12 polygons carry 91.3% of
the mapped area**, each one filling a whole grid cell out to the AOI edge — bboxes like
(119.30, 22.85, 119.99, 23.60) are open strait. They are classed `gain` with `valid_from` 1988,
because that is the first year Landsat coverage is dense enough for GSW to call the sea water. So
the layer's headline claim is that the Taiwan Strait appeared in 1988.

**Choosing the mask — measured, not assumed:**

Hansen's `datamask` is the tempting choice (30 m, already a dependency, same grid). It is wrong:
probed at known points, open ocean reads `2` and Sun Moon Lake reads `2` — the same value.
Masking to `datamask == 1` would delete Taiwan's best-known lake along with the sea.

Two boundary vectors classify every probe point correctly (ocean outside; Sun Moon Lake, Shimen
Reservoir, Tainan fishponds, Penghu inside), and both match Taiwan's published land area of
36,193 km² to within 0.1%. Applied to the real 30,606 features:

| | fully inside | dropped | clipped at coast | area kept |
|---|---|---|---|---|
| `FAO/GAUL/2015/level0` | 29,985 | 503 | 118 | 151,047 ha (4.5%) |
| `USDOS/LSIB_SIMPLE/2017` | 30,328 | 226 | 52 | 130,821 ha (3.9%) |

LSIB wins on both counts at once: it drops less than half as many genuine features *and* keeps
less residual sea. GAUL's coarser coastline smooths bays (retaining sea inside them) while cutting
coastal ponds off headlands. What LSIB drops is 3 remaining ocean blobs plus small patches a
median of 24.9 km offshore — not coastal water.

**Acceptance criteria:**
- [ ] The boundary asset id and its filter field live in `config.py`, nowhere else
- [ ] `water_stats_image` restricts to the land boundary, before vectorizing rather than after
- [ ] No extracted feature lies wholly outside the land boundary
- [ ] Inland water survives: Sun Moon Lake, Shimen Reservoir and the Tainan fishpond belt are
      still mapped
- [ ] The caveat states that marine and intertidal water is excluded and that patches at the coast
      are cut at the boundary — a reader must not read the layer as "all water near Taiwan"
- [ ] `data/` regenerated: extract, tiles, manifest
- [ ] Total mapped area is no longer dominated by a handful of cell-filling polygons

**Verify:** `cd pipeline && pytest && ruff check . && ruff format --check .`
**Owner:** claude
