/**
 * The B4 feature spine, mirroring `schema/feature.schema.json`.
 *
 * The JSON Schema is authoritative — the pipeline validates its output against it. This file is
 * the hand-maintained TypeScript view of the same contract. If you change one, change both; the
 * pipeline test `test_schema.py::test_ts_and_json_schema_agree` fails loudly when they drift.
 */

/** The universal change signal, identical across every domain. */
export type ChangeType = 'gain' | 'loss' | 'stable';

/**
 * A domain id. Deliberately `string` rather than a union of 'water' | 'forest': the web app
 * learns which domains exist from the manifest at runtime, so hardcoding them here would
 * reintroduce exactly the coupling the manifest exists to remove.
 */
export type DomainId = string;

export interface FeatureMetric {
  area_ha?: number;
  length_m?: number;
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

  /** Dataset and version this feature came from. */
  source: string;
  /** How it was derived — dataset operation or model id. */
  method: string;
  /** 0–1, surfaced in the UI rather than hidden. */
  confidence: number;
}

/** A GeoJSON Feature carrying Trace properties. Also the shape of a decoded vector-tile feature. */
export interface TraceFeature {
  type: 'Feature';
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
export function readMetric(
  props: Record<string, unknown>,
  key: keyof FeatureMetric,
): number | undefined {
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
