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
1988-1993. The fix is not a cleverer reduction over a blind record: the classes present
throughout take `range_first` and no year is measured at all (`STABLE_FROM_START`). Only the
arriving classes get a measured onset, and their onsets sit in the years the record can actually
see; the classes that ended are dated to the year they ended, and the two epoch verdicts to the
epoch (see the partition `STABLE_FROM_START` / `ARRIVED` / `ENDED` / `EPOCH_VERDICT`). What
measurement remains uses `median`, not `mean`, so a dried margin cannot drag a whole reservoir
across a boundary.

**Cover is a separate pass over the same stack.** The change features say what *moved*; the cover
features say what was *there* in a year. Cover is `waterClass >= WATER_CLASS_SEASONAL`, run-length
encoded per pixel over the years and vectorised one run at a time, so a shape is a stretch of
years over which the same ground was water every year, and it is drawn for exactly those years
(`[valid_from, valid_to)`, half-open). Blind years are imputed from the nearest observation so a
year GSW could not see does not split a run in two -- see `impute_nearest`. The two passes share
one pixel mask (`managed_seasonal_keep`), so they cannot disagree about which pixels exist.
"""

from __future__ import annotations

import logging
from typing import Any

from trace_pipeline import config
from trace_pipeline.domains.base import Domain, SourceInfo, register

logger = logging.getLogger(__name__)

METHOD = "JRC GSW transition class; onset from yearly waterClass"

#: The cover pass. Named for what it does to the years, since that is what a reader of a feature
#: needs to know: a stretch, and blind years filled from the nearest one that was seen.
COVER_METHOD = "JRC GSW YearlyHistory run-length, nearest-year imputed"

#: The `to` half of a run label when the run never ends. Two digits, so `encode_run` can pack
#: `from * 100 + to` into one integer for `reduceToVectors` to segment on; 99 is past any offset a
#: 41-year record can produce (0..40), so it cannot collide with a real end year.
RUN_OPEN = 99

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

#: How each class is dated. Change is a verdict accumulated since the record's first year --
#: drawn from the year it applies and for every year after, never closed -- so the only question a
#: class has to answer is *which year its verdict applies from*. JRC's roster partitions four ways,
#: each derivable from JRC's own class names (a test derives it; these sets are hand-written and
#: the test is what keeps them honest, exactly as with `ENDED`):
#:
#:   STABLE_FROM_START  1 permanent, 4 seasonal      -> range_first: present throughout
#:   ARRIVED            2 new permanent, 5 new seasonal -> measured onset, floored at range_first
#:   ENDED              3, 6 lost *; 9, 10 ephemeral *  -> first year the yearly record no longer
#:                                                        sees water there: last_seen + 1
#:   EPOCH_VERDICT      7 seasonal to permanent,       -> config.GSW_EPOCH_2_FIRST_YEAR, the first
#:                      8 permanent to seasonal           year of the epoch JRC judged them in
#:
#: This replaced `PRESENT_AT_START`, which dated every class that held water in epoch 1 -- the two
#: `lost *` classes and 8 included -- to the record's start and then closed the `lost *` ones at
#: `valid_to`. That was dating loss from when the water *was there*, and it put 71% of the loss
#: layer on frame one and switched it off later: the opposite of accumulating (T-025). The water
#: that existed before it went is the cover layer's to carry now (T-030), so re-dating loss to the
#: loss event loses nothing from the map.
#:
#: `last_seen + 1`, not `last_seen`: `last_seen` is the median last year a pixel was *seen* as
#: water -- the last year it existed -- and cover's run for it is `[f, last_seen + 1)`, so the loss
#: begins the year after, and cover and loss hand off with no year in common, the relation forest
#: has between `[2000, L)` and `[L, null)`.
#:
#: 7 and 8 get the epoch boundary because they are verdicts JRC reaches by comparing its two
#: epochs, and carry no year of their own; the one date the class itself carries is the first year
#: of the epoch it was judged in. 1984 would assert the decline (or the gain) held in the epoch
#: where the pixel was the *other* thing. A measured year would attach a Trace-invented date to a
#: JRC verdict. Class 7's earlier 1984 (T-021) was about not losing the water from the map, which
#: cover now answers.
STABLE_FROM_START: frozenset[int] = frozenset({1, 4})
ARRIVED: frozenset[int] = frozenset({2, 5})
EPOCH_VERDICT: frozenset[int] = frozenset({7, 8})

#: Classes where the water actually stopped, and so are dated to the year it stopped -- the first
#: year the yearly record no longer sees water there. `permanent to seasonal` (8) is pointedly
#: not here: that water declined, it did not end, and it is dated by the epoch instead.
#:
#: Hand-written and test-checked, exactly as the partition above and for the same reason:
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
#: forest's `COVER_GRID`: one request over the whole island cannot carry it. Chosen by
#: extrapolation, not forest's own more rigorous practice of measuring several grid sizes against
#: the real, full worst case (`COVER_GRID`'s comment records three) — a ~0.98 deg² slice of
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
#: The cover pass (T-030) is heavier again and was measured the same way, on the densest cell
#: first: 166,697 runs over 19 start-year-pair requests, 79 MB, 409 s, the heaviest single request
#: (the 1984-85 pair, every pre-record body) 40,116 runs and 22 MB. Island-wide 483,675 cover
#: runs across the 15 cells in 1h09m alongside the change pass; 4x4 holds.
#:
#: The consequence to remember, same as forest's: a water body straddling a cell edge comes back
#: as two features, so `area_ha` on a patch describes the piece inside its own cell, not the whole
#: body — summing areas from these features is therefore not a way to measure island-wide water.
#: Unlike forest's cover pass, a split here also gives the two pieces independent `first_year`/
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


def managed_seasonal_keep() -> Any:
    """The pixel mask both passes share: 1 where a pixel may exist, 0 where the managed-land rule
    removes it.

    Seasonal-grade water sitting on ground people build on or farm is far more likely to be the
    shadow between towers or an irrigated field than a water body -- see `MASK_ON_MANAGED_LAND`
    for why those classes and not the ones that say the water ended. A per-pixel test against two
    island-wide rasters, evaluated identically everywhere: no place in Taiwan is named here or
    anywhere else in this module, and none may be.

    One function for the change pass and the cover pass, decided by the *transition class* even
    for cover, so the two cannot disagree about which pixels exist: a `lost seasonal` pond on
    now-built ground is kept by change, and its cover must exist for the years it was there.

    `remap` off the frozenset rather than a chain of `.eq().Or()`, so the constant is the single
    definition and the code cannot drift from it. `unmask(0)` on the transition band so a pixel
    JRC never classed (transition absent) reads as *not* maskable and is kept -- the cover pass
    reaches such pixels in the v1.5 extension years, and a mask that fails open loses nothing.
    """
    import ee

    transition = ee.Image(config.GSW_MAPPING_LAYERS).select("transition").unmask(0)
    maskable_codes = sorted(MASK_ON_MANAGED_LAND)
    maskable = transition.remap(maskable_codes, [1] * len(maskable_codes), 0)
    return maskable.And(managed_land()).Not()


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


def require_documented(transition_code: int) -> None:
    """Raise `UnknownTransitionClass` unless `transition_code` is one JRC documents.

    The one gate every derivation goes through first. It used to live inside `derive_change_type`
    alone, and the two date derivations fell through on an unknown code -- `not in ENDED` read as
    "has not ended", `not in` the present-at-start set as "measure it" -- so an off-roster class
    came back
    as open-ended water with a measured onset. `build_feature` was saved only by evaluating
    `change_type=` after the dates, which is kwarg order, which nothing recorded as load-bearing
    (T-022). Now the check is the same function in all three places and cannot be reordered away.
    """
    if transition_code not in GSW_TRANSITION_CLASSES:
        raise UnknownTransitionClass(
            f"transition class {transition_code!r} is not one of JRC's documented 1-10; "
            f"{config.GSW_MAPPING_LAYERS} may have changed"
        )


def derive_change_type(transition_code: int) -> str:
    """The B4 `change_type` for a patch of JRC transition class `transition_code`.

    A lookup, not a derivation: the source already answered this question across the whole record,
    with proper handling of the years it could not observe. See `CHANGE_TYPE_BY_TRANSITION` for the
    mapping and the module docstring for what deriving it here instead cost.
    """
    require_documented(transition_code)
    return CHANGE_TYPE_BY_TRANSITION[transition_code]


def derive_valid_from(
    transition_code: int, *, first_seen: int, last_seen: int, range_first: int
) -> int:
    """The year this class's verdict applies from -- the one date a change feature carries.

    See the partition above for the rule per class. `first_seen` / `last_seen` are the measured
    medians of the first and last year the region was seen as water, and each is consulted only by
    the classes for which it means something: an arrival's onset, an ending's last year. The
    classes present throughout take the record's start; the two epoch verdicts take the epoch.
    """
    require_documented(transition_code)
    if transition_code in STABLE_FROM_START:
        return range_first
    if transition_code in ARRIVED:
        return max(first_seen, range_first)
    if transition_code in ENDED:
        return last_seen + 1
    return config.GSW_EPOCH_2_FIRST_YEAR


def encode_run(from_offset: int, to_offset: int | None) -> int:
    """One integer for a run `[from, to)`, in year offsets from the record's first year.

    `reduceToVectors` segments on an integer band, so a run's two dates have to be one number for
    adjacent pixels with the same run to become one polygon. `from * 100 + to`, with `RUN_OPEN`
    standing in for an open end; `decode_run` is its inverse and the tests hold them together.
    """
    if from_offset < 0 or from_offset >= RUN_OPEN:
        raise ValueError(f"run start offset {from_offset} is outside 0..{RUN_OPEN - 1}")
    if to_offset is not None and not from_offset < to_offset < RUN_OPEN:
        raise ValueError(
            f"run end offset {to_offset} must be after {from_offset} and below {RUN_OPEN}"
        )
    return from_offset * 100 + (RUN_OPEN if to_offset is None else to_offset)


def decode_run(label: int, range_first: int) -> tuple[int, int | None]:
    """`(valid_from, valid_to)` in calendar years for a label `encode_run` produced.

    Refuses anything it could not have produced -- an end at or before its start, or an offset the
    encoding cannot hold -- rather than returning a year the map would then draw.
    """
    from_offset, to_code = divmod(int(label), 100)
    if to_code == RUN_OPEN:
        return (range_first + from_offset, None)
    if to_code <= from_offset:
        raise ValueError(
            f"run label {label} ends ({to_code}) at or before it starts ({from_offset})"
        )
    return (range_first + from_offset, range_first + to_code)


def impute_nearest(observations: list[bool | None]) -> list[bool]:
    """The per-year water state with blind years filled from the nearest year that was seen.

    `None` is a year GSW could not classify -- *No data*, not dry -- and Taiwan's early record is
    mostly that (100% of 1985). Left as dry it would split every run at 1985, ending the water in
    1984 and starting it again in 1986 with nothing in between; left masked it would do the same
    by absence. So a blind year takes the last observation before it; with none, the first
    observation after it; with none at all, not water.

    Prefer-prior rather than truly nearest, so the rule is one pass forward and one back and a
    reader can predict it: a blind 1985 between a wet 1984 and a dry 1986 is wet, because that is
    what was last seen. The EE graph in `cover_run_labels` mirrors this exactly; this is the
    version the tests can run.
    """
    n = len(observations)
    forward: list[bool | None] = [None] * n
    carry: bool | None = None
    for i, seen in enumerate(observations):
        if seen is not None:
            carry = seen
        forward[i] = carry

    backward: list[bool | None] = [None] * n
    carry = None
    for i in range(n - 1, -1, -1):
        seen = observations[i]
        if seen is not None:
            carry = seen
        backward[i] = carry

    return [
        seen if seen is not None else (fwd if fwd is not None else bool(bwd))
        for seen, fwd, bwd in zip(observations, forward, backward, strict=True)
    ]


def runs_of(states: list[bool]) -> list[tuple[int, int | None]]:
    """The half-open runs `[from, to)` of consecutive `True` in `states`, as index offsets.

    `to` is the first index that is not water; `None` if the run reaches the end of the record.
    A single-year run at `i` is `(i, i + 1)`; `to == from` cannot occur.
    """
    runs: list[tuple[int, int | None]] = []
    start: int | None = None
    for i, wet in enumerate(states):
        if wet and start is None:
            start = i
        elif not wet and start is not None:
            runs.append((start, i))
            start = None
    if start is not None:
        runs.append((start, None))
    return runs


def build_cover_feature(
    geometry: dict[str, Any],
    *,
    run_label: int,
    range_first: int,
    area_ha: float,
    gsw_asset: str,
) -> dict[str, Any]:
    """Assemble one B4 cover feature from a vectorized run of water years.

    No `subtype`. A run can flip between seasonal and permanent from year to year -- every drawdown
    reservoir does -- and splitting runs on that would turn each one into a stack of one-year
    shapes; summarising it to a dominant class is a derived statistic this ticket does not define.
    `TraceFeature` omits an absent subtype rather than writing null into every tile.
    """
    from trace_pipeline.schema import TraceFeature

    valid_from, valid_to = decode_run(run_label, range_first)
    feature = TraceFeature(
        domain=WaterDomain.id,
        valid_from=valid_from,
        valid_to=valid_to,
        change_type="cover",
        metric={"area_ha": round(area_ha, 4)},
        source=gsw_asset,
        method=COVER_METHOD,
        confidence=CONFIDENCE,
    )
    return feature.to_geojson_feature(geometry)


def build_feature(
    geometry: dict[str, Any],
    *,
    transition_code: int,
    first_year: int,
    last_year: int,
    range_first: int,
    area_ha: float,
    gsw_asset: str,
) -> dict[str, Any]:
    """Assemble one B4 change feature from a vectorized water patch.

    `transition_code` is required rather than optional: it is the class the polygon was segmented
    on, so every patch has exactly one, and it decides `change_type`, `valid_from` and `subtype`.
    An absent class is a bug in the extraction, not a feature to emit without a change signal.

    `valid_to` is always None: change accumulates, and the schema refuses a change feature that
    closes. `first_year` / `last_year` are the *measured* medians and are only consulted for the
    classes that need them -- see `derive_valid_from`.
    """
    from trace_pipeline.schema import TraceFeature

    feature = TraceFeature(
        domain=WaterDomain.id,
        valid_from=derive_valid_from(
            transition_code, first_seen=first_year, last_seen=last_year, range_first=range_first
        ),
        valid_to=None,
        change_type=derive_change_type(transition_code),
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
    change_types = ("cover", "loss", "gain", "stable")

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
            # Change accumulates and cover is where the water was: the reader has to know which
            # layer answers which question, or the first frame reads as an event again.
            "Change accumulates: a change is drawn from the year it applies and for every later "
            "year, and the cover layer is where to see what existed in a given year. Loss is "
            "dated to the first year the yearly record no longer sees water where JRC says it "
            "was lost or ephemeral. The two classes JRC judges by comparing its epochs, seasonal "
            "water that became permanent and permanent water that dropped to seasonal, carry no "
            f"year of their own and are drawn from {config.GSW_EPOCH_2_FIRST_YEAR}, the first "
            "year of the epoch in which JRC made that judgement. "
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
            "water there, or saw it there in the record's final year, no year can be dated, and "
            "the region is dropped rather than given a guessed one, about "
            f"{config.WATER_UNDATABLE_DROPPED_PCT:.2f}% of the change area that passes the sieve. "
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
            "describes the inland part alone. "
            # Cover is a different product from change and the reader has to know which one a
            # shape came from: change is one verdict over the record, cover is a year-by-year
            # count, and the same water can carry both.
            "The cover layer is a year-by-year record from JRC's yearly history: each shape is a "
            "stretch of years over which the same ground was classed as water every year, and it "
            "is drawn only for those years, so a pond that dried and refilled is several shapes, "
            "one per stretch. Where the source could not see a pixel, the nearest observed year's "
            "state is carried over, so about "
            f"{config.WATER_COVER_IMPUTED_PCT:.0f}% of the water-years behind this layer are "
            f"carried rather than observed, and a stretch beginning in {first} may have begun "
            "earlier. Stretches pass the same single-pixel sieve, keeping about "
            f"{config.WATER_COVER_RETAINED_PCT:.0f}% of the water-years that survive the "
            "managed-land rule. Cover and change come from two JRC products and can disagree at "
            "a body's edge by a year or two."
            + (
                f" After {config.GSW_V14_LAST_YEAR} the change classes carry no new change; cover "
                f"continues to {last}."
                if last > config.GSW_V14_LAST_YEAR
                else ""
            )
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

        # Masking the band rather than filtering features afterwards means the managed-land
        # pixels never form regions at all, so an artefact cannot merge into a neighbouring real
        # patch and drag its geometry across the city or the plain. The mask itself lives in
        # `managed_seasonal_keep`, shared with the cover pass.
        transition = transition.updateMask(managed_seasonal_keep())

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

        Same shape as forest's `cover_grid_cells`, over `config.TAIWAN_BBOX` rather than
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

    def cover_states(self, aoi: Any) -> tuple[list[Any], list[Any], Any]:
        """Per-year water state over `aoi`, blind years imputed, as N ee.Images of 0/1.

        Returns `(states, known, native)`: `states[i]` is 1 where the pixel is water in year
        `first + i` under `impute_nearest`'s rule, `known[i]` is 1 where that year actually
        observed the pixel (so the imputed share can be measured), and `native` is the source
        grid, for the vectoriser.

        The fill is the EE form of `impute_nearest`, built as two chains of `unmask`: forward,
        `ffill_i = known_i ? obs_i : ffill_{i-1}`; backward likewise; then a pixel takes its own
        observation, else the forward value, else the backward one, else not-water. `unmask` with
        an image argument is the whole trick -- it fills exactly the masked pixels from another
        image, which is what "carry the last observation" means on a grid.

        The shared pixel mask is applied last, as `And`, so a removed pixel reads as not-water in
        every year rather than as masked, and no run can start on it.
        """
        import ee

        first, last, _ = self._resolve()
        n = last - first + 1
        images = self._yearly_water_class(aoi).sort("year").toList(n)
        keep = managed_seasonal_keep()

        native = ee.Image(images.get(0)).select("waterClass").projection()

        observed: list[Any] = []
        known: list[Any] = []
        for i in range(n):
            water_class = ee.Image(images.get(i)).select("waterClass")
            seen = water_class.neq(config.WATER_CLASS_NO_DATA)
            known.append(seen)
            observed.append(water_class.gte(config.WATER_CLASS_SEASONAL).updateMask(seen))

        forward: list[Any] = []
        previous: Any | None = None
        for i in range(n):
            previous = observed[i] if previous is None else observed[i].unmask(previous)
            forward.append(previous)

        backward: list[Any | None] = [None] * n
        following: Any | None = None
        for i in range(n - 1, -1, -1):
            following = observed[i] if following is None else observed[i].unmask(following)
            backward[i] = following

        states = [
            forward[i].unmask(backward[i]).unmask(0).And(keep).rename("water") for i in range(n)
        ]
        return states, known, native

    def cover_run_labels(self, aoi: Any) -> tuple[list[Any], Any]:
        """One ee.Image per start-year pair, each pixel carrying `encode_run(from, to)` where a run
        starts in one of those two years, masked elsewhere -- and the source grid.

        A run starting at `i` ends at the first dry year after it: `next_dry` is a backward pass,
        `next_dry_i = dry_i ? i : next_dry_{i+1}`, with `next_dry_N = N` meaning open. The label
        is the pair packed into one integer, because `reduceToVectors` segments on one band and
        adjacent pixels with the same `(from, to)` have to become one polygon.

        Two start years share a band because a pixel cannot start a run in consecutive years -- a
        run lasts at least one year and a dry year has to follow it -- so
        `label_i.unmask(label_{i+1})` is disjoint per pixel, and halving the requests changes
        nothing about what is segmented.
        Per *ordinal* run (first run, second run) would not do: adjacent pixels with identical
        `[1995, null)` runs whose ordinals differ, because one flickered earlier, would land in
        different bands and one region would come back as two.
        """
        import ee

        starts, ends, native = self.cover_runs(aoi)
        n = len(starts)

        labels: list[Any] = []
        for i in range(n):
            to_code = ends[i].where(ends[i].eq(n), RUN_OPEN)
            labels.append(
                ee.Image.constant(i * 100)
                .add(to_code)
                .updateMask(starts[i])
                .toInt16()
                .rename("run")
            )

        pairs: list[Any] = []
        for j in range(0, n, 2):
            pairs.append(labels[j] if j + 1 >= n else labels[j].unmask(labels[j + 1]))
        return pairs, native

    def cover_runs(self, aoi: Any) -> tuple[list[Any], list[Any], Any]:
        """Where runs start and where each would end, as N ee.Images, plus the source grid.

        `starts[i]` is 1 where a run begins in year offset `i`; `ends[i]` is the offset of the
        first dry year after `i` (`N` if none -- the run is open), meaningful where `starts[i]`
        is. Split out from `cover_run_labels` so the measurement that sets the config constants
        can read run lengths off the same images the extraction segments on.
        """
        import ee

        states, _, native = self.cover_states(aoi)
        n = len(states)

        starts = [states[0]] + [states[i].And(states[i - 1].Not()) for i in range(1, n)]

        next_dry: list[Any] = [None] * (n + 1)
        next_dry[n] = ee.Image.constant(n)
        for i in range(n - 1, -1, -1):
            next_dry[i] = ee.Image.constant(i).updateMask(states[i].Not()).unmask(next_dry[i + 1])

        ends = [next_dry[i + 1] for i in range(n)]
        return starts, ends, native

    def cover_patches_for_cell(self, cell: Any) -> list[Any]:
        """The ee.FeatureCollections of cover runs inside one grid cell, one per start-year pair,
        area-tagged and sieved.

        Same sieve as `patches_for_cell`: `connectedPixelCount` counts same-valued neighbours, and
        the value is the run label, so a component is a region with one `(from, to)`. No reducer
        on `reduceToVectors` -- the label carries both dates, and there is nothing else to measure.
        """
        pairs, native = self.cover_run_labels(cell)
        collections: list[Any] = []

        for label in pairs:
            component_size = label.connectedPixelCount(maxSize=16, eightConnected=False)
            kept = label.updateMask(component_size.gte(MIN_PATCH_PIXELS))

            regions = kept.reduceToVectors(
                geometry=cell,
                crs=native,
                scale=native.nominalScale(),
                geometryType="polygon",
                eightConnected=False,
                labelProperty="run",
                maxPixels=int(1e10),
            )

            def tag_area(feature: Any) -> Any:
                area_ha = feature.geometry().area(maxError=1).divide(config.M2_PER_HA)
                return feature.set("area_ha", area_ha)

            collections.append(regions.map(tag_area))

        return collections

    def extract_cover(self, aoi: Any) -> list[dict[str, Any]]:
        """Cover features for every land cell: one download per cell per start-year pair."""
        from trace_pipeline import extract

        first, _, asset = self._resolve()
        features: list[dict[str, Any]] = []

        cells = self.grid_cells(aoi)
        total_cells = len(cells)

        for index, cell in enumerate(cells, start=1):
            collections = self.cover_patches_for_cell(cell)
            in_cell = 0
            for pair, collection in enumerate(collections, start=1):
                description = (
                    f"water cover cell {index}/{total_cells} pair {pair}/{len(collections)}"
                )
                raw = extract.download_features(collection, description=description)
                for item in raw:
                    features.append(
                        build_cover_feature(
                            geometry=item["geometry"],
                            run_label=round(item["properties"]["run"]),
                            range_first=first,
                            area_ha=item["properties"]["area_ha"],
                            gsw_asset=asset,
                        )
                    )
                in_cell += len(raw)

            print(
                f"  cover cell {index}/{total_cells}: {in_cell:,} runs "
                f"(running total {len(features):,})",
                flush=True,
            )

        return features

    def extract(self, aoi: Any) -> dict[str, Any]:
        from trace_pipeline import extract

        first, last, asset = self._resolve()
        features: list[dict[str, Any]] = []

        cells = self.grid_cells(aoi)
        total_cells = len(cells)
        # A region whose class needs a measured year the yearly stack cannot give it -- either it
        # never saw water there (the two JRC products, aggregate `transition` and `YearlyHistory`,
        # disagreeing on that pixel), or an ending's last water year is the record's last year, so
        # the end itself was never observed. Skipped rather than dated from the record's edge, which
        # would assert something the source never saw; counted, and its area summed, so the run
        # says how much it dropped and config.WATER_UNDATABLE_DROPPED_PCT can quote it.
        undatable = 0
        undatable_ha = 0.0
        kept_ha = 0.0

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

                needs_onset = transition_code in ARRIVED
                needs_end = transition_code in ENDED
                end_unobserved = measured_last is None or round(measured_last) + 1 > last
                if (needs_onset and measured_first is None) or (needs_end and end_unobserved):
                    undatable += 1
                    undatable_ha += props["area_ha"]
                    continue
                kept_ha += props["area_ha"]

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
            share = 100 * undatable_ha / (kept_ha + undatable_ha)
            print(
                f"  {undatable:,} patches ({undatable_ha:,.1f} ha, {share:.2f}% of post-sieve "
                f"change area) skipped: class needs a measured year the yearly stack does not "
                f"have -- WATER_UNDATABLE_DROPPED_PCT",
                flush=True,
            )
        print(f"  {len(features):,} water change patches, GSW {asset}", flush=True)

        # Cover last, for the same reason as forest: the riskier pass, and `extract.run` writes
        # nothing until this method returns either way.
        features.extend(self.extract_cover(aoi))
        print(f"  {len(features):,} water features in all", flush=True)
        return {"type": "FeatureCollection", "features": features}
