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


def test_min_patch_is_a_few_pixels_at_native_scale():
    """The UI caveat says "under ~0.5 ha may be missed" -- keep code and claim aligned."""
    pixel_ha = (config.NATIVE_SCALE_M**2) / config.M2_PER_HA  # 0.09 ha at 30 m
    pixels = config.MIN_PATCH_HA / pixel_ha
    assert 3 <= pixels <= 12, f"MIN_PATCH_HA is {pixels:.1f} pixels -- suspiciously far from ~5"


def test_every_hue_is_a_hex_colour():
    for domain_id, hue in config.DOMAIN_HUES.items():
        assert hue.startswith("#") and len(hue) == 7, f"{domain_id} hue {hue!r} is not #rrggbb"
