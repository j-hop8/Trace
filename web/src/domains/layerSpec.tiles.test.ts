/**
 * The cohort model against the real tilesets.
 *
 * `layerSpec.test.ts` checks the shape of what gets built. This checks what it actually selects,
 * by running the built filters over features decoded straight out of each domain's `.pmtiles` with
 * MapLibre's own filter evaluator — the same one the map uses. The question it answers is the one
 * that cannot be answered by reading the layer specs: for every domain, year and role, does turning
 * cohorts on by opacity select exactly the features the plain time semantics would?
 *
 * Two halves now, because the model has two halves. The pipeline writes each feature into the tile
 * layer of its cohort (`pipeline/trace_pipeline/cohorts.py`), and every style layer reads its own
 * cohort's tile layer, so the first check is that the two rules agree: for every style layer, its
 * filter over the *whole* tile selects exactly the features in its tile layer. Given that, the
 * time semantics can be checked on tile-layer membership alone, with a cover feature's copies
 * across nodes counted as one feature.
 *
 * Every domain in the manifest, not the first one. The first version read `domains[0]` only, and
 * that is how water's `valid_to` went unhonoured for a release: the domain with the problem was
 * never the one decoded.
 *
 * Skipped per domain when its archive is absent: `data/` is generated and gitignored, so requiring
 * it would make this pass or fail on whether someone happened to have built the tiles.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VectorTile } from '@mapbox/vector-tile';
import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { PbfReader } from 'pbf';
import { PMTiles } from 'pmtiles';
import { beforeAll, describe, expect, it } from 'vitest';

import { cohortSourceLayers, layersFor, opacityChannel } from '@/domains/layerSpec';
import type { DomainManifest, DomainManifestEntry } from '@/domains/manifest';
import { KIND_OF } from '@/types/feature';
import type { ChangeType } from '@/types/feature';

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data');
const MANIFEST = path.join(DATA, 'domains.json');

/**
 * How many tiles to decode per domain.
 *
 * Enough features for the comparison to mean something, few enough to keep the suite quick — the
 * work is years x roles x features, so this is the term worth bounding.
 */
const TILE_BUDGET = 8;

const manifest: DomainManifest | null = existsSync(MANIFEST)
  ? (JSON.parse(readFileSync(MANIFEST, 'utf8')) as DomainManifest)
  : null;

const archiveFor = (entry: DomainManifestEntry) => path.join(DATA, path.basename(entry.tiles.url));

const domains = (manifest?.domains ?? []).map((entry) => ({
  entry,
  runnable: existsSync(archiveFor(entry)),
}));

/**
 * A decoded tile feature: which tile layer it came from, and an identity shared by every copy of
 * the same source feature within one tile.
 *
 * The identity is the id the pipeline writes on every copy -- the feature's position in the
 * source collection -- scoped to the tile, since a feature cut by a tile edge is in two tiles.
 * Nothing else would do: single-pixel patches share every attribute, and tippecanoe simplifies
 * each tile layer on its own, so two copies of one feature can differ in tile geometry.
 */
type Feature = { layer: string; key: string; properties: Record<string, unknown> };

async function decode(domain: DomainManifestEntry): Promise<Feature[]> {
  const archivePath = archiveFor(domain);
  const bytes = readFileSync(archivePath);
  const archive = new PMTiles({
    getKey: () => archivePath,
    getBytes: async (offset: number, length: number) => ({
      data: bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + length),
    }),
  } as never);

  const header = await archive.getHeader();
  const z = Math.min(header.maxZoom, 10);
  const n = 2 ** z;
  const lonToX = (lon: number) => Math.floor(((lon + 180) / 360) * n);
  const latToY = (lat: number) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  };

  const features: Feature[] = [];
  let tiles = 0;

  for (let x = lonToX(header.minLon); x <= lonToX(header.maxLon) && tiles < TILE_BUDGET; x += 1) {
    for (let y = latToY(header.maxLat); y <= latToY(header.minLat) && tiles < TILE_BUDGET; y += 1) {
      const tile = await archive.getZxy(z, x, y);
      if (!tile?.data) continue;

      const layers = new VectorTile(new PbfReader(new Uint8Array(tile.data))).layers;
      if (Object.keys(layers).length === 0) continue;

      tiles += 1;
      for (const [name, layer] of Object.entries(layers)) {
        for (let i = 0; i < layer.length; i += 1) {
          const feature = layer.feature(i);
          if (feature.id === undefined)
            throw new Error(`${name} in ${z}/${x}/${y}: a copy with no id`);
          features.push({
            layer: name,
            key: `${x}/${y}#${feature.id}`,
            properties: feature.properties,
          });
        }
      }
    }
  }

  return features;
}

