"""What every level domain shares: classing a value, dissolving a grid, building the feature.

A level is a measured value held for one year -- a cell's temperature anomaly, a township's
population density -- classed into its domain's fixed bands (`Domain.measure`). The web colours a
level by its band and quotes its value, so the two things a domain must get right are the class
and the number; this module owns both, so no measured domain re-derives them.

A grid is drawn as regions, not cells: `dissolve_grid` merges one year's same-band cells into
connected polygons and gives each the area-weighted mean of the values it covers. A 1 km grid of
Taiwan is ~36,000 cells a year and the map has nothing to say about a boundary between two cells
in the same band, so dissolving costs no information the map can show, and the readout still
quotes a measured mean rather than a band's midpoint.

No raster library: a grid arrives as cell centres and a spacing, which is enough to build the
cells as polygons, and shapely unions them. That keeps GDAL out of the pipeline for the price of
holding one year of cells in memory -- a few tens of thousands of squares.
"""

from __future__ import annotations

import bisect
import math
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from trace_pipeline import config, schema

#: Coordinates are snapped to this fraction of the grid spacing before cells are unioned. Two
#: neighbouring cells computed as `centre ± spacing / 2` can disagree on their shared edge in the
#: last bit, and the union then leaves a sliver between them or fails to merge them at all.
_SNAP_FRACTION = 1e-6


def band_of(value: float, breaks: Sequence[float]) -> int:
    """The band a value falls in: 0 below the first break, `len(breaks)` from the last one up.

    A value equal to a break belongs to the band above it, so the bands are `[b_i, b_{i+1})` --
    the same half-open convention as the time intervals, and the one the legend states.
    """
    if not math.isfinite(value):
        raise ValueError(f"cannot class a non-finite value ({value!r}) into a band")
    return bisect.bisect_right(breaks, value)


def geodesic_area_ha(geometry: Any) -> float:
    """True area of a lon/lat geometry on the WGS84 ellipsoid, in hectares.

    The same measure `tiles.verify` sums the island tiles with, so a level's `area_ha` and the
    archive's retained-area check are in the same units by construction.

    Oriented first. pyproj sums *signed* ring areas, so a multipolygon whose parts are wound in
    opposite directions -- which a shapefile, a union and a reprojection are each free to produce
    -- cancels itself toward zero, and a density divided by that area is off by any factor at
    all. Exteriors counter-clockwise and holes clockwise make every part add and every hole
    subtract.
    """
    import shapely
    from pyproj import Geod

    oriented = shapely.orient_polygons(geometry, exterior_cw=False)
    area_m2, _perimeter = Geod(ellps="WGS84").geometry_area_perimeter(oriented)
    return abs(area_m2) / config.M2_PER_HA


@dataclass(frozen=True)
class Region:
    """One connected same-band part of a grid in one year, in lon/lat."""

    geometry: Any
    band: int
    area_ha: float
    #: Area-weighted mean of each value column over the region's cells that have one. A carried
    #: column missing from every cell of the region is absent here -- never a 0.
    means: Mapping[str, float]
    cells: int


def grid_cells(
    xs: Sequence[float], ys: Sequence[float], spacing: float, crs: str
) -> Any:  # geopandas.GeoSeries
    """Square cells of side `spacing` centred on each `(x, y)`, in the grid's own CRS."""
    import geopandas as gpd
    import numpy as np
    import shapely

    half = spacing / 2
    x = np.asarray(xs, dtype=float)
    y = np.asarray(ys, dtype=float)
    boxes = shapely.box(x - half, y - half, x + half, y + half)
    return gpd.GeoSeries(shapely.set_precision(boxes, spacing * _SNAP_FRACTION), crs=crs)


def dissolve_grid(
    cells: Any,  # geopandas.GeoDataFrame
    key: str,
    breaks: Sequence[float],
    carry: Sequence[str] = (),
) -> list[Region]:
    """Merge one year's same-band cells into connected regions, in EPSG:4326.

    `cells` holds one row per cell: a square geometry in any projected or geographic CRS (see
    :func:`grid_cells`), the measured value in column `key`, and any further numeric columns
    named in `carry` -- the absolute temperature beside the anomaly, say. A cell whose `key` is
    missing is left out: a gap in the source is shown as a gap, never filled. A carried value is
    averaged over the cells that have it, and left out of `means` for a region where none do: a
    sum that skipped the gaps but divided by every cell would halve a value, and a region with no
    value would report 0.

    Cells are unioned in their own CRS, where neighbours share edges exactly, and only the
    regions are reprojected. Regions are 4-connected: cells meeting at a corner alone are two
    regions. Each region's means are weighted by the cells' true areas, which differ with latitude
    on a lon/lat grid.
    """
    import geopandas as gpd
    import shapely

    columns = [key, *(c for c in carry if c != key)]
    present = cells[cells[key].notna()].copy()
    if present.empty:
        return []

    present["_band"] = [band_of(float(v), breaks) for v in present[key]]
    present["_area_ha"] = [
        geodesic_area_ha(g) for g in present.geometry.to_crs("EPSG:4326").geometry
    ]

    regions: list[Region] = []
    for band, group in present.groupby("_band", sort=True):
        merged = shapely.union_all(group.geometry.values)
        parts = gpd.GeoSeries(shapely.get_parts(merged), crs=cells.crs)

        # Which region each cell fell into, by a point inside the cell -- robust where a corner
        # touch splits two regions that share a vertex.
        anchors = gpd.GeoDataFrame(
            group[[*columns, "_area_ha"]],
            geometry=group.geometry.representative_point(),
            crs=cells.crs,
        )
        owners = gpd.sjoin(
            anchors, gpd.GeoDataFrame(geometry=parts, crs=cells.crs), predicate="within"
        )

        lonlat = parts.to_crs("EPSG:4326")
        for index, members in owners.groupby("index_right", sort=True):
            means: dict[str, float] = {}
            for column in columns:
                measured = members[column].notna()
                weight = members.loc[measured, "_area_ha"]
                if weight.sum() > 0:
                    values = members.loc[measured, column]
                    means[column] = float((values * weight).sum() / weight.sum())
            geometry = lonlat.iloc[int(index)]
            regions.append(
                Region(
                    geometry=geometry,
                    band=int(band),
                    area_ha=geodesic_area_ha(geometry),
                    means=means,
                    cells=len(members),
                )
            )
    return regions


def level_feature(
    *,
    domain: str,
    year: int,
    geometry: Any,
    band: int,
    metric: Mapping[str, float],
    source: str,
    method: str,
    confidence: float,
    subtype: str | None = None,
    id: str | int | None = None,
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """A validated GeoJSON level feature for one year: `[year, year + 1)`.

    `geometry` is a shapely geometry in lon/lat. `area_ha` is measured here and added to the
    metric unless the caller supplied one, because the island tiles are verified by area and a
    level without it would be a region the check cannot see.
    """
    from shapely.geometry import mapping

    measured = dict(metric)
    measured.setdefault("area_ha", round(geodesic_area_ha(geometry), 4))
    return schema.TraceFeature(
        domain=domain,
        valid_from=year,
        valid_to=year + 1,
        change_type="level",
        metric=measured,
        source=source,
        method=method,
        confidence=confidence,
        subtype=subtype,
        band=band,
        id=id,
        extra=extra or {},
    ).to_geojson_feature(mapping(geometry))
