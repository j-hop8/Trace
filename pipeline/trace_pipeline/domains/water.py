"""Water domain — JRC Global Surface Water extraction.

**The version probe.** `config.GSW_V15_YEARLY` is a *project-hosted* Earth Engine asset, not a
catalog one, so read access is never guaranteed the way `JRC/GSW1_4/...` is. Every entry point
that needs the domain's range probes it first and falls back to v1.4 alone rather than assuming —
see :func:`gsw_v15_reachable` and :meth:`WaterDomain._resolve`. The range actually obtained is what
`temporal_range()` reports, never a hardcoded 2024.

**Per-pixel first/last water year.** JRC's `YearlyHistory` collection is one image per year, each
pixel classed `WATER_CLASS_NOT_WATER` / `_SEASONAL` / `_PERMANENT` (`config.WATER_CLASS_*`). A
pixel counts as water in a given year at `_SEASONAL` or above. Stacking every year's water mask,
tagging each with its own year, and reducing the stack with `min`/`max` gives the first and last
year each pixel was observed as water — the same "reduce a per-year stack" shape as forest's
per-year loop, just resolved as one reduction over the time axis instead of one Earth Engine
request per year, because there is no per-pixel encoded date to decode here the way Hansen's
`lossyear` has one.
"""

from __future__ import annotations

import logging
from typing import Any

from trace_pipeline import config
from trace_pipeline.domains.base import Domain, SourceInfo, register

logger = logging.getLogger(__name__)

METHOD = "JRC GSW yearly waterClass"

#: JRC's own accuracy figures for the yearly water classification are global, not per-pixel or
#: per-biome, so — same reasoning as Hansen's flat CONFIDENCE in forest.py — one honest flat value
#: is correct here rather than a fabricated per-feature score.
CONFIDENCE = 0.8

#: The `transition` band of `config.GSW_MAPPING_LAYERS` (JRC's own class codes), carried through
#: as `subtype`. Not a Trace invention — this is JRC's published encoding for how a pixel's water
#: state moved between the first and second half of the observed record.
GSW_TRANSITION_CLASSES: dict[int, str] = {
    1: "permanent",
    2: "new permanent",
    3: "lost permanent",
    4: "seasonal",
    5: "new seasonal",
    6: "lost seasonal",
    7: "seasonal to permanent",
    8: "permanent to seasonal",
    9: "ephemeral permanent",
    10: "ephemeral seasonal",
}

#: Minimum mapping unit, in pixels rather than hectares — same reason as forest's
#: `config.MIN_PATCH_PIXELS`: both sources share `config.NATIVE_SCALE_M`, and a Landsat pixel's
#: true geodesic area varies with latitude, so an area threshold would silently behave as a
#: different pixel count depending on where in Taiwan a patch sits. Counting pixels does not.
#: Two pixels, matching forest's choice, until a water-specific measurement says otherwise — 埤塘
#: (irrigation ponds) run smaller than forest patches on average, so this floor should be revisited
#: once real polygon counts are in.
MIN_PATCH_PIXELS = 2

#: JRC's own pixel geometry differs slightly from Hansen's; used only to state the mapping floor
#: in the caveat, exactly like forest's `TAIWAN_PIXEL_HA`, never for filtering. GSW is nominally
#: `config.NATIVE_SCALE_M` (30 m) like Hansen, so the same ~0.071 ha/pixel figure applies until a
#: real extraction measures JRC's actual grid.
WATER_PIXEL_HA = 0.071

