"""Every constant the pipeline depends on, in one place.

Earth Engine asset IDs drift between versions. They live here and nowhere else, so a catalog
update is a one-line change rather than a grep across modules.
"""

from typing import Final

# --- Area of interest -------------------------------------------------------------------------
# Main island + Penghu. Kinmen (~118.3E) and Matsu (~26.2N) are deliberately excluded: including
# them would stretch the tile extent across ~200 km of empty ocean for two small archipelagos.
# Set TAIWAN_BBOX_WITH_OUTLYING to pick them up once a story needs them.
TAIWAN_BBOX: Final[tuple[float, float, float, float]] = (119.3, 21.85, 122.05, 25.35)
TAIWAN_BBOX_WITH_OUTLYING: Final[tuple[float, float, float, float]] = (118.1, 21.85, 122.05, 26.4)

# --- Earth Engine assets ----------------------------------------------------------------------
# Verified 2026-08-10 against the Earth Engine data catalog.
HANSEN_ASSET: Final[str] = "UMD/hansen/global_forest_change_2025_v1_13"
HANSEN_FIRST_LOSS_YEAR: Final[int] = 2001  # lossyear band value 1
HANSEN_LAST_LOSS_YEAR: Final[int] = 2025  # lossyear band value 25
HANSEN_BASELINE_YEAR: Final[int] = 2000  # treecover2000

# JRC Global Surface Water. v1.4 is the public catalog asset (1984-2021). v1.5 is project-hosted
# and extends coverage to 2024 -- access is NOT guaranteed, so water.py probes it and degrades to
# v1.4 alone, recording whichever range it actually got in the manifest.
GSW_V14_YEARLY: Final[str] = "JRC/GSW1_4/YearlyHistory"
GSW_V14_LAST_YEAR: Final[int] = 2021
GSW_V15_YEARLY: Final[str] = "projects/global-surface-water/assets/GSW1_5/YearlyHistory"
GSW_V15_LAST_YEAR: Final[int] = 2024
GSW_FIRST_YEAR: Final[int] = 1984
# JRC's `transition` band compares two epochs, 1984-1999 and 2000-2021. A class that is a verdict
# across the two -- `seasonal to permanent`, `permanent to seasonal` -- carries no year of its own,
# and the first year of the second epoch is the one date the class itself supplies (T-031).
GSW_EPOCH_2_FIRST_YEAR: Final[int] = 2000
GSW_MAPPING_LAYERS: Final[str] = "JRC/GSW1_4/GlobalSurfaceWater"  # occurrence / transition / change

# Taiwan's land boundary. GSW classes ocean as water, so without this the water domain maps the
# Taiwan Strait: 12 cell-filling polygons carried 91.3% of the first extract's area, dated `gain`
# 1988 because that is when Landsat coverage gets dense enough for GSW to call the sea water.
#
# LSIB rather than Hansen's `datamask` or GAUL, decided by measurement rather than convenience:
#
#   - `datamask` is the tempting one (30 m, already a dependency, same grid) and is wrong. Probed
#     at known points, open ocean reads 2 and Sun Moon Lake reads 2 -- the same value -- so
#     masking to `datamask == 1` deletes Taiwan's best-known lake along with the sea.
#   - GAUL and LSIB both classify every probe point correctly and both match Taiwan's published
#     36,193 km2 to within 0.1%, but against the real 30,606-feature extract GAUL drops 503
#     features and keeps 151,047 ha where LSIB drops 226 and keeps 130,821 ha. GAUL loses on both
#     counts at once: its coarser coastline smooths bays, keeping the sea inside them, while
#     cutting coastal ponds off headlands.
#
# What LSIB still drops is 3 remaining ocean blobs plus small patches a median of 24.9 km
# offshore, which is sea rather than coastal water.
TAIWAN_LAND_BOUNDARY: Final[str] = "USDOS/LSIB_SIMPLE/2017"
TAIWAN_LAND_BOUNDARY_FIELD: Final[str] = "country_na"
TAIWAN_LAND_BOUNDARY_VALUE: Final[str] = "Taiwan"

