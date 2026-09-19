/**
 * The cohort layer model.
 *
 * These cover the properties the animation depends on, all of which are invisible to typechecking
 * and were previously only ever confirmed by looking at the map: that a cohort's selection is fixed
 * rather than rewritten as the slider moves, that showing a year is a constant paint change, that
 * draw order survives being split into a layer per year, and that the work a step costs does not
 * grow with the year. That last one is the regression that made playback start fast and crawl by
 * the end, and it is the reason this file exists.
 *
 * Two splits now: change roles are one cohort per `valid_from` year; cover roles are the canonical
 * nodes of an interval tree, so a feature that ends is drawn for exactly its years. The interval
 * tests run MapLibre's own filter evaluator over synthetic features, because "exactly one node
 * claims each year" is a property of the filters, not of the ids.
 */

import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';

import {
  cohortYears,
  intervalNodes,
  layerIdsFor,
  layerIdsForSelection,
  layerIdsForYear,
  layersFor,
  maxWritesPerStep,
  opacityChannel,
  opacityUpdatesFor,
} from '@/domains/layerSpec';
import type { DomainManifestEntry } from '@/domains/manifest';
import type { ChangeType } from '@/types/feature';

/**
 * A stand-in manifest entry rather than the real one: `data/domains.json` is generated and
 * gitignored, so a test that read it would pass or fail depending on whether the pipeline had been
 * run. Only the fields the layer builder actually reads matter here.
 */
const entry: DomainManifestEntry = {
  id: 'forest',
  label: { en: 'Forest', zh: '森林' },
  hue: '#15803d',
  changeTypes: ['cover', 'loss'],
  temporal: { start: 2001, end: 2025 },
  source: {
    name: 'Hansen Global Forest Change',
    version: 'v1.13',
    attribution: 'Hansen et al., University of Maryland',
    citation: 'Hansen et al., Science 342 (2013)',
    licence: 'CC-BY-4.0',
  },
  caveat: 'Tree-cover loss, not deforestation.',
  tiles: { url: 'pmtiles:///data/forest.pmtiles', sourceLayer: 'forest' },
};

/**
 * A water-shaped entry, for the half of the model the forest fixture cannot reach: three change
 * types alongside cover, where the roles built are a different set.
 */
const water: DomainManifestEntry = {
  id: 'water',
  label: { en: 'Water', zh: '水體' },
  hue: '#2563eb',
  changeTypes: ['cover', 'gain', 'loss', 'stable'],
  temporal: { start: 1984, end: 2021 },
  source: {
    name: 'JRC Global Surface Water',
    version: 'v1.4',
    attribution: 'Source: EC JRC/Google',
    citation: 'Pekel et al., Nature 540 (2016)',
    licence: 'Free to use with attribution',
  },
  caveat: 'Surface water at 30 m resolution.',
  tiles: { url: 'pmtiles:///data/water.pmtiles', sourceLayer: 'water' },
};

/** A domain with change and no cover at all — the case the cover machinery must stay out of. */
const changeOnly: DomainManifestEntry = { ...water, changeTypes: ['gain', 'loss', 'stable'] };

/** Everything the domain can show — the default the app opens in. */
const all = (e: DomainManifestEntry) => new Set(e.changeTypes ?? []);
const ALL = all(entry);

const YEARS = 25;
const NODES = 2 * YEARS - 1;
const COVER_ROLES = 2; // cover-fill, cover-outline
const CHANGE_ROLES = 3; // fill-loss, pattern-loss, outline-loss
const ROLES = COVER_ROLES + CHANGE_ROLES;
const LAYERS = COVER_ROLES * NODES + CHANGE_ROLES * YEARS;

/** `trace-forest-fill-loss-2013` → `fill-loss`; `trace-forest-cover-fill-2001-2026` → `cover-fill`. */
const roleOf = (id: string, e = entry) =>
  id.replace(`trace-${e.id}-`, '').replace(/-\d{4}(-\d{4})?$/, '');

/** Whether the model says this layer is on for a year, read back off its id alone. */
const shownAt = (id: string, year: number) => {
  const interval = /-(\d{4})-(\d{4})$/.exec(id);
  if (interval) return Number(interval[1]) <= year && year < Number(interval[2]);
  return Number(id.slice(-4)) <= year;
};

