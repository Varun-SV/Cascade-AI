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

  it('is off until the window has handed over the earlier build\'s choice (no file yet)', () => {
    expect(fileSyncConsent(file).allowed()).toBe(false);
    // Nothing stored by an earlier build: settled on, and kept across restarts.
    expect(fileSyncConsent(file).adoptLegacy(false)).toBe(true);
    expect(fileSyncConsent(file).allowed()).toBe(true);
  });

  it('settles on off when an earlier build kept an opt-out, so no run ends stamped on before that', () => {
    const consent = fileSyncConsent(file);
    // A run ending now (during the hand-over) reads off.
    expect(consent.allowed()).toBe(false);
    expect(consent.adoptLegacy(true)).toBe(false);
    expect(fileSyncConsent(file).allowed()).toBe(false);
  });

  it('never lets a stored opt-in undo an opt-out already kept, and lets a stored opt-out turn it off', () => {
    fileSyncConsent(file).setOptedOut(true);
    expect(fileSyncConsent(file).adoptLegacy(false)).toBe(false);
    fileSyncConsent(file).setOptedOut(false);
    expect(fileSyncConsent(file).adoptLegacy(false)).toBe(true);
    expect(fileSyncConsent(file).adoptLegacy(true)).toBe(false);
    expect(fileSyncConsent(file).allowed()).toBe(false);
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

  it('stops sending in this process when an opt-out cannot be written, and says it was not kept', () => {
    fileSyncConsent(file).setOptedOut(false);
    const failing = fileSyncConsent(file, {
      read: (f) => fs.readFileSync(f, 'utf8'),
      write: () => { throw new Error('disk full'); },
      rename: () => {},
    });
    expect(failing.allowed()).toBe(true);
    expect(() => failing.setOptedOut(true)).toThrow('disk full');
    expect(failing.allowed()).toBe(false);
    // A later opt-in that also cannot be written does not turn it back on.
    expect(() => failing.setOptedOut(false)).toThrow('disk full');
    expect(failing.allowed()).toBe(false);
  });
});
