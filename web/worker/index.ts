/**
 * The production host: serves the build as static assets and `/data/*` from R2, on one origin.
 *
 * Every data URL the app knows is root-relative — the manifest at `/data/domains.json`, the
 * basemap and each domain's tileset at `pmtiles:///data/…` — and `vite-plugin-serve-data.ts`
 * answers the same paths in development. So this is the dev plugin's production twin, and
 * nothing about the build has to know which one it is talking to. The tilesets live in R2 rather
 * than among the static assets because Cloudflare caps an asset at 25 MiB and they run to 91 MB.
 *
 * Range requests are the whole job: PMTiles is one file read by byte range, so without 206 the
 * map cannot load at all. The worker parses `Range` itself rather than handing R2 the raw
 * headers, so the parsing is a pure function the tests can pin.
 *
 * The R2 and assets types are declared here, as the subset used, rather than taken from
 * `@cloudflare/workers-types`: deploy tooling stays out of `npm ci` (see `docs/deploy.md`).
 */

/** A byte range in the form R2 accepts. */
export type ByteRange = { offset: number; length?: number } | { suffix: number };

export interface DataObject {
  size: number;
  /** The etag, already quoted for an HTTP header. */
  httpEtag: string;
  /** Copies the metadata stored at upload — Content-Type among it — onto `headers`. */
  writeHttpMetadata(headers: Headers): void;
}

export interface DataObjectBody extends DataObject {
  body: ReadableStream;
}

export interface DataBucket {
  get(key: string, options?: { range?: ByteRange }): Promise<DataObjectBody | null>;
  head(key: string): Promise<DataObject | null>;
}

export interface Env {
  DATA: DataBucket;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const DATA_PREFIX = '/data/';

/**
 * Parses a `Range` header into one range, or `null` to serve the whole object.
 *
 * Only a single `bytes` range is honoured. Anything else — several ranges, a reversed range, a
 * zero-length suffix, another unit — is ignored rather than refused, which RFC 9110 permits: the
 * client gets a 200 with the whole object, which is always a correct answer. PMTiles only ever
 * asks for one range.
 */
export function parseRange(header: string | null): ByteRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first = '', last = ''] = match;

  if (first === '') {
    const suffix = last === '' ? 0 : Number(last);
    return suffix > 0 ? { suffix } : null;
  }
  const offset = Number(first);
  if (last === '') return { offset };
  const end = Number(last);
  return end >= offset ? { offset, length: end - offset + 1 } : null;
}

/**
 * The inclusive `[start, end]` a range selects from an object of `size` bytes, or `null` when it
 * is unsatisfiable. A range running past the end is cut to it; a suffix longer than the object
 * is the whole object.
 */
export function resolveRange(range: ByteRange, size: number): [number, number] | null {
  if ('suffix' in range) {
    return size === 0 ? null : [Math.max(0, size - range.suffix), size - 1];
  }
  if (range.offset >= size) return null;
  const end = range.length === undefined ? size : Math.min(range.offset + range.length, size);
  return [range.offset, end - 1];
}

/** Whether an `If-None-Match` header names the object's etag, weak or strong, or is `*`. */
export function etagMatches(header: string | null, httpEtag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''))
    .some((tag) => tag === '*' || tag === httpEtag);
}

/**
 * The manifest is the contract the tiles are read against, so it is revalidated on every load
 * and can never be served stale beside a newer tileset. A tileset may be cached: each of its
 * ranges carries the archive's ETag, and the pmtiles client rereads the header when that changes.
 */
export function cacheControl(key: string): string {
  return key.endsWith('.json') ? 'no-cache' : 'public, max-age=3600';
}

/**
 * A missing file is an honest 404, never `index.html`. An HTML 200 for a missing manifest is
 * exactly how `Unexpected token '<'` reached the app in development (see the dev plugin), and the
 * same shape of answer is kept here so the error reads the same in both places.
 */
function notFound(key: string): Response {
  return Response.json(
    {
      error: `Not found under data/: ${key}`,
      hint: 'Publish it with: cd web && npm run publish:data',
    },
    { status: 404 },
  );
}

function unsatisfiable(size: number): Response {
  return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
}

function objectHeaders(object: DataObject, key: string): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', cacheControl(key));
  return headers;
}

/**
 * `If-None-Match` is evaluated before `Range` (RFC 9110 §13.2.2), so a client whose copy is
 * current gets a 304 whatever range it asked for — even one this object cannot satisfy.
 */
function notModified(request: Request, object: DataObject, key: string): Response | null {
  if (!etagMatches(request.headers.get('If-None-Match'), object.httpEtag)) return null;
  return new Response(null, { status: 304, headers: objectHeaders(object, key) });
}

export async function serveData(
  request: Request,
  key: string,
  bucket: DataBucket,
): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  if (key === '') return notFound(key);

  const range = parseRange(request.headers.get('Range'));

  let object: DataObjectBody | null;
  try {
    object = await bucket.get(key, range ? { range } : {});
  } catch (error) {
    // R2 refuses a range that starts past the end rather than returning nothing. Only that case
    // is answered here; anything else is a real failure and propagates.
    if (!range) throw error;
    const head = await bucket.head(key);
    if (!head) return notFound(key);
    if (resolveRange(range, head.size)) throw error;
    return notModified(request, head, key) ?? unsatisfiable(head.size);
  }
  if (!object) return notFound(key);

  const unchanged = notModified(request, object, key);
  if (unchanged) {
    await object.body.cancel();
    return unchanged;
  }
  const headers = objectHeaders(object, key);

  const body = request.method === 'HEAD' ? null : object.body;
  if (request.method === 'HEAD') await object.body.cancel();

  if (!range) {
    headers.set('Content-Length', String(object.size));
    return new Response(body, { status: 200, headers });
  }

  const span = resolveRange(range, object.size);
  if (!span) {
    await body?.cancel();
    return unsatisfiable(object.size);
  }
  const [start, end] = span;
  headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
  headers.set('Content-Length', String(end - start + 1));
  return new Response(body, { status: 206, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (!pathname.startsWith(DATA_PREFIX)) return env.ASSETS.fetch(request);

    let key: string;
    try {
      key = decodeURIComponent(pathname.slice(DATA_PREFIX.length));
    } catch {
      // A malformed escape names no object that could have been published.
      return notFound(pathname.slice(DATA_PREFIX.length));
    }
    return serveData(request, key, env.DATA);
  },
};
