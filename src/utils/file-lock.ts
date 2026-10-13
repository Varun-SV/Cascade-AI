// ─────────────────────────────────────────────
//  Cascade AI — A lock file shared between processes
// ─────────────────────────────────────────────
//
//  For a read-modify-write of a file that several Cascade processes change —
//  the privacy record, the credential store — so none drops another's change.

import crypto from 'node:crypto';
import fs from 'node:fs';

/** How long a caller waits for another process to finish before giving up. */
export const LOCK_WAIT_MS = 5_000;
/** A lock older than this was left by a process that ended holding it. */
export const STALE_LOCK_MS = 30_000;

/**
 * Run `fn` holding the lock file `lock`, which other processes respect. A
 * lock left by a process that ended holding it is taken over once stale;
 * waiting longer than `LOCK_WAIT_MS` throws, naming `what` was being done.
 *
 * The lock holds a token of its own, so a caller removes only the lock it
 * took. A stale one is taken over under a second, short lock (`.reclaim`),
 * and only while it is still the file found stale: two callers finding the
 * same stale lock cannot both remove it, the second removing the fresh lock
 * the first took in its place.
 */
export function withLock<T>(lock: string, what: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = `${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  for (;;) {
    if (tryCreate(lock, token)) break;
    const st = fs.statSync(lock, { throwIfNoEntry: false });
    if (st && Date.now() - st.mtimeMs > STALE_LOCK_MS) {
      reclaim(lock, st);
      continue;
    }
    if (Date.now() > deadline) throw new Error(`Could not ${what}: ${lock} has been held for over ${LOCK_WAIT_MS / 1000}s.`);
    pause(10);
  }
  try {
    return fn();
  } finally {
    // Ours still, unless it outlived STALE_LOCK_MS and was taken over.
    if (readToken(lock) === token) fs.rmSync(lock, { force: true });
  }
}

/** Create `lock` holding `token`; false when it is there already. */
function tryCreate(lock: string, token: string): boolean {
  try {
    fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
}

/**
 * Remove the stale lock `found` described, if it is still that file. Done
 * under `<lock>.reclaim`, held for no longer than a stat and a remove, so one
 * of those older than STALE_LOCK_MS was left by a process that ended.
 */
function reclaim(lock: string, found: fs.Stats): void {
  const guard = `${lock}.reclaim`;
  const token = `${process.pid}.${crypto.randomBytes(8).toString('hex')}`;
  if (!tryCreate(guard, token)) {
    const st = fs.statSync(guard, { throwIfNoEntry: false });
    if (st && Date.now() - st.mtimeMs > STALE_LOCK_MS) fs.rmSync(guard, { force: true });
    pause(10);
    return;
  }
  try {
    const now = fs.statSync(lock, { throwIfNoEntry: false });
    if (now && now.ino === found.ino && now.dev === found.dev && now.mtimeMs === found.mtimeMs) {
      fs.rmSync(lock, { force: true });
    }
  } finally {
    if (readToken(guard) === token) fs.rmSync(guard, { force: true });
  }
}

/** What a lock file holds; '' when it is gone or unreadable. */
function readToken(lock: string): string {
  try { return fs.readFileSync(lock, 'utf8'); } catch { return ''; }
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function pause(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}
