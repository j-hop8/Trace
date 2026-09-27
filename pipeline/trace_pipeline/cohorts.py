"""Which tile layer each feature is written to -- the pipeline's half of the web's cohorts.

The web draws a domain as one MapLibre layer per *cohort*: a change state gets one layer per
year of `valid_from`, and cover and level each get one layer per node of a binary interval tree
over the domain's years, so that the slider can animate a year as a constant opacity per layer
without ever rewriting a filter (`web/src/domains/layerSpec.ts`). Every one of those layers
carries a fixed filter that selects its cohort.

What this module decides is what those filters are *run against*. MapLibre's worker scopes a
style layer's filter to the tile layer it names, and walks every feature in that tile layer
through it -- so 589 style layers over one tile layer means every feature is tested 589 times per
tile, and at the opening view that was measured at ~43 s of worker time for a single water tile.
Writing each feature into a tile layer named after its cohort makes each filter a pass over its
own cohort only, which is the difference between minutes and seconds on first load.

The naming rule here must be the web's cohort rule, node for node, or a layer selects nothing.
There is no way to share the code across the language boundary, so this module is written to be
compared line by line with `intervalNodes` / `cohortFilter` / `intervalFilter` in `layerSpec.ts`,
and `web/src/domains/layerSpec.tiles.test.ts` proves the two agree against the built archives:
for every style layer, the filter over the whole tile selects exactly its tile layer.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Iterator, Mapping
from dataclasses import dataclass
from functools import cached_property
from typing import Any

from trace_pipeline import schema

#: `loss:2013` for a year cohort; `cover:2001-2026` or `level:2013-2014` for an interval node. The
#: separator is chosen so the name can never collide with a domain id, which is what the tile
#: layer used to be called; a manifest from before this scheme is refused by version rather than
#: misread.
_LAYER_NAME = re.compile(r"^(?P<change_type>[a-z]+):(?P<start>\d{4})(?:-(?P<end>\d{4}))?$")

#: Which cohort model each kind of state is drawn with -- the web's `cohortModelFor`. A change
#: never closes, so a cohort per year of `valid_from` switches on and stays on. Cover and level
#: both end, so both need the interval tree: a level is a state that ends the year after it
#: begins, which the tree holds in a leaf. Written out rather than defaulted, so a new kind in the
#: schema is a `KeyError` here until someone decides how it is drawn.
MODEL_OF_KIND: dict[str, str] = {"change": "year", "cover": "interval", "level": "interval"}


class CohortError(ValueError):
    """Raised when a feature cannot be placed in any cohort the web would build."""


@dataclass(frozen=True)
class Node:
    """One node of the interval tree: half-open `[start, end)`, like the validity it matches."""

    start: int
    end: int
    parent: Node | None

    def layer(self, change_type: str) -> str:
        """This node's tile layer for one interval-kind state: `cover:2001-2026`."""
        return f"{change_type}:{self.start}-{self.end}"

    def covered_by(self, valid_from: int, valid_to: int) -> bool:
        return valid_from <= self.start and valid_to >= self.end


def interval_nodes(first_year: int, last_year: int) -> list[Node]:
    """The `2N - 1` nodes of the binary tree over `[first_year, last_year + 1)`, pre-order.

    The split is `mid = floor((start + end) / 2)`, recursing while a node spans more than one
    year -- exactly `intervalNodes` in `layerSpec.ts`. A different split would build a different
    tree, and every cover node's name would then name a layer the web never asks for.
    """
    nodes: list[Node] = []

    def split(start: int, end: int, parent: Node | None) -> None:
        node = Node(start, end, parent)
        nodes.append(node)
        if end - start > 1:
            mid = (start + end) // 2
            split(start, mid, node)
            split(mid, end, node)

    split(first_year, last_year + 1, None)
    return nodes


