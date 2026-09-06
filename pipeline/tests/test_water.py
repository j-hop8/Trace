"""Water domain tests.

Nothing here talks to Earth Engine, same reasoning as test_forest.py: the valuable logic is the
version-probe fallback and the feature assembly, and a live API call would not catch a mistake in
either any better than a unit test would. `gsw_v15_reachable` is monkeypatched wherever the answer
matters, so these never need real network access or credentials.
"""

import pathlib
import re

import pytest

from trace_pipeline import config, schema
from trace_pipeline.domains import base, water


@pytest.fixture(autouse=True)
def _reset_gsw_probe_cache():
    """The resolved GSW version is cached at module scope (every `WaterDomain()` in a process must
    agree on it), so a value one test's `gsw_v15_reachable` monkeypatch produces would otherwise
    leak into the next test regardless of that test's own monkeypatch."""
    water._resolved_gsw = None
    yield
    water._resolved_gsw = None


def _jrc_name_starts(code: int, *prefixes: str) -> bool:
    """Does JRC's own name for `code` begin with one of `prefixes`?

    The vocabulary of those prefixes is the rule both `PRESENT_AT_START` and `ENDED` are checked
    against, so the *mechanism* lives here once while each test keeps its own prefixes in plain
    sight -- a helper that also hid which prefixes a rule uses would be the hand-kept list again,
    one indirection further away.
    """
    return water.GSW_TRANSITION_CLASSES[code].startswith(prefixes)


SQUARE = {
    "type": "Polygon",
    "coordinates": [[[121.216, 24.993], [121.226, 24.993], [121.226, 25.003], [121.216, 24.993]]],
}


# --- change_type derivation ------------------------------------------------------------------


def test_every_documented_jrc_class_has_a_change_type():
    """No class may fall through to a default -- a missing entry would paint the map a colour
    nobody chose. `GSW_TRANSITION_CLASSES` is the roster, so the two dicts must agree exactly."""
    assert set(water.CHANGE_TYPE_BY_TRANSITION) == set(water.GSW_TRANSITION_CLASSES)


def test_change_types_are_all_in_the_schema_enum():
    allowed = {"extent", "gain", "loss", "stable"}
    assert set(water.CHANGE_TYPE_BY_TRANSITION.values()) <= allowed


def test_persisting_classes_are_stable():
    assert water.derive_change_type(1) == "stable"  # permanent
    assert water.derive_change_type(4) == "stable"  # seasonal


def test_arriving_classes_are_gain():
    for code in (2, 5, 7):  # new permanent, new seasonal, seasonal to permanent
        assert water.derive_change_type(code) == "gain"


def test_departing_and_declining_classes_are_loss():
    for code in (3, 6, 8):  # lost permanent, lost seasonal, permanent to seasonal
        assert water.derive_change_type(code) == "loss"


def test_ephemeral_is_loss_not_gain():
    """Preserves the earlier derivation's decision: a patch that both arrived and went is more
    usefully flagged "this is gone" than "this once arrived"."""
    assert water.derive_change_type(9) == "loss"  # ephemeral permanent
    assert water.derive_change_type(10) == "loss"  # ephemeral seasonal


def test_the_river_case_that_prompted_this_is_not_loss():
    """淡水河 came back `change_type: loss` carrying `subtype: permanent` on the same feature --
    the layer contradicting its own source. JRC's class is now the only vote."""
    assert water.derive_change_type(1) == "stable"


def test_an_unknown_class_raises_rather_than_defaulting():
    """Asset versions drift (config.py's standing gotcha). A class this module has never seen must
    be looked at, not silently given a colour."""
    with pytest.raises(water.UnknownTransitionClass):
        water.derive_change_type(11)
    with pytest.raises(water.UnknownTransitionClass):
        water.derive_change_type(0)


# --- valid_from / valid_to derivation ---------------------------------------------------------


def test_classes_present_at_the_start_are_dated_to_the_record_not_measured():
    """The bug that dated 石門水庫 (dam 1964) and 曾文水庫 (1973) to the late 1980s: GSW has no
    usable observation of Taiwan in 1985, so a measured onset dates the observation, not the
    water. For a class JRC defines as already-water in epoch 1, the measurement is ignored."""
    for code in (1, 3, 4, 6, 7, 8):
        assert water.derive_valid_from(code, 1988, 1984) == 1984


