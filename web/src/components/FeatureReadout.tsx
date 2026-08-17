import { useTraceStore } from '@/store/useTraceStore';
import { readMetric } from '@/types/feature';
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

/** The one-line story: what this is, when it changed, and by how much. */
function sentence(props: TraceFeatureProperties, area: string | null): string {
  const from = props.valid_from;
  const to = props.valid_to;

  const when =
    props.change_type === 'loss'
      ? to
        ? `lost between ${from} and ${to}`
        : `lost in ${from}`
      : props.change_type === 'gain'
        ? `appeared in ${from}`
        : // Extent is an observation of one year, not a claim about every year since. "Present
          // since 2000" would say this block is still standing, which is exactly what the loss
          // features exist to contradict.
          props.change_type === 'extent'
          ? `mapped at the ${from} baseline`
          : to
            ? `present ${from}–${to}`
            : `present since ${from}`;

  const subject = props.subtype ?? props.domain;
  return area ? `This ${subject}: ${when}, ${area}.` : `This ${subject}: ${when}.`;
}

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
        <p className="leading-relaxed text-slate-100">{sentence(props, area)}</p>
        <button
          type="button"
          onClick={() => select(null)}
          aria-label="Close"
          className="shrink-0 text-slate-500 transition hover:text-slate-300"
        >
          ✕
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px] text-slate-400">
        <dt className="text-slate-600">source</dt>
        <dd className="truncate" title={props.source}>
          {props.source}
        </dd>
        <dt className="text-slate-600">method</dt>
        <dd>{props.method}</dd>
        <dt className="text-slate-600">confidence</dt>
        {/* Surfaced rather than smoothed over (A5) — a number the reader can weigh. */}
        <dd>{props.confidence.toFixed(2)}</dd>
      </dl>

      {entry && (
        <p className="mt-3 border-t border-ink-800 pt-3 text-[11px] leading-relaxed text-slate-500">
          {entry.caveat}
        </p>
      )}
    </div>
  );
}
