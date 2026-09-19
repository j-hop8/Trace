/**
 * The colour rule, in one place.
 *
 * **Hue names the domain, always.** Blue is water, green is forest, and every state a domain can be
 * in — its cover, what stayed, what arrived, what went — is a fixed transform of that one hue.
 * There is no cross-domain change colour.
 *
 * That is a deliberate reversal. The first rule here was `domain colour = what's there; red =
 * what's gone`, and with two domains it read as intended. It does not survive being scaled: at six
 * domains a shared loss red says only that *something, somewhere* was lost, and the reader has to
 * go back to the legend to find out what. The question a map of many domains has to answer first is
 * "what am I looking at", so hue is spent on that, and the state is carried by lightness, by
 * saturation, and — for loss — by texture.
 *
 * Loss is still never signalled by colour alone (A5): it keeps the hatch, and with no shared red to
 * lean on, that pattern is now load-bearing rather than a belt-and-braces addition.
 *
 * This module is the only place in `web/` allowed to contain a colour literal for data.
 */

import type { ChangeType } from '@/types/feature';

/**
 * The three anchors every ramp is mixed against.
 *
 * `MUTE` is a warm grey drawn from the basemap's own chrome family (`map/basemap/style.json` runs
 * `#2a2724` to `#a9a094`), so a stable feature recedes *toward the ground it sits on* rather than
 * toward a cold neutral that would read as its own third hue.
 */
const INK = '#000000';
const PAPER = '#ffffff';
const MUTE = '#7d7a74';

/** How a feature is drawn. Colour and its accessible pairing always travel together. */
export interface FeatureStyle {
  /** Fill colour. */
  color: string;
  /**
   * The colour to draw with when the *line is standing in for the patch* — below the zoom at which
   * a 30 m feature is large enough to fill.
   *
   * Usually the fill colour, and for every state but one it is exactly that. Loss is the exception,
   * and it is why this channel exists at all: under a domain ramp, loss is the deepest member of
   * its hue, and this basemap's ground is `#2a2724` over a `#0a0a09` background. A hairline in
   * forest's loss green (`#093a1b`) on that ground is invisible — so at island view, the zoom the
   * map opens at, forest loss would simply not be there. Drawing the sub-pixel mark at the bright
   * end of the same hue keeps the domain reading intact and the feature findable.
   */
  mark: string;
  /** Outline colour, for crisp edges once the fill is doing the work. */
  stroke: string;
  /**
   * Fill pattern paired with the colour. `null` means a solid fill is correct.
   *
   * Only loss carries one. It is the state whose meaning cannot be allowed to depend on colour, and
   * under a per-domain ramp it is also the state that no longer has a hue of its own to announce
   * itself with.
   */
  pattern: 'hatch' | null;
}

/**
 * The complete style for a feature — the only drawing decision in the app.
 *
 * A5 requires that loss is never signalled by colour alone. This returns one object rather than
 * exposing colour and pattern as separate calls, because a split API lets a caller take the loss
 * colour and skip the hatch, which is precisely the accessibility failure the rule exists to stop.
 * Making that impossible is a type-level guarantee; a convention that callers "should also call
 * patternFor" is not.
 *
 * Every branch returns a transform of `hue` and nothing else, so two domains can never come back
 * wearing the same colour for the same state — which is the whole point of the ramp.
 *
 * @param hue        The domain's own colour, from the manifest — never hardcoded here.
 * @param changeType Which state of that domain is being drawn.
 */
export function styleFor(hue: string, changeType: ChangeType): FeatureStyle {
  switch (changeType) {
    // The cover kind — what was there in the year — at full strength, exactly as the manifest
    // names it. The change kind's three states are all transforms of this.
    case 'cover': {
      return { color: hue, mark: hue, stroke: mix(hue, INK, 0.25), pattern: null };
    }
    // Present throughout, so it is the thing that did *not* happen. Pulled toward the basemap's own
    // grey to sit back behind the states that did.
    case 'stable': {
      const color = mix(hue, MUTE, 0.55);
      return { color, mark: color, stroke: mix(color, INK, 0.25), pattern: null };
    }
    // More of the subject than there was: the same hue, lifted. Brighter than the cover it adds
    // to, so a domain carrying both reads as baseline-plus-increment rather than two flat masses.
    case 'gain': {
      const color = mix(hue, PAPER, 0.32);
      return { color, mark: color, stroke: mix(hue, INK, 0.15), pattern: null };
    }
    // Gone: the hue emptied out almost to black, which is what "subtracted" looks like when the
    // subject's own colour is the only vocabulary available. The edge goes the other way — see
    // `mark` — so the patch is still findable when it is too small to fill.
    case 'loss': {
      const edge = mix(hue, PAPER, 0.45);
      return { color: mix(hue, INK, 0.55), mark: edge, stroke: edge, pattern: 'hatch' };
    }
  }
}

/**
 * Mix a hex colour toward another. Kept local so no colour utility library is needed.
 *
 * Hues reach this from `data/domains.json` — a generated file, not a compile-time constant — so a
 * malformed value is reachable at runtime. Rather than emit `#NaNNaNNaN` (which MapLibre rejects,
 * taking the whole layer down with it), fall back to the input unchanged: a slightly-wrong colour
 * is a far better failure than a missing layer.
 */
function mix(hex: string, target: string, amount: number): string {
  const from = channels(hex);
  const to = channels(target);
  if (!from || !to) return hex;

  const blend = (a: number, b: number) =>
    Math.round(a + (b - a) * amount)
      .toString(16)
      .padStart(2, '0');

  return `#${blend(from[0], to[0])}${blend(from[1], to[1])}${blend(from[2], to[2])}`;
}

/** `#15803d` or `#153` → `[21, 128, 61]`. `null` for anything that is not a hex colour. */
function channels(hex: string): [number, number, number] | null {
  const value = hex.replace('#', '');
  const full =
    value.length === 3
      ? value
          .split('')
          .map((c) => c + c)
          .join('')
      : value;

  if (!/^[0-9a-f]{6}$/i.test(full)) return null;

  return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
  ];
}
