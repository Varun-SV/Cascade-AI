import { describe, it, expect, vi } from 'vitest';
import {
  distillSessionFacts, buildSessionTranscript, sessionWorthRemembering,
} from './session-memory.js';
import type { ConversationMessage } from '../../types.js';

describe('sessionWorthRemembering', () => {
  it('skips trivial exchanges', () => {
    expect(sessionWorthRemembering([], 'hi', 'Hello!')).toBe(false);
    expect(sessionWorthRemembering([{ role: 'user', content: 'hi' }], 'thanks', 'yw')).toBe(false);
  });
  it('keeps substantive multi-turn sessions', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: 'Set up the deploy' },
      { role: 'assistant', content: 'x'.repeat(150) },
    ];
    expect(sessionWorthRemembering(history, 'Use Railway', 'y'.repeat(120))).toBe(true);
  });
});

describe('buildSessionTranscript', () => {
  it('includes history + final turn and caps length', () => {
    const history: ConversationMessage[] = [{ role: 'user', content: 'earlier' }];
    const t = buildSessionTranscript(history, 'latest question', 'the answer', 6000);
    expect(t).toContain('user: earlier');
    expect(t).toContain('user: latest question');
    expect(t).toContain('assistant: the answer');
  });
  it('flattens multimodal content and trims to the tail when over budget', () => {
    const history: ConversationMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', image: { data: 'x', mimeType: 'image/png' } as never }] },
    ];
    const t = buildSessionTranscript(history, 'a'.repeat(9000), 'end', 100);
    expect(t.length).toBeLessThanOrEqual(100);
    expect(t.endsWith('assistant: end')).toBe(true);
  });
});

describe('distillSessionFacts', () => {
  it('parses a JSON array of triples from the model reply', async () => {
    const gen = vi.fn().mockResolvedValue(
      'Sure:\n[{"entity":"user","relation":"prefers","value":"TypeScript"},{"entity":"project","relation":"deploys_to","value":"Railway"}]',
    );
    const facts = await distillSessionFacts('…', gen);
    expect(facts).toEqual([
      { entity: 'user', relation: 'prefers', value: 'TypeScript' },
      { entity: 'project', relation: 'deploys_to', value: 'Railway' },
    ]);
  });
  it('returns [] on no array, malformed JSON, or a thrown generate', async () => {
    expect(await distillSessionFacts('x', vi.fn().mockResolvedValue('nothing here'))).toEqual([]);
    expect(await distillSessionFacts('x', vi.fn().mockResolvedValue('[not json'))).toEqual([]);
    expect(await distillSessionFacts('x', vi.fn().mockRejectedValue(new Error('boom')))).toEqual([]);
  });
  it('drops malformed triples and caps at 6', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ entity: `e${i}`, relation: 'r', value: 'v' }));
    const gen = vi.fn().mockResolvedValue(JSON.stringify([{ entity: 'ok', relation: 'r', value: 'v' }, { entity: '', relation: 'r', value: 'v' }, { nope: true }, ...many]));
    const facts = await distillSessionFacts('x', gen);
    expect(facts.length).toBeLessThanOrEqual(6);
    expect(facts[0]).toEqual({ entity: 'ok', relation: 'r', value: 'v' });
  });
});
