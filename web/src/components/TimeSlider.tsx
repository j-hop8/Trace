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
 * Moving it only writes a number to the store. The map filters on the GPU, so scrubbing costs no
 * network and shows no reload flicker.
 */

/** Years advanced per second while playing. Slow enough to read, quick enough to hold attention. */
const YEARS_PER_SECOND = 6;

export default function TimeSlider() {
  const entries = useActiveEntries();
  const year = useTraceStore((s) => s.year);
  const playing = useTraceStore((s) => s.playing);
  const setYear = useTraceStore((s) => s.setYear);
  const setPlaying = useTraceStore((s) => s.setPlaying);

  const range = combinedRange(entries);
  const frame = useRef<number>();

  useEffect(() => {
    if (!playing || !range) return;

    let last = performance.now();
    let current = year >= range.end ? range.start : year;

    const step = (now: number) => {
      const advanced = ((now - last) / 1000) * YEARS_PER_SECOND;
      if (advanced >= 1) {
        const whole = Math.floor(advanced);
        current = Math.min(range.end, current + whole);
        // Advance by the time those years actually cost, not to `now` — resetting to `now` threw
        // away the leftover fraction each step, so playback ran slower than YEARS_PER_SECOND
        // claims and stepped unevenly.
        last += (whole / YEARS_PER_SECOND) * 1000;
        setYear(current);
        if (current >= range.end) {
          setPlaying(false);
          return;
        }
      }
      frame.current = requestAnimationFrame(step);
    };

    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    };
    // `year` is deliberately absent: including it would restart the animation on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, range?.start, range?.end, setYear, setPlaying]);

  // Nothing active means no meaningful axis. Hiding beats rendering a degenerate control.
  if (!range) return null;

  return (
    <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-ink-700/80 bg-ink-900/85 px-4 py-3 backdrop-blur">
      <button
        type="button"
        onClick={() => setPlaying(!playing)}
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

      <output className="w-14 shrink-0 text-right font-mono text-lg tabular-nums text-white">
        {year}
      </output>
    </div>
  );
}
