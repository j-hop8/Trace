/**
 * `loadingDomains` — which switched-on domains have nothing on screen yet.
 *
 * The map owns *setting* this (it is the only thing that knows whether a source's tiles have
 * arrived), so what is worth pinning down here is the half the map does not own: that switching a
 * domain off stops it claiming to be loading. Miss that and the domain comes back wearing the badge
 * until some unrelated tile event happens to correct it.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { useTraceStore } from '@/store/useTraceStore';
import type { DomainId } from '@/types/feature';

const pristine = useTraceStore.getState();

const ids = (set: Set<DomainId>) => [...set].sort();

beforeEach(() => {
  // Replace rather than merge, so one test's leftovers cannot decide another's outcome.
  useTraceStore.setState(pristine, true);
});

describe('loadingDomains', () => {
  it('starts empty — nothing is loading before anything is asked for', () => {
    expect(useTraceStore.getState().loadingDomains.size).toBe(0);
  });

  it('is whatever the map last reported', () => {
    useTraceStore.getState().setLoadingDomains(new Set(['forest', 'water']));

    expect(ids(useTraceStore.getState().loadingDomains)).toEqual(['forest', 'water']);
  });

  it('clears when the map reports the tiles arrived', () => {
    useTraceStore.getState().setLoadingDomains(new Set(['forest']));
    useTraceStore.getState().setLoadingDomains(new Set());

    expect(useTraceStore.getState().loadingDomains.size).toBe(0);
  });

  it('drops a domain that is switched off while still loading', () => {
    useTraceStore.setState({ activeDomains: new Set(['forest']) });
    useTraceStore.getState().setLoadingDomains(new Set(['forest']));

    useTraceStore.getState().toggleDomain('forest');

    expect(useTraceStore.getState().activeDomains.has('forest')).toBe(false);
    expect(useTraceStore.getState().loadingDomains.has('forest')).toBe(false);
  });

  it('leaves the other domains alone when one is switched off', () => {
    useTraceStore.setState({ activeDomains: new Set(['forest', 'water']) });
    useTraceStore.getState().setLoadingDomains(new Set(['forest', 'water']));

    useTraceStore.getState().toggleDomain('forest');

    expect(ids(useTraceStore.getState().loadingDomains)).toEqual(['water']);
  });

  it('marks every domain loading the moment the manifest lands', () => {
    // Not a guess: the layers are held back until the basemap has painted, so at this instant they
    // really are all switched on and showing nothing.
    useTraceStore.getState().setManifest({
      version: 1,
      domains: [
        { id: 'forest', temporal: { start: 2001, end: 2025 } },
        { id: 'water', temporal: { start: 1984, end: 2024 } },
      ],
    } as never);

    expect(ids(useTraceStore.getState().loadingDomains)).toEqual(['forest', 'water']);
  });

  it('does not mark a domain as loading just because it was switched on', () => {
    // Only the map can say that, and it says so through `setLoadingDomains`. Guessing here would
    // badge a domain whose tiles are already cached and arrive in the same frame.
    useTraceStore.getState().toggleDomain('forest');

    expect(useTraceStore.getState().activeDomains.has('forest')).toBe(true);
    expect(useTraceStore.getState().loadingDomains.has('forest')).toBe(false);
  });
});

/**
 * `selectedTypes` — which of each domain's states the reader has asked to see.
 *
 * This replaced an exclusive `change`/`extent` view switch, and the two things worth pinning down
 * are the ones the exclusivity used to make impossible: that the states are independent, and that
 * the one state the old switch could not represent — none of them — resolves to the domain being
 * off rather than to a lit toggle over an empty map.
 */
const manifest = {
  version: 1,
  domains: [
    {
      id: 'forest',
      changeTypes: ['cover', 'loss'],
      temporal: { start: 2001, end: 2025 },
    },
    {
      id: 'water',
      changeTypes: ['gain', 'loss', 'stable'],
      temporal: { start: 1984, end: 2021 },
    },
  ],
} as never;

const typesOf = (id: DomainId) => [...useTraceStore.getState().selectedTypesFor(id)].sort();

