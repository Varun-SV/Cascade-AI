import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Test against the live core source instead of the built dist/index.js
    // that the "#cascade-ai" imports-field entry (package.json) points at —
    // that entry only reflects dist/'s state as of the last `npm run build`,
    // so tests would otherwise run against a stale SDK snapshot any time
    // src/ changes without a rebuild. Production code still runs against the
    // real built package (see package.json "imports"); rebuild before shipping.
    alias: {
      '#cascade-ai': new URL('../../src/index.ts', import.meta.url).pathname,
    },
  },
});
