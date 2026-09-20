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

import { styleFor } from '@/domains/colors';
import { kindsOf } from '@/domains/manifest';
import type { DomainManifestEntry } from '@/domains/manifest';
import { CHANGE_TYPE_ORDER, KIND_OF } from '@/types/feature';
import type { ChangeType, Kind } from '@/types/feature';

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

/**
 * The map source one kind of a domain is read through: `trace-forest-cover`, `trace-forest-change`.
 *
 * One *archive* per domain, still — both sources name the same `tiles.url` — but one MapLibre
 * source per kind, because that is what lets the kinds arrive one after the other. A source is
 * parsed whole: adding a layer to it, or showing a hidden one, re-runs every visible layer over
 * every loaded tile, and cover is three quarters of that work. Two sources on the same archive
 * parse only their own layers, so the change source going on costs the change layers and nothing
 * else, and cover stays on screen untouched while it does. The tile bytes are fetched once for
 * both — see `sharedTiles` in `usePmtilesProtocol`.
 */
export const sourceId = (domainId: string, kind: Kind) => `trace-${domainId}-${kind}`;

/** Every source a domain reads through, in the order its stages go on. */
export const sourceIdsFor = (entry: DomainManifestEntry) =>
  kindsOf(entry).map((kind) => sourceId(entry.id, kind));

/**
 * The years a *change* role's layers are split across — one cohort per year of the coverage.
 *
 * Time is still a feature attribute: each cohort selects on `valid_from`, and the manifest's
 * range is what decides how many there are. What changed is that the selection is **fixed** at
 * build time rather than rewritten as the slider moves, which is what makes the animation free.
 * See `cohortFilter`. Cover roles use a different split — see `intervalNodes`.
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
 * Constant is not the same as free: MapLibre runs it over every feature of the cohort's *tile
 * layer* whenever a tile is parsed, which is why each cohort reads a tile layer of its own — see
 * `sourceLayerFor`.
 *
 * **Precondition: change features are open-ended.** A cohort is switched on for every year at or
 * after its own and never switched off again, so this model is only correct for features that
 * never stop being true — which is what the taxonomy says of every `change`-kind feature
 * (`valid_to: null`, always; `schema/feature.schema.json`). Cover is the kind that ends, and it
 * gets `intervalFilter` instead. `layerSpec.tiles.test.ts` checks the precondition against the
 * built tiles rather than trusting the comment.
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

/**
 * A node of the interval tree a *cover* role's layers are split across.
 *
 * Half-open `[start, end)`, like the validity it is matched against. `parent` is what makes a
 * node's filter *canonical* — see `intervalFilter`.
 */
export interface IntervalNode {
  start: number;
  end: number;
  parent: IntervalNode | null;
}

/**
 * A sentinel past any year the schema allows, so an absent `valid_to` reads as "never ends".
 *
 * Absent rather than null: tippecanoe drops null-valued attributes, so an open-ended feature
 * simply has no `valid_to` in the tile, and `['get', 'valid_to']` returns null for it.
 */
const OPEN_ENDED_YEAR = 9999;

/**
 * The binary tree over a domain's years that cover roles are split across — `2N − 1` nodes.
 *
 * Cover is the kind of state that *ends*: a forest block stands `[2000, L)` and is gone from L on.
 * Splitting it by `valid_from` alone, as change roles are, would draw it for every year after L
 * as well. And the obvious fix — one layer per year with a `from <= Y < to` filter — duplicates
 * every open-ended feature into every year's bucket, which for forest is the whole canopy 26 times
 * over in GPU memory. Paired `(from, to)` cohorts are correct but quadratic in N and their count
 * depends on the data.
 *
 * A segment tree is neither. Every half-open interval over N years decomposes into at most
 * `2⌈log₂N⌉` *canonical* nodes — the maximal nodes it fully covers — and a feature is placed in
 * exactly those. Each year is inside exactly one of them, so nothing draws twice; the common cases
 * (`[2000, null)`, `[1984, null)`) are the root alone; and the layer count is `2N − 1` whatever
 * the data holds. Pre-order, so a role's layers stay contiguous in draw order.
 */
