import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Test against the live core source instead of the built `cascade-ai`
    // package — the workspace self-reference in node_modules only reflects
    // dist/'s state as of the last `npm install`, so tests would otherwise
    // run against a stale SDK snapshot any time src/ changes without a
    // reinstall. Production code still depends on the real built package
    // (see package.json); rebuild + reinstall before shipping.
    alias: {
      'cascade-ai': new URL('../../src/index.ts', import.meta.url).pathname,
    },
  },
});
