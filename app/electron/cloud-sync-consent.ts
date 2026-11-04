// Whether the user lets the desktop copy its runs to the cloud, kept by the
// main process so the backend can read it when a run ends and the main
// process can check it again just before each upload. A run that ended while
// syncing was off is never uploaded, and one that ended while it was on is
// not uploaded once it has been turned off.
//
// Kept in a small JSON file in the app's data folder. No file means the
// choice has not been settled yet (a first start, or the first start after an
// upgrade, before the window hands over what an earlier build kept): that
// counts as off until `adoptLegacy` writes it, so no run can end stamped on
// while an older opt-out is still being moved here. A file that cannot be
// read or understood counts as off too: not knowing is not consent.
//
// An opt-out takes effect in this process the moment it is asked for, even
// if it cannot be written down; the caller is still told it was not kept.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export interface SyncConsent {
  /** True only when syncing is known to be on. */
  allowed(): boolean;
  /** Turns syncing off (true) or on (false). Throws if it could not be kept. */
  setOptedOut(optedOut: boolean): void;
  /**
   * Settles the choice from what an earlier build kept (the window's stored
   * opt-out). With nothing kept here yet, the earlier choice is written; with
   * a choice already kept, it can only be turned off, never back on. Throws if
   * it could not be kept. Answers whether syncing is on afterwards.
   */
  adoptLegacy(legacyOptedOut: boolean): boolean;
}

/** File operations, replaceable in tests. */
export interface ConsentFs {
  read(file: string): string;
  write(file: string, data: string): void;
  rename(from: string, to: string): void;
}

const nodeFs: ConsentFs = {
  read: (f) => readFileSync(f, 'utf8'),
  write: (f, d) => writeFileSync(f, d, { mode: 0o600 }),
  rename: (a, b) => renameSync(a, b),
};

export function fileSyncConsent(file: string, fs: ConsentFs = nodeFs): SyncConsent {
  // Set when an opt-out is asked for, before it is written: a failed write
  // still stops this process from sending. Cleared only by a kept opt-in.
  let offHere = false;
  const kept = (): 'missing' | 'on' | 'off' => {
    let raw: string;
    try { raw = fs.read(file); }
    catch (err) { return (err as { code?: unknown })?.code === 'ENOENT' ? 'missing' : 'off'; }
    try {
      const v = JSON.parse(raw) as unknown;
      return !!v && typeof v === 'object' && (v as { optedOut?: unknown }).optedOut === false ? 'on' : 'off';
    } catch { return 'off'; }
  };
  const write = (optedOut: boolean): void => {
    // Written whole, then moved over the old file, so a crash part-way
    // leaves the previous choice rather than a file that reads as nothing.
    const tmp = `${file}.tmp`;
    fs.write(tmp, JSON.stringify({ optedOut }));
    fs.rename(tmp, file);
  };
  const allowed = (): boolean => !offHere && kept() === 'on';
  return {
    allowed,
    setOptedOut(optedOut) {
      if (optedOut) offHere = true;
      write(optedOut);
      if (!optedOut) offHere = false;
    },
    adoptLegacy(legacyOptedOut) {
      if (legacyOptedOut) offHere = true;
      const now = kept();
      if (now === 'missing') write(legacyOptedOut);
      else if (legacyOptedOut && now !== 'off') write(true);
      return allowed();
    },
  };
}

/** What a mirror request answers when syncing is off now, so it is skipped, not retried. */
export const SYNC_OFF = { ok: false as const, syncOff: true as const, error: 'Cloud sync is off.' };
