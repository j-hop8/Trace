"""Water domain tests.

Nothing here talks to Earth Engine, same reasoning as test_forest.py: the valuable logic is the
version-probe fallback and the feature assembly, and a live API call would not catch a mistake in
either any better than a unit test would. `gsw_v15_reachable` is monkeypatched wherever the answer
matters, so these never need real network access or credentials.
"""

import json
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
    allowed = set(schema.load_schema()["$defs"]["properties"]["properties"]["change_type"]["enum"])
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


@pytest.mark.parametrize("code", [0, 11, -1, 255])
def test_the_date_derivations_refuse_an_unknown_class_too(code):
    """T-022. `derive_valid_from(11, ...)` used to return the measured year -- an unknown class read
    as dated water -- and `build_feature` was only saved by its kwargs evaluating `change_type=`
    after the date. The guard is one function every derivation calls first, so kwarg order
    carries nothing. (`derive_valid_to` was the other offender; T-031 deleted it.)"""
    with pytest.raises(water.UnknownTransitionClass, match="documented 1-10"):
        water.derive_valid_from(code, first_seen=1990, last_seen=2015, range_first=1984)
    with pytest.raises(water.UnknownTransitionClass, match="documented 1-10"):
        water.require_documented(code)


def test_every_documented_class_derives_as_the_partition_says():
    """The guard adds a raise on undefined input; on defined input each class follows its set."""
    for code in water.GSW_TRANSITION_CLASSES:
        water.require_documented(code)
        assert water.derive_change_type(code) == water.CHANGE_TYPE_BY_TRANSITION[code]
        got = water.derive_valid_from(code, first_seen=1990, last_seen=2015, range_first=1984)
        if code in water.STABLE_FROM_START:
            assert got == 1984
        elif code in water.ARRIVED:
            assert got == 1990
        elif code in water.ENDED:
            assert got == 2016
        else:
            assert code in water.EPOCH_VERDICT and got == config.GSW_EPOCH_2_FIRST_YEAR


# --- valid_from: the year a class's verdict applies -------------------------------------------


def test_the_four_sets_partition_the_roster():
    sets = (water.STABLE_FROM_START, water.ARRIVED, water.ENDED, water.EPOCH_VERDICT)
    assert frozenset().union(*sets) == frozenset(water.GSW_TRANSITION_CLASSES)
    assert sum(len(x) for x in sets) == len(water.GSW_TRANSITION_CLASSES), "a class is in two sets"


def test_the_partition_follows_jrcs_class_names_rather_than_a_hand_kept_list():
    """Same structural guard T-021 gave `ENDED`, now over all four sets: JRC's naming is the rule
    and is checkable. A class arrived if it is `new ...`; ended if `lost ...` or `ephemeral ...`;
    is an epoch verdict if its name is one state ` to ` another; and is present throughout
    otherwise. Class 7 went missing from the old list once because it reads as an arrival."""
    for code, name in water.GSW_TRANSITION_CLASSES.items():
        expected = (
            water.ARRIVED
            if _jrc_name_starts(code, "new ")
            else water.ENDED
            if _jrc_name_starts(code, "lost ", "ephemeral ")
            else water.EPOCH_VERDICT
            if " to " in name
            else water.STABLE_FROM_START
        )
        assert code in expected, f"class {code} ({name}) is in the wrong set"


def test_classes_present_throughout_are_dated_to_the_record_not_measured():
    """The bug that dated 石門水庫 (dam 1964) and 曾文水庫 (1973) to the late 1980s: GSW has no
    usable observation of Taiwan in 1985, so a measured onset dates the observation, not the
    water. For a class JRC says held its state through both epochs, the measurement is ignored."""
    for code in water.STABLE_FROM_START:
        assert (
            water.derive_valid_from(code, first_seen=1988, last_seen=2021, range_first=1984) == 1984
        )