def test_present_at_start_follows_jrcs_class_names_rather_than_a_hand_kept_list():
    """`seasonal to permanent` (7) was missed on the first pass because it reads as an arrival:
    it is a `gain`, so it was grouped with `new permanent` and `new seasonal` and given a measured
    onset -- which put water JRC says was already there in epoch 1 back in the blind 1988-93 years,
    the exact artefact this module exists to remove.

    JRC's naming is the rule and is checkable, so check it rather than re-listing the codes: a
    class is already-water in epoch 1 unless it arrived (`new ...`) or never held either epoch's
    stable state (`ephemeral ...`).
    """
    for code, name in water.GSW_TRANSITION_CLASSES.items():
        arrived_or_flickered = _jrc_name_starts(code, "new ", "ephemeral ")
        assert (code in water.PRESENT_AT_START) is not arrived_or_flickered, (
            f"class {code} ({name}) is on the wrong side of PRESENT_AT_START"
        )


def test_water_already_there_in_epoch_one_is_never_dated_by_measurement():
    """The measured onset cannot answer class 7's question even in principle: `water_stats_image`
    tags a year wherever `waterClass >= WATER_CLASS_SEASONAL`, so it reports the first year the
    pixel was seen as *any* water, never the year it became permanent."""
    assert water.derive_valid_from(7, 1991, 1984) == 1984
    assert water.derive_valid_to(7, 2015, 2021) is None  # becoming permanent is not an ending
    assert water.derive_change_type(7) == "gain"  # and the change is still carried


def test_arriving_classes_keep_their_measured_onset():
    """翡翠水庫's dam finished in 1987 -- the control proving the fix does not simply flatten
    every date to the start of the record."""
    assert water.derive_valid_from(2, 1988, 1984) == 1988
    assert water.derive_valid_from(5, 2016, 1984) == 2016


def test_a_measured_onset_cannot_fall_outside_the_published_range():
    assert water.derive_valid_from(2, 1979, 1984) == 1984


def test_only_ended_classes_close():
    """Driven off `ENDED` itself so a class correctly added to it is actually exercised here,
    rather than passing the membership guard while its closing behaviour goes untested."""
    for code in water.ENDED:
        name = water.GSW_TRANSITION_CLASSES[code]
        assert water.derive_valid_to(code, 2015, 2021) == 2015, f"{code} ({name}) did not close"


def test_ended_follows_jrcs_class_names_rather_than_a_hand_kept_list():
    """Same structural guard as `PRESENT_AT_START`'s, and here for the same reason: every other
    test of `ENDED` hand-lists codes, so the constant and its checks would be one hand-kept list
    wearing two hats -- exactly how class 7 went missing from `PRESENT_AT_START`.

    JRC's naming is the rule and is checkable: a class ended iff it was `lost ...` (held its state
    through epoch 1 and was gone by epoch 2) or `ephemeral ...` (came and went inside the record).
    """
    for code, name in water.GSW_TRANSITION_CLASSES.items():
        ended = _jrc_name_starts(code, "lost ", "ephemeral ")
        assert (code in water.ENDED) is ended, (
            f"class {code} ({name}) is on the wrong side of ENDED"
        )
    # The loop above only visits the roster, so on its own it cannot see a code in `ENDED` that
    # JRC never defined. Same containment check `MASK_ON_MANAGED_LAND` already gets.
    assert water.ENDED.issubset(water.GSW_TRANSITION_CLASSES)


def test_ended_is_a_strict_subset_of_the_loss_classes():
    """Pins class 8 as the case a looser rule -- `ended iff change_type is loss` -- would get
    wrong: `permanent to seasonal` is a `loss` that is not an ending. Asserts the constants
    directly rather than the naming rule, which is
    `test_ended_follows_jrcs_class_names_rather_than_a_hand_kept_list`'s job."""
    losses = {c for c, ct in water.CHANGE_TYPE_BY_TRANSITION.items() if ct == "loss"}
    assert 8 in losses
    assert 8 not in water.ENDED
    assert water.ENDED.issubset(losses)  # ...but every ending is still a loss


def test_persisting_classes_stay_open_ended():
    """The complement of `ENDED` over the roster, not a hand-kept tuple -- the same anti-pattern
    that let class 7 go missing. Every class JRC defines is now covered by this test or the one
    above, whichever side of `ENDED` it falls on."""
    for code in water.GSW_TRANSITION_CLASSES.keys() - water.ENDED:
        name = water.GSW_TRANSITION_CLASSES[code]
        assert water.derive_valid_to(code, 2015, 2021) is None, f"{code} ({name}) closed"


def test_declining_water_is_loss_but_has_not_ended():
    """`permanent to seasonal` is less water than there was, which is a loss -- but the water is
    still there, so the state is current and the feature stays open-ended."""
    assert water.derive_change_type(8) == "loss"
    assert water.derive_valid_to(8, 2015, 2021) is None


