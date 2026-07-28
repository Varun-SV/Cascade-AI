import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // app/electron holds a little pure logic (address-bar parsing) that is
    // worth testing; the rest of that directory imports electron and is not.
    include: [
      'src/**/*.test.ts', 'src/**/*.spec.ts', 'scripts/**/*.test.mjs',
      'app/electron/**/*.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.spec.ts',
        'src/cli/**/*.tsx',
        'src/types.ts',        // pure type file
        'src/constants.ts',    // constants only
      ],
      thresholds: {
        branches: 70,
        functions: 75,
        lines: 80,
        statements: 80,
      },
    },
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
    alias: {
      // Allow importing .js extensions in tests (ESM compat)
      '#cascade': new URL('./src', import.meta.url).pathname,
    },
  },
});

