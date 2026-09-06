"""Water domain — JRC Global Surface Water extraction.

**The version probe.** `config.GSW_V15_YEARLY` is a *project-hosted* Earth Engine asset, not a
catalog one, so read access is never guaranteed the way `JRC/GSW1_4/...` is. Every entry point
that needs the domain's range probes it first and falls back to v1.4 alone rather than assuming —
see :func:`gsw_v15_reachable` and :meth:`WaterDomain._resolve`. The range actually obtained is what
`temporal_range()` reports, never a hardcoded 2024.

**The land mask.** GSW classes ocean as water, and nothing about "was this pixel ever water"
excludes the sea, so the extraction is restricted to Taiwan's land boundary
(:func:`taiwan_land`). Without it the domain maps the Taiwan Strait: in the first full run 12
cell-filling polygons carried 91.3% of all mapped area, each dated `gain` 1988 -- so the layer's
loudest claim was that the strait appeared that year. `config.TAIWAN_LAND_BOUNDARY` records why
that dataset and not the two more obvious candidates.

**Change comes from JRC, not from us.** The `transition` band of `config.GSW_MAPPING_LAYERS` is
JRC's own published verdict on how each pixel's water state moved across the record, and
`CHANGE_TYPE_BY_TRANSITION` maps it onto the B4 `change_type`. An earlier version derived
`change_type` here instead, from the *mean* per-pixel first/last water year against the ends of the
range, and it was wrong at scale: every river and drawdown reservoir has ephemeral margin pixels
that drag that mean under the final year, flipping the whole polygon to `loss`. It put 82.8% of the
layer's area in `loss` and 1.7% in `stable`; 95.4% of that loss area ended in 2015 or later, and
52% of it landed on exactly 2020 — one year short of the 2021 cliff, which is what a boundary
artefact looks like rather than hydrology. 66.0% of the layer was called `loss` while the JRC class
carried on the very same feature said the water was still there. 淡水河 came back as `loss` with
`subtype: permanent`. JRC says 6.5% of the area is lost or declining.

**One polygon per transition class, not per blob.** Vectorizing ran off a single uniform "ever
water" mask, so connectivity alone grouped pixels: 淡水河 + 新店溪 + 大漢溪 + 基隆河 came back as
one 1,886 ha feature spanning 24 x 21 km, and the largest feature on the map was 30,305 ha over 28 x
67 km — 23.2% of the layer under one date pair (T-016). `reduceToVectors` segments on its first
band when that band is integer-valued, so feeding it `transition` gives one feature per contiguous
same-class region. Each polygon is then homogeneous in class, which is what makes `change_type`
exact rather than a `mode` over a mixture, and it splits a permanent river core from its
lost-seasonal margin and the aquaculture belt's ponds from the channels that joined them.

**Why the onset year is mostly not measured.** JRC's `YearlyHistory` is one image per year, each
pixel classed `WATER_CLASS_*`, and `waterClass == 0` is **No data** — a year GSW could not classify,
not a year it saw as dry. Taiwan's early record is largely blind. Measured over the pixels GSW
tracks, the no-data share runs 68.3% in 1984, **100.0% in 1985** (not one usable observation on the
whole island), 99.5% in 1986 and 89.8% in 1987, collapsing through 1988 (33.5%) and under 1% from
1994 — with mid-record relapses in 1997 (21.7%), 1998 (65.3%) and 1999 (26.5%). In 1986, 87.2% of
the pixels that *were* observed were water: the water was there, nothing was looking at it.

So a `min` over the years a pixel was seen as water does not date the water, it dates the
observation — which is why 石門水庫 (dam 1964) and 曾文水庫 (impounded 1973) came back as arriving
in the late 1980s, and why only 2.4% of the layer's area dated to 1984 while the mass piled into
1988-1993. The fix is not a cleverer reduction over a blind record: for the classes JRC already
asserts were water in its first epoch, `valid_from` is `range_first` and no year is measured at all
(`PRESENT_AT_START`). Only the arriving classes get a measured onset, and their onsets sit in the
years the record can actually see. What measurement remains uses `median`, not `mean`, so a dried
margin cannot drag a whole reservoir across a boundary.
"""

from __future__ import annotations

import logging
from typing import Any

from trace_pipeline import config
from trace_pipeline.domains.base import Domain, SourceInfo, register

logger = logging.getLogger(__name__)

