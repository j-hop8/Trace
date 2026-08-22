import { useEffect, useRef } from 'react';

import { combinedRange } from '@/domains/manifest';
import { useActiveEntries, useTraceStore } from '@/store/useTraceStore';

/**
 * The time control.
 *
 * Its range is the union of the active domains' coverage, so toggling a layer changes the
 * bounds — water reaches back to 1984, forest only to 2000. B8 calls forcing a shared range a
 * mistake, because it either invents years a source does not have or hides ones it does.
 *
 * Moving it only writes a number to the store. Applying that number costs the map a re-parse of
 * every loaded tile, so the thumb and the map run at different speeds by design: the thumb follows
 * the pointer, while `renderedYear` reports what has actually been drawn. The readout shows the
 * latter, so the number beside the slider always names the year on screen.
 */

/**
 * The fastest playback will run — a ceiling, not a rate.
 *
 * Playback advances only once the map reports the previous year drawn, so the real pace is whatever
 * the machine sustains and this only stops a fast one from flickering past unreadably. Driving it
 * off a clock instead is what used to make the map look frozen: years were requested faster than
 * they could be rendered, and each reload cancelled the one before it, so only the last one landed.
 */
const MAX_YEARS_PER_SECOND = 6;
const MIN_STEP_MS = 1000 / MAX_YEARS_PER_SECOND;

export default function TimeSlider() {
  const entries = useActiveEntries();
  const year = useTraceStore((s) => s.year);
  const renderedYear = useTraceStore((s) => s.renderedYear);
  const playing = useTraceStore((s) => s.playing);
  const setYear = useTraceStore((s) => s.setYear);
  const setPlaying = useTraceStore((s) => s.setPlaying);

  const range = combinedRange(entries);
  /** When the year currently playing was asked for, so the ceiling measures the whole step. */
  const stepAskedAt = useRef(0);

  useEffect(() => {
    if (!playing || !range) return;

    if (year >= range.end) {
      setPlaying(false);
      return;
    }

    // The map is still drawing the year already asked for. Asking for the next one now is exactly
    // what made playback unwatchable: the pending reload would be thrown away half-finished.
    if (renderedYear !== year) return;

    // Time already spent rendering counts towards the step, so a slow year advances the moment it
    // appears and only a fast one waits.
    const wait = Math.max(0, MIN_STEP_MS - (performance.now() - stepAskedAt.current));
    const timer = window.setTimeout(() => {
      stepAskedAt.current = performance.now();
      setYear(year + 1);
    }, wait);

    return () => window.clearTimeout(timer);
  }, [playing, year, renderedYear, range?.start, range?.end, setYear, setPlaying]);

  // Nothing active means no meaningful axis. Hiding beats rendering a degenerate control.
  if (!range) return null;

  return (
    <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-ink-700/80 bg-ink-900/85 px-4 py-3 backdrop-blur">
      <button
        type="button"
        onClick={() => {
          if (playing) {
            setPlaying(false);
            return;
          }
          stepAskedAt.current = performance.now();
          // Replaying from the end restarts at the first year *and shows it*. Starting the loop at
          // `range.start` without emitting it made the first visible frame `range.start + 1`, so a
          // replay opened on a jump from the last year to the second one.
          if (year >= range.end) setYear(range.start);
          setPlaying(true);
        }}
        aria-label={playing ? 'Pause' : 'Play through the years'}
        className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-ink-700 text-slate-300 transition hover:border-slate-500 hover:text-white"
      >
        {playing ? '❚❚' : '▶'}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <input
          type="range"
          min={range.start}
          max={range.end}
          step={1}
          value={Math.min(Math.max(year, range.start), range.end)}
          onChange={(event) => {
            setPlaying(false);
            setYear(Number(event.target.value));
          }}
          aria-label="Year"
          className="w-full accent-slate-300"
        />
        <div className="flex justify-between font-mono text-[10px] text-slate-500">
          <span>{range.start}</span>
          <span>{range.end}</span>
        </div>
      </div>

      {/* The drawn year, not the requested one — see the note at the top of the file. */}
      <output className="w-14 shrink-0 text-right font-mono text-lg tabular-nums text-white">
        {renderedYear}
      </output>
    </div>
  );
}