# Managed ground -- land people build on or farm -- used to drop seasonal-grade water that is
# really shadow or irrigation. One rule over two land classes, because both are the same mistake:
# a seasonal water detection on a managed surface reflects what people do to the ground, not a
# water body.
#
#   - Built-up: a 30 m pixel in a dense CBD picks up the shadow between towers. Taipei's urban core
#     came back with 204 ha of water over 30 km2, about 7x what its real park ponds hold, 71% of it
#     `seasonal` or `new seasonal`.
#   - Cropland: irrigated paddy floods on purpose. 74.7% of the water mapped over Yilan's plain sits
#     on cropland and only 8.6% on actual water, which is why that plain rendered as solid water.
#
# The split is not local to those two places. Island-wide, the permanent-grade transition classes
# sit 79.5% on WorldCover water (39,342 of 49,498 ha) -- they are water bodies -- while the
# seasonal-grade classes manage only 32.1% (27,357 of 85,101 ha), the rest being grass 15.2%,
# cropland 14.6%, tree 13.5% and built-up 9.3%.
#
# ESA WorldCover rather than a threshold on GSW's own quality bands, decided by measurement:
#
#   - `occurrence` and `recurrence` cannot separate the artefact from real seasonal water. Over
#     class 4/5 pixels, occurrence is p50=12% in Taipei against p50=20% on the Yilan paddy plain,
#     and recurrence p50=77% against p50=89% -- overlapping, with no clean cut.
#   - Managed ground separates them outright: 94% of Taipei's seasonal-class pixels are built-up
#     and 74.7% of Yilan's are cropland, against 5% in the Chiayi aquaculture belt and 13%/4.6% in
#     the Taoyuan pond belt. No `permanent`-class pixel is built-up in any region sampled, so the
#     rule cannot reach a real lake.
#
# A 2021 snapshot, so "managed" means today. That is why only the seasonal-grade classes are masked
# and the ones that say water *ended* are kept -- see water.MASK_ON_MANAGED_LAND.
WORLDCOVER_ASSET: Final[str] = "ESA/WorldCover/v200"
WORLDCOVER_MANAGED_CLASSES: Final[tuple[int, ...]] = (40, 50)  # cropland, built-up

# waterClass band values (JRC GSW YearlyHistory)
WATER_CLASS_NO_DATA: Final[int] = 0
WATER_CLASS_NOT_WATER: Final[int] = 1
WATER_CLASS_SEASONAL: Final[int] = 2
WATER_CLASS_PERMANENT: Final[int] = 3

# --- Extraction parameters --------------------------------------------------------------------
NATIVE_SCALE_M: Final[int] = 30  # Landsat-derived; both source datasets are 30 m

# Forest is "tree cover >= this percent in 2000". 30% is the Hansen convention.
TREECOVER_THRESHOLD_PCT: Final[int] = 30

# Minimum mapping unit, in PIXELS rather than hectares -- and that distinction is load-bearing.
#
# Chosen by measurement, not intuition: an earlier 0.5 ha guess would have discarded 18,759 of the
# 51,473 ha of tree-cover loss Hansen records for Taiwan 2001-2025, because loss here is dominated
# by small scattered patches (typhoon, landslide, selective plantation harvest) rather than large
# clearances. Island-wide retention by connected-component size, estimated from the raster before
# extraction -- these are the figures the threshold was chosen on:
#
#   >=1 px -> 100.0% retained    >=3 px -> 80.0%
#   >=2 px ->  89.2%  <- chosen  >=6 px -> 63.6%
#
# FOREST_RETAINED_PCT below is deliberately NOT taken from this table; it is re-measured from the
# extracted polygons, which land ~1 pp higher. The table justifies the choice, the constant
# describes the shipped data, and only the constant is quoted to users.
#
# Dropping isolated single pixels is defensible: they are the likeliest mixed-pixel and
# geolocation artefacts. Dropping anything larger is discarding signal.
#
# Why not express this as an area: Hansen is a 1/4000-degree product, so its pixels are ~27.8 m
# tall and ~25.5 m wide at Taiwan's latitude -- about 0.071 ha, not the 0.09 that "30 m" implies.
# A 0.18 ha threshold therefore demands 2.5 pixels and silently behaves as a 3-pixel filter, which
# is exactly what happened on the first run: 80.3% retained while the caveat claimed 89%.
# Counting pixels is latitude-independent and matches how the retention above was measured.
MIN_PATCH_PIXELS: Final[int] = 2

