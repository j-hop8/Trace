/**
 * App state. Deliberately small: MapLibre owns camera and rendering, so this holds only what the
 * UI and the map must agree on.
 */

import { useMemo } from 'react';
import { create } from 'zustand';

import type { DomainId, TraceFeatureProperties } from '@/types/feature';
import { combinedRange } from '@/domains/manifest';
import type { DomainManifest, DomainManifestEntry, ViewMode } from '@/domains/manifest';

export interface SelectedFeature {
  properties: TraceFeatureProperties;
  /** Where the user clicked, for anchoring the readout. */
  lngLat: { lng: number; lat: number };
}

interface TraceState {
  manifest: DomainManifest | null;
  manifestError: string | null;

  /** Domain ids currently switched on. */
  activeDomains: Set<DomainId>;

  /**
   * Domain ids that are switched on but whose tiles are not on screen yet.
   *
   * Separate from `activeDomains` because they answer different questions: one is what the reader
   * asked for, the other is what has arrived. Forest is 7.5 MB against the basemap's 498 KB at the
   * opening view, and its layers are deliberately held back until the basemap has painted, so there
   * is a real window where a layer is on and showing nothing. Saying so beats an empty map that
   * looks identical to a layer with no data.
   */
  loadingDomains: Set<DomainId>;

  /**
   * Which question each domain is answering — see `ViewMode`.
   *
   * Per domain rather than global: with water and forest both on, one may be worth reading as
   * change while the other is worth reading as what's left, and a single global switch would
   * force a choice that has no reason to be shared. Domains absent from the map are in the
   * default `change` view.
   */
  viewModes: Map<DomainId, ViewMode>;

  /**
   * The year the slider is *asking* for. The thumb tracks this, and it moves as fast as the user
   * or the playback loop wants it to.
   */
  year: number;

  /**
   * The year the map has actually drawn.
   *
   * Not the same thing as `year`, and the gap is the whole point. A year change makes MapLibre
   * re-parse every loaded tile in the worker — 158k polygons for forest — so the map lands on a
   * requested year some way after it was requested. Every number on screen reads from this one, so
   * the interface never names a year that is not the one being displayed.
   */
  renderedYear: number;
  playing: boolean;

  selected: SelectedFeature | null;

  setManifest: (manifest: DomainManifest) => void;
  setManifestError: (message: string) => void;
  toggleDomain: (id: DomainId) => void;
  setViewMode: (id: DomainId, mode: ViewMode) => void;
  viewModeFor: (id: DomainId) => ViewMode;
  setLoadingDomains: (ids: Set<DomainId>) => void;
  setYear: (year: number) => void;
  /** Called by the map once a requested year is on screen. */
  setRenderedYear: (year: number) => void;
  setPlaying: (playing: boolean) => void;
  select: (feature: SelectedFeature | null) => void;
}

/**
 * Hold `year` inside the range the active domains actually cover.
 *
 * Returns the year unchanged when nothing is active — there is no meaningful range to clamp to,
 * and the slider hides itself in that case rather than rendering a degenerate axis.
 */
function clampYear(
  year: number,
  manifest: DomainManifest | null,
  activeDomains: Set<DomainId>,
): number {
  if (!manifest) return year;
  const active = manifest.domains.filter((domain) => activeDomains.has(domain.id));
  const range = combinedRange(active);
  if (!range) return year;
  return Math.min(Math.max(year, range.start), range.end);
}

