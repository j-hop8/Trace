/**
 * The cohort model against the real tileset.
 *
 * `layerSpec.test.ts` checks the shape of what gets built. This checks what it actually selects,
 * by running the built filters over features decoded straight out of `data/forest.pmtiles` with
 * MapLibre's own filter evaluator — the same one the map uses. The question it answers is the one
 * that cannot be answered by reading the layer specs: for every year, does turning cohorts on by
 * opacity select exactly the features a `valid_from <= year` filter would have selected?
 *
 * Skipped when the pipeline has not been run: `data/` is generated and gitignored, so requiring it
 * would make this pass or fail on whether someone happened to have built the tiles.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { VectorTile } from '@mapbox/vector-tile';
import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { PbfReader } from 'pbf';
import { PMTiles } from 'pmtiles';
import { beforeAll, describe, expect, it } from 'vitest';

import { layersFor } from '@/domains/layerSpec';
import type { DomainManifest, DomainManifestEntry } from '@/domains/manifest';

const DATA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../data');
const MANIFEST = path.join(DATA, 'domains.json');

/**
 * How many tiles to decode.
 *
 * Enough features for the comparison to mean something, few enough to keep the suite quick — the
 * work is years x roles x features, so this is the term worth bounding.
 */
const TILE_BUDGET = 8;

const built =
  existsSync(MANIFEST) && JSON.parse(readFileSync(MANIFEST, 'utf8')).domains?.length > 0;

const entry: DomainManifestEntry | null = built
  ? ((JSON.parse(readFileSync(MANIFEST, 'utf8')) as DomainManifest).domains[0] ?? null)
  : null;

const archivePath = entry ? path.join(DATA, path.basename(entry.tiles.url)) : '';
const runnable = Boolean(entry) && existsSync(archivePath);

type Feature = { properties: Record<string, unknown> };

async function decode(domain: DomainManifestEntry): Promise<Feature[]> {
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

      const layer = new VectorTile(new PbfReader(new Uint8Array(tile.data))).layers[
        domain.tiles.sourceLayer
      ];
      if (!layer) continue;

      tiles += 1;
      for (let i = 0; i < layer.length; i += 1) {
        features.push({ properties: layer.feature(i).properties });
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

describe.skipIf(!runnable)('cohorts against the built tileset', () => {
  let features: Feature[] = [];

  beforeAll(async () => {
    features = await decode(entry!);
  }, 120_000);

  it('decodes real features to compare against', () => {
    expect(features.length).toBeGreaterThan(0);
  });

  it('never sees a feature that expires, which is what cohorts assume', () => {
    // A cohort switches on at its year and never switches off, so a feature carrying a `valid_to`
    // would keep drawing past its end. The pipeline emits `valid_to: null` for everything today and
    // tiling drops null attributes, so the key is absent. This is that precondition as a check
    // rather than a comment: if the pipeline ever starts emitting one, this fails loudly, which is
    // the signal that the cohort model needs revisiting rather than merely re-running.
    const expiring = features.filter((f) => f.properties.valid_to != null);

    expect(expiring).toHaveLength(0);
  });

  it('selects exactly what a live valid_from filter would, every year and every role', () => {
    const years: number[] = [];
    for (let y = entry!.temporal.start; y <= entry!.temporal.end; y += 1) years.push(y);

    for (const year of years) {
      // Both views, so the extent baseline and the cleared holes are covered too.
      const layers = [
        ...layersFor(entry!, year, 'change').layers,
        ...layersFor(entry!, year, 'extent').layers,
      ];

      const roles = new Set(
        layers.map((l) => l.id.replace(`trace-${entry!.id}-`, '').replace(/-\d{4}$/, '')),
      );

      for (const role of roles) {
        const mine = layers.filter(
          (l) => l.id.replace(/-\d{4}$/, '') === `trace-${entry!.id}-${role}`,
        );

        // What the cohorts actually put on screen: only those left at non-zero opacity. This is
        // driven by the build's own opacity assignment, so it exercises the gating, not just the
        // filter text.
        const shown = new Set<number>();
        for (const layer of mine) {
          const paint = layer.paint as Record<string, unknown>;
          const opacity = (
            layer.type === 'fill' ? paint['fill-opacity'] : paint['line-opacity']
          ) as number;
          if (opacity === 0) continue;
          for (const i of selects(layer.filter, features, layer.id)) shown.add(i);
        }

        // The reference: this role's own `change_type` test — unchanged by the cohort model, and
        // taken from the layer rather than restated here — composed with the plain time semantics
        // the cohorts replaced.
        const first = mine[0];
        expect(first).toBeDefined();
        const changeTypeTest = (first!.filter as unknown as unknown[])[2];
        const matchesType = selects(changeTypeTest, features, `${role}.change_type`);
        const expected = new Set(
          // Indices come from `features` itself, so the lookup cannot miss.
          [...matchesType].filter((i) => Number(features[i]!.properties.valid_from) <= year),
        );

        expect({ year, role, ids: [...shown].sort((a, b) => a - b) }).toEqual({
          year,
          role,
          ids: [...expected].sort((a, b) => a - b),
        });
      }
    }
  }, 120_000);
});
