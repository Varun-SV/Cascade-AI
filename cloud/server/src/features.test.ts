import { describe, it, expect } from 'vitest';
import { buildRunPrompt, parseChatRunPayload } from './runs.js';
import { getSkill, skillCatalog } from './skills.js';

describe('buildRunPrompt', () => {
  it('returns the prompt unchanged when there is no skill and no memory', () => {
    expect(buildRunPrompt('hello', undefined, [])).toBe('hello');
  });

  it('prepends the skill system prompt', () => {
    const out = buildRunPrompt('review this', 'You are a code reviewer.', []);
    expect(out.startsWith('You are a code reviewer.')).toBe(true);
    expect(out.endsWith('review this')).toBe(true);
  });

  it('injects memories as a bulleted fact list', () => {
    const out = buildRunPrompt('hi', undefined, ['Prefers TypeScript', 'Based in India']);
    expect(out).toContain('Persistent facts about the user');
    expect(out).toContain('- Prefers TypeScript');
    expect(out).toContain('- Based in India');
    expect(out.endsWith('hi')).toBe(true);
  });

  it('combines skill and memories, keeping the user text last', () => {
    const out = buildRunPrompt('do it', 'Be terse.', ['Likes brevity']);
    expect(out.indexOf('Be terse.')).toBeLessThan(out.indexOf('Persistent facts'));
    expect(out.indexOf('Persistent facts')).toBeLessThan(out.indexOf('do it'));
  });

  it('injects attached document text before the user prompt', () => {
    const out = buildRunPrompt('summarize', undefined, [], [{ filename: 'report.pdf', text: 'Q3 revenue rose 12%.' }]);
    expect(out).toContain('The user attached a document');
    expect(out).toContain('<document filename="report.pdf">');
    expect(out).toContain('Q3 revenue rose 12%.');
    expect(out.indexOf('Q3 revenue rose 12%.')).toBeLessThan(out.indexOf('summarize'));
  });

  it('counts multiple documents and escapes quotes in filenames', () => {
    const out = buildRunPrompt('go', undefined, [], [
      { filename: 'a"b.txt', text: 'one' },
      { filename: 'c.md', text: 'two' },
    ]);
    expect(out).toContain('2 documents');
    expect(out).toContain('filename="a&quot;b.txt"');
  });
});

describe('skills catalog', () => {
  it('exposes id/name/description only (no system prompts leak)', () => {
    const catalog = skillCatalog();
    expect(catalog.length).toBeGreaterThan(0);
    for (const s of catalog) {
      expect(Object.keys(s).sort()).toEqual(['description', 'id', 'name']);
    }
  });

  it('resolves a known skill and returns undefined for unknown/blank ids', () => {
    expect(getSkill('code-reviewer')?.systemPrompt).toContain('code review');
    expect(getSkill('nope')).toBeUndefined();
    expect(getSkill(undefined)).toBeUndefined();
    expect(getSkill('')).toBeUndefined();
  });
});

describe('parseChatRunPayload — attachments & skill', () => {
  const base = { prompt: 'hi', providers: [{ type: 'anthropic', apiKey: 'sk' }] };

  it('accepts attachmentIds and a skillId', () => {
    const parsed = parseChatRunPayload({ ...base, attachmentIds: ['a', 'b'], skillId: 'code-reviewer' });
    expect(parsed.attachmentIds).toEqual(['a', 'b']);
    expect(parsed.skillId).toBe('code-reviewer');
  });

  it('coerces a blank skillId to undefined and caps attachments at 8', () => {
    const parsed = parseChatRunPayload({ ...base, skillId: '' });
    expect(parsed.skillId).toBeUndefined();
    expect(() => parseChatRunPayload({ ...base, attachmentIds: ['1', '2', '3', '4', '5', '6', '7', '8', '9'] })).toThrow();
  });
});
