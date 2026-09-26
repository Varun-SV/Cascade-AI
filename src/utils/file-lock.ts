// ─────────────────────────────────────────────
//  Cascade AI — A lock file shared between processes
// ─────────────────────────────────────────────
//
//  For a read-modify-write of a file that several Cascade processes change —
//  the privacy record, the credential store — so none drops another's change.

import fs from 'node:fs';

/** How long a caller waits for another process to finish before giving up. */
export const LOCK_WAIT_MS = 5_000;
/** A lock older than this was left by a process that ended holding it. */
export const STALE_LOCK_MS = 30_000;

/**
 * Run `fn` holding the lock file `lock`, which other processes respect. A
 * lock left by a process that ended holding it is taken over once stale;
 * waiting longer than `LOCK_WAIT_MS` throws, naming `what` was being done.
 */
export function withLock<T>(lock: string, what: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const st = fs.statSync(lock, { throwIfNoEntry: false });
      if (st && Date.now() - st.mtimeMs > STALE_LOCK_MS) { fs.rmSync(lock, { force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`Could not ${what}: ${lock} has been held for over ${LOCK_WAIT_MS / 1000}s.`);
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  try { return fn(); } finally { fs.rmSync(lock, { force: true }); }
}
