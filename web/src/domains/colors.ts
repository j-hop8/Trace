/**
 * The colour rule, in one place.
 *
 * Two layers of meaning (proposal A2):
 *   - Domain identity  → where a subject *is*. Blue = water, green = forest, and so on.
 *   - Change signal    → what *happened*. Loss is a single warm hue shared by every domain.
 *
 * `domain colour = what's there; red = what's gone` is the rule that keeps the map readable at
 * any number of domains. It only holds if it is applied in exactly one place — so this module is
 * the only place in `web/` allowed to contain a colour literal for data.
 */

import type { ChangeType } from '@/types/feature';

/**
 * Loss — the universal cross-domain change signal.
 *
 * Shifted toward orange rather than a pure red. Under deuteranopia a pure red sits close to the
 * forest green; this hue separates from it by lightness as well as chroma. Colour is still never
 * the only signal — see `patternFor`.
 */
export const LOSS = '#e04b28';

/** Stable — present in both epochs. Muted so it recedes behind the thing that changed. */
export const STABLE = '#94a3b8';

/**
 * The colour a feature should be drawn in.
 *
 * @param hue        The domain's extent colour, from the manifest — never hardcoded here.
 * @param changeType The universal change signal.
 */
export function colorFor(hue: string, changeType: ChangeType): string {
  switch (changeType) {
    case 'loss':
      return LOSS;
    // Gain is the domain colour returning — the subject coming back is shown as the subject.
    case 'gain':
      return hue;
    case 'stable':
      return STABLE;
  }
}

/**
 * Fill pattern paired with the colour.
 *
 * A5 requires that loss is never signalled by colour alone. Returning the pattern from the same
 * function that decides colour is what stops the two from drifting apart: you cannot pick a
 * colour here without also being handed its accessible pairing.
 *
 * `null` means a solid fill is correct — stable and gain are not the states a colourblind user
 * would misread as each other.
 */
export function patternFor(changeType: ChangeType): 'hatch' | null {
  return changeType === 'loss' ? 'hatch' : null;
}

/** Outline colour. Slightly darkened fill, for crisp edges against the muted basemap. */
export function strokeFor(hue: string, changeType: ChangeType): string {
  return changeType === 'loss' ? '#a3300f' : darken(hue, 0.25);
}

/**
 * Mix a hex colour toward black. Kept local so no colour utility library is needed.
 *
 * Hues reach this from `data/domains.json` — a generated file, not a compile-time constant — so
 * a malformed value is reachable at runtime. Rather than emit `#NaNNaNNaN` (which MapLibre
 * rejects, taking the whole layer down with it), fall back to the input unchanged: a
 * slightly-wrong outline is a far better failure than a missing layer.
 */
function darken(hex: string, amount: number): string {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;

  if (!/^[0-9a-f]{6}$/i.test(full)) return hex;

  const channels = [0, 2, 4].map((i) => {
    const channel = Number.parseInt(full.slice(i, i + 2), 16);
    return Math.round(channel * (1 - amount));
  });

  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}