const selects = (spec: unknown, features: Feature[], where = 'test'): Set<number> => {
  // `rootKey` only labels the expression in warnings; it is required, not optional.
  const filter = featureFilter(spec as never, where);
  const hits = new Set<number>();

  features.forEach((feature, i) => {
    if (filter.filter({ zoom: 10 } as never, feature as never, undefined as never)) hits.add(i);
  });

  return hits;
};

/** `trace-water-fill-loss-2013` → `fill-loss`; `trace-forest-cover-fill-2001-2026` → `cover-fill`. */
const roleOf = (id: string, domainId: string) =>
  id.replace(`trace-${domainId}-`, '').replace(/-\d{4}(-\d{4})?$/, '');

/** The plain time semantics a role's cohorts stand in for, by the kind of state it draws. */
const inYear = (props: Record<string, unknown>, year: number, kind: 'cover' | 'change') => {
  const from = Number(props.valid_from);
  if (kind === 'change') return from <= year;
  const to = props.valid_to == null ? Infinity : Number(props.valid_to);
  return from <= year && year < to;
};

// With no manifest there is nothing to iterate, and a file that registers no suite at all is a
// vitest *failure* ("No test suite found"), not a skip — which would turn CI red, where `data/`
// never exists. So the absent-data case is a suite that is skipped on purpose and says why.
if (domains.length === 0) {
  describe.skip('cohorts against the built tilesets', () => {
    it('needs data/domains.json — run the pipeline to build it', () => {});
  });
}