METHOD = "JRC GSW transition class; onset from yearly waterClass"

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

#: JRC transition class -> B4 `change_type`. This is the layer's change signal: the source's own
#: classification, not a statistic computed here. The schema's enum is
#: `extent | gain | loss | stable` and is deliberately unchanged, so ten JRC classes fold into
#: three — `subtype` keeps the exact class for anyone who needs the distinction back.
#:
#: The two `ephemeral` classes (appeared *and* went within the record) map to `loss`, preserving
#: the decision the previous derivation already made and documented: "this is gone" is the more
#: actionable fact than "this once arrived".
#:
#: `permanent to seasonal` is `loss` because there is less water than there was — but it is not an
#: *ending*, which is why it is absent from `ENDED` below and keeps `valid_to: None`.
CHANGE_TYPE_BY_TRANSITION: dict[int, str] = {
    1: "stable",  # permanent
    2: "gain",  # new permanent
    3: "loss",  # lost permanent
    4: "stable",  # seasonal
    5: "gain",  # new seasonal
    6: "loss",  # lost seasonal
    7: "gain",  # seasonal to permanent
    8: "loss",  # permanent to seasonal
    9: "loss",  # ephemeral permanent
    10: "loss",  # ephemeral seasonal
}

#: Classes whose definition asserts water was already present in JRC's first epoch (1984-1999).
#: These take `valid_from = range_first` and are never dated by measurement — see the module
#: docstring on why a `min` over a record that is 100% blind in 1985 dates the observation rather
#: than the water.
#:
#: `seasonal to permanent` (7) is here despite being a `gain`, and was missed on the first pass
#: because it reads as an arrival. JRC's class says the pixel was *seasonal water* in epoch 1: the
#: water was already there and only its permanence changed. Measuring its onset therefore lands it
#: in the same 1988-93 pile-up as every other pre-record body — and the measurement does not even
#: answer the question the class poses, because `water_stats_image` tags a year wherever
#: `waterClass >= WATER_CLASS_SEASONAL`, so a measured onset is the first year the pixel was seen
#: as *any* water, never the year it became permanent. Dating that would need a second stack
#: reduced at `config.WATER_CLASS_PERMANENT`; until one exists, the record's start is the honest
#: `valid_from` and the `gain` still carries the change.
#:
#: The membership below is written by hand; what is *derived* is the check on it. A test reads
#: JRC's own naming — a class is already-water in epoch 1 unless it arrived (`new ...`) or never
#: held either epoch's stable state (`ephemeral ...`) — and fails if this set disagrees. Editing
#: `GSW_TRANSITION_CLASSES` therefore does not update this set; it breaks the test, which is the
#: point. Hand-keeping the list *and* its check is exactly how 7 went missing.
PRESENT_AT_START: frozenset[int] = frozenset({1, 3, 4, 6, 7, 8})

#: Classes where the water actually stopped, and so are the only ones that get a `valid_to`.
#: `permanent to seasonal` (8) is pointedly not here: that water declined, it did not end, so its
#: state is still current.
#:
#: Hand-written and test-checked, exactly as `PRESENT_AT_START` above and for the same reason:
#: a test derives the expected membership from JRC's naming — a class ended iff it was `lost ...`
#: (held its state through epoch 1 and was gone by epoch 2) or `ephemeral ...` (came and went
#: inside the record) — so this set cannot drift without failing. It was correct before that test
#: existed; nothing made it stay correct, which is the gap the test closes.
ENDED: frozenset[int] = frozenset({3, 6, 9, 10})

