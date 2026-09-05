import { useCallback, useEffect, useRef, useState } from 'react';
import type maplibregl from 'maplibre-gl';

import {
  HATCH_IMAGE,
  createHatchImage,
  layerIdsFor,
  layerIdsForMode,
  layerIdsForYear,
  layersFor,
  opacityUpdatesFor,
  sourceId,
} from '@/domains/layerSpec';
import { useTraceStore } from '@/store/useTraceStore';
import type { DomainId, TraceFeatureProperties } from '@/types/feature';

/**
 * How long the basemap gets to paint before the domain layers are allowed on.
 *
 * At the opening view the basemap is 12 tiles and 498 KB; forest is 11 tiles and 7.5 MB. Adding
 * both at once let the larger one bury the smaller, and since the page background and the style's
 * own background layer are both near-black by design, the result was several seconds of nothing to
 * look at. On any healthy connection the basemap is drawn long before this expires and the delay is
 * imperceptible; on a slow one, holding the data back for two seconds is the point rather than a
 * compromise.
 *
 * It is a *grace period*, not a precondition: whatever happens, the layers go on. Rendering is
 * driven by requestAnimationFrame, which a background tab pauses, so a tab that never comes to the
 * front would otherwise never paint, never report idle, and never get its layers at all — the
 * failure `MapCanvas` documents at `markReady` and deliberately avoids.
 */
const FIRST_PAINT_GRACE_MS = 2000;

/**
 * How long to wait when no reload ever starts.
 *
 * The normal case now: a year is applied as constant opacity, which redraws without touching tile
 * data, so the commit is done as soon as a frame has been drawn. This only has to catch the case
 * where no frame is drawn at all — a background tab throttles the render loop to a stop, and the
 * events below stop with it — so it is short.
 */
const NO_RELOAD_TIMEOUT_MS = 1500;

/**
 * How long to wait once a reload has actually been seen running.
 *
 * Changing the year no longer causes one, but switching view still does, and cutting that short
 * would report a year drawn while its tiles were still being rebuilt. Purely a backstop against a
 * reload that never reports finishing.
 */
const RELOAD_TIMEOUT_MS = 15000;

/**
 * Adds, removes and filters the domain layers on a live map.
 *
 * Split from MapCanvas because the two have different lifetimes: the map is built once, while
 * layers come and go as the manifest loads and layers are toggled. Keeping them in one effect
 * would rebuild the map whenever a toggle changed.
 *
 * Sources are added once per domain and never swapped, and the year is applied as **opacity**, not
 * as a filter — see `cohortFilter` in layerSpec for why the layers are split by year.
 *
 * That distinction is the whole performance story. `setFilter` routes through `Style._updateLayer`
 * to `_reloadSource`, which re-parses every loaded tile in the worker: decode, re-filter,
 * re-tessellate. Every other style mutation lands in the same place — a `global-state` filter, a
 * data-driven paint property, even a visibility change. A *constant* paint value is the one thing
 * that does not, and cohorts are what turn the year into one.
 *
 * Filtering a single layer instead meant each step re-tessellated everything from the start of the
 * range to the current year, so playback began quickly and slowed to a crawl as the accumulation
 * grew — and before it was paced, reloads simply superseded one another and only the last year
 * ever painted. The committer below still paces, because switching *view* does reload, and because
 * the readout should never name a year that has not been drawn.
 */