#: The AOI is split into a WATER_GRID x WATER_GRID grid before extracting, for the same reason as
#: forest's `EXTENT_GRID`: one request over the whole island cannot carry it. Chosen by
#: extrapolation, not forest's own more rigorous practice of measuring several grid sizes against
#: the real, full worst case (`EXTENT_GRID`'s comment records three) — a ~0.98 deg² slice of
#: northern Taiwan took 53 s for 6,823 features, so this starts at forest's own floor on the
#: assumption water's heavier per-pixel cost (a 38-year stack reduction plus a `reduceRegions`
#: join, against forest's single boolean mask) needs at least as fine a grid. The real full run
#: this shipped with confirms 4 is *sufficient* (30,606 features across 16 cells, one cell alone
#: carrying 7,599 — already denser than the sampled slice) but not that it is *necessary*; a
#: pathologically denser cell than any seen so far could still hit the request-too-large failure
#: forest's own comment documents at 2x2/3x3. Revisit with forest's measure-don't-extrapolate
#: approach if that ever happens.
#:
#: The consequence to remember, same as forest's: a water body straddling a cell edge comes back
#: as two features, so `area_ha` on a patch describes the piece inside its own cell, not the whole
#: body — summing areas from these features is therefore not a way to measure island-wide water.
#: Unlike forest's extent pass, a split here also gives the two pieces independent `first_year`/
#: `last_year`/`change_type`: a pond that filled in the middle of the record but straddles a cell
#: boundary can come back as one half "stable" and the other "gain", with no shared record tying
#: them back into one physical body.
WATER_GRID = 4


def gsw_v15_reachable() -> bool:
    """Whether the project-hosted v1.5 asset can actually be read right now.

    A module-level function, not a method, so a test can replace it with a fixed answer without
    touching `WaterDomain` at all. Every failure mode — permission denied, asset moved, asset
    simply not shared with this Earth Engine project — means the same thing here: fall back to
    v1.4, so they are all folded into one `False` rather than distinguished.

    Initializes Earth Engine itself first, rather than trusting the caller to have done it.
    `cli.py`'s own module doc promises `trace list` keeps working "while those modules are still
    being built" — it never calls `extract.initialize()`, since forest's `temporal_range()` is a
    pure `config` lookup with no such need. Without this, `trace list` would reach here
    uninitialized, fail inside the `try` below, and silently report the pessimistic v1.4 fallback
    as if v1.5 had genuinely been checked and found unreachable, even when it would have succeeded.
    """
    import ee

    from trace_pipeline.extract import initialize

    try:
        initialize()
        ee.ImageCollection(config.GSW_V15_YEARLY).limit(1).size().getInfo()
        return True
    except Exception:  # noqa: BLE001 -- unreachable is unreachable, whatever the cause
        return False


def derive_change_type(first_year: int, last_year: int, range_first: int, range_last: int) -> str:
    """The B4 `change_type` for a patch observed as water from `first_year` to `last_year`.

    Priority is loss, then gain, then stable — not the ticket's listing order, but the order that
    matches what a reader most needs to know. A pond that both appeared and disappeared within the
    record (e.g. built, then drained, before the last observed year) is more usefully flagged as a
    loss than a gain: "this is gone" is the more actionable fact than "this once arrived."

    - `last_year < range_last`: it stopped being water before the record ends — **loss**, whatever
      happened at the start.
    - `first_year > range_first`: it was not there at the start but is still water at the end —
      **gain**.
    - Otherwise it was water at the start and still is at the end — **stable**.
    """
    if last_year < range_last:
        return "loss"
    if first_year > range_first:
        return "gain"
    return "stable"


def build_feature(
    geometry: dict[str, Any],
    *,
    first_year: int,
    last_year: int,
    range_first: int,
    range_last: int,
    area_ha: float,
    gsw_asset: str,
    transition_code: int | None = None,
) -> dict[str, Any]:
    """Assemble one B4 feature from a vectorized water patch.

    `valid_to` is `None` exactly when the patch is still water in the final observed year — an
    open-ended feature, same convention as forest's loss/extent — and is otherwise `last_year`,
    the last year this patch was actually seen as water.
    """
    from trace_pipeline.schema import TraceFeature

    change_type = derive_change_type(first_year, last_year, range_first, range_last)
    # Derived from `change_type` rather than re-testing `last_year` against `range_last`
    # independently: `derive_change_type` already answers exactly this question (its `loss`
    # branch *is* "stopped before the record ends"), and writing the same boundary twice is how
    # the two could quietly drift apart if that logic's boundary is ever adjusted.
    valid_to = last_year if change_type == "loss" else None
    subtype = GSW_TRANSITION_CLASSES.get(transition_code) if transition_code is not None else None

    feature = TraceFeature(
        domain=WaterDomain.id,
        valid_from=first_year,
        valid_to=valid_to,
        change_type=change_type,  # type: ignore[arg-type]  -- validated against the schema, not the stale Literal
        metric={"area_ha": round(area_ha, 4)},
        source=gsw_asset,
        method=METHOD,
        confidence=CONFIDENCE,
        subtype=subtype,
    )
    return feature.to_geojson_feature(geometry)


