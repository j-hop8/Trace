#!/usr/bin/env node
/**
 * Enforces the rule the whole colour system rests on (proposal A2): the basemap may not use blue
 * or green, because those hues are reserved to mean "water domain" and "forest domain".
 *
 * This exists because the rule is invisible in review. Every off-the-shelf basemap paints its own
 * water blue and its vegetation green, so one layer left unrestyled — or one pulled in later from
 * upstream — reintroduces the collision, and the map still looks fine to anyone not looking for it.
 *
 * ## Fail-closed by construction
 *
 * Two earlier versions of this check were bypassable: the first scanned for six-digit hex only
 * (missing `rgb()`, `#00f`, `hsl()`), the second still waved through unrecognised words, so the
 * literal `"blue"` passed. Both reported success, which is worse than not checking — CI presented
 * a guarantee that did not exist.
 *
 * So the rule here is inverted: **anything that is not provably a safe colour is a failure.**
 * Colour properties are walked as expression trees. In a value position a string must parse into
 * RGB; a word that does not parse (`"blue"`, `"seagreen"`, a typo) is rejected rather than
 * ignored. Operator names sit at index 0 of an expression array and are skipped structurally, so
 * no allowlist of expression keywords is needed and none can go stale.
 *
 * Data-driven colours (`["get", …]`, `["feature-state", …]`) are rejected outright: their value
 * comes from tile data at runtime and cannot be proven safe here. If one is ever genuinely
 * needed, the guarantee has to move to runtime with it.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stylePath = join(here, '..', 'src', 'map', 'basemap', 'style.json');

/** The only colour *names* permitted. Anything else must be written as an explicit value. */
const NAMED = {
  transparent: [0, 0, 0],
  black: [0, 0, 0],
  white: [255, 255, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
};

/** Expression operators whose result depends on tile data, so it cannot be checked statically. */
const DATA_DRIVEN = new Set([
  'get',
  'has',
  'feature-state',
  'properties',
  'accumulated',
  'image',
  'coalesce-property',
]);

/** Expression operators that construct a colour from numeric arguments. */
const COLOR_CTOR = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'to-color']);

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

/** Parse a CSS colour string into [r,g,b], or null if it is not one. */
function parseColor(value) {
  const text = String(value).trim().toLowerCase();

  if (Object.prototype.hasOwnProperty.call(NAMED, text)) return NAMED[text];

  const hex = /^#([0-9a-f]{3,8})$/.exec(text);
  if (hex) {
    const d = hex[1];
    if (d.length === 3 || d.length === 4) return [0, 1, 2].map((i) => parseInt(d[i] + d[i], 16));
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
      .map(Number.parseFloat);
    if (parts.length < 3 || parts.slice(0, 3).some(Number.isNaN)) return null;
    return fn[1].startsWith('rgb')
      ? parts.slice(0, 3).map(Math.round)
      : hslToRgb(parts[0], parts[1], parts[2]);
  }

  return null;
}

function judge(rgb, label, problems) {
  const [r, g, b] = rgb;
  if (b > r) problems.push(`${label} — blue-shifted (B ${b} > R ${r})`);
  else if (g > r && g > b) problems.push(`${label} — green-dominant (G ${g} > R ${r}, B ${b})`);
}

/**
 * Walk a colour property's value. `node` is always in a *value* position: a literal colour, or an
 * expression whose operator is at index 0.
 */
function checkColorValue(node, path, problems) {
  if (node === null || typeof node === 'number' || typeof node === 'boolean') return;

  if (typeof node === 'string') {
    const rgb = parseColor(node);
    if (!rgb) {
      problems.push(
        `${path}: ${JSON.stringify(node)} — not a recognised colour. ` +
          `Named colours other than ${Object.keys(NAMED).join('/')} are rejected on purpose.`,
      );
      return;
    }
    judge(rgb, `${path}: ${node}`, problems);
    return;
  }

  if (Array.isArray(node)) {
    const op = node[0];

    if (typeof op === 'string' && DATA_DRIVEN.has(op)) {
      problems.push(
        `${path}: ["${op}", …] — data-driven colour cannot be verified statically. ` +
          `The A2 guarantee only holds for colours fixed in the style.`,
      );
      return;
    }

    if (typeof op === 'string' && COLOR_CTOR.has(op)) {
      const args = node.slice(1);
      if (args.every((a) => typeof a === 'number')) {
        const rgb = op.startsWith('hsl') ? hslToRgb(args[0], args[1], args[2]) : args.slice(0, 3);
        judge(rgb.map(Math.round), `${path}: ${op}(${args.join(',')})`, problems);
      } else {
        problems.push(`${path}: ["${op}", …] — non-literal arguments cannot be verified`);
      }
      return;
    }

    // A generic expression: index 0 is the operator, the rest are values.
    node.slice(1).forEach((arg, i) => checkColorValue(arg, `${path}[${i + 1}]`, problems));
    return;
  }

  if (typeof node === 'object') {
    problems.push(`${path}: object value in a colour position — cannot be verified`);
  }
}

/** Find every `*-color` property anywhere in the style and check its value. */
function walk(node, path, problems, seen) {
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, `${path}[${i}]`, problems, seen));
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const next = `${path}.${key}`;
      if (/color$/i.test(key)) {
        seen.count += 1;
        checkColorValue(value, next, problems);
      } else {
        walk(value, next, problems, seen);
      }
    }
  }
}

const source = readFileSync(stylePath, 'utf8');
const style = JSON.parse(source);

const problems = [];
const seen = { count: 0 };
walk(style, '$', problems, seen);

if (seen.count === 0) {
  console.error(`No *-color properties found in ${stylePath} — the check would pass vacuously.`);
  process.exit(1);
}

// Safety net: a colour literal hiding somewhere that is not a *-color property still counts.
for (const literal of new Set(
  source.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? [],
)) {
  const rgb = parseColor(literal);
  if (!rgb) continue;
  const [r, g, b] = rgb;
  if ((b > r || (g > r && g > b)) && !problems.some((p) => p.includes(literal))) {
    problems.push(`(outside a *-color property) ${literal} — blue or green`);
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

console.log(`basemap palette: ${seen.count} colour properties checked, no blue or green.`);
