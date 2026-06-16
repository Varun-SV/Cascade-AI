// Coverage for the runtime tool-generation capability (ToolCreator) and the
// `diff` helper. ToolCreator previously had no test, which let a regression
// ship where the syntax check compiled generated code synchronously and so
// rejected every tool that used `await callTool(...)` / `await fetch(...)`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ToolRegistry } from './registry.js';
import { ToolCreator, normalizeToolSchema, type GeneratedToolSpec } from './tool-creator.js';
import { generateDiff, diffSummary } from './diff.js';

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
