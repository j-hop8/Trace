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

import { featureFilter } from '@maplibre/maplibre-gl-style-spec';
import { describe, expect, it } from 'vitest';

import {
  cohortYears,
  layerIdsFor,
  layerIdsForMode,
  layerIdsForYear,
  layersFor,
  opacityChannel,
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

const opacityOf = (layer: { type: 'fill' | 'line'; paint?: unknown }) =>
  opacityChannel({ type: layer.type, paint: (layer.paint ?? {}) as Record<string, unknown> }).shown;

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
      const { key } = opacityChannel({ type: layer.type, paint });
      expect(paint[`${key}-transition`]).toEqual({ duration: 0, delay: 0 });
    }
  });

  it('changes nothing but opacity across cohorts of a role', () => {
    const { layers } = layersFor(entry, 2013, 'change');
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

/**
 * Which cohort a feature actually lands in, decided by MapLibre's own filter evaluator rather
 * than by reading the filter text. The distinction matters here: the obvious `coalesce` spelling
 * of the mark year parses cleanly and *looks* right, and then silently selects nothing at all.
 */
describe('the year a mark becomes true', () => {
  /** Water's range: a domain whose loss features end rather than run open. */
  const water: DomainManifestEntry = {
    ...entry,
    id: 'water',
    label: { en: 'Water', zh: '水體' },
    hue: '#2563eb',
    changeTypes: ['gain', 'loss', 'stable'],
    temporal: { start: 1984, end: 2021 },
    tiles: { url: 'pmtiles:///data/water.pmtiles', sourceLayer: 'water' },
  };

  /** The cohorts drawing a feature at a given year — what the reader sees, opacity included. */
  const shownFor = (
    domain: DomainManifestEntry,
    year: number,
    properties: Record<string, unknown>,
  ) =>
    layersFor(domain, year, 'change')
      .layers.filter((layer) => opacityOf(layer) > 0)
      .filter((layer) =>
        featureFilter(layer.filter as never, layer.id).filter(
          { zoom: 10 } as never,
          { properties } as never,
          undefined as never,
        ),
      )
      .map((layer) => layer.id);

  it('draws a closed-ended feature from the year its change is observed, not its first year', () => {
    // A pond that was water from 1988 and dried up in 1996. Keyed on valid_from it was painted
    // loss red from 1988 — thirty-three years of a loss that had not happened yet.
    const pond = { valid_from: 1988, valid_to: 1996, change_type: 'loss' };

    expect(shownFor(water, 1988, pond)).toEqual([]);
    expect(shownFor(water, 1996, pond)).toEqual([]);
    expect(shownFor(water, 1997, pond).length).toBeGreaterThan(0);
    expect(shownFor(water, 2021, pond).length).toBeGreaterThan(0);
  });

  it('marks it at valid_to + 1, so the map never contradicts the feature’s own dates', () => {
    // valid_to is the last year the patch was *still water*, and the readout says so outright
    // ("present 1988–1996"). Marking the loss at 1996 would have the map call it gone in a year
    // its own attributes call it present.
    const pond = { valid_from: 1988, valid_to: 1996, change_type: 'loss' };

    expect(shownFor(water, 1996, pond)).toEqual([]);

    const shown = shownFor(water, 1997, pond);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((id) => id.endsWith('-1997'))).toBe(true);
  });

  it('keeps it out of hit-testing until then, so a click cannot open a future loss', () => {
    // The cohorts are all on the map at every year, drawn at zero opacity, and
    // queryRenderedFeatures reads geometry rather than paint — so the layer *names* passed to it
    // are the only thing standing between a click at 1990 and a readout for a 1997 loss.
    const pond = { valid_from: 1988, valid_to: 1996, change_type: 'loss' };
    const drawnBy = (year: number) =>
      layersFor(water, year, 'change').layers.filter((layer) =>
        featureFilter(layer.filter as never, layer.id).filter(
          { zoom: 10 } as never,
          { properties: pond } as never,
          undefined as never,
        ),
      );

    const queried = new Set(layerIdsForYear(water, 1990));
    expect(drawnBy(1990).some((layer) => queried.has(layer.id))).toBe(false);

    const later = new Set(layerIdsForYear(water, 1997));
    expect(drawnBy(1997).some((layer) => later.has(layer.id))).toBe(true);
  });

  it('leaves open-ended features exactly where they were', () => {
    // Forest carries the loss year in valid_from and no valid_to at all, so nothing about its
    // bucketing may move. This is the regression guard for the fix itself.
    const clearing = { valid_from: 2005, change_type: 'loss' };

    expect(shownFor(entry, 2004, clearing)).toEqual([]);
    expect(shownFor(entry, 2005, clearing).every((id) => id.endsWith('-2005'))).toBe(true);
    expect(shownFor(entry, 2005, clearing).length).toBeGreaterThan(0);
    expect(shownFor(entry, 2025, clearing).length).toBeGreaterThan(0);
  });

  it('keeps a feature whose mark falls outside the range, at the nearest end', () => {
    // A manifest range can be narrower than the data it describes — water's is probed live and
    // falls back to v1.4's 2021 — and a mark in no cohort at all would simply never be drawn.
    const beforeStart = { valid_from: 1970, change_type: 'gain' };
    const pastEnd = { valid_from: 1990, valid_to: 2024, change_type: 'loss' };

    expect(shownFor(water, 1984, beforeStart).every((id) => id.endsWith('-1984'))).toBe(true);
    expect(shownFor(water, 1984, beforeStart).length).toBeGreaterThan(0);

    expect(shownFor(water, 2020, pastEnd)).toEqual([]);
    expect(shownFor(water, 2021, pastEnd).every((id) => id.endsWith('-2021'))).toBe(true);
    expect(shownFor(water, 2021, pastEnd).length).toBeGreaterThan(0);
  });

  it('never lets a cohort filter mention the year being shown', () => {
    // The property the whole model rests on, restated for the new expression: adding the mark
    // year must not have made any filter a function of the slider.
    const at1990 = layersFor(water, 1990, 'change').layers.map((l) => [l.id, l.filter]);
    const at2015 = layersFor(water, 2015, 'change').layers.map((l) => [l.id, l.filter]);

    expect(at1990).toEqual(at2015);
  });
});
