"""Forest domain tests.

Nothing here talks to Earth Engine. The valuable logic is the band-value arithmetic and the
feature assembly -- an off-by-one in the year mapping would shift every loss patch by a year and
produce a map that looks entirely plausible, which is exactly the kind of bug a live API call
would not catch anyway.
"""

import pytest

from trace_pipeline import config, schema
from trace_pipeline.domains import base, forest

SQUARE = {
    "type": "Polygon",
    "coordinates": [[[121.21, 24.99], [121.22, 24.99], [121.22, 25.0], [121.21, 24.99]]],
}


# --- the year encoding ---------------------------------------------------------------------


@pytest.mark.parametrize("band_value,calendar", [(1, 2001), (13, 2013), (25, 2025)])
def test_band_value_maps_to_calendar_year(band_value, calendar):
    assert forest.loss_year_to_calendar(band_value) == calendar


@pytest.mark.parametrize("calendar", [2001, 2013, 2025])
def test_calendar_year_maps_back_to_band_value(calendar):
    assert forest.loss_year_to_calendar(forest.calendar_to_loss_year(calendar)) == calendar


def test_the_two_endpoints_match_the_configured_range():
    """Ties the mapping to config, so a catalog bump to v1.14 cannot silently desync them."""
    first, last = forest.ForestDomain().temporal_range()
    assert forest.loss_year_to_calendar(1) == first == config.HANSEN_FIRST_LOSS_YEAR
    assert forest.calendar_to_loss_year(last) == last - config.HANSEN_BASELINE_YEAR
    assert last == config.HANSEN_LAST_LOSS_YEAR


@pytest.mark.parametrize("band_value", [0, 26, -1])
def test_out_of_range_band_values_are_rejected(band_value):
    """0 means "no loss" and must never reach the mapping as though it were a year."""
    with pytest.raises(ValueError, match="outside"):
        forest.loss_year_to_calendar(band_value)


@pytest.mark.parametrize("calendar", [2000, 2026, 1999])
def test_out_of_range_calendar_years_are_rejected(calendar):
    with pytest.raises(ValueError, match="outside"):
        forest.calendar_to_loss_year(calendar)


# --- feature assembly ----------------------------------------------------------------------


def test_built_feature_satisfies_the_b4_contract():
    feature = forest.build_feature(SQUARE, 2014, 0.72)
    schema.validate(schema.feature_collection([feature]))


def test_built_feature_carries_the_expected_spine_values():
    props = forest.build_feature(SQUARE, 2014, 0.72)["properties"]

    assert props["domain"] == "forest"
    assert props["valid_from"] == 2014
    assert props["change_type"] == "loss"
    assert props["metric"]["area_ha"] == 0.72
    assert props["source"] == config.HANSEN_ASSET
    assert props["method"] == forest.METHOD


def test_loss_is_open_ended():
    """Hansen's gain band is 2000-2012 only, so claiming a regrowth date would invent precision."""
    assert forest.build_feature(SQUARE, 2014, 0.72)["properties"]["valid_to"] is None


def test_area_is_rounded_but_not_to_zero():
    """A patch at the minimum mapping unit must keep a usable number."""
    props = forest.build_feature(SQUARE, 2010, 0.5000004)["properties"]
    assert props["metric"]["area_ha"] == pytest.approx(0.5, abs=1e-4)
    assert props["metric"]["area_ha"] > 0


def test_building_a_feature_with_an_impossible_year_fails():
    """build_feature goes through TraceFeature, so the schema bounds apply here too."""
    with pytest.raises(schema.FeatureValidationError):
        forest.build_feature(SQUARE, 1200, 1.0)


# --- the domain contract -------------------------------------------------------------------


def test_forest_is_registered():
    assert "forest" in base.all_ids()
    assert isinstance(base.get("forest"), forest.ForestDomain)


def test_temporal_range_is_the_hansen_loss_window():
    assert forest.ForestDomain().temporal_range() == (2001, 2025)


def test_caveat_refuses_the_word_deforestation_as_a_synonym():
    """A product requirement, not politeness — Hansen loss includes harvest, fire, and typhoons."""
    caveat = forest.ForestDomain().caveat.lower()

    assert "tree-cover loss" in caveat
    assert "not deforestation" in caveat
    for cause in ("plantation", "fire", "typhoon"):
        assert cause in caveat, f"the caveat should name {cause} as a cause of measured loss"


def test_caveat_states_the_resolution_floor():
    caveat = forest.ForestDomain().caveat
    assert str(config.NATIVE_SCALE_M) in caveat
    assert "single pixels" in caveat


def test_caveat_reports_retained_share_not_only_the_threshold():
    """A bare threshold is unjudgeable — "89% of measured loss" is the fact a reader needs."""
    caveat = forest.ForestDomain().caveat
    assert f"{config.FOREST_RETAINED_PCT:.0f}%" in caveat
    assert "records for Taiwan" in caveat


def test_manifest_entry_is_well_formed():
    entry = forest.ForestDomain().manifest_entry("pmtiles:///data/forest.pmtiles")

    assert entry["temporal"] == {"start": 2001, "end": 2025}
    assert entry["hue"] == config.DOMAIN_HUES["forest"]
    assert "Hansen" in entry["source"]["attribution"]
    assert entry["source"]["licence"] == "CC-BY-4.0"


def test_confidence_is_stated_not_fabricated_per_feature():
    """Hansen publishes per-biome accuracy, not per-pixel — one honest flat value is correct."""
    assert 0 < forest.CONFIDENCE < 1
    a = forest.build_feature(SQUARE, 2005, 1.0)["properties"]["confidence"]
    b = forest.build_feature(SQUARE, 2020, 9.0)["properties"]["confidence"]
    assert a == b == forest.CONFIDENCE
