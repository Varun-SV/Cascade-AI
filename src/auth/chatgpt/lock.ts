// ─────────────────────────────────────────────
//  Cascade AI — Sign in with ChatGPT: a lock held across an await
// ─────────────────────────────────────────────
//
//  A refresh is a network round trip and the refresh token ROTATES: two
//  processes refreshing at once would spend the same token twice, and the
//  second is refused as reused — which would sign the user out for nothing.
//  utils/file-lock's `withLock` is synchronous and cannot be held across an
//  await, so this is the same lock-file protocol (an owner token naming host,
//  PID and start time) in async form.
//
//  A lock whose owner is known to be gone is taken over at once. One whose
//  owner cannot be seen (another host or PID namespace) is taken over after
//  `staleMs`. A LIVE owner is never taken from, however long it takes: the
//  waiter gives up instead.

import fs from 'node:fs';
import { ownerState, ownerToken } from '../../utils/file-lock.js';
import { ChatGptAuthError } from './errors.js';

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function tryCreate(lock: string, token: string): boolean {
  try {
    fs.writeFileSync(lock, token, { flag: 'wx', mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
}

function readToken(lock: string): string {
  try { return fs.readFileSync(lock, 'utf8'); } catch { return ''; }
}

export async function withAsyncLock<T>(
  lock: string,
  fn: () => Promise<T>,
  opts: { waitMs?: number; staleMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<T> {
  const waitMs = opts.waitMs ?? 60_000;
  const staleMs = opts.staleMs ?? 120_000;
  const pollMs = opts.pollMs ?? 40;
  const sleep = opts.sleep ?? sleepReal;
  const token = ownerToken(process.pid);
  const deadline = Date.now() + waitMs;

  for (;;) {
    if (tryCreate(lock, token)) break;
    const st = fs.statSync(lock, { throwIfNoEntry: false });
    if (st) {
      const held = readToken(lock);
      const state = ownerState(held);
      const left = state === 'dead' || (state === 'unknown' && Date.now() - st.mtimeMs > staleMs);
      // Removed only if it is still the lock we looked at: a fresh one a
      // faster waiter just took must survive.
      if (left && readToken(lock) === held) { fs.rmSync(lock, { force: true }); continue; }
    }
    if (Date.now() > deadline) {
      throw new ChatGptAuthError('Another Cascade process is refreshing the ChatGPT sign-in. Try again in a moment.', 'transient');
    }
    await sleep(pollMs);
  }
  try {
    return await fn();
  } finally {
    if (readToken(lock) === token) fs.rmSync(lock, { force: true });
  }
}
