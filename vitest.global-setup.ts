// The WebAssembly sandbox runs agent-written tools on a worker thread, which
// loads its script with plain Node — Vitest's TypeScript transform does not
// reach it. From the source tree that script would be wasm-sandbox-worker.ts,
// which loads only where Node strips types itself. So, as the build writes
// dist/wasm-sandbox-worker.cjs beside the bundle, the suite writes the worker
// bundle beside its source (src/tools/sandbox/wasm-sandbox.ts looks there
// first), and removes it when the run ends.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'tsup';

const dir = fileURLToPath(new URL('./src/tools/sandbox/', import.meta.url));
const bundle = `${dir}wasm-sandbox-worker.cjs`;

export async function setup(): Promise<void> {
  await build({
    config: false,
    entry: { 'wasm-sandbox-worker': `${dir}wasm-sandbox-worker.ts` },
    outDir: dir,
    format: ['cjs'],
    platform: 'node',
    target: 'node20',
    noExternal: [/.*/],
    dts: false,
    clean: false,
    sourcemap: false,
    splitting: false,
    silent: true,
  });
  if (!fs.existsSync(bundle)) throw new Error(`the sandbox worker bundle was not written to ${bundle}`);
}

export function teardown(): void {
  fs.rmSync(bundle, { force: true });
}
