"""The level helpers, and a synthetic measured domain run through the whole pipeline.

The end-to-end test is what proves the spine takes a new kind of state without a per-domain
branch anywhere: a grid domain with no Earth Engine goes extract -> tiles -> verify -> manifest
through the same code water and forest do. It needs tippecanoe and is skipped where there is none
(CI), like every other test that would have to build an archive.
"""

import json
import shutil

import geopandas as gpd
import pytest
import shapely

from trace_pipeline import config, extract, levels, manifest, schema, tiles
from trace_pipeline.domains import base

TWD97 = "EPSG:3826"  # TWD97 / TM2 zone 121: metres, the grid CRS a Taiwanese source is likely in

#: An origin in central Taiwan, in TWD97 metres.
X0, Y0 = 250_000.0, 2_620_000.0


def grid(values: list[list[float | None]], spacing: float = 1000.0, **extra_columns):
    """A GeoDataFrame of cells from rows of values, top row first. `None` is a missing cell."""
    xs, ys, vs = [], [], []
    for row, line in enumerate(values):
        for col, value in enumerate(line):
            xs.append(X0 + col * spacing)
            ys.append(Y0 - row * spacing)
            vs.append(float("nan") if value is None else value)
    frame = gpd.GeoDataFrame(
        {"value": vs, **extra_columns}, geometry=levels.grid_cells(xs, ys, spacing, TWD97)
    )
    return frame.set_crs(TWD97, allow_override=True)


# --- banding -----------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,band",
    [(-5.0, 0), (-1.0, 1), (-0.99, 1), (0.0, 3), (0.49, 3), (1.5, 6), (40.0, 6)],
)
def test_a_value_on_a_break_belongs_to_the_band_above(value, band):
    assert levels.band_of(value, (-1.0, -0.5, 0.0, 0.5, 1.0, 1.5)) == band


@pytest.mark.parametrize("value", [float("nan"), float("inf")])
def test_a_missing_value_is_never_given_a_band(value):
    with pytest.raises(ValueError, match="non-finite"):
        levels.band_of(value, (0.0,))


# --- cells -------------------------------------------------------------------------------------


def test_neighbouring_cells_share_an_edge_exactly():
    """If they did not, the union would keep them apart or leave a sliver between them."""
    cells = levels.grid_cells([X0 + 0.1, X0 + 1000.1], [Y0, Y0], 1000.0, TWD97)
    merged = shapely.union_all(cells.values)
    assert merged.geom_type == "Polygon"
    assert merged.area == pytest.approx(2_000_000.0)


# --- dissolving --------------------------------------------------------------------------------

LOW, HIGH = 0.2, 0.8  # either side of the one break at 0.5

#  L L H
#  L H H
#  H . L     (. is a missing cell)
LAYOUT = [[LOW, LOW, HIGH], [LOW, HIGH, HIGH], [HIGH, None, LOW]]


def test_same_band_cells_merge_into_connected_regions():
    regions = levels.dissolve_grid(grid(LAYOUT), "value", (0.5,))
    by_band = sorted((r.band, r.cells) for r in regions)
    # Low: the three top-left cells, and the lone bottom-right one. High: the three that touch
    # along edges, and the bottom-left one, which meets them only at a corner.
    assert by_band == [(0, 1), (0, 3), (1, 1), (1, 3)]


def test_a_missing_cell_is_a_gap_not_a_value():
    regions = levels.dissolve_grid(grid(LAYOUT), "value", (0.5,))
    assert sum(r.cells for r in regions) == 8


def test_regions_are_in_lon_lat_and_measured_on_the_ellipsoid():
    regions = levels.dissolve_grid(grid(LAYOUT), "value", (0.5,))
    for region in regions:
        west, south, east, north = region.geometry.bounds
        assert 120 < west < east < 122 and 23 < south < north < 25
        # A 1 km cell is 100 ha; TM2 distorts area by well under a percent here.
        assert region.area_ha == pytest.approx(100.0 * region.cells, rel=0.01)


def test_a_regions_value_is_the_area_weighted_mean_of_its_cells():
    frame = grid([[0.1, 0.3], [None, None]], absolute=[20.0, 22.0, 0.0, 0.0])
    (region,) = levels.dissolve_grid(frame, "value", (0.5,), carry=("absolute",))
    assert region.means["value"] == pytest.approx(0.2, rel=1e-3)
    assert region.means["absolute"] == pytest.approx(21.0, rel=1e-3)


def test_a_carried_value_is_averaged_over_the_cells_that_have_it():
    """Regression: a sum that skipped the gap but divided by both cells halved the value."""
    frame = grid([[0.1, 0.3]], absolute=[20.0, float("nan")])
    (region,) = levels.dissolve_grid(frame, "value", (0.5,), carry=("absolute",))
    assert region.means["absolute"] == pytest.approx(20.0)


def test_a_carried_value_missing_everywhere_is_absent_not_zero():
    frame = grid([[0.1, 0.3]], absolute=[float("nan"), float("nan")])
    (region,) = levels.dissolve_grid(frame, "value", (0.5,), carry=("absolute",))
    assert "absolute" not in region.means
    assert region.means["value"] == pytest.approx(0.2, rel=1e-3)


