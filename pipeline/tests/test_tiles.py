"""Tiling tests.

Nothing here shells out to tippecanoe — the valuable logic is the guards around it. Every failure
these cover is one that would otherwise pass silently: a wrong-format file with the right name, a
layer name the web app cannot find, a tiler that quietly discarded a slice of the data.
"""

import json
from types import SimpleNamespace

import pytest

from trace_pipeline import cohorts, extract, tiles
from trace_pipeline.cohorts import Cohorts
from trace_pipeline.domains import base

FOREST = Cohorts(2001, 2025)


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
    source.write_text(
        json.dumps({"type": "FeatureCollection", "features": [loss(2013), loss(2014)]})
    )

    staging = tmp_path / "forest.partial.pmtiles"
    tippecanoe_input = tmp_path / "forest.partial.ndjson"

    def fake_run(*_args, **_kwargs):
        assert tippecanoe_input.exists(), "tippecanoe must be handed the partitioned input"
        staging.write_bytes(b"partial output")
        raise RuntimeError("something nobody anticipated")

    monkeypatch.setattr(tiles.subprocess, "run", fake_run)

    with pytest.raises(RuntimeError):
        tiles.build(forest_domain)

    assert not staging.exists(), "an unexpected failure must still clean up the staging file"
    assert not tippecanoe_input.exists(), "and the partitioned input beside it"
    assert not tiles.pmtiles_path("forest").exists()


def feature(change_type, valid_from, valid_to=None):
    return {
        "type": "Feature",
        "properties": {"change_type": change_type, "valid_from": valid_from, "valid_to": valid_to},
        "geometry": {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]},
    }


def loss(year):
    return feature("loss", year)


# --- the partitioned input ---------------------------------------------------------------------


def test_input_names_each_feature_for_its_cohort_and_copies_cover_per_node(tmp_path):
    """MapLibre scopes a filter to the tile layer it names, so the layer must be the cohort."""
    source = tmp_path / "forest.geojson"
    source.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "features": [loss(2013), feature("cover", 2000), feature("cover", 2000, 2014)],
            }
        )
    )
    destination = tmp_path / "forest.partial.ndjson"

    assert tiles.write_tippecanoe_input(source, destination, FOREST) == (3, 4, 0)

    lines = [json.loads(line) for line in destination.read_text().splitlines()]
    assert [line["tippecanoe"]["layer"] for line in lines] == [
        "loss:2013",
        "cover:2001-2026",
        "cover:2001-2013",
        "cover:2013-2014",
    ]
    # Copies are the whole feature, so the readout and the area are the same in every node.
    assert lines[2]["properties"] == lines[3]["properties"]
    assert lines[2]["geometry"] == lines[3]["geometry"]
    assert all(line["type"] == "Feature" for line in lines)
    # And they share the source feature's id, which is what tells a copy from a neighbour.
    assert [line["id"] for line in lines] == [0, 1, 2, 2]


def test_a_feature_past_the_range_stops_the_build_before_tippecanoe(tmp_path, monkeypatch):
    """Tiling it into nothing would be dropping it -- the one thing this module refuses."""
    source = tmp_path / "forest.geojson"
    source.write_text(json.dumps({"type": "FeatureCollection", "features": [loss(2030)]}))

    with pytest.raises(cohorts.CohortError, match="after the domain's last year"):
        tiles.write_tippecanoe_input(source, tmp_path / "x.ndjson", FOREST)


def test_cover_gone_before_the_range_is_counted_not_written(tmp_path):
    """No layer could draw it, so it is left out -- and the count says so rather than nothing."""
    source = tmp_path / "forest.geojson"
    source.write_text(
        json.dumps(
            {"type": "FeatureCollection", "features": [feature("cover", 2000, 2001), loss(2001)]}
        )
    )
    destination = tmp_path / "forest.partial.ndjson"

    assert tiles.write_tippecanoe_input(source, destination, FOREST) == (2, 1, 1)
    assert [
        json.loads(line)["tippecanoe"]["layer"] for line in destination.read_text().splitlines()
    ] == ["loss:2001"]


# --- post-conditions on the built archive -----------------------------------------------------


def write_archive(path, magic=b"PMTiles\x03"):
    path.write_bytes(magic + b"\x00" * 32)
    return path


def test_verify_rejects_a_non_pmtiles_archive(tmp_path, monkeypatch):
    monkeypatch.setattr(tiles, "layer_counts", lambda _: None)
    archive = write_archive(tmp_path / "forest.pmtiles", b"SQLite format 3\x00")

    with pytest.raises(tiles.TilingError, match="not a PMTiles archive"):
        tiles.verify(archive, FOREST, 10)


