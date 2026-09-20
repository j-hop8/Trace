/**
 * `selectableTypesByKind` — the split the toggles group by.
 *
 * Small, but it is the one place the taxonomy's two kinds meet the manifest, and the toggles draw a
 * group per non-empty kind: an error here is a heading over no chips, or chips under the wrong
 * baseline.
 */

import { describe, expect, it } from 'vitest';

import { kindsOf, selectableTypes, selectableTypesByKind } from '@/domains/manifest';
import type { DomainManifestEntry } from '@/domains/manifest';

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
    expect(selectableTypesByKind(entry(undefined))).toEqual({ cover: [], change: [] });
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
