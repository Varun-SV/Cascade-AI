import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  target: 'node18',
  external: [
    'better-sqlite3',
    'playwright',
    'fsevents',
  ],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
  banner: {
    js: '// Cascade AI — Multi-tier AI Orchestration System',
  },
});
