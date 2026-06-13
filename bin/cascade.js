#!/usr/bin/env node
// Cascade AI — Entry point
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