export function useDomainLayers(map: maplibregl.Map | null) {
  const manifest = useTraceStore((s) => s.manifest);
  const activeDomains = useTraceStore((s) => s.activeDomains);
  const viewModes = useTraceStore((s) => s.viewModes);
  const viewModeFor = useTraceStore((s) => s.viewModeFor);
  const year = useTraceStore((s) => s.year);
  const setRenderedYear = useTraceStore((s) => s.setRenderedYear);
  const setLoadingDomains = useTraceStore((s) => s.setLoadingDomains);
  const select = useTraceStore((s) => s.select);

  /** Latest year asked for. Overwritten freely; only ever read by `pump`. */
  const requested = useRef(year);
  /** Year whose opacities are currently applied, or null when that is unknown. */
  const committed = useRef<number | null>(null);
  /** True from applying opacities until the map says it has drawn them. */
  const inFlight = useRef(false);
  /** Tears down the in-flight wait without reporting it as drawn. */
  const cancelCommit = useRef<(() => void) | null>(null);
  /**
   * The year whose cohorts are currently painted, for handlers bound once and outliving it.
   *
   * Hit-testing needs it: cohorts past this year are on the map at zero opacity, so a query has to
   * be told which ones count.
   */
  const painted = useRef(year);
  /**
   * The opacity each cohort layer was last set to.
   *
   * A domain owns a layer per year, and all but one or two hold the same value from one step to
   * the next. Setting only what changed keeps a step to a couple of calls instead of hundreds.
   */
  const applied = useRef(new Map<string, number>());
  /**
   * The latest `pump`, for the settle handler to call.
   *
   * That handler is created once per commit and outlives the render that made it, so closing over
   * `pump` directly would pin whichever set of active domains was current when the commit started.
   */
  const pumpAgain = useRef<() => void>(() => {});
  /**
   * Domains seen fully loaded at least once since their source was (last) added.
   *
   * A ref, not effect-local state: the loading-report effect below re-runs on every domain toggle,
   * and re-deriving this from scratch each time would forget an unrelated, still-loaded domain the
   * instant any other domain is switched on or off, showing its badge again on a coincidence of
   * timing rather than anything about that domain. Cleared per-domain when its source is actually
   * torn down, in the effect below that owns that lifecycle.
   */
  const everLoaded = useRef(new Set<DomainId>());

  /** Whether the basemap has had its turn — see `FIRST_PAINT_GRACE_MS`. */
  const [basemapPainted, setBasemapPainted] = useState(false);

  useEffect(() => {
    if (!map) return;
    // Reset for this map instance: `basemapPainted` otherwise carries a stale `true` forward if
    // the map is ever rebuilt, letting domain layers straight onto a fresh, unpainted map.
    setBasemapPainted(false);

    let timer = 0;

    const done = () => {
      window.clearTimeout(timer);
      map.off('idle', done);
      setBasemapPainted(true);
    };

    // Nothing but the basemap is on the map yet, so `idle` here means exactly what it needs to:
    // the basemap has finished loading and has been drawn. `map.once` rather than a hand-rolled
    // guard: it is already a self-removing one-time listener, so calling `done` twice — once from
    // `idle`, once from the timeout racing it — is harmless without one.
    map.once('idle', done);
    // The map may already be idle by the time this effect runs: `map` is only handed down after
    // MapCanvas's own `styledata`/`load` handler fires, a render cycle before this subscribes, and
    // a fast or cached basemap can finish inside that gap. Asking directly closes the race instead
    // of paying the full grace period on the connections that need it least. `loaded()` alone isn't
    // `idle` — it skips the camera-motion check `idle` itself gates on — so a fitBounds still easing
    // in would otherwise pass this check before its own tiles have settled into their final view.
    if (map.loaded() && !map.isMoving()) done();
    else timer = window.setTimeout(done, FIRST_PAINT_GRACE_MS);

    return () => {
      map.off('idle', done);
      window.clearTimeout(timer);
    };
  }, [map]);

  // The hatch is a runtime-drawn image, registered before any layer references it. A fill-pattern
  // naming a missing image renders nothing at all, silently dropping the loss layer.
  useEffect(() => {
    if (!map) return;
    if (map.hasImage(HATCH_IMAGE)) return;
    map.addImage(HATCH_IMAGE, createHatchImage(), { pixelRatio: 2 });
  }, [map]);

  // Add and remove whole domains, once the basemap has had its turn.
  useEffect(() => {
    if (!map || !manifest) return;
    // Only ever gates the first add: once true this stays true, so later toggles are immediate.
    if (!basemapPainted) return;

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
        for (const id of layerIdsFor(entry)) {
          if (map.getLayer(id)) map.removeLayer(id);
        }
        map.removeSource(sourceId(entry.id));
        // The layers those opacities described are gone; a stale cache would skip re-applying them
        // to the fresh ones if the domain came back at the same year. Scoped to this domain's own
        // ids — the still-active domains' cached opacities are still accurate and clearing them too
        // would force every one of their layers to be reapplied on the next pump for nothing.
        for (const id of layerIdsFor(entry)) applied.current.delete(id);
        // The source that made this true is gone; a domain switched back on gets a fresh load
        // window rather than skipping straight past it on the strength of a source that no longer
        // exists.
        everLoaded.current.delete(entry.id);
      }
    }
    // Adding or removing a source starts loads of its own, and an in-flight year commit cannot tell
    // those apart from a reload of its own. Abandon the wait and force the next pump to re-apply,
    // so a toggle mid-playback recovers instead of wedging.
    return () => cancelCommit.current?.();
    // `year` and the view mode are read when a layer is first added but are not dependencies:
    // re-adding sources on every tick or toggle would refetch tiles and defeat the whole point.
    // Both are applied to live layers by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, manifest, activeDomains, basemapPainted]);

  // Report which switched-on domains have nothing on screen yet.
  //
  // Two windows produce one, and they look identical to the reader: the grace period above, where
  // the source does not exist at all, and the tile load that follows it. Both show a lit toggle
  // over an empty map, which is exactly what a layer with no data for the year looks like.
  useEffect(() => {
    if (!map || !manifest) return;

    // Bounds the badge to the two windows the comment above names: without checking `everLoaded`,
    // a later `sourcedata` event from panning into fresh tiles for an already-loaded domain would
    // flip the badge back on for data the reader has already been looking at.
    const domainSourceIds = new Set(manifest.domains.map((entry) => sourceId(entry.id)));

    const update = (e?: maplibregl.MapSourceDataEvent) => {
      // Most `sourcedata` events name the one source that changed; ignore it outright if that
      // source belongs to no domain, rather than re-checking every active domain for nothing.
      if (e?.sourceId && !domainSourceIds.has(e.sourceId)) return;

      const loading = new Set<DomainId>();

      for (const entry of manifest.domains) {
        if (!activeDomains.has(entry.id)) continue;
        if (everLoaded.current.has(entry.id)) continue;

        const id = sourceId(entry.id);
        // `getSource` first: `isSourceLoaded` raises an error event for a source the map does not
        // have, which during the grace period is every one of them.
        if (!map.getSource(id) || !map.isSourceLoaded(id)) {
          loading.add(entry.id);
        } else {
          everLoaded.current.add(entry.id);
        }
      }

      // Written only when the membership actually changed. `sourcedata` fires per tile, and a fresh
      // Set each time is a new reference as far as zustand is concerned — the toggles would
      // re-render continuously for as long as tiles kept arriving.
      const current = useTraceStore.getState().loadingDomains;
      const unchanged = loading.size === current.size && [...loading].every((d) => current.has(d));
      if (!unchanged) setLoadingDomains(loading);
    };

    map.on('sourcedata', update);
    update();

    return () => {
      map.off('sourcedata', update);
    };
  }, [map, manifest, activeDomains, basemapPainted, setLoadingDomains]);

  // Apply the view mode. Both views' layers already exist, so this is a visibility switch — no
  // source churn, no refetch, and the toggle is instant.
  useEffect(() => {
    if (!map || !manifest) return;

    for (const entry of manifest.domains) {
      if (!activeDomains.has(entry.id)) continue;

      const visible = new Set(layerIdsForMode(entry, viewModeFor(entry.id)));
      for (const id of layerIdsFor(entry)) {
        if (!map.getLayer(id)) continue;
        map.setLayoutProperty(id, 'visibility', visible.has(id) ? 'visible' : 'none');
      }
    }
  }, [map, manifest, activeDomains, viewModes, viewModeFor]);

  // Commit the year to the map, one step at a time.
  //
  // `pump` is a no-op unless the map is settled and behind, so the year effect below can call it on
  // every tick. Requests that arrive mid-flight are coalesced rather than queued: `requested` is
  // simply overwritten, and the next pump jumps straight to the newest value — so a fast drag lands
  // on the year it was released on rather than grinding through the ones it passed.
  const pump = useCallback(() => {
    if (!map || !manifest) return;
    if (inFlight.current) return;

    const target = requested.current;
    if (committed.current === target) return;

    const sources: string[] = [];
    let changed = false;

    for (const entry of manifest.domains) {
      if (!activeDomains.has(entry.id)) continue;
      if (!map.getSource(sourceId(entry.id))) continue;
      sources.push(sourceId(entry.id));

      // Every layer, including the ones the current view has hidden: a hidden layer left at the
      // wrong opacity would show the wrong year the instant the toggle brought it back.
      for (const [id, channel, opacity] of opacityUpdatesFor(entry, target)) {
        if (!map.getLayer(id)) continue;
        if (applied.current.get(id) === opacity) continue;
        map.setPaintProperty(id, channel, opacity);
        applied.current.set(id, opacity);
        changed = true;
      }
    }

    painted.current = target;
    committed.current = target;

    // Every active domain's cohorts already sit at their `target` opacity — reachable when a
    // domain is toggled off and the target is a year every *remaining* domain was already fully
    // painted through. Nothing was set, so nothing will dirty a frame: waiting on a render event
    // here would wait for one that is never coming, settling only once `NO_RELOAD_TIMEOUT_MS`
    // gives up.
    if (!changed) {
      setRenderedYear(target);
      pumpAgain.current();
      return;
    }

    inFlight.current = true;

    let settled = false;
    let timer = 0;
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
        return;
      }
      if (reloading) onSettled();
    }

    function onRender() {
      if (!allLoaded()) {
        markReloading();
        return;
      }
      if (reloading) {
        onSettled();
        return;
      }
      // A render pass runs `Style.update` before it draws, so by the time this fires, a reload this
      // commit triggered has already marked its tiles unloaded — if none did, this render is already
      // painting the opacities just set. One pass is enough: the listeners above were attached
      // synchronously, in the same tick as the paint calls, so JS's run-to-completion guarantees the
      // very next render event cannot be one already in flight from before them — there is no older
      // frame left to mistake this for. (Two passes were needed here when a year change was still a
      // `setFilter`, whose reload runs in a worker on its own clock and could finish after a render
      // had already fired; a paint value is applied synchronously and has no such gap.)
      onSettled();
    }

    // `sourcedata` carries the tile state changes; `render` covers the frames between them, so a
    // reload — from a view switch, since the year no longer causes one — cannot slip past. Both come off again the
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

  // Click to select, and a pointer cursor over anything selectable. Bound once; both read the
  // layers present and shown at the moment the pointer is over them.
  useEffect(() => {
    if (!map || !manifest) return;

    // Cohorts for years after the one on screen are still on the map, drawn at zero opacity, and
    // `queryRenderedFeatures` reads geometry rather than paint. Asking for every layer the domain
    // owns would therefore let a click land on loss that has not happened yet, and open a readout
    // describing it. Both views are still included: the hidden one renders nothing and so returns
    // nothing, which is what lets a click work in either mode without knowing which is current.
    const hittable = () =>
      manifest.domains
        .flatMap((entry) => layerIdsForYear(entry, painted.current))
        .filter((id) => map.getLayer(id));

    const onClick = (event: maplibregl.MapMouseEvent) => {
      const layers = hittable();
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

    // One mousemove rather than a mouseenter/mouseleave pair per layer, which is what this was.
    // A domain now owns a layer per year of its coverage, so per-layer binding would mean hundreds
    // of listeners, and they would light the cursor up over cohorts that are present but not yet
    // shown — the same mistake as above, in the one place the reader notices before clicking.
    //
    // Coalesced onto a frame because the query now spans a layer per year: a high-polling mouse
    // reports faster than the map draws, and the cursor only needs to be right once per frame.
    let hover = 0;
    let at: maplibregl.Point | null = null;

    const onMove = (event: maplibregl.MapMouseEvent) => {
      at = event.point;
      if (hover) return;

      hover = requestAnimationFrame(() => {
        hover = 0;
        if (!at) return;
        const layers = hittable();
        const over = layers.length > 0 && map.queryRenderedFeatures(at, { layers }).length > 0;
        map.getCanvas().style.cursor = over ? 'pointer' : '';
      });
    };

    map.on('click', onClick);
    map.on('mousemove', onMove);

    return () => {
      map.off('click', onClick);
      map.off('mousemove', onMove);
      if (hover) cancelAnimationFrame(hover);
      map.getCanvas().style.cursor = '';
    };
  }, [map, manifest, select]);
}