const opacityOf = (layer: { type: 'fill' | 'line'; paint?: unknown }) =>
  opacityChannel({ type: layer.type, paint: (layer.paint ?? {}) as Record<string, unknown> }).shown;

/** The root node's id for a cover role — shown at every year, since every year is inside it. */
const ROOT = `trace-${entry.id}-cover-fill-${entry.temporal.start}-${entry.temporal.end + 1}`;

describe('cohorts', () => {
  it('spans exactly the range the manifest claims', () => {
    expect(cohortYears(entry)).toHaveLength(YEARS);
    expect(cohortYears(entry)[0]).toBe(2001);
    expect(cohortYears(entry).at(-1)).toBe(2025);
  });

  it('builds one layer per change role per year and per cover role per node, with unique ids', () => {
    const { layers } = layersFor(entry, 2013, ALL);

    expect(layers).toHaveLength(LAYERS);
    expect(new Set(layers.map((l) => l.id)).size).toBe(layers.length);
    expect(layerIdsFor(entry)).toHaveLength(layers.length);
  });

  it('shows every layer when every state is selected, and none when none is', () => {
    expect(layerIdsForSelection(entry, ALL)).toHaveLength(LAYERS);
    expect(layerIdsForSelection(entry, new Set<ChangeType>())).toEqual([]);
  });

  it('gives the first cohort everything from its year back, so a pre-range baseline is kept', () => {
    // A change dated before the range — nothing forest emits today, but nothing forbids it — must
    // land in the first cohort rather than in none. An `==` test would drop it.
    const { layers } = layersFor(entry, 2013, ALL);
    const first = layers.find((l) => l.id === `trace-${entry.id}-fill-loss-2001`);
    const later = layers.find((l) => l.id === `trace-${entry.id}-fill-loss-2014`);

    expect(JSON.stringify(first?.filter)).toContain('"<="');
    expect(JSON.stringify(later?.filter)).toContain('"=="');
  });
});

describe('interval cohorts', () => {
  it('splits a cover role into 2N−1 nodes over the half-open range', () => {
    const nodes = intervalNodes(entry);

    expect(nodes).toHaveLength(NODES);
    expect(nodes[0]).toMatchObject({ start: 2001, end: 2026, parent: null });
    expect(nodes.filter((n) => n.end - n.start === 1)).toHaveLength(YEARS);
    expect(
      nodes.every((n) => n.parent === null || (n.parent.start <= n.start && n.end <= n.parent.end)),
    ).toBe(true);
  });

  it('shows, for any year, exactly the root-to-leaf path through that year', () => {
    for (const year of cohortYears(entry)) {
      const shown = intervalNodes(entry).filter((n) => n.start <= year && year < n.end);
      // Every shown node is an ancestor-or-self of the next, ending at the leaf.
      for (let i = 1; i < shown.length; i += 1) expect(shown[i]!.parent).toBe(shown[i - 1]);
      expect(shown.at(-1)).toMatchObject({ start: year, end: year + 1 });
    }
  });

  it('claims each year of a feature’s validity from exactly one node, and no year outside it', () => {
    // The load-bearing property, checked with MapLibre's own evaluator: for every synthetic
    // feature and every year, count the cover-fill layers that are both shown at that year and
    // select the feature. It must be 1 inside [from, to) and 0 outside — never 2, never missed.
    const cases: { valid_from: number; valid_to?: number; label: string }[] = [
      { valid_from: 2000, label: 'open, from before the range' },
      { valid_from: 2000, valid_to: 2014, label: 'closed, from before the range' },
      { valid_from: 2005, valid_to: 2009, label: 'closed, inside the range' },
      { valid_from: 2013, valid_to: 2014, label: 'a single year' },
      { valid_from: 2024, label: 'open, from near the end' },
      { valid_from: 2000, valid_to: 2030, label: 'closed after the range ends' },
      { valid_from: 1990, valid_to: 2001, label: 'ended before the range began' },
      { valid_from: 2026, label: 'begins after the range ends' },
    ];

    const { layers } = layersFor(entry, 2013, ALL);
    const coverFill = layers.filter((l) => roleOf(l.id) === 'cover-fill');
    expect(coverFill).toHaveLength(NODES);

    const filters = coverFill.map((l) => ({
      id: l.id,
      filter: featureFilter(l.filter as never, l.id).filter,
    }));

    for (const c of cases) {
      const feature = {
        type: 3,
        properties: { change_type: 'cover', valid_from: c.valid_from, valid_to: c.valid_to },
      };
      if (c.valid_to === undefined) delete (feature.properties as { valid_to?: number }).valid_to;

      for (const year of cohortYears(entry)) {
        const claims = filters.filter(
          ({ id, filter }) =>
            shownAt(id, year) &&
            filter({ zoom: 10 } as never, feature as never, undefined as never),
        ).length;
        const inside = c.valid_from <= year && year < (c.valid_to ?? Infinity);

        expect({ label: c.label, year, claims }).toEqual({
          label: c.label,
          year,
          claims: inside ? 1 : 0,
        });
      }
    }
  });

  it('reads an absent valid_to as open, which is how tippecanoe encodes null', () => {
    const { layers } = layersFor(entry, 2013, ALL);
    const root = layers.find((l) => l.id === ROOT)!;
    const filter = featureFilter(root.filter as never, root.id).filter;
    const at = (props: Record<string, unknown>) =>
      filter({ zoom: 10 } as never, { type: 3, properties: props } as never, undefined as never);

    expect(at({ change_type: 'cover', valid_from: 2000 })).toBe(true);
    expect(at({ change_type: 'cover', valid_from: 2000, valid_to: 2026 })).toBe(true);
    expect(at({ change_type: 'cover', valid_from: 2000, valid_to: 2025 })).toBe(false);
  });
});

