import { coversYear, supportsExtentView } from '@/domains/manifest';
import type { DomainManifestEntry, ViewMode } from '@/domains/manifest';
import { useTraceStore } from '@/store/useTraceStore';

/**
 * The two views, labelled generically.
 *
 * Neither label names a subject: "覆蓋" is whatever the domain's extent is, so the same control
 * reads correctly for forest cover and for water surface without a per-domain string table.
 */
const VIEW_LABELS: Record<ViewMode, { zh: string; title: (entry: DomainManifestEntry) => string }> =
  {
    change: {
      zh: '變化',
      title: (entry) => `${entry.label.zh}：顯示變化 — what changed, accumulating by year`,
    },
    extent: {
      zh: '覆蓋',
      title: (entry) =>
        `${entry.label.zh}：顯示該年覆蓋 — the baseline with everything lost by the selected year removed`,
    },
  };

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
  const loadingDomains = useTraceStore((s) => s.loadingDomains);
  // The drawn year, not the requested one, so this badge and the slider's readout never disagree
  // about which year the map is showing.
  const year = useTraceStore((s) => s.renderedYear);
  const toggleDomain = useTraceStore((s) => s.toggleDomain);
  // Subscribed to as state rather than read through `viewModeFor`, which is a getter and so would
  // not re-render this list when the mode changed.
  const viewModes = useTraceStore((s) => s.viewModes);
  const setViewMode = useTraceStore((s) => s.setViewMode);

  if (!manifest) return null;

  return (
    <ul className="pointer-events-auto flex flex-col gap-2">
      {manifest.domains.map((domain) => {
        const active = activeDomains.has(domain.id);
        const loading = loadingDomains.has(domain.id);
        const hasData = coversYear(domain, year);
        const mode = viewModes.get(domain.id) ?? 'change';
        // Only where the tileset carries both a baseline and something that changed — see
        // `supportsExtentView`. Never `domain.id === 'forest'`.
        const canSwitchView = active && supportsExtentView(domain);

        return (
          <li key={domain.id} className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => toggleDomain(domain.id)}
              aria-pressed={active}
              title={domain.caveat}
              className={[
                'flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition',
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
              {/*
                Loading wins over "no data": until the tiles are here, whether this year has
                anything in them is not yet known, and saying "no data" would be a guess that
                happens to be wrong most of the time.

                Slate rather than the amber below — amber is reserved for a layer that genuinely
                has nothing to show, and waiting is not that. The pulse carries "working" without
                needing an image.
              */}
              {active && loading && (
                <span className="ml-auto animate-pulse rounded bg-ink-800/80 px-1.5 py-0.5 text-[10px] text-slate-400">
                  載入中
                </span>
              )}

              {active && !loading && !hasData && (
                <span className="ml-auto rounded bg-amber-950/70 px-1.5 py-0.5 text-[10px] text-amber-300">
                  no data {year}
                </span>
              )}
            </button>

            {canSwitchView && (
              <div
                role="group"
                aria-label={`${domain.label.zh} view`}
                className="flex overflow-hidden rounded-full border border-ink-800 bg-ink-950/70"
              >
                {(['change', 'extent'] as ViewMode[]).map((option) => {
                  const selected = mode === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => setViewMode(domain.id, option)}
                      aria-pressed={selected}
                      title={VIEW_LABELS[option].title(domain)}
                      className={[
                        'px-2.5 py-1.5 text-[11px] transition',
                        selected ? 'text-ink-950' : 'text-slate-500 hover:text-slate-300',
                        // Chrome, not data: the change option's selected state is a neutral
                        // Tailwind token. The extent option is the one that carries meaning, and
                        // it takes its colour from the manifest below rather than from a literal.
                        selected && option === 'change' ? 'bg-slate-300' : '',
                      ].join(' ')}
                      style={
                        selected && option === 'extent'
                          ? { backgroundColor: domain.hue }
                          : undefined
                      }
                    >
                      {VIEW_LABELS[option].zh}
                    </button>
                  );
                })}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
