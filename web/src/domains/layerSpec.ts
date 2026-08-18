/**
 * Turns a manifest entry into MapLibre layers.
 *
 * This is the only file that knows how a domain becomes pixels, and it knows nothing about *which*
 * domains exist — everything comes from the entry it is handed. Adding a domain adds a manifest
 * record and nothing else.
 *
 * Colour never appears here as a literal. `styleFor` is the single authority (A2), and because it
 * returns the accessible pattern with the colour, the hatch that keeps loss from being
 * colour-alone (A5) comes along automatically rather than by remembering to add it.
 */

import type {
  FillLayerSpecification,
  FilterSpecification,
  LineLayerSpecification,
} from 'maplibre-gl';

import { CLEARED, styleFor } from '@/domains/colors';
import type { DomainManifestEntry, ViewMode } from '@/domains/manifest';
import type { ChangeType } from '@/types/feature';

const CHANGE_TYPES: ChangeType[] = ['extent', 'loss', 'gain', 'stable'];

/** Image id for the diagonal hatch registered on the map. */
export const HATCH_IMAGE = 'trace-hatch';

/**
 * The zoom at which a patch stops being sub-pixel and the fill can be seen.
 *
 * Measured, not guessed: decoding the built tiles, a median forest-loss ring is 2 tile units
 * across at z8 (a quarter of a CSS pixel) and 9 at z10; by z12 it is comfortably several pixels.
 * Below this the outline stands in for the patch — see the `outline` layer.
 */
const SCALE_SPLIT_ZOOM = 11;

export const sourceId = (domainId: string) => `trace-${domainId}`;

/**
 * A `match` over `change_type`, evaluated by calling `styleFor` for each case.
 *
 * Building the expression from the function — rather than restating its output — is what stops
 * the map's colours and the app's colour rule from drifting apart.
 */
function styleExpression(entry: DomainManifestEntry, channel: 'color' | 'stroke') {
  return [
    'match',
    ['get', 'change_type'],
    ...CHANGE_TYPES.flatMap((changeType) => [changeType, styleFor(entry.hue, changeType)[channel]]),
    styleFor(entry.hue, 'stable')[channel],
  ];
}

/**
 * The time filter.
 *
 * `valid_from <= year` is the whole animation: one tileset per domain, filtered on the GPU, so
 * scrubbing never reloads a tile.
 *
 * The `valid_to` half has to tolerate the key being **absent**. Tiling drops null attributes, so a
 * feature whose state has not ended carries no `valid_to` at all — testing it directly would hide
 * every open-ended feature, which for forest loss is all of them.
 */
export function timeFilter(year: number): FilterSpecification {
  return [
    'all',
    ['<=', ['get', 'valid_from'], year],
    ['any', ['!', ['has', 'valid_to']], ['>=', ['get', 'valid_to'], year]],
  ] as FilterSpecification;
}

/** `change_type` tests, named because they are the difference between the two views. */
const IS_EXTENT: FilterSpecification = ['==', ['get', 'change_type'], 'extent'];
const IS_NOT_EXTENT: FilterSpecification = ['!=', ['get', 'change_type'], 'extent'];
const IS_LOSS: FilterSpecification = ['==', ['get', 'change_type'], 'loss'];

/**
 * Combine the year filter with a `change_type` test.
 *
 * `timeFilter` is already an `all`, so its clauses are spread rather than nested — otherwise every
 * layer would carry a pointless `["all", ["all", …], …]`.
 */
function withTime(year: number, test: FilterSpecification): FilterSpecification {
  const [, ...timeClauses] = timeFilter(year) as unknown as FilterSpecification[];
  return ['all', ...timeClauses, test] as FilterSpecification;
}

/**
 * The width ramp that keeps a sub-pixel patch visible.
 *
 * Shared by every line layer here because the problem is shared: below `SCALE_SPLIT_ZOOM` the
 * patches are smaller than a pixel, whether they are being drawn as loss or subtracted from an
 * extent, and a fill cannot render either. See `ROLES.outline` for the full reasoning.
 */
