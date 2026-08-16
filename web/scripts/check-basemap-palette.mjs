#!/usr/bin/env node
/**
 * Enforces the one visual rule the whole colour system rests on (proposal A2):
 * the basemap may not use blue or green, because those hues are reserved to mean
 * "water domain" and "forest domain".
 *
 * This exists because the rule is invisible in review. Every off-the-shelf basemap paints its own
 * water blue and its vegetation green, so a single restyled layer left out — or one added later
 * from upstream — silently reintroduces the collision, and the map still looks fine to anyone who
 * is not looking for it. A screenshot catches it once; this catches it every time.
 *
 * The test: every colour must satisfy R > B (not blue-shifted) and not have G dominant (not
 * green). That admits the warm ink greys the style is built from and rejects the entire blue and
 * green families.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const stylePath = join(here, '..', 'src', 'map', 'basemap', 'style.json');

const source = readFileSync(stylePath, 'utf8');
const hexes = [...new Set(source.match(/#[0-9a-fA-F]{6}\b/g) ?? [])];

if (hexes.length === 0) {
  console.error(`No colours found in ${stylePath} — the check would pass vacuously.`);
  process.exit(1);
}

const offenders = [];
for (const hex of hexes) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  if (b > r) offenders.push(`${hex}  blue-shifted (B ${b} > R ${r})`);
  else if (g > r && g > b) offenders.push(`${hex}  green-dominant (G ${g} > R ${r}, B ${b})`);
}

if (offenders.length > 0) {
  console.error('Basemap palette violates the A2 colour reservation:\n');
  for (const line of offenders) console.error(`  ${line}`);
  console.error(
    '\nBlue and green mean "water domain" and "forest domain". The basemap must stay out of ' +
      'those hues — use a neutral or warm grey instead.',
  );
  process.exit(1);
}

console.log(`basemap palette: ${hexes.length} colours checked, no blue or green.`);
