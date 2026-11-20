import { describe, it, expect } from 'vitest';
import {
  chatWorthReading, estimateBuild, extractFromChat, normalizeCategory, reconcile, similarity,
  type ChatForMemory, type MemoryCandidate,
} from './memory-builder.js';

const chat = (id: string, userLines: string[], assistant = 'Sure, here is how.'): ChatForMemory => ({
  id,
  messages: userLines.flatMap((u, i) => [
    { role: 'user' as const, content: u, createdAt: 1000 + i * 10 },
    { role: 'assistant' as const, content: assistant, createdAt: 1005 + i * 10 },
  ]),
});
const reply = (items: unknown[]) => async () => JSON.stringify(items);

describe('extractFromChat', () => {
  const c = chat('c1', ['I build everything in TypeScript and deploy to Railway.', 'Please never use emojis in replies to me.']);

  it('keeps memories whose quote is the person\'s own words, with that quote as evidence', async () => {
    const out = await extractFromChat(c, reply([
      { category: 'preferences', memory: 'You build in TypeScript.', durable: true, quote: 'I build everything in TypeScript' },
      { category: 'instructions', memory: 'Never use emojis in replies.', durable: true, quote: 'never use emojis in replies to me' },
    ]));
    expect(out.map((m) => [m.category, m.content])).toEqual([
      ['preferences', 'You build in TypeScript.'],
      ['instructions', 'Never use emojis in replies.'],
    ]);
    expect(out[0]!.evidence).toEqual([{ conversationId: 'c1', quote: 'I build everything in TypeScript', at: 1000 }]);
    expect(out[1]!.evidence[0]!.at).toBe(1010);
  });

  it('drops a memory whose quote the person never wrote, or that only the assistant said', async () => {
    const out = await extractFromChat(chat('c2', ['I like short answers about my Go service.'], 'You should try Rust.'), reply([
      { category: 'preferences', memory: 'You like Rust.', durable: true, quote: 'You should try Rust.' },
      { category: 'facts', memory: 'You live in Paris.', durable: true, quote: 'I live in Paris' },
      { category: 'preferences', memory: 'You like short answers.', durable: true, quote: 'I like short answers' },
    ]));
    expect(out.map((m) => m.content)).toEqual(['You like short answers.']);
  });

  it('reads "durable: false" as current context, maps loose categories, and never throws', async () => {
    const out = await extractFromChat(c, reply([{ category: 'PROJECT', memory: 'You deploy to Railway.', durable: false, quote: 'deploy to Railway' }]));
    expect(out[0]).toMatchObject({ category: 'projects', durability: 'volatile' });
    expect(await extractFromChat(c, async () => 'not json at all')).toEqual([]);
    expect(await extractFromChat(c, async () => { throw new Error('rate limited'); })).toEqual([]);
  });

  it('a chat with nothing of the person\'s own is not read at all', async () => {
    let called = false;
    expect(await extractFromChat(chat('c3', ['hi']), async () => { called = true; return '[]'; })).toEqual([]);
    expect(called).toBe(false);
    expect(chatWorthReading(chat('c3', ['hi']))).toBe(false);
  });
});

describe('reconcile', () => {
  const cand = (content: string, conversationId: string, category: MemoryCandidate['category'] = 'preferences'): MemoryCandidate => ({
    category, content, durability: 'permanent', status: 'new', evidence: [{ conversationId, quote: content, at: 1 }],
  });

  it('the same memory from several chats is one candidate with all its evidence', () => {
    const out = reconcile([], [cand('You prefer TypeScript for backend work.', 'a'), cand('You prefer TypeScript for backend work', 'b')]);
    expect(out).toHaveLength(1);
    expect(out[0]!.evidence.map((e) => e.conversationId)).toEqual(['a', 'b']);
  });

  it('one already kept is known; one a kept memory says differently is a revision; the rest are new', () => {
    const kept = [
      { id: 'm1', content: 'You prefer TypeScript for backend work.', category: 'STACK', durability: 'permanent' as const },
      { id: 'm2', content: 'You are building Cascade, a CLI for AI orchestration.', category: 'projects', durability: 'permanent' as const },
    ];
    const out = reconcile(kept, [
      cand('You prefer TypeScript for backend work.', 'a'),
      cand('You are building Cascade, a desktop and cloud app for AI orchestration.', 'b', 'projects'),
      cand('You live in Bengaluru.', 'c', 'about-you'),
    ]);
    expect(out.map((c) => [c.category, c.status, c.matches?.id])).toEqual([
      ['about-you', 'new', undefined],
      ['preferences', 'known', 'm1'],
      ['projects', 'revision', 'm2'],
    ]);
  });

  it('a related memory in another category is not taken for a revision', () => {
    const out = reconcile([{ id: 'm1', content: 'You use TypeScript at work.', category: 'facts', durability: 'permanent' }], [cand('You prefer TypeScript at work.', 'a')]);
    expect(out[0]!.status).toBe('new');
  });
});

