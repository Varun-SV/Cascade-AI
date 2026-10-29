import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileSyncConsent } from './cloud-sync-consent';

describe('the desktop\'s cloud-sync consent', () => {
  let dir: string;
  let file: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-consent-')); file = path.join(dir, 'cloud-sync.json'); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('is on when the user never turned it off (no file)', () => {
    expect(fileSyncConsent(file).allowed()).toBe(true);
  });

  it('keeps an opt-out, and an opt-in after it, across restarts', () => {
    fileSyncConsent(file).setOptedOut(true);
    expect(fileSyncConsent(file).allowed()).toBe(false);
    fileSyncConsent(file).setOptedOut(false);
    expect(fileSyncConsent(file).allowed()).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
  });

  it('counts a file it cannot read or understand as off', () => {
    for (const bad of ['', 'not json', 'null', '{}', '{"optedOut":"no"}', '[false]']) {
      fs.writeFileSync(file, bad);
      expect(fileSyncConsent(file).allowed(), bad).toBe(false);
    }
    const unreadable = fileSyncConsent(file, {
      read: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
      write: () => {}, rename: () => {},
    });
    expect(unreadable.allowed()).toBe(false);
  });

  it('leaves the previous choice in place when a write fails part-way', () => {
    fileSyncConsent(file).setOptedOut(true);
    const failing = fileSyncConsent(file, {
      read: (f) => fs.readFileSync(f, 'utf8'),
      write: () => { throw new Error('disk full'); },
      rename: () => {},
    });
    expect(() => failing.setOptedOut(false)).toThrow('disk full');
    expect(fileSyncConsent(file).allowed()).toBe(false);
  });
});
