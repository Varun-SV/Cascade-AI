import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Test against the live core source instead of the built `cascade-ai`
    // package — the workspace self-reference in node_modules only refreshes
    // on a full reinstall, so tests would otherwise run against a stale
    // snapshot of the SDK any time src/ changes without one. Production code
    // still depends on the real published/built package (package.json).
    alias: {
      'cascade-ai': new URL('../../src/index.ts', import.meta.url).pathname,
    },
  },
});
