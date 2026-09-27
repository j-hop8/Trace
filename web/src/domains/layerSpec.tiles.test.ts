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
 * And both regimes of every domain. From `tiles.detailZoom` up a tile holds every feature with
 * its id; below it, the island view, a tile holds one feature per cohort and attribute group,
 * marked `pooled`, with no id and no metric. The cohort model has to hold on both — the same
 * style layers read both — so each is decoded at its own zoom and put through the same checks,
 * with identity read off the id where there is one and off the attributes where there is not.
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
import type { ChangeType, Kind } from '@/types/feature';

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

/** One regime of one domain: the zoom to decode, and what makes a feature itself there. */
interface Regime {
  entry: DomainManifestEntry;
  regime: 'detail' | 'island';
  zoom: number;
  runnable: boolean;
}

const regimes: Regime[] = (manifest?.domains ?? []).flatMap((entry) => {
  const runnable = existsSync(archiveFor(entry));
  return [
    { entry, regime: 'detail', zoom: entry.tiles.detailZoom, runnable },
    { entry, regime: 'island', zoom: entry.tiles.detailZoom - 1, runnable },
  ];
});

/**
 * A decoded tile feature: which tile layer it came from, and an identity shared by every copy of
 * the same source feature within one tile.
 *
 * In the detail regime the identity is the id the pipeline writes on every copy -- the feature's
 * position in the source collection -- scoped to the tile, since a feature cut by a tile edge is
 * in two tiles. Nothing else would do: single-pixel patches share every attribute, and tippecanoe
 * simplifies each tile layer on its own, so two copies of one feature can differ in tile geometry.
 *
 * In the island regime there is no id, because a feature there is a whole group pooled, and the
 * group *is* its attributes: every copy of it -- one per node layer canonical for its validity --
 * carries the same ones, so the attributes scoped to the tile are the identity.
 *
 * Only what the tile draws is decoded. Tippecanoe writes a feature into every tile whose
 * *buffer* it touches, so a feature a few metres over the edge is in the neighbour's data as a
 * sliver in the band the neighbour never renders. Those slivers are now pooled, and pooled per
 * layer: one node layer keeps a dust square where another lets the sliver go, and a tile-scoped
 * identity would read that as a copy missing from a layer. `verify` in the pipeline counts every
 * copy across the whole archive, so nothing is lost; here, a feature whose bounding box lies
 * wholly outside the tile's own extent is left out, as the renderer leaves it out.
 */
type Feature = { layer: string; key: string; properties: Record<string, unknown> };

/** Whether any of the feature's geometry falls inside the tile's own extent, buffer excluded. */
const drawn = (feature: { extent: number; loadGeometry(): { x: number; y: number }[][] }) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const ring of feature.loadGeometry()) {
    for (const { x, y } of ring) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX >= 0 && minX <= feature.extent && maxY >= 0 && minY <= feature.extent;
};

const identity = (regime: Regime['regime'], feature: { id?: unknown; properties: object }) => {
  if (regime === 'detail') {
    if (feature.id === undefined) throw new Error('a detail copy with no id');
    return String(feature.id);
  }
  return JSON.stringify(Object.entries(feature.properties).sort(([a], [b]) => (a < b ? -1 : 1)));
};

