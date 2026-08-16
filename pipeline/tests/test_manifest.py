"""The manifest is the only thing telling the web app which domains exist.

A domain missing from it is invisible in the UI, and a malformed entry produces a blank map with
no error — so the checks here are about failures that would otherwise be silent.
"""

import json

import pytest

from trace_pipeline import config, manifest
from trace_pipeline.domains import base


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
