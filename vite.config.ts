import {defineConfig} from 'vite';

// Static, self-contained build: relative base so the bundled page works when
// opened from any path (including directly as a local file via a static server),
// and all dependencies are bundled rather than pulled from a CDN.
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2020',
    assetsInlineLimit: 0,
  },
});
