/**
 * Turns a manifest entry into MapLibre layers.
 *
 * This is the only file that knows how a domain becomes pixels, and it knows nothing about *which*
 * domains exist — everything comes from the entry it is handed, including which layers to build at
 * all. Adding a domain adds a manifest record and nothing else.
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
import type { DomainManifestEntry } from '@/domains/manifest';
import { CHANGE_TYPE_ORDER } from '@/types/feature';
import type { ChangeType } from '@/types/feature';

/** Image id for the diagonal hatch registered on the map. */
export const HATCH_IMAGE = 'trace-hatch';

/**
 * The zoom at which a patch stops being sub-pixel and the fill can be seen.
 *
 * Measured, not guessed: decoding the built tiles, a median forest-loss ring is 2 tile units
 * across at z8 (a quarter of a CSS pixel) and 9 at z10; by z12 it is comfortably several pixels.
 * Below this the outline stands in for the patch — see the `outline` role, and `FeatureStyle.mark`.
 */
const SCALE_SPLIT_ZOOM = 11;

export const sourceId = (domainId: string) => `trace-${domainId}`;

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
 * `valid_to` — keeps drawing past its end. Forest holds to this. Water does **not**: JRC's `lost *`
 * and `ephemeral *` transition classes carry a real `valid_to`, and roughly 42k water features are
 * therefore drawn for years in which they no longer existed. Tracked as T-024; the fix is a second
 * cohort axis, which is a change to this function and not to any caller of it.
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

/** Selects exactly one change type. Every role filters on one of these. */
const isType = (changeType: ChangeType): FilterSpecification =>
  ['==', ['get', 'change_type'], changeType] as FilterSpecification;

/**
 * The width ramp that keeps a sub-pixel patch visible.
 *
 * Shared by every line layer here because the problem is shared: below `SCALE_SPLIT_ZOOM` the
 * patches are smaller than a pixel, whether they are being drawn as loss or subtracted from an
 * extent, and a fill cannot render either. See `outlineRole` for the full reasoning.
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

/** What a role's `paint(entry)` returns: enough to derive its opacity channel and draw it. */
type BuiltRole = { type: 'fill' | 'line'; paint: Record<string, unknown> };

/**
 * One layer a domain owns, before it is split into cohorts.
 *
 * `changeType` is which *toggle* shows this layer, which is not always the change type it filters
 * on — the cleared patches filter on `loss` but are shown by the extent toggle. See `rolesFor`.
 */
interface Role {
  key: string;
  changeType: ChangeType;
  test: FilterSpecification;
  paint: (entry: DomainManifestEntry) => BuiltRole;
}

/**
 * The line that carries a state, at both of the two jobs it has.
 *
 * A 30 m patch is *sub-pixel* below about z11 — at z8 a typical one is a quarter of a pixel across,
 * and 17% of them collapse to zero area when quantised onto the tile grid. A fill cannot draw that,
 * so below the split this line *is* the mark and takes `style.mark`. Above it the fill takes over
 * and the line goes back to being an edge, in `style.stroke`. Without the step the outline would be
 * the fill's own colour at high zoom and adjacent patches would be indistinguishable — including
 * the ones the extraction grid split.
 *
 * The width deliberately overstates area at low zoom: a mark you can see is bigger than the ground
 * it stands for. That is a legibility floor, not a measurement — the honest alternative is not a
 * truer dot, it is a blank map, which reads as "no change here". Areas are only ever quoted from
 * the feature's own `metric`, never inferred from mark size.
 */
function outlineRole(key: string, changeType: ChangeType, test: FilterSpecification): Role {
  return {
    key,
    changeType,
    test,
    paint: (entry) => {
      const style = styleFor(entry.hue, changeType);
      return {
        type: 'line' as const,
        paint: {
          'line-color': [
            'step',
            ['zoom'],
            style.mark,
            SCALE_SPLIT_ZOOM,
            style.stroke,
          ] as unknown as string,
          'line-width': MARK_WIDTH,
          'line-opacity': 0.85,
        },
      };
    },
  };
}

/**
 * The layers one non-extent state owns: its fill, its pattern if it has one, its outline.
 *
 * Every colour here is a **constant**. It used to be a `match` over `change_type` shared by all
 * three states at once, which meant one data-driven paint property survived in the hot path — the
 * exact class of style that forces MapLibre to re-read tile data. Splitting the states into their
 * own layers is what the toggles needed anyway, and it takes the last expression out of the paint.
 */