def test_arriving_classes_keep_their_measured_onset():
    """翡翠水庫's dam finished in 1987 -- the control proving the fix does not simply flatten
    every date to the start of the record."""
    assert water.derive_valid_from(2, first_seen=1988, last_seen=2021, range_first=1984) == 1988
    assert water.derive_valid_from(5, first_seen=2016, last_seen=2021, range_first=1984) == 2016


def test_a_measured_onset_cannot_fall_outside_the_published_range():
    assert water.derive_valid_from(2, first_seen=1979, last_seen=2021, range_first=1984) == 1984


def test_ended_classes_are_dated_to_the_first_year_the_water_is_gone():
    """`last_seen` is the last year the water was *seen*; cover's run for it is [f, last_seen + 1),
    so the loss begins the year after and the two hand off with no year in common -- the relation
    forest has between [2000, L) and [L, null). Driven off `ENDED` itself, as T-021 asked."""
    for code in water.ENDED:
        name = water.GSW_TRANSITION_CLASSES[code]
        got = water.derive_valid_from(code, first_seen=1984, last_seen=2015, range_first=1984)
        assert got == 2016, f"{code} ({name}) is not dated to the year after its last water"


def test_ended_follows_jrcs_class_names_rather_than_a_hand_kept_list():
    """Every other test of `ENDED` hand-lists codes, so the constant and its checks would be one
    hand-kept list wearing two hats. JRC's naming is the rule and is checkable: a class ended iff
    it was `lost ...` or `ephemeral ...`."""
    for code, name in water.GSW_TRANSITION_CLASSES.items():
        ended = _jrc_name_starts(code, "lost ", "ephemeral ")
        assert (code in water.ENDED) is ended, (
            f"class {code} ({name}) is on the wrong side of ENDED"
        )
    assert water.ENDED.issubset(water.GSW_TRANSITION_CLASSES)


def test_ended_is_a_strict_subset_of_the_loss_classes():
    """Pins class 8 as the case a looser rule -- `ended iff change_type is loss` -- would get
    wrong: `permanent to seasonal` is a `loss` that is not an ending."""
    losses = {c for c, ct in water.CHANGE_TYPE_BY_TRANSITION.items() if ct == "loss"}
    assert 8 in losses
    assert 8 not in water.ENDED
    assert water.ENDED.issubset(losses)


def test_epoch_verdicts_are_dated_to_the_epoch_they_were_judged_in():
    """7 and 8 are verdicts JRC reaches by comparing its two epochs and carry no year of their
    own. 1984 would assert the decline (or the gain) held in the epoch where the pixel was the
    other thing; a measured year would attach a Trace-invented date to a JRC verdict."""
    for code in water.EPOCH_VERDICT:
        got = water.derive_valid_from(code, first_seen=1991, last_seen=2015, range_first=1984)
        assert got == config.GSW_EPOCH_2_FIRST_YEAR
    assert config.GSW_EPOCH_2_FIRST_YEAR == 2000
    assert water.derive_change_type(7) == "gain"
    assert water.derive_change_type(8) == "loss"


def test_the_epoch_boundary_sits_inside_the_record():
    assert config.GSW_FIRST_YEAR < config.GSW_EPOCH_2_FIRST_YEAR < config.GSW_V14_LAST_YEAR


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
    assert props["valid_from"] == 2016  # the first year the record no longer sees water there
    assert props["valid_to"] is None  # change accumulates and never closes
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


def test_no_change_feature_ever_closes():
    """Change accumulates: drawn from the year it applies and for every year after. The schema
    refuses a change-kind feature with a valid_to, so this is also what lets every class pass."""
    for code in water.GSW_TRANSITION_CLASSES:
        assert build(code, first_year=1995, last_year=2015)["properties"]["valid_to"] is None


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

    assert "no year can be dated" in caveat
    assert "dropped rather than given a guessed one" in caveat


def test_caveat_admits_the_early_record_is_blind(monkeypatch):
    """GSW has no usable observation of Taiwan in 1985 and little before 1988, so a start date is
    when watching began rather than when the water arrived. That is the artefact that prompted this
    work, and it cannot be fixed -- only stated."""
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    caveat = water.WaterDomain().caveat

    assert "1985" in caveat
    assert "1988" in caveat


