import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STALE_LOCK_MS, withLock } from './file-lock.js';

let dir: string;
let lock: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-lock-'));
  lock = path.join(dir, 'x.lock');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Make `file` look as if it was last touched longer ago than a lock lives. */
function age(file: string): void {
  const then = new Date(Date.now() - STALE_LOCK_MS - 5_000);
  fs.utimesSync(file, then, then);
}

describe('withLock', () => {
  it('runs the function holding the lock, and removes it after', () => {
    const seen = withLock(lock, 'test', () => fs.existsSync(lock));
    expect(seen).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('takes over a lock left by a process that ended holding it', () => {
    fs.writeFileSync(lock, 'gone.0');
    age(lock);
    expect(withLock(lock, 'test', () => fs.readFileSync(lock, 'utf8'))).not.toBe('gone.0');
    expect(fs.existsSync(lock)).toBe(false);
  });

  // A caller whose lock was taken over as stale removed the new holder's.
  it('removes only the lock it took', () => {
    withLock(lock, 'test', () => fs.writeFileSync(lock, 'another.holder'));
    expect(fs.readFileSync(lock, 'utf8')).toBe('another.holder');
  });

  it('is not held up by a reclaim guard left behind', () => {
    fs.writeFileSync(lock, 'gone.0');
    age(lock);
    fs.writeFileSync(`${lock}.reclaim`, 'gone.1');
    age(`${lock}.reclaim`);
    expect(withLock(lock, 'test', () => 'ran')).toBe('ran');
    expect(fs.existsSync(`${lock}.reclaim`)).toBe(false);
  });

  it('gives up on a live lock after waiting', () => {
    fs.writeFileSync(lock, 'live.0');
    expect(() => withLock(lock, 'do the thing', () => 'ran')).toThrow(/Could not do the thing/);
    expect(fs.readFileSync(lock, 'utf8')).toBe('live.0');
  }, 10_000);
});