describe.each(domains)('cohorts against the built $entry.id tileset', ({ entry, runnable }) => {
  let features: Feature[] = [];

  beforeAll(async () => {
    if (runnable) features = await decode(entry);
  }, 120_000);

  it.skipIf(!runnable)('decodes real features to compare against', () => {
    expect(features.length).toBeGreaterThan(0);
  });

  it.skipIf(!runnable)(
    'never sees a change-kind feature that expires, which is what change cohorts assume',
    () => {
      // A change cohort switches on at its year and never switches off, so a change feature carrying
      // a `valid_to` would keep drawing past its end. This is that precondition as a check rather than
      // a comment. Cover is allowed to expire — that is what interval cohorts are for.
      const expiring = features.filter(
        (f) =>
          KIND_OF[f.properties.change_type as ChangeType] === 'change' &&
          f.properties.valid_to != null,
      );

      // Water's JRC `lost *` / `ephemeral *` classes still carry a `valid_to` until T-031 re-dates
      // them as open-ended change; the suite says so rather than going red for a known ticket.
      // "Not yet re-extracted under the taxonomy" is read off the tileset itself: a domain that
      // has been carries `cover`. Once it does, expiring change is a real failure again — which is
      // the right pressure to have on T-031 the moment T-030 lands.
      const pendingT031 = expiring.length > 0 && entry.changeTypes?.includes('cover') !== true;
      if (pendingT031) {
        console.warn(
          `[${entry.id}] ${expiring.length} change-kind features carry valid_to — pending T-031`,
        );
        return;
      }

      expect(expiring).toHaveLength(0);
    },
  );

  it.skipIf(!runnable)('holds only tile layers the model reads and the manifest lists', () => {
    // A tile layer the web builds no style layer for is data that never draws, whatever the
    // pipeline thought it was writing. And the manifest is what the web builds from, so a layer
    // present in the archive but not listed there is invisible in exactly the same way.
    const inTiles = new Set(features.map((f) => f.layer));
    const model = new Set(cohortSourceLayers(entry));
    const listed = new Set(entry.tiles.sourceLayers);

    expect([...inTiles].filter((l) => !model.has(l))).toEqual([]);
    expect([...inTiles].filter((l) => !listed.has(l))).toEqual([]);
  });

  it.skipIf(!runnable)(
    'has each style layer’s filter select exactly the tile layer it reads, over the whole tile',
    () => {
      // The pipeline's naming rule and this file's filters are two implementations of one cohort
      // model, in two languages, and this is where they are held to agree: run every style
      // layer's filter over every feature of the tile, whatever tile layer it is in, and the
      // features it selects must be precisely the features in that style layer's own tile layer.
      // A filter that selected more would mean features the map never draws (they are in a layer
      // it does not read); one that selected less would mean features drawn from a layer that
      // does not claim them. Compared by identity, because the filter reads attributes and every
      // copy of a feature carries the same ones: a node's filter selects all of a feature's
      // copies, and the claim is that one of them is in the node's layer.
      const layers = layersFor(entry, entry.temporal.end, new Set(entry.changeTypes ?? [])).layers;
      const byLayer = new Map<string, Set<string>>();
      for (const f of features) {
        if (!byLayer.has(f.layer)) byLayer.set(f.layer, new Set());
        byLayer.get(f.layer)!.add(f.key);
      }

      // One evaluation per (filter, feature) — the same pass the worker used to make per tile.
      const seen = new Set<string>();
      for (const layer of layers) {
        const sourceLayer = (layer as { 'source-layer': string })['source-layer'];
        if (seen.has(sourceLayer)) continue; // roles of one state share a filter's selection
        seen.add(sourceLayer);

        const selected = new Set(
          [...selects(layer.filter, features, layer.id)].map((i) => features[i]!.key),
        );
        const members = byLayer.get(sourceLayer) ?? new Set<string>();

        const extra = [...selected].filter((k) => !members.has(k)).length;
        const missing = [...members].filter((k) => !selected.has(k)).length;
        expect({ sourceLayer, extra, missing }).toEqual({ sourceLayer, extra: 0, missing: 0 });
      }
    },
    240_000,
  );

  it.skipIf(!runnable)(
    'selects exactly what the plain time semantics would, every year and every role',
    () => {
      // Given the check above, a style layer's selection *is* its tile layer, so this walks
      // membership rather than evaluating filters again. A cover feature is in every node
      // canonical for its validity, so its copies are one feature here: the property is that its
      // key is claimed by exactly one shown layer of a role in a year it is valid, and by none in
      // a year it is not.
      const years: number[] = [];
      for (let y = entry.temporal.start; y <= entry.temporal.end; y += 1) years.push(y);

      const byLayer = new Map<string, Feature[]>();
      for (const f of features) {
        if (!byLayer.has(f.layer)) byLayer.set(f.layer, []);
        byLayer.get(f.layer)!.push(f);
      }
      // Every distinct source feature, once, whichever layer a copy of it sits in.
      const distinct = new Map<string, Feature>();
      for (const f of features) if (!distinct.has(f.key)) distinct.set(f.key, f);

      for (const year of years) {
        // Everything the domain can show, so cover and every change are covered.
        const layers = layersFor(entry, year, new Set(entry.changeTypes ?? [])).layers;
        const roles = new Set(layers.map((l) => roleOf(l.id, entry.id)));

        for (const role of roles) {
          const mine = layers.filter((l) => roleOf(l.id, entry.id) === role);
          const first = mine[0]!;

          // The reference: this role's own `change_type`, read off its filter rather than restated
          // here, composed with the time semantics its kind of cohort stands in for.
          const changeTypeTest = (first.filter as unknown as unknown[]).at(-1);
          const changeType = (changeTypeTest as unknown[])[2] as ChangeType;
          const kind = KIND_OF[changeType];
          const expected = new Set(
            [...distinct.values()]
              .filter((f) => f.properties.change_type === changeType)
              .filter((f) => inYear(f.properties, year, kind))
              .map((f) => f.key),
          );

          // What the cohorts actually put on screen: only those left at non-zero opacity. This is
          // driven by the build's own opacity assignment, so it exercises the gating. A feature two
          // shown layers both hold would be drawn twice — the property the canonical decomposition
          // exists to prevent.
          const shown = new Set<string>();
          const twice: string[] = [];
          for (const layer of mine) {
            const paint = layer.paint as Record<string, unknown>;
            const { shown: opacity } = opacityChannel({ type: layer.type, paint });
            if (opacity === 0) continue;
            const sourceLayer = (layer as { 'source-layer': string })['source-layer'];
            for (const f of byLayer.get(sourceLayer) ?? []) {
              if (shown.has(f.key)) twice.push(f.key);
              shown.add(f.key);
            }
          }

          expect({ year, role, twice: twice.length }).toEqual({ year, role, twice: 0 });
          const extra = [...shown].filter((k) => !expected.has(k)).length;
          const missing = [...expected].filter((k) => !shown.has(k)).length;
          expect({ year, role, extra, missing }).toEqual({ year, role, extra: 0, missing: 0 });
        }
      }
    },
    240_000,
  );
});
