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

if TYPE_CHECKING:
    from trace_pipeline.domains.base import Domain

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
    entries = [domain.manifest_entry(tiles_url(domain.id)) for domain in domains]
    _check(entries)
    return {"version": config.MANIFEST_VERSION, "domains": entries}


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

        # Attribution is a licence obligation and the web app has no other source for it, so an
        # empty string here would silently drop a required credit.
        if not (entry.get("source") or {}).get("attribution"):
            raise ManifestError(f"{domain_id}: source.attribution is required")
        if not entry.get("caveat"):
            raise ManifestError(f"{domain_id}: caveat is required -- every layer states its limits")


def write(domains: Sequence[Domain], path: Path | None = None) -> Path:
    """Write the manifest to disk, creating the data directory if needed."""
    destination = path or config.MANIFEST_PATH
    destination.parent.mkdir(parents=True, exist_ok=True)

    payload = build(domains)
    # Trailing newline so the file is well-formed for diffing and for POSIX tools.
    destination.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return destination
