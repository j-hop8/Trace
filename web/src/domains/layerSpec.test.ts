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
  layerIdsForMode,
  layerIdsForYear,
  layersFor,
  opacityUpdatesFor,
} from '@/domains/layerSpec';
import type { DomainManifestEntry } from '@/domains/manifest';

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

const YEARS = 25;
const ROLES = 7;

/** `trace-forest-cleared-fill-2013` → `cleared-fill`. */
const roleOf = (id: string) => id.replace(`trace-${entry.id}-`, '').replace(/-\d{4}$/, '');

const opacityOf = (layer: { type: string; paint?: unknown }) => {
  const paint = (layer.paint ?? {}) as Record<string, unknown>;
  return (layer.type === 'fill' ? paint['fill-opacity'] : paint['line-opacity']) as number;
};

describe('cohorts', () => {
  it('spans exactly the range the manifest claims', () => {
    expect(cohortYears(entry)).toHaveLength(YEARS);
    expect(cohortYears(entry)[0]).toBe(2001);
    expect(cohortYears(entry).at(-1)).toBe(2025);
  });

  it('builds one layer per role per year, with unique ids', () => {
    const { layers } = layersFor(entry, 2013, 'change');

    expect(layers).toHaveLength(ROLES * YEARS);
    expect(new Set(layers.map((l) => l.id)).size).toBe(layers.length);
    expect(layerIdsFor(entry)).toHaveLength(layers.length);
  });

  it('splits the two views without dropping a layer', () => {
    const change = layerIdsForMode(entry, 'change');
    const extent = layerIdsForMode(entry, 'extent');

    expect(change.length + extent.length).toBe(ROLES * YEARS);
    expect(change.filter((id) => extent.includes(id))).toEqual([]);
  });

  it('gives the first cohort everything from its year back, so a pre-range baseline is kept', () => {
    // Forest's canopy baseline carries valid_from 2000 under a range starting in 2001. An `==`
    // test on the first cohort would put it in no cohort at all and the extent view would be empty.
    const { layers } = layersFor(entry, 2013, 'change');
    const first = layers.find((l) => l.id === `trace-${entry.id}-fill-2001`);
    const later = layers.find((l) => l.id === `trace-${entry.id}-fill-2014`);

    expect(JSON.stringify(first?.filter)).toContain('"<="');
    expect(JSON.stringify(later?.filter)).toContain('"=="');
  });
});

describe('the year is opacity, never a filter', () => {
  it('selects the same features whatever year is being shown', () => {
    // The load-bearing property. A filter that changes when the slider moves makes MapLibre
    // re-parse every loaded tile in the worker, which is what this design exists to avoid.
    const at2010 = layersFor(entry, 2010, 'change');
    const at2020 = layersFor(entry, 2020, 'change');

    const filters = (spec: typeof at2010) => spec.layers.map((l) => [l.id, l.filter]);

    expect(filters(at2010)).toEqual(filters(at2020));
  });

  it('shows cohorts up to the year and hides the rest', () => {
    const { layers } = layersFor(entry, 2010, 'change');

    for (const layer of layers) {
      const cohort = Number(layer.id.slice(-4));
      expect(opacityOf(layer) > 0).toBe(cohort <= 2010);
    }
  });

  it('draws a shown cohort at its role’s own opacity, not a substitute', () => {
    const { layers } = layersFor(entry, 2025, 'change');
    const shown = (role: string) =>
      opacityOf(layers.find((l) => l.id === `trace-${entry.id}-${role}-2010`)!);

    expect(shown('fill')).toBe(0.75);
    expect(shown('hatch')).toBe(0.9);
    expect(shown('outline')).toBe(0.85);
    expect(shown('cleared-fill')).toBe(1);
  });

  it('appears instantly, so a year is never shown half-drawn', () => {
    // MapLibre's default 300ms fade would still be running two years later at playback speed,
    // leaving the map mid-transition while the readout named the year outright.
    const { layers } = layersFor(entry, 2010, 'change');

    for (const layer of layers) {
      const paint = layer.paint as Record<string, unknown>;
      const key = layer.type === 'fill' ? 'fill-opacity' : 'line-opacity';
      expect(paint[`${key}-transition`]).toEqual({ duration: 0, delay: 0 });
    }
  });

  it('changes nothing but opacity across cohorts of a role', () => {
    const { layers } = layersFor(entry, 2013, 'change');
    const withoutOpacity = (layer: (typeof layers)[number]) => {
      const paint = { ...(layer.paint as Record<string, unknown>) };
      const key = layer.type === 'fill' ? 'fill-opacity' : 'line-opacity';
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
    const ids = layersFor(entry, 2013, 'extent').layers.map((l) => l.id);
    const lastExtent = ids.reduce((last, id, i) => (id.includes('-extent-') ? i : last), -1);
    const firstCleared = ids.findIndex((id) => id.includes('-cleared-'));

    expect(lastExtent).toBeGreaterThanOrEqual(0);
    expect(firstCleared).toBeGreaterThan(lastExtent);
  });

  it('keeps each role’s cohorts contiguous', () => {
    const roles = layersFor(entry, 2013, 'change').layers.map((l) => roleOf(l.id));

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
