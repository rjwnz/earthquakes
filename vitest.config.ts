import {defineConfig} from 'vitest/config';

// Unit tests concentrate on the data-transformation algorithms (projection,
// decimation, miniSEED/Steim decoding, amplitude mapping). These are pure and
// run in the Node environment; no DOM is required.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts', 'src/**/types.ts'],
    },
  },
});
