#!/usr/bin/env node
// Cascade AI — Entry point

// React (through Ink) picks its development or production build from NODE_ENV
// when it loads. Left unset, the development build loads, and its warnings are
// printed straight over the terminal UI. Set only for loading: the CLI clears it
// again before anything else runs, so commands it starts never inherit it.
if (process.env.NODE_ENV === undefined) {
  process.env.NODE_ENV = 'production';
  process.env.CASCADE_CLEAR_NODE_ENV = '1';
}

try {
  await import('../dist/cli.js');
} catch (err) {
  if (err?.code === 'ERR_MODULE_NOT_FOUND') {
    const missingDist = /dist[\\/]cli\.js/.test(String(err?.message ?? ''));
    console.error(
      missingDist
        ? 'Cascade build output is missing (dist/cli.js).\nRun: npm install && npm run build'
        : `A dependency failed to load — node_modules may be missing or out of date.\nRun: npm install && npm run build\n\n${err.message}`,
    );
    process.exit(1);
  }
  throw err;
}