describe('the year is opacity, never a filter', () => {
  it('selects the same features whatever year is being shown', () => {
    // The load-bearing property. A filter that changes when the slider moves makes MapLibre
    // re-parse every loaded tile in the worker, which is what this design exists to avoid.
    const at2010 = layersFor(entry, 2010, ALL);
    const at2020 = layersFor(entry, 2020, ALL);

    const filters = (spec: typeof at2010) => spec.layers.map((l) => [l.id, l.filter]);

    expect(filters(at2010)).toEqual(filters(at2020));
  });

  it('shows the cohorts the year falls in and hides the rest', () => {
    const { layers } = layersFor(entry, 2010, ALL);

    for (const layer of layers) {
      expect({ id: layer.id, on: opacityOf(layer) > 0 }).toEqual({
        id: layer.id,
        on: shownAt(layer.id, 2010),
      });
    }
  });

  it('draws a shown cohort at its role’s own opacity, not a substitute', () => {
    const { layers } = layersFor(entry, 2025, ALL);
    const shown = (id: string) => opacityOf(layers.find((l) => l.id === id)!);

    expect(shown(`trace-${entry.id}-fill-loss-2010`)).toBe(0.75);
    expect(shown(`trace-${entry.id}-pattern-loss-2010`)).toBe(0.9);
    expect(shown(`trace-${entry.id}-outline-loss-2010`)).toBe(0.85);
    expect(shown(ROOT)).toBe(0.85);
  });

  it('appears instantly, so a year is never shown half-drawn', () => {
    // MapLibre's default 300ms fade would still be running two years later at playback speed,
    // leaving the map mid-transition while the readout named the year outright.
    const { layers } = layersFor(entry, 2010, ALL);

    for (const layer of layers) {
      const paint = layer.paint as Record<string, unknown>;
      const { key } = opacityChannel({ type: layer.type, paint });
      expect(paint[`${key}-transition`]).toEqual({ duration: 0, delay: 0 });
    }
  });

  it('changes nothing but opacity across cohorts of a role', () => {
    const { layers } = layersFor(entry, 2013, ALL);
    const withoutOpacity = (layer: (typeof layers)[number]) => {
      const paint = { ...(layer.paint as Record<string, unknown>) };
      const { key } = opacityChannel({ type: layer.type, paint });
      delete paint[key];
      delete paint[`${key}-transition`];
      return JSON.stringify([layer.type, layer.source, paint]);
    };

    for (const role of new Set(layers.map((l) => roleOf(l.id)))) {
      const shared = layers.filter((l) => roleOf(l.id) === role).map(withoutOpacity);
      expect(new Set(shared).size).toBe(1);
    }
  });
});

