/**
 * The cohort layer model.
 *
 * These cover the properties the animation depends on, all of which are invisible to typechecking
 * and were previously only ever confirmed by looking at the map: that a cohort's selection is fixed
 * rather than rewritten as the slider moves, that showing a year is a constant paint change, that
 * draw order survives being split into a layer per year, and that the work a step costs does not
 * grow with the year. That last one is the regression that made playback start fast and crawl by
 * the end, and it is the reason this file exists.
 */

import { describe, expect, it } from 'vitest';

import {
  cohortYears,
  layerIdsFor,
  layerIdsForSelection,
  layerIdsForYear,
  layersFor,
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
  changeTypes: ['extent', 'loss'],
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
 * A water-shaped entry, for the half of the model the forest fixture cannot reach: a domain with no
 * extent and three change types, where the roles built are an entirely different set.
 */
const water: DomainManifestEntry = {
  id: 'water',
  label: { en: 'Water', zh: '水體' },
  hue: '#2563eb',
  changeTypes: ['gain', 'loss', 'stable'],
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

/** Everything the domain can show — the default the app opens in. */
const all = (e: DomainManifestEntry) => new Set(e.changeTypes ?? []);
const ALL = all(entry);

const YEARS = 25;
const ROLES = 7;

/** `trace-forest-cleared-fill-2013` → `cleared-fill`. */
const roleOf = (id: string) => id.replace(`trace-${entry.id}-`, '').replace(/-\d{4}$/, '');

const opacityOf = (layer: { type: 'fill' | 'line'; paint?: unknown }) =>
  opacityChannel({ type: layer.type, paint: (layer.paint ?? {}) as Record<string, unknown> }).shown;

describe('cohorts', () => {
  it('spans exactly the range the manifest claims', () => {
    expect(cohortYears(entry)).toHaveLength(YEARS);
    expect(cohortYears(entry)[0]).toBe(2001);
    expect(cohortYears(entry).at(-1)).toBe(2025);
  });

  it('builds one layer per role per year, with unique ids', () => {
    const { layers } = layersFor(entry, 2013, ALL);

    expect(layers).toHaveLength(ROLES * YEARS);
    expect(new Set(layers.map((l) => l.id)).size).toBe(layers.length);
    expect(layerIdsFor(entry)).toHaveLength(layers.length);
  });

  it('shows every layer when every state is selected, and none when none is', () => {
    expect(layerIdsForSelection(entry, ALL)).toHaveLength(ROLES * YEARS);
    expect(layerIdsForSelection(entry, new Set<ChangeType>())).toEqual([]);
  });

  it('gives the first cohort everything from its year back, so a pre-range baseline is kept', () => {
    // Forest's canopy baseline carries valid_from 2000 under a range starting in 2001. An `==`
    // test on the first cohort would put it in no cohort at all and the extent view would be empty.
    const { layers } = layersFor(entry, 2013, ALL);
    const first = layers.find((l) => l.id === `trace-${entry.id}-fill-loss-2001`);
    const later = layers.find((l) => l.id === `trace-${entry.id}-fill-loss-2014`);

    expect(JSON.stringify(first?.filter)).toContain('"<="');
    expect(JSON.stringify(later?.filter)).toContain('"=="');
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

  it('shows cohorts up to the year and hides the rest', () => {
    const { layers } = layersFor(entry, 2010, ALL);

    for (const layer of layers) {
      const cohort = Number(layer.id.slice(-4));
      expect(opacityOf(layer) > 0).toBe(cohort <= 2010);
    }
  });

  it('draws a shown cohort at its role’s own opacity, not a substitute', () => {
    const { layers } = layersFor(entry, 2025, ALL);
    const shown = (role: string) =>
      opacityOf(layers.find((l) => l.id === `trace-${entry.id}-${role}-2010`)!);

    expect(shown('fill-loss')).toBe(0.75);
    expect(shown('pattern-loss')).toBe(0.9);
    expect(shown('outline-loss')).toBe(0.85);
    expect(shown('cleared-fill')).toBe(1);
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
  it('keeps every extent cohort beneath every cleared cohort', () => {
    // Cleared patches are painted *over* the extent to cut holes in it. Interleaving roles and
    // cohorts would scatter that and the holes would stop cutting.
    const ids = layersFor(entry, 2013, ALL).layers.map((l) => l.id);
    const lastExtent = ids.reduce((last, id, i) => (id.includes('-extent-') ? i : last), -1);
    const firstCleared = ids.findIndex((id) => id.includes('-cleared-'));

    expect(lastExtent).toBeGreaterThanOrEqual(0);
    expect(firstCleared).toBeGreaterThan(lastExtent);
  });

  it('keeps each role’s cohorts contiguous', () => {
    const roles = layersFor(entry, 2013, ALL).layers.map((l) => roleOf(l.id));

    // A role that reappears after another role has intervened means the order was interleaved.
    expect(new Set(roles).size).toBe(ROLES);
    expect(roles).toEqual([...new Set(roles)].flatMap((r) => Array<string>(YEARS).fill(r)));
  });
});

describe('hit-testing', () => {
  it('offers only the years actually on screen', () => {
    // Later cohorts are still on the map at zero opacity, and queryRenderedFeatures reads geometry
    // rather than paint — so querying everything would let a click land on loss that has not
    // happened yet and open a readout describing it.
    const hittable = layerIdsForYear(entry, 2010);

    expect(hittable).toHaveLength(ROLES * 10);
    expect(hittable.every((id) => Number(id.slice(-4)) <= 2010)).toBe(true);
  });
});

describe('cost of a step', () => {
  it('is constant, so playback cannot slow down as it runs', () => {
    // The regression this whole model replaced: filtering one layer meant each step re-tessellated
    // every feature from the start of the range to the current year, so the work grew from 2,656
    // features at 2001 to 91,088 at 2025 and playback visibly decelerated.
    const applied = new Map<string, number>();
    const apply = (year: number) => {
      let writes = 0;
      for (const [id, , opacity] of opacityUpdatesFor(entry, year)) {
        if (applied.get(id) === opacity) continue;
        applied.set(id, opacity);
        writes++;
      }
      return writes;
    };

    apply(entry.temporal.start);

    const perStep: number[] = [];
    for (let year = entry.temporal.start + 1; year <= entry.temporal.end; year += 1) {
      perStep.push(apply(year));
    }

    // One cohort per role turns on, whatever the year — never a function of what came before it.
    expect(perStep).toEqual(Array<number>(YEARS - 1).fill(ROLES));
  });

  it('touches every cohort on first paint, so none is left at a stale opacity', () => {
    const applied = new Map<string, number>();
    let writes = 0;
    for (const [id, , opacity] of opacityUpdatesFor(entry, 2025)) {
      if (applied.get(id) === opacity) continue;
      applied.set(id, opacity);
      writes++;
    }

    expect(writes).toBe(ROLES * YEARS);
  });
});

describe('roles are derived from what the tileset holds', () => {
  const rolesOf = (e: DomainManifestEntry) => [
    ...new Set(layerIdsFor(e).map((id) => id.replace(`trace-${e.id}-`, '').replace(/-\d{4}$/, ''))),
  ];

  it('builds no extent or cleared layers for a domain that has no extent', () => {
    // The table used to be fixed at seven roles, so water built extent and cleared cohorts for a
    // baseline it does not have: four roles across 38 years, 152 layers that could never match a
    // feature and were switched between as if they might.
    const roles = rolesOf(water);

    expect(roles.some((role) => role.startsWith('extent-'))).toBe(false);
    expect(roles.some((role) => role.startsWith('cleared-'))).toBe(false);
  });

  it('gives every state a fill and an outline, and a pattern only where the style has one', () => {
    expect(rolesOf(water)).toEqual([
      'fill-stable',
      'outline-stable',
      'fill-gain',
      'outline-gain',
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

  it('costs no more than the fixed table it replaced', () => {
    // Deriving the roles was not a licence to grow the layer budget: both domains land on the same
    // seven roles the hardcoded table had, so the per-step write count is unchanged.
    expect(rolesOf(entry)).toHaveLength(ROLES);
    expect(rolesOf(water)).toHaveLength(ROLES);
  });

  it('builds nothing for a manifest that never said what it holds', () => {
    // `changeTypes` is optional. A domain without it gets no controls, so building layers it can
    // never switch off would put pixels on the map with nothing to explain or remove them.
    const { changeTypes: _omitted, ...silent } = water;

    expect(layerIdsFor(silent)).toEqual([]);
  });
});

describe('which toggle shows which layer', () => {
  it('shows the cleared patches with the extent, not with the loss', () => {
    // Taking out what has gone is part of drawing a baseline honestly, not an overlay the reader
    // opts into: an extent shown without its holes claims the 2000 canopy is still standing.
    const withExtent = layerIdsForSelection(entry, new Set<ChangeType>(['extent']));
    const withLoss = layerIdsForSelection(entry, new Set<ChangeType>(['loss']));

    expect(withExtent.some((id) => id.includes('-cleared-fill-'))).toBe(true);
    expect(withLoss.some((id) => id.includes('-cleared-fill-'))).toBe(false);
    expect(withLoss.some((id) => id.includes('-fill-loss-'))).toBe(true);
  });

  it('is a visibility switch, so the layers are built either way', () => {
    // Both states' layers exist from the start and are switched with `visibility`. Adding and
    // removing them instead would refetch a tile every time a chip was pressed.
    const { layers } = layersFor(entry, 2013, new Set<ChangeType>(['loss']));
    const visibilityOf = (id: string) =>
      (layers.find((l) => l.id === id)?.layout as { visibility?: string } | undefined)?.visibility;

    expect(layers).toHaveLength(ROLES * YEARS);
    expect(visibilityOf(`trace-${entry.id}-fill-loss-2013`)).toBe('visible');
    expect(visibilityOf(`trace-${entry.id}-extent-fill-2013`)).toBe('none');
  });
});

describe('paint never reads a feature', () => {
  it('carries no data-driven colour, in either domain', () => {
    // Colour used to be a `match` over `change_type` shared by every non-extent state — the last
    // data-driven paint property in the hot path, and exactly the class of style that makes
    // MapLibre re-read tile data. Splitting the states into their own layers made every colour a
    // constant; a `step` on zoom is still allowed, because zoom is not a feature.
    for (const e of [entry, water]) {
      for (const layer of layersFor(e, 2013, all(e)).layers) {
        expect(JSON.stringify(layer.paint)).not.toContain('"get"');
      }
    }
  });
});