#: `(first_year, last_year, asset_id)` actually available, cached at module rather than instance
#: scope. `cli.py` constructs a fresh `WaterDomain()` per pipeline stage (`domain_registry.get()`
#: instantiates on every call), so an instance-scoped cache lets `extract`, `tiles`, and `manifest`
#: each probe independently — a `trace all` run where v1.5 flips reachable partway through would
#: extract tiles under one version and then have the manifest describe a different one. Every
#: instance sharing one process-wide answer is what "probed at most once" actually has to mean.
_resolved_gsw: tuple[int, int, str] | None = None


def _resolve_gsw() -> tuple[int, int, str]:
    global _resolved_gsw
    if _resolved_gsw is None:
        if gsw_v15_reachable():
            last = config.GSW_V15_LAST_YEAR
            asset = config.GSW_V15_YEARLY
            logger.info(
                "water: GSW v1.5 reachable, using %s (%d-%d)", asset, config.GSW_FIRST_YEAR, last
            )
        else:
            last = config.GSW_V14_LAST_YEAR
            asset = config.GSW_V14_YEARLY
            logger.info(
                "water: GSW v1.5 unreachable, falling back to %s (%d-%d)",
                asset,
                config.GSW_FIRST_YEAR,
                last,
            )
        _resolved_gsw = (config.GSW_FIRST_YEAR, last, asset)
    return _resolved_gsw


