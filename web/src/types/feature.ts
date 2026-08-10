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
  /** Year the state ends; `null` means still current as of the source's last observed year. */
  valid_to?: number | null;

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
 * Vector tiles flatten nested objects, so `metric` arrives as `metric.area_ha` at the top level.
 * Reading a metric therefore goes through this rather than `props.metric.area_ha`, which is
 * `undefined` on a tile-decoded feature and would silently render "—" instead of a number.
 */
export function readMetric(
  props: Record<string, unknown>,
  key: keyof FeatureMetric,
): number | undefined {
  const flat = props[`metric.${key}`] ?? props[key];
  if (typeof flat === 'number') return flat;

  const nested = props.metric;
  if (nested && typeof nested === 'object') {
    const value = (nested as Record<string, unknown>)[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}
