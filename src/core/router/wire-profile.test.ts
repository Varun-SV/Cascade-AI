import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AnthropicProvider, toAnthropicTools, toAnthropicToolUse } from '../../providers/anthropic.js';
import { GeminiProvider, toGeminiTools, toGeminiFunctionCalls } from '../../providers/gemini.js';
import { OpenAIProvider, toOpenAITools, toOpenAIToolCalls } from '../../providers/openai.js';
import { OllamaProvider, toOllamaTools, toOllamaToolCalls } from '../../providers/ollama.js';
import { wireProfile, geminiImageCopies } from './wire-profile.js';
import type { BlockHandling } from './wire-profile.js';
import type {
  ConversationMessage,
  MessageContent,
  ModelInfo,
  ProviderType,
  ToolDefinition,
} from '../../types.js';

/**
 * These tests exist because the preflight estimator kept being wrong in ways
 * unit tests could not see: it modelled what a provider sends, the provider
 * changed or was misread, and nothing failed — the estimate was simply off,
 * refusing runs over content that is discarded or admitting ones over content
 * that is not.
 *
 * So nothing here asserts the table against itself. Every row is checked by
 * running the REAL provider serializer over a marked message and looking for
 * the marker in what comes out. If a provider's convertMessages/buildContents
 * changes, these fail, and the estimator is corrected before it can drift.
 */

const TEXT_MARKER = 'WIRE_PROFILE_TEXT_MARKER';
const IMAGE_MARKER = 'WIREPROFILEIMAGEMARKERBASE64';
const URL_MARKER = 'https://example.invalid/WIRE_PROFILE_URL_MARKER.png';
const TOOL_CALL_MARKER = 'wire_profile_tool_call_marker';

/**
 * The caller's own block array, verbatim — what a JSON.stringify()ing provider
 * puts on the wire and what no real conversion produces. Present twice over:
 * once as-is, and once escaped, since a stringified array lands inside a JSON
 * string value in the serialized request.
 */
function rawBlockShapes(blocks: MessageContent[]): string[] {
  const raw = JSON.stringify(blocks);
  return [raw, JSON.stringify(raw).slice(1, -1)];
}

const ROLES = ['system', 'user', 'assistant', 'tool'] as const;
const PROVIDERS: ProviderType[] = ['anthropic', 'gemini', 'openai', 'ollama'];

function model(provider: ProviderType): ModelInfo {
  return {
    id: 'test-model',
    name: 'Test Model',
    provider,
    contextWindow: 100_000,
    isVisionCapable: true,
    inputCostPer1kTokens: 0.001,
    outputCostPer1kTokens: 0.002,
    maxOutputTokens: 4096,
    supportsStreaming: true,
    isLocal: provider === 'ollama',
  };
}

/**
 * Runs the provider's own message serializer. These are private — reaching
 * past that is the point: a test that went through generate() would need the
 * network, and a reimplementation here would drift exactly like the estimator
 * did.
 */
function serialize(provider: ProviderType, messages: ConversationMessage[]): unknown[] {
  const cfg = { type: provider, apiKey: 'test-key' } as never;
  const m = model(provider);
  switch (provider) {
    case 'anthropic':
      return (new AnthropicProvider(cfg, m) as never as {
        convertMessages(x: ConversationMessage[]): unknown[];
      }).convertMessages(messages);
    case 'gemini':
      return (new GeminiProvider(cfg, m) as never as {
        buildContents(x: ConversationMessage[]): unknown[];
      }).buildContents(messages);
    case 'ollama':
      return (new OllamaProvider(cfg, m) as never as {
        convertMessages(x: ConversationMessage[]): unknown[];
      }).convertMessages(messages);
    default:
      return (new OpenAIProvider(cfg, m) as never as {
        convertMessages(x: ConversationMessage[]): unknown[];
      }).convertMessages(messages);
  }
}

function serializedJson(provider: ProviderType, messages: ConversationMessage[]): string {
  return JSON.stringify(serialize(provider, messages));
}

const markedBlocks = (): MessageContent[] => ([
  { type: 'text', text: TEXT_MARKER },
  { type: 'image', image: { type: 'base64', data: IMAGE_MARKER, mimeType: 'image/png' } },
]);

