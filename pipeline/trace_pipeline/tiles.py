"""Turn a domain's GeoJSON into one PMTiles file.

**Two regimes, split at `config.DETAIL_ZOOM`.** From the detail zoom up, nothing may be dropped:
every feature is one tile feature with its id and its metric, and the built archive is checked
feature by feature against what was written for tiling. The numbers this map reports — hectares
lost, patch counts — are the product's actual claim, and a tiler quietly binning 5% of the
smallest patches would make the map disagree with the caveat that states how much it shows.

Below the detail zoom a tile is something else: the island view, where a 30 m patch is a quarter
of a pixel and a z7 tile carried ~400k of them that no one could see as shapes — and parsing them
was the whole of the opening view's wait. So every feature is written a second time as an
*island copy*, confined to the zooms below the split and carrying only the attributes its cohort
shares. Tippecanoe merges a tile's copies of one group into one feature (`--coalesce`), and pools
polygons smaller than a screen pixel into squares of the same total area (its tiny-polygon
reduction, the thing the previous contract switched off). Area is preserved, identity is not, and
the caveat says so. What is verified below the split is the area: the island tiles are decoded
and their area summed against the source's.

The size-limit escapes stay disabled in both regimes: a feature is pooled by its own size, never
dropped to fit a tile budget. If the output is ever too large, the honest fix is to raise the
minimum mapping unit deliberately and restate the retained percentage — not to let the tiler
decide which data the reader gets.

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
import math
import os
import re
import shutil
import subprocess
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from trace_pipeline import cohorts as cohorts_module
from trace_pipeline import config, extract, schema
from trace_pipeline.cohorts import Cohorts

if TYPE_CHECKING:
    from trace_pipeline.domains.base import Domain

#: Below this the patches are far smaller than a pixel and the layer says nothing useful; above
#: it, the basemap extract stops. Matching the basemap's ceiling keeps the two in step.
MIN_ZOOM = 5
MAX_ZOOM = 14

#: Flags that exist purely to stop tippecanoe from silently discarding data to fit a budget.
#:
#: Tiny-polygon reduction is deliberately *not* in this list any more: below the detail zoom it
#: is the pooling the island copies exist for, and at the detail zoom and above it cannot reach a
#: real patch -- see :func:`detail_floor_units2`.
NO_LOSS_FLAGS = [
    "--no-feature-limit",  # default caps a tile at 200k features and drops the rest
    "--no-tile-size-limit",  # default caps a tile at 500 KB and drops the rest
]

#: Flags that shape the island regime. `--coalesce` merges consecutive features with identical
#: attributes into one, `--reorder` puts such features consecutive, and the size sets the pooling
#: threshold at its square in tile units. Detail copies are never touched by the first two: each
#: carries its own id and metric, so no two are identical.
POOLING_FLAGS = [
    "--coalesce",
    "--reorder",
    f"--tiny-polygon-size={config.TINY_POLYGON_SIZE}",
]

#: Geometry simplification keeps every feature and only reduces vertex counts, so it is the one
#: size lever that costs no data.
SIMPLIFICATION = 4

#: Substrings tippecanoe prints when it has thrown data away.
#:
#: An *early warning*, never the guarantee. Diagnostic text is not a stable correctness API: the
#: wording can change between releases and a discard mode nobody has seen yet would print
#: something not in this list. The guarantee is :func:`verify`, which decodes the built tiles.
#: This just fails faster, with a more specific message, in the cases it does recognise.
LOSS_MARKERS = ("dropping", "dropped", "Try using --drop")

#: The tile-only marker on an island copy. Never in the GeoJSON, so never in the schema: it says
#: that this feature is a cohort's shapes pooled for one tile, not one patch, and the readout
#: quotes no area for it.
POOLED_PROPERTY = "pooled"

#: Web Mercator's circumference, and tippecanoe's tile extent: what a tile unit measures.
_MERCATOR_M = 40_075_016.686
_TILE_EXTENT = 4096

#: What every domain's caveat says about the island view. Appended by `Domain.manifest_entry`
#: rather than written per domain, because it is a property of the tiling and the same for all.
#:
#: "About": pooling preserves area by construction, and the build measures how well -- 95-101%
#: per zoom and kind on the T-036 archives, the shortfall at the finest pooled zoom -- which is
#: why the sentence does not claim exactness and `verify` prints the figure every build.
ISLAND_CAVEAT = (
    f"Zoomed out to the island, patches smaller than a screen pixel are pooled into squares of "
    f"about the same total area and one year's shapes are merged, so a mark there stands for "
    f"several patches; from zoom {config.DETAIL_ZOOM} in, every patch is drawn on its own."
)


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


def require_tippecanoe_decode() -> str:
    """`tippecanoe-decode`, which ships with tippecanoe and is how the built tiles are read back.

    Required for the same reason `pmtiles` is: it is what proves the detail regime holds every
    feature and the island regime holds the area, and a build that cannot be checked is refused
    rather than passed.
    """
    path = shutil.which("tippecanoe-decode")
    if not path:
        raise TilingError(
            "tippecanoe-decode is not on PATH, so the built tiles cannot be read back and "
            "checked. It is installed alongside tippecanoe (brew install tippecanoe)."
        )
    return path


def pmtiles_path(domain_id: str) -> Path:
    return extract.DATA_DIR / f"{domain_id}.pmtiles"


@dataclass(frozen=True)
class TilingInput:
    """What `write_tippecanoe_input` decided to tile -- the reference every check runs against."""

    #: Features in the GeoJSON.
    source_count: int
    #: Detail copies written: one per cohort layer a feature belongs in. Island copies are one
    #: per detail copy by construction and are not counted separately.
    written: int
    #: Source features with no cohort -- cover gone before the range began.
    unplaced: int
    #: Sum of `metric.area_ha` over the copies written, per kind of state (`cover`, `change`), so
    #: the island tiles' pooled area can be measured against what went in.
    area_ha_by_kind: dict[str, float] = field(default_factory=dict)


def write_tippecanoe_input(geojson: Path, destination: Path, cohorts: Cohorts) -> TilingInput:
    """Rewrite the collection as tile features, each naming its cohort's layer, in both regimes.

    Tippecanoe reads newline-delimited features and honours a per-feature `tippecanoe.layer`, so
    this is how a feature is steered into its cohort's layer -- and how a cover feature is written
    once per interval node it belongs to. Each such copy is written twice: the *detail copy*,
    confined to `config.DETAIL_ZOOM` and up, with every property and the source feature's index as
    its `id`; and the *island copy*, confined to the zooms below, with every property but
    `metric`, no id, and `POOLED_PROPERTY` set -- so that a tile's island copies of one cohort and
    attribute group are identical and tippecanoe merges them into one feature.

    Returns a `TilingInput`. Its `written` is what the built archive's detail regime is checked
    against, because it is the number of features this step *decided* to tile, and a tiler that
    lost any of them is what the check exists to catch; its `unplaced` is cover that ended before
    the range began, which no layer could draw (`Cohorts.layers_for`) -- reported, never silent.

    Every detail copy's `id` is the source feature's position in the collection, which tippecanoe
    keeps as the tile feature's id. It is the only thing that tells a copy from a neighbour:
    single-pixel patches share every attribute, and tippecanoe simplifies each layer on its own,
    so two copies of one feature can differ in tile geometry. The web's tiles test counts a feature
    once by it, and :func:`verify` counts them to prove nothing was dropped.

    Loads the document rather than streaming it: the extraction step already holds the whole
    collection in memory, so this adds no new ceiling.

    Raises `CohortError` before tippecanoe runs for a feature that begins after the range ends.
    """
    with geojson.open(encoding="utf-8") as handle:
        features = json.load(handle)["features"]

    written = 0
    unplaced = 0
    area_ha_by_kind: dict[str, float] = {}
    kinds = schema.kind_of()
    with destination.open("w", encoding="utf-8") as out:
        for index, feature in enumerate(features):
            layers = cohorts.layers_for(feature["properties"])
            if not layers:
                unplaced += 1
                continue
            properties = feature["properties"]
            pooled = {k: v for k, v in properties.items() if k != "metric"}
            pooled[POOLED_PROPERTY] = True
            kind = kinds[properties["change_type"]]
            area_ha = float(properties.get("metric", {}).get("area_ha") or 0.0)
            for layer in layers:
                area_ha_by_kind[kind] = area_ha_by_kind.get(kind, 0.0) + area_ha
                detail = {
                    "type": "Feature",
                    "id": index,
                    "tippecanoe": {"layer": layer, "minzoom": config.DETAIL_ZOOM},
                    "properties": properties,
                    "geometry": feature["geometry"],
                }
                island = {
                    "type": "Feature",
                    "tippecanoe": {"layer": layer, "maxzoom": config.DETAIL_ZOOM - 1},
                    "properties": pooled,
                    "geometry": feature["geometry"],
                }
                out.write(json.dumps(detail))
                out.write("\n")
                out.write(json.dumps(island))
                out.write("\n")
                written += 1

    return TilingInput(len(features), written, unplaced, area_ha_by_kind)


def detail_floor_units2() -> float:
    """The smallest real patch, in tile units² at `DETAIL_ZOOM`, where a tile unit is widest.

    What makes the detail regime provably untouched by the pooling: tippecanoe pools a polygon
    under `TINY_POLYGON_SIZE`² units² whatever the zoom, and a `MIN_PATCH_PIXELS` patch -- the
    smallest thing any domain ships -- measures this many at the detail zoom. A tile unit is
    widest at the AOI's southern edge, so that is where a patch is fewest units, and the figure
    here is that worst case. `build` refuses to run if it comes within `DETAIL_FLOOR_MARGIN` of
    the threshold; the margin covers the pixel's 0.070-0.072 ha spread across the island.
    """
    south = config.TAIWAN_BBOX[1]
    metres_per_unit = (
        _MERCATOR_M * math.cos(math.radians(south)) / 2**config.DETAIL_ZOOM / _TILE_EXTENT
    )
    patch_m2 = config.MIN_PATCH_PIXELS * config.TAIWAN_PIXEL_HA * config.M2_PER_HA
    return patch_m2 / metres_per_unit**2


def require_detail_floor() -> None:
    """Refuse to build tiles whose detail regime the pooling could reach."""
    floor = detail_floor_units2()
    threshold = config.TINY_POLYGON_SIZE**2
    if floor < config.DETAIL_FLOOR_MARGIN * threshold:
        raise TilingError(
            f"a {config.MIN_PATCH_PIXELS}-pixel patch is {floor:.0f} tile units² at zoom "
            f"{config.DETAIL_ZOOM}, within {config.DETAIL_FLOOR_MARGIN}x of the pooling threshold "
            f"of {threshold}: tippecanoe could pool a real patch in the detail regime. Raise "
            f"config.DETAIL_ZOOM or lower config.TINY_POLYGON_SIZE."
        )


def build(domain: Domain) -> Path:
    """Build `data/<domain>.pmtiles`. Returns the path written."""
    tippecanoe = require_tippecanoe()
    # Checked up front, not after a 40-second tiling run, so a missing tool fails immediately.
    require_pmtiles()
    require_tippecanoe_decode()
    require_detail_floor()

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
        *POOLING_FLAGS,
        "--force",
        str(tippecanoe_input),
    ]

    # One cleanup path for every failure, rather than an unlink beside each raise. The acceptance
    # criterion is that a failed run leaves no half-written archive behind, and that has to hold
    # for the exceptions nobody anticipated too — not only the ones with a matching `except`.
    try:
        tiled = write_tippecanoe_input(source, tippecanoe_input, cohorts)
        print(
            f"[{domain.id}] tiling {tiled.source_count:,} features as {tiled.written:,} cohort "
            f"copies, each exact from zoom {config.DETAIL_ZOOM} and pooled below it…",
            flush=True,
        )
        if tiled.unplaced:
            print(
                f"[{domain.id}] {tiled.unplaced:,} cover features end before "
                f"{cohorts.first_year} and have no year the map can show; left out of the tiles.",
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

        verify(staging, cohorts, tiled.written, tiled.area_ha_by_kind, domain.id)
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


#: The least of the source's area the island tiles may hold, per kind. Pooling preserves area by
#: construction, so this is a check that tippecanoe did what its documentation says, set low
#: enough that dithering's per-tile rounding cannot trip it and high enough that a regime built
#: wrong -- a threshold that swallowed real patches, a flag that dropped features -- cannot pass.
ISLAND_AREA_FLOOR = 0.9

#: The island zooms whose area is measured: the opening view, and the last zoom before the split,
#: where the most is pooled at the finest scale.
ISLAND_AREA_ZOOMS = (7, config.DETAIL_ZOOM - 1)


def verify(
    archive: Path,
    cohorts: Cohorts,
    expected_features: int,
    area_ha_by_kind: Mapping[str, float],
    domain_id: str = "",
) -> None:
    """Post-conditions on the built archive. Raises rather than warning.

    Checked rather than assumed because every failure here is silent: a wrong-format file still
    has the right name, a tiler that dropped features still exits zero, and a layer the web never
    asks for is simply data that never draws.

    Three questions, in the order they can be answered. Is it the archive it claims to be, holding
    only layers the web builds? Does the detail regime hold every copy that was written -- read
    off the `DETAIL_ZOOM` tiles feature by feature, since tilestats counts what tippecanoe *read*,
    not what it kept? And do the island tiles hold the source's area, kind by kind, at the zooms
    where the most is pooled?
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

    # Tilestats counts every feature tippecanoe read: a detail copy and an island copy per cohort
    # copy. So this is input accounting -- it catches a feature refused at the door (an invalid
    # geometry, say), never one dropped from a tile -- and the two checks below are the ones that
    # read the tiles.
    count = sum(n for _, n in counts)
    if count != 2 * expected_features:
        archive.unlink(missing_ok=True)
        raise TilingError(
            f"{archive.name}: tippecanoe read {count:,} features but {2 * expected_features:,} "
            f"were written for tiling (a detail and an island copy for each of "
            f"{expected_features:,} cohort copies). The map would report different totals from "
            f"the data."
        )

    kept = detail_copies_in(archive)
    if kept != expected_features:
        archive.unlink(missing_ok=True)
        raise TilingError(
            f"{archive.name}: the zoom-{config.DETAIL_ZOOM} tiles hold {kept:,} distinct cohort "
            f"copies but {expected_features:,} were written. A feature is missing from the detail "
            f"regime, where nothing may be."
        )

    for zoom in ISLAND_AREA_ZOOMS:
        held = island_area_ha_by_kind(archive, zoom)
        for kind, source_ha in sorted(area_ha_by_kind.items()):
            share = held.get(kind, 0.0) / source_ha if source_ha else 1.0
            prefix = f"[{domain_id}] " if domain_id else ""
            print(
                f"{prefix}zoom {zoom} holds {share:.1%} of the {kind} area that went in "
                f"({held.get(kind, 0.0):,.0f} of {source_ha:,.0f} ha)",
                flush=True,
            )
            if share < ISLAND_AREA_FLOOR:
                archive.unlink(missing_ok=True)
                raise TilingError(
                    f"{archive.name}: the zoom-{zoom} tiles hold only {share:.1%} of the {kind} "
                    f"area that went in. Pooling is meant to preserve area; below "
                    f"{ISLAND_AREA_FLOOR:.0%} something was dropped, not pooled."
                )


