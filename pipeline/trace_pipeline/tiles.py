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
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any

from trace_pipeline import extract

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


def count_features(geojson: Path) -> int:
    """Features in the source file.

    Loads the document rather than streaming it: the extraction step already holds the whole
    collection in memory, so this adds no new ceiling, and an exact count is what makes the
    post-condition below meaningful.
    """
    with geojson.open(encoding="utf-8") as handle:
        return len(json.load(handle)["features"])


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

    expected = count_features(source)
    destination = pmtiles_path(domain.id)

    # Write beside the target and move on success, so a failed or interrupted run never leaves a
    # half-written archive for the next step to pick up and trust.
    #
    # The staging name must still END in .pmtiles: tippecanoe chooses its output format from the
    # extension, so `forest.pmtiles.partial` silently produced MBTiles, which then got renamed to
    # .pmtiles — the wrong format under the right name, which every later step would have believed.
    staging = destination.with_name(f"{domain.id}.partial.pmtiles")
    staging.unlink(missing_ok=True)

    command = [
        tippecanoe,
        "--output",
        str(staging),
        "--layer",
        domain.id,  # must equal the manifest's sourceLayer
        "--minimum-zoom",
        str(MIN_ZOOM),
        "--maximum-zoom",
        str(MAX_ZOOM),
        f"--simplification={SIMPLIFICATION}",
        *NO_LOSS_FLAGS,
        "--force",
        str(source),
    ]

    print(f"[{domain.id}] tiling {expected:,} features…", flush=True)

    # One cleanup path for every failure, rather than an unlink beside each raise. The acceptance
    # criterion is that a failed run leaves no half-written archive behind, and that has to hold
    # for the exceptions nobody anticipated too — not only the ones with a matching `except`.
    try:
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

        verify(staging, domain.id, expected)
    except BaseException:
        staging.unlink(missing_ok=True)
        raise

    os.replace(staging, destination)
    print(f"[{domain.id}] {destination} ({destination.stat().st_size / 1e6:.1f} MB)", flush=True)
    return destination


#: First bytes of a PMTiles v3 archive. MBTiles (a SQLite database) starts "SQLite format 3".
PMTILES_MAGIC = b"PMTiles"


def verify(archive: Path, domain_id: str, expected_features: int) -> None:
    """Post-conditions on the built archive. Raises rather than warning.

    Checked rather than assumed because both failures here are silent: a wrong-format file still
    has the right name, and a tiler that dropped features still exits zero.
    """
    with archive.open("rb") as handle:
        magic = handle.read(len(PMTILES_MAGIC))
    if magic != PMTILES_MAGIC:
        archive.unlink(missing_ok=True)
        raise TilingError(
            f"{archive.name} is not a PMTiles archive (starts {magic!r}). Tippecanoe picks its "
            f"output format from the file extension — check that it ends in .pmtiles."
        )

    stats = _layer_stats(archive)
    if stats is None:
        archive.unlink(missing_ok=True)
        raise TilingError(
            f"could not read the feature count back from {archive.name}. The build is refused "
            f"rather than passed unverified: an archive that silently lost features is exactly "
            f"what this check exists to catch, and 'tippecanoe printed nothing alarming' is not "
            f"evidence — its diagnostics are not a correctness API."
        )

    layer, count = stats
    if layer != domain_id:
        archive.unlink(missing_ok=True)
        raise TilingError(
            f"tileset layer is {layer!r} but the manifest will point at sourceLayer "
            f"{domain_id!r} — the web app would find no features."
        )
    if count != expected_features:
        archive.unlink(missing_ok=True)
        raise TilingError(
            f"{domain_id}: tiled {count:,} features but the source has {expected_features:,}. "
            f"The map would report different totals from the data."
        )


def change_types_in(archive: Path) -> tuple[str, ...] | None:
    """The distinct `change_type` values the built archive actually contains.

    The manifest advertises this so the web app knows which views a domain can offer, and it has
    to be *measured* rather than declared: a domain class asserting "I produce extent and loss"
    stays true in the manifest even when the extent pass was interrupted, and the UI then offers a
    view toggle that switches to an empty map. Tippecanoe already records the distinct values of
    every attribute in tilestats, so the tileset can be asked directly.

    Returns None when the archive is missing or its stats cannot be read -- the caller decides
    whether that is fatal, exactly as :func:`_layer_stats` does.
    """
    metadata = _tilestats_layers(archive)
    if metadata is None:
        return None

    for attribute in metadata.get("attributes", []):
        if attribute.get("attribute") != "change_type":
            continue
        values = attribute.get("values")
        if not isinstance(values, list):
            return None
        return tuple(sorted(str(value) for value in values))

    # The layer exists but carries no change_type at all, which is a broken tileset rather than an
    # empty one -- every B4 feature is required to have it.
    return None


def _tilestats_layers(archive: Path) -> dict[str, Any] | None:
    """The single layer's tilestats block, or None if it cannot be read."""
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

    if len(layers) != 1:
        return None
    return layers[0]


def _layer_stats(archive: Path) -> tuple[str, int] | None:
    """(layer name, feature count) from the archive's tilestats, or None if unavailable.

    Every failure here returns None rather than raising. This is the *verifier*, and an
    unavailable verifier must degrade to "unchecked, and said so" — not take down a build whose
    output is fine. `check=False` alone does not achieve that: `subprocess.run` still raises
    FileNotFoundError when the binary is missing, which would escape `verify()`, propagate out of
    `build()`, and leave the staging file behind — breaking the idempotency guarantee for a
    machine that simply lacks an optional tool. `_tilestats_layers` carries that contract.
    """
    layer = _tilestats_layers(archive)
    if layer is None:
        return None
    return layer.get("layer"), layer.get("count")
