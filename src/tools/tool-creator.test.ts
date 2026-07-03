// Coverage for the runtime tool-generation capability (ToolCreator) and the
// `diff` helper. ToolCreator previously had no test, which let a regression
// ship where the syntax check compiled generated code synchronously and so
// rejected every tool that used `await callTool(...)` / `await fetch(...)`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ToolRegistry } from './registry.js';
import { ToolCreator, normalizeToolSchema, type GeneratedToolSpec } from './tool-creator.js';
import { generateDiff, diffSummary } from './diff.js';
import { PermissionEscalator } from '../core/permissions/escalator.js';

const opts: any = { tierId: 't3-test' };
let ws: string;

beforeAll(async () => { ws = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-toolgen-')); });
afterAll(async () => { await fs.rm(ws, { recursive: true, force: true }); });

function makeRegistry() {
  return new ToolRegistry(
    { shellAllowlist: [], shellBlocklist: [], webSearch: {}, browserEnabled: false, requireApprovalFor: [] } as any,
    ws);
}
function mockRouter(spec: object) {
  return { generate: async () => ({ content: JSON.stringify(spec) }) } as any;
}

describe('diff helper (exercises the `diff` package)', () => {
  it('generateDiff + diffSummary produce a unified patch', () => {
    const patch = generateDiff('one\ntwo\n', 'one\nTWO\nthree\n', 'f.txt');
    expect(patch).toContain('@@');
    const s = diffSummary(patch);
    expect(s.added).toBeGreaterThan(0);
    expect(s.removed).toBeGreaterThan(0);
  });
});

describe('ToolCreator — runtime tool generation', () => {
  it('normalizeToolSchema wraps a bare properties map and passes a valid schema through', () => {
    const wrapped = normalizeToolSchema({ path: { type: 'string' } });
    expect(wrapped['type']).toBe('object');
    expect((wrapped['properties'] as any).path).toBeTruthy();
    const already = { type: 'object', properties: { x: { type: 'number' } } };
    expect(normalizeToolSchema(already)).toBe(already);
  });

  it('generates a pure-compute tool and executes it in the vm sandbox', async () => {
    const reg = makeRegistry();
    const spec: GeneratedToolSpec = {
      name: 'dynamic_add', description: 'add two numbers',
      inputSchema: { a: { type: 'number' }, b: { type: 'number' } },
      executeCode: 'return String(Number(input.a) + Number(input.b));', isDangerous: false,
    };
    const name = await new ToolCreator(mockRouter(spec), reg, ws).createTool('add two numbers', 'math');
    expect(name).toBe('dynamic_add');
    expect(await reg.execute('dynamic_add', { a: 2, b: 5 }, opts)).toBe('7');
  });

  // Regression guard: a tool body that uses `await` must be ACCEPTED (the
  // runtime runs it inside an async IIFE). A sync syntax check rejected these.
  it('accepts and runs an async tool that awaits callTool()', async () => {
    const reg = makeRegistry();
    await fs.writeFile(path.join(ws, 'seed.txt'), 'seed-content', 'utf-8');
    const spec: GeneratedToolSpec = {
      name: 'dynamic_reader', description: 'read seed',
      inputSchema: { path: { type: 'string' } },
      executeCode: "const c = await callTool('file_read', { path: input.path }); return c;",
      isDangerous: false,
    };
    const name = await new ToolCreator(mockRouter(spec), reg, ws).createTool('read a file', 'io');
    expect(name).toBe('dynamic_reader'); // not rejected as a syntax error
    expect(await reg.execute('dynamic_reader', { path: 'seed.txt' }, opts)).toContain('seed-content');
  });

  it('sandboxed fetch is SSRF-guarded against cloud metadata', async () => {
    const reg = makeRegistry();
    const spec: GeneratedToolSpec = {
      name: 'dynamic_ssrf', description: 'fetch metadata',
      inputSchema: { type: 'object', properties: {} },
      executeCode: "const r = await fetch('http://169.254.169.254/'); return await r.text();",
      isDangerous: false,
    };
    await new ToolCreator(mockRouter(spec), reg, ws).createTool('fetch a url', 'net');
    const out = await reg.execute('dynamic_ssrf', {}, opts);
    expect(out).toMatch(/Tool error:|non-public address|Blocked/);
  });

  it('rejects generated code with a genuine syntax error (no registration)', async () => {
    const reg = makeRegistry();
    const spec = {
      name: 'dynamic_broken', description: 'broken',
      inputSchema: { type: 'object', properties: {} },
      executeCode: 'return (((;', isDangerous: false,
    };
    const name = await new ToolCreator(mockRouter(spec), reg, ws).createTool('broken thing', 'x');
    expect(name).toBeNull();
    expect(reg.hasTool('dynamic_broken')).toBe(false);
  });

  it('dedupes identical capability requests (no second generation)', async () => {
    const reg = makeRegistry();
    let calls = 0;
    const router = { generate: async () => { calls++; return { content: JSON.stringify({
      name: 'dynamic_dedupe', description: 'dedupe me',
      inputSchema: { type: 'object', properties: {} },
      executeCode: "return 'ok';", isDangerous: false }) }; } } as any;
    const creator = new ToolCreator(router, reg, ws);
    const a = await creator.createTool('summarize a file thoroughly', 'ctx');
    const b = await creator.createTool('summarize a file thoroughly', 'ctx');
    expect(a).toBe(b);
    expect(calls).toBe(1);
  });

  it('dangerous generated tool routes its callTool through the escalator', async () => {
    const reg = makeRegistry();
    let asked = false;
    const escalator: any = { requestPermission: async () => { asked = true; return { approved: false, decidedBy: 'test' }; } };
    const spec: GeneratedToolSpec = {
      name: 'dynamic_danger', description: 'delete a file',
      inputSchema: { path: { type: 'string' } },
      executeCode: "return await callTool('file_delete', { path: input.path });",
      isDangerous: true,
    };
    const creator = new ToolCreator(mockRouter(spec), reg, ws);
    creator.setPermissionEscalator(escalator);
    await creator.createTool('delete a file', 'io');
    const out = await reg.execute('dynamic_danger', { path: 'whatever.txt' }, opts);
    expect(asked).toBe(true);
    expect(out).toMatch(/Permission denied/);
  });
});

describe('ToolCreator — worker sandbox (v0.9.6 item 1)', () => {
  it('runs a pure-compute tool in the worker thread', async () => {
    const reg = makeRegistry();
    const spec: GeneratedToolSpec = {
      name: 'dynamic_w_add', description: 'add',
      inputSchema: { a: { type: 'number' }, b: { type: 'number' } },
      executeCode: 'return String(Number(input.a) + Number(input.b));', isDangerous: false,
    };
    // Pin to the worker executor so this exercises the fallback path regardless
    // of whether isolated-vm is installed.
    await new ToolCreator(mockRouter(spec), reg, ws, true, 'worker').createTool('add in worker', 'math');
    expect(await reg.execute('dynamic_w_add', { a: 3, b: 4 }, opts)).toBe('7');
  });

  it('terminates an infinite-loop tool at the kill timeout (does not hang)', async () => {
    const reg = makeRegistry();
    const spec: GeneratedToolSpec = {
      name: 'dynamic_loop', description: 'spin forever',
      inputSchema: { type: 'object', properties: {} },
      executeCode: 'while (true) {} return "never";', isDangerous: false,
    };
    await new ToolCreator(mockRouter(spec), reg, ws, true, 'worker').createTool('spin', 'x');
    const prev = process.env.CASCADE_DYNAMIC_TOOL_TIMEOUT_MS;
    process.env.CASCADE_DYNAMIC_TOOL_TIMEOUT_MS = '600';
    try {
      const t0 = Date.now();
      const out = await reg.execute('dynamic_loop', {}, opts);
      expect(Date.now() - t0).toBeLessThan(4000);
      expect(out).toMatch(/timed out|terminated/);
    } finally {
      if (prev === undefined) delete process.env.CASCADE_DYNAMIC_TOOL_TIMEOUT_MS;
      else process.env.CASCADE_DYNAMIC_TOOL_TIMEOUT_MS = prev;
    }
  });
});

// ── Hard isolate (isolated-vm) — v0.14.0 ──
// Skipped gracefully when the optional native addon isn't installed/built, so CI
// without it stays green (the 'auto' path there simply falls back to the worker).
const ivmAvailable: boolean = await (async () => {
  try { await import('isolated-vm'); return true; } catch { return false; }
})();

describe.skipIf(!ivmAvailable)('ToolCreator — hard isolate sandbox (isolated-vm)', () => {
  it('runs a pure-compute tool inside the isolate', async () => {
    const reg = makeRegistry();
    const spec: GeneratedToolSpec = {
      name: 'dynamic_iso_add', description: 'add',
      inputSchema: { a: { type: 'number' }, b: { type: 'number' } },
      executeCode: 'return String(Number(input.a) + Number(input.b));', isDangerous: false,
    };
    await new ToolCreator(mockRouter(spec), reg, ws, true, 'isolate').createTool('iso add', 'math');
    expect(await reg.execute('dynamic_iso_add', { a: 8, b: 9 }, opts)).toBe('17');
  });

  it('CONFINES the code: no process / require / globalThis Node escapes', async () => {
    const reg = makeRegistry();
    const spec: GeneratedToolSpec = {
      name: 'dynamic_iso_confine', description: 'probe host',
      inputSchema: { type: 'object', properties: {} },
      executeCode: "return 'process=' + (typeof process) + ' require=' + (typeof require) + ' gt=' + (typeof globalThis.process);",
      isDangerous: false,
    };
    await new ToolCreator(mockRouter(spec), reg, ws, true, 'isolate').createTool('confine', 'x');
    const out = await reg.execute('dynamic_iso_confine', {}, opts);
    expect(out).toBe('process=undefined require=undefined gt=undefined');
  });

  it('still routes a dangerous callTool through the escalator from inside the isolate', async () => {
    const reg = makeRegistry();
    let asked = false;
    const escalator: any = { requestPermission: async () => { asked = true; return { approved: false, decidedBy: 'test' }; } };
    const spec: GeneratedToolSpec = {
      name: 'dynamic_iso_danger', description: 'delete',
      inputSchema: { path: { type: 'string' } },
      executeCode: "return await callTool('file_delete', { path: input.path });",
      isDangerous: true,
    };
    const creator = new ToolCreator(mockRouter(spec), reg, ws, true, 'isolate');
    creator.setPermissionEscalator(escalator);
    await creator.createTool('delete', 'io');
    const out = await reg.execute('dynamic_iso_danger', { path: 'x.txt' }, opts);
    expect(asked).toBe(true);
    expect(out).toMatch(/Permission denied/);
  });

  it('terminates a runaway isolate at the timeout (does not hang)', async () => {
    const reg = makeRegistry();
    const spec: GeneratedToolSpec = {
      name: 'dynamic_iso_loop', description: 'spin',
      inputSchema: { type: 'object', properties: {} },
      executeCode: 'while (true) {} return "never";', isDangerous: false,
    };
    await new ToolCreator(mockRouter(spec), reg, ws, true, 'isolate').createTool('iso spin', 'x');
    const prev = process.env.CASCADE_DYNAMIC_TOOL_TIMEOUT_MS;
    process.env.CASCADE_DYNAMIC_TOOL_TIMEOUT_MS = '600';
    try {
      const t0 = Date.now();
      const out = await reg.execute('dynamic_iso_loop', {}, opts);
      expect(Date.now() - t0).toBeLessThan(4000);
      expect(out).toMatch(/timed out|terminated/);
    } finally {
      if (prev === undefined) delete process.env.CASCADE_DYNAMIC_TOOL_TIMEOUT_MS;
      else process.env.CASCADE_DYNAMIC_TOOL_TIMEOUT_MS = prev;
    }
  });
});

describe('ToolCreator — default-deny + lazy escalator (v0.9.6 item 2)', () => {
  it('DENIES a dangerous callTool when no escalator is available (file NOT deleted)', async () => {
    const reg = makeRegistry();
    await fs.writeFile(path.join(ws, 'keep.txt'), 'x', 'utf-8');
    const spec: GeneratedToolSpec = {
      name: 'dynamic_nodeny', description: 'delete',
      inputSchema: { path: { type: 'string' } },
      executeCode: "return await callTool('file_delete', { path: input.path });",
      isDangerous: true,
    };
    // No setPermissionEscalator → getEscalator() is undefined → default-deny.
    await new ToolCreator(mockRouter(spec), reg, ws).createTool('delete', 'io');
    const out = await reg.execute('dynamic_nodeny', { path: 'keep.txt' }, opts);
    expect(out).toMatch(/no approver|default-deny|Permission denied/);
    expect(existsSync(path.join(ws, 'keep.txt'))).toBe(true);
  });

  it('an escalator set AFTER registration still gates (escalator resolved lazily)', async () => {
    const reg = makeRegistry();
    let asked = false;
    const spec: GeneratedToolSpec = {
      name: 'dynamic_late', description: 'delete',
      inputSchema: { path: { type: 'string' } },
      executeCode: "return await callTool('file_delete', { path: input.path });",
      isDangerous: true,
    };
    const creator = new ToolCreator(mockRouter(spec), reg, ws);
    await creator.createTool('delete', 'io'); // registered with no escalator yet
    creator.setPermissionEscalator({ requestPermission: async () => { asked = true; return { approved: false, decidedBy: 'test' }; } } as any);
    const out = await reg.execute('dynamic_late', { path: 'keep.txt' }, opts);
    expect(asked).toBe(true);
    expect(out).toMatch(/Permission denied/);
  });

  it('UNTRUSTED tool sets forceReprompt; trusted does not', async () => {
    const reg = makeRegistry();
    const captured: any[] = [];
    const escalator: any = { requestPermission: async (req: any) => { captured.push(req); return { approved: false, decidedBy: 'test' }; } };
    const danger: GeneratedToolSpec = {
      name: 'dynamic_trust', description: 'delete',
      inputSchema: { path: { type: 'string' } },
      executeCode: "return await callTool('file_delete', { path: input.path });",
      isDangerous: true,
    };
    const creator = new ToolCreator(mockRouter(danger), reg, ws);
    creator.setPermissionEscalator(escalator);
    await creator.createTool('delete', 'io');                       // trusted
    await reg.execute('dynamic_trust', { path: 'k' }, opts);
    creator.registerSpec({ ...danger, name: 'dynamic_trust_u' }, false); // untrusted
    await reg.execute('dynamic_trust_u', { path: 'k' }, opts);
    expect(captured.find((r) => r.requestedBy === 'dynamic_tool:dynamic_trust')?.forceReprompt).toBe(false);
    expect(captured.find((r) => r.requestedBy === 'dynamic_tool:dynamic_trust_u')?.forceReprompt).toBe(true);
  });
});

describe('ToolCreator — hardened persistence (v0.9.6 item 3)', () => {
  it('re-validates on load: skips a broken persisted spec, marks the rest untrusted', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-persist-'));
    await fs.mkdir(path.join(dir, '.cascade'), { recursive: true });
    const persisted = [
      { name: 'dynamic_good', description: 'ok', inputSchema: { type: 'object', properties: {} }, executeCode: "return 'ok';", isDangerous: false, trusted: true },
      { name: 'dynamic_bad', description: 'broken', inputSchema: { type: 'object', properties: {} }, executeCode: 'return (((;', isDangerous: false, trusted: true },
    ];
    await fs.writeFile(path.join(dir, '.cascade', 'dynamic-tools.json'), JSON.stringify(persisted), 'utf-8');
    const reg = makeRegistry();
    const creator = new ToolCreator(mockRouter({}), reg, dir);
    await creator.loadPersistedTools();
    expect(reg.hasTool('dynamic_good')).toBe(true);
    expect(reg.hasTool('dynamic_bad')).toBe(false);               // broken → skipped
    expect(creator.getSpec('dynamic_good')?.trusted).toBe(false); // forced untrusted despite trusted:true on disk
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('persistDynamicTools=false disables loading entirely', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-persist-off-'));
    await fs.mkdir(path.join(dir, '.cascade'), { recursive: true });
    await fs.writeFile(path.join(dir, '.cascade', 'dynamic-tools.json'),
      JSON.stringify([{ name: 'dynamic_x', description: 'x', inputSchema: { type: 'object', properties: {} }, executeCode: "return 'x';", isDangerous: false }]), 'utf-8');
    const reg = makeRegistry();
    const creator = new ToolCreator(mockRouter({}), reg, dir, false); // persistEnabled = false
    await creator.loadPersistedTools();
    expect(reg.hasTool('dynamic_x')).toBe(false);
    await fs.rm(dir, { recursive: true, force: true });
  });
});

describe('PermissionEscalator — forceReprompt bypasses the always-cache (v0.9.6)', () => {
  it('a cached always-approval does not satisfy a forceReprompt request', async () => {
    const esc = new PermissionEscalator(0);
    let evals = 0;
    esc.setT2Evaluator(async () => { evals++; return { requestId: 'x', approved: true, always: true, decidedBy: 'T2' }; });
    const base = { requestedBy: 'r', parentT2Id: 't2', toolName: 'shell', input: {}, isDangerous: true, subtaskContext: '', sectionContext: '' };
    await esc.requestPermission({ ...base, id: '1' });                      // evaluator → caches always
    await esc.requestPermission({ ...base, id: '2' });                      // cache hit (no eval)
    await esc.requestPermission({ ...base, id: '3', forceReprompt: true }); // bypasses cache → evaluator
    expect(evals).toBe(2);
  });
});
