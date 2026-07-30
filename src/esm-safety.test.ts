// ─────────────────────────────────────────────
//  Cascade AI — no dynamic require() in the ESM bundle
// ─────────────────────────────────────────────
//
//  tsup's ESM output replaces `require(...)` with esbuild's `__require`
//  shim, which throws `Dynamic require of "X" is not supported` under real
//  Node ESM (no global `require` identifier exists — `bin/cascade.js` loads
//  this package via `await import(...)`). vitest's own runtime DOES provide
//  a `require` shim, so a unit test exercising the affected code in isolation
//  passes even when the real ESM build is broken — which is exactly how this
//  bit twice: once in dead-models.ts's own require('node:fs'/'node:path'),
//  and again in cascade.ts's separate require('node:path') at the call site
//  that constructs it. Static imports are transpiled correctly for both the
//  CJS and ESM build targets, so there is never a reason for `src/` to use a
//  dynamic `require(` outside a context that genuinely runs as CommonJS.
//
//  The one legitimate exception: tool-creator.ts's Worker harness source,
//  which is eval'd inside a `new Worker(src, { eval: true })` with no
//  `type: 'module'` — that is a real synchronous-CJS `require` provided by
//  Node to the eval'd script, not the esbuild shim.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';

const srcDir = dirname(fileURLToPath(import.meta.url));

const ALLOWED_DYNAMIC_REQUIRE_FILES = new Set([
  'tools/tool-creator.ts', // inside HARNESS_SRC: a real CJS eval'd Worker script, not esbuild output
]);

describe('ESM build safety', () => {
  it('has no dynamic require() calls outside the allowlisted CJS worker harness', async () => {
    const files = await glob('**/*.ts', {
      cwd: srcDir,
      ignore: ['**/*.test.ts', '**/*.d.ts'],
    });

    const offenders: string[] = [];
    for (const file of files) {
      const rel = relative(srcDir, join(srcDir, file)).replace(/\\/g, '/');
      if (ALLOWED_DYNAMIC_REQUIRE_FILES.has(rel)) continue;
      const code = readFileSync(join(srcDir, file), 'utf-8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
      if (/\brequire\(\s*['"]/.test(code)) offenders.push(rel);
    }

    expect(offenders).toEqual([]);
  });
});