def test_caveat_says_change_accumulates_and_when_loss_is_dated(monkeypatch):
    """T-025, resolved: the first frame used to paint 71% of the loss layer because loss was dated
    from when the water was there. Now loss is dated to when it went, the epoch verdicts to the
    epoch, and the caveat says which layer answers which question."""
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    caveat = water.WaterDomain().caveat

    assert "Change accumulates" in caveat
    assert "first year the yearly record no longer sees water" in caveat
    assert f"drawn from {config.GSW_EPOCH_2_FIRST_YEAR}" in caveat
    assert "when the water was there" not in caveat


def test_caveat_quotes_the_undatable_share_rather_than_deferring_it(monkeypatch):
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    caveat = water.WaterDomain().caveat

    assert f"{config.WATER_UNDATABLE_DROPPED_PCT:.2f}%" in caveat
    assert "not yet folded" not in caveat


def test_caveat_names_small_ponds_by_their_local_name(monkeypatch):
    """A5: the caveat has to say what this layer cannot tell you, specifically enough to act on."""
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    assert "埤塘" in water.WaterDomain().caveat


def test_manifest_entry_is_well_formed(monkeypatch):
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    entry = water.WaterDomain().manifest_entry(
        "pmtiles:///data/water.pmtiles", ("cover", "loss", "gain", "stable")
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


# --- cover: runs of water years -------------------------------------------------------------


@pytest.mark.parametrize(
    "from_offset,to_offset,label",
    [(0, None, 99), (0, 1, 1), (3, None, 399), (10, 20, 1020), (37, 38, 3738), (40, None, 4099)],
)
def test_run_label_round_trips(from_offset, to_offset, label):
    """The label is what `reduceToVectors` segments on; a bad encoding would merge or split runs."""
    assert water.encode_run(from_offset, to_offset) == label
    assert water.decode_run(label, 1984) == (
        1984 + from_offset,
        None if to_offset is None else 1984 + to_offset,
    )


def test_run_label_refuses_an_empty_or_reversed_run():
    with pytest.raises(ValueError, match="after"):
        water.encode_run(5, 5)
    with pytest.raises(ValueError, match="after"):
        water.encode_run(5, 4)
    with pytest.raises(ValueError, match="at or before"):
        water.decode_run(505, 1984)


def test_run_label_cannot_reach_the_open_sentinel_by_accident():
    """An end offset of 99 would decode as open; the record cannot be that long, and the encoder
    refuses it rather than trusting that."""
    with pytest.raises(ValueError):
        water.encode_run(0, water.RUN_OPEN)
    with pytest.raises(ValueError):
        water.encode_run(water.RUN_OPEN, None)


def test_a_blind_year_does_not_split_a_run():
    """Taiwan is 100% blind in 1985. Left as dry, every pre-record body would end in 1984 and
    begin again in 1986."""
    assert water.impute_nearest([True, None, True]) == [True, True, True]
    assert water.runs_of(water.impute_nearest([True, None, True])) == [(0, None)]


def test_leading_blind_years_take_the_first_observation():
    """Water first seen in 1988 with 1984-87 blind is water from 1984 -- the same rule
    `PRESENT_AT_START` applies to change: the record starts with the water already there."""
    assert water.impute_nearest([None, None, None, None, True, True]) == [True] * 6


def test_trailing_and_inner_blind_years_carry_the_last_observation():
    """Prefer-prior: a blind year between wet and dry is wet, because that is what was last seen.
    It is one pass forward and one back, and a reader can predict it."""
    assert water.impute_nearest([True, None, False]) == [True, True, False]
    assert water.impute_nearest([False, True, None, None]) == [False, True, True, True]


def test_never_observed_is_not_water():
    assert water.impute_nearest([None, None, None]) == [False, False, False]
    assert water.runs_of([False, False, False]) == []


def test_runs_are_half_open_and_never_empty():
    assert water.runs_of([True, True, False, True]) == [(0, 2), (3, None)]
    assert water.runs_of([False, True, False]) == [(1, 2)]
    assert water.runs_of([True]) == [(0, None)]
    for states in ([True, False, True, False, True], [False] * 4 + [True] * 3):
        for start, end in water.runs_of(states):
            assert end is None or end > start


def test_a_pixel_cannot_start_runs_in_consecutive_years():
    """What lets two start years share one band in `cover_run_labels`: a run lasts at least a year
    and a dry year has to follow it, so starts are at least two years apart."""
    import itertools

    for states in itertools.product([True, False], repeat=8):
        starts = [s for s, _ in water.runs_of(list(states))]
        assert all(b - a >= 2 for a, b in zip(starts, starts[1:], strict=False)), states


def test_cover_feature_satisfies_the_contract_and_carries_no_subtype():
    feature = water.build_cover_feature(
        SQUARE,
        run_label=water.encode_run(4, 12),
        range_first=1984,
        area_ha=0.5,
        gsw_asset=config.GSW_V14_YEARLY,
    )
    schema.validate(schema.feature_collection([feature]))
    props = feature["properties"]

    assert props["change_type"] == "cover"
    assert props["valid_from"] == 1988
    assert props["valid_to"] == 1996
    assert props["method"] == water.COVER_METHOD
    assert props["source"] == config.GSW_V14_YEARLY
    assert "subtype" not in props


def test_open_cover_feature_has_no_end():
    feature = water.build_cover_feature(
        SQUARE,
        run_label=water.encode_run(0, None),
        range_first=1984,
        area_ha=0.5,
        gsw_asset=config.GSW_V14_YEARLY,
    )
    assert feature["properties"]["valid_from"] == 1984
    assert feature["properties"]["valid_to"] is None


def test_water_declares_cover_among_its_change_types():
    assert "cover" in water.WaterDomain.change_types


def test_caveat_says_cover_is_a_stretch_of_years_and_how_much_is_imputed(monkeypatch):
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    caveat = water.WaterDomain().caveat

    assert "stretch of years" in caveat
    assert "drawn only for those years" in caveat
    assert f"{config.WATER_COVER_IMPUTED_PCT:.0f}%" in caveat
    assert f"{config.WATER_COVER_RETAINED_PCT:.0f}%" in caveat
    assert "two JRC products" in caveat


_SHIPPED = pathlib.Path(__file__).resolve().parents[2] / "data" / "water.geojson"


@pytest.mark.skipif(not _SHIPPED.exists(), reason="no shipped water.geojson (data/ is generated)")
def test_shipped_cover_runs_are_well_formed():
    """The builder refuses a bad run; this checks the file that actually shipped agrees."""
    features = json.loads(_SHIPPED.read_text(encoding="utf-8"))["features"]
    cover = [f["properties"] for f in features if f["properties"]["change_type"] == "cover"]

    assert cover, "shipped water.geojson carries no cover features"
    assert all("subtype" not in p for p in cover)
    assert all(p["valid_from"] >= config.GSW_FIRST_YEAR for p in cover)
    bad = [p for p in cover if p["valid_to"] is not None and p["valid_to"] <= p["valid_from"]]
    assert not bad, f"{len(bad)} cover runs end at or before they begin"


@pytest.mark.skipif(not _SHIPPED.exists(), reason="no shipped water.geojson (data/ is generated)")
def test_shipped_change_features_never_close_and_none_is_lost_on_frame_one():
    """What T-025 was about, checked on the file that ships: no change feature carries an end, and
    the first frame draws no loss at all -- every loss is dated to a year the record could see it
    go, and the earliest such year is after the record opens."""
    features = json.loads(_SHIPPED.read_text(encoding="utf-8"))["features"]
    change = [f["properties"] for f in features if f["properties"]["change_type"] != "cover"]

    assert change
    assert all(p["valid_to"] is None for p in change)
    losses = [p for p in change if p["change_type"] == "loss"]
    assert min(p["valid_from"] for p in losses) > config.GSW_FIRST_YEAR