#: A tile header in `tippecanoe-decode` output, and a layer header inside it. Each is a line of
#: its own, and each feature is one line, which is what lets a 1 GB decode be read as a stream.
_TILE_HEADER = re.compile(r'"zoom": (\d+), "x": (\d+), "y": (\d+)')
_LAYER_HEADER = re.compile(r'"layer": "([^"]+)"')


def decoded_features(archive: Path, zoom: int) -> Iterator[tuple[int, int, str, dict[str, Any]]]:
    """Yield `(x, y, tile layer, feature)` for every feature of every tile at one zoom.

    Streams `tippecanoe-decode` rather than loading its output: the detail zoom of the water
    archive decodes to about a gigabyte of GeoJSON, and a build should not need several times that
    in memory to check itself. Geometry is in longitude/latitude, clipped to the tile plus
    tippecanoe's buffer -- so a feature on a tile edge appears in both tiles, whole.
    """
    command = [require_tippecanoe_decode(), "-z", str(zoom), "-Z", str(zoom), str(archive)]
    with subprocess.Popen(command, stdout=subprocess.PIPE, text=True, encoding="utf-8") as proc:
        assert proc.stdout is not None
        x = y = -1
        layer = ""
        for line in proc.stdout:
            if line.startswith('{ "type": "Feature"'):
                yield x, y, layer, json.loads(line)
                continue
            header = _TILE_HEADER.search(line)
            if header:
                x, y = int(header[2]), int(header[3])
                continue
            named = _LAYER_HEADER.search(line)
            if named:
                layer = named[1]
        if proc.wait() != 0:
            raise TilingError(f"tippecanoe-decode failed on {archive.name} at zoom {zoom}")