/** What the provider ACTUALLY did with this message's array content. */
function observedBlockHandling(provider: ProviderType, message: ConversationMessage): BlockHandling {
  const out = serializedJson(provider, [message]);
  // A stringified array keeps the caller's own block shape verbatim — that is
  // what distinguishes it from a real conversion, which rewrites images into
  // the provider's format (`source`, `image_url`, `inlineData`, `images[]`).
  const blocks = Array.isArray(message.content) ? message.content : [];
  if (rawBlockShapes(blocks).some((shape) => out.includes(shape))) return 'stringified';
  if (!out.includes(TEXT_MARKER) && !out.includes(IMAGE_MARKER)) return 'dropped';
  return 'blocks';
}

// ── The rows ───────────────────────────────────

describe('wire profile — dropsMessage, against the real serializers', () => {
  for (const provider of PROVIDERS) {
    for (const role of ROLES) {
      it(`${provider}: a ${role} turn with string content is ${
        wireProfile(provider).dropsMessage({ role, content: TEXT_MARKER }) ? 'dropped' : 'submitted'
      }`, () => {
        const message: ConversationMessage = {
          role,
          content: TEXT_MARKER,
          ...(role === 'tool' ? { toolCallId: 'call_1' } : {}),
        };
        const submitted = serializedJson(provider, [message]).includes(TEXT_MARKER);
        expect(wireProfile(provider).dropsMessage(message)).toBe(!submitted);
      });
    }
  }

  it('gemini drops a whitespace-only system turn but keeps one with text', () => {
    const blank: ConversationMessage = { role: 'system', content: '   \n ' };
    const filled: ConversationMessage = { role: 'system', content: TEXT_MARKER };
    expect(serialize('gemini', [blank])).toHaveLength(0);
    expect(wireProfile('gemini').dropsMessage(blank)).toBe(true);
    expect(serializedJson('gemini', [filled])).toContain(TEXT_MARKER);
    expect(wireProfile('gemini').dropsMessage(filled)).toBe(false);
  });

  it('anthropic drops system history entirely — the compaction-summary case', () => {
    // Compaction emits a system message holding a summary of the whole
    // conversation. convertMessages skips it, so charging it refuses runs over
    // input the provider never sees.
    expect(serialize('anthropic', [{ role: 'system', content: TEXT_MARKER }])).toHaveLength(0);
  });
});

describe('wire profile — blockHandling, against the real serializers', () => {
  for (const provider of PROVIDERS) {
    for (const role of ROLES) {
      const message: ConversationMessage = {
        role,
        content: markedBlocks(),
        ...(role === 'tool' ? { toolCallId: 'call_1' } : {}),
      };
      const wire = wireProfile(provider);
      // Where the whole message is dropped, blockHandling is never consulted.
      if (wire.dropsMessage(message)) continue;
      it(`${provider}: array content on a ${role} turn is ${wire.blockHandling(message)}`, () => {
        expect(wire.blockHandling(message)).toBe(observedBlockHandling(provider, message));
      });
    }
  }

  it('ollama drops assistant blocks only when the turn carries tool calls', () => {
    const withCalls: ConversationMessage = {
      role: 'assistant',
      content: markedBlocks(),
      toolCalls: [{ id: 'c1', name: TOOL_CALL_MARKER, input: {} }],
    };
    const without: ConversationMessage = { role: 'assistant', content: markedBlocks() };
    expect(observedBlockHandling('ollama', withCalls)).toBe('dropped');
    expect(wireProfile('ollama').blockHandling(withCalls)).toBe('dropped');
    expect(observedBlockHandling('ollama', without)).toBe('blocks');
    expect(wireProfile('ollama').blockHandling(without)).toBe('blocks');
  });

  it('a stringified tool result carries the image bytes in full', () => {
    // Not the flat per-image rate: the base64 payload really is on the wire,
    // so it is charged by its real size.
    const message: ConversationMessage = {
      role: 'tool',
      content: markedBlocks(),
      toolCallId: 'call_1',
    };
    for (const provider of ['anthropic', 'gemini', 'ollama'] as const) {
      expect(serializedJson(provider, [message])).toContain(IMAGE_MARKER);
      expect(wireProfile(provider).blockHandling(message)).toBe('stringified');
    }
  });
});

