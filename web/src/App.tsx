import { useEffect } from 'react';

import MapCanvas from '@/map/MapCanvas';
import baseStyle from '@/map/basemap/style.json';
import { loadManifest } from '@/domains/manifest';
import { useTraceStore } from '@/store/useTraceStore';

/**
 * Phase 0 shell: the map, and enough chrome to prove the manifest drives it.
 *
 * The slider, layer toggles and feature readout land in T-007. What matters structurally here is
 * that nothing below names a domain — the chips and the credits are both produced by iterating
 * the manifest, so a new domain appears without this file changing.
 */
export default function App() {
  const manifest = useTraceStore((s) => s.manifest);
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

  const basemapCredit = baseStyle.sources.protomaps.attribution;

  return (
    <div className="relative h-full w-full">
      <MapCanvas />

      <header className="pointer-events-none absolute left-0 top-0 p-5">
        <h1 className="text-xl font-semibold tracking-tight text-white drop-shadow">
          Trace <span className="text-slate-500">·</span> 描痕
        </h1>
        <p className="mt-0.5 text-xs text-slate-400">描出島嶼的改變</p>
      </header>

      {manifestError && (
        <div className="absolute inset-x-0 bottom-16 mx-auto max-w-xl px-4">
          <div className="rounded-lg border border-amber-700/50 bg-amber-950/80 p-4 text-sm backdrop-blur">
            <p className="font-medium text-amber-300">No domain manifest yet</p>
            <p className="mt-1 whitespace-pre-line font-mono text-xs leading-relaxed text-amber-100/70">
              {manifestError}
            </p>
          </div>
        </div>
      )}

      {manifest && (
        <ul className="pointer-events-none absolute left-5 top-24 flex flex-col gap-2">
          {manifest.domains.map((domain) => (
            <li
              key={domain.id}
              className="flex items-center gap-2 rounded-full border border-ink-700/80 bg-ink-900/80 px-3 py-1.5 text-xs backdrop-blur"
            >
              <span
                aria-hidden
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: domain.hue }}
              />
              <span className="text-slate-200">{domain.label.zh}</span>
              <span className="font-mono text-[11px] text-slate-500">
                {domain.temporal.start}–{domain.temporal.end}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/*
        Persistent credits (A5). Every active source's required attribution is concatenated —
        a licence obligation, not decoration, which is why it is always visible rather than
        tucked behind a control. T-007 extends this with each layer's caveat.
      */}
      <footer className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-ink-950/90 to-transparent px-4 py-2">
        <p className="text-[11px] leading-relaxed text-slate-500">
          <span dangerouslySetInnerHTML={{ __html: basemapCredit }} />
          {manifest?.domains.map((domain) => (
            <span key={domain.id}> · {domain.source.attribution}</span>
          ))}
        </p>
      </footer>
    </div>
  );
}
