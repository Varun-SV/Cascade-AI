import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from './registry.js';

const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-interp-'));
afterAll(() => fs.rmSync(ws, { recursive: true, force: true }));

describe('run_code — stopping', () => {
  it('stops a running script when its call is cancelled', async () => {
    const reg = new ToolRegistry({ shellAllowlist: [], shellBlocklist: [], requireApprovalFor: [], browserEnabled: false, webSearch: {}, processJail: 'off' } as never, ws);
    const stop = new AbortController();
    const started = Date.now();
    setTimeout(() => stop.abort(), 200);
    const out = await reg.execute('run_code', { language: 'nodejs', code: 'setTimeout(() => {}, 10000);' }, { tierId: 't3', sessionId: 's', signal: stop.signal } as never);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(String(out)).toMatch(/Execution failed|abort/i);
  });
});