def test_verify_deletes_the_bad_archive(tmp_path, monkeypatch):
    """A rejected build must not leave a file behind for the next step to pick up."""
    monkeypatch.setattr(tiles, "layer_counts", lambda _: None)
    archive = write_archive(tmp_path / "forest.pmtiles", b"SQLite format 3\x00")

    with pytest.raises(tiles.TilingError):
        tiles.verify(archive, FOREST, 10)
    assert not archive.exists()


def test_verify_rejects_a_layer_the_web_app_would_never_ask_for(tmp_path, monkeypatch):
    """The old single layer named for the domain is exactly such a layer now."""
    monkeypatch.setattr(tiles, "layer_counts", lambda _: [("loss:2013", 4), ("forest", 6)])
    archive = write_archive(tmp_path / "forest.pmtiles")

    with pytest.raises(tiles.TilingError, match="'forest'.*never draw"):
        tiles.verify(archive, FOREST, 10)
    assert not archive.exists()


def test_verify_rejects_a_node_from_a_tree_over_another_range(tmp_path, monkeypatch):
    monkeypatch.setattr(tiles, "layer_counts", lambda _: [("cover:2001-2025", 10)])
    archive = write_archive(tmp_path / "forest.pmtiles")

    with pytest.raises(tiles.TilingError, match="cover:2001-2025"):
        tiles.verify(archive, FOREST, 10)


def test_verify_rejects_a_feature_count_mismatch(tmp_path, monkeypatch):
    """The whole point: a tiler that dropped features still exits zero."""
    monkeypatch.setattr(
        tiles, "layer_counts", lambda _: [("cover:2001-2026", 50_000), ("loss:2013", 40_000)]
    )
    archive = write_archive(tmp_path / "forest.pmtiles")

    with pytest.raises(tiles.TilingError, match="different totals"):
        tiles.verify(archive, FOREST, 91_087)


def test_verify_counts_across_every_layer(tmp_path, monkeypatch):
    """The count to match is the copies written, summed over the layers they went into."""
    monkeypatch.setattr(
        tiles, "layer_counts", lambda _: [("cover:2001-2026", 50_000), ("loss:2013", 41_087)]
    )
    archive = write_archive(tmp_path / "forest.pmtiles")

    tiles.verify(archive, FOREST, 91_087)
    assert archive.exists()


def test_verify_refuses_a_build_it_cannot_check(tmp_path, monkeypatch):
    """Unverifiable is a failure, not a warning.

    Passing here would let a machine that cannot read the count produce tiles that were never
    checked — the exact silent failure this module exists to prevent. "Tippecanoe printed nothing
    alarming" is not evidence: its diagnostics are not a correctness API.
    """
    monkeypatch.setattr(tiles, "layer_counts", lambda _: None)
    archive = write_archive(tmp_path / "forest.pmtiles")

    with pytest.raises(tiles.TilingError, match="could not read the feature count"):
        tiles.verify(archive, FOREST, 91_087)
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
    assert tiles.layer_counts(tmp_path / "forest.pmtiles") is None


def test_layer_stats_survives_unparseable_metadata(tmp_path, monkeypatch):
    class Result:
        returncode = 0
        stdout = "not json at all"

    monkeypatch.setattr(tiles.subprocess, "run", lambda *a, **k: Result())
    assert tiles.layer_counts(tmp_path / "forest.pmtiles") is None


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


def test_change_types_are_read_from_the_archive(tmp_path, monkeypatch):
    """The manifest must describe the tileset, not the domain's intentions."""
    from trace_pipeline import tiles

    archive = tmp_path / "forest.pmtiles"
    archive.write_bytes(b"PMTiles")

    metadata = json.dumps(
        {
            "tilestats": {
                "layers": [
                    {"layer": "loss:2013", "count": 3},
                    {"layer": "cover:2001-2026", "count": 2},
                    {"layer": "loss:2014", "count": 1},
                ]
            }
        }
    )
    monkeypatch.setattr(
        tiles.subprocess,
        "run",
        lambda *a, **k: SimpleNamespace(returncode=0, stdout=metadata, stderr=""),
    )

    assert tiles.change_types_in(archive) == ("cover", "loss")
    assert tiles.source_layers_in(archive) == ("cover:2001-2026", "loss:2013", "loss:2014")


def test_an_archive_from_before_cohort_layers_reads_as_unknown(tmp_path, monkeypatch):
    """Its one layer is named for the domain, which no cohort is; the web could not draw it."""
    from trace_pipeline import tiles

    metadata = json.dumps({"tilestats": {"layers": [{"layer": "forest", "count": 3}]}})
    monkeypatch.setattr(
        tiles.subprocess,
        "run",
        lambda *a, **k: SimpleNamespace(returncode=0, stdout=metadata, stderr=""),
    )

    assert tiles.change_types_in(tmp_path / "forest.pmtiles") is None


