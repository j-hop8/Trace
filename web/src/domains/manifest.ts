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

import { CHANGE_TYPE_ORDER, KIND_OF, KIND_ORDER } from '@/types/feature';
import type { ChangeType, DomainId, Kind } from '@/types/feature';

export interface DomainSource {
  name: string;
  version: string;
  /** Verbatim credit the licence requires. Rendered as-is in the attribution line. */
  attribution: string;
  citation: string;
  licence: string;
}

/** One further number a level's readout quotes — the absolute °C beside the anomaly. */
export interface MeasureReadout {
  /** A key of the feature's `metric`. */
  key: string;
  unit: string;
  label: { en: string; zh: string };
}

/**
 * What a level domain measures: the manifest's description of its ramp.
 *
 * `breaks` are fixed class boundaries, ascending — `n` breaks make `n + 1` bands, a value on a
 * break belongs to the band above it, and they are the same for every year, so a colour means the
 * same thing in 1965 as in 2023. A level feature carries its band; this is what says what the band
 * *is*.
 */
export interface DomainMeasure {
  /** The metric key the bands are cut from, and the number the readout leads with. */
  key: string;
  unit: string;
  label: { en: string; zh: string };
  breaks: number[];
  /** What the value is relative to, when it is relative to something ("1991–2020 normal"). */
  baseline?: string;
  readout: MeasureReadout[];
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
  /**
   * Present exactly when the tileset holds `level` features: the unit, labels and fixed class
   * breaks the ramp, the legend and the readout are built from. The pipeline refuses a manifest
   * with levels and no measure; `selectableTypes` refuses to offer a level without one.
   */
  measure?: DomainMeasure;
  tiles: {
    url: string;
    /**
     * The tile layers the archive holds -- one per cohort, named by the pipeline with the same
     * rule `layerSpec` builds cohorts by: `loss:2013` for a year, `cover:2001-2026` for an
     * interval node. Measured from the archive like `changeTypes`, so the list is what is there:
     * a cohort with no features has no layer, and `layerSpec` builds a style layer only for a
     * cohort listed here. A style layer naming a layer the source lacks is an error MapLibre
     * raises on every tile.
     *
     * Why the tile is split this way at all: MapLibre's worker runs a style layer's filter over
     * every feature of the tile layer it names. Hundreds of cohort layers over one tile layer
     * meant every feature was filtered hundreds of times per tile -- minutes of parsing at the
     * opening view. One tile layer per cohort makes each filter a pass over its own cohort.
     */
    sourceLayers: string[];
    /**
     * The zoom from which every feature is its own tile feature, with its id and its metric.
     *
     * Below it the tiles are the island view: one feature per cohort and attribute group per
     * tile, with patches smaller than a screen pixel pooled into squares of the same total area
     * (`pipeline/trace_pipeline/tiles.py`). Such a feature carries `pooled` and no metric, and
     * the readout says so rather than quoting a number for a mark that stands for several
     * patches. Set by the pipeline and read from here, never assumed: it is the tiles' contract.
     */
    detailZoom: number;
  };
}

export interface DomainManifest {
  version: number;
  domains: DomainManifestEntry[];
}

/**
 * The manifest version this build understands. A bump means the tile contract changed.
 *
 * 4: a third kind of state, `level`, with `level:S-E` tile layers and a per-domain `measure`.
 * 3: two regimes split at `tiles.detailZoom` -- pooled below it, exact from it up.
 * 2: one tile layer per cohort (`tiles.sourceLayers`) rather than one named for the domain.
 */
const SUPPORTED_VERSION = 4;

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
  // A level without its measure has no ramp to be drawn in and no unit to be read in: offering
  // it would be a toggle onto nothing, which is the one thing this function exists to prevent.
  if (!entry.measure) present.delete('level');
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
  const byKind: Record<Kind, ChangeType[]> = { level: [], cover: [], change: [] };
  for (const changeType of selectableTypes(entry)) byKind[KIND_OF[changeType]].push(changeType);
  return byKind;
}

/**
 * The kinds this domain holds at least one state of, in `KIND_ORDER`.
 *
 * The one list that both the map and the controls walk: a domain is loaded one kind at a time,
 * in this order, and it is these kinds the loading badges report on. Deriving both from the same
 * function is what keeps a badge from naming a kind the map never builds, or the other way round.
 */
export function kindsOf(entry: DomainManifestEntry): Kind[] {
  const byKind = selectableTypesByKind(entry);
  return KIND_ORDER.filter((kind) => byKind[kind].length > 0);
}

/**
 * Whether this domain is a *backdrop*: a measured field covering the whole island, drawn beneath
 * every other domain and shown one at a time.
 *
 * Two fields at once cannot both be read — two full-island washes, one over the other — so the
 * store keeps at most one backdrop on, and the map slides a backdrop under whatever is already
 * drawn. Decided by what the tileset holds, never by the domain's id.
 */
export function isBackdrop(entry: DomainManifestEntry): boolean {
  return selectableTypes(entry).includes('level');
}

/**
 * The values a band spans, `[from, to)`: `from` is null for the lowest band and `to` for the
 * highest, which are open-ended. `null` for a band the breaks do not define.
 */
export function bandBounds(
  measure: DomainMeasure,
  band: number,
): { from: number | null; to: number | null } | null {
  if (!Number.isInteger(band) || band < 0 || band > measure.breaks.length) return null;
  return {
    from: band === 0 ? null : (measure.breaks[band - 1] ?? null),
    to: band === measure.breaks.length ? null : (measure.breaks[band] ?? null),
  };
}

/**
 * A number as the legend and the readout write it: a true minus sign, a plus when `signed` — for a
 * value relative to a baseline, where "+0.5" says "above normal" and "0.5" says only "half a
 * degree" — and `compact` for the legend's ticks, where "10K" has room and "10,000" does not.
 */
export function formatValue(
  value: number,
  { signed = false, compact = false }: { signed?: boolean; compact?: boolean } = {},
): string {
  const text = Math.abs(value).toLocaleString('en', {
    maximumFractionDigits: 2,
    notation: compact ? 'compact' : 'standard',
  });
  const sign = value < 0 ? '−' : signed && value > 0 ? '+' : '';
  return `${sign}${text}`;
}

/** A value of this measure, signed exactly when the measure is relative to a baseline. */
export function formatMeasure(
  measure: DomainMeasure,
  value: number,
  { compact = false }: { compact?: boolean } = {},
): string {
  return formatValue(value, { signed: Boolean(measure.baseline), compact });
}

/** A band's span in words, `[from, to)`: "< −1", "−1 – −0.5", "≥ 1.5". Units are the caller's. */
export function bandLabel(measure: DomainMeasure, band: number): string | null {
  const bounds = bandBounds(measure, band);
  if (!bounds) return null;
  if (bounds.from === null)
    return bounds.to === null ? null : `< ${formatMeasure(measure, bounds.to)}`;
  if (bounds.to === null) return `≥ ${formatMeasure(measure, bounds.from)}`;
  return `${formatMeasure(measure, bounds.from)} – ${formatMeasure(measure, bounds.to)}`;
}
