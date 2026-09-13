"""Guards on the constants everything else derives from.

These are cheap, but they catch the class of error that is expensive later: a bbox typo that
silently clips half the island out of every export, or a threshold that drifts away from the
caveat text the UI shows.
"""

import pytest

from trace_pipeline import config

# Places that must fall inside the area of interest. Taoyuan is the v1 hero story (the 埤塘
# ponds); Penghu is the reason the bbox reaches west of the main island.
LANDMARKS = {
    "Taipei": (121.565, 25.033),
    "Kaohsiung": (120.302, 22.627),
    "Taoyuan ponds": (121.216, 24.993),
    "Hualien": (121.601, 23.991),
    "Kenting (southern tip)": (120.798, 21.947),
    "Penghu": (119.566, 23.570),
}


def test_bbox_is_well_formed():
    west, south, east, north = config.TAIWAN_BBOX
    assert west < east, "west must be less than east"
    assert south < north, "south must be less than north"


@pytest.mark.parametrize("name,lon,lat", [(k, *v) for k, v in LANDMARKS.items()])
def test_bbox_covers_landmark(name, lon, lat):
    west, south, east, north = config.TAIWAN_BBOX
    assert west <= lon <= east, f"{name} lon {lon} outside bbox"
    assert south <= lat <= north, f"{name} lat {lat} outside bbox"


def test_outlying_bbox_is_a_superset():
    w1, s1, e1, n1 = config.TAIWAN_BBOX
    w2, s2, e2, n2 = config.TAIWAN_BBOX_WITH_OUTLYING
    assert w2 <= w1 and s2 <= s1 and e2 >= e1 and n2 >= n1


def test_outlying_bbox_reaches_kinmen_and_matsu():
    """The only reason this variant exists -- if it does not cover them, it is misnamed."""
    west, south, east, north = config.TAIWAN_BBOX_WITH_OUTLYING
    for name, (lon, lat) in {"Kinmen": (118.32, 24.43), "Matsu": (119.95, 26.16)}.items():
        assert west <= lon <= east and south <= lat <= north, f"{name} outside outlying bbox"


def test_hansen_loss_years_match_band_encoding():
    """lossyear encodes 1..N as 2001..2000+N. The asset id claims 2025, so N must be 25."""
    span = config.HANSEN_LAST_LOSS_YEAR - config.HANSEN_FIRST_LOSS_YEAR + 1
    assert span == 25
    assert config.HANSEN_FIRST_LOSS_YEAR == config.HANSEN_BASELINE_YEAR + 1
    assert str(config.HANSEN_LAST_LOSS_YEAR) in config.HANSEN_ASSET


def test_water_class_values_are_distinct_and_ordered():
    values = [
        config.WATER_CLASS_NO_DATA,
        config.WATER_CLASS_NOT_WATER,
        config.WATER_CLASS_SEASONAL,
        config.WATER_CLASS_PERMANENT,
    ]
    assert values == [0, 1, 2, 3], "JRC GSW waterClass encoding changed -- check the catalog"


def test_gsw_fallback_range_is_shorter_than_the_preferred_one():
    assert config.GSW_V14_LAST_YEAR < config.GSW_V15_LAST_YEAR
    assert config.GSW_FIRST_YEAR < config.GSW_V14_LAST_YEAR


def test_min_patch_drops_only_isolated_single_pixels():
    """Exactly 2 pixels, measured rather than assumed.

    Taiwan's Hansen loss is small scattered patches, so this threshold decides how much of the
    data the map may show at all. At 6 px an earlier guess discarded 18,759 of 51,473 ha. Anything
    above 2 px discards signal, not noise -- so this is pinned, not a range.
    """
    assert config.MIN_PATCH_PIXELS == 2, (
        "changing this changes how much measured loss the map reports; re-measure retention and "
        "update FOREST_RETAINED_PCT with it"
    )


def test_threshold_is_a_pixel_count_not_an_area():
    """The distinction is load-bearing, so guard against a well-meaning revert to hectares.

    A Hansen pixel over Taiwan is ~0.071 ha, not the nominal 0.09, so an area threshold rounds up
    to the next whole pixel and silently drops a band of real data -- it cost a full re-run.
    """
    assert isinstance(config.MIN_PATCH_PIXELS, int)
    assert not hasattr(config, "MIN_PATCH_HA"), (
        "MIN_PATCH_HA was removed deliberately -- filter on MIN_PATCH_PIXELS instead"
    )


def test_true_pixel_area_is_smaller_than_the_nominal_one():
    """The whole reason the threshold counts pixels. If these ever match, re-derive the constant."""
    nominal_ha = (config.NATIVE_SCALE_M**2) / config.M2_PER_HA  # 0.09 at a notional 30 m
    assert nominal_ha > config.TAIWAN_PIXEL_HA
    # Hansen's native grid is 1/4000 degree: ~27.8 m tall, ~25.5 m wide at these latitudes.
    assert 0.068 <= config.TAIWAN_PIXEL_HA <= 0.074


def test_retained_percentage_is_plausible_for_the_threshold():
    """The caveat quotes this figure as fact, so it must not drift away from the threshold."""
    assert 0 < config.FOREST_RETAINED_PCT <= 100
    # At >=2 px, measured from the extracted polygons, the value is 90.3%. A wildly different
    # number here means someone moved the threshold without re-measuring.
    assert 85 <= config.FOREST_RETAINED_PCT <= 95


def test_loss_dated_at_the_record_start_is_a_share_of_loss_not_of_the_layer():
    """The two readings of this figure differ by a factor of three and only one is the point.

    The same hectares are 70.9% of the layer's loss area and 24.1% of the whole layer. The caveat
    is about what the first frame of the timeline shows a reader, so it is the loss share that
    belongs there; quoting the layer share would understate it into looking negligible -- the
    failure mode the retained-percentage rule exists to prevent, pointed the other way.
    """
    assert 0 < config.WATER_LOSS_DATED_AT_START_PCT <= 100
    # Measured at 70.9%. Anything near 24 means someone swapped in the share-of-layer figure.
    assert 60 <= config.WATER_LOSS_DATED_AT_START_PCT <= 80


def test_most_of_the_loss_layer_is_not_water_that_vanished():
    """Two separate cuts through the same red, and the caveat needs both to be honest about it:
    only a few percent of the layer is permanent water that actually disappeared, while most of
    the loss is dated to the record's start rather than to the year the water went."""
    assert config.WATER_LOST_PERMANENT_PCT < config.WATER_LOSS_DATED_AT_START_PCT


def test_every_hue_is_a_hex_colour():
    for domain_id, hue in config.DOMAIN_HUES.items():
        assert hue.startswith("#") and len(hue) == 7, f"{domain_id} hue {hue!r} is not #rrggbb"


def test_land_boundary_is_configured_with_the_filter_it_needs():
    """The id alone is not enough -- the collection is global and has to be filtered to Taiwan."""
    assert config.TAIWAN_LAND_BOUNDARY
    assert config.TAIWAN_LAND_BOUNDARY_FIELD
    assert config.TAIWAN_LAND_BOUNDARY_VALUE == "Taiwan"
