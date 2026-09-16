"""Forest domain — Hansen Global Forest Change tree-cover loss.

**This is tree-cover loss, not deforestation.** Hansen's `lossyear` records where canopy was
removed, whatever the cause: plantation harvest on a rotation, typhoon damage, fire, landslide.
In Taiwan, where a large share of "forest" is managed plantation and typhoons strip hillsides
most years, conflating the two would be actively misleading. The wording is a product
requirement, not politeness -- see :attr:`ForestDomain.caveat`.

Extraction goes **year by year** rather than all at once. `lossyear` already encodes the date per
pixel, so one request per year keeps each `reduceToVectors` inside Earth Engine's synchronous
request budget, makes a failure retryable at one year rather than the whole island, and gives
progress output on a job that runs for minutes.

**Cover carries its own validity.** A loss patch dated L is, by construction, tree cover that stood
from the baseline until L -- same pixels, same sieve, same geometry -- so every loss download also
yields a *closed* cover piece `[2000, L)` at no extra request. The *open* cover `[2000, null)` is
the baseline with mapped loss cut out of it before vectorising. Between them a year's cover is
exactly what the cover features say holds in that year; nothing downstream has to subtract loss
from a baseline to draw it.
"""

from __future__ import annotations

from typing import Any

from trace_pipeline import config, extract
from trace_pipeline.domains.base import Domain, SourceInfo, register

METHOD = "Hansen lossyear"

#: The cover pass: where forest *was* in 2000, drawn forward until `lossyear` says it went. One
#: method string for both the open blocks and the closed pieces, because it is one derivation --
#: the closed pieces are simply the part of it whose end `lossyear` has recorded.
COVER_METHOD = "Hansen treecover2000, ended by lossyear"

#: Hansen's own accuracy figures are per-biome and not per-pixel, so a single flat value is the
#: honest thing to carry rather than a fabricated per-feature score. Sub-1.0 because 30 m pixels
#: over Taiwan's steep, cloud-prone terrain are not certainties.
CONFIDENCE = 0.8

#: The open-cover pass is chunked over an N x N grid of the AOI, because one request cannot carry
#: it.
#:
#: Loss chunks by year; open cover has no year to chunk on, so the split has to be spatial -- and a
#: spatial split is a genuine cost, not a free one: a forest block straddling a cell edge comes
#: back as two features, so `area_ha` on an open-cover polygon describes the piece inside that cell
#: rather than the whole block. Hence the coarsest grid that works, found by measurement against
#: the central range (the densest, worst case). Measured first as a plain baseline:
#:
#:   2x2, 3x3 -> HTTP 400, request too large
#:   4x4      -> 11,889 features / 22 MB / 13 s  <- chosen
#:   6x6      ->  5,902 features / 11 MB /  8 s
#:
#: and re-measured once the blocks carried their loss holes as interior rings (T-029), which is
#: more geometry per request; see the run log recorded below the constant.
#:
#: The consequence to remember: an open-cover polygon's `area_ha` is the area of a *block as this
#: grid cut it*, so summing cover areas is not a way to measure island-wide forest. Any total the
#: UI ever quotes has to be measured in the pipeline, not added up from features.
COVER_GRID = 4


def loss_year_to_calendar(band_value: int) -> int:
    """Hansen encodes loss year as 1..25 meaning 2001..2025.

    Getting this off by one would silently shift every loss patch by a year -- and the map would
    look entirely plausible.
    """
    if not 1 <= band_value <= config.HANSEN_LAST_LOSS_YEAR - config.HANSEN_BASELINE_YEAR:
        raise ValueError(
            f"lossyear band value {band_value} is outside 1.."
            f"{config.HANSEN_LAST_LOSS_YEAR - config.HANSEN_BASELINE_YEAR}"
        )
    return config.HANSEN_BASELINE_YEAR + band_value


def calendar_to_loss_year(calendar_year: int) -> int:
    """Inverse of :func:`loss_year_to_calendar`."""
    if not config.HANSEN_FIRST_LOSS_YEAR <= calendar_year <= config.HANSEN_LAST_LOSS_YEAR:
        raise ValueError(
            f"{calendar_year} is outside Hansen's loss range "
            f"{config.HANSEN_FIRST_LOSS_YEAR}-{config.HANSEN_LAST_LOSS_YEAR}"
        )
    return calendar_year - config.HANSEN_BASELINE_YEAR


