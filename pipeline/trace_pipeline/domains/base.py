"""The Domain contract.

A domain is one subject Trace can measure change in -- water, forest, and later coast, urban,
climate, transport. Every domain implements this same interface, which is what makes them
interchangeable modules on one spine rather than bespoke layers.

Adding a domain means: subclass Domain, register it, add a hue to config.DOMAIN_HUES. No change
to the tiling step, no change to the web app. `docs/adding-a-domain.md` is the full checklist.
"""

from __future__ import annotations

import math
from abc import ABC, abstractmethod
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
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


@dataclass(frozen=True)
class ReadoutValue:
    """One more number the readout quotes beside a level's own -- the absolute °C beside the
    anomaly, the head count beside the density. A metric key, and how to say it."""

    key: str
    unit: str
    label: Mapping[str, str]


@dataclass(frozen=True)
class Measure:
    """What a level domain measures, published so the web can draw its ramp and legend.

    `breaks` are the fixed class boundaries, ascending: `n` breaks make `n + 1` bands, and a value
    equal to a break belongs to the band above it (`levels.band_of`). They are the same for every
    year -- a colour has to mean the same thing in 1965 as in 2023, which per-year quantiles would
    quietly break -- and they are chosen, not fitted, so they belong in `config.py`.
    """

    #: The metric key the bands are cut from, e.g. `temp_anomaly_c`.
    key: str
    unit: str
    label: Mapping[str, str]
    breaks: tuple[float, ...]
    #: What the value is relative to, when it is relative to something ("1991–2020 normal").
    baseline: str | None = None
    readout: tuple[ReadoutValue, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        if not self.breaks:
            raise ValueError(f"measure {self.key!r} has no breaks -- one band is no ramp")
        if not all(math.isfinite(b) for b in self.breaks):
            raise ValueError(f"measure {self.key!r} has a non-finite break: {self.breaks}")
        if any(a >= b for a, b in zip(self.breaks, self.breaks[1:], strict=False)):
            raise ValueError(f"measure {self.key!r} breaks must strictly ascend: {self.breaks}")

    @property
    def bands(self) -> int:
        return len(self.breaks) + 1

    def manifest_entry(self) -> dict[str, Any]:
        entry: dict[str, Any] = {
            "key": self.key,
            "unit": self.unit,
            "label": dict(self.label),
            "breaks": list(self.breaks),
            "readout": [
                {"key": r.key, "unit": r.unit, "label": dict(r.label)} for r in self.readout
            ],
        }
        if self.baseline is not None:
            entry["baseline"] = self.baseline
        return entry


class Domain(ABC):
    """One measurable subject, extracted into dated features."""

    #: Stable identifier. Becomes the `domain` property on every feature this module emits and
    #: the PMTiles filename. Never rename without a manifest version bump.
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
        """Run the extraction and return a GeoJSON FeatureCollection.

        Every feature's properties must satisfy schema/feature.schema.json.

        Args:
            aoi: what to clip to -- an ee.Geometry for a domain that `needs_earth_engine`, and
                the `(west, south, east, north)` bbox tuple for one that reads local files.
        """

    #: Whether extraction runs on Earth Engine. A domain that reads files from
    #: `extract.RAW_DIR` sets this False, and `trace extract` then neither authenticates to Earth
    #: Engine for it nor hands it an ee.Geometry -- so it builds on a machine with no Earth
    #: Engine project at all.
    needs_earth_engine: bool = True

    #: What a level domain measures -- its unit, labels and fixed class breaks. Required exactly
    #: when the domain emits `level` features; `manifest._check` refuses one without the other.
    measure: Measure | None = None

    #: Which change types this domain's extraction is *designed* to emit.
    #:
    #: A declaration of intent, not a description of the data -- it is the fallback used before a
    #: tileset exists. What the manifest publishes is measured from the built archive instead (see
    #: `manifest.build`), because a class attribute stays true even when the run that was supposed
    #: to honour it was interrupted, and the UI would then offer a view toggle onto an empty map.
    change_types: tuple[str, ...] = ("loss",)

    def manifest_entry(
        self, tiles_url: str, change_types: Sequence[str], source_layers: Sequence[str]
    ) -> dict[str, Any]:
        """Describe this domain for `data/domains.json`.

        Concrete by design -- the manifest shape is a contract with the web app, so subclasses
        supply the parts and this assembles them uniformly.
        """
        from trace_pipeline import tiles
        from trace_pipeline.config import DETAIL_ZOOM, DOMAIN_HUES

        first, last = self.temporal_range()
        entry: dict[str, Any] = {
            "id": self.id,
            "label": self.label,
            "hue": DOMAIN_HUES[self.id],
            # Passed in rather than read from `self`: the caller is the one that can tell what the
            # tileset actually holds, and making it an argument means this cannot quietly publish
            # an aspiration.
            "changeTypes": list(change_types),
            "temporal": {"start": first, "end": last},
            "source": {
                "name": self.source.name,
                "version": self.source.version,
                "attribution": self.source.attribution,
                "citation": self.source.citation,
                "licence": self.source.licence,
            },
            # The domain's own limits, then the tiling's: below the detail zoom the tiles pool
            # what a screen pixel cannot show, and that is true of every domain alike, so it is
            # said once here rather than remembered in each domain's caveat.
            "caveat": f"{self.caveat} {tiles.ISLAND_CAVEAT}",
            # One tile layer per cohort (`cohorts.py`), measured from the archive like the states
            # above: the web builds exactly one style layer per name here. `detailZoom` is where
            # the tiles stop pooling and every feature is its own (`tiles.py`).
            "tiles": {
                "url": tiles_url,
                "sourceLayers": list(source_layers),
                "detailZoom": DETAIL_ZOOM,
            },
        }
        # Published only when the archive holds levels to draw with it, for the same reason the
        # states are measured: a legend for a ramp that is not on the map is an aspiration.
        if self.measure is not None and "level" in change_types:
            entry["measure"] = self.measure.manifest_entry()
        return entry


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
