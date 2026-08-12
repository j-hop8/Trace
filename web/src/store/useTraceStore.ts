/**
 * App state. Deliberately small: MapLibre owns camera and rendering, so this holds only what the
 * UI and the map must agree on.
 */

import { create } from 'zustand';

import type { DomainId, TraceFeatureProperties } from '@/types/feature';
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

  /** The year the slider is at. Layer filters read this; it is the only animation input. */
  year: number;
  playing: boolean;

  selected: SelectedFeature | null;

  setManifest: (manifest: DomainManifest) => void;
  setManifestError: (message: string) => void;
  toggleDomain: (id: DomainId) => void;
  setYear: (year: number) => void;
  setPlaying: (playing: boolean) => void;
  select: (feature: SelectedFeature | null) => void;
  activeEntries: () => DomainManifestEntry[];
}

export const useTraceStore = create<TraceState>((set, get) => ({
  manifest: null,
  manifestError: null,
  activeDomains: new Set(),
  year: new Date().getFullYear(),
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
      // Start at the most recent year any domain covers, so the first paint shows the present
      // rather than an arbitrary midpoint.
      year: Number.isFinite(latest) ? latest : new Date().getFullYear(),
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
      return { activeDomains: next, selected: keepSelection ? state.selected : null };
    }),

  setYear: (year) => set({ year }),
  setPlaying: (playing) => set({ playing }),
  select: (selected) => set({ selected }),

  activeEntries: () => {
    const { manifest, activeDomains } = get();
    if (!manifest) return [];
    return manifest.domains.filter((d) => activeDomains.has(d.id));
  },
}));
