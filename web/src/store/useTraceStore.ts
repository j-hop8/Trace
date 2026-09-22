/**
 * App state. Deliberately small: MapLibre owns camera and rendering, so this holds only what the
 * UI and the map must agree on.
 */

import { useMemo } from 'react';
import { create } from 'zustand';

import type { ChangeType, DomainId, Kind, TraceFeatureProperties } from '@/types/feature';
import { combinedRange, kindsOf, selectableTypes, selectableTypesByKind } from '@/domains/manifest';
import type { DomainManifest, DomainManifestEntry } from '@/domains/manifest';

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
   * For each switched-on domain, the kinds of state that are not on screen yet.
   *
   * Separate from `activeDomains` because they answer different questions: one is what the reader
   * asked for, the other is what has arrived. Forest is 7.5 MB against the basemap's 498 KB at the
   * opening view, and its layers are deliberately held back until the basemap has painted, so there
   * is a real window where a layer is on and showing nothing. Saying so beats an empty map that
   * looks identical to a layer with no data.
   *
   * Per kind rather than per domain because the kinds arrive one after the other: cover goes on
   * first and change is parsed behind it, so there is a second window where the map shows a
   * domain's cover as if that were the whole of it. A domain with an entry here has something
   * missing; one whose every kind is listed has nothing on screen at all. Domains with nothing
   * missing have no entry.
   */
  loadingKinds: Map<DomainId, ReadonlySet<Kind>>;

  /**
   * Which of each domain's states the reader has asked to see.
   *
   * Per domain rather than global: forest's baseline and water's seasonal extent are not the same
   * question, and a single global switch would force a choice that has no reason to be shared.
   * Multi-select rather than one-of — this replaced an exclusive `change`/`extent` view switch that
   * could show forest's canopy or its losses but never both, which is the one comparison the map
   * exists to make.
   *
   * A domain's set is seeded from `selectableTypes` and never contains a state its tileset lacks.
   * An empty set is not a reachable state: emptying it switches the domain off — see
   * `toggleChangeType`.
   */
  selectedTypes: Map<DomainId, Set<ChangeType>>;

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
  toggleChangeType: (id: DomainId, changeType: ChangeType) => void;
  /**
   * Every state of one kind at once — the group heading's press. All on → all off; anything
   * else → all on. The same consequences as `toggleChangeType`, because it is the same event
   * applied to several chips.
   */
  toggleKind: (id: DomainId, kind: Kind) => void;
  selectedTypesFor: (id: DomainId) => Set<ChangeType>;
  setLoadingKinds: (kinds: Map<DomainId, ReadonlySet<Kind>>) => void;
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

/** The loading report without the domains that are no longer switched on. */
function onlyActive(
  loadingKinds: Map<DomainId, ReadonlySet<Kind>>,
  activeDomains: Set<DomainId>,
): Map<DomainId, ReadonlySet<Kind>> {
  return new Map([...loadingKinds].filter(([domain]) => activeDomains.has(domain)));
}

/**
 * The state after one domain's selected states change, however they changed.
 *
 * Un-checking the last state switches the domain off outright. The alternative is a lit toggle
 * over an empty map, which is indistinguishable from a layer that simply has no data for the year
 * — the exact confusion the "no data" badge exists to prevent. Making the state unreachable is
 * cheaper than inventing a third thing for the badge to say.
 *
 * And switching off the last state is the same event as `toggleDomain` switching the domain off,
 * so it has the same three consequences: a domain that is gone is not loading, an orphaned
 * readout has to go, and the slider's bounds have changed under the year.
 */
function withSelectedTypes(
  state: TraceState,
  id: DomainId,
  nextTypes: Set<ChangeType>,
): Partial<TraceState> {
  const activeDomains = new Set(state.activeDomains);
  if (nextTypes.size === 0) activeDomains.delete(id);

  const keepSelection =
    state.selected !== null &&
    (state.selected.properties.domain !== id ||
      nextTypes.has(state.selected.properties.change_type));

  return {
    selectedTypes: new Map(state.selectedTypes).set(id, nextTypes),
    activeDomains,
    loadingKinds: onlyActive(state.loadingKinds, activeDomains),
    selected: keepSelection ? state.selected : null,
    year: clampYear(state.year, state.manifest, activeDomains),
  };
}