def canonical_nodes(nodes: Iterable[Node], valid_from: int, valid_to: int | None) -> list[Node]:
    """The nodes whose union is `[valid_from, valid_to)` clipped to the tree, each year once.

    A node is canonical for an interval iff the interval covers the node but not its parent --
    the maximal nodes inside it. That is the selection `intervalFilter` makes, so a copy of the
    feature in each of these tile layers is found by exactly the style layers that would have
    selected it from a single layer.

    Absent `valid_to` means the state has not ended; `layerSpec.ts` reads a missing attribute as
    9999 for the same reason (tippecanoe drops null-valued attributes).
    """
    end = valid_to if valid_to is not None else _OPEN_ENDED_YEAR
    return [
        node
        for node in nodes
        if node.covered_by(valid_from, end)
        and (node.parent is None or not node.parent.covered_by(valid_from, end))
    ]


#: A sentinel past any year the schema allows -- the web's `OPEN_ENDED_YEAR`.
_OPEN_ENDED_YEAR = 9999


@dataclass(frozen=True)
class Cohorts:
    """The complete set of tile layers a domain's tileset may hold, for one year range."""

    first_year: int
    last_year: int

    # Built once: `layers_for` is called per feature, and a tree rebuilt 600,000 times is also a
    # tree whose nodes are never the same objects twice.
    @cached_property
    def nodes(self) -> list[Node]:
        return interval_nodes(self.first_year, self.last_year)

    def layers_for(self, properties: Mapping[str, Any]) -> list[str]:
        """Every tile layer this feature belongs in: one for change, one per node otherwise.

        Empty only for a cover feature that ended before the range began -- forest's `[2000,
        2001)`, standing in the baseline year and gone by the first year the slider shows. No
        layer could draw it, so it is left out, and the tiling step reports how many were. A
        feature that *begins after* the range ends is refused instead: that is data the domain's
        range does not admit to, and tiling it into nothing would be dropping it silently.
        """
        change_type = properties["change_type"]
        valid_from = int(properties["valid_from"])
        valid_to = properties.get("valid_to")

        if valid_from > self.last_year:
            raise CohortError(
                f"a {change_type} feature begins in {valid_from}, after the domain's last year "
                f"{self.last_year} -- the GeoJSON was extracted for a different year range than "
                f"the domain reports now"
            )

        if _model(change_type) == "year":
            # The web's first cohort takes everything from the start year *back*, so a change dated
            # before the range lands in it rather than in no cohort at all (`cohortFilter`).
            return [f"{change_type}:{max(valid_from, self.first_year)}"]

        placed = canonical_nodes(
            self.nodes, valid_from, None if valid_to is None else int(valid_to)
        )
        return [node.layer(change_type) for node in placed]

    def all_layers(self, change_types: Iterable[str]) -> list[str]:
        """Every tile layer the web would build a style layer for, given these states."""
        names: list[str] = []
        for change_type in change_types:
            if _model(change_type) == "interval":
                names.extend(node.layer(change_type) for node in self.nodes)
            else:
                names.extend(
                    f"{change_type}:{year}" for year in range(self.first_year, self.last_year + 1)
                )
        return names

    def is_layer(self, name: str) -> bool:
        """Whether a tile layer name is one the web builds for this range.

        Every year cohort within the range, every node of this range's tree, and nothing else:
        a tileset built for a different range names nodes this tree does not have.
        """
        match = _LAYER_NAME.match(name)
        if not match:
            return False

        change_type = match["change_type"]
        if change_type not in schema.kind_of():
            return False

        start = int(match["start"])
        if match["end"] is None:
            return _model(change_type) == "year" and self.first_year <= start <= self.last_year

        end = int(match["end"])
        return _model(change_type) == "interval" and any(
            node.start == start and node.end == end for node in self.nodes
        )


def _model(change_type: str) -> str:
    """`"year"` or `"interval"`: how a state's cohorts are cut, decided by its kind."""
    return MODEL_OF_KIND[schema.kind_of()[change_type]]


def change_type_of(layer_name: str) -> str | None:
    """The state a tile layer holds, read off its name; None if the name is not a cohort's."""
    match = _LAYER_NAME.match(layer_name)
    return match["change_type"] if match else None


def partition(
    features: Iterable[Mapping[str, Any]], cohorts: Cohorts
) -> Iterator[tuple[str, Mapping[str, Any]]]:
    """Yield `(tile layer, feature)` for every copy to be tiled, in input order.

    A feature with no cohort (see `layers_for`) yields nothing; the caller counts those.
    """
    for feature in features:
        for layer in cohorts.layers_for(feature["properties"]):
            yield layer, feature
