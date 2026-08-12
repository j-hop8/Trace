"""The Domain contract.

A domain is one subject Trace can measure change in -- water, forest, and later coast, urban,
climate, transport. Every domain implements this same interface, which is what makes them
interchangeable modules on one spine rather than bespoke layers.

Adding a domain means: subclass Domain, register it, add a hue to config.DOMAIN_HUES. No change
to the tiling step, no change to the web app.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class SourceInfo:
    """Provenance for a domain, surfaced in the UI's persistent attribution line.

    `attribution` is the credit the licence *requires* verbatim (e.g. "Source: EC JRC/Google");
    `citation` is the academic reference. Both are non-optional because a layer whose origin the
    user cannot see is a layer Trace will not ship.
    """

    name: str
    version: str
    attribution: str
    citation: str
    licence: str


class Domain(ABC):
    """One measurable subject, extracted into dated features."""

    #: Stable identifier. Becomes the `domain` property on every feature this module emits, the
    #: PMTiles filename, and the source-layer name. Never rename without a manifest version bump.
    id: str

    #: Bilingual display label. The web app renders these; it never derives a label from `id`.
    label: dict[str, str]

    @property
    @abstractmethod
    def source(self) -> SourceInfo:
        """Where this domain's data comes from, and what credit it requires."""

    @property
    @abstractmethod
    def caveat(self) -> str:
        """The honest limitation of this layer, in one sentence, shown in the UI.

        Not optional and not boilerplate: A5 requires every layer state what it *cannot* tell you.
        For forest this is the tree-cover-loss-is-not-deforestation point; for water it is the
        30 m resolution floor.
        """

    @abstractmethod
    def temporal_range(self) -> tuple[int, int]:
        """Inclusive (first_year, last_year) this domain actually has data for.

        Resolved at extraction time rather than hardcoded, because a source may be unavailable
        and force a fallback to a shorter range. The slider reads this per layer, which is how
        the water/forest timeline mismatch degrades gracefully instead of breaking the UI.
        """

    @abstractmethod
    def extract(self, aoi: Any) -> dict[str, Any]:
        """Run the Earth Engine extraction and return a GeoJSON FeatureCollection.

        Every feature's properties must satisfy schema/feature.schema.json.

        Args:
            aoi: an ee.Geometry to clip to.
        """

    def manifest_entry(self, tiles_url: str) -> dict[str, Any]:
        """Describe this domain for `data/domains.json`.

        Concrete by design -- the manifest shape is a contract with the web app, so subclasses
        supply the parts and this assembles them uniformly.
        """
        from trace_pipeline.config import DOMAIN_HUES

        first, last = self.temporal_range()
        return {
            "id": self.id,
            "label": self.label,
            "hue": DOMAIN_HUES[self.id],
            "temporal": {"start": first, "end": last},
            "source": {
                "name": self.source.name,
                "version": self.source.version,
                "attribution": self.source.attribution,
                "citation": self.source.citation,
                "licence": self.source.licence,
            },
            "caveat": self.caveat,
            "tiles": {"url": tiles_url, "sourceLayer": self.id},
        }


_REGISTRY: dict[str, type[Domain]] = {}


def register(cls: type[Domain]) -> type[Domain]:
    """Class decorator adding a domain to the registry the CLI dispatches on."""
    if cls.id in _REGISTRY:
        raise ValueError(f"domain id {cls.id!r} is already registered")
    _REGISTRY[cls.id] = cls
    return cls


def get(domain_id: str) -> Domain:
    """Instantiate a registered domain by id."""
    if domain_id not in _REGISTRY:
        raise KeyError(f"unknown domain {domain_id!r}; known: {sorted(_REGISTRY)}")
    return _REGISTRY[domain_id]()


def all_ids() -> list[str]:
    """Every registered domain id, sorted. `trace all` iterates this."""
    return sorted(_REGISTRY)
