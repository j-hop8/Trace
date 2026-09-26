/**
 * `loadingKinds` — which kinds of each switched-on domain have nothing on screen yet.
 *
 * The map owns *setting* this (it is the only thing that knows whether a source's tiles have
 * arrived), so what is worth pinning down here is the half the map does not own: that switching a
 * domain off stops it claiming to be loading. Miss that and the domain comes back wearing the badge
 * until some unrelated tile event happens to correct it.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { useTraceStore } from '@/store/useTraceStore';
import type { DomainId, Kind } from '@/types/feature';

const pristine = useTraceStore.getState();

const ids = (set: Iterable<DomainId>) => [...set].sort();

/** The report as plain data, for comparing: each domain's missing kinds, sorted. */
const report = () =>
  Object.fromEntries(
    [...useTraceStore.getState().loadingKinds].map(([domain, kinds]) => [
      domain,
      [...kinds].sort(),
    ]),
  );

const kinds = (...list: Kind[]) => new Set<Kind>(list);

beforeEach(() => {
  // Replace rather than merge, so one test's leftovers cannot decide another's outcome.
  useTraceStore.setState(pristine, true);
});

describe('loadingKinds', () => {
  it('starts empty — nothing is loading before anything is asked for', () => {
    expect(useTraceStore.getState().loadingKinds.size).toBe(0);
  });

  it('is whatever the map last reported', () => {
    useTraceStore.getState().setLoadingKinds(
      new Map([
        ['forest', kinds('cover', 'change')],
        ['water', kinds('change')],
      ]),
    );

    expect(report()).toEqual({ forest: ['change', 'cover'], water: ['change'] });
  });

  it('clears when the map reports the tiles arrived', () => {
    useTraceStore.getState().setLoadingKinds(new Map([['forest', kinds('cover')]]));
    useTraceStore.getState().setLoadingKinds(new Map());

    expect(useTraceStore.getState().loadingKinds.size).toBe(0);
  });

  it('drops a domain that is switched off while still loading', () => {
    useTraceStore.setState({ activeDomains: new Set(['forest']) });
    useTraceStore.getState().setLoadingKinds(new Map([['forest', kinds('cover', 'change')]]));

    useTraceStore.getState().toggleDomain('forest');

    expect(useTraceStore.getState().activeDomains.has('forest')).toBe(false);
    expect(useTraceStore.getState().loadingKinds.has('forest')).toBe(false);
  });

  it('leaves the other domains alone when one is switched off', () => {
    useTraceStore.setState({ activeDomains: new Set(['forest', 'water']) });
    useTraceStore.getState().setLoadingKinds(
      new Map([
        ['forest', kinds('change')],
        ['water', kinds('change')],
      ]),
    );

    useTraceStore.getState().toggleDomain('forest');

    expect(report()).toEqual({ water: ['change'] });
  });

  it('marks every kind of every domain loading the moment the manifest lands', () => {
    // Not a guess: the layers are held back until the basemap has painted, so at this instant they
    // really are all switched on and showing nothing — and each kind will arrive on its own.
    useTraceStore.getState().setManifest({
      version: 3,
      domains: [
        { id: 'forest', changeTypes: ['cover', 'loss'], temporal: { start: 2001, end: 2025 } },
        { id: 'water', changeTypes: ['gain', 'loss'], temporal: { start: 1984, end: 2024 } },
      ],
    } as never);

    expect(report()).toEqual({ forest: ['change', 'cover'], water: ['change'] });
  });

  it('does not mark a domain as loading just because it was switched on', () => {
    // Only the map can say that, and it says so through `setLoadingKinds`. Guessing here would
    // badge a domain whose tiles are already cached and arrive in the same frame.
    useTraceStore.getState().toggleDomain('forest');

    expect(useTraceStore.getState().activeDomains.has('forest')).toBe(true);
    expect(useTraceStore.getState().loadingKinds.has('forest')).toBe(false);
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
  version: 3,
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
    useTraceStore.getState().setLoadingKinds(
      new Map([
        ['forest', kinds('change')],
        ['water', kinds('change')],
      ]),
    );

    useTraceStore.getState().toggleChangeType('forest', 'cover');
    useTraceStore.getState().toggleChangeType('forest', 'loss');

    expect(ids(useTraceStore.getState().loadingKinds.keys())).toEqual(['water']);
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

/**
 * `toggleKind` — the group heading's press: every state of one kind at once.
 */
describe('toggleKind', () => {
  beforeEach(() => {
    useTraceStore.getState().setManifest(manifest);
  });

  it('switches every state of a kind off when all are on, and back on otherwise', () => {
    useTraceStore.getState().toggleKind('water', 'change');
    expect(typesOf('water')).toEqual([]);
    expect(useTraceStore.getState().activeDomains.has('water')).toBe(false);

    // Bringing the domain back restores everything; then a partial selection flips to all-on.
    useTraceStore.getState().toggleDomain('water');
    useTraceStore.getState().toggleChangeType('water', 'gain');
    expect(typesOf('water')).toEqual(['loss', 'stable']);

    useTraceStore.getState().toggleKind('water', 'change');
    expect(typesOf('water')).toEqual(['gain', 'loss', 'stable']);
  });

  it('leaves the other kind untouched', () => {
    useTraceStore.getState().toggleKind('forest', 'change');
    expect(typesOf('forest')).toEqual(['cover']);
    expect(useTraceStore.getState().activeDomains.has('forest')).toBe(true);

    useTraceStore.getState().toggleKind('forest', 'change');
    expect(typesOf('forest')).toEqual(['cover', 'loss']);
  });

  it('switches the domain off when the last kind goes, like the last chip does', () => {
    useTraceStore.getState().toggleKind('forest', 'change');
    useTraceStore.getState().toggleKind('forest', 'cover');
    expect(typesOf('forest')).toEqual([]);
    expect(useTraceStore.getState().activeDomains.has('forest')).toBe(false);
  });

  it('does nothing for a kind the domain has no states of', () => {
    // The heading is never drawn for an empty kind, but the action must still be safe.
    useTraceStore.getState().toggleKind('water', 'cover');
    expect(typesOf('water')).toEqual(['gain', 'loss', 'stable']);
    expect(useTraceStore.getState().activeDomains.has('water')).toBe(true);
  });
});

/**
 * Backdrops — measured fields over the whole island, such as a temperature or a density.
 *
 * Two things to pin down: that none is on when the map opens, since the default exists for the
 * comparison of what is drawn over the ground; and that at most one is ever on, since a second
 * field over the whole island is a wash over a wash.
 */
describe('backdrops', () => {
  const measure = { key: 'v', unit: 'u', label: { en: 'v', zh: 'v' }, breaks: [0], readout: [] };
  const withBackdrops = {
    version: 4,
    domains: [
      { id: 'forest', changeTypes: ['cover', 'loss'], temporal: { start: 2001, end: 2025 } },
      { id: 'temperature', changeTypes: ['level'], measure, temporal: { start: 1960, end: 2023 } },
      { id: 'population', changeTypes: ['level'], measure, temporal: { start: 1975, end: 2024 } },
    ],
  } as never;

  const active = () => ids(useTraceStore.getState().activeDomains);

  beforeEach(() => {
    useTraceStore.getState().setManifest(withBackdrops);
  });

  it('opens with every backdrop off and every other domain on', () => {
    expect(active()).toEqual(['forest']);
    // Not loading, either: a domain that is off has nothing on its way.
    expect(report()).toEqual({ forest: ['change', 'cover'] });
    // Still seeded with its state, so switching it on shows it.
    expect(typesOf('temperature')).toEqual(['level']);
  });

  it('keeps one backdrop at a time, and leaves the other domains alone', () => {
    useTraceStore.getState().toggleDomain('temperature');
    expect(active()).toEqual(['forest', 'temperature']);

    useTraceStore.getState().toggleDomain('population');
    expect(active()).toEqual(['forest', 'population']);

    useTraceStore.getState().toggleDomain('population');
    expect(active()).toEqual(['forest']);
  });

  it('widens the slider’s range to a backdrop’s own years once it is chosen', () => {
    useTraceStore.getState().toggleDomain('temperature');
    useTraceStore.getState().setYear(1960);
    useTraceStore.getState().toggleDomain('population');
    // Temperature went off with its 1960 start, so the year is held inside what is left.
    expect(useTraceStore.getState().year).toBe(1975);
  });
});
