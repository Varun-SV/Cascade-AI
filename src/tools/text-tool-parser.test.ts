// ─────────────────────────────────────────────
//  Cascade AI — Text-tool parser & prompt
// ─────────────────────────────────────────────

import { describe, expect, it } from 'vitest';
import { parseTextToolCalls, buildTextToolSystemPrompt } from './text-tool-parser.js';

describe('parseTextToolCalls', () => {
  it('parses a proper <tool_call> block', () => {
    const r = parseTextToolCalls('<tool_call>{"name":"shell","input":{"command":"ls"}}</tool_call>');
    expect(r).toEqual([{ name: 'shell', input: { command: 'ls' } }]);
  });

  it('parses a bare {name,input} object with no wrapper, surrounded by prose', () => {
    const r = parseTextToolCalls('Sure, let me check: {"name":"grep","input":{"pattern":"foo"}} done.');
    expect(r).toEqual([{ name: 'grep', input: { pattern: 'foo' } }]);
  });

  it('accepts the "arguments" alias and single-quoted JSON', () => {
    const r = parseTextToolCalls("{'name': 'file_read', 'arguments': {'path': 'README.md'}}");
    expect(r).toEqual([{ name: 'file_read', input: { path: 'README.md' } }]);
  });

  it('parses a fenced ```json block', () => {
    const r = parseTextToolCalls('```json\n{"name":"shell","input":{"command":"pwd"}}\n```');
    expect(r).toEqual([{ name: 'shell', input: { command: 'pwd' } }]);
  });

  it('unwraps the OpenAI {function:{name,arguments}} echo shape', () => {
    const r = parseTextToolCalls('{"function":{"name":"shell","arguments":{"command":"id"}}}');
    expect(r).toEqual([{ name: 'shell', input: { command: 'id' } }]);
  });

  it('returns nothing for plain prose', () => {
    expect(parseTextToolCalls('I think the answer is 42.')).toEqual([]);
  });
});

describe('buildTextToolSystemPrompt', () => {
  it('carries enum values and required markers into the instructions', () => {
    const prompt = buildTextToolSystemPrompt([{
      name: 'grep',
      description: 'search files',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'regex' },
          mode: { type: 'string', enum: ['content', 'count'], description: 'output mode' },
        },
        required: ['pattern'],
      },
    }]);
    expect(prompt).toContain('grep');
    expect(prompt).toContain('[required]');
    expect(prompt).toContain('one of: "content", "count"');
  });
});
