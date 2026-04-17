import { describe, expect, it } from 'vitest';
import {
  containsMouseSequence,
  sanitizeTerminalInput,
  MOUSE_SGR_RE,
  PASTE_START,
  PASTE_END,
} from './terminal-input.js';

describe('sanitizeTerminalInput', () => {
  it('strips SGR mouse sequences that leak into text inputs', () => {
    const dirty = 'sk-proj-abc\x1b[<2;98;44M123';
    expect(sanitizeTerminalInput(dirty)).toBe('sk-proj-abc123');
  });

  it('strips the sequence the user reported verbatim', () => {
    expect(sanitizeTerminalInput('[<2;98;44M[<2;98;44m')).toBe('[<2;98;44M[<2;98;44m');
    // Only escape-prefixed sequences should be stripped; visible characters stay.
    expect(sanitizeTerminalInput('\x1b[<2;98;44M\x1b[<2;98;44m')).toBe('');
  });

  it('strips legacy x10 mouse reports', () => {
    const dirty = 'hello\x1b[M \x20\x20world';
    expect(sanitizeTerminalInput(dirty)).toBe('helloworld');
  });

  it('strips CSI navigation sequences (arrow keys) when they slip in', () => {
    expect(sanitizeTerminalInput('\x1b[Aabc')).toBe('abc');
    expect(sanitizeTerminalInput('\x1b[3~abc')).toBe('abc');
  });

  it('preserves \\x7F (delete/backspace) so ink-text-input can still delete', () => {
    expect(sanitizeTerminalInput('abc\x7F')).toBe('abc\x7F');
  });

  it('preserves printable unicode and ordinary ASCII', () => {
    const keyLike = 'sk-proj-AZ09_-. αβγ 日本語';
    expect(sanitizeTerminalInput(keyLike)).toBe(keyLike);
  });

  it('strips DCS and OSC sequences', () => {
    expect(sanitizeTerminalInput('pre\x1bPfoobar\x1b\\post')).toBe('prepost');
    expect(sanitizeTerminalInput('pre\x1b]0;title\x07post')).toBe('prepost');
  });

  it('leaves \\n and \\r intact (useful for multi-line pastes)', () => {
    // \t (0x09), \n (0x0A), \r (0x0D) are in the preserved ranges.
    expect(sanitizeTerminalInput('line1\nline2')).toBe('line1\nline2');
    expect(sanitizeTerminalInput('line1\tline2')).toBe('line1\tline2');
  });
});

describe('containsMouseSequence', () => {
  it('detects SGR mouse reports', () => {
    expect(containsMouseSequence('\x1b[<2;98;44M')).toBe(true);
    expect(containsMouseSequence('\x1b[<0;1;1m')).toBe(true);
  });

  it('detects legacy mouse reports', () => {
    expect(containsMouseSequence('\x1b[M   ')).toBe(true);
  });

  it('returns false for ordinary keypresses', () => {
    expect(containsMouseSequence('hello')).toBe(false);
    expect(containsMouseSequence('\x1b[A')).toBe(false); // up arrow
    expect(containsMouseSequence('\x1b[3~')).toBe(false); // delete
  });
});

describe('MOUSE_SGR_RE (global matcher)', () => {
  it('matches multiple occurrences', () => {
    const matches = '\x1b[<0;1;1M...\x1b[<64;5;5m'.match(MOUSE_SGR_RE);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBe(2);
  });
});

describe('bracketed paste markers', () => {
  it('exports the canonical start/end markers', () => {
    expect(PASTE_START).toBe('\x1b[200~');
    expect(PASTE_END).toBe('\x1b[201~');
  });
});