function stateRoles(entry: DomainManifestEntry, changeType: ChangeType): Role[] {
  const test = isType(changeType);
  const style = styleFor(entry.hue, changeType);

  const roles: Role[] = [
    {
      key: `fill-${changeType}`,
      changeType,
      test,
      paint: (e) => ({
        type: 'fill' as const,
        paint: {
          'fill-color': styleFor(e.hue, changeType).color,
          // Kept below 1 so overlapping years read as accumulation rather than a flat mass.
          'fill-opacity': 0.75,
        },
      }),
    },
  ];

  if (style.pattern) {
    roles.push({
      key: `pattern-${changeType}`,
      changeType,
      test,
      // A second fill carrying only the pattern. fill-pattern would replace fill-color on a single
      // layer, and the rule is that loss is signalled by colour *and* texture, never either alone.
      paint: () => ({
        type: 'fill' as const,
        paint: { 'fill-pattern': HATCH_IMAGE, 'fill-opacity': 0.9 },
      }),
    });
  }

  roles.push(outlineRole(`outline-${changeType}`, changeType, test));
  return roles;
}

/**
 * Every layer this particular domain owns, derived from what its tileset actually contains.
 *
 * This used to be a fixed table of seven roles tagged with one of two mutually exclusive views, and
 * both halves of that were wrong. The views were exclusive where they should have been additive —
 * forest could show its canopy or its losses but never both, which is the one comparison the map
 * exists to make. And the table was fixed, so water built `extent-*` and `cleared-*` cohorts for an
 * extent it does not have: 4 roles across 38 years, 152 layers that could never match a feature.
 *
 * Now a role exists only if the manifest says the domain has something to put in it, and each role
 * names the change type whose toggle shows it. Array order is draw order, and it is load-bearing
 * twice over: the cleared patches are painted *over* the extent to cut holes in it, so they must
 * follow it; and the states run in `CHANGE_TYPE_ORDER` so loss lands on top of whatever it happened
 * to.
 */
function buildRoles(entry: DomainManifestEntry): Role[] {
  const present = new Set(entry.changeTypes ?? []);
  const roles: Role[] = [];

  if (present.has('extent')) {
    // The baseline mass the holes are cut from. More opaque than a change fill, which is an
    // accumulation rather than a ground state.
    roles.push({
      key: 'extent-fill',
      changeType: 'extent',
      test: isType('extent'),
      paint: (e) => ({
        type: 'fill' as const,
        paint: { 'fill-color': styleFor(e.hue, 'extent').color, 'fill-opacity': 0.85 },
      }),
    });
    roles.push(outlineRole('extent-outline', 'extent', isType('extent')));

    // Subtraction done with paint, because MapLibre fills cannot subtract. Filters on `loss` but is
    // shown by the *extent* toggle: taking out what has gone is part of drawing a baseline
    // honestly, not an overlay the reader opts into. An extent shown without its holes would claim
    // the 2000 canopy is still standing.
    if (present.has('loss')) {
      roles.push({
        key: 'cleared-fill',
        changeType: 'extent',
        test: isType('loss'),
        // Opaque on purpose. See CLEARED for why it is the colour it is.
        paint: () => ({
          type: 'fill' as const,
          paint: { 'fill-color': CLEARED, 'fill-opacity': 1 },
        }),
      });
      roles.push({
        key: 'cleared-outline',
        changeType: 'extent',
        test: isType('loss'),
        // Without this the extent would look static at island view: the holes are the same
        // sub-pixel patches as the loss layer, so at z8 a fill alone cuts nothing visible and the
        // mass would appear not to change as the years pass.
        paint: () => ({
          type: 'line' as const,
          paint: { 'line-color': CLEARED, 'line-width': MARK_WIDTH, 'line-opacity': 1 },
        }),
      });
    }
  }

  for (const changeType of CHANGE_TYPE_ORDER) {
    if (changeType === 'extent') continue;
    if (!present.has(changeType)) continue;
    roles.push(...stateRoles(entry, changeType));
  }

  return roles;
}

