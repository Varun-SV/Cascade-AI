import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { composerStep, loadDrafts, saveDrafts } from './drafts.js';

describe('messages waiting to be sent', () => {
  let data: Record<string, string>;
  beforeEach(() => {
    data = {};
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => { data[k] = v; },
    };
  });
  afterEach(() => { delete (globalThis as { localStorage?: unknown }).localStorage; });

  it('outlive the window, by session', () => {
    const draft = { sessionId: 's1', prompt: 'open these', attachments: [{ id: 'f1', kind: 'image' as const, mime: 'image/png', filename: null }] };
    saveDrafts({ s1: draft });
    expect(loadDrafts()).toEqual({ s1: draft });
  });

  it('a stored one that is not a draft is dropped; no storage is no drafts', () => {
    data['cascade-composer-drafts'] = JSON.stringify({ s1: { sessionId: 'other', prompt: 'x', attachments: [] }, s2: { prompt: 3 }, s3: { sessionId: 's3', prompt: 'ok', attachments: [] } });
    expect(Object.keys(loadDrafts())).toEqual(['s3']);
    data['cascade-composer-drafts'] = 'not json';
    expect(loadDrafts()).toEqual({});
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(loadDrafts()).toEqual({});
    expect(() => saveDrafts({})).not.toThrow();
  });
});

describe("a draft in the composer is its chat's alone", () => {
  const draft = { sessionId: 'a', prompt: 'open these', attachments: [{ id: 'f1', kind: 'image' as const, mime: 'image/png', filename: null }] };

  it('fills the composer in its chat, and leaving it for a chat without one empties it', () => {
    const shown = composerStep(null, 'a', draft);
    expect(shown).toEqual({ kind: 'set', input: 'open these', pending: draft.attachments, shownFor: 'a' });
    expect(composerStep('a', 'b', undefined)).toEqual({ kind: 'set', input: '', pending: [], shownFor: null });
  });

  it("leaves alone what the user typed in a chat that never had one", () => {
    expect(composerStep(null, 'b', undefined)).toEqual({ kind: 'keep' });
    expect(composerStep(null, 'c', undefined)).toEqual({ kind: 'keep' });
  });

  it('another chat with its own draft shows that one', () => {
    const other = { ...draft, sessionId: 'b', prompt: 'other' };
    expect(composerStep('a', 'b', other)).toMatchObject({ input: 'other', shownFor: 'b' });
  });
});
