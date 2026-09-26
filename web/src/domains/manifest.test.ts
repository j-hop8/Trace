/**
 * `selectableTypesByKind` — the split the toggles group by.
 *
 * Small, but it is the one place the taxonomy's two kinds meet the manifest, and the toggles draw a
 * group per non-empty kind: an error here is a heading over no chips, or chips under the wrong
 * baseline.
 */

import { describe, expect, it } from 'vitest';

import {
  bandBounds,
  bandLabel,
  formatMeasure,
  formatValue,
  isBackdrop,
  kindsOf,
  selectableTypes,
  selectableTypesByKind,
} from '@/domains/manifest';
import type { DomainManifestEntry, DomainMeasure } from '@/domains/manifest';

const entry = (changeTypes?: DomainManifestEntry['changeTypes']): DomainManifestEntry => ({
  id: 'x',
  label: { en: 'X', zh: 'X' },
  hue: '#123456',
  // `exactOptionalPropertyTypes`: an absent field and an undefined one are different manifests.
  ...(changeTypes ? { changeTypes } : {}),
  temporal: { start: 2000, end: 2020 },
  source: { name: '', version: '', attribution: '', citation: '', licence: '' },
  caveat: '',
  tiles: { url: 'pmtiles:///data/x.pmtiles', sourceLayers: ['loss:2001'], detailZoom: 11 },
});

describe('selectableTypesByKind', () => {
  it('puts cover on one side and every change on the other', () => {
    expect(selectableTypesByKind(entry(['stable', 'loss', 'cover', 'gain']))).toEqual({
      level: [],
      cover: ['cover'],
      change: ['stable', 'gain', 'loss'],
    });
  });

  it('gives a domain without cover an empty cover group, not a missing key', () => {
    const byKind = selectableTypesByKind(entry(['loss', 'gain']));
    expect(byKind.cover).toEqual([]);
    expect(byKind.change).toEqual(['gain', 'loss']);
  });

  it('keeps the order selectableTypes gives, within each kind', () => {
    // Tilestats reports states alphabetically; the split must not reintroduce that accident.
    const e = entry(['loss', 'gain', 'stable', 'cover']);
    const flat = selectableTypes(e);
    const byKind = selectableTypesByKind(e);
    expect([...byKind.cover, ...byKind.change]).toEqual(flat);
  });

  it('is empty on both sides for a manifest that never said what it holds', () => {
    expect(selectableTypesByKind(entry(undefined))).toEqual({ level: [], cover: [], change: [] });
  });
});

/**
 * `kindsOf` — the kinds a domain holds, in the order they are loaded and badged.
 */
describe('kindsOf', () => {
  it('lists cover before change, whatever order the manifest gave', () => {
    expect(kindsOf(entry(['loss', 'cover', 'gain']))).toEqual(['cover', 'change']);
  });

  it('leaves out a kind the domain has no state of', () => {
    expect(kindsOf(entry(['loss', 'gain']))).toEqual(['change']);
    expect(kindsOf(entry(['cover']))).toEqual(['cover']);
  });

  it('is empty for a manifest that never said what it holds', () => {
    expect(kindsOf(entry(undefined))).toEqual([]);
  });
});

/**
 * Levels — measured values, which need their `measure` to be drawn or read at all.
 */
const anomaly: DomainMeasure = {
  key: 'temp_anomaly_c',
  unit: '°C',
  label: { en: 'Temperature anomaly', zh: '年均溫距平' },
  breaks: [-1, -0.5, 0, 0.5, 1, 1.5],
  baseline: '1991–2020 normal',
  readout: [],
};
const density: DomainMeasure = {
  key: 'density_per_km2',
  unit: 'people/km²',
  label: { en: 'Population density', zh: '人口密度' },
  breaks: [10, 30, 100, 300, 1000, 3000, 10000],
  readout: [],
};

describe('levels', () => {
  it('offers a level only with the measure that says how to draw it', () => {
    expect(selectableTypes(entry(['level']))).toEqual([]);
    expect(selectableTypes({ ...entry(['level']), measure: anomaly })).toEqual(['level']);
  });

  it('is the first kind, and the one that makes a domain a backdrop', () => {
    const measured = { ...entry(['level', 'cover']), measure: anomaly };
    expect(kindsOf(measured)).toEqual(['level', 'cover']);
    expect(isBackdrop(measured)).toBe(true);
    expect(isBackdrop(entry(['cover', 'loss']))).toBe(false);
    expect(isBackdrop(entry(['level']))).toBe(false); // no measure, nothing drawn
  });

  it('spans a band half-open, with the lowest and highest open-ended', () => {
    expect(bandBounds(anomaly, 0)).toEqual({ from: null, to: -1 });
    expect(bandBounds(anomaly, 3)).toEqual({ from: 0, to: 0.5 });
    expect(bandBounds(anomaly, 6)).toEqual({ from: 1.5, to: null });
    expect(bandBounds(anomaly, 7)).toBeNull();
    expect(bandBounds(anomaly, -1)).toBeNull();
  });

  it('writes a relative measure signed, and an absolute one plain', () => {
    expect(bandLabel(anomaly, 0)).toBe('< −1');
    expect(bandLabel(anomaly, 4)).toBe('+0.5 – +1');
    expect(bandLabel(anomaly, 6)).toBe('≥ +1.5');
    expect(bandLabel(density, 5)).toBe('1,000 – 3,000');
    expect(formatMeasure(anomaly, 0)).toBe('0');
    expect(formatMeasure(density, 10000, { compact: true })).toBe('10K');
    expect(formatValue(23.456)).toBe('23.46');
  });
});
