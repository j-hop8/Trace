"""Writes `data/domains.json` -- the contract between the pipeline and the web app.

This file is the spine. The web app learns which domains exist, what they are called, what colour
they are, which years they cover, and what credit they require by reading it. Nothing in `web/`
hardcodes a domain, so a domain that fails to reach this file simply does not exist as far as the
UI is concerned.
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

from trace_pipeline import config
from trace_pipeline.cohorts import Cohorts
from trace_pipeline.schema import REPO_ROOT

if TYPE_CHECKING:
    from trace_pipeline.domains.base import Domain

DATA_DIR = REPO_ROOT / "data"
MANIFEST_PATH = DATA_DIR / "domains.json"

#: Root-relative so the same manifest works under `npm run dev` and on object storage. The
#: pmtiles:// prefix is what registers the file with MapLibre's PMTiles protocol handler.
TILES_URL_TEMPLATE = "pmtiles:///data/{domain}.pmtiles"


class ManifestError(ValueError):
    """Raised when the assembled manifest would be unusable by the web app."""


def tiles_url(domain_id: str) -> str:
    return TILES_URL_TEMPLATE.format(domain=domain_id)


def build(domains: Sequence[Domain]) -> dict[str, Any]:
    """Assemble the manifest for the given domains.

    No timestamp or run id: T-005 requires re-running the pipeline to be idempotent, and a
    generated-at field would make every run produce a different file even when the data is
    identical.
    """
    entries = []
    for domain in domains:
        change_types, source_layers = _measured(domain)
        entries.append(domain.manifest_entry(tiles_url(domain.id), change_types, source_layers))
    _check(entries)
    return {"version": config.MANIFEST_VERSION, "domains": entries}


def _measured(domain: Domain) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """`(change types, tile layers)` the domain's archive actually holds.

    Measured, because the manifest drives what the web builds: one toggle per state and one
    style layer per tile layer listed, and no others. A domain declaring `("cover", "loss")`
    whose cover pass was interrupted would otherwise still advertise a toggle onto an empty map,
    and a style layer naming a layer its source lacks is an error MapLibre raises on every tile.

    Falls back to what the domain *intends* -- its declared states, and every cohort the range
    implies -- only when there is no archive at all: writing a manifest before tiling is
    legitimate (a provisional run, a test), and there is nothing better to say then. An archive
    that is there but cannot be described is refused instead. Falling back for it too would
    publish an invented layer list over real tiles, and `_check` would then be validating the
    invention rather than the archive -- exactly the silent disagreement it exists to catch.
    """
    from trace_pipeline import tiles

    archive = tiles.pmtiles_path(domain.id)
    if not archive.exists():
        change_types = tuple(domain.change_types)
        return change_types, tuple(Cohorts(*domain.temporal_range()).all_layers(change_types))

    source_layers = tiles.source_layers_in(archive)
    if source_layers is None:
        raise ManifestError(
            f"{domain.id}: {archive.name} exists but its layers cannot be read, so the manifest "
            f"cannot say what it holds. Is `pmtiles` installed? Rebuild with:\n"
            f"  python -m trace_pipeline.cli tiles {domain.id}"
        )

    change_types = tiles.change_types_in(archive)
    if change_types is None:
        raise ManifestError(
            f"{domain.id}: {archive.name} holds a layer that is not a cohort -- an archive from "
            f"before cohort layers, which the web cannot draw. Rebuild with:\n"
            f"  python -m trace_pipeline.cli tiles {domain.id}"
        )

    return change_types, source_layers


def _check(entries: Sequence[dict[str, Any]]) -> None:
    """Catch the manifest mistakes that surface as a silently blank map."""
    seen: set[str] = set()
    for entry in entries:
        domain_id = entry.get("id")

        if not domain_id:
            raise ManifestError("a domain produced a manifest entry with no id")
        if domain_id in seen:
            # Both would write to data/<id>.pmtiles, so one would overwrite the other's tiles.
            raise ManifestError(f"duplicate domain id {domain_id!r} in the manifest")
        seen.add(domain_id)

        temporal = entry.get("temporal") or {}
        start, end = temporal.get("start"), temporal.get("end")
        if not isinstance(start, int) or not isinstance(end, int):
            raise ManifestError(f"{domain_id}: temporal.start and temporal.end must be integers")
        if start > end:
            # The slider would render an empty or inverted range.
            raise ManifestError(f"{domain_id}: temporal range {start}-{end} runs backwards")

        # Every tile layer must be a cohort the web builds for *this* range: a tileset built when
        # the domain resolved to a different range names interval nodes this range's tree does
        # not have, and the features in them would never draw. Rebuilding the tiles is the fix.
        cohorts = Cohorts(start, end)
        layers = (entry.get("tiles") or {}).get("sourceLayers") or []
        strays = [layer for layer in layers if not cohorts.is_layer(layer)]
        if strays:
            raise ManifestError(
                f"{domain_id}: tile layer {strays[0]!r} is not a cohort for {start}-{end}. The "
                f"tiles were built for a different year range -- rebuild them:\n"
                f"  python -m trace_pipeline.cli tiles {domain_id}"
            )

        # Attribution is a licence obligation and the web app has no other source for it, so an
        # empty string here would silently drop a required credit.
        if not (entry.get("source") or {}).get("attribution"):
            raise ManifestError(f"{domain_id}: source.attribution is required")
        if not entry.get("caveat"):
            raise ManifestError(f"{domain_id}: caveat is required -- every layer states its limits")


def write(domains: Sequence[Domain], path: Path | None = None) -> Path:
    """Write the manifest to disk, creating the data directory if needed."""
    destination = path or MANIFEST_PATH
    destination.parent.mkdir(parents=True, exist_ok=True)

    payload = build(domains)
    # Trailing newline so the file is well-formed for diffing and for POSIX tools.
    destination.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return destination