export function intervalNodes(entry: DomainManifestEntry): IntervalNode[] {
  let nodes = intervalCache.get(entry);
  if (nodes) return nodes;

  nodes = [];
  const split = (start: number, end: number, parent: IntervalNode | null) => {
    const node: IntervalNode = { start, end, parent };
    nodes!.push(node);
    if (end - start > 1) {
      const mid = Math.floor((start + end) / 2);
      split(start, mid, node);
      split(mid, end, node);
    }
  };
  split(entry.temporal.start, entry.temporal.end + 1, null);

  intervalCache.set(entry, nodes);
  return nodes;
}

const intervalCache = new WeakMap<DomainManifestEntry, IntervalNode[]>();

/** Whether a feature's validity covers the whole of a node. */
const covers = (node: IntervalNode): FilterSpecification =>
  [
    'all',
    ['<=', ['get', 'valid_from'], node.start],
    ['>=', ['coalesce', ['get', 'valid_to'], OPEN_ENDED_YEAR], node.end],
  ] as FilterSpecification;

/**
 * One node's share of a cover role: the features whose validity covers this node but not its
 * parent — which is exactly the canonical decomposition, so each year of a feature is claimed by
 * one node and no other.
 *
 * The parent's bounds are constants at build time, so like `cohortFilter` every clause here is
 * fixed and the year is animated by opacity alone. A node is shown for year Y iff
 * `start <= Y < end`; the shown set is the root-to-leaf path for Y, and stepping to Y+1 flips at
 * most `2·(depth − 1)` of them — a bound on writes per step that does not depend on the data.
 */
function intervalFilter(node: IntervalNode, test: FilterSpecification): FilterSpecification {
  const canonical: FilterSpecification = node.parent
    ? (['all', covers(node), ['!', covers(node.parent)]] as FilterSpecification)
    : covers(node);

  return ['all', canonical, test] as FilterSpecification;
}

/** Selects exactly one change type. Every role filters on one of these. */
const isType = (changeType: ChangeType): FilterSpecification =>
  ['==', ['get', 'change_type'], changeType] as FilterSpecification;

/**
 * Which split a state's layers get. Decided by the *kind* — cover ends, change does not — so it
 * is the taxonomy that picks the model, never the domain.
 */
const cohortModelFor = (changeType: ChangeType): 'from' | 'interval' =>
  KIND_OF[changeType] === 'cover' ? 'interval' : 'from';

/**
 * The width ramp that keeps a sub-pixel patch visible.
 *
 * Shared by every line layer here because the problem is shared: below `SCALE_SPLIT_ZOOM` the
 * patches are smaller than a pixel, whether they are being drawn as loss or as the edge of a
 * cover block, and a fill cannot render either. See `outlineRole` for the full reasoning.
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
 * `changeType` is which *toggle* shows this layer and which state it filters on; `cohorts` is
 * how its layers are split across the years, and follows from the change type's kind.
 */