describe('wire profile — sendsToolCalls, against the real serializers', () => {
  const withCalls = (content: string | MessageContent[]): ConversationMessage => ({
    role: 'assistant',
    content,
    toolCalls: [{ id: 'c1', name: TOOL_CALL_MARKER, input: { q: 'x' } }],
  });

  for (const provider of PROVIDERS) {
    it(`${provider}: serializes an assistant turn's tool calls (string content)`, () => {
      const message = withCalls('hello');
      const sent = serializedJson(provider, [message]).includes(TOOL_CALL_MARKER);
      expect(wireProfile(provider).sendsToolCalls(message)).toBe(sent);
      expect(sent).toBe(true);
    });
  }

  it('openai drops tool calls on an assistant turn with array content', () => {
    // The tool_calls branch sits inside `if (typeof m.content === 'string')`;
    // array content falls through to the parts branch and never attaches them.
    const message = withCalls(markedBlocks());
    expect(serializedJson('openai', [message])).not.toContain(TOOL_CALL_MARKER);
    expect(wireProfile('openai').sendsToolCalls(message)).toBe(false);
  });

  it('no provider serializes tool calls hung on a non-assistant turn', () => {
    for (const provider of PROVIDERS) {
      const message: ConversationMessage = {
        role: 'user',
        content: 'hello',
        toolCalls: [{ id: 'c1', name: TOOL_CALL_MARKER, input: {} }],
      };
      expect(serializedJson(provider, [message])).not.toContain(TOOL_CALL_MARKER);
      expect(wireProfile(provider).sendsToolCalls(message)).toBe(false);
    }
  });
});

describe('wire profile — sendsUrlImages, against the real serializers', () => {
  const urlImage: ConversationMessage = {
    role: 'user',
    content: [{ type: 'image', image: { type: 'url', data: URL_MARKER, mimeType: 'image/png' } }],
  };

  for (const provider of PROVIDERS) {
    it(`${provider}: a URL image attachment is ${
      wireProfile(provider).sendsUrlImages ? 'submitted' : 'discarded'
    }`, () => {
      const sent = serializedJson(provider, [urlImage]).includes(URL_MARKER);
      expect(wireProfile(provider).sendsUrlImages).toBe(sent);
    });
  }

  it('gemini alone discards it — inlineData is emitted for base64 only', () => {
    expect(serializedJson('gemini', [urlImage])).not.toContain(URL_MARKER);
    expect(wireProfile('gemini').sendsUrlImages).toBe(false);
  });
});

const here = path.dirname(fileURLToPath(import.meta.url));
const providerDir = path.join(here, '..', '..', 'providers');
const FILES: Record<ProviderType, string> = {
  anthropic: 'anthropic.ts',
  gemini: 'gemini.ts',
  openai: 'openai.ts',
  azure: 'azure.ts',
  'openai-compatible': 'openai-compatible.ts',
  ollama: 'ollama.ts',
};
const providerSource = (provider: ProviderType): string =>
  fs.readFileSync(path.join(providerDir, FILES[provider]), 'utf8');

describe('wire profile — readsTopLevelImages, against the provider sources', () => {
  // `options.images` is passed to the serializer only by Gemini, so no
  // serializer-level probe can show the difference. Reading the sources is the
  // check that actually catches the drift: the day another provider starts
  // reading the field, its profile row has to change with it.
  for (const [provider, file] of Object.entries(FILES) as [ProviderType, string][]) {
    it(`${provider}: ${
      wireProfile(provider).readsTopLevelImages ? 'reads' : 'never reads'
    } options.images`, () => {
      const source = fs.readFileSync(path.join(providerDir, file), 'utf8');
      expect(/\boptions\.images\b/.test(source)).toBe(wireProfile(provider).readsTopLevelImages);
    });
  }
});

