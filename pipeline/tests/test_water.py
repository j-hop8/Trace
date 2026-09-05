"""Water domain tests.

Nothing here talks to Earth Engine, same reasoning as test_forest.py: the valuable logic is the
version-probe fallback and the feature assembly, and a live API call would not catch a mistake in
either any better than a unit test would. `gsw_v15_reachable` is monkeypatched wherever the answer
matters, so these never need real network access or credentials.
"""

import pytest

from trace_pipeline import config, schema
from trace_pipeline.domains import base, water

SQUARE = {
    "type": "Polygon",
    "coordinates": [[[121.216, 24.993], [121.226, 24.993], [121.226, 25.003], [121.216, 24.993]]],
}


# --- change_type derivation ------------------------------------------------------------------


def test_a_patch_still_water_at_the_end_is_stable():
    assert water.derive_change_type(1984, 2021, 1984, 2021) == "stable"


def test_a_patch_that_stopped_before_the_end_is_loss():
    assert water.derive_change_type(1984, 2015, 1984, 2021) == "loss"


def test_a_patch_that_appeared_after_the_start_and_stayed_is_gain():
    assert water.derive_change_type(2005, 2021, 1984, 2021) == "gain"


def test_appeared_and_then_disappeared_is_loss_not_gain():
    """Loss takes priority: "this is gone" is more actionable than "this once arrived"."""
    assert water.derive_change_type(2005, 2015, 1984, 2021) == "loss"


def test_a_single_year_patch_within_the_range_is_loss():
    assert water.derive_change_type(2010, 2010, 1984, 2021) == "loss"


# --- feature assembly ------------------------------------------------------------------------


def test_built_feature_satisfies_the_b4_contract():
    feature = water.build_feature(
        SQUARE,
        first_year=1984,
        last_year=2021,
        range_first=1984,
        range_last=2021,
        area_ha=1.2,
        gsw_asset=config.GSW_V14_YEARLY,
    )
    schema.validate(schema.feature_collection([feature]))


def test_built_feature_carries_the_expected_spine_values():
    props = water.build_feature(
        SQUARE,
        first_year=2005,
        last_year=2015,
        range_first=1984,
        range_last=2021,
        area_ha=0.34,
        gsw_asset=config.GSW_V14_YEARLY,
    )["properties"]

    assert props["domain"] == "water"
    assert props["valid_from"] == 2005
    assert props["valid_to"] == 2015
    assert props["change_type"] == "loss"
    assert props["metric"]["area_ha"] == 0.34
    assert props["source"] == config.GSW_V14_YEARLY
    assert props["method"] == water.METHOD


def test_still_water_at_the_end_is_open_ended():
    """The final observed year is not an end date -- the record simply stops there."""
    props = water.build_feature(
        SQUARE,
        first_year=1984,
        last_year=2021,
        range_first=1984,
        range_last=2021,
        area_ha=5.0,
        gsw_asset=config.GSW_V14_YEARLY,
    )["properties"]
    assert props["valid_to"] is None
    assert props["change_type"] == "stable"


def test_transition_code_becomes_the_named_subtype():
    props = water.build_feature(
        SQUARE,
        first_year=1984,
        last_year=2015,
        range_first=1984,
        range_last=2021,
        area_ha=0.5,
        gsw_asset=config.GSW_V14_YEARLY,
        transition_code=3,
    )["properties"]
    assert props["subtype"] == water.GSW_TRANSITION_CLASSES[3]


def test_an_unrecognised_transition_code_omits_subtype_rather_than_guessing():
    props = water.build_feature(
        SQUARE,
        first_year=1984,
        last_year=2021,
        range_first=1984,
        range_last=2021,
        area_ha=0.5,
        gsw_asset=config.GSW_V14_YEARLY,
        transition_code=99,
    )["properties"]
    assert "subtype" not in props


def test_no_transition_code_omits_subtype():
    props = water.build_feature(
        SQUARE,
        first_year=1984,
        last_year=2021,
        range_first=1984,
        range_last=2021,
        area_ha=0.5,
        gsw_asset=config.GSW_V14_YEARLY,
    )["properties"]
    assert "subtype" not in props


