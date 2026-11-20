import { describe, it, expect } from 'vitest';
import {
  SKILL_LIMITS, chatDigest, draftSkillPrompt, estimateSuggest, parseSkillDraft, parseSkillSuggestions, refineSkillPrompt, suggestSkillsPrompt,
} from './skill-builder.js';

const chat = (id: string, asks: string[], title = `Chat ${id}`) => ({
  id, title, messages: asks.flatMap((a) => [{ role: 'user' as const, content: a }, { role: 'assistant' as const, content: 'SECRET ASSISTANT TEXT' }]),
});

describe('skill drafts', () => {
  it('reads a draft, cut to the store\'s limits, and refuses one with no name or instructions', () => {
    const d = parseSkillDraft('```json\n{"name": "Security   reviewer", "description": "Reviews diffs.", "instructions": "You are a security reviewer."}\n```');
    expect(d).toEqual({ name: 'Security reviewer', description: 'Reviews diffs.', instructions: 'You are a security reviewer.' });
    const long = parseSkillDraft(JSON.stringify({ name: 'x'.repeat(100), description: 'd'.repeat(500), instructions: 'i'.repeat(9000) }))!;
    expect(long.name).toHaveLength(SKILL_LIMITS.name);
    expect(long.description).toHaveLength(SKILL_LIMITS.description);
    expect(long.instructions).toHaveLength(SKILL_LIMITS.instructions);
    expect(parseSkillDraft('{"name": "x"}')).toBeNull();
    expect(parseSkillDraft('not json')).toBeNull();
    expect(parseSkillDraft('[1,2]')).toBeNull();
  });

  it('asks for what the person wants, and a refine keeps the skill it changes', () => {
    expect(draftSkillPrompt('review PRs for security')).toContain('review PRs for security');
    const p = refineSkillPrompt({ name: 'Tutor', description: 'Teaches SQL', instructions: 'You teach SQL.' }, 'be stricter about joins');
    expect(p).toContain('You teach SQL.');
    expect(p).toContain('be stricter about joins');
  });
});

describe('skill suggestions from chats', () => {
  it('the digest holds the person\'s asks only, never the assistant\'s replies, with each chat\'s id', () => {
    const { text, ids } = chatDigest([chat('c1', ['review this PR for injection']), chat('c2', [])]);
    expect(text).toContain('[c1] Chat c1');
    expect(text).toContain('review this PR for injection');
    expect(text).not.toContain('SECRET ASSISTANT TEXT');
    expect([...ids]).toEqual(['c1']);
  });

  it('keeps a suggestion only when it names two or more chats it was shown, and drops names already taken', () => {
    const shown = new Set(['c1', 'c2', 'c3']);
    const raw = JSON.stringify([
      { name: 'PR security review', description: 'd', instructions: 'You review PRs.', why: 'Asked in three chats', chats: ['c1', 'c2', 'c2', 'zz'] },
      { name: 'One-off', description: 'd', instructions: 'x', why: 'w', chats: ['c1'] },
      { name: 'Invented', description: 'd', instructions: 'x', why: 'w', chats: ['made-up', 'also-made-up'] },
      { name: 'SQL Tutor', description: 'd', instructions: 'x', why: 'w', chats: ['c1', 'c3'] },
      null,
    ]);
    const out = parseSkillSuggestions(raw, shown, ['sql tutor']);
    expect(out).toEqual([{ name: 'PR security review', description: 'd', instructions: 'You review PRs.', why: 'Asked in three chats', chats: ['c1', 'c2'] }]);
    expect(parseSkillSuggestions('nope', shown)).toEqual([]);
  });

  it('the prompt names skills the person has, and the estimate counts the chats it reads', () => {
    expect(suggestSkillsPrompt('[c1] x', ['SQL Tutor'])).toContain('SQL Tutor');
    const est = estimateSuggest([chat('c1', ['a']), chat('c2', ['b']), chat('c3', [])]);
    expect(est.chats).toBe(2);
    expect(est.inputTokens).toBeGreaterThan(500);
  });
});
