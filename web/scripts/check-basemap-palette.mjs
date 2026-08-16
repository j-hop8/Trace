#!/usr/bin/env node
/**
 * Enforces the one visual rule the whole colour system rests on (proposal A2):
 * the basemap may not use blue or green, because those hues are reserved to mean
 * "water domain" and "forest domain".
 *
 * This exists because the rule is invisible in review. Every off-the-shelf basemap paints its own
 * water blue and its vegetation green, so a single restyled layer left out — or one pulled in
 * later from upstream — silently reintroduces the collision, and the map still looks fine to
 * anyone not specifically looking for it. A screenshot catches that once; this catches it always.
 *
 * **Fail-closed by design.** Every value of a `*-color` property must parse into RGB, and a value
 * that cannot be parsed is an error rather than a skip. An earlier version scanned the file for
 * six-digit hex only, which meant `rgb(0,0,255)`, `#00f`, or the bare word `blue` would have
 * passed silently — a check that quietly inspects nothing is worse than no check, because CI
 * reports it as a guarantee.
 *
 * The test: R > B (not blue-shifted) and G not dominant (not green). That admits the warm ink
 * greys the style is built from and rejects the blue and green families outright.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stylePath = join(here, '..', 'src', 'map', 'basemap', 'style.json');

/** The only colour names permitted — anything else must be written as an explicit value. */
const NAMED = {
  transparent: [0, 0, 0],
  black: [0, 0, 0],
  white: [255, 255, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
};

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  l /= 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [r, g, b].map((v) => Math.round((v + m) * 255));
}

/** Parse any CSS colour MapLibre accepts into [r,g,b], or null if it is not a colour at all. */
function parseColor(value) {
  const text = String(value).trim().toLowerCase();

  if (Object.prototype.hasOwnProperty.call(NAMED, text)) return NAMED[text];

  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const d = hex[1];
    if (d.length === 3 || d.length === 4) {
      return [0, 1, 2].map((i) => parseInt(d[i] + d[i], 16));
    }
    if (d.length === 6 || d.length === 8) {
      return [0, 2, 4].map((i) => parseInt(d.slice(i, i + 2), 16));
    }
    return null;
  }

  const fn = /^(rgba?|hsla?)\(([^)]+)\)$/.exec(text);
  if (fn) {
    const parts = fn[2]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map((p) => Number.parseFloat(p));
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return fn[1].startsWith('rgb')
      ? parts.slice(0, 3).map((n) => Math.round(n))
      : hslToRgb(parts[0], parts[1], parts[2]);
  }

  return null;
}

/** Every string leaf under a value — colour properties may be expressions, not plain strings. */
function stringLeaves(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) stringLeaves(v, out);
  return out;
}

/** Collect [path, value] for every string under any property whose name ends in `color`. */
function collectColorStrings(node, path = '$', found = []) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectColorStrings(v, `${path}[${i}]`, found));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const next = `${path}.${key}`;
      if (/color$/i.test(key)) {
        for (const leaf of stringLeaves(value)) found.push([next, leaf]);
      } else {
        collectColorStrings(value, next, found);
      }
    }
  }
  return found;
}

const style = JSON.parse(readFileSync(stylePath, 'utf8'));
const entries = collectColorStrings(style);

if (entries.length === 0) {
  console.error(`No *-color properties found in ${stylePath} — the check would pass vacuously.`);
  process.exit(1);
}

const problems = [];
for (const [path, raw] of entries) {
  const rgb = parseColor(raw);

  if (!rgb) {
    // Expression keywords ("interpolate", "linear", "zoom", property names) are legitimate
    // strings inside a colour expression. Only flag things that look like a colour attempt.
    if (/^#|^rgba?\(|^hsla?\(/.test(raw.trim()) || /^[a-z]+$/i.test(raw.trim()) === false) {
      problems.push(`${path}: ${JSON.stringify(raw)} — cannot be parsed as a colour`);
    }
    continue;
  }

  const [r, g, b] = rgb;
  if (b > r) problems.push(`${path}: ${raw} — blue-shifted (B ${b} > R ${r})`);
  else if (g > r && g > b)
    problems.push(`${path}: ${raw} — green-dominant (G ${g} > R ${r}, B ${b})`);
}

// Safety net: a colour literal hiding outside a *-color property still counts.
const source = readFileSync(stylePath, 'utf8');
for (const literal of new Set(
  source.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? [],
)) {
  const rgb = parseColor(literal);
  if (!rgb) continue;
  const [r, g, b] = rgb;
  if (b > r || (g > r && g > b)) {
    const already = problems.some((p) => p.includes(literal));
    if (!already) problems.push(`(outside a *-color property) ${literal} — blue or green`);
  }
}

if (problems.length > 0) {
  console.error('Basemap palette violates the A2 colour reservation:\n');
  for (const line of problems) console.error(`  ${line}`);
  console.error(
    '\nBlue and green mean "water domain" and "forest domain". The basemap must stay out of ' +
      'those hues — use a neutral or warm grey instead.',
  );
  process.exit(1);
}

console.log(`basemap palette: ${entries.length} colour values checked, no blue or green.`);
