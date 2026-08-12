"""The Domain contract is what keeps domains interchangeable -- so test the contract itself."""

import pytest

from trace_pipeline import config
from trace_pipeline.domains import base


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


def test_domain_cannot_be_instantiated_without_implementing_the_contract():
    class Incomplete(base.Domain):
        id = "incomplete"
        label = {"en": "Incomplete"}

    with pytest.raises(TypeError):
        Incomplete()


def test_manifest_entry_matches_the_web_contract(fake_domain_cls):
    entry = fake_domain_cls().manifest_entry("pmtiles://water.pmtiles")

    assert entry["id"] == "water"
    assert entry["label"]["zh"] == "水體"
    assert entry["hue"] == config.DOMAIN_HUES["water"]
    assert entry["temporal"] == {"start": 1984, "end": 2021}
    assert entry["tiles"] == {"url": "pmtiles://water.pmtiles", "sourceLayer": "water"}
    # Attribution must survive into the manifest verbatim -- it is a licence obligation, and the
    # web app has no other source for it.
    assert entry["source"]["attribution"] == "Source: EC JRC/Google"
    assert entry["caveat"]


def test_temporal_range_flows_into_the_manifest(fake_domain_cls):
    """A fallback to a shorter source must show up in the manifest, since the slider reads it."""

    class Truncated(fake_domain_cls):
        def temporal_range(self):
            return (1984, 2021)

    class Extended(fake_domain_cls):
        def temporal_range(self):
            return (1984, 2024)

    assert Truncated().manifest_entry("x")["temporal"]["end"] == 2021
    assert Extended().manifest_entry("x")["temporal"]["end"] == 2024


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
