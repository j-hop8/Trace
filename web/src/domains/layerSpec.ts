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

import { styleFor } from '@/domains/colors';
import type { DomainManifestEntry } from '@/domains/manifest';
import type { ChangeType } from '@/types/feature';

const CHANGE_TYPES: ChangeType[] = ['loss', 'gain', 'stable'];

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
export const fillLayerId = (domainId: string) => `trace-${domainId}-fill`;
export const hatchLayerId = (domainId: string) => `trace-${domainId}-hatch`;
export const outlineLayerId = (domainId: string) => `trace-${domainId}-outline`;

/** All layer ids a domain owns, in draw order. Used for teardown and hit-testing. */
export function layerIdsFor(domainId: string): string[] {
  return [fillLayerId(domainId), hatchLayerId(domainId), outlineLayerId(domainId)];
}

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

export interface DomainLayers {
  sourceId: string;
  source: { type: 'vector'; url: string; attribution: string };
  layers: (FillLayerSpecification | LineLayerSpecification)[];
}

export function layersFor(entry: DomainManifestEntry, year: number): DomainLayers {
  const source = sourceId(entry.id);
  const sourceLayer = entry.tiles.sourceLayer;
  const filter = timeFilter(year);

  const fill: FillLayerSpecification = {
    id: fillLayerId(entry.id),
    type: 'fill',
    source,
    'source-layer': sourceLayer,
    filter,
    paint: {
      'fill-color': styleExpression(entry, 'color') as unknown as string,
      // Kept below 1 so overlapping years read as accumulation rather than a flat mass.
      'fill-opacity': 0.75,
    },
  };

  // A second fill carrying only the pattern. fill-pattern would replace fill-color on a single
  // layer, and the rule is that loss is signalled by colour *and* texture, never either alone.
  const hatch: FillLayerSpecification = {
    id: hatchLayerId(entry.id),
    type: 'fill',
    source,
    'source-layer': sourceLayer,
    filter: ['all', filter, ['==', ['get', 'change_type'], 'loss']] as FilterSpecification,
    paint: { 'fill-pattern': HATCH_IMAGE, 'fill-opacity': 0.9 },
  };

  const outline: LineLayerSpecification = {
    id: outlineLayerId(entry.id),
    type: 'line',
    source,
    'source-layer': sourceLayer,
    filter,
    paint: {
      // Two jobs, split at the zoom where the fill becomes legible.
      //
      // A 30 m patch is *sub-pixel* below about z11 — at z8 a typical one is a quarter of a
      // pixel across, and 17% of them collapse to zero area when quantised onto the tile grid.
      // A fill cannot draw that, so below the split this line *is* the mark and carries the fill
      // colour. Above it, the fill takes over and the line goes back to being an edge.
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
      'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.2, 9, 1.6, 12, 0.8, 15, 1.2],
      'line-opacity': 0.85,
    },
  };

  return {
    sourceId: source,
    source: { type: 'vector', url: entry.tiles.url, attribution: entry.source.attribution },
    layers: [fill, hatch, outline],
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
