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

// A jail that threw while preparing left the script behind, in the folder
// later commands are shown — and a local-only subtask's can hold what it read.
describe('run_code — its script', () => {
  it('is removed when the jail throws while preparing', async () => {
    const { CodeInterpreterTool } = await import('./interpreter.js');
    const { statePath, STATE } = await import('../config/project-state.js');
    const tool = new CodeInterpreterTool();
    tool.setWorkspaceRoot(ws);
    tool.setProcessJail({ prepare: async () => { throw new Error('privacy record unreadable'); } } as never);
    await expect(tool.execute({ language: 'nodejs', code: 'console.log("PRIVATE")' }, { tierId: 't3', sessionId: 's' } as never))
      .rejects.toThrow(/privacy record unreadable/);
    const tmp = statePath(ws, STATE.tmp);
    expect(fs.existsSync(tmp) ? fs.readdirSync(tmp).filter((f) => f.startsWith('intp_')) : []).toEqual([]);
  });
});
