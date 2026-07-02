import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AuditLogger } from './audit-logger.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-audit-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('AuditLogger hash chain', () => {
  it('verifies an untampered log', () => {
    const logger = new AuditLogger(dir);
    logger.logEvent('tool_call', 'T3_abc', { tool: 'file_read', path: 'a.ts' });
    logger.logEvent('tool_result', 'T3_abc', { ok: true });
    logger.logEvent('tier_status', 'T2_def', { status: 'COMPLETED' });
    const v = logger.verifyChain();
    logger.close();
    expect(v).toEqual({ ok: true, entries: 3 });
  });

  it('verifies an empty log', () => {
    const logger = new AuditLogger(dir);
    const v = logger.verifyChain();
    logger.close();
    expect(v).toEqual({ ok: true, entries: 0 });
  });

  it('detects a modified row', () => {
    const logger = new AuditLogger(dir);
    logger.logEvent('tool_call', 'T3_abc', { tool: 'shell' });
    logger.logEvent('tool_result', 'T3_abc', { ok: true });
    logger.close();

    // Tamper directly: swap the second row's event_type without re-hashing.
    const db = new Database(path.join(dir, '.cascade', 'audit_log.db'));
    db.prepare("UPDATE audit_logs SET event_type = 'tool_call' WHERE rowid = 2").run();
    db.close();

    const reopened = new AuditLogger(dir);
    const v = reopened.verifyChain();
    reopened.close();
    expect(v.ok).toBe(false);
    expect(v.firstBadRow).toBe(2);
  });

  it('detects a deleted row (chain break)', () => {
    const logger = new AuditLogger(dir);
    logger.logEvent('a', 't', { n: 1 });
    logger.logEvent('b', 't', { n: 2 });
    logger.logEvent('c', 't', { n: 3 });
    logger.close();

    const db = new Database(path.join(dir, '.cascade', 'audit_log.db'));
    db.prepare('DELETE FROM audit_logs WHERE rowid = 2').run();
    db.close();

    const reopened = new AuditLogger(dir);
    const v = reopened.verifyChain();
    reopened.close();
    expect(v.ok).toBe(false);
  });
});