# True geodesic area of one Hansen pixel over Taiwan, measured from the quantization of extracted
# patch areas on the native grid. Varies ~0.070-0.072 ha between Kenting and Taipei. Used only to
# express the threshold in human units for the caveat; never for filtering.
TAIWAN_PIXEL_HA: Final[float] = 0.071

# Share of island-wide Hansen loss area that survives MIN_PATCH_PIXELS: 46,503 of 51,473 ha,
# 2001-2025 over TAIWAN_BBOX.
#
# Measured from the extracted polygons themselves, not from a pre-run raster estimate -- the two
# differ by ~1 pp because of how connected components resolve at the AOI edge, and the number the
# UI states as fact has to describe the data that actually shipped. Re-measure from the output
# whenever the threshold changes.
FOREST_RETAINED_PCT: Final[float] = 90.3

# Share of island-wide *baseline* forest area the cover layer draws on its first frame:
# 2,335,572 of 2,340,162 ha at >= TREECOVER_THRESHOLD_PCT canopy in HANSEN_BASELINE_YEAR, over
# TAIWAN_BBOX. The 4,590 ha dropped are baseline pixels the sieve removes -- 4,029 ha isolated in
# the source, and ~560 ha more left isolated once mapped loss is cut out of the open blocks (T-029).
#
# Measured raster-to-raster on Hansen's native grid, with `ee.Image.pixelArea()` on both sides:
# numerator = (baseline minus mapped loss, sieved) union (mapped loss); denominator = baseline.
# Not vector-over-raster, because the shipped polygons' `area_ha` sums a uniform 0.23% higher than
# the same pixels' pixelArea -- 46,503 vs 46,395 ha for loss, which is not gridded, as well as for
# cover -- so a ratio that mixes the two bases lands above 100% (100.03% on the T-029 run). Either
# basis is a share; mixing them is not. The previous constant, whatever its comment said, was the
# raster/raster figure too: it reproduces from the sieved raster (2,335,902) and not from the
# shipped vectors (2,341,516).
#
# Far higher than FOREST_RETAINED_PCT because the two sieve different things: loss is thousands of
# scattered small patches, so dropping isolated pixels costs ~10% of it, while the baseline is one
# near-continuous mass and the same rule costs 0.2%. Both figures are quoted to users, and quoting
# the loss number for the cover layer would understate its completeness by 10 pp.
#
# Re-measure whenever MIN_PATCH_PIXELS or TREECOVER_THRESHOLD_PCT changes, or the Hansen asset
# version bumps.
FOREST_COVER_RETAINED_PCT: Final[float] = 99.8

# Share of the water area that survives MIN_PATCH_PIXELS, measured on the ever-water raster
# (transition >= 1) clipped to TAIWAN_LAND_BOUNDARY: components of at least MIN_PATCH_PIXELS
# same-class pixels, against everything that actually reaches the sieve.
#
# The denominator is post-managed-land-mask (117,685 ha), not JRC's full 134,600 ha, so this and
# WATER_MANAGED_SEASONAL_DROPPED_PCT below describe two different cuts and do not double-count the
# same hectares. The caveat quotes them as two separate facts for the same reason -- and, because
# quoting only those two invites a reader to take this figure as the layer's completeness against
# the source, states WATER_SOURCE_RETAINED_PCT as well. Never describe this number as a share of
# what the source records: it is a share of what reaches the sieve.
#
# Measured per class region, not per water body, because that is what a feature now is: water.py
# segments on JRC's transition class, so the sieve applies to the class region and a large lake
# with a two-pixel fringe of a different class loses the fringe, not the lake.
#
# 103,175 of 117,685 ha. The first guess at this comment predicted a figure near
# FOREST_COVER_RETAINED_PCT's 99.8%, reasoning that water is one near-continuous mass rather than
# forest loss's scattered patches. Measuring says otherwise, and the reason is the segmentation
# itself: splitting on transition class turns every lake's seasonal fringe into its own thin region,
# so the sieve bites roughly as hard here as it does on forest loss. Sizing this by intuition would
# have overstated completeness by 11 points in a line quoted to users.
#
# Re-measure whenever MIN_PATCH_PIXELS or the segmentation changes -- it is quoted to users.
WATER_RETAINED_PCT: Final[float] = 87.7