describe('normalizeCategory and similarity', () => {
  it('reads older, typed categories into the six', () => {
    expect(normalizeCategory('STACK')).toBe('preferences');
    expect(normalizeCategory('STYLE')).toBe('preferences');
    expect(normalizeCategory('PROJECT')).toBe('projects');
    expect(normalizeCategory('session')).toBe('facts');
    expect(normalizeCategory('about-you')).toBe('about-you');
    expect(normalizeCategory(null)).toBe('facts');
  });
  it('scores shared words, ignoring filler', () => {
    expect(similarity('You prefer TypeScript.', 'you prefer typescript')).toBe(1);
    expect(similarity('You prefer TypeScript.', 'You live in Paris.')).toBe(0);
  });
});

describe('estimateBuild', () => {
  it('counts only chats worth reading, a call each', () => {
    const e = estimateBuild([chat('a', ['I build everything in TypeScript and deploy to Railway.']), chat('b', ['hi'])]);
    expect(e.chats).toBe(1);
    expect(e.inputTokens).toBeGreaterThan(450);
    expect(e.outputTokens).toBe(350);
  });
});

describe('estimateBuildCostUsd', () => {
  it('prices the tokens on the model, and gives no figure for a model with no known price', async () => {
    const { estimateBuildCostUsd } = await import('./memory-builder.js');
    const priced = { id: 'm', name: 'm', inputCostPer1kTokens: 0.003, outputCostPer1kTokens: 0.015 } as never;
    expect(estimateBuildCostUsd({ inputTokens: 10_000, outputTokens: 1_000 }, priced)).toBeCloseTo(0.045, 3);
    expect(estimateBuildCostUsd({ inputTokens: 10_000, outputTokens: 1_000 }, undefined)).toBeNull();
    expect(estimateBuildCostUsd({ inputTokens: 10_000, outputTokens: 1_000 }, { id: 'x', name: 'x', isLocal: true } as never)).toBe(0);
  });
});

describe('similarity on hostile input', () => {
  it('stays fast on a long run of dashes, and still drops trailing punctuation', async () => {
    const { similarity } = await import('./memory-builder.js');
    const evil = `a${'-'.repeat(100_000)}b ${'-'.repeat(100_000)}`;
    const t = Date.now();
    similarity(evil, evil);
    expect(Date.now() - t).toBeLessThan(500);
    expect(similarity('Uses Go.', 'uses go')).toBe(1);
  });
});

describe('Codex on bca3626', () => {
  const chat = {
    id: 'c1', title: 't',
    messages: [{ role: 'user' as const, content: 'I am a backend engineer in Lisbon and I write services in Go for a payments team', createdAt: 5 }],
  };

  it('skips a null or non-object item from the model instead of throwing', async () => {
    const { extractFromChat } = await import('./memory-builder.js');
    const out = await extractFromChat(chat, async () => JSON.stringify([null, 3, 'x', [], { category: 'about-you', memory: 'Engineer in Lisbon', quote: 'backend engineer in Lisbon' }]));
    expect(out.map((c) => c.content)).toEqual(['Engineer in Lisbon']);
  });

  it('keeps the most recent evidence, as many as a memory holds, when one memory is said in many chats', async () => {
    const { reconcile, MAX_EVIDENCE } = await import('./memory-builder.js');
    const found = Array.from({ length: 20 }, (_, i) => ({
      category: 'preferences' as const, content: 'Prefers Go', durability: 'permanent' as const, status: 'new' as const,
      evidence: [{ conversationId: `c${i}`, quote: 'Go', at: i }],
    }));
    const [one] = reconcile([], found);
    expect(one!.evidence).toHaveLength(MAX_EVIDENCE);
    expect(one!.evidence[0]!.at).toBe(19);
  });

  it('an already-kept memory keeps its own wording', async () => {
    const { reconcile } = await import('./memory-builder.js');
    const [c] = reconcile([{ id: 'm1', content: 'Prefers Go for services', category: 'preferences', durability: 'permanent' }], [
      { category: 'preferences', content: 'Prefers Go for services.', durability: 'permanent', status: 'new', evidence: [{ conversationId: 'c', quote: 'Go', at: 1 }] },
    ]);
    expect(c).toMatchObject({ status: 'known', content: 'Prefers Go for services' });
  });
});

describe('Codex on 411b9d6', () => {
  it('the same words in another order are a change to review, not a repeat', async () => {
    const { reconcile, sameClaim } = await import('./memory-builder.js');
    const was = 'You are migrating the payments service from Python to Rust';
    const now = 'You are migrating the payments service from Rust to Python';
    expect(sameClaim(was, now)).toBe(false);
    expect(sameClaim(was, `${was}.`)).toBe(true);
    const [c] = reconcile([{ id: 'm1', content: was, category: 'projects', durability: 'permanent' }], [
      { category: 'projects', content: now, durability: 'permanent', status: 'new', evidence: [{ conversationId: 'c', quote: 'q', at: 1 }] },
    ]);
    expect(c).toMatchObject({ status: 'revision', content: now, matches: { id: 'm1' } });
    // Nor are two such candidates merged into one.
    const ev = [{ conversationId: 'c', quote: 'q', at: 1 }];
    expect(reconcile([], [
      { category: 'projects', content: was, durability: 'permanent', status: 'new', evidence: ev },
      { category: 'projects', content: now, durability: 'permanent', status: 'new', evidence: ev },
    ])).toHaveLength(2);
  });
});