def test_area_does_not_cancel_between_parts_wound_opposite_ways():
    """Regression: pyproj sums signed rings, so two equal squares wound opposite ways were 0 ha."""
    from shapely.geometry import MultiPolygon, Polygon
    from shapely.geometry.polygon import orient

    a = Polygon([(121.0, 24.0), (121.01, 24.0), (121.01, 24.01), (121.0, 24.01)])
    b = Polygon([(121.02, 24.0), (121.03, 24.0), (121.03, 24.01), (121.02, 24.01)])
    both = MultiPolygon([orient(a, 1.0), orient(b, -1.0)])
    assert levels.geodesic_area_ha(both) == pytest.approx(
        levels.geodesic_area_ha(a) + levels.geodesic_area_ha(b)
    )
    # And a hole still subtracts, whichever way it was wound.
    holed = Polygon(a.exterior.coords, [[(121.002, 24.002), (121.004, 24.002), (121.004, 24.004)]])
    assert levels.geodesic_area_ha(holed) < levels.geodesic_area_ha(a)


def test_an_empty_year_dissolves_to_nothing():
    assert levels.dissolve_grid(grid([[None, None]]), "value", (0.5,)) == []


# --- the feature -------------------------------------------------------------------------------


def test_a_level_feature_is_one_valid_year_with_its_area():
    (region, *_) = levels.dissolve_grid(grid([[LOW]]), "value", (0.5,))
    feature = levels.level_feature(
        domain="temperature",
        year=2013,
        geometry=region.geometry,
        band=region.band,
        metric={"temp_anomaly_c": 0.2},
        source="synthetic",
        method="test",
        confidence=0.8,
    )
    schema.validate(schema.feature_collection([feature]))
    props = feature["properties"]
    assert (props["valid_from"], props["valid_to"], props["band"]) == (2013, 2014, 0)
    assert props["metric"]["area_ha"] == pytest.approx(100.0, rel=0.01)


# --- the whole pipeline, for a domain with no Earth Engine ---------------------------------------

YEARS = (2019, 2021)
BREAKS = (0.0, 0.5)


class SyntheticGrid(base.Domain):
    """A 4x4 grid of 5 km cells over three years, warming from one band into the next."""

    id = "temperature"  # borrows a real hue; the registry is not touched
    label = {"en": "Synthetic grid", "zh": "測試網格"}
    needs_earth_engine = False
    change_types = ("level",)
    measure = base.Measure(
        key="temp_anomaly_c", unit="°C", label={"en": "Anomaly", "zh": "距平"}, breaks=BREAKS
    )

    @property
    def source(self):
        return base.SourceInfo(
            name="synthetic", version="0", attribution="test", citation="-", licence="-"
        )

    @property
    def caveat(self):
        return "A test grid."

    def temporal_range(self):
        return YEARS

    def extract(self, aoi):
        assert aoi == config.TAIWAN_BBOX
        features = []
        for year in range(YEARS[0], YEARS[1] + 1):
            warming = (year - YEARS[0]) * 0.3
            values = [[-0.2 + warming + 0.1 * col for col in range(4)] for _row in range(4)]
            frame = grid(values, spacing=5000.0)
            for region in levels.dissolve_grid(frame, "value", BREAKS):
                features.append(
                    levels.level_feature(
                        domain=self.id,
                        year=year,
                        geometry=region.geometry,
                        band=region.band,
                        metric={"temp_anomaly_c": round(region.means["value"], 3)},
                        source="synthetic",
                        method="test",
                        confidence=0.8,
                    )
                )
        return schema.feature_collection(features)


@pytest.mark.skipif(
    not all(shutil.which(t) for t in ("tippecanoe", "tippecanoe-decode", "pmtiles")),
    reason="building an archive needs tippecanoe, tippecanoe-decode and pmtiles",
)
def test_a_measured_domain_goes_through_the_whole_pipeline(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(extract, "DATA_DIR", tmp_path)
    domain = SyntheticGrid()

    written = extract.run(domain, config.TAIWAN_BBOX)
    features = json.loads(written.read_text())["features"]
    assert {f["properties"]["change_type"] for f in features} == {"level"}

    archive = tiles.build(domain)

    layers = tiles.source_layers_in(archive)
    assert layers and all(layer.startswith("level:") for layer in layers)
    # One leaf per year -- a level never reaches an inner node of the tree.
    assert set(layers) == {f"level:{y}-{y + 1}" for y in range(YEARS[0], YEARS[1] + 1)}

    # The island regime keeps the band on every pooled feature: it is what colours them.
    island = list(tiles.decoded_features(archive, 7))
    assert island and all(
        "band" in f["properties"] and "metric" not in f["properties"] for *_, f in island
    )

    out = capsys.readouterr().out
    assert "of the level area that went in" in out

    entry = manifest.build([domain])["domains"][0]
    assert entry["changeTypes"] == ["level"]
    assert entry["measure"]["breaks"] == list(BREAKS)
    assert entry["tiles"]["sourceLayers"] == list(layers)
