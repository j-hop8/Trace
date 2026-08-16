import baseStyle from '@/map/basemap/style.json';
import { useTraceStore } from '@/store/useTraceStore';

/**
 * The persistent credits line (A5, B2.1).
 *
 * Always visible, never behind a control: these are licence obligations, and the basemap's ODbL
 * terms plus the data sources' own conditions require the credit to be shown wherever the map is.
 *
 * Only *active* layers are credited. A line listing sources that are not on screen is not more
 * generous, it is less accurate — the reader cannot tell what they are actually looking at.
 */
export default function Attribution() {
  const entries = useTraceStore((s) => s.activeEntries());
  const basemapCredit = baseStyle.sources.protomaps.attribution;

  return (
    <p className="text-[11px] leading-relaxed text-slate-500">
      {/* The basemap credit ships as HTML with the required link back to OSM's copyright page. */}
      <span dangerouslySetInnerHTML={{ __html: basemapCredit }} />
      {entries.map((entry) => (
        <span key={entry.id} title={entry.caveat}>
          {' · '}
          {entry.source.attribution}
        </span>
      ))}
    </p>
  );
}
