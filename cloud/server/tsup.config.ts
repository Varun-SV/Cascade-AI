import { defineConfig } from 'tsup';

// Deps resolve from the hoisted workspace node_modules at runtime, same as
// the root package's npm build — no need to bundle them.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  target: 'node20',
  external: ['better-sqlite3', 'cascade-ai'],
  banner: {
    js: '// Cascade Cloud — hosted server',
  },
});
