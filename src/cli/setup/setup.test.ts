import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applySetup, saveSetup } from './index.js';
import { ConfigManager } from '../../config/index.js';
import { loadGlobalCredentials, saveGlobalCredentials } from '../../config/global-credentials.js';
import type { ProviderConfig } from '../../types.js';

// The wizard saved its providers as the machine's whole list, and then
// handed them to the manager as the project's whole list: choosing one
// provider for a project removed the keys every other project used.
describe('the setup wizard\'s save', () => {
  it('adds what it was given to the machine\'s providers, and removes none', async () => {
    const globalDir = process.env['CASCADE_GLOBAL_DIR']!;
    const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-setup-')));
    const types = () => loadGlobalCredentials(globalDir).map((p) => p.type).sort();
    try {
      saveGlobalCredentials(globalDir, [
        { type: 'openai', apiKey: 'sk-openai' } as ProviderConfig,
        { type: 'gemini', apiKey: 'sk-gemini' } as ProviderConfig,
      ]);
      const config = saveSetup(ws, [{ type: 'anthropic', apiKey: 'sk-anthropic' }], { t1: 'auto', t2: 'auto', t3: 'auto' });
      expect(types()).toEqual(['anthropic', 'gemini', 'openai']);
      await applySetup(new ConfigManager(ws), config);
      expect(types()).toEqual(['anthropic', 'gemini', 'openai']);
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
      saveGlobalCredentials(globalDir, []);
    }
  });
});
