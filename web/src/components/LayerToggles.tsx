import { rampFor, styleFor } from '@/domains/colors';
import type { FeatureStyle } from '@/domains/colors';
import {
  bandLabel,
  coversYear,
  formatMeasure,
  kindsOf,
  selectableTypes,
  selectableTypesByKind,
} from '@/domains/manifest';
import type { DomainManifestEntry, DomainMeasure } from '@/domains/manifest';
import { useTraceStore } from '@/store/useTraceStore';
import { KIND_ORDER } from '@/types/feature';
import type { ChangeType, Kind } from '@/types/feature';

/**
 * The kinds of state, and what each one is compared against.
 *
 * This is the line the control was missing. A chip's colour says *which* state; nothing said what
 * that state was measured against — and cover and change have different answers. Cover is what
 * was there in the drawn year. Change is everything that has happened since the record began, so
 * a loss chip at 2010 is every loss from the first year to 2010, not 2010's alone. The heading
 * states the baseline in words, on screen, because on a phone there is no hover and in a
 * screenshot there is no tooltip.
 *
 * Both glosses are functions of the manifest entry and the drawn year. No domain, no year and no
 * range is named here.
 */
const KIND_LABELS: Record<
  Kind,
  {
    zh: string;
    en: string;
    gloss: (ctx: { year: number; start: number; inRange: boolean }) => { zh: string; en: string };
  }
> = {
  // A level is compared against nothing but its own scale — the legend beside it says what the
  // bands are, and a baseline, when there is one, is part of the measure's own label.
  level: {
    zh: '數值',
    en: 'value',
    gloss: ({ year, inRange }) =>
      inRange
        ? { zh: `${year}年的量測值`, en: `measured in ${year}` }
        : { zh: '此年無紀錄', en: 'no record for this year' },
  },
  cover: {
    zh: '範圍',
    en: 'cover',
    gloss: ({ year, inRange }) =>
      // Outside the record there is nothing to draw and the year must not be named as if there
      // were — the cover layers are off, and the pill already carries the "no data" badge.
      inRange
        ? { zh: `${year}年的範圍`, en: `what was there in ${year}` }
        : { zh: '此年無紀錄', en: 'no record for this year' },
  },
  change: {
    zh: '變化',
    en: 'change',
    gloss: ({ start }) => ({ zh: `自${start}年起累計`, en: `cumulative since ${start}` }),
  },
};

/**
 * The states, labelled generically.
 *
 * No label names a subject: "範圍" is whatever the domain's cover is, so the same control reads
 * correctly for forest canopy and for water surface without a per-domain string table — which would
 * put domain literals back into a component, and would also invite a *wrong* label. Water's
 * `stable` covers permanent and seasonal water both; calling it "permanent" because that is the
 * commonest class would quietly misdescribe a third of the layer.
 */
const TYPE_LABELS: Record<
  ChangeType,
  { zh: string; en: string; gloss: { zh: string; en: string } }
