import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  server: {
    // The pipeline writes tiles to the repo-root data/ directory, which sits outside web/.
    // Serving it directly keeps generated artifacts out of the source tree and out of git.
    fs: { allow: [path.resolve(__dirname, '..')] },
  },
  // PMTiles are fetched with HTTP range requests; they must never be inlined or hashed.
  assetsInclude: ['**/*.pmtiles'],
});
