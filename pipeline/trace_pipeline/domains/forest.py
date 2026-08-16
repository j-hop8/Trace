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
"""

from __future__ import annotations

from typing import Any

from trace_pipeline import config, extract
from trace_pipeline.domains.base import Domain, SourceInfo, register

METHOD = "Hansen lossyear"

#: Hansen's own accuracy figures are per-biome and not per-pixel, so a single flat value is the
#: honest thing to carry rather than a fabricated per-feature score. Sub-1.0 because 30 m pixels
#: over Taiwan's steep, cloud-prone terrain are not certainties.
CONFIDENCE = 0.8


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


@register
class ForestDomain(Domain):
    id = "forest"
    label = {"en": "Forest", "zh": "森林"}

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
            "records for Taiwan."
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

    def extract(self, aoi: Any) -> dict[str, Any]:
        features: list[dict[str, Any]] = []
        first, last = self.temporal_range()

        for calendar_year in range(first, last + 1):
            collection = self.loss_patches_for_year(aoi, calendar_year)
            raw = extract.download_features(collection, description=f"forest loss {calendar_year}")

            for item in raw:
                features.append(
                    build_feature(
                        geometry=item["geometry"],
                        calendar_year=calendar_year,
                        area_ha=item["properties"]["area_ha"],
                    )
                )

            # flush: this loop runs for minutes, and progress you cannot see is not progress.
            print(
                f"  {calendar_year}: {len(raw):,} patches (running total {len(features):,})",
                flush=True,
            )

        return {"type": "FeatureCollection", "features": features}