def test_area_is_rounded_but_not_to_zero():
    props = water.build_feature(
        SQUARE,
        first_year=1984,
        last_year=2021,
        range_first=1984,
        range_last=2021,
        area_ha=0.5000004,
        gsw_asset=config.GSW_V14_YEARLY,
    )["properties"]
    assert props["metric"]["area_ha"] == pytest.approx(0.5, abs=1e-4)
    assert props["metric"]["area_ha"] > 0


def test_building_a_feature_with_an_impossible_year_fails():
    """build_feature goes through TraceFeature, so the schema bounds apply here too."""
    with pytest.raises(schema.FeatureValidationError):
        water.build_feature(
            SQUARE,
            first_year=1200,
            last_year=2021,
            range_first=1984,
            range_last=2021,
            area_ha=1.0,
            gsw_asset=config.GSW_V14_YEARLY,
        )


# --- the version probe -----------------------------------------------------------------------


def test_temporal_range_falls_back_to_v14_when_v15_is_unreachable(monkeypatch):
    """The path this ticket exists to guarantee: no exception, and the honest shorter range."""
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)

    domain = water.WaterDomain()

    assert domain.temporal_range() == (1984, 2021)
    assert domain.temporal_range() == (config.GSW_FIRST_YEAR, config.GSW_V14_LAST_YEAR)


def test_temporal_range_uses_v15_when_reachable(monkeypatch):
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: True)

    domain = water.WaterDomain()

    assert domain.temporal_range() == (config.GSW_FIRST_YEAR, config.GSW_V15_LAST_YEAR)


def test_the_probe_runs_at_most_once_per_instance(monkeypatch):
    """`extract` and `temporal_range` must agree on which version they used.

    A second network round-trip could in principle come back differently (the asset could become
    reachable or unreachable between calls), which would silently desync the manifest's range from
    what was actually extracted -- so the probe is cached the first time this instance needs it.
    """
    calls = []
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: (calls.append(1), False)[1])

    domain = water.WaterDomain()
    domain.temporal_range()
    domain.temporal_range()
    _ = domain.source

    assert len(calls) == 1


def test_source_names_which_gsw_version_was_actually_used(monkeypatch):
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    assert "v1.4" in water.WaterDomain().source.version

    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: True)
    assert "v1.5" in water.WaterDomain().source.version


# --- the domain contract ----------------------------------------------------------------------


def test_water_is_registered():
    assert "water" in base.all_ids()
    assert isinstance(base.get("water"), water.WaterDomain)


def test_caveat_states_the_resolution_floor(monkeypatch):
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    caveat = water.WaterDomain().caveat
    assert str(config.NATIVE_SCALE_M) in caveat


def test_caveat_names_small_ponds_by_their_local_name(monkeypatch):
    """A5: the caveat has to say what this layer cannot tell you, specifically enough to act on."""
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    assert "埤塘" in water.WaterDomain().caveat


def test_manifest_entry_is_well_formed(monkeypatch):
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    entry = water.WaterDomain().manifest_entry(
        "pmtiles:///data/water.pmtiles", ("loss", "gain", "stable")
    )

    assert entry["id"] == "water"
    assert entry["temporal"] == {"start": 1984, "end": 2021}
    assert entry["hue"] == config.DOMAIN_HUES["water"]
    assert entry["source"]["attribution"] == "Source: EC JRC/Google"
    assert entry["tiles"] == {"url": "pmtiles:///data/water.pmtiles", "sourceLayer": "water"}


def test_confidence_is_stated_not_fabricated_per_feature():
    """JRC publishes global accuracy figures, not per-pixel ones -- one honest flat value."""
    assert 0 < water.CONFIDENCE < 1
    a = water.build_feature(
        SQUARE,
        first_year=1984,
        last_year=2021,
        range_first=1984,
        range_last=2021,
        area_ha=1.0,
        gsw_asset=config.GSW_V14_YEARLY,
    )["properties"]["confidence"]
    b = water.build_feature(
        SQUARE,
        first_year=1990,
        last_year=2000,
        range_first=1984,
        range_last=2021,
        area_ha=9.0,
        gsw_asset=config.GSW_V14_YEARLY,
    )["properties"]["confidence"]
    assert a == b == water.CONFIDENCE