/**
 * `buildRoles(entry)`, cached per manifest entry.
 *
 * `opacityUpdatesFor` walks this on every single year commit, and rebuilding the table each time
 * would mean re-deriving every role — and calling into `styleFor` for each — on every tick of
 * playback. Keyed on the `entry` object for the same reason as `builtCache` below.
 */
const rolesCache = new WeakMap<DomainManifestEntry, Role[]>();

function rolesFor(entry: DomainManifestEntry): Role[] {
  let roles = rolesCache.get(entry);
  if (!roles) {
    roles = buildRoles(entry);
    rolesCache.set(entry, roles);
  }
  return roles;
}

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
export function opacityChannel(built: BuiltRole): {
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
 * `role.paint(entry)`, cached per domain/role.
 *
 * It rebuilds the whole style object — a `step` array, several calls into `styleFor` — every time
 * it runs, but is only ever asked for the same handful of (entry, role) pairs, and their output
 * never changes for the life of a manifest. `opacityUpdatesFor` calls this once per role on every
 * single year commit, so leaving it uncached meant reconstructing every role's full paint object on
 * every tick of playback just to read back one constant.
 *
 * Keyed on the `entry` object itself, not `entry.id`: a manifest that is ever replaced hands every
 * domain a fresh entry object, so the old one's cache entries simply become unreachable rather than
 * shadowing a same-id domain that has since changed hue or anything else `role.paint` reads.
 */
const builtCache = new WeakMap<DomainManifestEntry, Map<string, BuiltRole>>();

function builtFor(entry: DomainManifestEntry, role: Role): BuiltRole {
  let perEntry = builtCache.get(entry);
  if (!perEntry) {
    perEntry = new Map();
    builtCache.set(entry, perEntry);
  }
  let built = perEntry.get(role.key);
  if (!built) {
    built = role.paint(entry);
    perEntry.set(role.key, built);
  }
  return built;
}

/**
 * All layer ids a domain owns, in draw order. Used for teardown.
 *
 * Every change type's layers are built once and switched with `visibility` rather than added and
 * removed, so that flipping a toggle never refetches a tile.
 */
export function layerIdsFor(entry: DomainManifestEntry): string[] {
  return rolesFor(entry).flatMap((role) =>
    cohortYears(entry).map((cohort) => cohortLayerId(entry.id, role.key, cohort)),
  );
}

/**
 * The layers the reader has asked to see. Drives the visibility switch in `useDomainLayers`.
 *
 * A role is shown when *its* change type is selected, which for the cleared patches is `extent` and
 * not the `loss` they filter on — see `buildRoles`.
 */
export function layerIdsForSelection(
  entry: DomainManifestEntry,
  selected: ReadonlySet<ChangeType>,
): string[] {
  return rolesFor(entry)
    .filter((role) => selected.has(role.changeType))
    .flatMap((role) =>
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
 *
 * De-selected change types need no filtering here — their layers are `visibility: none`, which
 * `queryRenderedFeatures` skips outright.
 */
export function layerIdsForYear(entry: DomainManifestEntry, year: number): string[] {
  return rolesFor(entry).flatMap((role) =>
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
  return rolesFor(entry).flatMap((role) => {
    const { key, shown } = opacityChannel(builtFor(entry, role));

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

export function layersFor(
  entry: DomainManifestEntry,
  year: number,
  selected: ReadonlySet<ChangeType>,
): DomainLayers {
  const source = sourceId(entry.id);

  // Built by walking the same table that produces the ids, the opacities and the visibility sets,
  // in the same order. There is no second list to fall out of step with.
  //
  // Roles are the outer loop and cohorts the inner one, which keeps the role order — and with it
  // the rule that cleared patches are painted over the extent they cut holes in, and that loss is
  // drawn last. Interleaving the two would scatter each role's cohorts through the draw order and
  // lose that.
  const layers = rolesFor(entry).flatMap((role) => {
    const built = builtFor(entry, role);
    const { key, shown } = opacityChannel(built);
    const visibility = selected.has(role.changeType) ? 'visible' : 'none';

    return cohortYears(entry).map(
      (cohort) =>
        ({
          id: cohortLayerId(entry.id, role.key, cohort),
          type: built.type,
          source,
          'source-layer': entry.tiles.sourceLayer,
          filter: cohortFilter(entry, cohort, role.test),
          layout: { visibility },
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
