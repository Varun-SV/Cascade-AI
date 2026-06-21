import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

// Read the published version once, at build time, and bake it into the bundle so
// CASCADE_VERSION (src/constants.ts) always matches package.json — no more drift.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string };

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
  target: 'node20',
  external: [
    'better-sqlite3',
    'playwright',
    'fsevents',
    // Optional native modules — dynamically imported with graceful fallbacks.
    // They must stay external so the build never hard-requires their .node
    // binaries (which may be absent on the build machine). This bundle is also
    // shipped as the desktop app's `cascade-core`, so a failed build here would
    // break the embedded backend.
    'keytar',
    'node-notifier',
  ],
  define: {
    'process.env.CASCADE_BUILD_VERSION': JSON.stringify(pkg.version),
  },
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
  banner: {
    js: '// Cascade AI — Multi-tier AI Orchestration System',
  },
});
