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
 * Bare ground — what is left where a domain's extent has been taken away.
 *
 * The extent view answers "how much is left" by drawing the baseline and removing everything lost
 * by the selected year. MapLibre fills cannot subtract, so the lost patches are painted over the
 * extent in the colour of the ground beneath, and the holes are what remains visible.
 *
 * This tracks the basemap's `earth` fill in `map/basemap/style.json`. It is duplicated here rather
 * than imported because this module is the only place in `web/` allowed to hold a colour literal
 * for data — but if the basemap's ground changes, this changes with it, or the holes stop looking
 * like holes.
 *
 * Exact only over bare earth. The basemap paints `landcover` and `landuse` over it at partial
 * opacity, so above those a hole is a few RGB units darker than the ground beside it — visible, if
 * at all, at high zoom over valley floors. Matching them properly would mean drawing the domain
 * layers underneath those two, which would also put them over the extent fill and tint the whole
 * layer; the seam is the cheaper of the two errors.
 */
export const CLEARED = '#2a2724';

/** How a feature is drawn. Colour and its accessible pairing always travel together. */
export interface FeatureStyle {
  /** Fill colour. */
  color: string;
  /**
   * Fill pattern paired with the colour. `null` means a solid fill is correct — stable and gain
   * are not the states a colourblind user would misread as each other.
   */
  pattern: 'hatch' | null;
  /** Outline colour, for crisp edges against the muted basemap. */
  stroke: string;
}

/**
 * The complete style for a feature — the only drawing decision in the app.
 *
 * A5 requires that loss is never signalled by colour alone. This returns one object rather than
 * exposing colour and pattern as separate calls, because a split API lets a caller take the loss
 * red and skip the hatch, which is precisely the accessibility failure the rule exists to stop.
 * Making that impossible is a type-level guarantee; a convention that callers "should also call
 * patternFor" is not.
 *
 * @param hue        The domain's extent colour, from the manifest — never hardcoded here.
 * @param changeType The universal change signal.
 */
export function styleFor(hue: string, changeType: ChangeType): FeatureStyle {
  switch (changeType) {
    case 'loss':
      return { color: LOSS, pattern: 'hatch', stroke: '#a3300f' };
    // Extent and gain are both *the subject itself* — where it is, and where it came back — so
    // both take the domain hue. They stay separate cases because they answer different questions
    // and a later design may want to tell them apart; the shared colour is a decision, not an
    // accident of falling through.
    case 'extent':
      return { color: hue, pattern: null, stroke: darken(hue, 0.25) };
    case 'gain':
      return { color: hue, pattern: null, stroke: darken(hue, 0.25) };
    case 'stable':
      return { color: STABLE, pattern: null, stroke: darken(STABLE, 0.25) };
  }
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