def detail_copies_in(archive: Path) -> int:
    """How many distinct cohort copies the `DETAIL_ZOOM` tiles hold.

    A copy is `(tile layer, id)`: the id is the source feature's index, so a cover feature written
    into several node layers counts once per layer, exactly as it was written; and a feature cut
    by a tile edge, present in both tiles, counts once. Every copy appears in at least one tile at
    this zoom, so this equals the copies written if and only if none was dropped.
    """
    seen: set[tuple[str, int]] = set()
    for _x, _y, layer, feature in decoded_features(archive, config.DETAIL_ZOOM):
        if "id" not in feature:
            raise TilingError(
                f"{archive.name}: a zoom-{config.DETAIL_ZOOM} feature in {layer!r} has no id, "
                f"which every detail copy must carry"
            )
        seen.add((layer, int(feature["id"])))
    return len(seen)


def island_area_ha_by_kind(archive: Path, zoom: int) -> dict[str, float]:
    """Geodesic area the tiles at one island zoom hold, per kind of state, in hectares.

    Each feature is clipped to its tile's own bounds before measuring, because tippecanoe writes a
    feature into every tile it touches, buffer included, and summing the unclipped copies would
    count every tile edge twice. Then the tiles are edge to edge and their sum is the layer's.
    """
    from pyproj import Geod
    from shapely import clip_by_rect
    from shapely.geometry import shape

    geod = Geod(ellps="WGS84")
    kinds = schema.kind_of()
    held: dict[str, float] = {}
    for x, y, layer, feature in decoded_features(archive, zoom):
        change_type = cohorts_module.change_type_of(layer)
        if change_type is None:
            continue
        geometry = shape(feature["geometry"])
        clipped = clip_by_rect(geometry, *tile_bounds(zoom, x, y))
        if clipped.is_empty:
            continue
        area_m2 = abs(geod.geometry_area_perimeter(clipped)[0])
        kind = kinds[change_type]
        held[kind] = held.get(kind, 0.0) + area_m2 / config.M2_PER_HA
    return held


def tile_bounds(zoom: int, x: int, y: int) -> tuple[float, float, float, float]:
    """`(west, south, east, north)` of a Web Mercator tile, in degrees."""
    n = 2**zoom
    west = x / n * 360.0 - 180.0
    east = (x + 1) / n * 360.0 - 180.0
    north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / n))))
    return west, south, east, north


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
