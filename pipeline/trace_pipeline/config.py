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

# waterClass band values (JRC GSW YearlyHistory)
WATER_CLASS_NO_DATA: Final[int] = 0
WATER_CLASS_NOT_WATER: Final[int] = 1
WATER_CLASS_SEASONAL: Final[int] = 2
WATER_CLASS_PERMANENT: Final[int] = 3

# --- Extraction parameters --------------------------------------------------------------------
NATIVE_SCALE_M: Final[int] = 30  # Landsat-derived; both source datasets are 30 m

# Forest is "tree cover >= this percent in 2000". 30% is the Hansen convention.
TREECOVER_THRESHOLD_PCT: Final[int] = 30

# Minimum mapping unit. Below ~5 pixels (0.45 ha at 30 m) a patch is mostly edge effect, and
# keeping it would inflate polygon counts without adding signal. This threshold is also what the
# per-layer resolution caveat in the UI reports, so the honest claim and the code agree.
MIN_PATCH_HA: Final[float] = 0.5

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
