/**
 * The production `/data` host. What is pinned here is what the map needs from it to load at all —
 * byte ranges answered exactly, a missing file answered as a 404 and never as the page — and the
 * cache rule that keeps the manifest from going stale beside its tiles.
 */

import { describe, expect, it, vi } from 'vitest';

import worker, { etagMatches, parseRange, resolveRange } from './index';
import type { ByteRange, DataBucket, Env } from './index';

const SIZE = 1000;
const TILES = Uint8Array.from({ length: SIZE }, (_, i) => i % 251);
const MANIFEST = new TextEncoder().encode('{"version":3,"domains":[]}');

/**
 * A stand-in for R2. It slices bytes on its own terms, not through the worker's `resolveRange`,
 * so a mistake there cannot hide behind the same mistake here. Like R2, it throws for a range
 * that starts past the end instead of returning nothing.
 */
function fakeBucket(): DataBucket & { ranges: (ByteRange | undefined)[] } {
  const objects = new Map([
    ['domains.json', { bytes: MANIFEST, type: 'application/json' }],
    ['tiles.pmtiles', { bytes: TILES, type: 'application/octet-stream' }],
  ]);
  const ranges: (ByteRange | undefined)[] = [];
  const meta = (key: string, bytes: Uint8Array, type: string) => ({
    size: bytes.length,
    httpEtag: `"etag-${key}"`,
    writeHttpMetadata: (headers: Headers) => headers.set('Content-Type', type),
  });

  return {
    ranges,
    async head(key) {
      const object = objects.get(key);
      return object ? meta(key, object.bytes, object.type) : null;
    },
    async get(key, options) {
      const object = objects.get(key);
      if (!object) return null;
      const range = options?.range;
      ranges.push(range);

      let slice = object.bytes;
      if (range && 'suffix' in range) slice = object.bytes.slice(-range.suffix);
      else if (range) {
        if (range.offset >= object.bytes.length) throw new Error('InvalidRange (10039)');
        const end = range.length === undefined ? undefined : range.offset + range.length;
        slice = object.bytes.slice(range.offset, end);
      }
      return { ...meta(key, object.bytes, object.type), body: new Blob([slice]).stream() };
    },
  };
}

function setup() {
  const bucket = fakeBucket();
  const assets = vi.fn(async (_request: Request) => new Response('<!doctype html>'));
  const env: Env = { DATA: bucket, ASSETS: { fetch: assets } };
  const request = (path: string, init?: RequestInit) =>
    worker.fetch(new Request(`https://trace.example${path}`, init), env);
  return { bucket, assets, request };
}

const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer());

describe('parseRange', () => {
  it.each([
    ['bytes=0-15', { offset: 0, length: 16 }],
    ['bytes=100-', { offset: 100 }],
    ['bytes=-10', { suffix: 10 }],
    [' bytes=7-7 ', { offset: 7, length: 1 }],
  ])('reads %j as one range', (header, expected) => {
    expect(parseRange(header)).toEqual(expected);
  });

  it.each([
    null,
    '',
    'bytes=5-2',
    'bytes=0-1,4-5',
    'bytes=-0',
    'bytes=-',
    'items=0-1',
    'bytes=a-b',
  ])('ignores %j, so the whole object is served', (header) => {
    expect(parseRange(header)).toBeNull();
  });
});

describe('resolveRange', () => {
  it('cuts a range that runs past the end', () => {
    expect(resolveRange({ offset: 990, length: 100 }, SIZE)).toEqual([990, 999]);
  });

  it('serves a suffix longer than the object as the whole object', () => {
    expect(resolveRange({ suffix: 5000 }, SIZE)).toEqual([0, 999]);
  });

  it('finds nothing to serve past the end, or in an empty object', () => {
    expect(resolveRange({ offset: SIZE }, SIZE)).toBeNull();
    expect(resolveRange({ suffix: 1 }, 0)).toBeNull();
  });
});

describe('etagMatches', () => {
  it('matches the etag strong, weak, in a list, or as *', () => {
    expect(etagMatches('"a"', '"a"')).toBe(true);
    expect(etagMatches('W/"a"', '"a"')).toBe(true);
    expect(etagMatches('"b", "a"', '"a"')).toBe(true);
    expect(etagMatches('*', '"a"')).toBe(true);
  });

  it('does not match another etag, or no header', () => {
    expect(etagMatches('"b"', '"a"')).toBe(false);
    expect(etagMatches(null, '"a"')).toBe(false);
  });
});