describe('draw order', () => {
  it('keeps every cover cohort beneath every change cohort', () => {
    // Cover is the ground the changes happened to. A loss drawn under the canopy it removed would
    // simply not be visible.
    const ids = layersFor(entry, 2013, ALL).layers.map((l) => l.id);
    const lastCover = ids.reduce((last, id, i) => (id.includes('-cover-') ? i : last), -1);
    const firstChange = ids.findIndex((id) => id.includes('-loss-'));

    expect(lastCover).toBeGreaterThanOrEqual(0);
    expect(firstChange).toBeGreaterThan(lastCover);
  });

  it('keeps each role’s cohorts contiguous', () => {
    const roles = layersFor(entry, 2013, ALL).layers.map((l) => roleOf(l.id));
    const counts = new Map<string, number>();
    for (const role of roles) counts.set(role, (counts.get(role) ?? 0) + 1);

    // A role that reappears after another role has intervened means the order was interleaved.
    expect(counts.size).toBe(ROLES);
    expect(roles).toEqual([...counts].flatMap(([r, n]) => Array<string>(n).fill(r)));
  });
});

describe('hit-testing', () => {
  it('offers only the layers actually on screen', () => {
    // Later cohorts are still on the map at zero opacity, and queryRenderedFeatures reads geometry
    // rather than paint — so querying everything would let a click land on loss that has not
    // happened yet, or on cover that has already gone, and open a readout describing it.
    const hittable = layerIdsForYear(entry, 2010);
    const path = intervalNodes(entry).filter((n) => n.start <= 2010 && 2010 < n.end).length;

    expect(hittable).toHaveLength(CHANGE_ROLES * 10 + COVER_ROLES * path);
    expect(hittable.every((id) => shownAt(id, 2010))).toBe(true);
  });
});

describe('cost of a step', () => {
  /** Apply a year through the same dedupe `useDomainLayers` uses; return how many writes it took. */
  const stepper = () => {
    const applied = new Map<string, number>();
    return (year: number) => {
      let writes = 0;
      for (const [id, , opacity] of opacityUpdatesFor(entry, year)) {
        if (applied.get(id) === opacity) continue;
        applied.set(id, opacity);
        writes++;
      }
      return writes;
    };
  };
  const { start, end } = entry.temporal;

  it('is bounded whatever the year, so playback cannot slow down as it runs', () => {
    // The regression this whole model replaced: filtering one layer meant each step re-tessellated
    // every feature from the start of the range to the current year, so the work grew from 2,656
    // features at 2001 to 91,088 at 2025 and playback visibly decelerated.
    const apply = stepper();
    apply(start);

    const perStep: number[] = [];
    for (let year = start + 1; year <= end; year += 1) perStep.push(apply(year));

    // One cohort per change role, plus at most one path's worth of flips per cover role.
    expect(Math.max(...perStep)).toBeLessThanOrEqual(maxWritesPerStep(entry));
    expect(maxWritesPerStep(entry)).toBe(CHANGE_ROLES * 1 + COVER_ROLES * 2 * 5);
    // And over a full sweep each node turns on once and off once, so the mean is small.
    const mean = perStep.reduce((a, b) => a + b, 0) / perStep.length;
    expect(mean).toBeLessThanOrEqual(CHANGE_ROLES + 4 * COVER_ROLES);
  });

  it('costs the same to step back as forward, so nothing accumulates', () => {
    // A segment tree flips the same nodes in either direction. Anything that grew with the year
    // would break this symmetry, which makes it the sharpest single assertion of "no accumulation".
    const forward = stepper();
    forward(start);
    const up: number[] = [];
    for (let year = start + 1; year <= end; year += 1) up.push(forward(year));

    const backward = stepper();
    backward(end);
    const down: number[] = [];
    for (let year = end - 1; year >= start; year -= 1) down.push(backward(year));

    expect(down.reverse()).toEqual(up);
  });

  it('touches every cohort on first paint, so none is left at a stale opacity', () => {
    expect(stepper()(2025)).toBe(LAYERS);
  });
});

