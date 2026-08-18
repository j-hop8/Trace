import baseStyle from '@/map/basemap/style.json';
import { useActiveEntries } from '@/store/useTraceStore';

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
  const entries = useActiveEntries();
  const basemapCredit = baseStyle.sources.protomaps.attribution;

  // A div, not a p: the caveats below are `details` elements, which are flow content and cannot
  // legally sit inside a paragraph — the browser silently closes the p early and the credits and
  // caveats end up as siblings in the wrong order, which is exactly how it first rendered.
  return (
    <div className="text-[11px] leading-relaxed text-slate-500">
      {/*
        The caveat is disclosed, not hovered. CLAUDE.md requires every layer to *show* its
        resolution caveat, and a `title` tooltip shows it to nobody on a touch screen, in a
        screenshot, or to anyone who does not happen to hover the right span. `details` keeps it
        out of the way while leaving it one keyboard-reachable click from the credit it qualifies.
      */}
      {entries.map((entry) => (
        <details key={entry.id} className="pointer-events-auto mb-1">
          <summary className="cursor-pointer text-slate-500 hover:text-slate-300">
            {entry.label.zh} — 資料限制 / caveat
          </summary>
          <span className="mt-1 block max-w-xl text-slate-400">{entry.caveat}</span>
        </details>
      ))}

      <p>
        {/* The basemap credit ships as HTML with the required link back to OSM's copyright page. */}
        <span dangerouslySetInnerHTML={{ __html: basemapCredit }} />
        {entries.map((entry) => (
          <span key={entry.id}>
            {' · '}
            {entry.source.attribution}
          </span>
        ))}
      </p>
    </div>
  );
}