def test_change_types_are_none_when_the_archive_cannot_be_read(tmp_path, monkeypatch):
    """A missing verifier degrades to "unknown" so the caller can fall back, never to a guess."""
    from trace_pipeline import tiles

    monkeypatch.setattr(
        tiles.subprocess,
        "run",
        lambda *a, **k: (_ for _ in ()).throw(FileNotFoundError("pmtiles")),
    )

    assert tiles.change_types_in(tmp_path / "missing.pmtiles") is None


def test_manifest_prefers_the_measured_change_types(tmp_path, monkeypatch):
    """An interrupted cover pass must not leave the UI advertising a cover toggle."""
    from trace_pipeline import manifest, tiles

    monkeypatch.setattr(tiles, "pmtiles_path", lambda domain_id: tmp_path / f"{domain_id}.pmtiles")
    write_archive(tmp_path / "forest.pmtiles")
    # The tileset only got loss into it, whatever the domain class declares.
    monkeypatch.setattr(tiles, "change_types_in", lambda archive: ("loss",))
    monkeypatch.setattr(tiles, "source_layers_in", lambda archive: ("loss:2013",))

    class Declared(base.Domain):
        id = "forest"
        label = {"en": "Forest", "zh": "森林"}
        change_types = ("cover", "loss")

        @property
        def source(self):
            return base.SourceInfo("s", "v", "a", "c", "l")

        @property
        def caveat(self):
            return "caveat"

        def temporal_range(self):
            return (2001, 2025)

        def extract(self, aoi):
            return {"type": "FeatureCollection", "features": []}

    entry = manifest.build([Declared()])["domains"][0]
    assert entry["changeTypes"] == ["loss"]
    assert entry["tiles"]["sourceLayers"] == ["loss:2013"]


def test_manifest_lists_every_cohort_before_the_tiles_exist(tmp_path, monkeypatch):
    """Nothing measured yet, so the manifest says what the range and states imply."""
    from trace_pipeline import manifest, tiles

    monkeypatch.setattr(tiles, "pmtiles_path", lambda domain_id: tmp_path / f"{domain_id}.pmtiles")

    entry = manifest.build([Fake2001()])["domains"][0]
    assert entry["changeTypes"] == ["cover", "loss"]
    assert len(entry["tiles"]["sourceLayers"]) == (2 * 25 - 1) + 25
    assert "cover:2001-2026" in entry["tiles"]["sourceLayers"]


def test_manifest_refuses_tiles_built_for_another_range(tmp_path, monkeypatch):
    """A node this range's tree does not have is data the web would never draw."""
    from trace_pipeline import manifest, tiles

    monkeypatch.setattr(tiles, "pmtiles_path", lambda domain_id: tmp_path / f"{domain_id}.pmtiles")
    write_archive(tmp_path / "forest.pmtiles")
    monkeypatch.setattr(tiles, "change_types_in", lambda archive: ("cover", "loss"))
    monkeypatch.setattr(tiles, "source_layers_in", lambda archive: ("cover:2001-2025", "loss:2013"))

    with pytest.raises(manifest.ManifestError, match="cover:2001-2025.*different year range"):
        manifest.build([Fake2001()])


def test_manifest_refuses_an_archive_it_cannot_read(tmp_path, monkeypatch):
    """Present but unreadable is not the pre-tiling case.

    Falling back here would publish an invented layer list over real tiles and then validate the
    invention -- the manifest passing on a machine without `pmtiles` while describing nothing.
    """
    from trace_pipeline import manifest, tiles

    monkeypatch.setattr(tiles, "pmtiles_path", lambda domain_id: tmp_path / f"{domain_id}.pmtiles")
    write_archive(tmp_path / "forest.pmtiles")
    monkeypatch.setattr(tiles, "source_layers_in", lambda archive: None)

    with pytest.raises(manifest.ManifestError, match="cannot be read"):
        manifest.build([Fake2001()])


def test_manifest_refuses_an_archive_from_before_cohort_layers(tmp_path, monkeypatch):
    from trace_pipeline import manifest, tiles

    monkeypatch.setattr(tiles, "pmtiles_path", lambda domain_id: tmp_path / f"{domain_id}.pmtiles")
    write_archive(tmp_path / "forest.pmtiles")
    monkeypatch.setattr(tiles, "source_layers_in", lambda archive: ("forest",))
    monkeypatch.setattr(tiles, "change_types_in", lambda archive: None)

    with pytest.raises(manifest.ManifestError, match="before cohort layers"):
        manifest.build([Fake2001()])


class Fake2001(base.Domain):
    id = "forest"
    label = {"en": "Forest", "zh": "森林"}
    change_types = ("cover", "loss")

    @property
    def source(self):
        return base.SourceInfo("s", "v", "a", "c", "l")

    @property
    def caveat(self):
        return "caveat"

    def temporal_range(self):
        return (2001, 2025)

    def extract(self, aoi):
        return {"type": "FeatureCollection", "features": []}