# The layer's completeness against what JRC records: post-sieve change area over JRC's full
# classed water on Taiwan's land, 101,339 of 132,440 ha -- raster to raster, `pixelArea` on both
# sides at the source grid, island-wide connected components (T-031 / T-020). The previous 75.5
# divided the shipped vectors (101,567 ha) by a denominator taken from an old commit message
# (134,600 ha) that no probe had produced; measured, the denominator is 1.6% smaller. The shipped
# vectors sum ~0.2% above the same pixels' pixelArea, as forest's do, so the vector-over-raster
# figure would land at 76.7 -- either basis is a share, mixing them is not.
#
# Re-measure whenever MASK_ON_MANAGED_LAND, MIN_PATCH_PIXELS or the GSW asset changes.
WATER_SOURCE_RETAINED_PCT: Final[float] = 76.5

# Share of the shipped water layer that is JRC's `lost permanent` class alone -- water that
# vanished outright: 3,538 of 101,339 ha, raster to raster, post-sieve (T-031 / T-020, re-verified
# rather than carried forward; the shipped vectors give 3,547 of 101,567, the same 3.5). Stated
# because "loss" bundles four JRC classes and only this one is water that is gone.
#
# Re-measure whenever MASK_ON_MANAGED_LAND or MIN_PATCH_PIXELS changes.
WATER_LOST_PERMANENT_PCT: Final[float] = 3.5

# Share of the post-sieve change area dropped as undatable: a region whose class needs a measured
# year the yearly stack cannot give it -- an arrival never seen as water, an ending never seen as
# water, or an ending whose last water year is the record's last year, so the end itself was never
# observed. Dropped rather than dated from the record's edge, which would assert something the
# source never saw.
#
# Measured zero on the T-031 run: 0 of 133,701 post-sieve regions, GSW v1.4. JRC's two products
# agree on every region that survives the sieve, and no ending falls on 2021. The rule and the
# count stay, because an asset version bump is exactly when this stops being zero; `extract`
# prints the share whenever it is not, and the caveat quotes it.
WATER_UNDATABLE_DROPPED_PCT: Final[float] = 0.0

# Share of JRC's classed water area removed by the managed-land rule
# (water.MASK_ON_MANAGED_LAND): 4.7% on built-up ground plus 7.8% on cropland.
#
# Quoted because it is a deliberate deletion of source data, not a resolution limit: the layer
# shows less water than JRC does, and a reader is owed the size of that gap. Modest island-wide and
# very large locally -- Yilan's paddy plain keeps 24% of JRC's raw water where the Chiayi
# aquaculture belt keeps 98%. That asymmetry is the point, and is why the rule is spatial rather
# than a class drop, which would have cost 63% island-wide to fix the same places.
#
# Re-measure whenever MASK_ON_MANAGED_LAND or WORLDCOVER_ASSET changes.
WATER_MANAGED_SEASONAL_DROPPED_PCT: Final[float] = 12.6

# --- the water cover pass (T-030) ---------------------------------------------------------------
#
# Cover is JRC's yearly waterClass, run-length encoded per pixel: a shape is a stretch of years
# over which the same ground was water every year, drawn for exactly those years. Both figures
# below are in PIXEL-YEARS, not hectares -- a run is area x time, and a year boundary is a region
# boundary, so hectares would understate what the two rules cost.
#
# Measured island-wide over TAIWAN_LAND_BOUNDARY at the source grid (30 m), off the exact images
# the extraction segments on (`cover_states` / `cover_runs`), GSW v1.4 1984-2021. 39,632,802
# water pixel-years in all; 3,512,251 run starts; at most 13 runs on one pixel. Run lengths:
# one year 20.4% of runs but 1.8% of pixel-years; six years or more 52.4% of runs and 90.5% of
# pixel-years -- the layer is mostly long-lived water, the churn is in the count of shapes, not
# the area-time. Water at `transition == 0` (a flicker JRC never classed) is 0.20% of pixel-years,
# so cover is not gated on the transition band. Re-measure whenever MASK_ON_MANAGED_LAND,
# MIN_PATCH_PIXELS or the GSW asset changes.

