import { coversYear } from '@/domains/manifest';
import { useTraceStore } from '@/store/useTraceStore';

/**
 * Layer switches, built by iterating the manifest — no domain is named here.
 *
 * A domain that has no data for the current year says so. Rendering it as a live layer that
 * happens to be empty is the failure this replaces: an empty map and a lit-up toggle look
 * identical to a layer that is simply switched off, and the reader concludes there was no change
 * that year rather than no *data* that year.
 */
export default function LayerToggles() {
  const manifest = useTraceStore((s) => s.manifest);
  const activeDomains = useTraceStore((s) => s.activeDomains);
  const year = useTraceStore((s) => s.year);
  const toggleDomain = useTraceStore((s) => s.toggleDomain);

  if (!manifest) return null;

  return (
    <ul className="pointer-events-auto flex flex-col gap-2">
      {manifest.domains.map((domain) => {
        const active = activeDomains.has(domain.id);
        const hasData = coversYear(domain, year);

        return (
          <li key={domain.id}>
            <button
              type="button"
              onClick={() => toggleDomain(domain.id)}
              aria-pressed={active}
              title={domain.caveat}
              className={[
                'flex w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition',
                active
                  ? 'border-ink-700 bg-ink-900/85 text-slate-200'
                  : 'border-ink-800 bg-ink-950/70 text-slate-500 hover:text-slate-300',
              ].join(' ')}
            >
              <span
                aria-hidden
                className="h-2 w-2 shrink-0 rounded-full transition"
                style={{
                  backgroundColor: active ? domain.hue : 'transparent',
                  boxShadow: active ? 'none' : `inset 0 0 0 1px ${domain.hue}`,
                }}
              />
              <span>{domain.label.zh}</span>
              <span className="font-mono text-[11px] text-slate-500">
                {domain.temporal.start}–{domain.temporal.end}
              </span>
              {active && !hasData && (
                <span className="ml-auto rounded bg-amber-950/70 px-1.5 py-0.5 text-[10px] text-amber-300">
                  no data {year}
                </span>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
