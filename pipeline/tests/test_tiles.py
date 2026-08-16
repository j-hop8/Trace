"""Tiling tests.

Nothing here shells out to tippecanoe — the valuable logic is the guards around it. Every failure
these cover is one that would otherwise pass silently: a wrong-format file with the right name, a
layer name the web app cannot find, a tiler that quietly discarded a slice of the data.
"""

import json

import pytest

from trace_pipeline import extract, tiles
from trace_pipeline.domains import base


@pytest.fixture
def forest_domain():
    class Fake(base.Domain):
        id = "forest"
        label = {"en": "Forest", "zh": "森林"}

        @property
        def source(self):
            return base.SourceInfo("Hansen", "v1.13", "Hansen et al.", "Science 342", "CC-BY-4.0")

        @property
        def caveat(self):
            return "Tree-cover loss, not deforestation."

        def temporal_range(self):
            return (2001, 2025)

        def extract(self, aoi):
            return {"type": "FeatureCollection", "features": []}

    return Fake()


# --- the toolchain guard ---------------------------------------------------------------------


def test_missing_tippecanoe_says_how_to_install_it(monkeypatch):
    monkeypatch.setattr(tiles.shutil, "which", lambda _: None)
    with pytest.raises(tiles.TilingError, match="brew install tippecanoe"):
        tiles.require_tippecanoe()


def test_missing_geojson_points_at_the_extraction_step(monkeypatch, tmp_path, forest_domain):
    monkeypatch.setattr(tiles.shutil, "which", lambda _: "/usr/bin/tippecanoe")
    monkeypatch.setattr(extract, "DATA_DIR", tmp_path)

    with pytest.raises(tiles.TilingError, match="extract forest"):
        tiles.build(forest_domain)


# --- the staging filename ---------------------------------------------------------------------


def test_staging_file_keeps_the_pmtiles_extension(tmp_path, monkeypatch):
    """Regression: tippecanoe picks its output format from the extension.

    Staging as `forest.pmtiles.partial` gave the file extension `.partial`, so tippecanoe wrote
    MBTiles, which was then renamed to `.pmtiles` — the wrong format under the right name, which
    every later step would have trusted. The staging name must still end in .pmtiles.
    """
    monkeypatch.setattr(extract, "DATA_DIR", tmp_path)
    destination = tiles.pmtiles_path("forest")
    staging = destination.with_name("forest.partial.pmtiles")

    assert staging.suffix == ".pmtiles", "staging name must end in .pmtiles or the format flips"
    assert staging != destination


def test_output_path_matches_the_manifest_url(tmp_path, monkeypatch):
    """The manifest points at pmtiles:///data/<id>.pmtiles — the file has to actually be there."""
    monkeypatch.setattr(extract, "DATA_DIR", tmp_path)
    assert tiles.pmtiles_path("forest").name == "forest.pmtiles"


def test_a_failed_build_leaves_no_staging_file(tmp_path, monkeypatch, forest_domain):
    """Whatever goes wrong, the next run must not find a half-written archive to trust."""
    monkeypatch.setattr(extract, "DATA_DIR", tmp_path)
    monkeypatch.setattr(tiles.shutil, "which", lambda _: "/usr/bin/tippecanoe")

    source = tmp_path / "forest.geojson"
    source.write_text(json.dumps({"type": "FeatureCollection", "features": [{}, {}]}))

    staging = tmp_path / "forest.partial.pmtiles"

    def fake_run(*_args, **_kwargs):
        staging.write_bytes(b"partial output")
        raise RuntimeError("something nobody anticipated")

    monkeypatch.setattr(tiles.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError):
        tiles.build(forest_domain)

    assert not staging.exists(), "an unexpected failure must still clean up the staging file"
    assert not tiles.pmtiles_path("forest").exists()


# --- post-conditions on the built archive -----------------------------------------------------


def write_archive(path, magic=b"PMTiles\x03"):
    path.write_bytes(magic + b"\x00" * 32)
    return path


def test_verify_rejects_a_non_pmtiles_archive(tmp_path, monkeypatch):
    monkeypatch.setattr(tiles, "_layer_stats", lambda _: None)
    archive = write_archive(tmp_path / "forest.pmtiles", b"SQLite format 3\x00")

    with pytest.raises(tiles.TilingError, match="not a PMTiles archive"):
        tiles.verify(archive, "forest", 10)


def test_verify_deletes_the_bad_archive(tmp_path, monkeypatch):
    """A rejected build must not leave a file behind for the next step to pick up."""
    monkeypatch.setattr(tiles, "_layer_stats", lambda _: None)
    archive = write_archive(tmp_path / "forest.pmtiles", b"SQLite format 3\x00")

    with pytest.raises(tiles.TilingError):
        tiles.verify(archive, "forest", 10)
    assert not archive.exists()


def test_verify_rejects_a_layer_name_the_web_app_cannot_find(tmp_path, monkeypatch):
    monkeypatch.setattr(tiles, "_layer_stats", lambda _: ("trees", 10))
    archive = write_archive(tmp_path / "forest.pmtiles")

    with pytest.raises(tiles.TilingError, match="sourceLayer"):
        tiles.verify(archive, "forest", 10)


