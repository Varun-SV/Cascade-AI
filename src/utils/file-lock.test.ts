import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { STALE_LOCK_MS, ownerToken, withLock } from './file-lock.js';

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

  // Taken over for being 30s old, a live owner slowed by its filesystem was
  // still inside its read-modify-write when the next one began its own.
  // Where a process's start time can be read: elsewhere a running owner's
  // PID may be another process's, and its lock ages out after STALE_LOCK_MS.
  it.skipIf(!fs.existsSync('/proc/self/stat'))('never takes a lock from a live owner, however old; takes it once that owner is gone', async () => {
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => owner.once('spawn', r));
      fs.writeFileSync(lock, ownerToken(owner.pid!));
      age(lock);
      expect(() => withLock(lock, 'save', () => 'ran')).toThrow(/Could not save/);
      expect(JSON.parse(fs.readFileSync(lock, 'utf8')).pid).toBe(owner.pid);
      owner.kill('SIGKILL');
      await new Promise((r) => owner.once('exit', r));
      // Gone: taken over at once, without waiting for it to age.
      fs.utimesSync(lock, new Date(), new Date());
      expect(withLock(lock, 'save', () => 'ran')).toBe('ran');
    } finally {
      owner.kill('SIGKILL');
    }
  }, 15_000);

  // A start time that could not be read was taken for a different one, and
  // the lock of a live owner was taken over at once.
  it.skipIf(!fs.existsSync('/proc/self/stat'))('waits on a live owner whose start time cannot be read now', async () => {
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await new Promise((r) => owner.once('spawn', r));
      const token = ownerToken(owner.pid!);
      expect(JSON.parse(token).started).not.toBe('');
      fs.writeFileSync(lock, token);
      // From here on, procfs will not show that process's stat to this one.
      const real = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, o?: never) => {
        if (String(p) === `/proc/${owner.pid}/stat`) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        return real(p, o);
      }) as never);
      expect(() => withLock(lock, 'save', () => 'ran')).toThrow(/Could not save/);
      expect(fs.readFileSync(lock, 'utf8')).toBe(token);
    } finally {
      vi.restoreAllMocks();
      owner.kill('SIGKILL');
    }
  }, 15_000);

  it.skipIf(!fs.existsSync('/proc/self/stat'))('takes a lock whose PID now belongs to another process', () => {
    const token = JSON.parse(ownerToken(process.pid)) as Record<string, unknown>;
    fs.writeFileSync(lock, JSON.stringify({ ...token, started: '1' }));
    expect(withLock(lock, 'save', () => 'ran')).toBe('ran');
  });

  it('gives up on a live lock after waiting', () => {
    fs.writeFileSync(lock, 'live.0');
    expect(() => withLock(lock, 'do the thing', () => 'ran')).toThrow(/Could not do the thing/);
    expect(fs.readFileSync(lock, 'utf8')).toBe('live.0');
  }, 10_000);
});
