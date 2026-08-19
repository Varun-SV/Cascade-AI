// ─────────────────────────────────────────────
//  Cascade AI — the desktop's view of this package
// ─────────────────────────────────────────────
//
//  `app/electron/main.ts` reaches the SDK through `loadCore()`, which
//  `require()`s the built entry point and declares its shape with a
//  hand-written object-literal type. That type is a CLAIM, not a check: adding
//  a name to it compiles whether or not the entry point exports one, and the
//  failure is a TypeError at runtime in the packaged desktop app, on the
//  settings-save path, where nobody sees it until a user does.
//
//  This closes that gap from the SDK side: everything the desktop destructures
//  must actually be exported here.

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as entry from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const electronMain = path.join(here, '..', 'app', 'electron', 'main.ts');

describe('desktop core contract', () => {
  /** The names loadCore()'s declared return type promises. */
  function declaredByLoadCore(): string[] {
    const source = fs.readFileSync(electronMain, 'utf8');
    const signature = /function loadCore\(\):\s*\{([\s\S]*?)\}\s*\{/.exec(source);
    expect(signature, 'loadCore() signature not found — did it move?').toBeTruthy();

    // Depth by BRACES AND PARENS only. Counting angle brackets as well looks
    // right until `=> boolean`, whose `>` closes a bracket that never opened —
    // which silently dropped every member declared after the first arrow type,
    // including the one this test exists to catch.
    const body = signature![1]!;
    const segments: string[] = [];
    let depth = 0;
    let current = '';
    for (const ch of body) {
      if (ch === '{' || ch === '(') depth++;
      else if (ch === '}' || ch === ')') depth--;
      if (ch === ';' && depth === 0) { segments.push(current); current = ''; continue; }
      current += ch;
    }
    segments.push(current);

    return segments
      .map((seg) => seg.slice(0, seg.indexOf(':')).trim())
      .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
  }

  it('exports everything the desktop expects to find', () => {
    const declared = declaredByLoadCore();
    expect(declared.length).toBeGreaterThan(0);
    const missing = declared.filter((name) => !(name in entry));
    expect(missing, `not exported from src/index.ts: ${missing.join(', ')}`).toEqual([]);
  });

  it('exports applyProviderApiKey specifically', () => {
    // Named on its own because it is the one that broke: it was added to
    // loadCore()'s type and called from two settings paths without ever being
    // re-exported, so both would have thrown on the first key save.
    expect(typeof entry.applyProviderApiKey).toBe('function');
  });
});
