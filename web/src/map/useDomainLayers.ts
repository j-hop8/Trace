import { useCallback, useEffect, useRef } from 'react';
import type maplibregl from 'maplibre-gl';

import {
  HATCH_IMAGE,
  createHatchImage,
  filtersFor,
  layerIdsFor,
  layerIdsForMode,
  layersFor,
  sourceId,
} from '@/domains/layerSpec';
import { useTraceStore } from '@/store/useTraceStore';
import type { TraceFeatureProperties } from '@/types/feature';

/**
 * How long to wait when the map never appears to start reloading.
 *
 * Either the new filters changed nothing to reload, or nothing is rendering at all — a background
 * tab throttles the render loop to a stop, and the events this waits on stop with it. Both cases
 * are "there is nothing to wait for", so this is short.
 */
const NO_RELOAD_TIMEOUT_MS = 1500;

/**
 * How long to wait once a reload has actually been seen running.
 *
 * Far longer, because here there *is* something to wait for and cutting it short is the bug this
 * whole mechanism exists to fix: the next year would be requested on top of a half-finished
 * reload, and the map would go back to rendering only whichever one happened to land last. Purely
 * a backstop against a reload that never reports finishing.
 */
const RELOAD_TIMEOUT_MS = 15000;

/**
 * Adds, removes and filters the domain layers on a live map.
 *
 * Split from MapCanvas because the two have different lifetimes: the map is built once, while
 * layers come and go as the manifest loads and layers are toggled. Keeping them in one effect
 * would rebuild the map whenever a toggle changed.
 *
 * Sources are added once per domain and never swapped, so changing the year costs no network — that
 * is the whole reason time is a feature attribute rather than a layer.
 *
 * It is not, however, free. `setFilter` routes through `Style._updateLayer` to `_reloadSource`,
 * which re-parses every loaded tile in the worker: decode, re-filter, re-tessellate. On 158k forest
 * polygons that runs well past the gap between slider ticks, and each reload supersedes the one
 * before it — which is why firing one per tick used to leave the map frozen until the slider
 * stopped, then jump straight to the final year. Every other style mutation lands in the same
 * place (a `global-state` filter, a data-driven paint property, even a visibility change), so there
 * is no cheaper channel to switch to. The committer below instead keeps at most one reload in
 * flight and coalesces whatever is requested while it runs.
 */
