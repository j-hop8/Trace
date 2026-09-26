/**
 * The B4 feature spine, mirroring `schema/feature.schema.json`.
 *
 * The JSON Schema is authoritative — the pipeline validates its output against it. This file is
 * the hand-maintained TypeScript view of the same contract. If you change one, change both; the
 * pipeline test `test_schema.py::test_ts_and_json_schema_agree` fails loudly when they drift.
 */

/**
 * The universal state signal, identical across every domain.
 *
 * `cover` is not a change: it is the baseline the changes are measured against, carried as a
 * change_type so that one tileset per domain still holds everything the map draws. `level` is not
 * a category at all: it is a measured value held for one year — a temperature, a population
 * density — drawn by the `band` it falls in.
 */
export type ChangeType = 'cover' | 'gain' | 'level' | 'loss' | 'stable';

/**
 * The three kinds of state. Cover carries its own validity; change accumulates and never closes;
 * level is a value measured over exactly one year.
 */
export type Kind = 'level' | 'cover' | 'change';
export const KIND_OF: Record<ChangeType, Kind> = {
  level: 'level',
  cover: 'cover',
  stable: 'change',
  gain: 'change',
  loss: 'change',
};

/**
 * The kinds in the order they are drawn, listed and loaded: a measured field first, as the
 * backdrop everything else is read against; then the ground a domain's changes happened to; then
 * the changes. `CHANGE_TYPE_ORDER` below is this same order one level down.
 */
export const KIND_ORDER: readonly Kind[] = ['level', 'cover', 'change'];

/**
 * Every change type, in the order they should be drawn and listed.
 *
 * Not the union's declaration order, which is alphabetical and meaningless on a map. This runs from
 * the ground state outward: a level's field first, cover, then what stayed, then what arrived,
 * then what went — so `loss` is drawn last and sits on top of whatever it happened to, and a
 * legend built by walking this reads as a sentence rather than a set.
 */
export const CHANGE_TYPE_ORDER: readonly ChangeType[] = [
  'level',
  'cover',
  'stable',
  'gain',
  'loss',
];

/**
 * A domain id. Deliberately `string` rather than a union of 'water' | 'forest': the web app
 * learns which domains exist from the manifest at runtime, so hardcoding them here would
 * reintroduce exactly the coupling the manifest exists to remove.
 */
export type DomainId = string;

/**
 * A feature's numbers. `area_ha` and `length_m` are the spine's own; a level carries its measured
 * value beside them under the key its domain's manifest `measure` names (`temp_anomaly_c`,
 * `density_per_km2`), which is why the rest are open.
 */
export interface FeatureMetric {
  area_ha?: number;
  length_m?: number;
  [key: string]: number | undefined;
}

export interface TraceFeatureProperties {
  domain: DomainId;
  subtype?: string | null;

  /** Year the state begins. An integer year — the time slider filters on it numerically. */
  valid_from: number;
  /**
   * Year the state ends; `null` means still current as of the source's last observed year.
   *
   * Required rather than optional — the key must be present even when the value is null. An
   * extractor that omits it would make every feature look current, and that failure is invisible
   * on the map.
   */
  valid_to: number | null;

  change_type: ChangeType;
  metric: FeatureMetric;

  /**
   * Which of the domain's fixed classes a level's value falls in, from 0 at the lowest of the
   * manifest's `measure.breaks`. Present on level features only, and kept on the pooled island
   * copies — unlike `metric` — because it is what colours a level at every zoom.
   */
  band?: number;

  /** Dataset and version this feature came from. */
  source: string;
  /** How it was derived — dataset operation or model id. */
  method: string;
  /** 0–1, surfaced in the UI rather than hidden. */
  confidence: number;

  /**
   * Present, and true, on a tile feature below the manifest's `tiles.detailZoom`: this is a
   * cohort's shapes pooled for one tile, not one patch, and it carries no `metric`.
   *
   * A tile-only marker. It is never in the GeoJSON and so never in the schema -- the pipeline
   * writes it on the island copies it hands tippecanoe (`tiles.py`), which is why `metric` is
   * declared required above and yet absent here: the readout reads through `readMetric`, which
   * tolerates that, and quotes nothing for a pooled feature.
   */
  pooled?: true;
}

/** A GeoJSON Feature carrying Trace properties. Also the shape of a decoded vector-tile feature. */
export interface TraceFeature {
  type: 'Feature';
  /**
   * In a tile, the feature's position in the source collection. The pipeline writes a cover
   * feature into one tile layer per interval node that covers it, and every copy carries this
   * same id — the one thing that tells a copy from a neighbour with identical attributes.
   */
  id?: string | number;
  geometry: GeoJSON.Geometry;
  properties: TraceFeatureProperties;
}

/**
 * Read a metric from a feature, whichever shape it arrived in.
 *
 * Mapbox Vector Tiles have no nested values, so `metric` does not survive tiling as an object.
 * Measured against a real tileset, tippecanoe serialises it to a **JSON string** —
 * `'{"area_ha":0.1397}'` — rather than flattening it to `metric.area_ha` as first assumed. Both
 * are handled here, along with the plain object a feature has before it is tiled.
 *
 * This matters more than it looks: every one of those wrong guesses returns `undefined` rather
 * than throwing, so the readout would quietly show "—" for a number the pipeline definitely
 * measured, and nothing would indicate the value had been lost in transit.
 */
export function readMetric(props: Record<string, unknown>, key: string): number | undefined {
  // Flattened (`metric.area_ha`) or top-level — cheapest checks first.
  const flat = props[`metric.${key}`] ?? props[key];
  if (typeof flat === 'number') return flat;

  const metric = props.metric;

  // The shape tiles actually deliver.
  if (typeof metric === 'string') {
    try {
      const parsed: unknown = JSON.parse(metric);
      if (parsed && typeof parsed === 'object') {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === 'number') return value;
      }
    } catch {
      // Not JSON; fall through rather than throwing inside a render path.
    }
    return undefined;
  }

  // Untiled features, straight from the pipeline.
  if (metric && typeof metric === 'object') {
    const value = (metric as Record<string, unknown>)[key];
    if (typeof value === 'number') return value;
  }

  return undefined;
}
