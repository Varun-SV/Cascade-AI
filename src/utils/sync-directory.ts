import fs from 'node:fs';

/** Flush a completed regular file; Windows requires a writable handle. */
export function syncFile(file: string): void {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Persist directory-entry changes on POSIX; Node cannot flush Windows directory handles. */
export function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