def test_verify_rejects_a_feature_count_mismatch(tmp_path, monkeypatch):
    """The whole point: a tiler that dropped features still exits zero."""
    monkeypatch.setattr(tiles, "_layer_stats", lambda _: ("forest", 90_000))
    archive = write_archive(tmp_path / "forest.pmtiles")

    with pytest.raises(tiles.TilingError, match="different totals"):
        tiles.verify(archive, "forest", 91_087)


def test_verify_passes_when_everything_matches(tmp_path, monkeypatch):
    monkeypatch.setattr(tiles, "_layer_stats", lambda _: ("forest", 91_087))
    archive = write_archive(tmp_path / "forest.pmtiles")

    tiles.verify(archive, "forest", 91_087)
    assert archive.exists()


def test_verify_refuses_a_build_it_cannot_check(tmp_path, monkeypatch):
    """Unverifiable is a failure, not a warning.

    Passing here would let a machine that cannot read the count produce tiles that were never
    checked — the exact silent failure this module exists to prevent. "Tippecanoe printed nothing
    alarming" is not evidence: its diagnostics are not a correctness API.
    """
    monkeypatch.setattr(tiles, "_layer_stats", lambda _: None)
    archive = write_archive(tmp_path / "forest.pmtiles")

    with pytest.raises(tiles.TilingError, match="could not read the feature count"):
        tiles.verify(archive, "forest", 91_087)
    assert not archive.exists()


def test_pmtiles_is_required_not_optional(monkeypatch):
    """It is how the count is read back, so a machine without it must not build at all."""
    monkeypatch.setattr(tiles.shutil, "which", lambda name: None if name == "pmtiles" else "/bin/x")

    with pytest.raises(tiles.TilingError, match="cannot be verified"):
        tiles.require_pmtiles()


def test_missing_pmtiles_fails_before_the_tiling_run(monkeypatch, tmp_path, forest_domain):
    """Fail in a second, not after 40 seconds of tiling that is about to be thrown away."""
    monkeypatch.setattr(extract, "DATA_DIR", tmp_path)
    monkeypatch.setattr(
        tiles.shutil, "which", lambda name: None if name == "pmtiles" else "/bin/tippecanoe"
    )

    def must_not_run(*_a, **_k):
        raise AssertionError("tippecanoe ran despite pmtiles being unavailable")

    monkeypatch.setattr(tiles.subprocess, "run", must_not_run)

    with pytest.raises(tiles.TilingError, match="cannot be verified"):
        tiles.build(forest_domain)


def test_layer_stats_returns_none_when_pmtiles_is_not_installed(tmp_path, monkeypatch):
    """`check=False` does not cover a missing binary — subprocess.run still raises.

    Unhandled, that escapes verify(), propagates out of build(), and strands the staging file on
    a machine whose only fault is lacking an optional tool. The verifier must degrade to
    "unchecked", never take down a build whose output is fine.
    """

    def missing_binary(*_args, **_kwargs):
        raise FileNotFoundError(2, "No such file or directory", "pmtiles")

    monkeypatch.setattr(tiles.subprocess, "run", missing_binary)
    assert tiles._layer_stats(tmp_path / "forest.pmtiles") is None


def test_layer_stats_survives_unparseable_metadata(tmp_path, monkeypatch):
    class Result:
        returncode = 0
        stdout = "not json at all"

    monkeypatch.setattr(tiles.subprocess, "run", lambda *a, **k: Result())
    assert tiles._layer_stats(tmp_path / "forest.pmtiles") is None


# --- the no-loss contract ----------------------------------------------------------------------


def test_lossy_strategies_are_never_passed_to_tippecanoe():
    """Dropping features would silently change the hectare totals the UI states as fact."""
    forbidden = (
        "--drop-densest-as-needed",
        "--drop-smallest-as-needed",
        "--drop-fraction-as-needed",
        "--coalesce-densest-as-needed",
        "--drop-polygons",
    )
    flags = " ".join(tiles.NO_LOSS_FLAGS)
    for flag in forbidden:
        assert flag not in flags


def test_size_escape_hatches_are_disabled():
    """Tippecanoe's defaults discard features to fit tile budgets; all three must be off."""
    for flag in ("--no-feature-limit", "--no-tile-size-limit", "--no-tiny-polygon-reduction"):
        assert flag in tiles.NO_LOSS_FLAGS


def test_loss_markers_cover_tippecanoes_drop_vocabulary():
    for phrase in ("dropping", "Try using --drop"):
        assert any(marker in phrase or phrase in marker for marker in tiles.LOSS_MARKERS)


def test_zoom_range_reaches_the_island_view():
    """Loss must be visible when Taiwan fits the screen (~z7), not only when zoomed in."""
    assert tiles.MIN_ZOOM <= 7 <= tiles.MAX_ZOOM


def test_count_features_reads_the_collection(tmp_path):
    path = tmp_path / "x.geojson"
    path.write_text(json.dumps({"type": "FeatureCollection", "features": [{}, {}, {}]}))
    assert tiles.count_features(path) == 3
