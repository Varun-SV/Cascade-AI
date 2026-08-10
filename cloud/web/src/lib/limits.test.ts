// The server-side prompt cap is gone, which leaves socket.io's 2 MB
// `maxHttpBufferSize` as the real ceiling — and that one is silent. An
// oversized frame is dropped by the transport before any handler runs, so
// there is no ack and no error: the message just never answers. The client
// has to be what says "too long".

import { describe, it, expect } from 'vitest';
import { byteLength, formatBytes, promptTooLargeError, MAX_PROMPT_BYTES, MAX_SOCKET_FRAME_BYTES } from './limits.js';

describe('byteLength', () => {
  it('counts UTF-8 bytes, not UTF-16 units', () => {
    expect(byteLength('abc')).toBe(3);
    // A 4-byte emoji is length 2 in JS. Measuring with .length would let a
    // prompt of emoji through at twice the byte budget.
    expect('😀'.length).toBe(2);
    expect(byteLength('😀')).toBe(4);
    expect(byteLength('é')).toBe(2);
  });
});

describe('promptTooLargeError', () => {
  it('passes an ordinary message', () => {
    expect(promptTooLargeError('hello')).toBeNull();
  });

  it('passes a long-but-sendable message — the case the old cap broke', () => {
    // 200k characters is ten times the cap that used to reject it.
    expect(promptTooLargeError('x'.repeat(200_000))).toBeNull();
  });

  it('rejects a message past the limit, and says what to do', () => {
    const msg = promptTooLargeError('x'.repeat(MAX_PROMPT_BYTES + 1));
    expect(msg).toBeTruthy();
    expect(msg).toContain('smaller pieces');
  });

  it('accepts a message exactly at the limit', () => {
    expect(promptTooLargeError('x'.repeat(MAX_PROMPT_BYTES))).toBeNull();
  });

  it('measures multi-byte text by bytes, so emoji cannot slip past', () => {
    // Half the byte budget in characters, but each is 4 bytes → over.
    expect(promptTooLargeError('😀'.repeat(MAX_PROMPT_BYTES / 2))).toBeTruthy();
  });

  it('leaves headroom under the transport ceiling for the rest of the payload', () => {
    // Guarding AT 2 MB would let a prompt just under the line push the
    // JSON-encoded frame just over it — the silent-hang case again.
    expect(MAX_PROMPT_BYTES).toBeLessThan(MAX_SOCKET_FRAME_BYTES);
    expect(MAX_SOCKET_FRAME_BYTES - MAX_PROMPT_BYTES).toBeGreaterThan(100_000);
  });
});

describe('formatBytes', () => {
  it('renders sizes a person can compare against the limit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1024 * 1024 * 2)).toBe('2.0 MB');
  });
});