#: Classes dropped where `config.WORLDCOVER_MANAGED_CLASSES` says the ground is built on or farmed
#: — the seasonal-grade ones, which never involve permanent water at either end of the record.
#: `config` records the measurements that chose a managed-land mask over a threshold on GSW's own
#: quality bands.
#:
#: One rule over both land classes, because they are the same mistake: a seasonal water detection
#: on a surface people manage reflects what they do to the ground — shadow between towers,
#: irrigation in a paddy — not a water body. Island-wide the permanent-grade classes sit 79.5% on
#: WorldCover water while the seasonal-grade ones manage 32.1%, so this is where the layer's
#: trustworthy half divides from the rest, not a local patch.
#:
#: Dropping these classes *everywhere* instead was the obvious fix and is the wrong one: it cuts
#: real data harder than the artefact. Taiwan's genuine seasonal water is carried by the same
#: classes — the Chiayi aquaculture belt drains its fish ponds, the Taoyuan 埤塘 are seasonal.
#: Removing 4/5/10 island-wide costs 63% of the layer and takes Taoyuan to 52% and Chiayi to 74%;
#: restricted to managed ground the same rule costs 12.6% and leaves them at 90% and 98%.
#:
#: **Why 3, 6 and 9 are not here.** WorldCover is a 2021 snapshot, so managed is a claim about
#: today, and a class saying the water *ended* is entirely consistent with the ground having been
#: taken over — a 埤塘 filled in for housing or converted to a field, which is the most interesting
#: water story Taiwan has. 15% of `lost permanent` and 12% of `lost seasonal` sit on built-up land
#: for exactly that reason, and masking them would delete the story along with the artefact.
#:
#: **Why 10 is here despite also having ended.** `ephemeral` means the water never held either
#: epoch's stable state; it flickered. Flickering sub-pixel water on managed ground is shadow or a
#: wet field, not a pond that was filled in.
#:
#: `permanent to seasonal` (8) is 16% built-up and is likewise kept: it involves permanent water,
#: so it is a pond encroached on rather than an artefact.
MASK_ON_MANAGED_LAND: frozenset[int] = frozenset({4, 5, 10})

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
#: this shipped with confirms 4 is *sufficient* (36,721 features across the 15 land-bearing
#: cells, one alone carrying 7,941 — already denser than the sampled slice) but not that it is
#: *necessary*; a
#: pathologically denser cell than any seen so far could still hit the request-too-large failure
#: forest's own comment documents at 2x2/3x3. Revisit with forest's measure-don't-extrapolate
#: approach if that ever happens.
#:
#: Segmenting per transition class rather than per connected blob multiplied the feature count
#: roughly fourfold — 149,849 across the same 15 cells, with the worst carrying 59,443 against the
#: previous worst of 7,941 — so this was re-measured rather than assumed to still hold. It does:
#: that cell downloads in one request. An 8x8 grid was measured too (42 land cells, worst 28,123)
#: and is the fallback if a future source pushes a cell past what one request can carry.
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


#: Taiwan's land boundary as one ee.Geometry, built at most once per process.
_land_geometry: Any | None = None


def taiwan_land() -> Any:
    """Taiwan's land boundary as an ee.Geometry, cached for the life of the process.

    A module-level function for the same reason as :func:`gsw_v15_reachable`: a test can replace
    it without touching `WaterDomain`. The asset id and its filter field come from `config` and
    appear nowhere else, so a boundary that moves or is renamed is a one-line change there.

    A *geometry* rather than the FeatureCollection it comes from, because the two clip very
    differently. `clipToCollection` rasterizes the collection over every tile it touches, and
    adding that to a 38-year stack reduction was enough to take a cell from working to a
    server-side HTTP 500. Clipping to the geometry asks Earth Engine for a vector intersection it
    does natively, and the cost does not scale with the area being read.
    """
    import ee

    global _land_geometry
    if _land_geometry is None:
        _land_geometry = (
            ee.FeatureCollection(config.TAIWAN_LAND_BOUNDARY)
            .filter(
                ee.Filter.eq(config.TAIWAN_LAND_BOUNDARY_FIELD, config.TAIWAN_LAND_BOUNDARY_VALUE)
            )
            .geometry()
        )
    return _land_geometry


class UnknownTransitionClass(ValueError):
    """A `transition` value outside JRC's documented 1-10.

    Raised rather than defaulted. Asset versions drift — that is this pipeline's standing gotcha —
    and a class this module has never seen must be looked at, not silently painted a colour. The
    extraction is chunked per grid cell, so this surfaces on the first cell rather than after a
    full run.
    """


#: Managed ground as one ee.Image, built at most once per process.
_managed_land_image: Any | None = None