def test_an_end_year_cannot_exceed_the_record():
    """The record stopping is not the state stopping."""
    assert water.derive_valid_to(3, 2025, 2021) == 2021


# --- the managed-land mask ---------------------------------------------------------------------


def test_only_seasonal_grade_classes_are_masked_on_managed_land():
    """The mask must never reach a class involving permanent water at either end: those are real
    urban lakes and encroached ponds, not building shadow. Measured, 0% of `permanent` pixels sit
    on built-up ground in any region sampled."""
    involves_permanent = {1, 2, 3, 7, 8, 9}
    assert water.MASK_ON_MANAGED_LAND.isdisjoint(involves_permanent)
    assert water.MASK_ON_MANAGED_LAND.issubset(water.GSW_TRANSITION_CLASSES)
    for code in water.MASK_ON_MANAGED_LAND:
        assert "seasonal" in water.GSW_TRANSITION_CLASSES[code]


def test_classes_that_ended_are_kept_on_managed_ground():
    """A 埤塘 filled in for housing is the most interesting urban water story Taiwan has, and it
    reads as `lost permanent` / `lost seasonal` sitting on built-up land -- 15% and 12% of those
    classes do. Masking them would delete the story along with the shadows."""
    for code in (3, 6):  # lost permanent, lost seasonal
        assert code not in water.MASK_ON_MANAGED_LAND


def test_ephemeral_seasonal_is_masked_but_ephemeral_permanent_is_not():
    """`ephemeral` means the water held neither epoch's stable state. Flickering sub-pixel
    *seasonal* water on built ground is shadow; the permanent-grade counterpart is not."""
    assert 10 in water.MASK_ON_MANAGED_LAND
    assert 9 not in water.MASK_ON_MANAGED_LAND


def test_the_managed_land_asset_comes_from_config_not_a_literal():
    """Asset ids live in config.py and nowhere else, exactly as for the land boundary."""
    source = pathlib.Path(water.__file__).read_text(encoding="utf-8").split('"""', 2)[2]

    assert "ESA/" not in source
    assert "config.WORLDCOVER_ASSET" in source
    assert "config.WORLDCOVER_MANAGED_CLASSES" in source


def test_caveat_states_the_managed_land_rule_and_what_it_costs(monkeypatch):
    """A deliberate deletion of source data, not a resolution limit -- so the reader is owed the
    size of the gap, that it is spatial, and that ended water is kept."""
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    caveat = water.WaterDomain().caveat

    assert "built-up or cropland" in caveat
    assert f"{config.WATER_MANAGED_SEASONAL_DROPPED_PCT:.1f}%" in caveat
    assert "2021 snapshot" in caveat
    assert "ended" in caveat


def test_both_managed_land_classes_are_covered():
    """One rule over two land classes -- built-up shadow and irrigated cropland are the same
    mistake, so the constant must carry both or the plains stay blue."""
    assert set(config.WORLDCOVER_MANAGED_CLASSES) == {40, 50}  # cropland, built-up


def test_the_rule_names_no_place_in_taiwan():
    """The mask is a per-pixel test against island-wide rasters and must stay one. A coordinate
    literal in this module would mean some region was special-cased, which is exactly what the
    measurement said not to do: the artefact is a land-cover property, not a location."""
    source = pathlib.Path(water.__file__).read_text(encoding="utf-8").split('"""', 2)[2]

    # Taiwan's span is 119-122E / 21-26N; any bare decimal in that range would be a hard-coded
    # place. Config holds the one bounding box the pipeline is allowed to know.
    suspects = re.findall(r"\b(1(?:19|2[012])\.\d+|2[1-5]\.\d+)\b", source)
    assert not suspects, f"hard-coded coordinates in water.py: {suspects}"


def test_caveat_does_not_promise_gain_means_new_water(monkeypatch):
    """For pixels JRC calls `new seasonal` the median was already water in 46% of the epoch-1 years
    GSW could see (`new permanent`: 78%), and satellite revisit roughly doubled over the record --
    so `gain` cannot be sold as water appearing where there was none."""
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    caveat = water.WaterDomain().caveat

    assert "not that water appeared where there was none" in caveat
    assert "revisit" in caveat


# --- feature assembly ------------------------------------------------------------------------


