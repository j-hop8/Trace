#!/usr/bin/env node
/**
 * Publishes the generated data the app reads to the R2 bucket the worker serves `/data` from.
 *
 *   npm run publish:data                  upload to the live bucket
 *   npm run publish:data -- --dry-run     print the plan, upload nothing
 *   npm run publish:data -- --local       upload to wrangler's local simulator, for `wrangler dev`
 *
 * ## The list is derived, never written down
 *
 * What is uploaded is what the app will ask for: every domain's `tiles.url` in the manifest, every
 * `pmtiles://` source in the basemap style, and the manifest itself. No domain and no tileset is
 * named here — `web/` may not name a domain (CLAUDE.md, rule 1), and a list kept by hand is one
 * that goes stale the day a domain is added. It also keeps out what the app never reads, such as
 * the pipeline's GeoJSON intermediates beside the tiles in `data/`.
 *
 * ## Order
 *
 * Tilesets first, the manifest last. The manifest is what points the app at tile layers, so it
 * goes live only once everything it names is already there — and if an upload fails part-way,
 * the manifest has not moved.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = join(web, '..', 'data');

const MANIFEST = 'domains.json';
const DATA_URL = 'pmtiles:///data/';
const CONTENT_TYPES = { '.json': 'application/json', '.pmtiles': 'application/octet-stream' };
const GENERATE = 'cd pipeline && .venv/bin/python -m trace_pipeline.cli all';

const args = process.argv.slice(2);
const unknown = args.filter((arg) => arg !== '--dry-run' && arg !== '--local');
if (unknown.length > 0) fail(`unknown argument ${unknown.join(' ')}; use --dry-run or --local`);
const dryRun = args.includes('--dry-run');
const target = args.includes('--local') ? '--local' : '--remote';

function fail(message) {
  console.error(`publish-data: ${message}`);
  process.exit(1);
}

function readJson(path, hint = '') {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return fail(`cannot read ${relative(process.cwd(), path)}: ${error.message}${hint}`);
  }
}

const manifest = readJson(join(dataDir, MANIFEST), `\nGenerate it with: ${GENERATE}`);
const style = readJson(join(web, 'src', 'map', 'basemap', 'style.json'));
const wrangler = readJson(join(web, 'wrangler.json'));
const wranglerVersion = readJson(join(web, 'package.json')).config?.wrangler;

const bucket = wrangler.r2_buckets?.find((entry) => entry.binding === 'DATA')?.bucket_name;
if (!bucket) fail('wrangler.json has no R2 bucket bound as DATA');
if (!wranglerVersion) fail('package.json has no config.wrangler version');

/** `[who asked for it, the URL it asked with]`, for every tileset the app will read. */
const references = [
  ...(manifest.domains ?? []).map((domain) => [`domain "${domain.id}"`, domain.tiles?.url]),
  ...Object.entries(style.sources ?? {})
    .filter(([, source]) => typeof source.url === 'string' && source.url.startsWith('pmtiles:'))
    .map(([name, source]) => [`basemap source "${name}"`, source.url]),
];
if (references.length === 0) fail(`${MANIFEST} and the basemap style reference no tilesets`);

// A URL outside /data is refused, not skipped: skipping it would publish a site that asks for a
// file this script never uploaded.
const tilesets = new Set();
for (const [who, url] of references) {
  const key = typeof url === 'string' && url.startsWith(DATA_URL) ? url.slice(DATA_URL.length) : '';
  if (key === '' || key.split('/').includes('..')) {
    fail(`${who} reads ${JSON.stringify(url)}, which is not a file under ${DATA_URL}`);
  }
  tilesets.add(key);
}

const plan = [...tilesets, MANIFEST].map((key) => {
  const file = join(dataDir, key);
  let size;
  try {
    size = statSync(file).size;
  } catch {
    fail(`data/${key} is referenced but missing. Generate it with: ${GENERATE}`);
  }
  const type = CONTENT_TYPES[extname(key)];
  if (!type) fail(`no content type is known for ${key}`);
  return { key, file, size, type };
});

const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`.padStart(9);
const destination = `${bucket} (${target === '--local' ? 'local simulator' : 'live'})`;
console.log(`${dryRun ? 'Would publish' : 'Publishing'} to ${destination}, in this order:`);
for (const { key, file, size, type } of plan) {
  console.log(`  ${mb(size)}  ${key}  ${type}  ← ${relative(join(web, '..'), file)}`);
}
if (dryRun) process.exit(0);

for (const { key, file, type } of plan) {
  const { status } = spawnSync(
    'npx',
    [
      '--yes',
      `wrangler@${wranglerVersion}`,
      'r2',
      'object',
      'put',
      `${bucket}/${key}`,
      '--file',
      file,
      '--content-type',
      type,
      // Explicit either way: wrangler 4 defaults `r2 object` to the local simulator, so an upload
      // with neither flag "succeeds" into a bucket the live site never reads.
      target,
    ],
    { cwd: web, stdio: 'inherit' },
  );
  if (status !== 0) {
    fail(`uploading ${key} failed. The manifest was not published; re-run once this is fixed.`);
  }
}
console.log(`Published ${plan.length} files to ${destination}.`);
