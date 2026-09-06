/**
 * The cohort model against the real tileset.
 *
 * `layerSpec.test.ts` checks the shape of what gets built. This checks what it actually selects,
 * by running the built filters over features decoded straight out of `data/forest.pmtiles` with
 * MapLibre's own filter evaluator — the same one the map uses. The question it answers is the one
 * that cannot be answered by reading the layer specs: for every year, does turning cohorts on by
 * opacity select exactly the features a `valid_from <= year` filter would have selected?
 *
 * Every domain the manifest lists and the pipeline has actually built, not just the first one:
 * water is the domain whose loss features *end*, and running this against forest alone is how a
 * cohort model that mis-dates every closed-ended feature passed a green suite.
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

import { layersFor, opacityChannel } from '@/domains/layerSpec';
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

const archiveFor = (domain: DomainManifestEntry) =>
  path.join(DATA, path.basename(domain.tiles.url));

const declared: DomainManifestEntry[] = existsSync(MANIFEST)
  ? ((JSON.parse(readFileSync(MANIFEST, 'utf8')) as DomainManifest).domains ?? [])
  : [];

/** The domains that are both in the manifest and actually built. */
const entries = declared.filter((domain) => existsSync(archiveFor(domain)));
const runnable = entries.length > 0;

type Feature = { properties: Record<string, unknown> };

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
  const decoded = new Map<string, Feature[]>();

  beforeAll(async () => {
    for (const domain of entries) decoded.set(domain.id, await decode(domain));
  }, 240_000);

  it('decodes real features to compare against', () => {
    for (const domain of entries) {
      expect({ domain: domain.id, some: decoded.get(domain.id)!.length > 0 }).toEqual({
        domain: domain.id,
        some: true,
      });
    }
  });

  it('agrees with the pipeline about which features end', () => {
    // Tippecanoe omits null properties rather than encoding them, so an open-ended feature has no
    // `valid_to` key at all. That is what `MARK_YEAR` tests with `has`, and it is a fact about the
    // tiler rather than something the schema promises — so it is checked rather than assumed. A
    // present-but-null `valid_to` would send the mark year through `+` and take the layer down.
    for (const domain of entries) {
      const nulls = decoded
        .get(domain.id)!
        .filter((f) => 'valid_to' in f.properties && f.properties.valid_to == null);

      expect({ domain: domain.id, presentButNull: nulls.length }).toEqual({
        domain: domain.id,
        presentButNull: 0,
      });
    }
  });

  it('never draws a closed-ended feature before its change is observed', () => {
    // The bug this model had against water: 15,170 of 30,606 features carry a `valid_to`, and
    // keyed on `valid_from` every one of them was painted loss red from the year the pond
    // appeared — up to thirty-three years before it dried up.
    const closed = entries.flatMap((domain) =>
      decoded
        .get(domain.id)!
        .filter((f) => f.properties.valid_to != null)
        .filter((f) => Number(f.properties.valid_to) > Number(f.properties.valid_from))
        .slice(0, 25)
        .map((feature) => ({ domain, feature })),
    );

    for (const { domain, feature } of closed) {
      const first = Number(feature.properties.valid_from);
      const mark = Number(feature.properties.valid_to) + 1;

      const drawnAt = (year: number) =>
        [...layersFor(domain, year, 'change').layers, ...layersFor(domain, year, 'extent').layers]
          .filter((layer) => {
            const paint = layer.paint as Record<string, unknown>;
            return opacityChannel({ type: layer.type, paint }).shown > 0;
          })
          .filter((layer) => selects(layer.filter, [feature], layer.id).size > 0).length;

      expect({
        id: `${domain.id} ${first}-${feature.properties.valid_to}`,
        atFirst: drawnAt(first),
      }).toEqual({
        id: `${domain.id} ${first}-${feature.properties.valid_to}`,
        atFirst: 0,
      });
      expect({
        id: `${domain.id} ${first}-${feature.properties.valid_to}`,
        atMark: drawnAt(Math.min(mark, domain.temporal.end)) > 0,
      }).toEqual({ id: `${domain.id} ${first}-${feature.properties.valid_to}`, atMark: true });
    }
  });

  it('selects exactly what the mark year says it should, every year and every role', () => {
    for (const domain of entries) {
      const features = decoded.get(domain.id)!;
      const years: number[] = [];
      for (let y = domain.temporal.start; y <= domain.temporal.end; y += 1) years.push(y);

      // The reference semantics, written out independently of the expression under test: a
      // feature that ends is dated by its end, one that runs open by its start, and either is
      // clamped into the manifest's range so a mark outside it lands on the nearest cohort
      // rather than in none.
      const markYear = (f: Feature) => {
        const raw =
          f.properties.valid_to != null
            ? Number(f.properties.valid_to) + 1
            : Number(f.properties.valid_from);
        return Math.min(Math.max(raw, domain.temporal.start), domain.temporal.end);
      };

      for (const year of years) {
        // Both views, so the extent baseline and the cleared holes are covered too.
        const layers = [
          ...layersFor(domain, year, 'change').layers,
          ...layersFor(domain, year, 'extent').layers,
        ];

        const roles = new Set(
          layers.map((l) => l.id.replace(`trace-${domain.id}-`, '').replace(/-\d{4}$/, '')),
        );

        for (const role of roles) {
          const mine = layers.filter(
            (l) => l.id.replace(/-\d{4}$/, '') === `trace-${domain.id}-${role}`,
          );

          // What the cohorts actually put on screen: only those left at non-zero opacity. This is
          // driven by the build's own opacity assignment, so it exercises the gating, not just the
          // filter text.
          const shown = new Set<number>();
          for (const layer of mine) {
            const paint = layer.paint as Record<string, unknown>;
            const { shown: opacity } = opacityChannel({ type: layer.type, paint });
            if (opacity === 0) continue;
            for (const i of selects(layer.filter, features, layer.id)) shown.add(i);
          }

          // The reference: this role's own `change_type` test — unchanged by the cohort model, and
          // taken from the layer rather than restated here — composed with the mark-year semantics
          // above.
          const first = mine[0];
          expect(first).toBeDefined();
          const changeTypeTest = (first!.filter as unknown as unknown[])[2];
          const matchesType = selects(changeTypeTest, features, `${role}.change_type`);
          const expected = new Set(
            // Indices come from `features` itself, so the lookup cannot miss.
            [...matchesType].filter((i) => markYear(features[i]!) <= year),
          );

          expect({ domain: domain.id, year, role, ids: [...shown].sort((a, b) => a - b) }).toEqual({
            domain: domain.id,
            year,
            role,
            ids: [...expected].sort((a, b) => a - b),
          });
        }
      }
    }
  }, 240_000);
});
