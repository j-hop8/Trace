"""The CLI is the documented entry point, so its contract is worth pinning down.

These tests deliberately run against an empty domain registry -- that is the scaffold's real
state until T-003 and T-004 land, and "the build command does something sensible when nothing is
registered yet" is exactly what broke the first time.
"""

import pytest

from trace_pipeline import cli
from trace_pipeline.domains import base


@pytest.fixture(autouse=True)
def empty_registry(monkeypatch):
    monkeypatch.setattr(base, "_REGISTRY", {})


def test_parser_requires_a_subcommand():
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args([])


def test_version_flag_exits_cleanly():
    with pytest.raises(SystemExit) as excinfo:
        cli.build_parser().parse_args(["--version"])
    assert excinfo.value.code == 0


@pytest.mark.parametrize("command", ["list", "extract", "tiles", "all"])
def test_every_documented_command_parses(command):
    args = cli.build_parser().parse_args([command])
    assert callable(args.func)


def test_all_carries_a_domain_attribute():
    """cmd_all delegates to cmd_extract/cmd_tiles, which both read args.domain."""
    assert cli.build_parser().parse_args(["all"]).domain is None


def test_list_succeeds_on_an_empty_registry(capsys):
    assert cli.main(["list"]) == 0
    assert "No domains are registered." in capsys.readouterr().out


def test_all_fails_loudly_when_nothing_is_registered(capsys):
    """Exiting 0 here would report a successful build that produced no tiles."""
    assert cli.main(["all"]) == 1

    stderr = capsys.readouterr().err
    assert "nothing to build" in stderr
    assert "T-003" in stderr, "the message should say where the missing domains come from"


@pytest.mark.parametrize("command", ["extract", "tiles"])
def test_extract_and_tiles_fail_before_importing_heavy_modules(command, capsys):
    """The empty-registry guard must come first -- otherwise these raise ImportError instead.

    `extract` and `tiles` import Earth Engine and tippecanoe wrappers lazily, so an ordering slip
    would turn a clear message into a traceback about a missing module.
    """
    assert cli.main([command]) == 1
    assert "nothing to build" in capsys.readouterr().err


def test_registered_domain_appears_in_listing(capsys, monkeypatch):
    class FakeForest(base.Domain):
        id = "forest"
        label = {"en": "Forest", "zh": "森林"}

        @property
        def source(self):
            return base.SourceInfo(
                name="Hansen GFC",
                version="1.13",
                attribution="Hansen et al.",
                citation="Hansen et al., Science 342 (2013)",
                licence="CC-BY-4.0",
            )

        @property
        def caveat(self):
            return "Tree-cover loss, not deforestation."

        def temporal_range(self):
            return (2000, 2025)

        def extract(self, aoi):
            return {"type": "FeatureCollection", "features": []}

    base.register(FakeForest)

    assert cli.main(["list"]) == 0
    out = capsys.readouterr().out
    assert "forest" in out
    assert "2000-2025" in out
    assert "Hansen GFC" in out
