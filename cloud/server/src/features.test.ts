import { describe, it, expect } from 'vitest';
import { buildRunPrompt, parseChatRunPayload, wantsFileDelivery, FILE_DELIVERY_GUIDANCE } from './runs.js';
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

describe('wantsFileDelivery (file-guidance gate)', () => {
  it('fires for prompts that explicitly ask for a file/document/export', () => {
    expect(wantsFileDelivery('write a report and save it as report.md')).toBe(true);
    expect(wantsFileDelivery('export this as CSV')).toBe(true);
    expect(wantsFileDelivery('make me a word document about pandas')).toBe(true);
    expect(wantsFileDelivery('generate a config.json for this')).toBe(true);
    expect(wantsFileDelivery('can you give me a downloadable summary?')).toBe(true);
    expect(wantsFileDelivery('turn this into a PowerPoint deck')).toBe(true);
    expect(wantsFileDelivery('put the numbers in an Excel spreadsheet')).toBe(true);
    expect(wantsFileDelivery('build a slide presentation on Q3')).toBe(true);
  });

  it('stays quiet for conversation and ordinary questions', () => {
    expect(wantsFileDelivery('hello')).toBe(false);
    expect(wantsFileDelivery('hi')).toBe(false);
    expect(wantsFileDelivery('3')).toBe(false);
    expect(wantsFileDelivery('what is a monad')).toBe(false);
    expect(wantsFileDelivery('explain this code to me')).toBe(false);
  });

  it('fires when the active skill is file-oriented', () => {
    expect(wantsFileDelivery('summarize our chat', 'You produce a structured report document.')).toBe(true);
  });

  it('keeps guidance for follow-ups to an already-delivered file', () => {
    const history = [
      { role: 'user', content: 'make a csv of the results' },
      { role: 'assistant', content: 'Here you go:\n```file:results.csv\na,b\n1,2\n```' },
      { role: 'user', content: 'now change the header row' },
    ];
    expect(wantsFileDelivery('now change the header row', undefined, history)).toBe(true);
  });

  it('guidance text is echo-proof and intent-gated', () => {
    // No fenced example a small model could echo verbatim…
    expect(FILE_DELIVERY_GUIDANCE).not.toContain('```');
    // …and the instruction is explicitly conditional.
    expect(FILE_DELIVERY_GUIDANCE).toContain('ONLY');
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
