import { describe, expect, it } from 'vitest';
import { fieldFromSnapshot, numberFieldFromSnapshot } from './snapshot-apply';

describe('a complete snapshot replaces, it does not merge', () => {
  // `settingsSnapshot()` carries every section the save can write, so a field
  // coming back `undefined` says "nothing is configured" rather than "no
  // information". Applying only the values that were present meant a setting
  // cleared elsewhere survived in the form and was recreated by the next
  // unrelated save.
  it('replaces a stale form value with the default when the snapshot has none', () => {
    expect(fieldFromSnapshot(undefined, '')).toBe('');
    expect(fieldFromSnapshot(null, 'auto')).toBe('auto');
  });

  it('keeps a value the snapshot does carry', () => {
    expect(fieldFromSnapshot('http://searx.internal', '')).toBe('http://searx.internal');
  });

  it('does not mistake falsy-but-set for unset', () => {
    // `0` and `false` are configured values. A truthiness check here was the
    // bug for SearXNG's URL and would be worse for a numeric or boolean knob.
    expect(fieldFromSnapshot(0, 8)).toBe(0);
    expect(fieldFromSnapshot(false, true)).toBe(false);
    expect(fieldFromSnapshot('', 'fallback')).toBe('');
  });

  it('blanks a numeric input the snapshot no longer sets', () => {
    expect(numberFieldFromSnapshot(undefined)).toBe('');
    expect(numberFieldFromSnapshot(0)).toBe('0');
    expect(numberFieldFromSnapshot(20)).toBe('20');
  });

  it('the reported sequence: form holds A, snapshot says unset, form must clear', () => {
    const formHeld = 'http://searx.internal';
    const snapshotSays = undefined;
    // Old behaviour kept `formHeld`, and the next save wrote it back.
    expect(fieldFromSnapshot(snapshotSays, '')).toBe('');
    expect(fieldFromSnapshot(snapshotSays, '')).not.toBe(formHeld);
  });
});
