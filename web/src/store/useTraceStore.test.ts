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