@register
class WaterDomain(Domain):
    id = "water"
    label = {"en": "Water", "zh": "水體"}
    change_types = ("loss", "gain", "stable")

    def _resolve(self) -> tuple[int, int, str]:
        """`(first_year, last_year, asset_id)` actually available, probing v1.5 at most once."""
        return _resolve_gsw()

    @property
    def source(self) -> SourceInfo:
        _, last, asset = self._resolve()
        version = "v1.5" if asset == config.GSW_V15_YEARLY else "v1.4"
        return SourceInfo(
            name="JRC Global Surface Water",
            version=f"{version} (1984-{last})",
            attribution="Source: EC JRC/Google",
            citation=(
                "Pekel et al., 'High-resolution mapping of global surface water and its "
                "long-term changes', Nature 540 (2016)"
            ),
            licence="Free to use with attribution",
        )

    @property
    def caveat(self) -> str:
        first, last = self.temporal_range()
        pixel_ha = MIN_PATCH_PIXELS * WATER_PIXEL_HA
        return (
            f"Surface water at {config.NATIVE_SCALE_M} m resolution, {first}-{last}. Isolated "
            f"single pixels (under about {pixel_ha:.2f} ha) are not mapped, so the smallest 埤塘 "
            "(irrigation ponds) may be missed entirely, or merged with a neighbour if they sit "
            "closer together than one pixel."
        )

    def temporal_range(self) -> tuple[int, int]:
        first, last, _ = self._resolve()
        return (first, last)

    def _yearly_water_class(self, aoi: Any) -> Any:
        """The per-year `waterClass` stack over `aoi`, v1.4 alone or extended with v1.5.

        v1.5 is published as an extension of v1.4's coverage, not a full replacement — merging
        picks up v1.4's own years unchanged and appends v1.5's images only for the years beyond
        v1.4's own range, rather than asking v1.5 to re-supply years v1.4 already has.
        """
        import ee

        first, last, asset = self._resolve()
        v14 = ee.ImageCollection(config.GSW_V14_YEARLY).filter(
            ee.Filter.And(
                ee.Filter.gte("year", first), ee.Filter.lte("year", config.GSW_V14_LAST_YEAR)
            )
        )
        if asset == config.GSW_V14_YEARLY:
            return v14

        extension = ee.ImageCollection(config.GSW_V15_YEARLY).filter(
            ee.Filter.And(
                ee.Filter.gt("year", config.GSW_V14_LAST_YEAR), ee.Filter.lte("year", last)
            )
        )
        return v14.merge(extension)

    def water_stats_image(self, aoi: Any) -> Any:
        """The 3-band ee.Image of `first_year` / `last_year` / `transition`, clipped to `aoi`.

        Each year's image is masked to where it was observed as water and tagged with its own
        year; reducing the masked stack with `min`/`max` gives, per pixel, the first and last year
        it was seen as water. A pixel never observed as water has no contributing image at all and
        reduces to fully masked, which is what makes `first_year`'s own mask the "was this ever
        water" mask vectorizing runs against.
        """
        import ee

        stack = self._yearly_water_class(aoi)

        def tag_year(image: Any) -> Any:
            year = ee.Image.constant(image.get("year")).toInt16()
            was_water = image.select("waterClass").gte(config.WATER_CLASS_SEASONAL)
            return year.updateMask(was_water).rename("year")

        years = stack.map(tag_year)
        first_year = years.reduce(ee.Reducer.min()).rename("first_year")
        last_year = years.reduce(ee.Reducer.max()).rename("last_year")
        # `config.GSW_MAPPING_LAYERS` is a v1.4-only asset with no v1.5 counterpart, so a patch
        # whose water only exists in the v1.5-extension years (2022-2024) still gets a `transition`
        # class computed from JRC's classification of the 1984-2021 window alone — a window that
        # doesn't include the years that actually made the patch exist. Not surfaced in `caveat`;
        # revisit if v1.5 access is ever confirmed and this stops being a theoretical gap.
        transition = (
            ee.Image(config.GSW_MAPPING_LAYERS).select("transition").rename("transition").toInt8()
        )

        return first_year.addBands(last_year).addBands(transition).clip(aoi)

    def grid_cells(self, aoi: Any) -> list[Any]:
        """`aoi` split into `WATER_GRID` x `WATER_GRID` rectangles, in row-major order.

        Same shape as forest's `extent_grid_cells`, over `config.TAIWAN_BBOX` rather than
        whatever `aoi` was passed — the grid is a fixed partition of the island regardless of
        which sub-area extraction is asked for.
        """
        import ee

        west, south, east, north = config.TAIWAN_BBOX
        width = (east - west) / WATER_GRID
        height = (north - south) / WATER_GRID

        cells = []
        for row in range(WATER_GRID):
            for col in range(WATER_GRID):
                cells.append(
                    ee.Geometry.Rectangle(
                        [
                            west + col * width,
                            south + row * height,
                            west + (col + 1) * width,
                            south + (row + 1) * height,
                        ]
                    ).intersection(aoi, maxError=1)
                )
        return cells

    def patches_for_cell(self, cell: Any) -> Any:
        """The ee.FeatureCollection of water patches inside one grid cell, area-tagged."""
        import ee

        stats = self.water_stats_image(cell)
        # `.mask()` reads back the mask *channel* as data, which comes back floating-point --
        # `connectedPixelCount` refuses that outright ("Segment size calculation on floating point
        # bands is not supported"), found by actually running this against Earth Engine. A boolean
        # comparison keeps the source pixels' mask (still masked outside ever-water) but its own
        # result is a real integer type, and `selfMask` then collapses it to one uniform class so
        # vectorizing groups by connectivity alone, not by the varying first_year value underneath.
        ever_water = stats.select("first_year").gt(0).selfMask()

        # Vectorized from the boolean mask alone, exactly like forest's loss/extent passes — the
        # geometry a component gets does not depend on what its pixels' first/last year happen to
        # be, only on which pixels were ever water and how they connect.
        component_size = ever_water.connectedPixelCount(maxSize=16, eightConnected=False)
        kept = ever_water.updateMask(component_size.gte(MIN_PATCH_PIXELS))

        # `scale` rather than the reduced image's own `.projection()`: reducing over an
        # ImageCollection with `.reduce()` does not carry forward a concrete grid the way a single
        # loaded asset band's native projection does, so `crs=<that projection>` alone reaches
        # Earth Engine with no resolvable scale attached ("You must specify a scale or crsTransform
        # when specifying a crs"), found by actually running this. Both sources are natively
        # `config.NATIVE_SCALE_M`, so stating it directly sidesteps relying on that propagation.
        regions = kept.reduceToVectors(
            geometry=cell,
            scale=config.NATIVE_SCALE_M,
            geometryType="polygon",
            eightConnected=False,
            maxPixels=int(1e10),
        )

        # A water body's pixels do not all start or end in the same year -- a pond that grew
        # outward has older water at its centre than at its edge. `mean` gives each polygon a
        # representative onset/end year rather than requiring one that does not exist. The
        # tradeoff: a handful of outlier pixels can pull that mean across `derive_change_type`'s
        # boundary even when most of the patch is not remotely near it -- a reservoir that is 95%
        # still water at the end of the record but has a thin dried edge some years earlier will
        # have its mean `last_year` pulled below `range_last` and be classified `loss` outright.
        # No test exercises this because it needs a real multi-year, spatially-varying pixel
        # history to construct, which is exactly the kind of case only a live extraction surfaces;
        # revisit with a threshold-based rule (e.g. loss only once some minimum share of the
        # patch's area actually stopped being water) if this misclassifies real patches.
        years_by_region = stats.select(["first_year", "last_year"]).reduceRegions(
            collection=regions,
            reducer=ee.Reducer.mean(),
            scale=config.NATIVE_SCALE_M,
        )

        # `transition` is categorical, so `mean` was tried first and rejected -- averaging two
        # JRC class codes (say 3, "lost permanent", and 7, "seasonal to permanent") can land on a
        # third code, like 5, "new seasonal", that describes neither pixel actually in the patch.
        # `mode` reports the class most of the patch's pixels actually carry, which a categorical
        # code calls for. Reducing `years_by_region` again rather than the original `regions` adds
        # this property onto the features that already carry first_year/last_year, instead of
        # recomputing a second, separate collection to merge by hand afterward.
        #
        # `setOutputs(["transition"])` is not decoration: `ee.Reducer.mode()` names its output
        # property after the *reducer* ("mode"), not the band, unlike `mean()` above which happens
        # to use the band name — found by actually running this and seeing every feature come back
        # with `transition: None` because the extraction loop was reading a property that was
        # never written under that name.
        stats_by_region = stats.select("transition").reduceRegions(
            collection=years_by_region,
            reducer=ee.Reducer.mode().setOutputs(["transition"]),
            scale=config.NATIVE_SCALE_M,
        )

        def tag_area(feature: Any) -> Any:
            area_ha = feature.geometry().area(maxError=1).divide(config.M2_PER_HA)
            return feature.set("area_ha", area_ha)

        return stats_by_region.map(tag_area)

    def extract(self, aoi: Any) -> dict[str, Any]:
        from trace_pipeline import extract

        first, last, asset = self._resolve()
        features: list[dict[str, Any]] = []

        for index, cell in enumerate(self.grid_cells(aoi), start=1):
            collection = self.patches_for_cell(cell)
            raw = extract.download_features(
                collection, description=f"water cell {index}/{WATER_GRID**2}"
            )

            for item in raw:
                props = item["properties"]
                features.append(
                    build_feature(
                        geometry=item["geometry"],
                        first_year=round(props["first_year"]),
                        last_year=round(props["last_year"]),
                        range_first=first,
                        range_last=last,
                        area_ha=props["area_ha"],
                        gsw_asset=asset,
                        transition_code=(
                            round(props["transition"])
                            if props.get("transition") is not None
                            else None
                        ),
                    )
                )

            print(
                f"  cell {index}/{WATER_GRID**2}: {len(raw):,} patches "
                f"(running total {len(features):,})",
                flush=True,
            )

        print(f"  {len(features):,} water patches, GSW {asset}", flush=True)
        return {"type": "FeatureCollection", "features": features}