> = {
  level: {
    zh: '數值',
    en: 'value',
    gloss: { zh: '該年量測的數值', en: 'the value measured that year' },
  },
  cover: { zh: '範圍', en: 'cover', gloss: { zh: '該年存在的範圍', en: 'what existed that year' } },
  stable: {
    zh: '穩定',
    en: 'stable',
    gloss: { zh: '整段紀錄都在', en: 'there throughout the record' },
  },
  gain: { zh: '增加', en: 'gain', gloss: { zh: '紀錄期間出現', en: 'appeared during the record' } },
  loss: {
    zh: '減少',
    en: 'loss',
    gloss: { zh: '紀錄期間消失或減少', en: 'gone or reduced during the record' },
  },
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
 * A level's legend: one swatch per band, lowest first, with the breaks between them.
 *
 * The same rule as the chips — the swatches are the colours the map draws, from the same
 * `rampFor` — so the legend can never disagree with the field. Ticks sit on the boundaries
 * because that is what a break is; each swatch's own span is on its tooltip, in full.
 */
function Ramp({ domain, measure }: { domain: DomainManifestEntry; measure: DomainMeasure }) {
  const ramp = rampFor(domain.hue, measure.breaks.length + 1);

  return (
    <div className="flex items-end gap-1.5">
      <div className="flex flex-col gap-0.5">
        <div className="flex">
          {ramp.map((style, band) => (
            <span
              key={band}
              title={`${bandLabel(measure, band)} ${measure.unit}`}
              className="h-2 w-6 first:rounded-l-sm last:rounded-r-sm"
              style={{ backgroundColor: style.color }}
            />
          ))}
        </div>
        <div className="relative h-3">
          {measure.breaks.map((value, i) => (
            <span
              key={value}
              className="absolute -translate-x-1/2 font-mono text-[9px] leading-none text-slate-500"
              style={{ left: `${((i + 1) / ramp.length) * 100}%` }}
            >
              {formatMeasure(measure, value, { compact: true })}
            </span>
          ))}
        </div>
      </div>
      <span className="pb-3 text-[10px] text-slate-500">{measure.unit}</span>
    </div>
  );
}

/**
 * A level's row: what is measured and against what, then its ramp.
 *
 * No chips: a level has one state, and the switch for it is the heading, as a kind's heading is
 * everywhere else. What would have been chips is the legend, which a field needs and a category
 * does not.
 */
function LevelGroup({
  domain,
  measure,
  year,
  selected,
  loading,
  onToggleKind,
}: {
  domain: DomainManifestEntry;
  measure: DomainMeasure;
  year: number;
  selected: ReadonlySet<ChangeType>;
  loading: boolean;
  onToggleKind: () => void;
}) {
  const on = selected.has('level');
  const gloss = KIND_LABELS.level.gloss({
    year,
    start: domain.temporal.start,
    inRange: coversYear(domain, year),
  });

  return (
    <div
      role="group"
      aria-label={`${domain.label.zh} ${measure.label.zh}`}
      className="flex flex-col gap-1"
    >
      <button
        type="button"
        onClick={onToggleKind}
        aria-pressed={on}
        title={`${domain.label.zh}：${measure.label.zh} — ${gloss.en}${measure.baseline ? `, relative to the ${measure.baseline}` : ''}`}
        className="flex flex-wrap items-baseline gap-x-1.5 self-start text-[10px] leading-tight text-slate-500 transition hover:text-slate-300"
      >
        <span className={on ? 'text-slate-400' : ''}>{measure.label.zh}</span>
        <span aria-hidden>·</span>
        <span>{gloss.zh}</span>
        {measure.baseline && <span>（相對 {measure.baseline}）</span>}
        {loading && (
          <span className="animate-pulse rounded bg-ink-800/80 px-1 py-px text-[9px] text-slate-400">
            載入中
          </span>
        )}
      </button>
      <span className={on ? '' : 'opacity-40'}>
        <Ramp domain={domain} measure={measure} />
      </span>
    </div>
  );
}

/**
 * One kind's row: a heading that states the baseline, then a chip per state of that kind.
 *
 * Drawn only when the tileset holds a state of this kind — a domain with no cover gets no cover
 * row rather than an empty heading. The heading is a button: pressing it is every chip in the row
 * at once, so a reader can drop all of "change" and keep "cover" in one press.
 *
 * `loading` is this kind still being parsed while the domain's other kind is already drawn — the
 * kinds go on the map one after the other, cover first. The heading says so, because a map that
 * shows the canopy and none of the losses yet looks exactly like a map on which nothing was lost.
 */
function KindGroup({
  domain,
  kind,
  year,
  selected,
  loading,
  onToggleType,
  onToggleKind,
}: {
  domain: DomainManifestEntry;
  kind: Kind;
  year: number;
  selected: ReadonlySet<ChangeType>;
  loading: boolean;
  onToggleType: (changeType: ChangeType) => void;
  onToggleKind: () => void;
}) {
  const types = selectableTypesByKind(domain)[kind];
  if (types.length === 0) return null;

  const label = KIND_LABELS[kind];
  const gloss = label.gloss({
    year,
    start: domain.temporal.start,
    inRange: coversYear(domain, year),
  });
  const allOn = types.every((changeType) => selected.has(changeType));

  return (
    <div role="group" aria-label={`${domain.label.zh} ${label.zh}`} className="flex flex-col gap-1">
      <button
        type="button"
        onClick={onToggleKind}
        aria-pressed={allOn}
        title={`${domain.label.zh}：${label.zh} — ${gloss.en}`}
        className="flex items-baseline gap-1.5 self-start text-[10px] leading-tight text-slate-500 transition hover:text-slate-300"
      >
        <span className={allOn ? 'text-slate-400' : ''}>{label.zh}</span>
        <span aria-hidden>·</span>
        {/* The baseline, in words, on screen. This is the line that says what the colours mean. */}
        <span>{gloss.zh}</span>
        {/* The same badge as the pill's, one size down: waiting, in slate, never amber. */}
        {loading && (
          <span className="animate-pulse rounded bg-ink-800/80 px-1 py-px text-[9px] text-slate-400">
            載入中
          </span>
        )}
      </button>

      <div className="flex flex-wrap gap-1">
        {types.map((changeType) => {
          const on = selected.has(changeType);
          const type = TYPE_LABELS[changeType];

          return (
            <button
              key={changeType}
              type="button"
              onClick={() => onToggleType(changeType)}
              aria-pressed={on}
              title={`${domain.label.zh}：${label.zh}・${type.zh} — ${gloss.en}; ${type.gloss.en}`}
              className={[
                'flex items-center gap-1.5 rounded-full border px-2 py-1 text-[11px] transition',
                on
                  ? 'border-ink-700 bg-ink-900/85 text-slate-200'
                  : 'border-ink-800 bg-ink-950/70 text-slate-500 hover:text-slate-300',
              ].join(' ')}
            >
              {/*
                The swatch keeps its colours when switched off, at reduced opacity rather than
                greyed out. Greying would take the hue away, and the hue is the only thing saying
                which domain this chip belongs to once several are open.
              */}
              <span className={on ? '' : 'opacity-40'}>
                <Swatch style={styleFor(domain.hue, changeType)} />
              </span>
              <span>{type.zh}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Layer switches, built by iterating the manifest — no domain is named here.
 *
 * Three levels, all driven by the manifest: a domain on or off; its two kinds of state, each with
 * the baseline it is compared against stated on screen; and which states within a kind are drawn.
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
  const loadingKinds = useTraceStore((s) => s.loadingKinds);
  // The drawn year, not the requested one, so this badge and the slider's readout never disagree
  // about which year the map is showing.
  const year = useTraceStore((s) => s.renderedYear);
  const toggleDomain = useTraceStore((s) => s.toggleDomain);
  // Subscribed to as state rather than read through `selectedTypesFor`, which is a getter and so
  // would not re-render this list when the selection changed.
  const selectedTypes = useTraceStore((s) => s.selectedTypes);
  const toggleChangeType = useTraceStore((s) => s.toggleChangeType);
  const toggleKind = useTraceStore((s) => s.toggleKind);

  if (!manifest) return null;

  return (
    <ul className="pointer-events-auto flex flex-col gap-2">
      {manifest.domains.map((domain) => {
        const active = activeDomains.has(domain.id);
        const kinds = kindsOf(domain);
        const missing = loadingKinds.get(domain.id);
        // Nothing of this domain is on screen yet — every kind it holds is still to come. Once
        // the first kind has drawn, the pill's badge gives way to the kind heading's below.
        const loading = missing !== undefined && kinds.every((kind) => missing.has(kind));
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
                className="flex flex-col gap-1.5 pl-3"
              >
                {KIND_ORDER.map((kind) =>
                  kind === 'level' ? (
                    domain.measure &&
                    kinds.includes('level') && (
                      <LevelGroup
                        key={kind}
                        domain={domain}
                        measure={domain.measure}
                        year={year}
                        selected={selected}
                        loading={!loading && missing !== undefined && missing.has(kind)}
                        onToggleKind={() => toggleKind(domain.id, kind)}
                      />
                    )
                  ) : (
                    <KindGroup
                      key={kind}
                      domain={domain}
                      kind={kind}
                      year={year}
                      selected={selected}
                      loading={!loading && missing !== undefined && missing.has(kind)}
                      onToggleType={(changeType) => toggleChangeType(domain.id, changeType)}
                      onToggleKind={() => toggleKind(domain.id, kind)}
                    />
                  ),
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
