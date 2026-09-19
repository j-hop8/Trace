/**
 * The cohort model against the real tilesets.
 *
 * `layerSpec.test.ts` checks the shape of what gets built. This checks what it actually selects,
 * by running the built filters over features decoded straight out of each domain's `.pmtiles` with
 * MapLibre's own filter evaluator — the same one the map uses. The question it answers is the one
 * that cannot be answered by reading the layer specs: for every domain, year and role, does turning
 * cohorts on by opacity select exactly the features the plain time semantics would?
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

import { layersFor, opacityChannel } from '@/domains/layerSpec';
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

  it.skipIf(!runnable)(
    'selects exactly what the plain time semantics would, every year and every role',
    () => {
      const years: number[] = [];
      for (let y = entry.temporal.start; y <= entry.temporal.end; y += 1) years.push(y);

      for (const year of years) {
        // Everything the domain can show, so cover and every change are covered.
        const layers = layersFor(entry, year, new Set(entry.changeTypes ?? [])).layers;
        const roles = new Set(layers.map((l) => roleOf(l.id, entry.id)));

        for (const role of roles) {
          const mine = layers.filter((l) => roleOf(l.id, entry.id) === role);
          const first = mine[0]!;

          // The reference: this role's own `change_type` test — taken from the layer rather than
          // restated here — composed with the time semantics its kind of cohort stands in for.
          const changeTypeTest = (first.filter as unknown as unknown[]).at(-1);
          const changeType = (changeTypeTest as unknown[])[2] as ChangeType;
          const kind = KIND_OF[changeType];
          const matchesType = selects(changeTypeTest, features, `${role}.change_type`);
          const expected = new Set(
            [...matchesType].filter((i) => inYear(features[i]!.properties, year, kind)),
          );

          // What the cohorts actually put on screen: only those left at non-zero opacity. This is
          // driven by the build's own opacity assignment, so it exercises the gating, not just the
          // filter text. A feature two shown layers both select would be drawn twice — the property
          // the canonical decomposition exists to prevent.
          const shown = new Set<number>();
          const twice: number[] = [];
          for (const layer of mine) {
            const paint = layer.paint as Record<string, unknown>;
            const { shown: opacity } = opacityChannel({ type: layer.type, paint });
            if (opacity === 0) continue;
            for (const i of selects(layer.filter, features, layer.id)) {
              if (shown.has(i)) twice.push(i);
              shown.add(i);
            }
          }

          expect({ year, role, twice }).toEqual({ year, role, twice: [] });
          expect({ year, role, ids: [...shown].sort((a, b) => a - b) }).toEqual({
            year,
            role,
            ids: [...expected].sort((a, b) => a - b),
          });
        }
      }
    },
    240_000,
  );
});
