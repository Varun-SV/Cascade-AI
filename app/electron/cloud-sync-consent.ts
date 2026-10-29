// Whether the user lets the desktop copy its runs to the cloud, kept by the
// main process so the backend can read it when a run ends and the main
// process can check it again just before each upload. A run that ended while
// syncing was off is never uploaded, and one that ended while it was on is
// not uploaded once it has been turned off.
//
// Kept in a small JSON file in the app's data folder. No file means the user
// never turned syncing off (on, as before). A file that cannot be read or
// understood counts as off: not knowing is not consent.

import { readFileSync, writeFileSync, renameSync } from 'node:fs';

export interface SyncConsent {
  /** True only when syncing is known to be on. */
  allowed(): boolean;
  /** Turns syncing off (true) or on (false). Throws if it could not be kept. */
  setOptedOut(optedOut: boolean): void;
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
  return {
    allowed() {
      let raw: string;
      try { raw = fs.read(file); }
      catch (err) { return (err as { code?: unknown })?.code === 'ENOENT'; }
      try {
        const v = JSON.parse(raw) as unknown;
        return !!v && typeof v === 'object' && (v as { optedOut?: unknown }).optedOut === false;
      } catch { return false; }
    },
    setOptedOut(optedOut) {
      // Written whole, then moved over the old file, so a crash part-way
      // leaves the previous choice rather than a file that reads as nothing.
      const tmp = `${file}.tmp`;
      fs.write(tmp, JSON.stringify({ optedOut }));
      fs.rename(tmp, file);
    },
  };
}

/** What a mirror request answers when syncing is off now, so it is skipped, not retried. */
export const SYNC_OFF = { ok: false as const, syncOff: true as const, error: 'Cloud sync is off.' };