describe('wire profile — sizeTools is the provider\'s own conversion', () => {
  const tool: ToolDefinition = {
    name: 'search',
    description: 'Search things',
    inputSchema: {
      type: 'object',
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      additionalProperties: false,
      properties: { q: { type: 'string', 'x-mcp-header': 'X-Q' } },
    },
  };

  // Not "the estimate matches the request" but "the estimate IS the request":
  // one function, called by the provider when it builds the call and by the
  // estimator when it sizes it. A mirrored copy is what drifted before.
  const SHARED: Array<[ProviderType, unknown, string]> = [
    ['anthropic', toAnthropicTools, 'toAnthropicTools'],
    ['gemini', toGeminiTools, 'toGeminiTools'],
    ['openai', toOpenAITools, 'toOpenAITools'],
    ['azure', toOpenAITools, 'toOpenAITools'],
    ['openai-compatible', toOpenAITools, 'toOpenAITools'],
    ['ollama', toOllamaTools, 'toOllamaTools'],
  ];

  for (const [provider, fn, name] of SHARED) {
    it(`${provider}: sizes with ${name} itself, not a copy of it`, () => {
      expect(wireProfile(provider).sizeTools).toBe(fn);
    });
  }

  for (const provider of ['anthropic', 'gemini', 'openai', 'ollama'] as const) {
    it(`${provider}: builds its request with that same function`, () => {
      // If someone inlines the mapping back into generateStream, the shared
      // function stops being what goes on the wire and this fails.
      const name = SHARED.find(([p]) => p === provider)![2];
      expect(providerSource(provider)).toMatch(new RegExp(`${name}\\(options\\.tools\\)`));
    });
  }

  it('openai and ollama wrap every definition in a function envelope', () => {
    // Missing this was worth a few tokens per tool — and hundreds across a
    // large MCP server, always in the direction that lets a request slip a cap.
    for (const provider of ['openai', 'azure', 'openai-compatible', 'ollama'] as const) {
      const sized = JSON.stringify(wireProfile(provider).sizeTools([tool]));
      expect(sized).toContain('"type":"function"');
      expect(sized).toContain('"parameters":');
      expect(sized).not.toContain('"inputSchema"');
      expect(sized.length).toBeGreaterThan(JSON.stringify([tool]).length);
    }
  });

  it('anthropic renames inputSchema to input_schema', () => {
    const sized = JSON.stringify(wireProfile('anthropic').sizeTools([tool]));
    expect(sized).toContain('"input_schema"');
    expect(sized).not.toContain('"inputSchema"');
  });

  it('gemini sanitises the schema, so sizing the raw JSON would over-charge', () => {
    const sized = JSON.stringify(wireProfile('gemini').sizeTools([tool]));
    expect(sized).not.toContain('x-mcp-header');
    expect(sized).not.toContain('$schema');
    expect(sized.length).toBeLessThan(JSON.stringify([tool]).length);
  });
});

describe('wire profile — provider coverage', () => {
  it('has a row for every ProviderType', () => {
    // Azure and openai-compatible extend OpenAIProvider without overriding
    // convertMessages, so they share its row by construction.
    const all: ProviderType[] = ['anthropic', 'openai', 'gemini', 'azure', 'openai-compatible', 'ollama'];
    for (const provider of all) expect(wireProfile(provider)).toBeDefined();
    expect(wireProfile('azure')).toBe(wireProfile('openai'));
    expect(wireProfile('openai-compatible')).toBe(wireProfile('openai'));
  });

  it('falls back to the OpenAI shape for an unknown provider', () => {
    expect(wireProfile('brand-new' as ProviderType)).toBe(wireProfile('openai'));
  });
});

describe('geminiImageCopies — mirrors buildContents', () => {
  const img = { type: 'base64' as const, data: IMAGE_MARKER, mimeType: 'image/png' as const };

  /** How many inlineData parts buildContents really emits for one extra image. */
  function observedCopies(messages: ConversationMessage[]): number {
    const contents = (new GeminiProvider({ type: 'gemini', apiKey: 'k' } as never, model('gemini')) as never as {
      buildContents(m: ConversationMessage[], extra?: typeof img[]): unknown[];
    }).buildContents(messages, [img]);
    return JSON.stringify(contents).split(IMAGE_MARKER).length - 1;
  }

  const cases: Array<[string, ConversationMessage[]]> = [
    ['a single user turn', [{ role: 'user', content: 'hi' }]],
    ['two user turns', [{ role: 'user', content: 'hi' }, { role: 'user', content: 'again' }]],
    ['led by a system turn', [
      { role: 'system', content: 'ctx' },
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'again' },
    ]],
    ['led by an EMPTY system turn', [
      { role: 'system', content: '   ' },
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'again' },
    ]],
    ['led by an assistant turn', [
      { role: 'assistant', content: 'sure' },
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'again' },
    ]],
    ['led by an EMPTY assistant turn', [
      { role: 'assistant', content: '' },
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'again' },
    ]],
    ['led by a tool result', [
      { role: 'tool', content: 'out', toolCallId: 'c1' },
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'again' },
    ]],
    ['no user turn at all', [{ role: 'assistant', content: 'sure' }]],
  ];

  for (const [label, messages] of cases) {
    it(`${label}: charges what buildContents attaches`, () => {
      const observed = observedCopies(messages);
      // Never charge for a copy the provider does not send; never leave one
      // unreserved. The one exception is a history with no user turn at all,
      // where the image is dropped outright and the estimator's floor of 1 is
      // a deliberate over-count of a case that cannot arise in a real request.
      if (observed === 0) expect(geminiImageCopies(messages)).toBe(1);
      else expect(geminiImageCopies(messages)).toBe(observed);
    });
  }
});

