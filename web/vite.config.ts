import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import { serveDataDir } from './vite-plugin-serve-data';

export default defineConfig({
  // The pipeline writes tiles to the repo-root data/ directory, outside web/. They are served at
  // /data in dev by the plugin below and by the host at the same path in production — never
  // copied through public/, which would bundle ~100 MB of generated tiles into the build.
  plugins: [react(), serveDataDir(path.resolve(__dirname, '..', 'data'))],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    fs: { allow: [path.resolve(__dirname, '..')] },
  },
  // PMTiles are fetched with HTTP range requests; they must never be inlined or hashed.
  assetsInclude: ['**/*.pmtiles'],
});
