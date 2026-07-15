import { describe, it, expect } from 'vitest';
import { HandoffStore, parseHandoffBody, normalizeCode, formatCode, HANDOFF_TTL_MS } from './handoff.js';

describe('parseHandoffBody', () => {
  it('accepts a well-formed transcript and normalizes title/skill', () => {
    const out = parseHandoffBody({
      title: '  My chat  ',
      skillId: 'general',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
    });
    expect('error' in out).toBe(false);
    if ('error' in out) return;
    expect(out.title).toBe('My chat');
    expect(out.skillId).toBe('general');
    expect(out.messages).toHaveLength(2);
  });

  it('drops blank turns and unknown roles, keeping order', () => {
    const out = parseHandoffBody({
      messages: [
        { role: 'system', content: 'ignored' },
        { role: 'user', content: '  ' },
        { role: 'user', content: 'real question' },
        { role: 'assistant', content: '' },
        { role: 'assistant', content: 'real answer' },
      ],
    });
    if ('error' in out) throw new Error(out.error);
    expect(out.messages).toEqual([
      { role: 'user', content: 'real question' },
      { role: 'assistant', content: 'real answer' },
    ]);
  });

  it('coerces a missing title/skill to null', () => {
    const out = parseHandoffBody({ messages: [{ role: 'user', content: 'x' }] });
    if ('error' in out) throw new Error(out.error);
    expect(out.title).toBeNull();
    expect(out.skillId).toBeNull();
  });

  it('rejects a body with no usable messages', () => {
    expect(parseHandoffBody({ messages: [] })).toEqual({ error: expect.any(String) });
    expect(parseHandoffBody({ messages: [{ role: 'system', content: 'x' }] })).toEqual({ error: expect.any(String) });
    expect(parseHandoffBody({})).toEqual({ error: expect.any(String) });
  });

  it('rejects an oversized transcript', () => {
    const huge = 'a'.repeat(20_000);
    const messages = Array.from({ length: 40 }, () => ({ role: 'user' as const, content: huge }));
    expect(parseHandoffBody({ messages })).toEqual({ error: expect.any(String) });
  });

  it('rejects too many messages', () => {
    const messages = Array.from({ length: 201 }, () => ({ role: 'user' as const, content: 'x' }));
    expect(parseHandoffBody({ messages })).toEqual({ error: expect.any(String) });
  });
});

describe('code formatting', () => {
  it('normalizes case, dashes and spaces to the storage key', () => {
    expect(normalizeCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeCode('ABCD EFGH')).toBe('ABCDEFGH');
    expect(normalizeCode('a b c d e f g h')).toBe('ABCDEFGH');
  });

  it('formats an 8-char code as XXXX-XXXX', () => {
    expect(formatCode('ABCDEFGH')).toBe('ABCD-EFGH');
    expect(formatCode('abcdefgh')).toBe('ABCD-EFGH');
  });
});

describe('HandoffStore', () => {
  const snapshot = {
    title: 'Test',
    skillId: null,
    messages: [{ role: 'user' as const, content: 'hi' }],
  };

  it('round-trips a snapshot by code (dash/case insensitive)', () => {
    const store = new HandoffStore();
    const { code } = store.create(snapshot);
    expect(code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    const got = store.get(code.toLowerCase().replace('-', ''));
    expect(got).not.toBeNull();
    expect(got!.title).toBe('Test');
    expect(got!.messages).toEqual(snapshot.messages);
  });

  it('returns null for an unknown code', () => {
    const store = new HandoffStore();
    expect(store.get('ZZZZ-ZZZZ')).toBeNull();
  });

  it('expires a snapshot after the TTL', () => {
    let now = 1_000_000;
    const store = new HandoffStore(() => now);
    const { code, expiresAt } = store.create(snapshot);
    expect(expiresAt).toBe(1_000_000 + HANDOFF_TTL_MS);

    now += HANDOFF_TTL_MS - 1;
    expect(store.get(code)).not.toBeNull(); // still inside the window

    now += 2;
    expect(store.get(code)).toBeNull(); // just past it
    expect(store.size()).toBe(0); // and swept from memory
  });

  it('reads are non-consuming within the TTL', () => {
    const store = new HandoffStore();
    const { code } = store.create(snapshot);
    expect(store.get(code)).not.toBeNull();
    expect(store.get(code)).not.toBeNull();
  });

  it('mints distinct codes for concurrent handoffs', () => {
    const store = new HandoffStore();
    const codes = new Set(Array.from({ length: 50 }, () => store.create(snapshot).code));
    expect(codes.size).toBe(50);
  });
});
