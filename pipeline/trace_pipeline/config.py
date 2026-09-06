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

# Share of island-wide *baseline* forest area that survives MIN_PATCH_PIXELS: 2,335,902 of
# 2,340,266 ha at >= TREECOVER_THRESHOLD_PCT canopy in HANSEN_BASELINE_YEAR, over TAIWAN_BBOX.
#
# Far higher than FOREST_RETAINED_PCT because the two sieve different things: loss is thousands of
# scattered small patches, so dropping isolated pixels costs ~10% of it, while the baseline is one
# near-continuous mass and the same rule costs 0.2%. Both figures are quoted to users, and quoting
# the loss number for the extent layer would understate the extent layer's completeness by 10 pp.
FOREST_EXTENT_RETAINED_PCT: Final[float] = 99.8

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
# FOREST_EXTENT_RETAINED_PCT's 99.8%, reasoning that water is one near-continuous mass rather than
# forest loss's scattered patches. Measuring says otherwise, and the reason is the segmentation
# itself: splitting on transition class turns every lake's seasonal fringe into its own thin region,
# so the sieve bites roughly as hard here as it does on forest loss. Sizing this by intuition would
# have overstated completeness by 11 points in a line quoted to users.
#
# Re-measure whenever MIN_PATCH_PIXELS or the segmentation changes -- it is quoted to users.
WATER_RETAINED_PCT: Final[float] = 87.7

# Share of the water area JRC records for Taiwan that survives *both* cuts -- the managed-land rule
# and the mapping floor -- and so reaches the map. The one number a reader needs to judge the
# layer's completeness, and the one neither constant above states on its own: WATER_RETAINED_PCT is
# 87.7% of a post-mask denominator, which is 76.7% of the source, not 87.7% of it.
#
# 101,567 of 134,600 ha, the shipped vector total against JRC's classed water. Arithmetic over two
# recorded measurements rather than its own probe, so it is the figure to confirm first on the next
# full run. It is deliberately the *vector* total and not the 103,175 ha post-sieve raster figure
# behind WATER_RETAINED_PCT: the ~1.6% between them is lost to vectorizing, cell edges and the
# undatable regions water.extract drops, and a completeness figure quoted to users has to describe
# what they actually get rather than what survived one intermediate step.
#
# Quoted to one decimal, unlike WATER_RETAINED_PCT: 75.46% stored as 75.5 and then rendered whole
# would round twice and reach the reader as 76%, overstating completeness by half a point on a
# formatting artefact. Any figure that lands near a .5 boundary gets the decimal.
#
# Re-measure whenever either cut above changes.
WATER_SOURCE_RETAINED_PCT: Final[float] = 75.5

# Share of the water layer's area that is permanent water which disappeared outright -- JRC's
# `lost permanent` class alone, 3,547 of 101,567 ha.
#
# Quoted because `loss` paints about a third of this layer red, and a third of Taiwan's water did
# not vanish. That red bundles four different JRC classes: water that was only ever ephemeral,
# seasonal water that went, permanent water that dropped to seasonal but is still there, and only
# then permanent water that actually went. Stating the threshold without this composition would let
# a reader take the whole third as disappearance -- the same failure mode the forest caveat's
# retained-percentage rule exists to prevent.
#
# The numerator is untouched by the managed-land rule (class 3 is kept, and T-019 measured every
# non-masked class unchanged to the hectare) but the *denominator* is not: this read 3.0 against
# T-017's 117,204 ha layer and was carried through T-018 and T-019 while they cut the layer to
# 101,567 ha, so the share it states had drifted low by half a point. Recomputed from those two
# recorded figures rather than re-probed, hence the extra decimal in the caveat -- 3.5 is close
# enough to the .0f rounding boundary that quoting it whole would flip between 3% and 4% on noise.
#
# The per-class composition that used to sit in this comment was measured on the same stale
# denominator and two of its classes (9 and 10) are cut by the managed-land rule, so it is not
# rescalable and has been dropped rather than restated wrongly. Re-measure it, and this, on the
# next full run -- and whenever MASK_ON_MANAGED_LAND changes, since that moves the denominator.
WATER_LOST_PERMANENT_PCT: Final[float] = 3.5

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

M2_PER_HA: Final[float] = 10_000.0

# --- Output -----------------------------------------------------------------------------------
MANIFEST_VERSION: Final[int] = 1

# Domain identity hues (A2). Extent = domain hue; loss = the universal change signal, which lives
# in the web app's colors.ts because it is cross-domain by definition.
DOMAIN_HUES: Final[dict[str, str]] = {
    "water": "#2563eb",
    "forest": "#15803d",
}


def bbox_to_ee_geometry(bbox: tuple[float, float, float, float]):
    """Build an ee.Geometry.Rectangle from a (west, south, east, north) tuple.

    Imported lazily so that config stays importable -- and testable -- without authenticating to
    Earth Engine.
    """
    import ee

    return ee.Geometry.Rectangle(list(bbox), proj="EPSG:4326", geodesic=False)
