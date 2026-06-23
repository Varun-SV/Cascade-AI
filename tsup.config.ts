import { defineConfig } from 'tsup';
import { readFileSync } from 'node:fs';

// Read the published version once, at build time, and bake it into the bundle so
// CASCADE_VERSION (src/constants.ts) always matches package.json — no more drift.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
) as { version: string };

// Native / optional modules that must never be bundled: they either ship a
// `.node` binary or are dynamically imported with a graceful fallback. The
// desktop app ships better-sqlite3 (rebuilt for the Electron ABI) into
// cascade-core/node_modules; keytar/playwright/fsevents/node-notifier are
// optional and degrade gracefully when absent.
const NATIVE_EXTERNAL = [
  'better-sqlite3',
  'playwright',
  'fsevents',
  'keytar',
  'node-notifier',
];

// Bundle everything for the desktop backend EXCEPT these native/optional
// modules. We express this as a single `noExternal` negative-lookahead so the
// excluded names fall back to tsup's default auto-external behavior — `external`
// alone does not win over `noExternal: [/.*/]` in this tsup version, and a
// blanket noExternal pulled Playwright's unresolvable internals into the bundle.
const DESKTOP_KEEP_EXTERNAL = [
  'better-sqlite3',
  'playwright',
  'playwright-core',
  'chromium-bidi',
  'fsevents',
  'keytar',
  'node-notifier',
];
const DESKTOP_NO_EXTERNAL = new RegExp(
  `^(?!(?:${DESKTOP_KEEP_EXTERNAL.join('|')})(?:/|$)).+`,
);

export default defineConfig([
  // ── npm package + CLI ──────────────────────────────────────────────────────
  // Dependencies stay EXTERNAL: when installed from npm they live in the user's
  // node_modules, so bundling them would just bloat the package.
  {
    entry: { index: 'src/index.ts', cli: 'src/cli/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    splitting: false,
    treeshake: true,
    target: 'node20',
    external: NATIVE_EXTERNAL,
    define: {
      'process.env.CASCADE_BUILD_VERSION': JSON.stringify(pkg.version),
    },
    esbuildOptions(options) {
      options.jsx = 'automatic';
    },
    banner: {
      js: '// Cascade AI — Multi-tier AI Orchestration System',
    },
  },

  // ── Self-contained backend for the desktop app ───────────────────────────────
  // The Electron app embeds this as `cascade-core`. Unlike the npm package it has
  // NO node_modules to resolve `require`s from, so we BUNDLE every JS dependency
  // (glob, express, socket.io, provider SDKs, …) into one file. Only the native /
  // optional modules above stay external — better-sqlite3 is shipped alongside,
  // the rest degrade gracefully. Without this the embedded backend failed at the
  // first `require('glob')` and the desktop app sat permanently "offline".
  {
    entry: { 'desktop-core': 'src/index.ts' },
    format: ['cjs'],
    dts: false,
    clean: false,
    sourcemap: false,
    splitting: false,
    treeshake: true,
    target: 'node20',
    noExternal: [DESKTOP_NO_EXTERNAL], // bundle all JS deps except the native/optional ones
    external: DESKTOP_KEEP_EXTERNAL,
    define: {
      'process.env.CASCADE_BUILD_VERSION': JSON.stringify(pkg.version),
    },
    esbuildOptions(options) {
      options.jsx = 'automatic';
    },
    banner: {
      js: '// Cascade AI — embedded desktop backend (self-contained bundle)',
    },
  },
]);
