/**
 * The domain manifest — the contract between pipeline and web app.
 *
 * The pipeline writes `data/domains.json`; this module reads it. Everything the app knows about
 * which domains exist, what they are called, what colour they are, what years they cover, and
 * what credit they require comes from here.
 *
 * Nothing in `web/` may hardcode a domain id. Adding "coast" should require zero changes to this
 * file or any component — only a new entry in the JSON.
 */

import type { DomainId } from '@/types/feature';

export interface DomainSource {
  name: string;
  version: string;
  /** Verbatim credit the licence requires. Rendered as-is in the attribution line. */
  attribution: string;
  citation: string;
  licence: string;
}

export interface DomainManifestEntry {
  id: DomainId;
  label: { en: string; zh: string };
  /** Extent hue. The one input to `colorFor` that varies by domain. */
  hue: string;
  /**
   * Inclusive year range this domain actually has data for. Resolved by the pipeline at
   * extraction time, so a source that fell back to an older version reports its real, shorter
   * range here — which is how the slider stays honest instead of showing empty years.
   */
  temporal: { start: number; end: number };
  source: DomainSource;
  /** The layer's honest limitation, shown in the UI (A5). */
  caveat: string;
  tiles: { url: string; sourceLayer: string };
}

export interface DomainManifest {
  version: number;
  domains: DomainManifestEntry[];
}

/** The manifest version this build understands. A bump means the tile contract changed. */
const SUPPORTED_VERSION = 1;

export async function loadManifest(url = '/data/domains.json'): Promise<DomainManifest> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Could not load the domain manifest from ${url} (${response.status}). ` +
        `Run the pipeline first: cd pipeline && python -m trace_pipeline.cli all`,
    );
  }

  const manifest = (await response.json()) as DomainManifest;

  if (manifest.version !== SUPPORTED_VERSION) {
    throw new Error(
      `Manifest version ${manifest.version} but this build understands ${SUPPORTED_VERSION}. ` +
        `Regenerate the tiles, or check out a matching commit.`,
    );
  }

  return manifest;
}

/**
 * The union of every active domain's year range.
 *
 * Water starts in 1984 and forest in 2000, so the slider's bounds depend on what is switched on.
 * B8 calls forcing a shared range a mistake — the fix is that the range is derived, and each
 * layer's own `temporal` still governs whether it renders in a given year.
 *
 * Returns `null` when nothing is active, so the caller can hide the slider rather than render a
 * degenerate one.
 */
export function combinedRange(
  entries: DomainManifestEntry[],
): { start: number; end: number } | null {
  if (entries.length === 0) return null;

  return entries.reduce(
    (range, entry) => ({
      start: Math.min(range.start, entry.temporal.start),
      end: Math.max(range.end, entry.temporal.end),
    }),
    { start: Infinity, end: -Infinity },
  );
}

/** Whether a domain has data for a given year — drives the "no data yet" affordance. */
export function coversYear(entry: DomainManifestEntry, year: number): boolean {
  return year >= entry.temporal.start && year <= entry.temporal.end;
}
