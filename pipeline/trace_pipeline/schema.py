"""The B4 feature spine in Python, and the gate that keeps bad features out of the tiles.

`schema/feature.schema.json` is authoritative; this module is its Python side. Two layers of
defence, deliberately:

- :class:`TraceFeature` validates on construction, so a domain module fails at the line that
  built the bad feature.
- :func:`validate` re-checks whole collections, because features also arrive as raw GeoJSON from
  Earth Engine exports that never pass through the dataclass.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

import jsonschema

# trace_pipeline/schema.py -> pipeline/ -> repo root
REPO_ROOT = Path(__file__).resolve().parents[2]
SCHEMA_PATH = REPO_ROOT / "schema" / "feature.schema.json"

ChangeType = Literal["cover", "gain", "level", "loss", "stable"]
Kind = Literal["cover", "change", "level"]

#: How many individual problems to name before truncating. A malformed export can produce tens of
#: thousands of identical errors; the first handful plus a count is what actually helps.
MAX_REPORTED_PROBLEMS = 10


class FeatureValidationError(ValueError):
    """Raised when features do not satisfy the B4 contract.

    Carries the full problem list, so a caller can log everything, while `str()` stays short
    enough to read in a terminal.
    """

    def __init__(self, problems: Sequence[str]) -> None:
        self.problems = list(problems)

        shown = self.problems[:MAX_REPORTED_PROBLEMS]
        body = "\n".join(f"  - {p}" for p in shown)
        hidden = len(self.problems) - len(shown)
        if hidden > 0:
            body += f"\n  ... and {hidden} more"

        count = len(self.problems)
        noun = "problem" if count == 1 else "problems"
        super().__init__(f"{count} schema {noun}:\n{body}")


@lru_cache(maxsize=1)
def load_schema() -> dict[str, Any]:
    """The authoritative JSON Schema, read once and cached."""
    with SCHEMA_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


@lru_cache(maxsize=1)
def _validator() -> jsonschema.protocols.Validator:
    """Validates a whole GeoJSON Feature."""
    schema = load_schema()
    cls = jsonschema.validators.validator_for(schema)
    cls.check_schema(schema)
    return cls(schema)


@lru_cache(maxsize=1)
def _properties_validator() -> jsonschema.protocols.Validator:
    """Validates a bare ``properties`` object, for features that have no geometry yet.

    :class:`TraceFeature` is constructed before Earth Engine hands back a geometry, so it can only
    check the half it has.
    """
    schema = load_schema()["$defs"]["properties"]
    cls = jsonschema.validators.validator_for(load_schema())
    return cls(schema)


def required_property_names() -> list[str]:
    """The `properties` fields the schema marks required.

    Read from the schema rather than restated here -- a copy would be one more thing to drift.
    """
    return list(load_schema()["$defs"]["properties"]["required"])


@lru_cache(maxsize=1)
def kind_of() -> dict[str, str]:
    """The state kind for every change type, derived from the schema."""
    return dict(load_schema()["$defs"]["properties"]["properties"]["change_type"]["x-kind"])


@lru_cache(maxsize=1)
def spine_field_names() -> frozenset[str]:
    """Every property name the B4 spine owns, including the optional ones.

    Derived from the schema rather than hardcoded so a new spine field is automatically protected
    from being shadowed by ``TraceFeature.extra``.
    """
    return frozenset(load_schema()["$defs"]["properties"]["properties"])


@dataclass(frozen=True)
class TraceFeature:
    """One dated, measured feature -- the unit the whole product is built from.

    Field order follows proposal B4. Validation happens in ``__post_init__`` so an invalid feature
    cannot exist: the traceback points at the extraction code that built it, not at a tiling step
    thousands of features later.
    """

    domain: str
    valid_from: int
    valid_to: int | None
    change_type: ChangeType
    metric: Mapping[str, float]
    source: str
    method: str
    confidence: float
    subtype: str | None = None
    #: The class a level feature's value falls in, from 0 at the lowest of the domain's fixed
    #: breaks. Required on a level feature and forbidden on any other (`_check_properties`).
    band: int | None = None
    id: str | int | None = None
    #: Domain-specific extras the spine does not define — e.g. water's GSW transition class.
    #: Keys colliding with a spine field are rejected in ``__post_init__``; see
    #: :func:`spine_field_names` for why that check has to exist.
    extra: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        # Reject collisions before building properties. `extra` is merged last, so a colliding
        # key would otherwise overwrite a typed field: a feature constructed as `water` could
        # emit `forest` into the tiles, and it would pass validation because `forest` is a legal
        # value. Silent misattribution is far worse than a loud constructor failure.
        collisions = sorted(set(self.extra) & spine_field_names())
        if collisions:
            raise FeatureValidationError(
                [
                    f"feature: extra may not contain spine field(s) {', '.join(collisions)} -- "
                    f"set them as arguments instead of smuggling them through extra"
                ]
            )

        props = self.properties()
        problems = [_describe(e, "feature") for e in _properties_validator().iter_errors(props)]
        problems.extend(_check_properties(props, where="feature"))
        if problems:
            raise FeatureValidationError(problems)

    def properties(self) -> dict[str, Any]:
        """The GeoJSON ``properties`` object for this feature."""
        # Extras first, so the authoritative fields win even if the collision guard above were
        # ever bypassed. Belt and braces: the guard gives the good error, this ordering makes
        # silent corruption impossible rather than merely unlikely.
        props: dict[str, Any] = dict(self.extra)
        props.update(
            {
                "domain": self.domain,
                "valid_from": self.valid_from,
                "valid_to": self.valid_to,
                "change_type": self.change_type,
                "metric": dict(self.metric),
                "source": self.source,
                "method": self.method,
                "confidence": self.confidence,
            }
        )
        # Only emit subtype when there is one. The schema marks it optional (B4), so a null
        # placeholder on every forest patch would be noise in every tile.
        if self.subtype is not None:
            props["subtype"] = self.subtype
        # Likewise band: it exists only on the level kind, and a null on every other feature
        # would be one more attribute in every island group for nothing.
        if self.band is not None:
            props["band"] = self.band
        return props

    def to_geojson_feature(self, geometry: Mapping[str, Any]) -> dict[str, Any]:
        """Pair these properties with a geometry to make a GeoJSON Feature.

        Geometry comes in separately because it is produced by Earth Engine's vectorization,
        while the properties are assembled by the domain module.
        """
        feature: dict[str, Any] = {
            "type": "Feature",
            "geometry": dict(geometry),
            "properties": self.properties(),
        }
        if self.id is not None:
            feature["id"] = self.id
        return feature


def _check_properties(props: Mapping[str, Any], where: str) -> list[str]:
    """The rules JSON Schema *cannot* express, checked in code.

    Strictly the complement of the schema, never an overlap. JSON Schema compares a value against
    a constraint but never against a sibling value, so the ordering rule has to live here --
    whereas ``metric`` being non-empty is `minProperties: 1` in the schema and is deliberately
    *not* repeated, or every empty metric would be reported twice.
    """
    problems: list[str] = []

    valid_from = props.get("valid_from")
    valid_to = props.get("valid_to")
    if isinstance(valid_from, int) and isinstance(valid_to, int) and valid_to <= valid_from:
        # Half-open: valid_to is the first year the state no longer holds, so equality is an empty
        # interval -- a state that ended the year it began, which is no state at all.
        problems.append(
            f"{where}: valid_to ({valid_to}) is not after valid_from ({valid_from}) -- "
            f"a state cannot end before it begins, and [from, to) with to == from is empty"
        )

    # Change accumulates: a verdict drawn from the year it applies and for every year after, so a
    # change-kind feature never closes. Cover is the kind that ends. Enforced here because JSON
    # Schema cannot condition one field on another's `x-kind`.
    change_type = props.get("change_type")
    kind = kind_of().get(change_type) if isinstance(change_type, str) else None
    if kind == "change" and valid_to is not None:
        problems.append(
            f"{where}: change_type {change_type!r} is a change, and change never closes -- "
            f"valid_to must be null; only a cover feature ends"
        )

    # A level is a value measured over one year: it closes, and it closes the year after it
    # begins. Open-ended, it would claim a temperature for years nobody measured; spanning
    # several, it would stand one number in for years that each had their own.
    if kind == "level" and isinstance(valid_from, int) and valid_to != valid_from + 1:
        problems.append(
            f"{where}: a level holds for exactly one year -- valid_to must be "
            f"{valid_from + 1} (valid_from + 1), not {valid_to!r}"
        )

    # The band is what colours a level at every zoom, pooled or not, so a level without one
    # cannot be drawn; and on any other kind it would be a class nobody's breaks define.
    has_band = props.get("band") is not None
    if kind == "level" and not has_band:
        problems.append(f"{where}: a level feature must carry a band -- the class it is drawn in")
    if kind is not None and kind != "level" and has_band:
        problems.append(
            f"{where}: band is only for level features, not change_type {change_type!r}"
        )

    return problems


def _describe(error: jsonschema.ValidationError, where: str) -> str:
    """Turn a jsonschema error into something a human can act on.

    The default rendering is a multi-line dump of the failing schema. What the reader needs is
    which feature, which field, and what was wrong.
    """
    path = ".".join(str(p) for p in error.absolute_path) or "(root)"
    return f"{where}: {path} -- {error.message}"


def validate_feature(feature: Mapping[str, Any], where: str = "feature") -> list[str]:
    """Problems with a single GeoJSON Feature. Empty list means it is valid."""
    problems = [_describe(e, where) for e in _validator().iter_errors(feature)]

    props = feature.get("properties")
    if isinstance(props, Mapping):
        problems.extend(_check_properties(props, where))

    return problems


def validate(feature_collection: Mapping[str, Any]) -> None:
    """Check a whole FeatureCollection, or raise :class:`FeatureValidationError`.

    Features are validated one at a time rather than through the collection subschema, purely so
    the error message can name the offending index -- "feature[8123]" is actionable, a JSON
    pointer into a 40k-element array is not.
    """
    problems: list[str] = []

    if feature_collection.get("type") != "FeatureCollection":
        problems.append(
            f"(root): type is {feature_collection.get('type')!r}, expected 'FeatureCollection'"
        )

    features = feature_collection.get("features")
    if not isinstance(features, list):
        problems.append(f"(root): features is {type(features).__name__}, expected a list")
        raise FeatureValidationError(problems)

    for index, feature in enumerate(features):
        if not isinstance(feature, Mapping):
            problems.append(f"feature[{index}]: expected an object, got {type(feature).__name__}")
            continue
        problems.extend(validate_feature(feature, where=f"feature[{index}]"))

    if problems:
        raise FeatureValidationError(problems)


def feature_collection(features: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    """Wrap features in a FeatureCollection. Does not validate -- call :func:`validate` for that."""
    return {"type": "FeatureCollection", "features": list(features)}
