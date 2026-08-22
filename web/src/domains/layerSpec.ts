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
 * The years a domain's layers are split across — one *cohort* per year of its coverage.
 *
 * Time is still a feature attribute: each cohort selects on `valid_from`, and the manifest's
 * range is what decides how many there are. What changed is that the selection is **fixed** at
 * build time rather than rewritten as the slider moves, which is what makes the animation free.
 * See `cohortFilter`.
 */
export function cohortYears(entry: DomainManifestEntry): number[] {
  const years: number[] = [];
  for (let year = entry.temporal.start; year <= entry.temporal.end; year += 1) years.push(year);
  return years;
}

/**
 * One cohort's share of a domain: the features that begin in that year, and nothing else.
 *
 * The first cohort takes everything from that year *back*, so a baseline laid down before the
 * slider's first year — forest's 2000 canopy under a range starting at 2001 — lands in it rather
 * than in no cohort at all.
 *
 * Every clause here is constant. That is the entire point: a filter that never changes is parsed
 * into its bucket once, and the year is then animated by opacity alone, which MapLibre applies
 * without re-parsing anything. Rewriting one live filter instead made every step re-tessellate
 * every feature from the start of the range to the current year — 2,656 of them at 2001 against
 * 91,088 at 2025, which is exactly why playback used to begin quickly and grind to a crawl.
 *
 * **Precondition: features are open-ended.** A cohort is switched on for every year at or after
 * its own and never switched off again, so a feature that *stops* being true — a non-null
 * `valid_to` — would keep drawing past its end. Every feature the pipeline emits today carries
 * `valid_to: null`, so this holds; a domain that starts emitting one needs this revisited rather
 * than merely re-run.
 */
function cohortFilter(
  entry: DomainManifestEntry,
  cohort: number,
  test: FilterSpecification,
): FilterSpecification {
  const begins: FilterSpecification =
    cohort === entry.temporal.start
      ? (['<=', ['get', 'valid_from'], cohort] as FilterSpecification)
      : (['==', ['get', 'valid_from'], cohort] as FilterSpecification);

  return ['all', begins, test] as FilterSpecification;
}

/** `change_type` tests, named because they are the difference between the two views. */
const IS_EXTENT: FilterSpecification = ['==', ['get', 'change_type'], 'extent'];
const IS_NOT_EXTENT: FilterSpecification = ['!=', ['get', 'change_type'], 'extent'];
const IS_LOSS: FilterSpecification = ['==', ['get', 'change_type'], 'loss'];

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

const cohortLayerId = (domainId: string, key: string, cohort: number) =>
  `trace-${domainId}-${key}-${cohort}`;

/**
 * The opacity channel a role is animated through, and the value it holds when shown.
 *
 * Read back off the role's own paint rather than listed separately, so a role that changes how
 * solid it draws cannot end up fading to a different value than it painted with. Roles must
 * therefore declare a plain number: an expression here would be data-driven, and a data-driven
 * paint property is exactly the thing that forces the reload this design exists to avoid.
 */
function opacityChannel(built: { type: 'fill' | 'line'; paint: Record<string, unknown> }): {
  key: string;
  shown: number;
} {
  const key = built.type === 'fill' ? 'fill-opacity' : 'line-opacity';
  const shown = built.paint[key];

  if (typeof shown !== 'number') {
    throw new Error(`Layer role paints ${key} with an expression; cohorts need a constant.`);
  }

  return { key, shown };
}

/**
 * All layer ids a domain owns, in draw order. Used for teardown.
 *
 * Both views' layers are built once and switched with `visibility` rather than added and removed,
 * so that flipping the toggle never refetches a tile.
 */
export function layerIdsFor(entry: DomainManifestEntry): string[] {
  return ROLES.flatMap((role) =>
    cohortYears(entry).map((cohort) => cohortLayerId(entry.id, role.key, cohort)),
  );
}

/** Which view each layer belongs to. Drives the visibility switch in `useDomainLayers`. */
export function layerIdsForMode(entry: DomainManifestEntry, mode: ViewMode): string[] {
  return ROLES.filter((role) => role.mode === mode).flatMap((role) =>
    cohortYears(entry).map((cohort) => cohortLayerId(entry.id, role.key, cohort)),
  );
}

/**
 * The layers actually showing something at a given year — the ones a click may land on.
 *
 * Hit-testing has to ask for these by name rather than for everything the domain owns. A cohort
 * from a later year is still *there*, drawn at zero opacity, and `queryRenderedFeatures` reads
 * geometry rather than paint: querying the lot would let the reader click a patch of loss that
 * has not happened yet and open a readout describing it.
 */
export function layerIdsForYear(entry: DomainManifestEntry, year: number): string[] {
  return ROLES.flatMap((role) =>
    cohortYears(entry)
      .filter((cohort) => cohort <= year)
      .map((cohort) => cohortLayerId(entry.id, role.key, cohort)),
  );
}

/**
 * Every cohort's opacity for a given year, keyed by layer id and paint property.
 *
 * This is the animation. Each entry is a *constant* paint value, which MapLibre applies without
 * touching tile data at all — no filter change, no source reload, no re-tessellation. Cohorts up
 * to the year draw at their role's own opacity; the rest sit at zero.
 */
export function opacityUpdatesFor(
  entry: DomainManifestEntry,
  year: number,
): [string, string, number][] {
  return ROLES.flatMap((role) => {
    const { key, shown } = opacityChannel(role.paint(entry));

    return cohortYears(entry).map(
      (cohort) =>
        [cohortLayerId(entry.id, role.key, cohort), key, cohort <= year ? shown : 0] as [
          string,
          string,
          number,
        ],
    );
  });
}

export interface DomainLayers {
  sourceId: string;
  source: { type: 'vector'; url: string; attribution: string };
  layers: (FillLayerSpecification | LineLayerSpecification)[];
}

export function layersFor(entry: DomainManifestEntry, year: number, mode: ViewMode): DomainLayers {
  const source = sourceId(entry.id);

  // Built by walking the same table that produces the ids, the opacities and the visibility sets,
  // in the same order. There is no second list to fall out of step with.
  //
  // Roles are the outer loop and cohorts the inner one, which keeps `ROLES` order — and with it
  // the rule that cleared patches are painted over the extent they cut holes in. Interleaving the
  // two would scatter each role's cohorts through the draw order and lose that.
  const layers = ROLES.flatMap((role) => {
    const built = role.paint(entry);
    const { key, shown } = opacityChannel(built);

    return cohortYears(entry).map(
      (cohort) =>
        ({
          id: cohortLayerId(entry.id, role.key, cohort),
          type: built.type,
          source,
          'source-layer': entry.tiles.sourceLayer,
          filter: cohortFilter(entry, cohort, role.test),
          layout: { visibility: role.mode === mode ? 'visible' : 'none' },
          paint: {
            ...built.paint,
            [key]: cohort <= year ? shown : 0,
            // A cohort appears the instant its year arrives. The default 300ms fade would still be
            // running two years later at playback speed, leaving the map showing a half-drawn year
            // while the readout named it outright.
            [`${key}-transition`]: { duration: 0, delay: 0 },
          },
        }) as unknown as FillLayerSpecification | LineLayerSpecification,
    );
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
