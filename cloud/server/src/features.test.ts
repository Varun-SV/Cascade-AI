import { describe, it, expect } from 'vitest';
import { buildRunPrompt, parseChatRunPayload, formatZodError, wantsFileDelivery, FILE_DELIVERY_GUIDANCE } from './runs.js';
import { ZodError } from 'zod';
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

  it('injects memories as markdown, split by how long each fact should hold', () => {
    const out = buildRunPrompt('hi', undefined, [
      { content: 'Prefers TypeScript', durability: 'permanent' },
      { content: 'Migrating the billing service this sprint', durability: 'volatile' },
    ]);
    expect(out).toContain('## Stable facts');
    expect(out).toContain('- Prefers TypeScript');
    expect(out).toContain('## Current context');
    expect(out).toContain('- Migrating the billing service this sprint');
    // A durable fact must not be filed under the heading that tells the model
    // to distrust it when the user says otherwise.
    expect(out.indexOf('Prefers TypeScript')).toBeLessThan(out.indexOf('## Current context'));
    expect(out.endsWith('hi')).toBe(true);
  });

  it('omits a durability heading entirely when nothing falls under it', () => {
    const out = buildRunPrompt('hi', undefined, [{ content: 'Prefers TypeScript', durability: 'permanent' }]);
    expect(out).toContain('## Stable facts');
    expect(out).not.toContain('## Current context');
  });

  it('combines skill and memories, keeping the user text last', () => {
    const out = buildRunPrompt('do it', 'Be terse.', [{ content: 'Likes brevity', durability: 'permanent' }]);
    expect(out.indexOf('Be terse.')).toBeLessThan(out.indexOf('What you know about this user'));
    expect(out.indexOf('What you know about this user')).toBeLessThan(out.indexOf('do it'));
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

  it('tells the model the chart: convention exists, not just "use a table"', () => {
    // The exporters can now produce a genuine PowerPoint chart object from a
    // chart: fence. Guidance that doesn't mention it leaves the model writing
    // prose about a chart nobody drew — which is what real decks came back with.
    expect(FILE_DELIVERY_GUIDANCE).toContain('chart:bar');
    expect(FILE_DELIVERY_GUIDANCE).toContain('chart:line');
    expect(FILE_DELIVERY_GUIDANCE).toContain('REAL, editable chart');
    expect(FILE_DELIVERY_GUIDANCE).toContain('never use a generated image for data that has to be accurate');
    // Still echo-proof: describing the fence must not require writing one.
    expect(FILE_DELIVERY_GUIDANCE).not.toContain('```');
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

describe('parseChatRunPayload — prompt length and error messages', () => {
  const base = { providers: [{ type: 'anthropic', apiKey: 'sk' }] };

  it('accepts a prompt far past the old 20k-character cap', () => {
    // The cap rejected exactly the inputs Cascade is for — a pasted document,
    // a long stack trace, a whole file — and did it on every message, so chat
    // was simply unusable for them. The transport's 2 MB frame limit is the
    // only ceiling that has to exist, and the client guards under it.
    const long = 'x'.repeat(200_000);
    expect(parseChatRunPayload({ ...base, prompt: long }).prompt).toHaveLength(200_000);
  });

  it('accepts a system prompt past the old cap too', () => {
    const long = 'y'.repeat(50_000);
    expect(parseChatRunPayload({ ...base, prompt: 'hi', systemPrompt: long }).systemPrompt).toHaveLength(50_000);
  });

  it('accepts as history the same long turn it accepts as a prompt', () => {
    // The two describe the SAME turns from opposite ends: a stateless caller
    // resends its whole message array, so this request's prompt is the next
    // request's history. A ceiling on one and not the other meant a long
    // prompt succeeded once and then failed validation on every follow-up —
    // and runChatTurn persists the prompt verbatim, so the stored transcript
    // really did contain a turn the schema would have refused to replay.
    const long = 'z'.repeat(600_000);
    const parsed = parseChatRunPayload({ ...base, prompt: long, seedHistory: [{ role: 'user', content: long }] });
    expect(parsed.seedHistory![0]!.content).toHaveLength(600_000);
  });

  it('still bounds how MANY history turns a request may seed', () => {
    const many = Array.from({ length: 201 }, () => ({ role: 'user' as const, content: 'x' }));
    expect(() => parseChatRunPayload({ ...base, prompt: 'hi', seedHistory: many })).toThrow();
  });

  it('still rejects an empty prompt', () => {
    expect(() => parseChatRunPayload({ ...base, prompt: '' })).toThrow();
  });

  it('names the failing field, so an error says which setting is wrong', () => {
    // The whole bug report was four anonymous sentences — three identical —
    // with nothing pointing at the field. `issue.message` describes the
    // CONSTRAINT and never the path, so joining messages alone is unusable
    // when several fields fail at once.
    let message = '';
    try {
      parseChatRunPayload({
        ...base,
        prompt: 'hi',
        tierParams: { t1: { maxTokens: 2_000_000 }, t2: { maxTokens: 2_000_000 } },
      });
    } catch (err) {
      message = formatZodError(err as ZodError);
    }
    expect(message).toContain('tierParams.t1.maxTokens');
    expect(message).toContain('tierParams.t2.maxTokens');
  });

  it('renders array indices as indices, and keeps a pathless issue readable', () => {
    let message = '';
    try {
      parseChatRunPayload({ ...base, prompt: 'hi', attachmentIds: [1] });
    } catch (err) {
      message = formatZodError(err as ZodError);
    }
    expect(message).toContain('attachmentIds[0]');

    const bare = new ZodError([{ code: 'custom', path: [], message: 'whole thing is wrong' }]);
    expect(formatZodError(bare)).toBe('whole thing is wrong');
  });
});