def build(transition_code, **overrides):
    """A feature with the boring defaults filled in, so each test states only what it is about."""
    kwargs = {
        "transition_code": transition_code,
        "first_year": 1984,
        "last_year": 2021,
        "range_first": 1984,
        "range_last": 2021,
        "area_ha": 1.2,
        "gsw_asset": config.GSW_V14_YEARLY,
    }
    kwargs.update(overrides)
    return water.build_feature(SQUARE, **kwargs)


def test_built_feature_satisfies_the_b4_contract():
    schema.validate(schema.feature_collection([build(1)]))


def test_every_class_produces_a_schema_valid_feature():
    """Each of the ten classes now drives change_type, valid_from and valid_to, so each is its own
    path to the schema rather than a decorative label."""
    features = [
        build(code, first_year=1995, last_year=2015) for code in water.GSW_TRANSITION_CLASSES
    ]
    schema.validate(schema.feature_collection(features))


def test_built_feature_carries_the_expected_spine_values():
    props = build(6, first_year=1995, last_year=2015)["properties"]  # lost seasonal

    assert props["domain"] == "water"
    assert props["valid_from"] == 1984  # class 6 was water in epoch 1, so not measured
    assert props["valid_to"] == 2015
    assert props["change_type"] == "loss"
    assert props["subtype"] == "lost seasonal"
    assert props["metric"]["area_ha"] == 1.2
    assert props["source"] == config.GSW_V14_YEARLY
    assert props["method"] == water.METHOD


def test_a_new_body_carries_its_measured_onset_and_stays_open():
    props = build(2, first_year=1988, last_year=2021)["properties"]  # new permanent
    assert props["valid_from"] == 1988
    assert props["valid_to"] is None
    assert props["change_type"] == "gain"


def test_still_water_at_the_end_is_open_ended():
    """The final observed year is not an end date -- the record simply stops there."""
    props = build(1)["properties"]  # permanent
    assert props["valid_to"] is None
    assert props["change_type"] == "stable"


def test_transition_code_becomes_the_named_subtype():
    assert build(3)["properties"]["subtype"] == water.GSW_TRANSITION_CLASSES[3]


def test_subtype_and_change_type_can_never_disagree():
    """The failure that prompted this work: 淡水河 shipped `subtype: permanent` alongside
    `change_type: loss`. Both now come from the same class, so a feature JRC calls permanent
    cannot also be painted as gone."""
    for code, name in water.GSW_TRANSITION_CLASSES.items():
        props = build(code, first_year=1995, last_year=2015)["properties"]
        assert props["subtype"] == name
        assert props["change_type"] == water.CHANGE_TYPE_BY_TRANSITION[code]


def test_an_unrecognised_transition_code_raises_rather_than_guessing():
    with pytest.raises((water.UnknownTransitionClass, KeyError)):
        build(99)


def test_area_is_rounded_but_not_to_zero():
    props = build(1, area_ha=0.5000004)["properties"]
    assert props["metric"]["area_ha"] == pytest.approx(0.5, abs=1e-4)
    assert props["metric"]["area_ha"] > 0


def test_building_a_feature_with_an_impossible_year_fails():
    """build_feature goes through TraceFeature, so the schema bounds apply here too."""
    with pytest.raises(schema.FeatureValidationError):
        # class 2 is measured rather than dated to the record, so a bad year reaches the schema
        build(2, first_year=1200, range_first=1200)


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


def test_the_probe_runs_at_most_once_per_process(monkeypatch):
    """`extract` and `temporal_range` must agree on which version they used.

    A second network round-trip could in principle come back differently (the asset could become
    reachable or unreachable between calls), which would silently desync the manifest's range from
    what was actually extracted -- so the probe is cached the first time anything needs it.
    """
    calls = []
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: (calls.append(1), False)[1])

    domain = water.WaterDomain()
    domain.temporal_range()
    domain.temporal_range()
    _ = domain.source

    assert len(calls) == 1


def test_the_probe_is_shared_across_instances_not_just_within_one(monkeypatch):
    """`cli.py`'s `domain_registry.get()` constructs a fresh WaterDomain per pipeline stage
    (extract, tiles, manifest) -- an instance-scoped cache would let each stage probe
    independently and risk disagreeing about which GSW version was used mid-run. The cache has to
    be shared by every instance in the process, not merely reused within one."""
    calls = []
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: (calls.append(1), False)[1])

    water.WaterDomain().temporal_range()
    _ = water.WaterDomain().source
    _ = water.WaterDomain().caveat

    assert len(calls) == 1