interface Role {
  key: string;
  changeType: ChangeType;
  cohorts: 'from' | 'interval';
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
    cohorts: cohortModelFor(changeType),
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
 * The layers one non-cover state owns: its fill, its pattern if it has one, its outline.
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
      cohorts: cohortModelFor(changeType),
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
      cohorts: cohortModelFor(changeType),
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
 * exists to make. And the table was fixed, so water built cover cohorts for a cover it does not
 * have: layers that could never match a feature, switched between as if they might.
 *
 * Now a role exists only if the manifest says the domain has something to put in it, and each role
 * names the change type whose toggle shows it. Array order is draw order: cover first, as the
 * ground the changes happened to, then the states in `CHANGE_TYPE_ORDER` so loss lands on top.
 *
 * There used to be a third thing here — `cleared-*` roles that painted loss patches over the cover
 * in the ground colour to cut holes in it, because a cover that never ended had to be shown ending
 * somehow. That was this file deriving cover from loss. Cover now carries its own `valid_to`
 * (T-029) and its layers switch off at it (`intervalFilter`), so the holes are in the data and
 * nothing here needs to fake them.
 */
function buildRoles(entry: DomainManifestEntry): Role[] {
  const present = new Set(entry.changeTypes ?? []);
  const roles: Role[] = [];

  if (present.has('cover')) {
    // The ground state. More opaque than a change fill, which is an accumulation rather than a
    // mass, and drawn for exactly the years its own validity says — see `intervalNodes`.
    roles.push({
      key: 'cover-fill',
      changeType: 'cover',
      cohorts: cohortModelFor('cover'),
      test: isType('cover'),
      paint: (e) => ({
        type: 'fill' as const,
        paint: { 'fill-color': styleFor(e.hue, 'cover').color, 'fill-opacity': 0.85 },
      }),
    });
    roles.push(outlineRole('cover-outline', 'cover', isType('cover')));
  }

  for (const changeType of CHANGE_TYPE_ORDER) {
    if (changeType === 'cover') continue;
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

/**
 * One layer of a role, whichever way the role is split: its id, the tile layer it reads, its
 * fixed filter, and whether it is shown for a year. Everything below walks these, so the two
 * cohort models meet in exactly one place and no caller has to know which it is holding.
 */
interface Cohort {
  id: string;
  sourceLayer: string;
  filter: FilterSpecification;
  shown: (year: number) => boolean;
}

/** `trace-forest-fill-loss-2013` for a year cohort; `trace-forest-cover-fill-2001-2026` for a node. */
const cohortLayerId = (domainId: string, key: string, cohort: number | IntervalNode) =>
  typeof cohort === 'number'
    ? `trace-${domainId}-${key}-${cohort}`
    : `trace-${domainId}-${key}-${cohort.start}-${cohort.end}`;

/**
 * The tile layer a cohort's features are in: `loss:2013` for a year, `cover:2001-2026` for a node.
 *
 * This is the other half of why a step is cheap. The filter is what *defines* a cohort, and it
 * is fixed — but MapLibre's worker runs every style layer's filter over every feature of the tile
 * layer the style layer names, so with every cohort reading one tile layer, each feature was
 * filtered once per cohort: 416 times for water, 167 million evaluations for the largest z7 tile,
 * ~43 s of worker time before anything could draw. The pipeline now writes each feature into the
 * tile layer of its cohort (`pipeline/trace_pipeline/cohorts.py`, the same rule as this file), so
 * a filter here is a pass over its own cohort. The filter stays: it is the definition, the tile
 * layer is the index, and the tiles test asserts that the two select the same features.
 *
 * A cover feature is in every node canonical for its validity, so it is written once per such
 * node — about 2.1 copies on average for a closed stretch, and one for open-ended cover.
 */
export const sourceLayerFor = (changeType: ChangeType, cohort: number | IntervalNode) =>
  typeof cohort === 'number'
    ? `${changeType}:${cohort}`
    : `${changeType}:${cohort.start}-${cohort.end}`;

/**
 * Every tile layer a domain's cohorts would read, whether or not the archive holds it.
 *
 * The full enumeration of the model, for the tests and for comparing against a built archive.
 * The layers actually built are the subset the manifest lists — see `buildCohorts`.
 */
export function cohortSourceLayers(entry: DomainManifestEntry): string[] {
  const names = new Set<string>();
  for (const changeType of entry.changeTypes ?? []) {
    if (cohortModelFor(changeType) === 'interval') {
      for (const node of intervalNodes(entry)) names.add(sourceLayerFor(changeType, node));
    } else {
      for (const year of cohortYears(entry)) names.add(sourceLayerFor(changeType, year));
    }
  }
  return [...names];
}

/**
 * The tile layers the manifest says the archive holds, as a set, cached per entry.
 *
 * A cohort whose tile layer is not here gets no style layer. That is not a loss of data — the
 * pipeline lists what tippecanoe wrote, and a cohort with no features gets no layer — and the
 * alternative is a style layer naming a layer its source lacks, which MapLibre reports as an
 * error on every tile.
 */
const listedCache = new WeakMap<DomainManifestEntry, Set<string>>();

function listedSourceLayers(entry: DomainManifestEntry): Set<string> {
  let listed = listedCache.get(entry);
  if (!listed) {
    listed = new Set(entry.tiles.sourceLayers);
    listedCache.set(entry, listed);
  }
  return listed;
}

function buildCohorts(entry: DomainManifestEntry, role: Role): Cohort[] {
  const listed = listedSourceLayers(entry);
  const cohorts: Cohort[] =
    role.cohorts === 'interval'
      ? intervalNodes(entry).map((node) => ({
          id: cohortLayerId(entry.id, role.key, node),
          sourceLayer: sourceLayerFor(role.changeType, node),
          filter: intervalFilter(node, role.test),
          shown: (year) => node.start <= year && year < node.end,
        }))
      : cohortYears(entry).map((cohort) => ({
          id: cohortLayerId(entry.id, role.key, cohort),
          sourceLayer: sourceLayerFor(role.changeType, cohort),
          filter: cohortFilter(entry, cohort, role.test),
          shown: (year) => cohort <= year,
        }));

  return cohorts.filter((c) => listed.has(c.sourceLayer));
}

/**
 * `buildCohorts(entry, role)`, cached per domain/role — for the same reason as `builtFor`: this
 * is walked on every year commit, and its output never changes for the life of a manifest.
 * Caching also makes "the filter never changes" true by identity, not just by construction.
 */
const cohortsCache = new WeakMap<DomainManifestEntry, Map<string, Cohort[]>>();

function cohortsOf(entry: DomainManifestEntry, role: Role): Cohort[] {
  let perEntry = cohortsCache.get(entry);
  if (!perEntry) {
    perEntry = new Map();
    cohortsCache.set(entry, perEntry);
  }
  let cohorts = perEntry.get(role.key);
  if (!cohorts) {
    cohorts = buildCohorts(entry, role);
    perEntry.set(role.key, cohorts);
  }
  return cohorts;
}

/**
 * The most paint writes one year step can cost this domain, whatever the year.
 *
 * A change role flips exactly one cohort per step. A cover role's shown set is a root-to-leaf
 * path, so a step flips at most the two paths' symmetric difference: `2·(depth − 1)`, the root
 * being on both. The test asserts the real per-step counts stay under this, and that they read
 * the same backwards — the property that rules out anything accumulating. A bound on the full
 * model: a cohort the archive has no layer for is simply never written, so it only lowers the
 * real count.
 */
export function maxWritesPerStep(entry: DomainManifestEntry): number {
  const depth = intervalNodes(entry).reduce((max, node) => {
    let d = 1;
    for (let n = node.parent; n; n = n.parent) d += 1;
    return Math.max(max, d);
  }, 0);

  return rolesFor(entry).reduce(
    (sum, role) => sum + (role.cohorts === 'interval' ? 2 * (depth - 1) : 1),
    0,
  );
}

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
  return rolesFor(entry).flatMap((role) => cohortsOf(entry, role).map((c) => c.id));
}

/**
 * The layers the reader has asked to see. Drives the visibility switch in `useDomainLayers`.
 *
 * A role is shown when its own change type is selected.
 */
export function layerIdsForSelection(
  entry: DomainManifestEntry,
  selected: ReadonlySet<ChangeType>,
): string[] {
  return rolesFor(entry)
    .filter((role) => selected.has(role.changeType))
    .flatMap((role) => cohortsOf(entry, role).map((c) => c.id));
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
    cohortsOf(entry, role)
      .filter((c) => c.shown(year))
      .map((c) => c.id),
  );
}

/**
 * Every cohort's opacity for a given year, keyed by layer id and paint property.
 *
 * This is the animation. Each entry is a *constant* paint value, which MapLibre applies without
 * touching tile data at all — no filter change, no source reload, no re-tessellation. Cohorts the
 * year falls in draw at their role's own opacity; the rest sit at zero.
 */
export function opacityUpdatesFor(
  entry: DomainManifestEntry,
  year: number,
): [string, string, number][] {
  return rolesFor(entry).flatMap((role) => {
    const { key, shown } = opacityChannel(builtFor(entry, role));

    return cohortsOf(entry, role).map(
      (c) => [c.id, key, c.shown(year) ? shown : 0] as [string, string, number],
    );
  });
}

/**
 * One kind of a domain, ready to go on the map: its source and the layers that read it.
 *
 * `stagesFor` returns these in `kindsOf` order, and the map adds them in that order — the next
 * only once the previous source reports loaded — so cover is on screen while change is still
 * being parsed. Which kind a role belongs to follows from its change type (`KIND_OF`), the same
 * rule that picks its cohort model and its toggle group.
 */
export interface DomainStage {
  kind: Kind;
  sourceId: string;
  source: { type: 'vector'; url: string; attribution: string };
  layers: (FillLayerSpecification | LineLayerSpecification)[];
}

export function stageFor(
  entry: DomainManifestEntry,
  kind: Kind,
  year: number,
  selected: ReadonlySet<ChangeType>,
): DomainStage {
  const source = sourceId(entry.id, kind);

  // Built by walking the same table that produces the ids, the opacities and the visibility sets,
  // in the same order. There is no second list to fall out of step with.
  //
  // Roles are the outer loop and cohorts the inner one, which keeps the role order — and with it
  // the rule that cover is the ground and loss is drawn last. Interleaving the two would scatter
  // each role's cohorts through the draw order and lose that.
  const layers = rolesFor(entry)
    .filter((role) => KIND_OF[role.changeType] === kind)
    .flatMap((role) => {
      const built = builtFor(entry, role);
      const { key, shown } = opacityChannel(built);
      const visibility = selected.has(role.changeType) ? 'visible' : 'none';

      return cohortsOf(entry, role).map(
        (c) =>
          ({
            id: c.id,
            type: built.type,
            source,
            'source-layer': c.sourceLayer,
            filter: c.filter,
            layout: { visibility },
            paint: {
              ...built.paint,
              [key]: c.shown(year) ? shown : 0,
              // A cohort appears the instant its year arrives. The default 300ms fade would still
              // be running two years later at playback speed, leaving the map showing a half-drawn
              // year while the readout named it outright.
              [`${key}-transition`]: { duration: 0, delay: 0 },
            },
          }) as unknown as FillLayerSpecification | LineLayerSpecification,
      );
    });

  return {
    kind,
    sourceId: source,
    source: { type: 'vector', url: entry.tiles.url, attribution: entry.source.attribution },
    layers,
  };
}

/** Every stage of a domain, in the order they go on the map. */
export function stagesFor(
  entry: DomainManifestEntry,
  year: number,
  selected: ReadonlySet<ChangeType>,
): DomainStage[] {
  return kindsOf(entry).map((kind) => stageFor(entry, kind, year, selected));
}

/**
 * Every layer a domain builds, across all its stages, in draw order.
 *
 * What the map ends up holding once every stage is on. The tests read this; the map itself adds
 * stage by stage.
 */
export function layersFor(
  entry: DomainManifestEntry,
  year: number,
  selected: ReadonlySet<ChangeType>,
): (FillLayerSpecification | LineLayerSpecification)[] {
  return stagesFor(entry, year, selected).flatMap((stage) => stage.layers);
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