describe('roles are derived from what the tileset holds', () => {
  const rolesOf = (e: DomainManifestEntry) => [
    ...new Set(layerIdsFor(e).map((id) => roleOf(id, e))),
  ];

  it('builds no cover layers for a domain that has no cover', () => {
    // The table used to be fixed at seven roles, so water built cover cohorts for a baseline it
    // does not have: layers that could never match a feature and were switched between as if
    // they might.
    expect(rolesOf(changeOnly).some((role) => role.startsWith('cover-'))).toBe(false);
  });

  it('gives every state a fill and an outline, and a pattern only where the style has one', () => {
    expect(rolesOf(water)).toEqual([
      'cover-fill',
      'cover-outline',
      'fill-stable',
      'outline-stable',
      'fill-gain',
      'outline-gain',
      'fill-loss',
      'pattern-loss',
      'outline-loss',
    ]);
    expect(rolesOf(entry)).toEqual([
      'cover-fill',
      'cover-outline',
      'fill-loss',
      'pattern-loss',
      'outline-loss',
    ]);
  });

  it('draws the states in a fixed order, with loss on top of whatever it happened to', () => {
    const roles = rolesOf(water);

    expect(roles.indexOf('fill-stable')).toBeLessThan(roles.indexOf('fill-gain'));
    expect(roles.indexOf('fill-gain')).toBeLessThan(roles.indexOf('fill-loss'));
  });

  it('splits change roles by year and cover roles by node, nothing else', () => {
    for (const id of layerIdsFor(entry)) {
      const isCover = roleOf(id).startsWith('cover-');
      expect({ id, interval: /-\d{4}-\d{4}$/.test(id) }).toEqual({ id, interval: isCover });
    }
    expect(
      layerIdsFor(changeOnly).every((id) => /-\d{4}$/.test(id) && !/-\d{4}-\d{4}$/.test(id)),
    ).toBe(true);
  });

  it('builds nothing for a manifest that never said what it holds', () => {
    // `changeTypes` is optional. A domain without it gets no controls, so building layers it can
    // never switch off would put pixels on the map with nothing to explain or remove them.
    const { changeTypes: _omitted, ...silent } = water;

    expect(layerIdsFor(silent)).toEqual([]);
  });
});

describe('which toggle shows which layer', () => {
  it('shows cover with the cover toggle and loss with the loss toggle, and nothing crosses over', () => {
    // There used to be `cleared-*` roles that filtered on loss but were shown by the cover toggle,
    // to cut holes in a cover that never ended. Cover carries its own end now, so no role answers
    // to a toggle other than its own.
    const withCover = layerIdsForSelection(entry, new Set<ChangeType>(['cover']));
    const withLoss = layerIdsForSelection(entry, new Set<ChangeType>(['loss']));

    expect(withCover.every((id) => roleOf(id).startsWith('cover-'))).toBe(true);
    expect(withLoss.every((id) => roleOf(id).endsWith('-loss'))).toBe(true);
    expect(withCover).toHaveLength(COVER_ROLES * NODES);
    expect(withLoss).toHaveLength(CHANGE_ROLES * YEARS);
  });

  it('is a visibility switch, so the layers are built either way', () => {
    // Both states' layers exist from the start and are switched with `visibility`. Adding and
    // removing them instead would refetch a tile every time a chip was pressed.
    const { layers } = layersFor(entry, 2013, new Set<ChangeType>(['loss']));
    const visibilityOf = (id: string) =>
      (layers.find((l) => l.id === id)?.layout as { visibility?: string } | undefined)?.visibility;

    expect(layers).toHaveLength(LAYERS);
    expect(visibilityOf(`trace-${entry.id}-fill-loss-2013`)).toBe('visible');
    expect(visibilityOf(ROOT)).toBe('none');
  });
});

describe('paint never reads a feature', () => {
  it('carries no data-driven colour or opacity, in either domain', () => {
    // Colour used to be a `match` over `change_type` shared by every change state — the last
    // data-driven paint property in the hot path, and exactly the class of style that makes
    // MapLibre re-read tile data. And the obvious way to honour `valid_to` — a data-driven
    // opacity per step — is the same reload in different clothes. A `step` on zoom is still
    // allowed, because zoom is not a feature.
    for (const e of [entry, water]) {
      for (const layer of layersFor(e, 2013, all(e)).layers) {
        expect(JSON.stringify(layer.paint)).not.toContain('"get"');
      }
    }
  });
});
