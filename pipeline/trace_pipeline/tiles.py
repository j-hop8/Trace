"""Turn a domain's GeoJSON into one PMTiles file.

**Nothing may be dropped.** Tippecanoe's defaults are tuned for cartography: when a tile grows too
large it discards features, and at low zoom it merges tiny polygons into dots. Both are sensible
for a basemap and unacceptable here, because the numbers this map reports — hectares lost, patch
counts — are the product's actual claim. A tiler quietly binning 5% of the smallest patches would
make the map disagree with the caveat that states how much it shows, and nothing would say so.

So the size-limit escapes are disabled rather than the drop-strategies enabled, and the result is
verified against the input count rather than assumed. If the output is ever too large, the honest
fix is to raise the minimum mapping unit deliberately and restate the retained percentage — not
to let the tiler decide which data the reader gets.

**Every feature goes into the tile layer of its cohort** (`cohorts.py`), not into one layer named
after the domain. The web draws a domain as hundreds of style layers, one per cohort, and
MapLibre's worker runs each style layer's filter over every feature of the tile layer it names —
so one layer per domain meant every feature was filtered hundreds of times per tile, and the
opening view took minutes to parse. Cover features are written once per node of the interval tree
that covers them, so the tile holds more features than the GeoJSON; the count that is verified is
the count of *copies* this module chose to write, which is how "nothing dropped" stays checkable.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any

from trace_pipeline import cohorts as cohorts_module
from trace_pipeline import extract
from trace_pipeline.cohorts import Cohorts

if TYPE_CHECKING:
    from trace_pipeline.domains.base import Domain

#: Below this the patches are far smaller than a pixel and the layer says nothing useful; above
#: it, the basemap extract stops. Matching the basemap's ceiling keeps the two in step.
MIN_ZOOM = 5
MAX_ZOOM = 14

#: Flags that exist purely to stop tippecanoe from silently discarding data.
NO_LOSS_FLAGS = [
    "--no-feature-limit",  # default caps a tile at 200k features and drops the rest
    "--no-tile-size-limit",  # default caps a tile at 500 KB and drops the rest
    "--no-tiny-polygon-reduction",  # default merges sub-pixel polygons into dots at low zoom
]

#: Geometry simplification keeps every feature and only reduces vertex counts, so it is the one
#: size lever that costs no data.
SIMPLIFICATION = 4

#: Substrings tippecanoe prints when it has thrown data away.
#:
#: An *early warning*, never the guarantee. Diagnostic text is not a stable correctness API: the
#: wording can change between releases and a discard mode nobody has seen yet would print
#: something not in this list. The guarantee is the tilestats count in :func:`verify`, which
#: compares what landed in the archive against what went in. This just fails faster, with a more
#: specific message, in the cases it does recognise.
LOSS_MARKERS = ("dropping", "dropped", "Try using --drop", "polygon dust")


class TilingError(RuntimeError):
    """Raised when tiles cannot be built, or were built lossily."""


def require_tippecanoe() -> str:
    path = shutil.which("tippecanoe")
    if not path:
        raise TilingError(
            "tippecanoe is not on PATH.\n"
            "  macOS:  brew install tippecanoe\n"
            "  Linux:  build from https://github.com/felt/tippecanoe\n"
            "It converts the extracted GeoJSON into the PMTiles the web app reads."
        )
    return path


def require_pmtiles() -> str:
    """The `pmtiles` CLI, required — not optional.

    It is how the built archive's feature count is read back, and that count is the only real
    guarantee that nothing was discarded. Treating it as optional would mean a machine without it
    produces tiles that pass without the count ever being checked, which is precisely the silent
    failure this module exists to prevent. Better to refuse to build than to build unverified.
    """
    path = shutil.which("pmtiles")
    if not path:
        raise TilingError(
            "pmtiles is not on PATH, so the tiled feature count cannot be verified.\n"
            "  macOS:  brew install pmtiles\n"
            "  any OS: GOBIN=/usr/local/bin go install github.com/protomaps/go-pmtiles@latest\n"
            "          (installs as `go-pmtiles`; symlink or rename it to `pmtiles`)\n"
            "This is required rather than optional: the count check is what proves the tiler did "
            "not silently discard features, and the map's area totals depend on it."
        )
    return path


def pmtiles_path(domain_id: str) -> Path:
    return extract.DATA_DIR / f"{domain_id}.pmtiles"


def write_tippecanoe_input(
    geojson: Path, destination: Path, cohorts: Cohorts
) -> tuple[int, int, int]:
    """Rewrite the collection as one line per tile feature, each naming its cohort's layer.

    Tippecanoe reads newline-delimited features and honours a per-feature `tippecanoe.layer`, so
    this is how a feature is steered into its cohort's layer -- and how a cover feature is written
    once per interval node it belongs to. Returns `(source features, tile features written,
    source features with no cohort)`; the second is what the built archive is checked against,
    because it is the number of features this step *decided* to tile, and a tiler that lost any
    of them is what the check exists to catch. The third is cover that ended before the range
    began, which no layer could draw (`Cohorts.layers_for`); it is reported, never silent.

    Every copy carries the source feature's position in the collection as its `id`, which
    tippecanoe keeps as the tile feature's id. It is the only thing that tells a copy from a
    neighbour: single-pixel patches share every attribute, and tippecanoe simplifies each layer
    on its own, so two copies of one feature can differ in tile geometry. The web's tiles test
    counts a feature once by it.

    Loads the document rather than streaming it: the extraction step already holds the whole
    collection in memory, so this adds no new ceiling.

    Raises `CohortError` before tippecanoe runs for a feature that begins after the range ends.
    """
    with geojson.open(encoding="utf-8") as handle:
        features = json.load(handle)["features"]

    written = 0
    unplaced = 0
    with destination.open("w", encoding="utf-8") as out:
        for index, feature in enumerate(features):
            layers = cohorts.layers_for(feature["properties"])
            if not layers:
                unplaced += 1
                continue
            for layer in layers:
                record = {
                    "type": "Feature",
                    "id": index,
                    "tippecanoe": {"layer": layer},
                    "properties": feature["properties"],
                    "geometry": feature["geometry"],
                }
                out.write(json.dumps(record))
                out.write("\n")
                written += 1

    return len(features), written, unplaced


def build(domain: Domain) -> Path:
    """Build `data/<domain>.pmtiles`. Returns the path written."""
    tippecanoe = require_tippecanoe()
    # Checked up front, not after a 40-second tiling run, so a missing tool fails immediately.
    require_pmtiles()

    source = extract.geojson_path(domain.id)
    if not source.exists():
        raise TilingError(
            f"{source} does not exist — run extraction first:\n"
            f"  python -m trace_pipeline.cli extract {domain.id}"
        )

    # The same range the manifest will publish, so the tree the tile layers are named after is the
    # tree the web builds from `temporal`. For water this probes Earth Engine once, exactly as the
    # manifest step does; the alternative -- reading the range off the data -- would let the two
    # drift, and a node the web never asks for is data that silently never draws.
    cohorts = Cohorts(*domain.temporal_range())
    destination = pmtiles_path(domain.id)

    # Write beside the target and move on success, so a failed or interrupted run never leaves a
    # half-written archive for the next step to pick up and trust.
    #
    # The staging name must still END in .pmtiles: tippecanoe chooses its output format from the
    # extension, so `forest.pmtiles.partial` silently produced MBTiles, which then got renamed to
    # .pmtiles — the wrong format under the right name, which every later step would have believed.
    staging = destination.with_name(f"{domain.id}.partial.pmtiles")
    staging.unlink(missing_ok=True)
    tippecanoe_input = staging.with_suffix(".ndjson")

    command = [
        tippecanoe,
        "--output",
        str(staging),
        # Only a feature with no `tippecanoe.layer` of its own would land here, and every feature
        # is given one -- so this layer never exists, and `verify` rejects the archive if it does.
        "--layer",
        domain.id,
        "--minimum-zoom",
        str(MIN_ZOOM),
        "--maximum-zoom",
        str(MAX_ZOOM),
        f"--simplification={SIMPLIFICATION}",
        *NO_LOSS_FLAGS,
        "--force",
        str(tippecanoe_input),
    ]

    # One cleanup path for every failure, rather than an unlink beside each raise. The acceptance
    # criterion is that a failed run leaves no half-written archive behind, and that has to hold
    # for the exceptions nobody anticipated too — not only the ones with a matching `except`.
    try:
        source_count, expected, unplaced = write_tippecanoe_input(source, tippecanoe_input, cohorts)
        print(
            f"[{domain.id}] tiling {source_count:,} features as {expected:,} cohort copies…",
            flush=True,
        )
        if unplaced:
            print(
                f"[{domain.id}] {unplaced:,} cover features end before {cohorts.first_year} and "
                f"have no year the map can show; left out of the tiles.",
                flush=True,
            )

        result = subprocess.run(command, capture_output=True, text=True, check=False)
        output = f"{result.stdout}\n{result.stderr}"

        if result.returncode != 0:
            raise TilingError(f"tippecanoe failed for {domain.id}:\n{output.strip()}")

        lost = [line for line in output.splitlines() if any(m in line for m in LOSS_MARKERS)]
        if lost:
            raise TilingError(
                f"tippecanoe discarded features for {domain.id}, so the tiles would disagree "
                f"with the areas the UI reports:\n  " + "\n  ".join(lost[:5])
            )

        verify(staging, cohorts, expected)
    except BaseException:
        staging.unlink(missing_ok=True)
        raise
    finally:
        tippecanoe_input.unlink(missing_ok=True)

    os.replace(staging, destination)
    print(f"[{domain.id}] {destination} ({destination.stat().st_size / 1e6:.1f} MB)", flush=True)
    return destination


#: First bytes of a PMTiles v3 archive. MBTiles (a SQLite database) starts "SQLite format 3".
PMTILES_MAGIC = b"PMTiles"


def verify(archive: Path, cohorts: Cohorts, expected_features: int) -> None:
    """Post-conditions on the built archive. Raises rather than warning.

    Checked rather than assumed because every failure here is silent: a wrong-format file still
    has the right name, a tiler that dropped features still exits zero, and a layer the web never
    asks for is simply data that never draws.
    """
    with archive.open("rb") as handle:
        magic = handle.read(len(PMTILES_MAGIC))
    if magic != PMTILES_MAGIC:
        archive.unlink(missing_ok=True)
        raise TilingError(
            f"{archive.name} is not a PMTiles archive (starts {magic!r}). Tippecanoe picks its "
            f"output format from the file extension — check that it ends in .pmtiles."
        )

    counts = layer_counts(archive)
    if counts is None:
        archive.unlink(missing_ok=True)
        raise TilingError(
            f"could not read the feature count back from {archive.name}. The build is refused "
            f"rather than passed unverified: an archive that silently lost features is exactly "
            f"what this check exists to catch, and 'tippecanoe printed nothing alarming' is not "
            f"evidence — its diagnostics are not a correctness API."
        )

    strays = [layer for layer, _ in counts if not cohorts.is_layer(layer)]
    if strays:
        archive.unlink(missing_ok=True)
        raise TilingError(
            f"{archive.name} holds layer {strays[0]!r}, which is not a cohort the web builds for "
            f"{cohorts.first_year}-{cohorts.last_year} — the features in it would never draw."
        )

    count = sum(n for _, n in counts)
    if count != expected_features:
        archive.unlink(missing_ok=True)
        raise TilingError(
            f"{archive.name}: tiled {count:,} features but {expected_features:,} were written for "
            f"tiling. The map would report different totals from the data."
        )


def source_layers_in(archive: Path) -> tuple[str, ...] | None:
    """The tile layers the built archive actually contains, sorted.

    The manifest publishes this list and the web builds exactly one style layer per name in it,
    so it has to be *measured*: a cohort with no features gets no layer from tippecanoe, and a
    style layer naming a layer the source lacks is an error MapLibre raises on every tile.

    Returns None when the archive is missing or its stats cannot be read -- the caller decides
    whether that is fatal, exactly as :func:`layer_counts` does.
    """
    counts = layer_counts(archive)
    if counts is None:
        return None
    return tuple(sorted(layer for layer, _ in counts))


def change_types_in(archive: Path) -> tuple[str, ...] | None:
    """The distinct states the built archive actually contains, read off its layer names.

    The manifest advertises this so the web app knows which views a domain can offer, and it has
    to be *measured* rather than declared: a domain class asserting "I produce extent and loss"
    stays true in the manifest even when the extent pass was interrupted, and the UI then offers a
    view toggle that switches to an empty map.

    Returns None when the archive is missing, its stats cannot be read, or a layer is not named
    for a cohort -- that last is an archive from before cohort layers, which the web cannot draw.
    """
    layers = source_layers_in(archive)
    if layers is None:
        return None

    change_types: set[str] = set()
    for layer in layers:
        change_type = cohorts_module.change_type_of(layer)
        if change_type is None:
            return None
        change_types.add(change_type)
    return tuple(sorted(change_types))


def _tilestats_layers(archive: Path) -> list[dict[str, Any]] | None:
    """Every layer's tilestats block, or None if they cannot be read."""
    try:
        result = subprocess.run(
            ["pmtiles", "show", "--metadata", str(archive)],
            capture_output=True,
            text=True,
            check=False,
        )
    except (FileNotFoundError, OSError):
        return None

    if result.returncode != 0:
        return None

    try:
        metadata, _ = json.JSONDecoder().raw_decode(result.stdout.strip())
        layers = metadata["tilestats"]["layers"]
    except (ValueError, KeyError, TypeError):
        return None

    if not isinstance(layers, list) or not layers:
        return None
    return layers


def layer_counts(archive: Path) -> list[tuple[str, int]] | None:
    """`(layer name, feature count)` per layer from the archive's tilestats, or None if unavailable.

    Every failure here returns None rather than raising. This is the *verifier*, and an
    unavailable verifier must degrade to "unchecked, and said so" — not take down a build whose
    output is fine. `check=False` alone does not achieve that: `subprocess.run` still raises
    FileNotFoundError when the binary is missing, which would escape `verify()`, propagate out of
    `build()`, and leave the staging file behind — breaking the idempotency guarantee for a
    machine that simply lacks an optional tool. `_tilestats_layers` carries that contract.
    """
    layers = _tilestats_layers(archive)
    if layers is None:
        return None

    counts: list[tuple[str, int]] = []
    for layer in layers:
        name, count = layer.get("layer"), layer.get("count")
        if not isinstance(name, str) or not isinstance(count, int):
            return None
        counts.append((name, count))
    return counts
