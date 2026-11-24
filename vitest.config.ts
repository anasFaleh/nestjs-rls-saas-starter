import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

// Unit tests: no database, no network. Files next to the code: src/**/*.spec.ts
export default defineConfig({
  // SWC emits decorator metadata (esbuild does not), so Nest DI works in tests.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
  },
});