def managed_land() -> Any:
    """Ground people build on or farm, as a 1/0 ee.Image, cached for the life of the process.

    A module-level function for the same reason as :func:`taiwan_land`: a test can replace it
    without touching `WaterDomain`, and the asset id lives in `config` alone.

    `unmask(0)` is the load-bearing part. Anywhere the source does not cover has to read as *not*
    managed, so a gap in the reference dataset keeps the water rather than deleting it — a mask that
    fails open loses nothing, one that fails closed silently erases real data in exactly the places
    nobody is looking.
    """
    import ee

    global _managed_land_image
    if _managed_land_image is None:
        classes = list(config.WORLDCOVER_MANAGED_CLASSES)
        _managed_land_image = (
            ee.ImageCollection(config.WORLDCOVER_ASSET)
            .first()
            .select("Map")
            .remap(classes, [1] * len(classes), 0)
            .unmask(0)
        )
    return _managed_land_image


def derive_change_type(transition_code: int) -> str:
    """The B4 `change_type` for a patch of JRC transition class `transition_code`.

    A lookup, not a derivation: the source already answered this question across the whole record,
    with proper handling of the years it could not observe. See `CHANGE_TYPE_BY_TRANSITION` for the
    mapping and the module docstring for what deriving it here instead cost.
    """
    try:
        return CHANGE_TYPE_BY_TRANSITION[transition_code]
    except KeyError:
        raise UnknownTransitionClass(
            f"transition class {transition_code!r} is not one of JRC's documented 1-10; "
            f"{config.GSW_MAPPING_LAYERS} may have changed"
        ) from None


def derive_valid_from(transition_code: int, measured_first_year: int, range_first: int) -> int:
    """The year this patch's water begins, measured only where measuring means anything.

    A class in `PRESENT_AT_START` is one JRC defines as already water in its first epoch, so the
    honest answer is `range_first` — the record starts with the water already there, and it cannot
    say when it arrived. Measuring instead is what dated 石門水庫 (dam 1964) to the late 1980s: GSW
    has no usable observation of Taiwan at all in 1985, so the first year a pixel can be *seen* as
    water is not the first year it *was* water.

    Arriving classes do get their measured onset, which is sound because their onset is by
    definition inside the record; it is floored at `range_first` so a median cannot land the
    feature outside the range the manifest publishes.
    """
    if transition_code in PRESENT_AT_START:
        return range_first
    return max(measured_first_year, range_first)


def derive_valid_to(transition_code: int, measured_last_year: int, range_last: int) -> int | None:
    """The year this patch's water ends, or `None` if it has not ended.

    Only the `ENDED` classes close. `None` is the B4 convention for a state that is still current,
    and it is the common case here — including for `permanent to seasonal`, which is `loss` because
    there is less water than there was, not because the water went away.

    Capped at `range_last`: the record ending is not the state ending, so a median that rounds to
    the final year would otherwise assert an end the source never observed.
    """
    if transition_code not in ENDED:
        return None
    return min(measured_last_year, range_last)


