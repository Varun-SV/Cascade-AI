import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PendingAccounting } from './pending-accounting.js';

describe('run accounting waiting for a window', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-pending-'));
    file = path.join(dir, 'pending-accounting-4898.jsonl');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('keeps each report with an id until a window confirms it', () => {
    const pending = new PendingAccounting<{ sessionId: string }>();
    const a = pending.add({ sessionId: 's1' });
    const b = pending.add({ sessionId: 's2' });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(pending.unconfirmed().map((r) => r.sessionId)).toEqual(['s1', 's2']);
    pending.confirm(a.id);
    expect(pending.unconfirmed()).toEqual([b]);
    pending.confirm(undefined);
    pending.confirm(42);
    expect(pending.size).toBe(1);
  });

  it('drops nothing that has not been confirmed, however many wait', () => {
    const pending = new PendingAccounting<{ n: number }>(file);
    for (let n = 1; n <= 1500; n++) pending.add({ n });
    expect(pending.size).toBe(1500);
    expect(pending.unconfirmed()[0]!.n).toBe(1);
  });

  it('keeps unconfirmed reports across a restart, and not confirmed ones', () => {
    const before = new PendingAccounting<{ n: number }>(file);
    const first = before.add({ n: 1 });
    before.add({ n: 2 });
    before.confirm(first.id);
    const after = new PendingAccounting<{ n: number }>(file);
    expect(after.unconfirmed().map((r) => r.n)).toEqual([2]);
  });

  it('reads past a line torn by a crash', () => {
    const before = new PendingAccounting<{ n: number }>(file);
    before.add({ n: 1 });
    fs.appendFileSync(file, '{"add":{"n":2,"id":"half');
    expect(new PendingAccounting<{ n: number }>(file).unconfirmed().map((r) => r.n)).toEqual([1]);
  });

  it('rewrites the file without confirmed reports from time to time', () => {
    const pending = new PendingAccounting<{ n: number }>(file);
    for (let n = 0; n < 300; n++) pending.confirm(pending.add({ n }).id);
    pending.add({ n: 999 });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines.length).toBeLessThan(300);
    expect(new PendingAccounting<{ n: number }>(file).unconfirmed().map((r) => r.n)).toEqual([999]);
  });

  it('keeps reports in memory when the file cannot be written', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const blocker = path.join(dir, 'not-a-folder');
    fs.writeFileSync(blocker, 'x');
    const pending = new PendingAccounting<{ n: number }>(path.join(blocker, 'pending.jsonl'));
    pending.add({ n: 1 });
    expect(pending.size).toBe(1);
    warn.mockRestore();
  });
});
