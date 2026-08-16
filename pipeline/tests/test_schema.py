"""The B4 contract is what every other module trusts, so test it from both directions.

Fixtures are real GeoJSON rather than dicts built inline: the pipeline's actual input is a file
produced by Earth Engine, and a fixture that has been through a JSON round-trip catches things an
in-memory dict cannot (a null that became a string, an int that became a float).
"""

import json
from pathlib import Path

import pytest

from trace_pipeline import config, manifest, schema
from trace_pipeline.domains import base

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> dict:
    with (FIXTURES / f"{name}.geojson").open(encoding="utf-8") as handle:
        return json.load(handle)


# --- the schema file itself --------------------------------------------------------------------


def test_schema_file_is_itself_valid():
    """A malformed schema would make every other check here vacuously pass."""
    import jsonschema

    doc = schema.load_schema()
    jsonschema.validators.validator_for(doc).check_schema(doc)


def test_valid_to_is_required_but_subtype_is_not():
    """The deliberate asymmetry from the T-000 review -- pin it so it is not "tidied up" later.

    Omitting valid_to would make every feature look current, which is invisible on the map.
    subtype is optional because proposal B4 marks it so.
    """
    required = schema.required_property_names()
    assert "valid_to" in required
    assert "subtype" not in required


# --- validating collections --------------------------------------------------------------------


def test_valid_fixture_passes():
    schema.validate(load("valid"))


@pytest.mark.parametrize(
    "fixture,expected_in_message",
    [
        ("invalid_missing_valid_to", "valid_to"),
        ("invalid_empty_metric", "metric"),
        ("invalid_reversed_dates", "valid_to"),
        ("invalid_bad_enums", "change_type"),
    ],
)
def test_invalid_fixtures_are_rejected(fixture, expected_in_message):
    with pytest.raises(schema.FeatureValidationError) as excinfo:
        schema.validate(load(fixture))
    assert expected_in_message in str(excinfo.value)


def test_error_names_the_offending_feature_index():
    """Debugging a 40k-feature export needs the index, not a JSON pointer."""
    collection = load("valid")
    broken = json.loads(json.dumps(collection["features"][0]))
    broken["properties"]["confidence"] = 5.0
    collection["features"].append(broken)

    with pytest.raises(schema.FeatureValidationError) as excinfo:
        schema.validate(collection)

    message = str(excinfo.value)
    assert "feature[2]" in message, message
    assert "confidence" in message, message


def test_reversed_dates_message_explains_the_rule():
    with pytest.raises(schema.FeatureValidationError) as excinfo:
        schema.validate(load("invalid_reversed_dates"))
    assert "cannot end before it begins" in str(excinfo.value)


def test_all_problems_are_collected_not_just_the_first():
    collection = load("invalid_bad_enums")
    # domain pattern, change_type enum, and confidence range are all wrong in this fixture.
    with pytest.raises(schema.FeatureValidationError) as excinfo:
        schema.validate(collection)
    assert len(excinfo.value.problems) >= 3


def test_long_problem_lists_are_truncated_in_the_message():
    """Printing 40k errors helps nobody; the count still has to be honest."""
    one = load("invalid_empty_metric")["features"][0]
    collection = schema.feature_collection([json.loads(json.dumps(one)) for _ in range(40)])

    with pytest.raises(schema.FeatureValidationError) as excinfo:
        schema.validate(collection)

    assert len(excinfo.value.problems) == 40, "one problem per feature, not one per rule"
    assert "and 30 more" in str(excinfo.value)
    assert str(excinfo.value).count("\n  - ") == schema.MAX_REPORTED_PROBLEMS


@pytest.mark.parametrize(
    "collection,fragment",
    [
        ({"type": "Feature", "features": []}, "expected 'FeatureCollection'"),
        ({"type": "FeatureCollection", "features": {}}, "expected a list"),
        ({"type": "FeatureCollection", "features": ["nope"]}, "expected an object"),
    ],
)
def test_malformed_collections_fail_readably(collection, fragment):
    with pytest.raises(schema.FeatureValidationError) as excinfo:
        schema.validate(collection)
    assert fragment in str(excinfo.value)


# --- the dataclass ------------------------------------------------------------------------------


def make_props(**overrides):
    """A raw properties dict — bypasses the dataclass so invalid ones can be built."""
    props = {
        "domain": "water",
        "valid_from": 1984,
        "valid_to": 2008,
        "change_type": "loss",
        "metric": {"area_ha": 3.2},
        "source": "JRC/GSW1_4/YearlyHistory",
        "method": "JRC GSW YearlyHistory",
        "confidence": 0.85,
    }
    props.update(overrides)
    return props


