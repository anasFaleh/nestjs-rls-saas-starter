import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

// E2E tests run against a real PostgreSQL (see README "Run the tests").
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    setupFiles: ['test/setup-env.ts'],
    // All files share one database: run them one after another.
    fileParallelism: false,
  },
});
