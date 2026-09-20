import { useCallback, useEffect, useRef, useState } from 'react';
import type maplibregl from 'maplibre-gl';

import {
  HATCH_IMAGE,
  createHatchImage,
  layerIdsFor,
  layerIdsForSelection,
  layerIdsForYear,
  opacityUpdatesFor,
  sourceId,
  sourceIdsFor,
  stageFor,
} from '@/domains/layerSpec';
import { kindsOf } from '@/domains/manifest';
import type { DomainManifestEntry } from '@/domains/manifest';
import { useTraceStore } from '@/store/useTraceStore';
import type { DomainId, Kind, TraceFeatureProperties } from '@/types/feature';

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
 * Sources are added once per domain *and kind* and never swapped — cover's first, change's once
 * cover has drawn, see `sourceId` in layerSpec — and the year is applied as **opacity**, not as a
 * filter — see `cohortFilter` and `intervalNodes` there for why the layers are split.
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
  const selectedTypes = useTraceStore((s) => s.selectedTypes);
  const selectedTypesFor = useTraceStore((s) => s.selectedTypesFor);
  const year = useTraceStore((s) => s.year);
  const setRenderedYear = useTraceStore((s) => s.setRenderedYear);
  const setLoadingKinds = useTraceStore((s) => s.setLoadingKinds);
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
   * Sources seen fully loaded at least once since they were (last) added.
   *
   * A ref, not effect-local state: the loading-report effect below re-runs on every domain toggle,
   * and re-deriving this from scratch each time would forget an unrelated, still-loaded source the
   * instant any other domain is switched on or off, showing its badge again on a coincidence of
   * timing rather than anything about that domain. Cleared per-source when it is actually torn
   * down, in the effect below that owns that lifecycle.
   */
  const everLoaded = useRef(new Set<string>());
  /**
   * How many of each domain's kinds are on the map, counted in `kindsOf` order.
   *
   * The map's own state, mirrored so the staging effect can tell "the next kind is due" from
   * "the next kind is already on" without walking the style on every `sourcedata` event.
   */
  const staged = useRef(new Map<DomainId, number>());

  /** Whether the basemap has had its turn — see `FIRST_PAINT_GRACE_MS`. */
  const [basemapPainted, setBasemapPainted] = useState(false);

  useEffect(() => {
    if (!map) return;
    // Reset for this map instance: `basemapPainted` otherwise carries a stale `true` forward if
    // the map is ever rebuilt, letting domain layers straight onto a fresh, unpainted map — and
    // the refs below describe sources and layers the old map took with it.
    setBasemapPainted(false);
    staged.current.clear();
    everLoaded.current.clear();
    applied.current.clear();
    committed.current = null;

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

  // Add and remove whole domains, once the basemap has had its turn — one kind at a time.
  //
  // A domain goes on in stages, in `kindsOf` order: its cover source and layers first, and its
  // change source only once cover reports loaded. Cover is three quarters of the parse
  // (`sourceId` in layerSpec has the numbers), so this is what puts the ground on screen before
  // the changes have been worked out, instead of nothing until both have.
  //
  // The gate is on *every* active domain's cover, not the domain's own: a stage goes on only once
  // every stage before it, on every active domain, is loaded. With its bytes already shared, a
  // change source's tiles are cache hits and go to the workers at once — so one domain's change
  // parse would otherwise run alongside the other domain's cover tiles still coming in, and the
  // ground of the second domain would arrive later for it. Nothing of change is fetched or
  // parsed until all of cover is on screen.
  useEffect(() => {
    if (!map || !manifest) return;
    // Only ever gates the first add: once true this stays true, so later toggles are immediate.
    if (!basemapPainted) return;

    /** Put one kind of a domain on the map: its source, then its layers in draw order. */
    const addStage = (entry: DomainManifestEntry, kind: Kind) => {
      // Built with the year current at this moment, so a stage arriving mid-scrub lands on the
      // year being asked for rather than the one the domain was switched on at.
      const stage = stageFor(entry, kind, requested.current, selectedTypesFor(entry.id));
      map.addSource(stage.sourceId, stage.source);
      // Computed once: each layer goes in before the same neighbour, so the stage keeps its own
      // order and lands directly after the domain's earlier stages.
      const beforeId = beforeIdFor(map, entry);
      for (const layer of stage.layers) map.addLayer(layer, beforeId);
    };

    /** Take every stage of a domain off the map. */
    const remove = (entry: DomainManifestEntry) => {
      for (const id of layerIdsFor(entry)) {
        if (map.getLayer(id)) map.removeLayer(id);
        // The layers those opacities described are gone; a stale cache would skip re-applying
        // them to the fresh ones if the domain came back at the same year. Scoped to this
        // domain's own ids — the still-active domains' cached opacities are still accurate and
        // clearing them too would force every one of their layers to be reapplied on the next
        // pump for nothing.
        applied.current.delete(id);
      }
      for (const id of sourceIdsFor(entry)) {
        if (map.getSource(id)) map.removeSource(id);
        // The source that made this true is gone; a domain switched back on gets a fresh load
        // window rather than skipping straight past it on the strength of a source that no
        // longer exists.
        everLoaded.current.delete(id);
      }
      staged.current.delete(entry.id);
    };

    /** Whether every stage before `index`, of every active domain, is on the map and loaded. */
    const ready = (index: number) => {
      for (const entry of manifest.domains) {
        if (!activeDomains.has(entry.id)) continue;
        for (const kind of kindsOf(entry).slice(0, index)) {
          const id = sourceId(entry.id, kind);
          // `getSource` first: `isSourceLoaded` raises an error event for a source the map does
          // not have, and a stage not yet added is a stage not yet loaded.
          if (!map.getSource(id) || !map.isSourceLoaded(id)) return false;
        }
      }
      return true;
    };

    const settle = () => {
      let added = false;

      for (const entry of manifest.domains) {
        const kinds = kindsOf(entry);
        const have = staged.current.get(entry.id) ?? 0;

        if (!activeDomains.has(entry.id)) {
          if (have > 0) remove(entry);
          continue;
        }
        const next = kinds[have];
        if (next === undefined) continue;
        if (!ready(have)) continue;

        addStage(entry, next);
        staged.current.set(entry.id, have + 1);
        added = true;
      }

      // Adding a source starts loads of its own, and an in-flight year commit cannot tell those
      // apart from a reload of its own. Abandon the wait and pump again, so the new layers are
      // brought to the year in hand and the readout is not left waiting on a settle that would
      // report the wrong thing.
      if (added) {
        cancelCommit.current?.();
        pumpAgain.current();
      }
    };

    // Every tile that finishes fires this, so a stage goes on within a frame of the one before
    // it reporting loaded.
    map.on('sourcedata', settle);
    settle();

    return () => {
      map.off('sourcedata', settle);
      // Removing a source mid-flight is the same problem as adding one — see `settle`.
      cancelCommit.current?.();
    };
    // `year` and the state selection are read when a stage is added but are not dependencies:
    // re-adding sources on every tick or toggle would refetch tiles and defeat the whole point.
    // Both are applied to live layers by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, manifest, activeDomains, basemapPainted]);

  // Report which kinds of each switched-on domain have nothing on screen yet.
  //
  // Three windows produce one, and they look identical to the reader: the grace period above,
  // where no source exists at all; the tile load that follows it; and, once the first kind is
  // drawn, the next kind's own load. All three show a lit control over a map missing something,
  // which is exactly what a layer with no data for the year looks like.
  useEffect(() => {
    if (!map || !manifest) return;

    const domainSourceIds = new Set(manifest.domains.flatMap(sourceIdsFor));

    const update = (e?: maplibregl.MapSourceDataEvent) => {
      // Most `sourcedata` events name the one source that changed; ignore it outright if that
      // source belongs to no domain, rather than re-checking every active domain for nothing.
      if (e?.sourceId && !domainSourceIds.has(e.sourceId)) return;

      const loading = new Map<DomainId, Set<Kind>>();

      for (const entry of manifest.domains) {
        if (!activeDomains.has(entry.id)) continue;

        for (const kind of kindsOf(entry)) {
          const id = sourceId(entry.id, kind);
          // Bounds the badge to the windows named above: without this, a later `sourcedata` event
          // from panning into fresh tiles for an already-loaded source would flip the badge back
          // on for data the reader has already been looking at.
          if (everLoaded.current.has(id)) continue;

          // `getSource` first: `isSourceLoaded` raises an error event for a source the map does
          // not have, which during the grace period is every one of them.
          if (!map.getSource(id) || !map.isSourceLoaded(id)) {
            let kinds = loading.get(entry.id);
            if (!kinds) loading.set(entry.id, (kinds = new Set()));
            kinds.add(kind);
          } else {
            everLoaded.current.add(id);
          }
        }
      }

      // Written only when the membership actually changed. `sourcedata` fires per tile, and a fresh
      // Map each time is a new reference as far as zustand is concerned — the toggles would
      // re-render continuously for as long as tiles kept arriving.
      if (!sameReport(loading, useTraceStore.getState().loadingKinds)) setLoadingKinds(loading);
    };

    map.on('sourcedata', update);
    update();

    return () => {
      map.off('sourcedata', update);
    };
  }, [map, manifest, activeDomains, basemapPainted, setLoadingKinds]);

  // Apply the state selection. Every change type's layers already exist, so this is a visibility
  // switch — no source churn, no refetch, and the toggle is instant.
  useEffect(() => {
    if (!map || !manifest) return;

    for (const entry of manifest.domains) {
      if (!activeDomains.has(entry.id)) continue;

      const visible = new Set(layerIdsForSelection(entry, selectedTypesFor(entry.id)));
      for (const id of layerIdsFor(entry)) {
        if (!map.getLayer(id)) continue;
        map.setLayoutProperty(id, 'visibility', visible.has(id) ? 'visible' : 'none');
      }
    }
  }, [map, manifest, activeDomains, selectedTypes, selectedTypesFor]);

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
      // Whichever of the domain's stages are on so far; a stage still to come has no layers to
      // set and is not waited on.
      const present = sourceIdsFor(entry).filter((id) => map.getSource(id));
      if (present.length === 0) continue;
      sources.push(...present);

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

/**
 * Where a domain's next layer goes: directly after its last one on the map, so a later stage
 * lands behind the earlier ones and each domain stays contiguous in the draw order. For a
 * domain's first layer, under the basemap's labels: appending with no `beforeId` puts data on top
 * of everything, and the cover layer is a near-solid mass — it covered every place name in the
 * central range, so the reader could see the forest and not where it was. The label layer is
 * found by type rather than by id so it survives a basemap whose label layer is renamed.
 */
function beforeIdFor(map: maplibregl.Map, entry: DomainManifestEntry): string | undefined {
  const order = map.getLayersOrder();
  const own = new Set(layerIdsFor(entry));

  let last = -1;
  order.forEach((id, i) => {
    if (own.has(id)) last = i;
  });
  // `undefined` when the domain's last layer is the map's last: append.
  if (last >= 0) return order[last + 1];

  return order.find((id) => map.getLayer(id)?.type === 'symbol');
}

/** Whether two loading reports name the same kinds of the same domains. */
function sameReport(
  a: Map<DomainId, ReadonlySet<Kind>>,
  b: Map<DomainId, ReadonlySet<Kind>>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [domain, kinds] of a) {
    const other = b.get(domain);
    if (!other || other.size !== kinds.size) return false;
    for (const kind of kinds) if (!other.has(kind)) return false;
  }
  return true;
}
