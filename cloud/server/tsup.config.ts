import { defineConfig } from 'tsup';

// Deps resolve from the hoisted workspace node_modules at runtime, same as
// the root package's npm build — no need to bundle them. `#cascade-ai` is a
// Node package.json "imports" subpath (see package.json) pointing straight
// at the root workspace's built dist/index.js — left external so it's
// resolved at runtime via that imports-field entry rather than bundled.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm'],
  dts: false,
  clean: true,
  sourcemap: true,
  splitting: false,
  treeshake: true,
  target: 'node20',
  external: ['better-sqlite3', '#cascade-ai'],
  banner: {
    js: '// Cascade Cloud — hosted server',
  },
});
