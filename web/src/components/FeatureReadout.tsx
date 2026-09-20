import { useTraceStore } from '@/store/useTraceStore';
import { KIND_OF, readMetric } from '@/types/feature';
import type { TraceFeatureProperties } from '@/types/feature';

/**
 * "Every pixel becomes a sentence" (A1).
 *
 * A selected feature becomes a plain-language readout rather than a property table, because the
 * product's claim is that change is legible, not that the data is available. The numbers are
 * stated with their units and their uncertainty, never rounded into false precision.
 */

function formatArea(hectares: number | undefined): string | null {
  if (hectares === undefined) return null;
  // Below a hectare, hectares read as noise; square metres are the honest unit at that size.
  if (hectares < 1) return `${Math.round(hectares * 10_000).toLocaleString()} m²`;
  return `${hectares.toLocaleString(undefined, { maximumFractionDigits: 1 })} ha`;
}

/**
 * Whether this feature's `area_ha` describes a real thing, or an artefact of how it was cut.
 *
 * Cover shapes are vectorised over a spatial grid (`COVER_GRID` / `WATER_GRID` in the pipeline)
 * and, for water, split again at every year boundary, so a body straddling a cell edge or a dry
 * year comes back as several features and each one's area is the piece inside that cut. The
 * number is a true geodesic area of the polygon, but the polygon's boundary is partly an
 * extraction detail — quoting it as "this forest: 198,830 ha" states a fact about the chunking as
 * though it were a fact about the forest. A change feature is the thing that changed, and its
 * area is that thing's.
 */
function areaIsMeaningful(props: TraceFeatureProperties): boolean {
  return KIND_OF[props.change_type] === 'change';
}

/**
 * The one-line story: what this is, when, and by how much.
 *
 * Two kinds, two tenses. A cover feature carries its own validity, half-open, so it is described
 * by the years it was there and — if it ended — the year it was gone. A change feature is a
 * verdict that applies from its year and for every year after, so it is described by that one
 * year; it never has an end to describe.
 *
 * And one thing that is not a feature at all: below the tiles' detail zoom a mark stands for a
 * cohort's patches pooled together (`pooled`), so the sentence names the cohort in the plural
 * and quotes no size — a number here would read as the size of the mark under the cursor, and
 * it would be the size of nothing.
 */
function sentence(props: TraceFeatureProperties, area: string | null, detailZoom?: number): string {
  const from = props.valid_from;
  const to = props.valid_to;

  const when =
    props.change_type === 'cover'
      ? to == null
        ? `there from ${from} to the end of the record`
        : to - from === 1
          ? `there in ${from}, gone by ${to}`
          : `there ${from}–${to - 1}, gone by ${to}`
      : props.change_type === 'loss'
        ? `lost in ${from}`
        : props.change_type === 'gain'
          ? `appeared in ${from}`
          : `there throughout, from ${from}`;

  const subject = props.subtype ?? props.domain;
  if (props.pooled) {
    const from = detailZoom === undefined ? 'zoom in' : `zoom in past ${detailZoom}`;
    return `${capitalise(subject)}, ${when} — several patches pooled at this zoom; ${from} to see them one by one.`;
  }
  const quotable = area && areaIsMeaningful(props) ? area : null;
  return quotable ? `This ${subject}: ${when}, ${quotable}.` : `This ${subject}: ${when}.`;
}

const capitalise = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

export default function FeatureReadout() {
  const selected = useTraceStore((s) => s.selected);
  const select = useTraceStore((s) => s.select);
  const manifest = useTraceStore((s) => s.manifest);

  if (!selected) return null;

  const props = selected.properties;
  const entry = manifest?.domains.find((d) => d.id === props.domain);
  const area = formatArea(readMetric(props as unknown as Record<string, unknown>, 'area_ha'));

  return (
    <div className="pointer-events-auto w-80 rounded-xl border border-ink-700/80 bg-ink-900/90 p-4 text-sm backdrop-blur">
      <div className="flex items-start justify-between gap-3">
        <p className="leading-relaxed text-slate-100">
          {sentence(props, area, entry?.tiles.detailZoom)}
        </p>
        <button
          type="button"
          onClick={() => select(null)}
          aria-label="Close"
          className="shrink-0 text-slate-500 transition hover:text-slate-300"
        >
          ✕
        </button>
      </div>

      {/* Say why the number is missing. An absent area otherwise looks like data that failed to
          load, and the reader has no way to tell that from a number deliberately withheld. */}
      {area && !areaIsMeaningful(props) && !props.pooled && (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          No area given: cover shapes are cut by the extraction grid and at year boundaries, so one
          shape&rsquo;s size is partly an artefact of where those cuts fell.
        </p>
      )}

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px] text-slate-400">
        <dt className="text-slate-600">source</dt>
        <dd className="truncate" title={props.source}>
          {props.source}
        </dd>
        <dt className="text-slate-600">method</dt>
        <dd>{props.method}</dd>
        <dt className="text-slate-600">confidence</dt>
        {/*
          Surfaced rather than smoothed over (A5) — a number the reader can weigh. Guarded because
          these properties are an unchecked cast of raw tile attributes: tiling drops nulls (which
          is why the time filter has to test `has`), so a domain that omitted this would throw
          inside render and take the whole app down rather than losing one line of a panel.
        */}
        <dd>{typeof props.confidence === 'number' ? props.confidence.toFixed(2) : '—'}</dd>
      </dl>

      {entry && (
        <p className="mt-3 border-t border-ink-800 pt-3 text-[11px] leading-relaxed text-slate-500">
          {entry.caveat}
        </p>
      )}
    </div>
  );
}
