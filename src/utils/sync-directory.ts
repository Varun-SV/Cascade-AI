import fs from 'node:fs';

/** Persist directory-entry changes on POSIX; Node cannot flush Windows directory handles. */
export function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
