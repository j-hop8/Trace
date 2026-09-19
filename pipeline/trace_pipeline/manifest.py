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
        change_types = _change_types_for(domain)
        entries.append(
            domain.manifest_entry(
                tiles_url(domain.id), change_types, _source_layers_for(domain, change_types)
            )
        )
    _check(entries)
    return {"version": config.MANIFEST_VERSION, "domains": entries}


def _change_types_for(domain: Domain) -> tuple[str, ...]:
    """What the domain's tileset actually contains, falling back to what it intends to produce.

    Measured first, because the manifest drives which views the UI offers: a domain declaring
    `("cover", "loss")` whose cover pass was interrupted would otherwise still advertise a view
    toggle, and switching to it would show an empty map with nothing to explain why.

    The fallback is for the pre-tiling case only -- writing a manifest before the archive exists
    is legitimate (a provisional run, a test), and there is nothing better to say then.
    """
    from trace_pipeline import tiles

    measured = tiles.change_types_in(tiles.pmtiles_path(domain.id))
    return measured if measured is not None else tuple(domain.change_types)


def _source_layers_for(domain: Domain, change_types: Sequence[str]) -> tuple[str, ...]:
    """The tile layers the web should build style layers for -- measured, like the states.

    The web builds one style layer per name listed and no others, so the list has to be what the
    archive holds: a cohort with no features has no layer, and a style layer naming a layer its
    source lacks is an error MapLibre raises on every tile. The fallback, for the same pre-tiling
    case as above, is every cohort the range and states imply.
    """
    from trace_pipeline import tiles

    measured = tiles.source_layers_in(tiles.pmtiles_path(domain.id))
    if measured is not None:
        return measured
    return tuple(Cohorts(*domain.temporal_range()).all_layers(change_types))


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
