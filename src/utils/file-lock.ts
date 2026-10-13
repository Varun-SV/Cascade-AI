// ─────────────────────────────────────────────
//  Cascade AI — A lock file shared between processes
// ─────────────────────────────────────────────
//
//  For a read-modify-write of a file that several Cascade processes change —
//  the privacy record, the credential store — so none drops another's change.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

/** How long a caller waits for another process to finish before giving up. */
export const LOCK_WAIT_MS = 5_000;
/**
 * A lock older than this, held by a process this one cannot see — on
 * another host, or in another PID namespace sharing the volume — is taken
 * for one left by a process that ended. Long beyond any read-modify-write
 * done under it.
 */
export const STALE_LOCK_MS = 10 * 60_000;

/**
 * Run `fn` holding the lock file `lock`, which other processes respect. A
 * lock left by a process that ended holding it is taken over; waiting
 * longer than `LOCK_WAIT_MS` throws, naming `what` was being done.
 *
 * The lock names its owner: host, PID namespace, process and when that
 * process started. One whose owner this process can see is taken over only
 * once that owner is gone — never for being old, which a live owner slowed
 * by its filesystem may be; waiting on it throws instead. One whose owner it
 * cannot see is taken over after STALE_LOCK_MS.
 *
 * A caller removes only the lock it took. A lock is taken over under a
 * second, short lock (`.reclaim`), and only while it is still the file found
 * left: two callers finding the same one cannot both remove it, the second
 * removing the fresh lock the first took in its place.
 */
export function withLock<T>(lock: string, what: string, fn: () => T): T {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const token = ownerToken(process.pid);
  for (;;) {
    if (tryCreate(lock, token)) break;
    const st = fs.statSync(lock, { throwIfNoEntry: false });
    if (st && left(readToken(lock), st)) {
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
 * Remove the left lock `found` described, if it is still that file. Done
 * under `<lock>.reclaim`, which is held for no longer than a stat and a
 * remove, and taken over by the same rule with GUARD_STALE_MS.
 */
function reclaim(lock: string, found: fs.Stats): void {
  const guard = `${lock}.reclaim`;
  const token = ownerToken(process.pid);
  if (!tryCreate(guard, token)) {
    const st = fs.statSync(guard, { throwIfNoEntry: false });
    if (st && left(readToken(guard), st, GUARD_STALE_MS)) fs.rmSync(guard, { force: true });
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

/** A reclaim guard is held for a stat and a remove: one this old was left. */
const GUARD_STALE_MS = 30_000;

/**
 * Whether the lock holding `token` was left by a process that ended: at once
 * when its owner is known to be gone; never while it is known to be running;
 * and, when that cannot be known, once it is older than `staleMs`.
 */
function left(token: string, st: fs.Stats, staleMs = STALE_LOCK_MS): boolean {
  const state = ownerState(token);
  if (state === 'dead') return true;
  if (state === 'alive') return false;
  return Date.now() - st.mtimeMs > staleMs;
}

/**
 * What can be known of the process that wrote `token` (see `ownerToken`):
 * `dead` only when it is confirmed gone — no process has its PID, or the one
 * that has it started at another time — `alive` only when it is confirmed
 * there, and `unknown` otherwise: another host or PID namespace, a token
 * that cannot be read, or a start time that cannot be (no /proc, or one this
 * process may not read), since its PID may have gone to another process.
 */
export function ownerState(token: string): 'alive' | 'dead' | 'unknown' {
  const owner = parseToken(token);
  if (!owner || owner.host !== HOST || owner.ns !== PID_NAMESPACE) return 'unknown';
  try {
    process.kill(owner.pid, 0);
  } catch (err) {
    // EPERM: there, and another user's.
    if ((err as NodeJS.ErrnoException).code !== 'EPERM') return 'dead';
  }
  if (owner.started === '') return 'unknown';
  const started = startedAt(owner.pid);
  if (started === '') return 'unknown';
  return started === owner.started ? 'alive' : 'dead';
}

const HOST = os.hostname();
/** This process's PID namespace, where the system has them ('' elsewhere): a PID means a process only within one. */
const PID_NAMESPACE = (() => { try { return fs.readlinkSync('/proc/self/ns/pid'); } catch { return ''; } })();

/**
 * What a lock taken by process `pid` holds: where it runs, which process it
 * is — its start time tells it from a later one given the same PID — and a
 * nonce of its own. The workspace gate's markers hold one too.
 */
export function ownerToken(pid: number): string {
  return JSON.stringify({ host: HOST, ns: PID_NAMESPACE, pid, started: startedAt(pid), nonce: crypto.randomBytes(8).toString('hex') });
}

function parseToken(token: string): { host: string; ns: string; pid: number; started: string } | null {
  try {
    const t = JSON.parse(token) as Record<string, unknown>;
    if (typeof t['host'] !== 'string' || typeof t['ns'] !== 'string' || typeof t['started'] !== 'string') return null;
    if (typeof t['pid'] !== 'number' || !Number.isInteger(t['pid']) || t['pid'] <= 0) return null;
    return { host: t['host'], ns: t['ns'], pid: t['pid'], started: t['started'] };
  } catch {
    return null;
  }
}

/** When process `pid` started, in clock ticks since boot (Linux); '' where that cannot be read. */
function startedAt(pid: number): string {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // The fields after the command name, which is in parentheses and may hold spaces; starttime is the 22nd.
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
  } catch {
    return '';
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