describe('wire profile — sendsBlock, against the real serializers', () => {
  // Every provider's user-array conversion has a branch for text and a branch
  // for image, and nothing else. A tool_result block sitting in a user turn is
  // therefore never submitted — and contentToText expands its whole payload,
  // so charging it refused runs over data nobody sees.
  const toolResultBlock: MessageContent = {
    type: 'tool_result',
    toolCallId: 'call_1',
    content: TEXT_MARKER,
  };

  for (const provider of PROVIDERS) {
    it(`${provider}: drops a tool_result block from a user turn`, () => {
      const message: ConversationMessage = { role: 'user', content: [toolResultBlock] };
      expect(serializedJson(provider, [message])).not.toContain(TEXT_MARKER);
      expect(wireProfile(provider).sendsBlock(toolResultBlock)).toBe(false);
    });

    it(`${provider}: keeps text and image blocks on a user turn`, () => {
      const message: ConversationMessage = { role: 'user', content: markedBlocks() };
      const out = serializedJson(provider, [message]);
      expect(out).toContain(TEXT_MARKER);
      expect(out).toContain(IMAGE_MARKER);
      for (const block of markedBlocks()) {
        expect(wireProfile(provider).sendsBlock(block)).toBe(true);
      }
    });
  }

  it('a stringified tool result still carries every block, dropped types included', () => {
    // The whole array is JSON.stringify()d there, so nothing is filtered and
    // the tool_result payload really is billed.
    const message: ConversationMessage = {
      role: 'tool',
      content: [toolResultBlock],
      toolCallId: 'call_1',
    };
    for (const provider of ['anthropic', 'gemini', 'ollama'] as const) {
      expect(wireProfile(provider).blockHandling(message)).toBe('stringified');
      expect(serializedJson(provider, [message])).toContain(TEXT_MARKER);
    }
  });
});

describe('wire profile — sizeToolCalls is the provider\'s own conversion', () => {
  const toolCalls = [{ id: 'call_abc123', name: 'search', input: { q: 'a "quoted" value' } }];

  const SHARED_CALLS: Array<[ProviderType, unknown, string]> = [
    ['anthropic', toAnthropicToolUse, 'toAnthropicToolUse'],
    ['gemini', toGeminiFunctionCalls, 'toGeminiFunctionCalls'],
    ['openai', toOpenAIToolCalls, 'toOpenAIToolCalls'],
    ['azure', toOpenAIToolCalls, 'toOpenAIToolCalls'],
    ['openai-compatible', toOpenAIToolCalls, 'toOpenAIToolCalls'],
    ['ollama', toOllamaToolCalls, 'toOllamaToolCalls'],
  ];

  for (const [provider, fn, name] of SHARED_CALLS) {
    it(`${provider}: sizes with ${name} itself, not a copy of it`, () => {
      expect(wireProfile(provider).sizeToolCalls).toBe(fn);
    });
  }

  for (const provider of ['anthropic', 'gemini', 'openai', 'ollama'] as const) {
    it(`${provider}: serializes an assistant turn with that same function`, () => {
      const name = SHARED_CALLS.find(([p]) => p === provider)![2];
      expect(providerSource(provider)).toMatch(new RegExp(`${name}\\(`));
      // And the shape it produces really is what lands in the request.
      const message: ConversationMessage = { role: 'assistant', content: 'hi', toolCalls };
      const sized = JSON.stringify(wireProfile(provider).sizeToolCalls(toolCalls));
      const sent = serializedJson(provider, [message]);
      expect(sent).toContain(sized.slice(1, -1));
    });
  }

  it('openai double-escapes the argument object, which costs more than the raw form', () => {
    const sized = JSON.stringify(wireProfile('openai').sizeToolCalls(toolCalls));
    expect(sized).toContain('\\"');
    expect(sized.length).toBeGreaterThan(JSON.stringify(toolCalls).length);
  });

  it('gemini drops the call id, which costs less than the raw form', () => {
    const sized = JSON.stringify(wireProfile('gemini').sizeToolCalls(toolCalls));
    expect(sized).not.toContain('call_abc123');
    expect(sized.length).toBeLessThan(JSON.stringify(toolCalls).length);
  });
});

describe('wire profile — sendsToolCallId, against the real serializers', () => {
  const ID_MARKER = 'wire_profile_tool_call_id';
  for (const provider of PROVIDERS) {
    it(`${provider}: a tool result's id is ${
      wireProfile(provider).sendsToolCallId ? 'submitted' : 'discarded'
    }`, () => {
      const message: ConversationMessage = {
        role: 'tool',
        content: 'output',
        toolCallId: ID_MARKER,
      };
      const sent = serializedJson(provider, [message]).includes(ID_MARKER);
      expect(wireProfile(provider).sendsToolCallId).toBe(sent);
    });
  }
});