describe('the /data host', () => {
  it('serves the manifest whole, and makes the browser revalidate it every time', async () => {
    const { request } = setup();
    const response = await request('/data/domains.json');

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('ETag')).toBe('"etag-domains.json"');
    expect(response.headers.get('Accept-Ranges')).toBe('bytes');
    expect(await bytesOf(response)).toEqual(MANIFEST);
  });

  it('lets a tileset be cached', async () => {
    const { request } = setup();
    const response = await request('/data/tiles.pmtiles');
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
  });

  it('answers a byte range with exactly those bytes, and asks R2 for no more', async () => {
    const { request, bucket } = setup();
    const response = await request('/data/tiles.pmtiles', { headers: { Range: 'bytes=0-15' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(`bytes 0-15/${SIZE}`);
    expect(response.headers.get('Content-Length')).toBe('16');
    expect(await bytesOf(response)).toEqual(TILES.slice(0, 16));
    expect(bucket.ranges).toEqual([{ offset: 0, length: 16 }]);
  });

  it.each([
    ['bytes=100-', 100, 999],
    ['bytes=-10', 990, 999],
    ['bytes=990-2000', 990, 999],
  ])('states the span %s actually selects', async (header, start, end) => {
    const { request } = setup();
    const response = await request('/data/tiles.pmtiles', { headers: { Range: header } });

    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Range')).toBe(`bytes ${start}-${end}/${SIZE}`);
    expect(await bytesOf(response)).toEqual(TILES.slice(start, end + 1));
  });

  it('refuses a range that starts past the end, stating the real size', async () => {
    const { request } = setup();
    const response = await request('/data/tiles.pmtiles', { headers: { Range: 'bytes=5000-' } });

    expect(response.status).toBe(416);
    expect(response.headers.get('Content-Range')).toBe(`bytes */${SIZE}`);
  });

  it.each(['bytes=0-1,4-5', 'bytes=9-3'])(
    'serves the whole object for a range it will not honour (%s)',
    async (header) => {
      const { request } = setup();
      const response = await request('/data/tiles.pmtiles', { headers: { Range: header } });

      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Range')).toBeNull();
      expect(await bytesOf(response)).toEqual(TILES);
    },
  );

  it('answers a missing file with a JSON 404, never with the page', async () => {
    const { request, assets } = setup();
    const response = await request('/data/missing.pmtiles');

    expect(response.status).toBe(404);
    expect(response.headers.get('Content-Type')).toMatch(/^application\/json/);
    const body = (await response.json()) as { error: string; hint: string };
    expect(body.error).toContain('missing.pmtiles');
    expect(body.hint).toContain('npm run publish:data');
    expect(assets).not.toHaveBeenCalled();
  });

  it.each(['/data/', '/data/%E0%A4%A'])(
    'answers %s with a 404 rather than failing',
    async (path) => {
      const { request } = setup();
      expect((await request(path)).status).toBe(404);
    },
  );

  it('answers only GET and HEAD', async () => {
    const { request } = setup();
    const response = await request('/data/domains.json', { method: 'POST' });

    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
  });

  it('answers a revalidation of an unchanged file with 304 and no body', async () => {
    const { request } = setup();
    const fresh = await request('/data/domains.json', {
      headers: { 'If-None-Match': '"etag-domains.json"' },
    });
    const stale = await request('/data/domains.json', { headers: { 'If-None-Match': '"old"' } });

    expect(fresh.status).toBe(304);
    expect(fresh.body).toBeNull();
    expect(stale.status).toBe(200);
  });

  it('answers a current copy with 304 before judging its range, even one past the end', async () => {
    const { request } = setup();
    const response = await request('/data/tiles.pmtiles', {
      headers: { Range: 'bytes=5000-', 'If-None-Match': '"etag-tiles.pmtiles"' },
    });

    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe('"etag-tiles.pmtiles"');
    expect(response.body).toBeNull();
  });

  it('answers HEAD with the headers and the size, and no body', async () => {
    const { request } = setup();
    const response = await request('/data/tiles.pmtiles', { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Length')).toBe(String(SIZE));
    expect(response.body).toBeNull();
  });

  it('hands every other path to the static build, /data lookalikes included', async () => {
    const { request, assets, bucket } = setup();

    for (const path of ['/', '/assets/index.js', '/data', '/database.json']) {
      const response = await request(path);
      expect(await response.text()).toBe('<!doctype html>');
    }
    expect(assets).toHaveBeenCalledTimes(4);
    expect(bucket.ranges).toEqual([]);
  });
});