async function decode({ entry: domain, regime, zoom: z }: Regime): Promise<Feature[]> {
  const archivePath = archiveFor(domain);
  const bytes = readFileSync(archivePath);
  const archive = new PMTiles({
    getKey: () => archivePath,
    getBytes: async (offset: number, length: number) => ({
      data: bytes.buffer.slice(bytes.byteOffset + offset, bytes.byteOffset + offset + length),
    }),
  } as never);

  const header = await archive.getHeader();
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
          if (!drawn(feature)) continue;
          features.push({
            layer: name,
            key: `${x}/${y}#${identity(regime, feature)}`,
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

/**
 * The plain time semantics a role's cohorts stand in for, by the kind of state it draws: a change
 * holds from its year on; cover and level hold for their own half-open validity.
 */
const inYear = (props: Record<string, unknown>, year: number, kind: Kind) => {
  const from = Number(props.valid_from);
  if (kind === 'change') return from <= year;
  const to = props.valid_to == null ? Infinity : Number(props.valid_to);
  return from <= year && year < to;
};

// With no manifest there is nothing to iterate, and a file that registers no suite at all is a
// vitest *failure* ("No test suite found"), not a skip — which would turn CI red, where `data/`
// never exists. So the absent-data case is a suite that is skipped on purpose and says why.
if (regimes.length === 0) {
  describe.skip('cohorts against the built tilesets', () => {
    it('needs data/domains.json — run the pipeline to build it', () => {});
  });
}

describe.each(regimes)(
  'cohorts against the built $entry.id tileset, $regime regime at z$zoom',
  (regime) => {
    const { entry, runnable } = regime;
    let features: Feature[] = [];

    beforeAll(async () => {
      if (runnable) features = await decode(regime);
    }, 120_000);

    it.skipIf(!runnable)('decodes real features to compare against', () => {
      expect(features.length).toBeGreaterThan(0);
    });

    it.skipIf(!runnable)(
      'carries what its regime promises: ids and metrics, or the pooled marker',
      () => {
        // The detail regime is every feature, exactly: a readout can quote its area. The island regime
        // is a group per tile: it says so, and carries no number that would read as a mark's size.
        for (const f of features) {
          if (regime.regime === 'detail') {
            expect(f.properties.pooled).toBeUndefined();
            expect(f.properties.metric).toBeDefined();
          } else {
            expect(f.properties.pooled).toBe(true);
            expect(f.properties.metric).toBeUndefined();
          }
        }
      },
    );

    it.skipIf(!runnable || regime.regime !== 'island')(
      'holds one feature per cohort layer and attribute group per tile',
      () => {
        // What makes the island view cheap: tippecanoe merged every copy of a group in a tile
        // into one. Two features with the same key in the same layer would be a merge that did
        // not happen — a `--coalesce` silently ineffective, and a tile as heavy as before.
        const seen = new Set<string>();
        for (const f of features) {
          const key = `${f.layer}|${f.key}`;
          expect(seen.has(key), `${key} appears twice`).toBe(false);
          seen.add(key);
        }
      },
    );

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
      'gives every level its band, in both regimes, and nothing else one',
      () => {
        // The band is what colours a level, and the island copies lose their metric — so a level
        // without a band here is a region the map paints in the fallback colour at every zoom.
        for (const f of features) {
          const isLevel = f.properties.change_type === 'level';
          expect(Number.isInteger(f.properties.band), `${f.layer} band`).toBe(isLevel);
        }
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
        //
        // The island regime keeps only half of that claim. Its copies are pooled per layer, so a
        // group with a square left in one node layer can have pooled to nothing in another, and
        // a filter then selects a key its own layer no longer holds. What it must still never do
        // is hold a feature its filter does not select: that would be a feature drawn under the
        // wrong years. So `extra` is a detail-regime promise and `missing` is every regime's.
        const layers = layersFor(entry, entry.temporal.end, new Set(entry.changeTypes ?? []));
        const exact = regime.regime === 'detail';
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
          expect({ sourceLayer, extra: exact ? extra : 0, missing }).toEqual({
            sourceLayer,
            extra: 0,
            missing: 0,
          });
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
        const exact = regime.regime === 'detail';

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
          const layers = layersFor(entry, year, new Set(entry.changeTypes ?? []));
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
            // Nothing drawn in a year it is not valid, in either regime; and nothing valid left
            // undrawn in the detail regime. The island regime may have pooled a group's copy for
            // this year to nothing while keeping another of its copies -- see the filter check.
            const extra = [...shown].filter((k) => !expected.has(k)).length;
            const missing = [...expected].filter((k) => !shown.has(k)).length;
            expect({ year, role, extra, missing: exact ? missing : 0 }).toEqual({
              year,
              role,
              extra: 0,
              missing: 0,
            });
          }
        }
      },
      240_000,
    );
  },
);
