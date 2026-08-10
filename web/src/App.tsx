import { useEffect } from 'react';

import { loadManifest } from '@/domains/manifest';
import { useTraceStore } from '@/store/useTraceStore';

/**
 * Phase 0 shell.
 *
 * The map canvas lands in T-006. What this proves today is the contract path: the pipeline's
 * manifest is what tells the app which domains exist, and the app fails loudly and usefully when
 * it is missing rather than rendering an empty map with no explanation.
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

  return (
    <main className="flex h-full flex-col items-center justify-center gap-6 p-8">
      <header className="text-center">
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          Trace <span className="text-slate-500">·</span> 描痕
        </h1>
        <p className="mt-1 text-sm text-slate-400">描出島嶼的改變</p>
      </header>

      {manifestError && (
        <div className="max-w-xl rounded-lg border border-amber-700/50 bg-amber-950/40 p-4 text-sm">
          <p className="font-medium text-amber-300">No domain manifest yet</p>
          <p className="mt-1 font-mono text-xs leading-relaxed text-amber-100/70">
            {manifestError}
          </p>
        </div>
      )}

      {manifest && (
        <ul className="flex flex-wrap justify-center gap-3">
          {manifest.domains.map((domain) => (
            <li
              key={domain.id}
              className="flex items-center gap-2 rounded-full border border-ink-700 bg-ink-900 px-4 py-2 text-sm"
            >
              <span
                aria-hidden
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: domain.hue }}
              />
              <span className="text-slate-200">{domain.label.zh}</span>
              <span className="font-mono text-xs text-slate-500">
                {domain.temporal.start}–{domain.temporal.end}
              </span>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