export function useDomainLayers(map: maplibregl.Map | null) {
  const manifest = useTraceStore((s) => s.manifest);
  const activeDomains = useTraceStore((s) => s.activeDomains);
  const viewModes = useTraceStore((s) => s.viewModes);
  const viewModeFor = useTraceStore((s) => s.viewModeFor);
  const year = useTraceStore((s) => s.year);
  const setRenderedYear = useTraceStore((s) => s.setRenderedYear);
  const select = useTraceStore((s) => s.select);

  /** Latest year asked for. Overwritten freely; only ever read by `pump`. */
  const requested = useRef(year);
  /** Year whose filters are currently applied, or null when that is unknown. */
  const committed = useRef<number | null>(null);
  /** True from applying filters until the map says it has drawn them. */
  const inFlight = useRef(false);
  /** Tears down the in-flight wait without reporting it as drawn. */
  const cancelCommit = useRef<(() => void) | null>(null);
  /**
   * The latest `pump`, for the settle handler to call.
   *
   * That handler is created once per commit and outlives the render that made it, so closing over
   * `pump` directly would pin whichever set of active domains was current when the commit started.
   */
  const pumpAgain = useRef<() => void>(() => {});

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
        // Under the basemap's labels, not over them. Appending with no `beforeId` puts data on
        // top of everything, and the extent view is a near-solid mass -- it covered every place
        // name in the central range, so the reader could see the forest and not where it was.
        // Found by type rather than by id so it survives a basemap whose label layer is renamed.
        const firstSymbol = map.getStyle().layers.find((layer) => layer.type === 'symbol')?.id;
        for (const layer of spec.layers) map.addLayer(layer, firstSymbol);
      } else if (!shouldBeVisible && present) {
        for (const id of layerIdsFor(entry.id)) {
          if (map.getLayer(id)) map.removeLayer(id);
        }
        map.removeSource(sourceId(entry.id));
      }
    }
    // Adding or removing a source starts loads of its own, and an in-flight year commit waiting on
    // `idle` cannot tell those apart from its own reload. Abandon the wait and force the next pump
    // to re-apply, so a toggle mid-playback recovers instead of wedging.
    return () => cancelCommit.current?.();
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

  // Commit the year to the map, one reload at a time.
  //
  // `pump` is a no-op unless the map is idle and behind, so the year effect below can call it on
  // every tick. Requests that arrive mid-flight are coalesced rather than queued: `requested` is
  // simply overwritten, and the next pump jumps straight to the newest value. That is what makes a
  // fast drag land on the year the user released on instead of grinding through the ones it passed.
  const pump = useCallback(() => {
    if (!map || !manifest) return;
    if (inFlight.current) return;

    const target = requested.current;
    if (committed.current === target) return;

    const sources: string[] = [];

    for (const entry of manifest.domains) {
      if (!activeDomains.has(entry.id)) continue;
      if (!map.getSource(sourceId(entry.id))) continue;
      sources.push(sourceId(entry.id));

      // Every layer, including the ones the current view has hidden: a hidden layer that was
      // never re-filtered would show the wrong year the instant the toggle brought it back.
      for (const [id, filter] of filtersFor(entry.id, target)) {
        if (map.getLayer(id)) map.setFilter(id, filter);
      }
    }

    committed.current = target;
    inFlight.current = true;

    let settled = false;
    let timer = 0;
    /** Consecutive render passes seen with everything loaded — see `onRender`. */
    let quietRenders = 0;
    /**
     * Whether the reload has been seen actually running.
     *
     * `setFilter` only *marks* the source for reload; the work starts on the next render pass. So
     * `isSourceLoaded` reads true twice — once before the reload registers and once after it
     * finishes — and settling on the first reading would report a year drawn before anything had
     * been redrawn. Waiting for it to go false and back to true settles on the second.
     */
    let reloading = false;

    const stop = () => {
      if (settled) return false;
      settled = true;
      window.clearTimeout(timer);
      map.off('sourcedata', onSourceData);
      map.off('render', onRender);
      cancelCommit.current = null;
      inFlight.current = false;
      return true;
    };

    const onSettled = () => {
      if (!stop()) return;
      setRenderedYear(target);
      // Whatever was asked for while this was in flight.
      pumpAgain.current();
    };

    // A source removed mid-flight cannot hold the commit up, and asking a map about a source it no
    // longer has raises an error event.
    const allLoaded = () => sources.every((id) => !map.getSource(id) || map.isSourceLoaded(id));

    /** Note that the reload is genuinely under way, and give it room to finish. */
    const markReloading = () => {
      if (reloading) return;
      reloading = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(onSettled, RELOAD_TIMEOUT_MS);
    };

    function onSourceData() {
      if (!allLoaded()) {
        markReloading();
        quietRenders = 0;
        return;
      }
      if (reloading) onSettled();
    }

    function onRender() {
      if (!allLoaded()) {
        markReloading();
        quietRenders = 0;
        return;
      }
      if (reloading) {
        onSettled();
        return;
      }
      // A render pass runs `Style.update` before it draws, so by the time this fires, a reload this
      // commit triggered has already marked its tiles unloaded. Two clean passes in a row therefore
      // mean the new filters changed nothing to reload — which is the case on first paint, where
      // the layers were created carrying this year already. Two rather than one because a render
      // already in flight when the filters were applied could otherwise report the state before
      // them. Settling here keeps a no-op commit from holding the next one behind a whole timeout.
      if (++quietRenders >= 2) onSettled();
    }

    // `sourcedata` carries the tile state changes; `render` covers the frames between them, so the
    // brief window where the reload is running cannot slip past unobserved. Both come off again the
    // moment the commit settles. `idle` would be the obvious signal and is deliberately not used:
    // it waits on the whole map, basemap included, so a slow or stalled basemap tile would report
    // the domain's year as undrawn long after it was drawn. These two ask only about this domain's
    // own sources.
    map.on('sourcedata', onSourceData);
    map.on('render', onRender);
    // Nothing here may stall playback for good. This starts on the short fuse and is re-armed on
    // the long one as soon as a reload is seen actually running.
    timer = window.setTimeout(onSettled, NO_RELOAD_TIMEOUT_MS);

    cancelCommit.current = () => {
      // Nulled so the next pump re-applies: the commit was abandoned, not completed.
      if (stop()) committed.current = null;
    };
  }, [map, manifest, activeDomains, setRenderedYear]);

  useEffect(() => {
    pumpAgain.current = pump;
  }, [pump]);

  useEffect(() => {
    requested.current = year;
    pump();
  }, [year, pump]);

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
    // Every layer of both views, matching the click handler above. Binding only the change view's
    // fill left the extent view clickable but with no pointer cursor, so the green read as inert.
    const hoverLayers = manifest.domains.flatMap((entry) => layerIdsFor(entry.id));
    for (const id of hoverLayers) {
      map.on('mouseenter', id, onEnter);
      map.on('mouseleave', id, onLeave);
    }

    return () => {
      map.off('click', onClick);
      for (const id of hoverLayers) {
        map.off('mouseenter', id, onEnter);
        map.off('mouseleave', id, onLeave);
      }
    };
  }, [map, manifest, select]);
}