# Share of the water pixel-years behind the cover layer that were carried from the nearest
# observed year rather than seen: 6,131,787 of 39,632,802. `waterClass == WATER_CLASS_NO_DATA`
# is a year GSW could not classify, not a dry one, and Taiwan's record is 100% blind in 1985 and
# mostly blind before 1988. A blind year takes the last observation before it, else the first
# after it (`impute_nearest`). One water-year in six on this layer is inferred, and the caveat
# says so.
WATER_COVER_IMPUTED_PCT: Final[float] = 15.5

# Share of water pixel-years (post managed-land rule) that survive the same-run MIN_PATCH_PIXELS
# sieve: 29,871,265 of 39,632,802. Far below WATER_RETAINED_PCT's 87.7%, and expected to be:
# segmenting by (from, to) makes every year boundary a region boundary, so a two-pixel pond whose
# halves dried a year apart is two single-pixel runs and drops out, where the change pass saw one
# two-pixel region and kept it. Nearly a quarter of the layer's water-years are in runs too small
# to map on their own; the change layer still carries the pixels, dated by class.
WATER_COVER_RETAINED_PCT: Final[float] = 75.4

M2_PER_HA: Final[float] = 10_000.0

# --- Tiling: the two regimes (T-036) ------------------------------------------------------------
#
# From DETAIL_ZOOM up, a tile holds every feature exactly as extracted -- its id, its metric,
# nothing pooled, count-verified. Below it, a tile holds one feature per cohort layer and
# attribute group, and patches smaller than a screen pixel are pooled into squares of the same
# total area (tippecanoe's tiny-polygon reduction). At the island view (z7) a 30 m patch is a
# quarter of a pixel and a z7 tile carried ~400k of them; parsing that was the whole of the
# opening view's wait after T-034.
#
# 11 is where the web's `SCALE_SPLIT_ZOOM` says a patch's fill becomes visible, and it is the
# lowest zoom at which the pooling threshold cannot reach a real patch: a MIN_PATCH_PIXELS patch
# is ~18 tile units² at z10 and ~72 at z11 against TINY_POLYGON_SIZE² = 36, measured at the AOI's
# southern edge where a unit is widest (`tiles.detail_floor_units2`). `tiles.build` refuses to run
# if that floor ever comes within DETAIL_FLOOR_MARGIN of the threshold.
DETAIL_ZOOM: Final[int] = 11

# tippecanoe pools polygons under this many tile units *squared* (its --tiny-polygon-size). 6 is
# the largest its docs call artefact-free; 2, the default, would leave everything from z8 up
# unpooled (a 2-pixel patch is 1.2 units² at z8, 4.5 at z9, 18 at z10).
TINY_POLYGON_SIZE: Final[int] = 6

# How far above the pooling threshold the smallest real patch must sit at DETAIL_ZOOM. Covers the
# pixel's 0.070-0.072 ha spread across the island and rounding in the projection.
DETAIL_FLOOR_MARGIN: Final[float] = 1.5

# --- Output -----------------------------------------------------------------------------------
# 4: a third kind of state, `level`, with `level:S-E` tile layers and a per-domain `measure`.
# 3: two regimes split at `tiles.detailZoom` -- pooled below it, exact from it up (T-036).
# 2: one tile layer per cohort (`tiles.sourceLayers`) rather than one named for the domain.
MANIFEST_VERSION: Final[int] = 4

# Domain identity hues (A2). Hue names the domain, and every state -- cover, change, a level's
# whole ramp -- is a transform of it in the web's colors.ts. The budget is small and spent with
# care: the basemap is drawn without blue or green so those can mean water and forest, which is
# also why rainfall cannot simply be blue or NDVI green (docs/adding-a-domain.md). Temperature
# takes the heat red the proposal set aside for climate; population takes gold. Level domains are
# shown one at a time, so their two ramps never share the screen.
DOMAIN_HUES: Final[dict[str, str]] = {
    "water": "#2563eb",
    "forest": "#15803d",
    "temperature": "#dc2626",
    "population": "#eab308",
}


def bbox_to_ee_geometry(bbox: tuple[float, float, float, float]):
    """Build an ee.Geometry.Rectangle from a (west, south, east, north) tuple.

    Imported lazily so that config stays importable -- and testable -- without authenticating to
    Earth Engine.
    """
    import ee

    return ee.Geometry.Rectangle(list(bbox), proj="EPSG:4326", geodesic=False)