def test_source_names_which_gsw_version_was_actually_used(monkeypatch):
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    assert "v1.4" in water.WaterDomain().source.version

    # The probe is cached at module scope now (every WaterDomain must agree on it within one
    # process), so getting a second, different answer in this same test needs a fresh cache, not
    # just a fresh instance -- a real process only ever resolves once per run.
    water._resolved_gsw = None
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


def test_caveat_states_the_change_window_not_just_the_extent_range(monkeypatch):
    """`transition` is a v1.4-only band covering 1984-2021. It now decides change_type, so if v1.5
    ever resolves, extent would run to 2024 while change still stops at 2021. The caveat has to say
    so unconditionally rather than leaving the reader to assume one range covers both."""
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: True)
    caveat = water.WaterDomain().caveat

    assert str(config.GSW_V14_LAST_YEAR) in caveat
    assert "transition" in caveat


def test_caveat_states_what_a_feature_now_is(monkeypatch):
    """Features are regions of one transition class, so an area figure is not a water body's
    area -- T-016's acceptance criterion."""
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    assert "transition class" in water.WaterDomain().caveat


def test_caveat_states_the_retained_percentage_not_just_the_threshold(monkeypatch):
    """The honesty rule: "patches under X ha are not mapped" sounds negligible; the retained share
    is the fact a reader needs."""
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    assert f"{config.WATER_RETAINED_PCT:.0f}%" in water.WaterDomain().caveat


def test_caveat_states_completeness_against_the_source_not_just_against_the_sieve(monkeypatch):
    """WATER_RETAINED_PCT's denominator is post-managed-land-mask, so quoting it alongside the
    mask's own cost let a reader read 88% as "88% of JRC's water is here" when the layer holds
    about 75%. Both cuts are stated, and so is what they compose to."""
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    caveat = water.WaterDomain().caveat

    assert f"{config.WATER_SOURCE_RETAINED_PCT:.1f}%" in caveat
    # And the sieve figure no longer claims the source's total as its base.
    assert f"{config.WATER_RETAINED_PCT:.0f}% of the water area the source records" not in caveat


def test_caveat_admits_the_regions_dropped_as_undatable(monkeypatch):
    """`extract` skips a region whose class needs a measured year the yearly stack cannot supply.
    That is a fourth way the layer is smaller than its source, and the honesty rule that governs
    the other three governs it too -- it cannot be left to the run log alone."""
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    caveat = water.WaterDomain().caveat

    assert "no onset can be dated" in caveat
    assert "not yet folded into the percentages" in caveat


def test_caveat_admits_the_early_record_is_blind(monkeypatch):
    """GSW has no usable observation of Taiwan in 1985 and little before 1988, so a start date is
    when watching began rather than when the water arrived. That is the artefact that prompted this
    work, and it cannot be fixed -- only stated."""
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    caveat = water.WaterDomain().caveat

    assert "1985" in caveat
    assert "1988" in caveat


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
    a = build(1, area_ha=1.0)["properties"]["confidence"]
    b = build(6, first_year=1990, last_year=2000, area_ha=9.0)["properties"]["confidence"]
    assert a == b == water.CONFIDENCE


def test_caveat_says_the_layer_is_inland_water_only(monkeypatch):
    """The sea being absent has to be stated, not left for the reader to infer.

    GSW classes ocean as water, so "surface water near Taiwan" is exactly what a reader would
    otherwise take this layer to be -- and the honest failure mode of a land clip is that
    intertidal water reads as *unchanged* rather than as *not measured*.
    """
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    caveat = water.WaterDomain().caveat

    assert "land boundary" in caveat
    assert "intertidal" in caveat
    # And that a patch meeting the coast is cut, so its area is not the whole body's.
    assert "cut at the boundary" in caveat


def test_the_land_boundary_comes_from_config_not_a_literal():
    """Asset ids live in config.py and nowhere else, so a moved asset is a one-line change."""
    source = (
        pathlib.Path(water.__file__).read_text(encoding="utf-8").split('"""', 2)[2]
    )  # past the module docstring, which cites the id in prose

    assert "USDOS/" not in source
    assert "config.TAIWAN_LAND_BOUNDARY" in source


def test_caveat_says_what_loss_bundles(monkeypatch):
    """Loss paints about a third of this layer red, and a third of Taiwan's water did not vanish:
    the class bundles ephemeral water, gone seasonal water, and permanent water that merely dropped
    to seasonal. The share that actually disappeared has to be stated, for the same reason the
    forest caveat states a retained percentage rather than only a threshold."""
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    caveat = water.WaterDomain().caveat

    assert "ephemeral" in caveat
    assert f"{config.WATER_LOST_PERMANENT_PCT:.1f}%" in caveat
