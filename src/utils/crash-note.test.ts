import { afterEach, describe, expect, it } from 'vitest';
import { nativeRun, onCrashNote } from './crash-note.js';

afterEach(() => onCrashNote(null));

describe('crash notes', () => {
  it('one run finishing leaves the others still running in the note (Codex on 5b80217)', () => {
    const notes: Array<string | null> = [];
    onCrashNote((d) => notes.push(d));
    const a = nativeRun('running tool A');
    const b = nativeRun('running tool B');
    a();
    expect(notes.at(-1)).toBe('running tool B');
    a(); // twice is once
    expect(notes.at(-1)).toBe('running tool B');
    b();
    expect(notes).toEqual(['running tool A', 'running tool A and running tool B', 'running tool B', null]);
  });

  it('a listener that throws never stops the work; one added mid-run is told at once', () => {
    onCrashNote(() => { throw new Error('disk full'); });
    const over = nativeRun('running tool C');
    const seen: Array<string | null> = [];
    onCrashNote((d) => seen.push(d));
    expect(seen).toEqual(['running tool C']);
    expect(() => over()).not.toThrow();
    expect(seen.at(-1)).toBeNull();
  });
});
