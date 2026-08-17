import { useEffect } from 'react';
import type maplibregl from 'maplibre-gl';

import {
  HATCH_IMAGE,
  createHatchImage,
  fillLayerId,
  filtersFor,
  layerIdsFor,
  layerIdsForMode,
  layersFor,
  sourceId,
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
  const viewModes = useTraceStore((s) => s.viewModes);
  const viewModeFor = useTraceStore((s) => s.viewModeFor);
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
        const spec = layersFor(entry, year, viewModeFor(entry.id));
        map.addSource(spec.sourceId, spec.source);
        for (const layer of spec.layers) map.addLayer(layer);
      } else if (!shouldBeVisible && present) {
        for (const id of layerIdsFor(entry.id)) {
          if (map.getLayer(id)) map.removeLayer(id);
        }
        map.removeSource(sourceId(entry.id));
      }
    }
    // `year` and the view mode are read when a layer is first added but are not dependencies:
    // re-adding sources on every tick or toggle would refetch tiles and defeat the point of
    // filtering. Both are applied to live layers by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, manifest, activeDomains]);

  // Apply the view mode. Both views' layers already exist, so this is a visibility switch — no
  // source churn, no refetch, and the toggle is instant.
  useEffect(() => {
    if (!map || !manifest) return;

    for (const entry of manifest.domains) {
      if (!activeDomains.has(entry.id)) continue;

      const visible = new Set(layerIdsForMode(entry.id, viewModeFor(entry.id)));
      for (const id of layerIdsFor(entry.id)) {
        if (!map.getLayer(id)) continue;
        map.setLayoutProperty(id, 'visibility', visible.has(id) ? 'visible' : 'none');
      }
    }
  }, [map, manifest, activeDomains, viewModes, viewModeFor]);

  // Apply the year. Cheap enough to run on every slider tick.
  useEffect(() => {
    if (!map || !manifest) return;

    for (const entry of manifest.domains) {
      if (!activeDomains.has(entry.id)) continue;

      // Every layer, including the ones the current view has hidden: a hidden layer that was
      // never re-filtered would show the wrong year the instant the toggle brought it back.
      for (const [id, filter] of filtersFor(entry.id, year)) {
        if (map.getLayer(id)) map.setFilter(id, filter);
      }
    }
  }, [map, manifest, activeDomains, year]);

  // Click to select. Bound once; the handler reads the layers present at click time.
  useEffect(() => {
    if (!map || !manifest) return;

    const onClick = (event: maplibregl.MapMouseEvent) => {
      // Every layer of both views. Hidden ones render nothing and so return nothing, which means
      // this needs no knowledge of the current mode — and in the extent view a click still lands,
      // on the baseline block or on the cleared patch that was cut out of it.
      const layers = manifest.domains
        .flatMap((entry) => layerIdsFor(entry.id))
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