def build_feature(
    geometry: dict[str, Any],
    *,
    transition_code: int,
    first_year: int,
    last_year: int,
    range_first: int,
    range_last: int,
    area_ha: float,
    gsw_asset: str,
) -> dict[str, Any]:
    """Assemble one B4 feature from a vectorized water patch.

    `transition_code` is required rather than optional: it is the class the polygon was segmented
    on, so every patch has exactly one, and it now decides `change_type`, `valid_from` and
    `valid_to` as well as `subtype`. An absent class is a bug in the extraction, not a feature to
    emit without a change signal.

    `first_year` / `last_year` are the *measured* medians and are only consulted for the classes
    that actually need them — see `derive_valid_from` and `derive_valid_to`.
    """
    from trace_pipeline.schema import TraceFeature

    feature = TraceFeature(
        domain=WaterDomain.id,
        valid_from=derive_valid_from(transition_code, first_year, range_first),
        valid_to=derive_valid_to(transition_code, last_year, range_last),
        change_type=derive_change_type(transition_code),  # type: ignore[arg-type]  -- validated against the schema, not the stale Literal
        metric={"area_ha": round(area_ha, 4)},
        source=gsw_asset,
        method=METHOD,
        confidence=CONFIDENCE,
        # Same dict the change signal comes from, so the human-readable class and the colour can
        # never describe different things.
        subtype=GSW_TRANSITION_CLASSES[transition_code],
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
            f"Surface water at {config.NATIVE_SCALE_M} m resolution, {first}-{last}. Gain, loss "
            "and stability are JRC's own transition classes, which compare its two epochs over "
            f"{config.GSW_FIRST_YEAR}-{config.GSW_V14_LAST_YEAR} — so change is measured over that "
            "window whatever range the extent above covers, and a shape here is one region of a "
            "single transition class rather than a whole lake or river. A body whose middle stayed "
            "permanent while its edge dried is two features, not one, and an area figure describes "
            "the class region, not the body. Loss here is broader than disappearance: it bundles "
            "water that was only ever ephemeral, seasonal water that went, and permanent water "
            "that dropped to seasonal but is still present. Permanent water that vanished outright "
            f"is about {config.WATER_LOST_PERMANENT_PCT:.1f}% of the layer. "
            "Loss is dated from when the water was there, not from when it went. The three "
            "classes JRC says already held water in its first epoch — the two it calls lost, "
            "and the decline just described — all carry the record's "
            f"first year, so about {config.WATER_LOSS_DATED_AT_START_PCT:.0f}% of this "
            "layer's loss is already drawn in the earliest frames: water that was there then "
            "and was lost at some point over the decades that followed, not water lost that "
            "year. It reads as a coastline because the seasonal-grade classes sit on tidal "
            "flats, river mouths and fish ponds down the west coast, while mountain "
            "reservoirs stay permanent and never join it. "
            f"Isolated single pixels (under about {pixel_ha:.2f} ha) are not mapped, keeping about "
            f"{config.WATER_RETAINED_PCT:.0f}% of the water that survives the managed-land rule "
            "below, so "
            "the smallest 埤塘 (irrigation ponds) may be missed entirely, or merged with a "
            "neighbour if they sit closer together than one pixel. "
            "Seasonal water on ground that is built on or farmed is deliberately left out. At 30 m "
            "a dense city block reads the shadow between towers as seasonal water, and an "
            "irrigated paddy reads as water because it genuinely is one for a few weeks a year — "
            "neither is a water body, and together they put about seven times more water in "
            "central Taipei than its parks hold and turned Taiwan's rice plains solid blue. "
            "Seasonal patches are therefore dropped wherever the ground is built-up or cropland — "
            f"about {config.WATER_MANAGED_SEASONAL_DROPPED_PCT:.1f}% of the source's water area. "
            "Water the source says has ended is kept there, so a pond filled in for housing or "
            "converted to a field still appears, and so is every permanent body, so lakes inside "
            "cities and farmland remain. That reference is a single 2021 snapshot, so genuine "
            "seasonal water in a district built up or brought into cultivation during the record "
            "is removed along with the artefacts. "
            "Between that rule and the mapping floor, this layer holds about "
            f"{config.WATER_SOURCE_RETAINED_PCT:.1f}% of the water area the source records for "
            "Taiwan. "
            "Regions where the source's two products disagree are left out on top of that: where "
            "the transition band calls a region arriving or ended but the yearly record never sees "
            "water there, no onset can be dated, and the region is dropped rather than given a "
            "guessed year. Each extraction run reports that count; it is not yet folded into the "
            "percentages above. "
            "Gain means a body holds water more of the time than the early record shows, not that "
            "water appeared where there was none: satellite revisit roughly doubled over the "
            "period, so a body that was always seasonally wet is caught more often later and can "
            "read as gain on that alone. "
            "Dates are weaker than the classes. Landsat barely covered Taiwan early on — the "
            "source has no usable observation of the island at all in 1985, and little before "
            f"1988 — so water already present when the record opens is dated {first} because that "
            "is when watching began, not when the water arrived, and an arrival dated before about "
            "1988 may equally be the year the view cleared. "
            "Inland water only: the source classes the sea as water too, so this is clipped to "
            "Taiwan's land boundary. Marine and intertidal water — tidal flats, lagoons and fish "
            "farms seaward of the coastline — is therefore absent rather than measured as "
            "unchanged, and a patch meeting the coast is cut at the boundary, so its area "
            "describes the inland part alone."
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
        """The 3-band ee.Image of `transition` / `first_year` / `last_year`, clipped to `aoi`.

        **`transition` is band 0 and that is load-bearing**: `reduceToVectors` segments on its
        first band when that band is integer-valued, and segmenting on the class is what gives one
        polygon per transition class instead of one blob per connected mass. `toInt8` keeps it
        integer-typed for that.

        The year bands are the *measured* onset and end, and most features never use them — see
        `derive_valid_from`. Each year's image is masked to where it was observed as water and
        tagged with its own year, so `min`/`max` over the stack give the first and last year each
        pixel was *seen* as water.
        """
        import ee

        stack = self._yearly_water_class(aoi)

        def tag_year(image: Any) -> Any:
            year = ee.Image.constant(image.get("year")).toInt16()
            # `waterClass == config.WATER_CLASS_NO_DATA` is *No data*, not dry, and `gte(SEASONAL)`
            # already excludes it here. Worth stating because that exclusion is the subtle half of
            # the problem rather than the fix for it: a blind year does not inject a false water
            # year, it silently pushes `min` later, and Taiwan's record is 100% blind in 1985. The
            # consequence is handled where it can be — `derive_valid_from` — not here.
            was_water = image.select("waterClass").gte(config.WATER_CLASS_SEASONAL)
            return year.updateMask(was_water).rename("year")

        years = stack.map(tag_year)
        first_year = years.reduce(ee.Reducer.min()).rename("first_year")
        last_year = years.reduce(ee.Reducer.max()).rename("last_year")
        # `config.GSW_MAPPING_LAYERS` is a v1.4-only asset with no v1.5 counterpart, so a patch
        # whose water only exists in the v1.5-extension years (2022-2024) still gets a `transition`
        # class computed from JRC's classification of the 1984-2021 window alone. This used to be a
        # decorative gap affecting `subtype`; now that the same band decides `change_type`, it is
        # load-bearing, so `caveat` states the change window explicitly and unconditionally.
        transition = (
            ee.Image(config.GSW_MAPPING_LAYERS).select("transition").rename("transition").toInt8()
        )

        # Seasonal-grade water sitting on ground people build on or farm is far more likely to be
        # the shadow between towers or an irrigated field than a water body — see
        # `MASK_ON_MANAGED_LAND` for why these classes and not the ones that say the water ended.
        # Masking the band rather than filtering features afterwards means these pixels never form
        # regions at all, so an artefact cannot merge into a neighbouring real patch and drag its
        # geometry across the city or the plain.
        #
        # A per-pixel test against two island-wide rasters, evaluated identically over every grid
        # cell: no place in Taiwan is named here or anywhere else in this module, and none may be.
        #
        # `remap` off the frozenset rather than a chain of `.eq().Or()`, so the constant is the
        # single definition and the code cannot drift from it.
        maskable_codes = sorted(MASK_ON_MANAGED_LAND)
        maskable = transition.remap(maskable_codes, [1] * len(maskable_codes), 0)
        transition = transition.updateMask(maskable.And(managed_land()).Not())

        # Land before vectorizing, not after. Clipping the polygons afterwards would mean asking
        # Earth Engine to vectorize the whole Taiwan Strait first and then throwing almost all of
        # it away: the sea was 91.3% of the unmasked area. Restricting the image is also what
        # keeps a coastal patch cut at the coastline rather than reaching into the sea.
        #
        # Intersected here rather than left to the caller so the guarantee holds for any `aoi`,
        # including the whole-bbox one `water_stats_image` is public enough to be handed.
        land = ee.Geometry(aoi).intersection(taiwan_land(), maxError=1)

        return transition.addBands(first_year).addBands(last_year).clip(land)

    def grid_cells(self, aoi: Any) -> list[Any]:
        """The land-bearing cells of a `WATER_GRID` x `WATER_GRID` partition, in row-major order.

        Same shape as forest's `extent_grid_cells`, over `config.TAIWAN_BBOX` rather than
        whatever `aoi` was passed — the grid is a fixed partition of the island regardless of
        which sub-area extraction is asked for.

        Each cell is intersected with the land boundary, and a cell holding no land at all is
        dropped rather than requested. That is not only a saving: `Image.clip` refuses an empty
        geometry outright, so an all-sea cell is a hard failure rather than an empty result once
        the domain is restricted to land. Several of the sixteen are pure Taiwan Strait.

        The emptiness test costs one round trip for the whole grid rather than one per cell —
        sixteen `getInfo` calls to decide what not to ask for would undo the saving.
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
                    )
                    .intersection(aoi, maxError=1)
                    .intersection(taiwan_land(), maxError=1)
                )

        areas = ee.List([cell.area(maxError=1) for cell in cells]).getInfo()
        return [cell for cell, area in zip(cells, areas, strict=True) if area > 0]

    def patches_for_cell(self, cell: Any) -> Any:
        """The ee.FeatureCollection of water patches inside one grid cell, area-tagged."""
        import ee

        stats = self.water_stats_image(cell)

        # Segment on the class, not on a uniform "ever water" blob. `selfMask` drops transition
        # class 0 ("no change"), which is every not-water pixel on the island and would otherwise
        # vectorize as one enormous region.
        classed = stats.select("transition").selfMask()

        # `connectedPixelCount` counts *same-valued* connected neighbours, so on a multi-valued
        # band it is already the per-class segment size — the same MMU sieve as before, now applied
        # to the region that actually becomes a feature rather than to the merged blob around it.
        component_size = classed.connectedPixelCount(maxSize=16, eightConnected=False)
        kept = classed.updateMask(component_size.gte(MIN_PATCH_PIXELS))

        # One call replaces the old vectorize + two `reduceRegions`. The first band (`transition`,
        # integer) defines the regions and lands on each feature as `labelProperty`; the reducer
        # runs over the remaining bands, giving each region its own median onset/end year.
        #
        # `median`, not `mean`: a mean over a patch is pulled by its dried margins, which is what
        # put 82.8% of this layer's area in `loss` (module docstring). A median answers "the year
        # half of this patch was water", which is the statistic that survives an outlier edge.
        #
        # `scale` rather than the reduced image's own `.projection()`: reducing over an
        # ImageCollection with `.reduce()` does not carry forward a concrete grid the way a single
        # loaded asset band's native projection does, so `crs=<that projection>` alone reaches
        # Earth Engine with no resolvable scale attached ("You must specify a scale or crsTransform
        # when specifying a crs"), found by actually running this. Both sources are natively
        # `config.NATIVE_SCALE_M`, so stating it directly sidesteps relying on that propagation.
        regions = kept.addBands(stats.select(["first_year", "last_year"])).reduceToVectors(
            reducer=ee.Reducer.median(),
            geometry=cell,
            scale=config.NATIVE_SCALE_M,
            geometryType="polygon",
            eightConnected=False,
            labelProperty="transition",
            maxPixels=int(1e10),
        )

        def tag_area(feature: Any) -> Any:
            area_ha = feature.geometry().area(maxError=1).divide(config.M2_PER_HA)
            return feature.set("area_ha", area_ha)

        return regions.map(tag_area)

    def extract(self, aoi: Any) -> dict[str, Any]:
        from trace_pipeline import extract

        first, last, asset = self._resolve()
        features: list[dict[str, Any]] = []

        cells = self.grid_cells(aoi)
        total_cells = len(cells)
        # A region whose class needs a measured year but whose yearly stack never saw water there
        # — the two JRC products (aggregate `transition` vs `YearlyHistory`) disagreeing on that
        # pixel. Skipped rather than dated from `range_first`, which would assert the water was
        # present from the start of the record, and counted rather than swallowed so the run says
        # how much it dropped.
        undatable = 0

        for index, cell in enumerate(cells, start=1):
            collection = self.patches_for_cell(cell)
            raw = extract.download_features(
                collection, description=f"water cell {index}/{total_cells}"
            )

            for item in raw:
                props = item["properties"]
                transition_code = round(props["transition"])
                measured_first = props.get("first_year")
                measured_last = props.get("last_year")

                needs_onset = transition_code not in PRESENT_AT_START
                needs_end = transition_code in ENDED
                if (needs_onset and measured_first is None) or (
                    needs_end and measured_last is None
                ):
                    undatable += 1
                    continue

                features.append(
                    build_feature(
                        geometry=item["geometry"],
                        transition_code=transition_code,
                        # Only consulted for the classes that need them; `range_first`/`range_last`
                        # stand in where the class makes the measurement irrelevant, so a masked
                        # median never reaches the schema as a fabricated year.
                        first_year=round(measured_first) if measured_first is not None else first,
                        last_year=round(measured_last) if measured_last is not None else last,
                        range_first=first,
                        range_last=last,
                        area_ha=props["area_ha"],
                        gsw_asset=asset,
                    )
                )

            print(
                f"  cell {index}/{total_cells}: {len(raw):,} patches "
                f"(running total {len(features):,})",
                flush=True,
            )

        if undatable:
            print(
                f"  {undatable:,} patches skipped: class needs a measured year the yearly "
                f"stack does not have",
                flush=True,
            )
        print(f"  {len(features):,} water patches, GSW {asset}", flush=True)
        return {"type": "FeatureCollection", "features": features}
