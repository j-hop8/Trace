"""The Domain contract is what keeps domains interchangeable -- so test the contract itself."""

import pytest

import trace_pipeline.domains as domains
from trace_pipeline import config, schema, tiles
from trace_pipeline.domains import base, water


@pytest.fixture
def fake_domain_cls():
    """A minimal Domain implementation, registered under a real hue so manifest assembly works."""

    class FakeWater(base.Domain):
        id = "water"
        label = {"en": "Water", "zh": "水體"}

        @property
        def source(self):
            return base.SourceInfo(
                name="JRC GSW",
                version="1.4",
                attribution="Source: EC JRC/Google",
                citation="Pekel et al., Nature 540 (2016)",
                licence="Free to use with attribution",
            )

        @property
        def caveat(self):
            return "30 m resolution — ponds under ~0.5 ha may be missed."

        def temporal_range(self):
            return (1984, 2021)

        def extract(self, aoi):
            return {"type": "FeatureCollection", "features": []}

    return FakeWater


#: Markup that renders as literal punctuation. `web/src/components/Attribution.tsx` puts the
#: caveat on the page as `{entry.caveat}` -- a text node, deliberately: the string comes from the
#: pipeline and interpreting it as markup would mean either a parser or `dangerouslySetInnerHTML`
#: for the sake of one emphasised word. So the contract is that a caveat is plain prose, and it is
#: enforced on the side that can be enforced.
_MARKUP = ("*", "`", "](")


@pytest.mark.parametrize("domain_id", domains.all_ids())
def test_declared_change_types_are_in_the_schema(domain_id):
    allowed = set(schema.load_schema()["$defs"]["properties"]["properties"]["change_type"]["enum"])
    assert set(domains.get(domain_id).change_types) <= allowed


@pytest.mark.parametrize("domain_id", domains.all_ids())
def test_caveat_is_plain_prose_not_markup(domain_id, monkeypatch):
    """Water's caveat shipped `*ended*` and readers saw the asterisks.

    Emphasis was the right instinct -- "Water the source says ended is kept there" is hard to
    parse without it -- but the fix is prose that does not need emphasis ("says has ended"), not
    markup in a field nothing parses. Every domain, so the next caveat cannot reintroduce it.
    """
    monkeypatch.setattr(water, "gsw_v15_reachable", lambda: False)
    monkeypatch.setattr(water, "_resolved_gsw", None)

    caveat = domains.get(domain_id).caveat

    for token in _MARKUP:
        assert token not in caveat, (
            f"{domain_id}'s caveat contains {token!r}; Attribution.tsx renders it as text, so the "
            f"reader sees the character. Rewrite the sentence instead."
        )


def test_domain_cannot_be_instantiated_without_implementing_the_contract():
    class Incomplete(base.Domain):
        id = "incomplete"
        label = {"en": "Incomplete"}

    with pytest.raises(TypeError):
        Incomplete()


def test_manifest_entry_matches_the_web_contract(fake_domain_cls):
    entry = fake_domain_cls().manifest_entry("pmtiles://water.pmtiles", ("loss",), ("loss:1984",))

    assert entry["id"] == "water"
    assert entry["label"]["zh"] == "水體"
    assert entry["hue"] == config.DOMAIN_HUES["water"]
    assert entry["temporal"] == {"start": 1984, "end": 2021}
    assert entry["tiles"] == {
        "url": "pmtiles://water.pmtiles",
        "sourceLayers": ["loss:1984"],
        "detailZoom": config.DETAIL_ZOOM,
    }
    # Attribution must survive into the manifest verbatim -- it is a licence obligation, and the
    # web app has no other source for it.
    assert entry["source"]["attribution"] == "Source: EC JRC/Google"
    # The domain's own caveat first, then the tiling's -- every domain's tiles pool the same way,
    # so the sentence is added once here rather than remembered per domain.
    assert entry["caveat"].startswith(fake_domain_cls().caveat)
    assert entry["caveat"].endswith(tiles.ISLAND_CAVEAT)
    # A categorical domain measures nothing, so it publishes no ramp.
    assert "measure" not in entry