def make_feature(**overrides):
    return schema.TraceFeature(**make_props(**overrides))


SQUARE = {
    "type": "Polygon",
    "coordinates": [[[121.21, 24.99], [121.22, 24.99], [121.22, 25.0], [121.21, 24.99]]],
}


def test_dataclass_round_trips_through_validation():
    feature = make_feature().to_geojson_feature(SQUARE)
    schema.validate(schema.feature_collection([feature]))


def test_dataclass_rejects_reversed_dates_at_construction():
    """Failing here points the traceback at the extraction code that built it."""
    with pytest.raises(schema.FeatureValidationError, match="cannot end before it begins"):
        make_feature(valid_from=2008, valid_to=1990)


def test_dataclass_rejects_empty_metric():
    with pytest.raises(schema.FeatureValidationError, match="non-empty"):
        make_feature(metric={})


@pytest.mark.parametrize(
    "overrides,fragment",
    [
        ({"domain": "Water"}, "domain"),
        ({"change_type": "deforestation"}, "change_type"),
        ({"confidence": 1.4}, "confidence"),
        ({"source": ""}, "source"),
        ({"valid_from": 1200}, "valid_from"),
    ],
)
def test_dataclass_enforces_the_full_schema_not_just_the_code_rules(overrides, fragment):
    """The dataclass validates against the schema, so it catches all that validate() does."""
    with pytest.raises(schema.FeatureValidationError, match=fragment):
        make_feature(**overrides)


def test_empty_metric_is_reported_once_not_twice():
    """metric lives in the schema only; duplicating it in code would double every report."""
    problems = schema.validate_feature(
        {"type": "Feature", "geometry": SQUARE, "properties": make_props(metric={})}
    )
    assert sum("metric" in p for p in problems) == 1, problems


def test_open_ended_state_is_allowed():
    feature = make_feature(valid_to=None)
    assert feature.properties()["valid_to"] is None


def test_same_year_start_and_end_is_allowed():
    """A pond present for a single year is real data, not an error."""
    assert make_feature(valid_from=1995, valid_to=1995).properties()["valid_to"] == 1995


def test_subtype_is_omitted_when_absent_rather_than_null():
    """A null on every feature would be dead weight in every tile."""
    assert "subtype" not in make_feature().properties()
    assert make_feature(subtype="pond").properties()["subtype"] == "pond"


def test_id_is_only_emitted_when_set():
    assert "id" not in make_feature().to_geojson_feature(SQUARE)
    assert make_feature(id="water-1").to_geojson_feature(SQUARE)["id"] == "water-1"


def test_extra_properties_are_carried_through():
    feature = make_feature(extra={"gsw_transition": 4})
    assert feature.properties()["gsw_transition"] == 4


@pytest.mark.parametrize("key", ["domain", "valid_from", "valid_to", "metric", "subtype"])
def test_extra_cannot_shadow_a_spine_field(key):
    """Regression: `extra` used to be merged last and could silently rewrite the contract.

    A feature built as `water` with extra={'domain': 'forest'} emitted `forest` into the tiles
    and passed validation, because `forest` is a legal domain. Misattributed data that validates
    is the worst failure mode available here.
    """
    with pytest.raises(schema.FeatureValidationError, match="may not contain spine field"):
        make_feature(extra={key: "forest"})


def test_spine_field_names_come_from_the_schema():
    """Hardcoding the list would leave a newly added spine field unprotected."""
    assert set(schema.required_property_names()) <= schema.spine_field_names()
    assert "subtype" in schema.spine_field_names()


def test_geometry_is_copied_not_aliased():
    """A shared dict would let one feature's geometry mutate another's."""
    geometry = dict(SQUARE)
    feature = make_feature().to_geojson_feature(geometry)
    geometry["type"] = "Point"
    assert feature["geometry"]["type"] == "Polygon"


# --- the TypeScript mirror ----------------------------------------------------------------------


