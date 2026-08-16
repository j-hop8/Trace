import { useEffect } from 'react';

import Attribution from '@/components/Attribution';
import FeatureReadout from '@/components/FeatureReadout';
import LayerToggles from '@/components/LayerToggles';
import TimeSlider from '@/components/TimeSlider';
import MapCanvas from '@/map/MapCanvas';
import { loadManifest } from '@/domains/manifest';
import { useTraceStore } from '@/store/useTraceStore';

/**
 * Explore — the map, the year, and what you clicked.
 *
 * Nothing here names a domain. The toggles, the slider range, the credits and the layers are all
 * produced by iterating the manifest, so a new domain appears throughout the UI without this file
 * changing. That is the invariant the whole architecture rests on.
 */
export default function App() {
  const manifestError = useTraceStore((s) => s.manifestError);
  const setManifest = useTraceStore((s) => s.setManifest);
  const setManifestError = useTraceStore((s) => s.setManifestError);

  useEffect(() => {
    loadManifest()
      .then(setManifest)
      .catch((error: unknown) => {
        setManifestError(error instanceof Error ? error.message : String(error));
      });
  }, [setManifest, setManifestError]);

  return (
    <div className="relative h-full w-full overflow-hidden">
      <MapCanvas />

      {/* Chrome floats over the map and lets pointer events through except where it must not. */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-white drop-shadow">
              Trace <span className="text-slate-500">·</span> 描痕
            </h1>
            <p className="mt-0.5 text-xs text-slate-400">描出島嶼的改變</p>
            <div className="mt-4">
              <LayerToggles />
            </div>
          </div>

          <FeatureReadout />
        </div>

        <div className="flex flex-col gap-2">
          {manifestError && (
            <div className="pointer-events-auto max-w-xl rounded-lg border border-amber-700/50 bg-amber-950/85 p-4 text-sm backdrop-blur">
              <p className="font-medium text-amber-300">No domain manifest yet</p>
              <p className="mt-1 whitespace-pre-line font-mono text-xs leading-relaxed text-amber-100/70">
                {manifestError}
              </p>
            </div>
          )}

          <div className="mx-auto w-full max-w-2xl">
            <TimeSlider />
          </div>

          <Attribution />
        </div>
      </div>
    </div>
  );
}