export const useTraceStore = create<TraceState>((set, get) => ({
  manifest: null,
  manifestError: null,
  activeDomains: new Set(),
  loadingKinds: new Map(),
  selectedTypes: new Map(),
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
      // ...showing every state each one carries. Same reasoning one level down: a reader who has to
      // switch forest's canopy on before the losses have anything to be losses *of* has to already
      // know what the map is for. `selectableTypes` is what keeps this honest — a domain is seeded
      // with what its tileset actually holds, never with a fixed list of states.
      selectedTypes: new Map(manifest.domains.map((d) => [d.id, new Set(selectableTypes(d))])),
      // ...and none of it has arrived yet. Not a guess: the layers are deliberately held back until
      // the basemap has painted, so at this instant every domain is genuinely switched on and
      // showing nothing. The map clears these kind by kind as each source finishes loading.
      loadingKinds: new Map(manifest.domains.map((d) => [d.id, new Set(kindsOf(d))])),
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
      const selectedTypes = new Map(state.selectedTypes);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
        // A domain goes dark either by this switch or by having its last state un-checked, and it
        // has to come back the same way from both. Without this, a domain switched off from the
        // state chips would return still holding the empty set that switched it off — on, and
        // drawing nothing.
        if (!selectedTypes.get(id)?.size) {
          const entry = state.manifest?.domains.find((domain) => domain.id === id);
          if (entry) selectedTypes.set(id, new Set(selectableTypes(entry)));
        }
      }
      // A selection belonging to a domain that just went dark would leave an orphaned readout.
      const keepSelection = state.selected && next.has(state.selected.properties.domain);

      return {
        activeDomains: next,
        selectedTypes,
        // A domain switched off is not loading. Left in, it would come back wearing the badge
        // until the next `sourcedata` happened to correct it.
        loadingKinds: onlyActive(state.loadingKinds, next),
        selected: keepSelection ? state.selected : null,
        // Toggling a layer changes the slider's bounds, and an unclamped year then disagrees with
        // the thumb: the slider clamps only what it *displays*, so a year of 1990 left over from a
        // 1984-start domain would show a thumb parked at 2001 while still asking the map for 1990.
        year: clampYear(state.year, state.manifest, next),
        // `renderedYear` is deliberately left alone here. It names the year the map has actually
        // drawn, and toggling a domain doesn't draw anything by itself — the clamped `year` above
        // flows through the same commit/settle pump as any other year change, and `renderedYear`
        // catches up once that lands, exactly as it does during normal playback. Clamping it here
        // too would have the readout claim a year was on screen before the map painted it.
      };
    }),

  toggleChangeType: (id, changeType) =>
    set((state) => {
      const entry = state.manifest?.domains.find((domain) => domain.id === id);
      if (!entry) return {};

      const nextTypes = new Set(state.selectedTypes.get(id) ?? selectableTypes(entry));
      if (nextTypes.has(changeType)) nextTypes.delete(changeType);
      else nextTypes.add(changeType);

      return withSelectedTypes(state, id, nextTypes);
    }),

  toggleKind: (id, kind) =>
    set((state) => {
      const entry = state.manifest?.domains.find((domain) => domain.id === id);
      if (!entry) return {};

      const group = selectableTypesByKind(entry)[kind];
      const nextTypes = new Set(state.selectedTypes.get(id) ?? selectableTypes(entry));
      const allOn = group.every((changeType) => nextTypes.has(changeType));
      for (const changeType of group) {
        if (allOn) nextTypes.delete(changeType);
        else nextTypes.add(changeType);
      }

      return withSelectedTypes(state, id, nextTypes);
    }),

  selectedTypesFor: (id) => get().selectedTypes.get(id) ?? new Set(),

  setLoadingKinds: (loadingKinds) => set({ loadingKinds }),
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
