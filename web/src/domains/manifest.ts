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

import { CHANGE_TYPE_ORDER, KIND_OF } from '@/types/feature';
import type { ChangeType, DomainId, Kind } from '@/types/feature';

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
  /** The domain's hue. The one input to `styleFor` that varies by domain. */
  hue: string;
  /**
   * Which change types this domain's tileset contains.
   *
   * Measured by the pipeline from the built tiles, not declared — so a domain whose cover pass was
   * interrupted advertises what it actually has. This is the whole basis of the layer controls:
   * one toggle per entry here, and one set of map layers per entry here. Testing for a domain id
   * instead would put `forest` back into the components, which is the coupling the manifest exists
   * to remove.
   *
   * Optional: a manifest written before this field existed offers no per-state control at all.
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
 * The states this domain can be asked to show, in the order they should be listed and drawn.
 *
 * The single source for both the toggles and the map layers, so a control can never appear for a
 * state the tileset cannot fill, and a layer can never be built with no way to switch it off.
 *
 * Sorted into `CHANGE_TYPE_ORDER` rather than taken as-is: the pipeline reads these back out of
 * tippecanoe's tilestats, which reports them alphabetically, and "gain, loss, stable" is an
 * accident of the alphabet rather than an order that means anything on a map.
 *
 * Empty for a manifest written before `changeTypes` existed — such a domain draws nothing, which is
 * the honest reading of "the tileset never said what it holds".
 */
export function selectableTypes(entry: DomainManifestEntry): ChangeType[] {
  const present = new Set(entry.changeTypes ?? []);
  return CHANGE_TYPE_ORDER.filter((changeType) => present.has(changeType));
}

/**
 * The same states, split by kind: what was *there* in a year, and what *changed* since the record
 * began. The toggles group by this, because the two kinds answer different questions and are
 * compared against different baselines — a year for cover, the record's start for change — and a
 * chip that does not say which one it is compared against is a colour with no meaning.
 *
 * Order within each kind follows `selectableTypes`; a domain without one kind gets an empty list
 * for it, and the toggles draw no group.
 */
export function selectableTypesByKind(entry: DomainManifestEntry): Record<Kind, ChangeType[]> {
  const byKind: Record<Kind, ChangeType[]> = { cover: [], change: [] };
  for (const changeType of selectableTypes(entry)) byKind[KIND_OF[changeType]].push(changeType);
  return byKind;
}