def build_feature(geometry: dict[str, Any], calendar_year: int, area_ha: float) -> dict[str, Any]:
    """Assemble one B4 feature from a vectorized loss patch.

    `valid_to` is None: a cleared patch stays cleared as far as this dataset can say. Hansen's
    `gain` band covers 2000-2012 only and is not comparable year-for-year with `lossyear`, so
    claiming a regrowth date here would be inventing precision the source does not have.
    """
    from trace_pipeline.schema import TraceFeature

    feature = TraceFeature(
        domain=ForestDomain.id,
        valid_from=calendar_year,
        valid_to=None,
        change_type="loss",
        metric={"area_ha": round(area_ha, 4)},
        source=config.HANSEN_ASSET,
        method=METHOD,
        confidence=CONFIDENCE,
    )
    return feature.to_geojson_feature(geometry)


def build_cover_feature(
    geometry: dict[str, Any], area_ha: float, *, valid_to: int | None
) -> dict[str, Any]:
    """Assemble one B4 cover feature: tree cover standing from the baseline until `valid_to`.

    `valid_from` is always the baseline year -- this is the state Hansen observed in 2000. What
    varies is the end. `valid_to=None` is an open block: nothing in `lossyear` has ended it, so
    it holds through the record. `valid_to=L` is a closed piece: the same pixels the loss patch
    dated L covers, standing `[2000, L)` and gone from L on. Half-open, so the cover piece and
    the loss patch hand off with no year in common.

    A `valid_to` at or before the baseline is refused rather than validated away: `lossyear`
    starts at 2001, so such a value cannot come from the data and can only be a caller's bug.
    """
    from trace_pipeline.schema import TraceFeature

    if valid_to is not None and valid_to <= config.HANSEN_BASELINE_YEAR:
        raise ValueError(
            f"cover cannot end in {valid_to}: it begins at the {config.HANSEN_BASELINE_YEAR} "
            f"baseline, and Hansen records no loss before {config.HANSEN_FIRST_LOSS_YEAR}"
        )

    feature = TraceFeature(
        domain=ForestDomain.id,
        valid_from=config.HANSEN_BASELINE_YEAR,
        valid_to=valid_to,
        change_type="cover",
        metric={"area_ha": round(area_ha, 4)},
        source=config.HANSEN_ASSET,
        method=COVER_METHOD,
        confidence=CONFIDENCE,
    )
    return feature.to_geojson_feature(geometry)