export const useTraceStore = create<TraceState>((set, get) => ({
  manifest: null,
  manifestError: null,
  activeDomains: new Set(),
  loadingDomains: new Set(),
  viewModes: new Map(),
  year: new Date().getFullYear(),
  renderedYear: new Date().getFullYear(),
  playing: false,
  selected: null,

  setManifest: (manifest) => {
    // A manifest with no domains is what a partial pipeline run produces. Spreading an empty
    // array into Math.max yields -Infinity, which would render a slider labelled "-Infinity"
    // instead of surfacing the real problem.
    const latest = manifest.domains.reduce(
      (max, d) => Math.max(max, d.temporal.end),
      Number.NEGATIVE_INFINITY,
    );

    set({
      manifest,
      manifestError:
        manifest.domains.length === 0
          ? 'The manifest contains no domains. Re-run the pipeline: cd pipeline && python -m trace_pipeline.cli all'
          : null,
      // Everything on by default: the point of the map is the comparison, and a user who has to
      // switch layers on before seeing anything has to already know what to look for.
      activeDomains: new Set(manifest.domains.map((d) => d.id)),
      // ...and none of it has arrived yet. Not a guess: the layers are deliberately held back until
      // the basemap has painted, so at this instant every domain is genuinely switched on and
      // showing nothing. The map clears these as each source finishes loading.
      loadingDomains: new Set(manifest.domains.map((d) => d.id)),
      // Start at the most recent year any domain covers, so the first paint shows the present
      // rather than an arbitrary midpoint.
      year: Number.isFinite(latest) ? latest : new Date().getFullYear(),
      renderedYear: Number.isFinite(latest) ? latest : new Date().getFullYear(),
    });
  },

  setManifestError: (message) => set({ manifestError: message }),

  toggleDomain: (id) =>
    set((state) => {
      const next = new Set(state.activeDomains);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      // A selection belonging to a domain that just went dark would leave an orphaned readout.
      const keepSelection = state.selected && next.has(state.selected.properties.domain);
      const loading = new Set([...state.loadingDomains].filter((domain) => next.has(domain)));

      return {
        activeDomains: next,
        // A domain switched off is not loading. Left in, it would come back wearing the badge
        // until the next `sourcedata` happened to correct it.
        loadingDomains: loading,
        selected: keepSelection ? state.selected : null,
        // Toggling a layer changes the slider's bounds, and an unclamped year then disagrees with
        // both the thumb and the map: the slider clamps only what it *displays*, so a year of
        // 1990 left over from a 1984-start domain would show "1990" beside a thumb parked at 2001
        // while the map filtered at 1990 and drew nothing. Three answers to one question.
        year: clampYear(state.year, state.manifest, next),
        // Clamped alongside `year` for the same reason: the readout reads from this, and an
        // unclamped value would print a year outside the axis the thumb is now sitting on.
        renderedYear: clampYear(state.renderedYear, state.manifest, next),
      };
    }),

  setViewMode: (id, mode) =>
    set((state) => {
      const next = new Map(state.viewModes);
      next.set(id, mode);
      // The readout describes one feature, and the two views draw different features — a loss
      // patch stays selected while the map switches to showing what's left of the baseline,
      // leaving a panel that no longer refers to anything on screen.
      const keepSelection = state.selected && state.selected.properties.domain !== id;
      return { viewModes: next, selected: keepSelection ? state.selected : null };
    }),

  viewModeFor: (id) => get().viewModes.get(id) ?? 'change',

  setLoadingDomains: (loadingDomains) => set({ loadingDomains }),
  setYear: (year) => set({ year }),
  setRenderedYear: (renderedYear) => set({ renderedYear }),
  setPlaying: (playing) => set({ playing }),
  select: (selected) => set({ selected }),
}));

/**
 * The manifest entries currently switched on.
 *
 * A hook rather than a store method, and the distinction is not cosmetic. As a method it was
 * called *inside* a selector — `useTraceStore((s) => s.activeEntries())` — which returns a fresh
 * array on every read. zustand 4 memoises per snapshot so that merely cost a re-render on each
 * slider tick, but zustand 5 replaced that wrapper with a plain `useSyncExternalStore`, where a
 * selector returning a new reference each call is an infinite render loop. With T-008 open to move
 * the web toolchain forward, leaving the trap in place meant handing the next upgrade a crash with
 * no obvious cause. Selecting two stable references and deriving under `useMemo` is correct on
 * both versions.
 */
export function useActiveEntries(): DomainManifestEntry[] {
  const manifest = useTraceStore((s) => s.manifest);
  const activeDomains = useTraceStore((s) => s.activeDomains);

  return useMemo(
    () => (manifest ? manifest.domains.filter((domain) => activeDomains.has(domain.id)) : []),
    [manifest, activeDomains],
  );
}
