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
from typing import TYPE_CHECKING

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

#: Substrings tippecanoe prints when it has thrown data away. Treated as failures.
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
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    output = f"{result.stdout}\n{result.stderr}"

    if result.returncode != 0:
        staging.unlink(missing_ok=True)
        raise TilingError(f"tippecanoe failed for {domain.id}:\n{output.strip()}")

    lost = [line for line in output.splitlines() if any(m in line for m in LOSS_MARKERS)]
    if lost:
        staging.unlink(missing_ok=True)
        raise TilingError(
            f"tippecanoe discarded features for {domain.id}, so the tiles would disagree with "
            f"the areas the UI reports:\n  " + "\n  ".join(lost[:5])
        )

    verify(staging, domain.id, expected)

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
        print(f"[{domain_id}] warning: tileset carries no tilestats; count unverified", flush=True)
        return

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


def _layer_stats(archive: Path) -> tuple[str, int] | None:
    """(layer name, feature count) from the archive's tilestats, or None if absent."""
    result = subprocess.run(
        ["pmtiles", "show", "--metadata", str(archive)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return None

    try:
        metadata, _ = json.JSONDecoder().raw_decode(result.stdout.strip())
        layers = metadata["tilestats"]["layers"]
    except (ValueError, KeyError, TypeError):
        return None

    if len(layers) != 1:
        return None
    return layers[0].get("layer"), layers[0].get("count")