const MARK_WIDTH = [
  'interpolate',
  ['linear'],
  ['zoom'],
  5,
  1.2,
  9,
  1.6,
  12,
  0.8,
  15,
  1.2,
] as unknown as number;

/**
 * Every layer a domain owns, declared once.
 *
 * This table is the single source for all four things the app needs to know about a layer: its
 * id, which view shows it, what it filters on, and how it paints. They used to be four
 * hand-maintained lists, and only one pairing of them was defended — forgetting a layer in the
 * visibility list produced a layer that was built and filtered correctly but never shown, with
 * nothing to say so. Deriving all four from one table makes that inconsistency unrepresentable.
 *
 * Array order is draw order, and it is load-bearing: the cleared patches are painted *over* the
 * extent to cut holes in it, so they must follow it.
 */
const ROLES = [
  {
    key: 'extent-fill',
    mode: 'extent',
    test: IS_EXTENT,
    // The baseline mass the holes are cut from. More opaque than the change view's fill, which
    // is an accumulation rather than a ground state.
    paint: (entry: DomainManifestEntry) => ({
      type: 'fill' as const,
      paint: {
        'fill-color': styleFor(entry.hue, 'extent').color,
        'fill-opacity': 0.85,
      },
    }),
  },
  {
    key: 'extent-outline',
    mode: 'extent',
    test: IS_EXTENT,
    // Same two jobs as `outline`: the mark itself while the blocks are sub-pixel, an edge once
    // they are not. Without the step the outline would be the fill's own colour at high zoom and
    // adjacent blocks would be indistinguishable — including the ones the extraction grid split.
    paint: (entry: DomainManifestEntry) => ({
      type: 'line' as const,
      paint: {
        'line-color': [
          'step',
          ['zoom'],
          styleFor(entry.hue, 'extent').color,
          SCALE_SPLIT_ZOOM,
          styleFor(entry.hue, 'extent').stroke,
        ] as unknown as string,
        'line-width': MARK_WIDTH,
        'line-opacity': 0.85,
      },
    }),
  },
  {
    key: 'cleared-fill',
    mode: 'extent',
    test: IS_LOSS,
    // Opaque on purpose: this is subtraction done with paint, because MapLibre fills cannot
    // subtract. See CLEARED for why it is the colour it is.
    paint: () => ({
      type: 'fill' as const,
      paint: { 'fill-color': CLEARED, 'fill-opacity': 1 },
    }),
  },
  {
    key: 'cleared-outline',
    mode: 'extent',
    test: IS_LOSS,
    // Without this the extent view would look static at island view: the holes are the same
    // sub-pixel patches as the loss layer, so at z8 a fill alone cuts nothing visible and the
    // green mass would appear not to change as the years pass.
    paint: () => ({
      type: 'line' as const,
      paint: { 'line-color': CLEARED, 'line-width': MARK_WIDTH, 'line-opacity': 1 },
    }),
  },
  {
    key: 'fill',
    mode: 'change',
    test: IS_NOT_EXTENT,
    paint: (entry: DomainManifestEntry) => ({
      type: 'fill' as const,
      paint: {
        'fill-color': styleExpression(entry, 'color') as unknown as string,
        // Kept below 1 so overlapping years read as accumulation rather than a flat mass.
        'fill-opacity': 0.75,
      },
    }),
  },
  {
    key: 'hatch',
    mode: 'change',
    test: IS_LOSS,
    // A second fill carrying only the pattern. fill-pattern would replace fill-color on a single
    // layer, and the rule is that loss is signalled by colour *and* texture, never either alone.
    paint: () => ({
      type: 'fill' as const,
      paint: { 'fill-pattern': HATCH_IMAGE, 'fill-opacity': 0.9 },
    }),
  },
  {
    key: 'outline',
    mode: 'change',
    test: IS_NOT_EXTENT,
    paint: (entry: DomainManifestEntry) => ({
      type: 'line' as const,
      paint: {
        // Two jobs, split at the zoom where the fill becomes legible.
        //
        // A 30 m patch is *sub-pixel* below about z11 — at z8 a typical one is a quarter of a
        // pixel across, and 17% of them collapse to zero area when quantised onto the tile grid.
        // A fill cannot draw that, so below the split this line *is* the mark and carries the
        // fill colour. Above it, the fill takes over and the line goes back to being an edge.
        'line-color': [
          'step',
          ['zoom'],
          styleExpression(entry, 'color'),
          SCALE_SPLIT_ZOOM,
          styleExpression(entry, 'stroke'),
        ] as unknown as string,
        // Wide enough to see at island view, then hairline once the fill is doing the work.
        //
        // This deliberately overstates area at low zoom: a mark you can see is bigger than the
        // ground it stands for. That is a legibility floor, not a measurement — the honest
        // alternative is not a truer dot, it is a blank map, which reads as "no loss here". Areas
        // are only ever quoted from the feature's own `metric`, never inferred from mark size.
        'line-width': MARK_WIDTH,
        'line-opacity': 0.85,
      },
    }),
  },
] as const;

