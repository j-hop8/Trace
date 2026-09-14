import { styleFor } from '@/domains/colors';
import type { FeatureStyle } from '@/domains/colors';
import { coversYear, selectableTypes } from '@/domains/manifest';
import { useTraceStore } from '@/store/useTraceStore';
import type { ChangeType } from '@/types/feature';

/**
 * The states, labelled generically.
 *
 * No label names a subject: "覆蓋" is whatever the domain's cover is, so the same control reads
 * correctly for forest cover and for water surface without a per-domain string table — which would
 * put domain literals back into a component, and would also invite a *wrong* label. Water's
 * `stable` covers permanent and seasonal water both; calling it "permanent" because that is the
 * commonest class would quietly misdescribe a third of the layer.
 */
const TYPE_LABELS: Record<ChangeType, { zh: string; gloss: string }> = {
  cover: {
    zh: '覆蓋',
    gloss: 'the baseline, with everything lost by the selected year taken out',
  },
  stable: { zh: '穩定', gloss: 'present throughout the record' },
  gain: { zh: '增加', gloss: 'appeared during the record' },
  loss: { zh: '減少', gloss: 'gone by the selected year' },
};

/**
 * The swatch — the same fill, edge and texture the map draws, at 10px.
 *
 * This is what makes the control a legend as well as a switch, and the reason there is no separate
 * legend component: the thing you press to show a state is the thing that shows you what it looks
 * like, so the two can never disagree about a colour.
 *
 * The border is not decoration. Under a domain ramp, loss is the deepest member of its hue — at
 * this size, on this chrome, the fill alone would be a dark smudge — and `stroke` is exactly the
 * bright edge the map gives it for the same reason.
 */
function Swatch({ style: featureStyle }: { style: FeatureStyle }) {
  return (
    <span
      aria-hidden
      className="relative h-2.5 w-2.5 shrink-0 overflow-hidden rounded-[3px]"
      style={{
        backgroundColor: featureStyle.color,
        boxShadow: `inset 0 0 0 1px ${featureStyle.stroke}`,
      }}
    >
      {featureStyle.pattern === 'hatch' && (
        <span
          className="absolute inset-0"
          // Matches `createHatchImage`: 45°, white at 55%, transparent between the strokes.
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, transparent 0 2px, rgba(255,255,255,0.55) 2px 3px)',
          }}
        />
      )}
    </span>
  );
}

/**
 * Layer switches, built by iterating the manifest — no domain is named here.
 *
 * Two levels, both driven by the manifest: a domain on or off, and which of its states are drawn.
 * The states come from `selectableTypes`, so a domain offers exactly the switches its tileset can
 * fill, and they are independent rather than one-of — the previous control could show forest's
 * canopy or its losses but never both.
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
  // Subscribed to as state rather than read through `selectedTypesFor`, which is a getter and so
  // would not re-render this list when the selection changed.
  const selectedTypes = useTraceStore((s) => s.selectedTypes);
  const toggleChangeType = useTraceStore((s) => s.toggleChangeType);

  if (!manifest) return null;

  return (
    <ul className="pointer-events-auto flex flex-col gap-2">
      {manifest.domains.map((domain) => {
        const active = activeDomains.has(domain.id);
        const loading = loadingDomains.has(domain.id);
        const hasData = coversYear(domain, year);
        const selected = selectedTypes.get(domain.id) ?? new Set<ChangeType>();
        // Whatever this domain's tileset actually holds — never a fixed list, never `domain.id`.
        const types = selectableTypes(domain);

        return (
          <li key={domain.id} className="flex flex-col gap-1">
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

            {active && types.length > 0 && (
              <div
                role="group"
                aria-label={`${domain.label.zh} 圖層`}
                className="flex flex-wrap gap-1 pl-3"
              >
                {types.map((changeType) => {
                  const on = selected.has(changeType);
                  const label = TYPE_LABELS[changeType];

                  return (
                    <button
                      key={changeType}
                      type="button"
                      onClick={() => toggleChangeType(domain.id, changeType)}
                      aria-pressed={on}
                      title={`${domain.label.zh}：${label.zh} — ${label.gloss}`}
                      className={[
                        'flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] transition',
                        on
                          ? 'border-ink-700 bg-ink-900/85 text-slate-200'
                          : 'border-ink-800 bg-ink-950/70 text-slate-500 hover:text-slate-300',
                      ].join(' ')}
                    >
                      {/*
                        The swatch keeps its colours when switched off, at reduced opacity rather
                        than greyed out. Greying would take the hue away, and the hue is the only
                        thing saying which domain this chip belongs to once several are open.
                      */}
                      <span className={on ? '' : 'opacity-40'}>
                        <Swatch style={styleFor(domain.hue, changeType)} />
                      </span>
                      <span>{label.zh}</span>
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
