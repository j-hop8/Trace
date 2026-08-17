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

import type { ChangeType, DomainId } from '@/types/feature';

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
   * Which change types this domain's tileset contains.
   *
   * Read rather than assumed, because it decides what the UI offers: a domain carrying both an
   * `extent` and a change type can be viewed either way and gets a view toggle, and one carrying
   * only changes does not. Testing for a domain id instead would put `forest` back into the
   * components, which is the coupling the manifest exists to remove.
   *
   * Optional: a manifest written before this field existed simply has no extent to show.
   */
  changeTypes?: ChangeType[];
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

/** What to tell someone whose manifest is missing. The fix is almost always the first line. */
const MISSING_MANIFEST_HINT =
  'Generate it with:  cd pipeline && .venv/bin/python -m trace_pipeline.cli all\n' +
  'If it already exists in the repo-root data/ directory, the dev server is not serving /data — ' +
  'restart it so the serve-data plugin in vite.config.ts is applied. In production, /data is ' +
  'served by the host.';

export async function loadManifest(url = '/data/domains.json'): Promise<DomainManifest> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Could not load the domain manifest from ${url} (${response.status}).\n` +
        MISSING_MANIFEST_HINT,
    );
  }

  // A 404 is not how a missing manifest usually presents. Vite's dev server answers unknown
  // paths with index.html at HTTP 200 — the SPA fallback — so `response.ok` is true and the
  // check above sails past. Without this, the failure surfaces as
  // `Unexpected token '<', "<!doctype "... is not valid JSON`, which tells the reader nothing
  // about what is actually wrong. Static hosts behave the same way for missing files.
  const body = await response.text();
  if (body.trimStart().startsWith('<')) {
    throw new Error(
      `${url} returned HTML rather than JSON, which means the file is not being served ` +
        `(a dev server answering with index.html, not a real manifest).\n${MISSING_MANIFEST_HINT}`,
    );
  }

  let manifest: DomainManifest;
  try {
    manifest = JSON.parse(body) as DomainManifest;
  } catch (error) {
    throw new Error(
      `${url} is not valid JSON: ${error instanceof Error ? error.message : String(error)}\n` +
        `The file exists but is malformed — regenerate it.`,
    );
  }

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

/**
 * The two questions a domain can be asked.
 *
 * `change` is what moved — the loss patches accumulating as the year advances. `extent` is what
 * is left — the baseline with everything lost by that year taken out of it. Same tileset, same
 * time filter; only which features are drawn, and how, differs.
 */
export type ViewMode = 'change' | 'extent';

/**
 * Whether a domain can answer both questions, and so should offer the toggle.
 *
 * Both halves are required. A domain with extent but no change type has no second view to switch
 * to, and one with changes but no baseline cannot say what is left — offering a toggle in either
 * case would give the reader an empty layer and no explanation.
 */
export function supportsExtentView(entry: DomainManifestEntry): boolean {
  const types = entry.changeTypes ?? [];
  return types.includes('extent') && types.some((type) => type !== 'extent');
}
