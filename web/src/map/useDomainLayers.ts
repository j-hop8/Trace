import { useEffect } from 'react';
import type maplibregl from 'maplibre-gl';

import {
  HATCH_IMAGE,
  createHatchImage,
  fillLayerId,
  hatchLayerId,
  layerIdsFor,
  layersFor,
  outlineLayerId,
  sourceId,
  timeFilter,
} from '@/domains/layerSpec';
import { useTraceStore } from '@/store/useTraceStore';
import type { TraceFeatureProperties } from '@/types/feature';

/**
 * Adds, removes and filters the domain layers on a live map.
 *
 * Split from MapCanvas because the two have different lifetimes: the map is built once, while
 * layers come and go as the manifest loads and layers are toggled. Keeping them in one effect
 * would rebuild the map whenever a toggle changed.
 *
 * Sources are added once per domain and never swapped. The year is applied as a filter update, so
 * scrubbing the slider re-filters tiles already on the GPU — no request, no flicker. That is the
 * whole reason time is a feature attribute rather than a layer.
 */
export function useDomainLayers(map: maplibregl.Map | null) {
  const manifest = useTraceStore((s) => s.manifest);
  const activeDomains = useTraceStore((s) => s.activeDomains);
  const year = useTraceStore((s) => s.year);
  const select = useTraceStore((s) => s.select);

  // The hatch is a runtime-drawn image, registered before any layer references it. A fill-pattern
  // naming a missing image renders nothing at all, silently dropping the loss layer.
  useEffect(() => {
    if (!map) return;
    if (map.hasImage(HATCH_IMAGE)) return;
    map.addImage(HATCH_IMAGE, createHatchImage(), { pixelRatio: 2 });
  }, [map]);

  // Add and remove whole domains.
  useEffect(() => {
    if (!map || !manifest) return;

    for (const entry of manifest.domains) {
      const shouldBeVisible = activeDomains.has(entry.id);
      const present = Boolean(map.getSource(sourceId(entry.id)));

      if (shouldBeVisible && !present) {
        const spec = layersFor(entry, year);
        map.addSource(spec.sourceId, spec.source);
        for (const layer of spec.layers) map.addLayer(layer);
      } else if (!shouldBeVisible && present) {
        for (const id of layerIdsFor(entry.id)) {
          if (map.getLayer(id)) map.removeLayer(id);
        }
        map.removeSource(sourceId(entry.id));
      }
    }
    // `year` is read when a layer is first added but is not a dependency: re-adding sources on
    // every tick would refetch tiles and defeat the point of filtering.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, manifest, activeDomains]);

  // Apply the year. Cheap enough to run on every slider tick.
  useEffect(() => {
    if (!map || !manifest) return;
    const filter = timeFilter(year);

    for (const entry of manifest.domains) {
      if (!activeDomains.has(entry.id)) continue;
      if (map.getLayer(fillLayerId(entry.id))) map.setFilter(fillLayerId(entry.id), filter);
      if (map.getLayer(outlineLayerId(entry.id))) map.setFilter(outlineLayerId(entry.id), filter);
      if (map.getLayer(hatchLayerId(entry.id))) {
        map.setFilter(hatchLayerId(entry.id), [
          'all',
          filter,
          ['==', ['get', 'change_type'], 'loss'],
        ] as never);
      }
    }
  }, [map, manifest, activeDomains, year]);

  // Click to select. Bound once; the handler reads the layers present at click time.
  useEffect(() => {
    if (!map || !manifest) return;

    const onClick = (event: maplibregl.MapMouseEvent) => {
      const layers = manifest.domains
        .flatMap((entry) => [fillLayerId(entry.id), hatchLayerId(entry.id)])
        .filter((id) => map.getLayer(id));

      if (layers.length === 0) return;

      const [hit] = map.queryRenderedFeatures(event.point, { layers });
      if (!hit) {
        select(null);
        return;
      }

      select({
        properties: hit.properties as unknown as TraceFeatureProperties,
        lngLat: { lng: event.lngLat.lng, lat: event.lngLat.lat },
      });
    };

    const onEnter = () => {
      map.getCanvas().style.cursor = 'pointer';
    };
    const onLeave = () => {
      map.getCanvas().style.cursor = '';
    };

    map.on('click', onClick);
    for (const entry of manifest.domains) {
      map.on('mouseenter', fillLayerId(entry.id), onEnter);
      map.on('mouseleave', fillLayerId(entry.id), onLeave);
    }

    return () => {
      map.off('click', onClick);
      for (const entry of manifest.domains) {
        map.off('mouseenter', fillLayerId(entry.id), onEnter);
        map.off('mouseleave', fillLayerId(entry.id), onLeave);
      }
    };
  }, [map, manifest, select]);
}