def test_temporal_range_flows_into_the_manifest(fake_domain_cls):
    """A fallback to a shorter source must show up in the manifest, since the slider reads it."""

    class Truncated(fake_domain_cls):
        def temporal_range(self):
            return (1984, 2021)

    class Extended(fake_domain_cls):
        def temporal_range(self):
            return (1984, 2024)

    assert Truncated().manifest_entry("x", ("loss",), ())["temporal"]["end"] == 2021
    assert Extended().manifest_entry("x", ("loss",), ())["temporal"]["end"] == 2024


def test_registry_round_trip(monkeypatch, fake_domain_cls):
    monkeypatch.setattr(base, "_REGISTRY", {})
    base.register(fake_domain_cls)

    assert base.all_ids() == ["water"]
    assert isinstance(base.get("water"), fake_domain_cls)


def test_registry_rejects_duplicate_ids(monkeypatch, fake_domain_cls):
    """Two modules claiming the same id would silently shadow each other's tiles."""
    monkeypatch.setattr(base, "_REGISTRY", {})
    base.register(fake_domain_cls)

    with pytest.raises(ValueError, match="already registered"):
        base.register(fake_domain_cls)


def test_registry_reports_known_ids_on_miss(monkeypatch, fake_domain_cls):
    monkeypatch.setattr(base, "_REGISTRY", {})
    base.register(fake_domain_cls)

    with pytest.raises(KeyError, match="water"):
        base.get("coast")


# --- measured domains ---------------------------------------------------------------------------

ANOMALY = base.Measure(
    key="temp_anomaly_c",
    unit="°C",
    label={"en": "Temperature anomaly", "zh": "年均溫距平"},
    breaks=(-1.0, -0.5, 0.0, 0.5, 1.0, 1.5),
    baseline="1991–2020 normal",
    readout=(base.ReadoutValue("temp_mean_c", "°C", {"en": "Annual mean", "zh": "年均溫"}),),
)


@pytest.fixture
def level_domain_cls(fake_domain_cls):
    class FakeTemperature(fake_domain_cls):
        id = "temperature"
        label = {"en": "Temperature", "zh": "氣溫"}
        needs_earth_engine = False
        change_types = ("level",)
        measure = ANOMALY

    return FakeTemperature


def test_a_measure_is_published_with_the_levels_it_describes(level_domain_cls):
    entry = level_domain_cls().manifest_entry("x", ("level",), ("level:1984-1985",))
    assert entry["measure"] == {
        "key": "temp_anomaly_c",
        "unit": "°C",
        "label": {"en": "Temperature anomaly", "zh": "年均溫距平"},
        "breaks": [-1.0, -0.5, 0.0, 0.5, 1.0, 1.5],
        "baseline": "1991–2020 normal",
        "readout": [
            {"key": "temp_mean_c", "unit": "°C", "label": {"en": "Annual mean", "zh": "年均溫"}}
        ],
    }


def test_no_measure_is_published_for_an_archive_without_levels(level_domain_cls):
    """Measured like the states: a legend for a ramp that is not on the map is an aspiration."""
    assert "measure" not in level_domain_cls().manifest_entry("x", (), ())


def test_a_measure_counts_one_more_band_than_breaks():
    assert ANOMALY.bands == 7


@pytest.mark.parametrize(
    "breaks,fragment",
    [
        ((), "no breaks"),
        ((0.0, 0.0), "ascend"),
        ((1.0, 0.5), "ascend"),
        ((float("nan"),), "finite"),
    ],
)
def test_a_measure_refuses_breaks_that_cannot_class_anything(breaks, fragment):
    with pytest.raises(ValueError, match=fragment):
        base.Measure(key="k", unit="u", label={"en": "k", "zh": "k"}, breaks=breaks)


def test_the_manifest_refuses_levels_without_a_measure(level_domain_cls, monkeypatch, tmp_path):
    from trace_pipeline import manifest

    class Unmeasured(level_domain_cls):
        measure = None

    monkeypatch.setattr(tiles, "pmtiles_path", lambda domain_id: tmp_path / f"{domain_id}.pmtiles")
    with pytest.raises(manifest.ManifestError, match="declares no `measure`"):
        manifest.build([Unmeasured()])
    assert manifest.build([level_domain_cls()])["domains"][0]["measure"]["key"] == "temp_anomaly_c"
