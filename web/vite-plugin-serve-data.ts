import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

import type { Plugin } from 'vite';

/**
 * Serves the repo-root `data/` directory at `/data` during development.
 *
 * **Why not a symlink in `public/`.** `public/` means "copy verbatim into the build output", and
 * `data/` holds generated tilesets — 91 MB for the basemap alone — which must never be bundled.
 * Worse, `data/` is gitignored, so on a clean checkout the symlink dangles and Vite's build dies
 * on `statSync` before it produces anything. That is how this reached CI.
 *
 * In production these files are served by the host (object storage) at the same `/data` path, so
 * the app's URLs are identical in both environments and nothing about the build has to know.
 *
 * Range requests are mandatory, not a nicety: PMTiles is a single file read by byte range, so
 * without 206 support the basemap cannot load at all.
 */
const MIME: Record<string, string> = {
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.pmtiles': 'application/octet-stream',
};

export function serveDataDir(dataDir: string): Plugin {
  const root = resolve(dataDir);

  return {
    name: 'trace:serve-data',
    apply: 'serve',

    configureServer(server) {
      // Terminal by design: every /data request is answered here, never passed on to Vite.
      server.middlewares.use('/data', (req, res) => {
        const rawPath = (req.url ?? '/').split('?')[0] ?? '/';
        const target = resolve(join(root, normalize(decodeURIComponent(rawPath))));

        // Refuse anything that escapes data/ — the middleware is dev-only, but a path-traversal
        // hole that reads arbitrary files off the developer's disk is still a real one.
        if (target !== root && !target.startsWith(root + sep)) {
          res.statusCode = 403;
          res.end('Forbidden');
          return;
        }

        let size: number;
        try {
          const stat = statSync(target);
          if (!stat.isFile()) throw new Error('not a file');
          size = stat.size;
        } catch {
          // A genuine 404, not `next()`. Falling through would hand the request to Vite's SPA
          // fallback, which answers with index.html at HTTP 200 — so a missing tileset would
          // arrive as HTML claiming success. That is exactly the failure that made a missing
          // manifest surface as `Unexpected token '<'`. /data is a data namespace with no SPA
          // routes under it, so "not found" is always the honest answer.
          res.statusCode = 404;
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              error: `Not found under data/: ${rawPath}`,
              hint: 'Generate it with: cd pipeline && .venv/bin/python -m trace_pipeline.cli all',
            }),
          );
          return;
        }

        res.setHeader('Content-Type', MIME[extname(target)] ?? 'application/octet-stream');
        res.setHeader('Accept-Ranges', 'bytes');

        const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
        if (range) {
          const start = range[1] ? Number.parseInt(range[1], 10) : 0;
          const end = range[2] ? Number.parseInt(range[2], 10) : size - 1;

          if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
            res.statusCode = 416;
            res.setHeader('Content-Range', `bytes */${size}`);
            res.end();
            return;
          }

          const last = Math.min(end, size - 1);
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${start}-${last}/${size}`);
          res.setHeader('Content-Length', String(last - start + 1));
          createReadStream(target, { start, end: last }).pipe(res);
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Length', String(size));
        createReadStream(target).pipe(res);
      });
    },
  };
}