describe('selectedTypes', () => {
  beforeEach(() => {
    useTraceStore.getState().setManifest(manifest);
  });

  it('opens with every state of every domain showing', () => {
    // The point of the map is the comparison, and a reader who has to switch the canopy on before
    // the losses have anything to be losses *of* has to already know what the map is for.
    expect(typesOf('forest')).toEqual(['cover', 'loss']);
    expect(typesOf('water')).toEqual(['gain', 'loss', 'stable']);
  });

  it('seeds a domain only with states its tileset actually holds', () => {
    // Never a fixed list: water has no extent, so no extent control and no extent layers.
    expect(typesOf('water')).not.toContain('cover');
  });

  it('switches one state without touching the others', () => {
    // The whole reason for the change. The previous control could show forest's canopy or its
    // losses but never both, which is the one comparison the map exists to make.
    useTraceStore.getState().toggleChangeType('forest', 'cover');

    expect(typesOf('forest')).toEqual(['loss']);
    expect(useTraceStore.getState().activeDomains.has('forest')).toBe(true);
  });

  it('leaves the other domains alone', () => {
    useTraceStore.getState().toggleChangeType('forest', 'loss');

    expect(typesOf('water')).toEqual(['gain', 'loss', 'stable']);
  });

  it('switches the domain off when its last state is un-checked', () => {
    // A lit toggle over an empty map is indistinguishable from a layer with no data for the year.
    // Making the state unreachable beats inventing a third thing for the badge to say.
    useTraceStore.getState().toggleChangeType('forest', 'cover');
    useTraceStore.getState().toggleChangeType('forest', 'loss');

    expect(typesOf('forest')).toEqual([]);
    expect(useTraceStore.getState().activeDomains.has('forest')).toBe(false);
  });

  it('brings a domain back showing everything, however it went dark', () => {
    // Without this, a domain switched off from its state chips returns still holding the empty set
    // that switched it off — on, and drawing nothing.
    useTraceStore.getState().toggleChangeType('forest', 'cover');
    useTraceStore.getState().toggleChangeType('forest', 'loss');

    useTraceStore.getState().toggleDomain('forest');

    expect(typesOf('forest')).toEqual(['cover', 'loss']);
  });

  it('stops claiming to load a domain its last state just closed', () => {
    useTraceStore.getState().setLoadingDomains(new Set(['forest', 'water']));

    useTraceStore.getState().toggleChangeType('forest', 'cover');
    useTraceStore.getState().toggleChangeType('forest', 'loss');

    expect(ids(useTraceStore.getState().loadingDomains)).toEqual(['water']);
  });

  it('drops a readout describing a state that is no longer drawn', () => {
    const selected = {
      properties: { domain: 'forest', change_type: 'loss' },
      lngLat: { lng: 121, lat: 24 },
    } as never;
    useTraceStore.getState().select(selected);

    useTraceStore.getState().toggleChangeType('forest', 'loss');

    expect(useTraceStore.getState().selected).toBeNull();
  });

  it('keeps a readout whose own state is untouched', () => {
    const selected = {
      properties: { domain: 'forest', change_type: 'loss' },
      lngLat: { lng: 121, lat: 24 },
    } as never;
    useTraceStore.getState().select(selected);

    useTraceStore.getState().toggleChangeType('forest', 'cover');
    useTraceStore.getState().toggleChangeType('water', 'gain');

    expect(useTraceStore.getState().selected).toBe(selected);
  });

  it('re-clamps the year when the last state closes a domain', () => {
    // Same consequence as switching the domain off by its pill: the slider's bounds moved, and an
    // unclamped year would leave the thumb parked at 2001 while still asking the map for 1990.
    useTraceStore.getState().setYear(1990);
    useTraceStore.getState().toggleChangeType('water', 'gain');
    useTraceStore.getState().toggleChangeType('water', 'loss');
    useTraceStore.getState().toggleChangeType('water', 'stable');

    expect(useTraceStore.getState().activeDomains.has('water')).toBe(false);
    expect(useTraceStore.getState().year).toBe(2001);
  });

  it('ignores a domain the manifest has never heard of', () => {
    useTraceStore.getState().toggleChangeType('coast', 'loss');

    expect(useTraceStore.getState().selectedTypes.has('coast')).toBe(false);
  });
});
