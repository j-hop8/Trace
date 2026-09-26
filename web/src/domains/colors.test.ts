/**
 * The colour rule.
 *
 * These pin the two properties the ramp exists for and neither of which typechecking can see: that
 * hue means the domain and nothing else — so no two domains can come back wearing the same colour —
 * and that loss stays findable on a near-black basemap despite being the darkest thing the ramp
 * produces. The second is the one that would have shipped broken: it is invisible in a unit test of
 * the fill alone, and at island view the fill is not what gets drawn.
 */

import { describe, expect, it } from 'vitest';

import { rampFor, styleFor } from '@/domains/colors';
import { CHANGE_TYPE_ORDER } from '@/types/feature';

const FOREST = '#15803d';
const WATER = '#2563eb';

/** The basemap's earth fill, which every mark has to be visible against. */
const EARTH = '#2a2724';

const channels = (hex: string) =>
  [0, 2, 4].map((i) => Number.parseInt(hex.replace('#', '').slice(i, i + 2), 16));

/** WCAG relative luminance, for asserting "lighter than" rather than eyeballing it. */
const luminance = (hex: string) => {
  const [r, g, b] = channels(hex).map((c) => {
    const channel = c / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

const contrast = (a: string, b: string) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
};

describe('hue names the domain', () => {
  it('never gives two domains the same colour for the same state', () => {
    // The whole point of the change. The previous rule sent every domain's loss to one shared red,
    // which at two domains read as "the universal change signal" and at six reads as "something,
    // somewhere, was lost" — the hue stops saying *what*.
    for (const changeType of CHANGE_TYPE_ORDER) {
      const forest = styleFor(FOREST, changeType);
      const water = styleFor(WATER, changeType);

      expect(forest.color).not.toBe(water.color);
      expect(forest.mark).not.toBe(water.mark);
      expect(forest.stroke).not.toBe(water.stroke);
    }
  });

  it('emits no colour that two different domains could both reach', () => {
    // Stronger than the above and the property that actually matters: the palettes are disjoint, so
    // there is no colour anywhere on the map that two domains could both be wearing.
    //
    // Within one domain colours repeat by design — `mark` is the fill for every state that is not
    // loss, and loss's mark and stroke are the same bright edge — so this compares the two
    // domains' sets rather than counting all twenty-four values.
    const paletteFor = (hue: string) =>
      new Set(
        CHANGE_TYPE_ORDER.flatMap((changeType) => {
          const style = styleFor(hue, changeType);
          return [style.color, style.mark, style.stroke];
        }),
      );

    const forest = paletteFor(FOREST);
    const water = paletteFor(WATER);

    expect([...forest].filter((colour) => water.has(colour))).toEqual([]);
  });

  it('draws a cover as the domain hue itself, untouched', () => {
    expect(styleFor(FOREST, 'cover').color).toBe(FOREST);
    expect(styleFor(WATER, 'cover').color).toBe(WATER);
  });
});

describe('loss', () => {
  it('is always paired with a pattern, and is the only state that is', () => {
    // A5: loss is never signalled by colour alone. With no shared red left to lean on, the hatch is
    // load-bearing rather than a second opinion.
    for (const hue of [FOREST, WATER]) {
      expect(styleFor(hue, 'loss').pattern).toBe('hatch');

      for (const changeType of CHANGE_TYPE_ORDER) {
        if (changeType === 'loss') continue;
        expect(styleFor(hue, changeType).pattern).toBeNull();
      }
    }
  });

  it('marks itself lighter than it fills itself', () => {
    // Why `mark` exists. Loss is the deepest member of its hue, and below the zoom where a 30 m
    // patch can be filled, the *line* is the feature — a hairline in the fill colour would be
    // invisible on this basemap, so island view would simply show no loss at all.
    for (const hue of [FOREST, WATER]) {
      const loss = styleFor(hue, 'loss');

      expect(luminance(loss.mark)).toBeGreaterThan(luminance(loss.color));
      expect(luminance(loss.stroke)).toBeGreaterThan(luminance(loss.color));
    }
  });

  it('stands out against the ground it is drawn on', () => {
    // The check the previous assertion is a proxy for. 4.5:1 is WCAG AA for text; a 1px mark at
    // island view has no more margin than text does.
    for (const hue of [FOREST, WATER]) {
      expect(contrast(styleFor(hue, 'loss').mark, EARTH)).toBeGreaterThan(4.5);
    }
  });

  it('fills as the deepest member of its own ramp', () => {
    // "Subtracted", expressed in the only vocabulary a domain ramp has. Deliberately not compared
    // against the ground: forest's loss green is a hair *lighter* than the basemap's earth, which
    // is fine — a hole is read from the hatch and the bright edge, not from being the darkest thing
    // in the frame. What has to hold is that nothing else in the domain sits below it.
    for (const hue of [FOREST, WATER]) {
      const loss = luminance(styleFor(hue, 'loss').color);

      for (const changeType of CHANGE_TYPE_ORDER) {
        if (changeType === 'loss') continue;
        expect(loss).toBeLessThan(luminance(styleFor(hue, changeType).color));
      }
    }
  });
});

describe('a malformed hue', () => {
  // Hues arrive from `data/domains.json`, a generated file, so this is reachable at runtime rather
  // than merely defensive. `#NaNNaNNaN` is rejected by MapLibre and takes the whole layer down.
  it('never produces a colour MapLibre would reject', () => {
    for (const bad of ['', 'not-a-colour', '#12', 'rgb(1,2,3)', '#15803dff']) {
      for (const changeType of CHANGE_TYPE_ORDER) {
        const style = styleFor(bad, changeType);

        expect(style.color).not.toContain('NaN');
        expect(style.mark).not.toContain('NaN');
        expect(style.stroke).not.toContain('NaN');
      }
    }
  });

  it('falls back to the input rather than to a colour from another domain', () => {
    expect(styleFor('not-a-colour', 'loss').color).toBe('not-a-colour');
  });
});

/**
 * A level's ramp: a measured value in lightness alone, because hue is already spent on the domain.
 */
describe('a level ramp', () => {
  const TEMPERATURE = '#dc2626';
  const POPULATION = '#eab308';

  /** HSL hue angle in degrees, to show a band is still its domain's colour. */
  const hueOf = (hex: string) => {
    const [r, g, b] = channels(hex).map((c) => c / 255) as [number, number, number];
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (d === 0) return NaN;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };

  it('gives one colour per band, lightest for the highest', () => {
    for (const bands of [2, 7, 8]) {
      const lights = rampFor(TEMPERATURE, bands).map((style) => luminance(style.color));
      expect(lights).toHaveLength(bands);
      for (let i = 1; i < lights.length; i += 1) expect(lights[i]).toBeGreaterThan(lights[i - 1]!);
    }
  });

  it('keeps every band its domain’s hue, with the hue itself in the middle', () => {
    const ramp = rampFor(TEMPERATURE, 7);
    expect(ramp[3]!.color).toBe(TEMPERATURE);
    for (const style of ramp)
      expect(Math.abs(hueOf(style.color) - hueOf(TEMPERATURE))).toBeLessThan(3);
  });

  it('shares no colour with another domain’s ramp or states', () => {
    const palette = (hue: string) =>
      new Set([
        ...rampFor(hue, 8).flatMap((style) => [style.color, style.stroke]),
        ...CHANGE_TYPE_ORDER.flatMap((changeType) => {
          const style = styleFor(hue, changeType);
          return [style.color, style.mark, style.stroke];
        }),
      ]);
    const hues = [FOREST, WATER, TEMPERATURE, POPULATION];
    for (const a of hues) {
      for (const b of hues) {
        if (a === b) continue;
        const theirs = palette(b);
        expect([...palette(a)].filter((colour) => theirs.has(colour))).toEqual([]);
      }
    }
  });

  it('marks nothing with a pattern — a level has no "gone" to signal', () => {
    expect(rampFor(POPULATION, 8).every((style) => style.pattern === null)).toBe(true);
  });
});