def test_typescript_mirror_has_not_drifted():
    """`web/src/types/feature.ts` is hand-maintained against this schema.

    Nothing enforces the two stay aligned except this test, so it is the only thing standing
    between a schema change and a web app that silently reads a field that is no longer there.
    """
    ts_source = (schema.REPO_ROOT / "web" / "src" / "types" / "feature.ts").read_text(
        encoding="utf-8"
    )

    missing = [name for name in schema.required_property_names() if name not in ts_source]
    assert not missing, (
        f"{missing} are required by schema/feature.schema.json but absent from "
        f"web/src/types/feature.ts -- update the TypeScript mirror"
    )


def test_change_type_values_match_the_typescript_union():
    ts_source = (schema.REPO_ROOT / "web" / "src" / "types" / "feature.ts").read_text(
        encoding="utf-8"
    )
    for value in schema.load_schema()["$defs"]["properties"]["properties"]["change_type"]["enum"]:
        assert f"'{value}'" in ts_source, f"ChangeType in the TS mirror is missing {value!r}"


# --- the manifest -------------------------------------------------------------------------------
#
# Kept in this file rather than a test_manifest.py of its own: T-002 scopes tests to
# tests/test_schema.py, and manifest.py is the other half of the same pipeline-to-web contract.


def make_domain(domain_id="water", *, start=1984, end=2024, attribution="Source: EC JRC/Google"):
    class Fake(base.Domain):
        id = domain_id
        label = {"en": domain_id.title(), "zh": "水體"}

        @property
        def source(self):
            return base.SourceInfo(
                name="JRC GSW",
                version="1.4+1.5",
                attribution=attribution,
                citation="Pekel et al., Nature 540 (2016)",
                licence="Free to use with attribution",
            )

        @property
        def caveat(self):
            return "30 m resolution — ponds under ~0.5 ha may be missed."

        def temporal_range(self):
            return (start, end)

        def extract(self, aoi):
            return {"type": "FeatureCollection", "features": []}

    return Fake()


def test_build_produces_the_shape_the_web_app_reads():
    payload = manifest.build([make_domain()])

    assert payload["version"] == config.MANIFEST_VERSION
    entry = payload["domains"][0]
    assert entry["id"] == "water"
    assert entry["temporal"] == {"start": 1984, "end": 2024}
    assert entry["tiles"]["sourceLayer"] == "water"
    assert entry["hue"] == config.DOMAIN_HUES["water"]


def test_tiles_url_is_root_relative_so_dev_and_deploy_agree():
    url = manifest.tiles_url("forest")
    assert url.startswith("pmtiles:///"), url
    assert url.endswith("/forest.pmtiles"), url


def test_duplicate_ids_are_rejected():
    """Both would write data/<id>.pmtiles — one silently overwrites the other."""
    with pytest.raises(manifest.ManifestError, match="duplicate"):
        manifest.build([make_domain("water"), make_domain("water")])


def test_backwards_temporal_range_is_rejected():
    with pytest.raises(manifest.ManifestError, match="backwards"):
        manifest.build([make_domain(start=2024, end=1984)])


def test_missing_attribution_is_rejected():
    """A licence obligation the web app has no other source for."""
    with pytest.raises(manifest.ManifestError, match="attribution"):
        manifest.build([make_domain(attribution="")])


def test_write_creates_the_data_directory(tmp_path):
    destination = tmp_path / "nested" / "domains.json"
    written = manifest.write([make_domain()], path=destination)

    assert written == destination
    payload = json.loads(destination.read_text(encoding="utf-8"))
    assert payload["domains"][0]["id"] == "water"


def test_write_is_idempotent(tmp_path):
    """T-005 requires re-running the pipeline to produce identical output."""
    destination = tmp_path / "domains.json"
    manifest.write([make_domain()], path=destination)
    first = destination.read_text(encoding="utf-8")
    manifest.write([make_domain()], path=destination)

    assert destination.read_text(encoding="utf-8") == first


def test_written_file_keeps_cjk_readable(tmp_path):
    """ensure_ascii would turn 水體 into escapes, making the file unreviewable in a diff."""
    destination = tmp_path / "domains.json"
    manifest.write([make_domain()], path=destination)
    assert "水體" in destination.read_text(encoding="utf-8")


def test_written_file_ends_with_a_newline(tmp_path):
    destination = tmp_path / "domains.json"
    manifest.write([make_domain()], path=destination)
    assert destination.read_text(encoding="utf-8").endswith("\n")


def test_empty_domain_list_produces_a_valid_but_empty_manifest(tmp_path):
    """The web app reports this state itself; the writer's job is not to crash on it."""
    payload = manifest.build([])
    assert payload == {"version": config.MANIFEST_VERSION, "domains": []}