@register
class ForestDomain(Domain):
    id = "forest"
    label = {"en": "Forest", "zh": "森林"}
    change_types = ("cover", "loss")

    @property
    def source(self) -> SourceInfo:
        return SourceInfo(
            name="Hansen Global Forest Change",
            version="v1.13 (2000-2025)",
            attribution="Hansen et al., University of Maryland",
            citation=(
                "Hansen et al., 'High-Resolution Global Maps of 21st-Century Forest Cover "
                "Change', Science 342 (2013)"
            ),
            licence="CC-BY-4.0",
        )

    @property
    def caveat(self) -> str:
        # The retained percentage is the part that matters. A bare threshold sounds negligible;
        # "this shows about 90% of measured loss" is the fact a reader needs to judge the number
        # in front of them. Both figures are interpolated from config so they cannot go stale.
        return (
            "Tree-cover loss, not deforestation: this includes plantation harvest, fire, and "
            "typhoon damage as well as permanent clearance. Baseline is ≥"
            f"{config.TREECOVER_THRESHOLD_PCT}% canopy in {config.HANSEN_BASELINE_YEAR}, at "
            f"{config.NATIVE_SCALE_M} m resolution. Isolated single pixels (under about "
            f"{config.MIN_PATCH_PIXELS * config.TAIWAN_PIXEL_HA:.2f} ha) are not mapped, so this "
            f"shows about {config.FOREST_RETAINED_PCT:.0f}% of the tree-cover loss the source "
            "records for Taiwan. "
            # Cover is the baseline drawn forward, and the two ways that is not a fresh observation
            # run in opposite directions -- a reader who knows only one of them would draw the
            # wrong conclusion about which way the picture is off, so both are stated.
            f"The cover layer draws the {config.HANSEN_BASELINE_YEAR} baseline forward year by "
            "year: a patch is drawn until the year Hansen records its loss and not after, so a "
            "given year shows the baseline minus the loss mapped by then. Regrowth is not added "
            "back (Hansen's gain band ends in 2012 and is not comparable year for year), and loss "
            f"too small to map, about {100 - config.FOREST_RETAINED_PCT:.0f}% of it, stays in the "
            "cover. The baseline passes the same single-pixel sieve and keeps about "
            f"{config.FOREST_COVER_RETAINED_PCT:.1f}% of the canopy area the source records."
        )

    def temporal_range(self) -> tuple[int, int]:
        return (config.HANSEN_FIRST_LOSS_YEAR, config.HANSEN_LAST_LOSS_YEAR)

    def loss_patches_for_year(self, aoi: Any, calendar_year: int) -> Any:
        """The ee.FeatureCollection of loss polygons for one year, area-tagged and sieved."""
        import ee

        # Clip before anything else, connectivity included. On an unclipped image a component
        # straddling the AOI edge counts its outside-Taiwan pixels toward MIN_PATCH_PIXELS, then
        # reduceToVectors clips it to a lone pixel -- so the output contains single-pixel polygons
        # the caveat promises are not mapped. Taiwan sits ~5 km inside every edge of TAIWAN_BBOX,
        # so clipping truncates no real coastal component.
        image = ee.Image(config.HANSEN_ASSET).clip(aoi)
        forest_2000 = image.select("treecover2000").gte(config.TREECOVER_THRESHOLD_PCT)
        lost_this_year = image.select("lossyear").eq(calendar_to_loss_year(calendar_year))

        patches = lost_this_year.And(forest_2000).selfMask()

        # Everything below runs on Hansen's own grid. Its nominal scale is 27.83 m, not 30 -- it
        # is a 1/4000-degree product that the literature rounds to "30 m". Asking for scale=30
        # resamples onto a different grid from the one connectedPixelCount analysed, so
        # components and output polygons stop agreeing and 2-pixel components can emerge as
        # single output pixels. Pinning both to the native projection keeps them consistent.
        native = image.select("lossyear").projection()

        # Sieve by connected-component size, before vectorizing.
        #
        # Filtering on hectares instead looks equivalent and is not: a Hansen pixel over Taiwan is
        # ~0.071 ha (config.TAIWAN_PIXEL_HA) rather than the nominal 0.09, so an area threshold
        # quietly rounds up to the next whole pixel count and drops a band of real data. Counting
        # pixels is latitude-independent and matches how the caveat's retention figure was
        # measured.
        # eightConnected must agree with reduceToVectors below, or components differ.
        component_size = patches.connectedPixelCount(maxSize=16, eightConnected=False)
        kept = patches.updateMask(component_size.gte(config.MIN_PATCH_PIXELS))

        vectors = kept.reduceToVectors(
            geometry=aoi,
            crs=native,
            geometryType="polygon",
            eightConnected=False,
            maxPixels=int(1e10),
        )

        def tag_area(feature: Any) -> Any:
            # True geodesic area, for the metric the readout quotes -- measured, never filtered on.
            area_ha = feature.geometry().area(maxError=1).divide(config.M2_PER_HA)
            return feature.set("area_ha", area_ha)

        return vectors.map(tag_area)

    def cover_grid_cells(self, aoi: Any) -> list[Any]:
        """The AOI split into COVER_GRID x COVER_GRID rectangles, in row-major order."""
        import ee

        west, south, east, north = config.TAIWAN_BBOX
        width = (east - west) / COVER_GRID
        height = (north - south) / COVER_GRID

        cells = []
        for row in range(COVER_GRID):
            for col in range(COVER_GRID):
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

    def cover_blocks_for_cell(self, cell: Any) -> Any:
        """The ee.FeatureCollection of *open* cover polygons inside one grid cell.

        Open cover is the 2000 baseline with the loss this pipeline maps already cut out of it, so
        the polygons carry their holes as interior rings and hold `[2000, null)` as stated -- no
        consumer has to subtract loss from them to draw a year.

        Which loss gets cut is the load-bearing choice. Not every loss pixel: only loss in a
        component of at least MIN_PATCH_PIXELS with the *same* `lossyear`, which is exactly what
        :meth:`loss_patches_for_year` maps. `connectedPixelCount` counts same-valued neighbours,
        so running it over `lossyear` yields the per-year components in one pass, and the sieve
        below agrees with the loss pass's by construction. Sub-MMU loss stays in the cover: the
        cover says "still there" precisely where the loss layer says "not mapped", and the caveat
        states both. Cutting *all* loss instead would leave the two layers disagreeing about
        thousands of isolated pixels, with neither able to say so.

        Otherwise the same shape as :meth:`loss_patches_for_year`: clip first, sieve on
        connected-component size on the native grid, then vectorize.
        """
        import ee

        image = ee.Image(config.HANSEN_ASSET).clip(cell)
        forest_2000 = image.select("treecover2000").gte(config.TREECOVER_THRESHOLD_PCT)

        # Same-valued components over lossyear, within the baseline, are the per-year loss
        # components. Pixels with lossyear 0 form components too, and are excluded by the gte(1).
        lossyear = image.select("lossyear").updateMask(forest_2000)
        same_year = lossyear.connectedPixelCount(maxSize=16, eightConnected=False)
        mapped_loss = same_year.gte(config.MIN_PATCH_PIXELS).And(lossyear.gte(1)).unmask(0)

        cover = forest_2000.And(mapped_loss.Not()).selfMask()

        native = image.select("treecover2000").projection()

        # A baseline pixel left isolated by the holes around it is sieved out here, like any other
        # single pixel; that is part of what FOREST_COVER_RETAINED_PCT measures.
        component_size = cover.connectedPixelCount(maxSize=16, eightConnected=False)
        kept = cover.updateMask(component_size.gte(config.MIN_PATCH_PIXELS))

        vectors = kept.reduceToVectors(
            geometry=cell,
            crs=native,
            geometryType="polygon",
            eightConnected=False,
            maxPixels=int(1e10),
        )

        def tag_area(feature: Any) -> Any:
            area_ha = feature.geometry().area(maxError=1).divide(config.M2_PER_HA)
            return feature.set("area_ha", area_ha)

        return vectors.map(tag_area)

    def extract_cover(self, aoi: Any) -> list[dict[str, Any]]:
        """Open cover `[2000, null)`, one request per grid cell."""
        features: list[dict[str, Any]] = []

        for index, cell in enumerate(self.cover_grid_cells(aoi), start=1):
            collection = self.cover_blocks_for_cell(cell)
            raw = extract.download_features(
                collection, description=f"forest cover cell {index}/{COVER_GRID**2}"
            )

            for item in raw:
                features.append(
                    build_cover_feature(
                        geometry=item["geometry"],
                        area_ha=item["properties"]["area_ha"],
                        valid_to=None,
                    )
                )

            print(
                f"  cover cell {index}/{COVER_GRID**2}: {len(raw):,} blocks "
                f"(running total {len(features):,})",
                flush=True,
            )

        return features

    def extract(self, aoi: Any) -> dict[str, Any]:
        features: list[dict[str, Any]] = []
        first, last = self.temporal_range()

        for calendar_year in range(first, last + 1):
            collection = self.loss_patches_for_year(aoi, calendar_year)
            raw = extract.download_features(collection, description=f"forest loss {calendar_year}")

            for item in raw:
                geometry = item["geometry"]
                area_ha = item["properties"]["area_ha"]
                features.append(
                    build_feature(geometry, calendar_year=calendar_year, area_ha=area_ha)
                )
                # The same pixels, standing until this year: one download, two features. Their
                # geometries are identical by construction, which is what lets the cover and the
                # loss hand off cleanly at `calendar_year` with nothing drawn twice or not at all.
                features.append(build_cover_feature(geometry, area_ha, valid_to=calendar_year))

            # flush: this loop runs for minutes, and progress you cannot see is not progress.
            print(
                f"  {calendar_year}: {len(raw):,} patches, each also a closed cover piece "
                f"(running total {len(features):,})",
                flush=True,
            )

        # Open cover last because it is the riskier pass -- but note this buys less than it looks
        # like: `extract.run` writes nothing until this method returns, so a failure here still
        # discards the features built above and the whole domain must be re-extracted. Only the
        # previously written file on disk is protected, and that by `write_features`.
        features.extend(self.extract_cover(aoi))

        return {"type": "FeatureCollection", "features": features}
