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

describe('other models\' call formats', () => {
  it('reads Llama 3 "parameters"', async () => {
    const { parseTextToolCalls } = await import('./text-tool-parser.js');
    expect(parseTextToolCalls('<|python_tag|>{"name": "shell", "parameters": {"command": "ls"}}'))
      .toEqual([{ name: 'shell', input: { command: 'ls' } }]);
  });

  it('reads <function=name> tags', async () => {
    const { parseTextToolCalls } = await import('./text-tool-parser.js');
    expect(parseTextToolCalls('<function=file_read>{"path": "a.txt"}</function>'))
      .toEqual([{ name: 'file_read', input: { path: 'a.txt' } }]);
  });

  it('reads Mistral [TOOL_CALLS]', async () => {
    const { parseTextToolCalls } = await import('./text-tool-parser.js');
    expect(parseTextToolCalls('[TOOL_CALLS] [{"name": "shell", "arguments": {"command": "pwd"}}, {"name": "web_search", "arguments": "{\\"query\\": \\"x\\"}"}]'))
      .toEqual([{ name: 'shell', input: { command: 'pwd' } }, { name: 'web_search', input: { query: 'x' } }]);
  });
});

describe('strayTextToolCalls', () => {
  const tools = [{ name: 'shell' }, { name: 'file_read' }];

  it('takes a marked call to a tool the worker has', async () => {
    const { strayTextToolCalls } = await import('./text-tool-parser.js');
    expect(strayTextToolCalls('<tool_call>\n{"name": "shell", "input": {"command": "ls"}}\n</tool_call>', tools))
      .toEqual([{ name: 'shell', input: { command: 'ls' } }]);
  });

  it('takes a reply that opens with the call', async () => {
    const { strayTextToolCalls } = await import('./text-tool-parser.js');
    expect(strayTextToolCalls('```json\n{"name": "file_read", "arguments": {"path": "x"}}\n```', tools)).toHaveLength(1);
  });

  it('ignores an answer that only mentions a call', async () => {
    const { strayTextToolCalls } = await import('./text-tool-parser.js');
    const answer = 'To list files you would send {"name": "shell", "input": {"command": "ls"}} to the tool.';
    expect(strayTextToolCalls(answer, tools)).toEqual([]);
  });

  it('ignores a call to a tool the worker does not have', async () => {
    const { strayTextToolCalls } = await import('./text-tool-parser.js');
    expect(strayTextToolCalls('<tool_call>{"name": "rm_rf", "input": {}}</tool_call>', tools)).toEqual([]);
  });

  it('ignores an empty reply', async () => {
    const { strayTextToolCalls } = await import('./text-tool-parser.js');
    expect(strayTextToolCalls('', tools)).toEqual([]);
  });
});

describe('strayTextToolCalls and quoted examples', () => {
  const tools = [{ name: 'shell' }];

  it('does not run a call shown in a code block', async () => {
    const { strayTextToolCalls } = await import('./text-tool-parser.js');
    const reply = 'Here is an example; do not run it:\n```\n<tool_call>{"name":"shell","input":{"command":"echo example > example.txt"}}</tool_call>\n```';
    expect(strayTextToolCalls(reply, tools)).toEqual([]);
  });

  it('does not run a call shown in inline code', async () => {
    const { strayTextToolCalls } = await import('./text-tool-parser.js');
    expect(strayTextToolCalls('Send `<tool_call>{"name":"shell","input":{}}</tool_call>` to run it.', tools)).toEqual([]);
  });

  it('still runs a reply that is one fenced call', async () => {
    const { strayTextToolCalls } = await import('./text-tool-parser.js');
    expect(strayTextToolCalls('```tool_call\n<tool_call>{"name":"shell","input":{"command":"ls"}}</tool_call>\n```', tools))
      .toEqual([{ name: 'shell', input: { command: 'ls' } }]);
  });

  it('runs a marked call outside a code block that also shows an example', async () => {
    const { strayTextToolCalls } = await import('./text-tool-parser.js');
    const reply = '<tool_call>{"name":"shell","input":{"command":"ls"}}</tool_call>\nLike `<tool_call>{"name":"shell","input":{"command":"pwd"}}</tool_call>`.';
    expect(strayTextToolCalls(reply, tools)).toEqual([{ name: 'shell', input: { command: 'ls' } }]);
  });

  it('keeps backticks inside a real call\'s arguments exactly as written', async () => {
    const { strayTextToolCalls } = await import('./text-tool-parser.js');
    const tools2 = [{ name: 'file_write' }];
    const content = 'Use `npm test` to check.\n```sh\nnpm run lint\n```';
    const reply = `<tool_call>${JSON.stringify({ name: 'file_write', input: { path: 'README.md', content } })}</tool_call>`;
    expect(strayTextToolCalls(reply, tools2)).toEqual([{ name: 'file_write', input: { path: 'README.md', content } }]);
  });

  it('keeps backticks in a bare JSON call that opens the reply', async () => {
    const { strayTextToolCalls } = await import('./text-tool-parser.js');
    const reply = JSON.stringify({ name: 'shell', arguments: { command: 'echo `date`' } });
    expect(strayTextToolCalls(reply, tools)).toEqual([{ name: 'shell', input: { command: 'echo `date`' } }]);
  });

  it('runs the outer call when its argument shows a call example', async () => {
    const { strayTextToolCalls } = await import('./text-tool-parser.js');
    const both = [{ name: 'file_write' }, { name: 'shell' }];
    const content = "<tool_call>{'name':'shell','input':{'command':'echo example > example.txt'}}</tool_call>";
    const bare = JSON.stringify({ name: 'file_write', input: { path: 'doc.md', content } });
    expect(strayTextToolCalls(bare, both)).toEqual([{ name: 'file_write', input: { path: 'doc.md', content } }]);
    const marked = `<tool_call>${bare}</tool_call>`;
    expect(strayTextToolCalls(marked, both)).toEqual([{ name: 'file_write', input: { path: 'doc.md', content } }]);
  });

  it('reads template-prefixed calls from their own payload, not an example inside it', async () => {
    const { strayTextToolCalls, parseTextToolCalls } = await import('./text-tool-parser.js');
    const both = [{ name: 'file_write' }, { name: 'shell' }];
    const content = "<tool_call>{'name':'shell','input':{'command':'echo example > example.txt'}}</tool_call>";
    const want = [{ name: 'file_write', input: { path: 'doc.md', content } }];
    const mistral = `[TOOL_CALLS] [${JSON.stringify({ name: 'file_write', arguments: { path: 'doc.md', content } })}]`;
    const llama = `<|python_tag|>${JSON.stringify({ name: 'file_write', parameters: { path: 'doc.md', content } })}`;
    expect(strayTextToolCalls(mistral, both)).toEqual(want);
    expect(strayTextToolCalls(llama, both)).toEqual(want);
    // The same for a model that uses the text format all the time.
    expect(parseTextToolCalls(mistral)).toEqual(want);
    expect(parseTextToolCalls(`<tool_call>${JSON.stringify({ name: 'file_write', input: { path: 'doc.md', content } })}</tool_call>`)).toEqual(want);
  });
});