const roleLayerId = (domainId: string, key: string) => `trace-${domainId}-${key}`;

/**
 * All layer ids a domain owns, in draw order. Used for teardown and hit-testing.
 *
 * Both views' layers are built once and switched with `visibility` rather than added and removed,
 * so that flipping the toggle never refetches a tile.
 */
export function layerIdsFor(domainId: string): string[] {
  return ROLES.map((role) => roleLayerId(domainId, role.key));
}

/** Which view each layer belongs to. Drives the visibility switch in `useDomainLayers`. */
export function layerIdsForMode(domainId: string, mode: ViewMode): string[] {
  return ROLES.filter((role) => role.mode === mode).map((role) => roleLayerId(domainId, role.key));
}

/**
 * Every layer's filter for a given year, keyed by layer id.
 *
 * The single source for both jobs that need them: building the layers, and re-filtering live ones
 * when the slider moves. They used to be written out in both places, in different files, which
 * meant the year effect silently dropped the `change_type` half of each filter — the layers were
 * correct until the first scrub, and then quietly wrong.
 */
export function filtersFor(domainId: string, year: number): [string, FilterSpecification][] {
  return ROLES.map((role) => [roleLayerId(domainId, role.key), withTime(year, role.test)]);
}

export interface DomainLayers {
  sourceId: string;
  source: { type: 'vector'; url: string; attribution: string };
  layers: (FillLayerSpecification | LineLayerSpecification)[];
}

export function layersFor(entry: DomainManifestEntry, year: number, mode: ViewMode): DomainLayers {
  const source = sourceId(entry.id);

  // Built by walking the same table that produces the ids, the filters and the visibility sets,
  // in the same order. There is no second list to fall out of step with.
  const layers = ROLES.map((role) => {
    const { type, paint } = role.paint(entry);
    return {
      id: roleLayerId(entry.id, role.key),
      type,
      source,
      'source-layer': entry.tiles.sourceLayer,
      filter: withTime(year, role.test),
      layout: { visibility: role.mode === mode ? 'visible' : 'none' },
      paint,
    } as FillLayerSpecification | LineLayerSpecification;
  });

  return {
    sourceId: source,
    source: { type: 'vector', url: entry.tiles.url, attribution: entry.source.attribution },
    layers,
  };
}

/**
 * A 45° hatch, drawn once and registered as a map image.
 *
 * Transparent between the strokes so the fill colour beneath still shows: the texture is an
 * *addition* to the colour signal, not a replacement for it.
 */
export function createHatchImage(size = 8): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('2D canvas context unavailable — cannot build the hatch pattern');

  context.clearRect(0, 0, size, size);
  context.strokeStyle = 'rgba(255,255,255,0.55)';
  context.lineWidth = 1.1;
  context.beginPath();
  // Two strokes, offset by the tile size, so the diagonal is continuous when the pattern repeats.
  context.moveTo(-size / 2, size / 2);
  context.lineTo(size / 2, -size / 2);
  context.moveTo(size / 2, size * 1.5);
  context.lineTo(size * 1.5, size / 2);
  context.moveTo(0, size);
  context.lineTo(size, 0);
  context.stroke();

  return context.getImageData(0, 0, size, size);
}
