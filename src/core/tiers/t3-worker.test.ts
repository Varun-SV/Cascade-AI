import { describe, expect, it, vi } from 'vitest';
import type {
  GenerateResult,
  PermissionDecision,
  PermissionRequest,
  T2ToT3Assignment,
  ToolCall,
  ToolDefinition,
} from '../../types.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { PeerBus } from '../peer/bus.js';
import { PermissionEscalator } from '../permissions/escalator.js';
import { T3Worker, buildWorkerRules, missingVisualEvidence, shouldRequireArtifact } from './t3-worker.js';

function makeResult(
  content: string,
  toolCalls?: ToolCall[],
  finishReason: GenerateResult['finishReason'] = 'stop',
): GenerateResult {
  return {
    content,
    toolCalls,
    finishReason,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      estimatedCostUsd: 0,
    },
  };
}

function makeAssignment(overrides: Partial<T2ToT3Assignment> = {}): T2ToT3Assignment {
  return {
    subtaskId: 'subtask-1',
    subtaskTitle: 'Write summary',
    description: 'Write a concise summary',
    expectedOutput: 'A complete summary',
    constraints: [],
    peerT3Ids: [],
    parentT2: 't2-1',
    ...overrides,
  };
}

function makeRouter(generateImpl: CascadeRouter['generate']): CascadeRouter {
  // runAgentLoop calls getModelForTier to decide native vs text tool-call mode
  return {
    generate: generateImpl,
    getModelForTier: () => undefined,
  } as unknown as CascadeRouter;
}

function makeToolRegistry(overrides: Partial<ToolRegistry> = {}): ToolRegistry {
  const toolDefinitions: ToolDefinition[] = [{
    name: 'file_write',
    description: 'Write a file',
    inputSchema: {},
  }];

  return {
    getToolDefinitions: () => toolDefinitions,
    requiresApproval: () => false,
    isDangerous: () => false,
    execute: vi.fn().mockResolvedValue('ok'),
    ...overrides,
  } as unknown as ToolRegistry;
}

describe('T3Worker', () => {
  it('executes a real approval + tool loop through the escalator', async () => {
    let loopCalls = 0;
    const router = makeRouter(vi.fn(async (_tier, options) => {
      const latest = options.messages[options.messages.length - 1];
      const content = typeof latest?.content === 'string' ? latest.content : '';

      if (content.startsWith('Self-test this output')) {
        return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
      }

      loopCalls += 1;
      if (loopCalls === 1) {
        return makeResult('', [{
          id: 'tool-1',
          name: 'file_write',
          input: { path: 'summary.md', content: '# Summary' },
        }], 'tool_use');
      }

      return makeResult('Final summary');
    }));

    const execute = vi.fn().mockResolvedValue('wrote summary.md');
    const toolRegistry = makeToolRegistry({
      requiresApproval: () => true,
      isDangerous: () => true,
      execute,
    });

    const escalator = new PermissionEscalator();
    const requestPermission = vi
      .spyOn(escalator, 'requestPermission')
      .mockResolvedValue({
        requestId: 'req-1',
        approved: true,
        decidedBy: 'T2',
        always: true,
      } satisfies PermissionDecision);

    const worker = new T3Worker(router, toolRegistry, 't2-parent');
    worker.setPermissionEscalator(escalator);

    const result = await worker.execute(makeAssignment(), 'task-1');

    expect(result.status).toBe('COMPLETED');
    expect(result.output).toBe('Final summary');
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(requestPermission.mock.calls[0]?.[0]).toEqual(expect.objectContaining<Partial<PermissionRequest>>({
      parentT2Id: 't2-parent',
      toolName: 'file_write',
      subtaskContext: 'Write summary',
    }));
    expect(execute).toHaveBeenCalledOnce();
  });

  it('runs one independent T2-critic round: rejected output is revised, then accepted', async () => {
    const criticTiers: string[] = [];
    let verdicts = 0;

    const generate = vi.fn(async (tier: string, options: { messages: Array<{ content: unknown }> }) => {
      const latest = options.messages[options.messages.length - 1];
      const content = typeof latest?.content === 'string' ? latest.content : '';

      if (content.startsWith('Self-test this output')) {
        return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
      }
      if (content.includes('independent critic')) {
        criticTiers.push(tier);
        verdicts += 1;
        // First (and only, maxRounds=1) verdict: reject so the revision path runs.
        return makeResult('{"sufficient": false, "notes": "misses the conclusion"}');
      }
      if (content.startsWith('Improve the following')) {
        return makeResult('Improved output');
      }
      return makeResult('Draft output');
    });

    const router = {
      generate,
      getModelForTier: () => undefined,
      getReflectionConfig: () => ({ enabled: true, maxRounds: 1 }),
    } as unknown as CascadeRouter;

    const worker = new T3Worker(router, makeToolRegistry(), 't2-parent');
    const result = await worker.execute(makeAssignment(), 'task-critic');

    expect(result.status).toBe('COMPLETED');
    expect(result.output).toBe('Improved output');
    expect(verdicts).toBe(1);
    // The critic must run on the T2 tier — a different model than the T3 that
    // produced the output — and must NOT spawn a manager hierarchy.
    expect(criticTiers).toEqual(['T2']);
  });

  it('delivers peer sync messages through the shared PeerBus', async () => {
    const router = makeRouter(vi.fn());
    const toolRegistry = makeToolRegistry();
    const bus = new PeerBus();

    const sender = new T3Worker(router, toolRegistry, 't2-parent');
    const receiver = new T3Worker(router, toolRegistry, 't2-parent');
    sender.setPeerBus(bus);
    receiver.setPeerBus(bus);

    const received = new Promise<{ fromId: string; content: unknown }>((resolve) => {
      receiver.once('peer-sync-received', resolve);
    });

    sender.sendToPeer(receiver.id, { ready: true });

    await expect(received).resolves.toEqual({
      fromId: sender.id,
      content: { ready: true },
    });
  });
});

describe('buildWorkerRules — tool-scoped guidance', () => {
  // The complete built-in tool set (registry.ts registerDefaults).
  const FULL = new Set([
    'shell', 'file_read', 'file_write', 'file_edit', 'file_delete', 'file_list',
    'git', 'github', 'image_analyze', 'pdf_create', 'run_code', 'peer_message',
    'web_search', 'glob', 'grep', 'web_fetch',
  ]);

  it('with the full tool set, renders every rule the registered tools warrant', () => {
    const out = buildWorkerRules((name) => FULL.has(name));
    expect(out).toBe(`You are a T3 Worker agent in the Cascade AI system. Your job is to execute a specific subtask completely and accurately.

Rules:
- Execute the subtask completely — do not stop partway through.
- Use tools when needed. Ask for approval only when the tool registry requires it.
- If the task asks for a file or artifact, you must actually create it in the workspace, verify that it exists, and inspect it before claiming success.
- Use the "web_search" tool to find current information, documentation, news, or general web data.
- Use the "pdf_create" tool for PDF requests.
- No image-generation model is available on this run, so there is NO tool that can draw a picture. Do not emit a Markdown image reference, a bracketed placeholder such as [image: a cat], or any claim that an illustration is included. If the request needs a data visualization use a \`\`\`chart: block, which needs no image model; otherwise describe the visual in words and say plainly that no image could be generated.
- Use the "run_code" tool for data processing, archives, and file formats not covered by a dedicated tool. Do NOT use it to build a PDF — "pdf_create" does that. Always cleanup after code execution.
- If you are not making meaningful progress, stop and escalate rather than looping or padding the response.
- Use the "peer_message" tool to communicate with other T3 workers if your tasks have dependencies or shared state. You can send updates or wait for signals.
- Only use tools directly relevant to THIS subtask. Do not reach for an unrelated connected-service action (e.g. creating, deleting, or modifying a repository, issue, or PR; sending a message) unless the subtask explicitly calls for it.
- Return structured output that directly addresses the expected output specification.`);
  });

  it('with a web-only cloud tool set, omits guidance for tools that do not exist', () => {
    const out = buildWorkerRules((name) => new Set(['web_search', 'web_fetch']).has(name));
    // The one enabled tool is still described…
    expect(out).toContain('- Use the "web_search" tool');
    // …and the absent tools are NOT mentioned, so the model never wastes a
    // turn calling a tool that isn't registered.
    expect(out).not.toContain('run_code');
    expect(out).not.toContain('pdf_create');
    expect(out).not.toContain('peer_message');
    expect(out).not.toContain('If the task asks for a file or artifact');
    // A web tool exists, so the generic "use tools" line is still present.
    expect(out).toContain('- Use tools when needed.');
  });

  it('with generate_image registered, requires a real generated image over a text placeholder', () => {
    const out = buildWorkerRules((name) => new Set([...FULL, 'generate_image']).has(name));
    // The tool must be named — otherwise the model narrates the picture instead
    // of drawing one, which is exactly the "[image: …]" placeholder bug.
    expect(out).toContain('you MUST call the "generate_image" tool');
    // …and naming the tool is not enough: it also has to be told how to
    // reference the result, or it generates an image and then never embeds it.
    expect(out).toContain('![description](location)');
    expect(out).toContain('exactly the string the tool reported back');
    expect(out).toContain('[image: a cat]');
  });

  it('scopes the image instruction to PowerPoint/Word — the only exporters that actually embed one', () => {
    // Regression: an unconditional "call generate_image for any deliverable"
    // instruction also fires for a PDF request, but the PDF exporter
    // (renderPdf) flattens a Markdown image reference to caption text same as
    // the original bug — the model would pay for an image nobody ever sees.
    const out = buildWorkerRules((name) => new Set([...FULL, 'generate_image']).has(name));
    expect(out).toContain('slide deck (PowerPoint) or Word document');
    expect(out).toMatch(/PDF.*do NOT call "generate_image"/);
  });

  it('excludes data-driven charts from the generate_image mandate — image models cannot guarantee exact values', () => {
    // Routing a quantitative chart (exact axes/numbers) through a generative
    // image model risks a plausible-looking but numerically wrong picture. Only
    // decorative visuals go through generate_image; data-driven ones now have a
    // REAL alternative (a chart: block) rather than the flat table that used to
    // be the only fallback.
    const out = buildWorkerRules((name) => new Set([...FULL, 'generate_image']).has(name));
    expect(out).toMatch(/do NOT use "generate_image".*chart.*exact data/i);
    expect(out).toContain('emit a ```chart: block instead');
    expect(out).not.toContain('render that data as a Markdown table instead');
  });

  it('without generate_image, says so out loud instead of leaving the model to guess', () => {
    // The other half of the "images only worked once" report: generate_image
    // exists only when an OpenAI or Gemini key is configured, and a model that
    // is not told writes "[illustration of a cat]" and moves on.
    const out = buildWorkerRules((name) => FULL.has(name));
    // Never name a tool that was not registered — that just burns a turn on
    // tool-not-found.
    expect(out).not.toContain('"generate_image"');
    expect(out).not.toContain('![description](location)');
    expect(out).toContain('No image-generation model is available on this run');
    expect(out).toContain('chart: block, which needs no image model');
  });

  it('omits the image-absence notice for a worker that could not produce a document anyway', () => {
    // A hosted pure-chat run has no deliverable to put a picture in, so the
    // notice would be noise.
    const out = buildWorkerRules((name) => new Set(['web_search', 'web_fetch']).has(name));
    expect(out).not.toContain('No image-generation model is available');
  });

  it('with generate_document registered, forbids file_write for Office formats', () => {
    // The original bug: file_write does exactly what it promises — writes the
    // model's characters verbatim — so `report.docx` held Markdown and Word
    // reported it corrupted. Naming the prohibition matters as much as naming
    // the tool, because the model already has a file_write habit.
    const out = buildWorkerRules((name) => new Set([...FULL, 'generate_document']).has(name));
    expect(out).toContain('you MUST call the "generate_document" tool and NEVER "file_write"');
    expect(out).toContain('ZIP archives of XML');
    expect(out).toContain('Markdown slides separated by --- rules for .pptx');
    // …and run_code must stop competing for the same formats.
    expect(out).toContain('Do NOT use it to build a .docx, .pptx or .xlsx');
  });

  it('teaches the chart: convention wherever a document can be rendered', () => {
    const out = buildWorkerRules((name) => new Set([...FULL, 'generate_document']).has(name));
    expect(out).toContain('```chart:bar');
    expect(out).toContain('chart:line');
    expect(out).toContain('chart:pie');
    expect(out).toContain('REAL, editable chart');
    expect(out).toContain('Never write prose describing a chart in place of emitting one');
  });

  it('omits the chart convention when nothing can render a document', () => {
    const out = buildWorkerRules((name) => FULL.has(name));
    expect(out).not.toContain('```chart:bar');
    expect(out).not.toContain('generate_document');
  });

  it('with NO tools registered (hosted pure-chat), drops all tool guidance', () => {
    const out = buildWorkerRules(() => false);
    // The model has zero tools — never tell it to reach for one, so it can't
    // waste turns hallucinating tool calls against an empty registry.
    expect(out).not.toContain('- Use tools when needed.');
    expect(out).not.toContain('web_search');
    expect(out).not.toContain('run_code');
    expect(out).not.toContain('pdf_create');
    expect(out).not.toContain('peer_message');
    expect(out).not.toContain('If the task asks for a file or artifact');
    // Non-tool execution guidance still renders.
    expect(out).toContain('- Execute the subtask completely');
    expect(out).toContain('- Return structured output');
  });

  it('with generate_video registered, requires the actual tool call, not a script standing in for it', () => {
    // Live-reported bug: "it just keeps on writing scripts, directing and etc,
    // but the video never gets generated". The worker had an explicit MUST-call
    // rule for images and none for video, and generate_video was not even in
    // KNOWN_TOOLS — so a "generate the video" subtask was answered in prose.
    const out = buildWorkerRules((name) => new Set([...FULL, 'generate_video']).has(name));
    expect(out).toContain('you MUST call the "generate_video" tool');
    expect(out).toContain('that call IS the deliverable');
    // Naming the tool is not enough — the placeholder shapes have to be named
    // too, exactly as the image rule names "[image: a cat]".
    expect(out).toContain('[video: a cat skating]');
    expect(out).toMatch(/NEVER deliver the video as prose, a script, a storyboard/);
    // How to report the result, so a generated clip is not orphaned.
    expect(out).toContain('[description](location)');
    // Cost control: one call, and a failure is reported rather than re-run.
    expect(out).toContain('Call it exactly ONCE');
    expect(out).toMatch(/do NOT call it again/);
  });

  it('without generate_video (no video model configured), omits the video guidance entirely', () => {
    const out = buildWorkerRules((name) => new Set([...FULL, 'generate_image']).has(name));
    expect(out).not.toContain('generate_video');
    expect(out).not.toContain('[video: a cat skating]');
  });

  it('counts every media tool as a tool, so a media-only run still gets tool guidance', () => {
    // KNOWN_TOOLS decides whether ANY tool guidance renders. It listed
    // generate_image only, so a worker whose sole tools were generate_video /
    // generate_speech / transcribe_audio counted as "no tools registered" and
    // was told nothing about using tools at all.
    for (const tool of ['generate_video', 'generate_speech', 'transcribe_audio']) {
      const out = buildWorkerRules((name) => name === tool);
      expect(out, `${tool} alone should still enable tool guidance`).toContain('- Use tools when needed.');
    }
  });
});

describe('T3Worker — text-tool lean prompts (v0.15.0)', () => {
  it('sends the FULL text-tool contract once, then only a terse reminder', async () => {
    const sysPrompts: string[] = [];
    let calls = 0;
    const router = {
      generate: vi.fn(async (_tier: string, options: { messages: Array<{ content?: unknown }>; systemPrompt?: string }) => {
        const latest = options.messages[options.messages.length - 1];
        const content = typeof latest?.content === 'string' ? latest.content : '';
        if (content.startsWith('Self-test this output')) {
          return makeResult('{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}');
        }
        sysPrompts.push(String(options.systemPrompt ?? ''));
        calls += 1;
        if (calls === 1) {
          // Text-format tool call — no native toolCalls field.
          return makeResult('<tool_call>{"name":"file_write","input":{"path":"a.md","content":"x"}}</tool_call>');
        }
        return makeResult('Final answer');
      }),
      // A model WITHOUT native tool support triggers the text-tool path.
      getModelForTier: () => ({ id: 'local-x', provider: 'ollama', supportsToolUse: false }),
    } as unknown as CascadeRouter;

    const worker = new T3Worker(router, makeToolRegistry(), 't2-parent');
    const result = await worker.execute(makeAssignment(), 'task-lean');

    expect(result.status).toBe('COMPLETED');
    expect(sysPrompts.length).toBeGreaterThanOrEqual(2);
    expect(sysPrompts[0]).toContain('TOOL USE INSTRUCTIONS');   // full contract, turn 1
    expect(sysPrompts[1]).toContain('TOOL USE REMINDER');       // terse afterwards
    expect(sysPrompts[1]).not.toContain('TOOL USE INSTRUCTIONS');
    expect(sysPrompts[1]).toContain('file_write');              // tool names still listed
  });
});

describe('T3Worker.executeTool — unified provider-error classification (used to loop instead of fast-failing)', () => {
  // Regression: a dead image-gen model's 404 ("This model is no longer
  // available to new users") fell through the old hand-rolled regex (which
  // only recognised 429/auth/forbidden) into adaptiveFallback, looping for up
  // to 15 iterations before ever surfacing the real reason. classifyProviderError
  // already recognises 404/model_unavailable as systemic — this just wires it in.
  function makeWorkerWithFailingTool(err: unknown) {
    const toolRegistry = makeToolRegistry({ execute: vi.fn().mockRejectedValue(err) });
    return new T3Worker(makeRouter(vi.fn()), toolRegistry, 't2-parent');
  }

  it('throws CriticalToolError for a 404-shaped provider error (JSON body, no LLM needed)', async () => {
    // Matches the real shape thrown by multimodal/generate.ts's postJson():
    // Object.assign(new Error(rawResponseBodyText), { status: res.status }) —
    // the raw JSON error body as the message, HTTP status as a real property.
    const err = Object.assign(
      new Error(JSON.stringify({
        error: { code: 404, message: 'This model is no longer available to new users.', status: 'NOT_FOUND' },
      })),
      { status: 404 },
    );
    const worker = makeWorkerWithFailingTool(err);
    const tc: ToolCall = { id: 'tc-1', name: 'generate_image', input: {} };

    await expect(
      (worker as unknown as { executeTool: (tc: ToolCall) => Promise<string> }).executeTool(tc),
    ).rejects.toMatchObject({ name: 'CriticalToolError' });
  });

  it('still throws CriticalToolError for the previously-recognised cases (rate limit, auth) on a provider-backed tool', async () => {
    const worker = makeWorkerWithFailingTool(new Error('429 Too Many Requests: rate limit exceeded'));
    const tc: ToolCall = { id: 'tc-2', name: 'generate_image', input: {} };
    await expect(
      (worker as unknown as { executeTool: (tc: ToolCall) => Promise<string> }).executeTool(tc),
    ).rejects.toMatchObject({ name: 'CriticalToolError' });
  });

  it('does NOT fast-fail an ordinary per-task error — still falls through to adaptive recovery', async () => {
    const worker = makeWorkerWithFailingTool(new Error('file not found: nope.txt'));
    const tc: ToolCall = { id: 'tc-3', name: 'file_read', input: {} };
    const result = await (worker as unknown as { executeTool: (tc: ToolCall) => Promise<string> }).executeTool(tc);
    expect(result).toContain('Tool error');
  });

  it('does NOT run classifyProviderError against a non-provider tool, even when its message shares provider vocabulary', async () => {
    // Regression: a plain filesystem EACCES error contains the literal words
    // "permission denied", which classifyProviderError's auth-failure
    // pattern also matches — applying the classifier to EVERY tool's error
    // indiscriminately turned an ordinary "can't read this one file" into a
    // whole-worker escalation instead of letting the agent try another file.
    const worker = makeWorkerWithFailingTool(new Error('EACCES: permission denied, open \'/etc/shadow\''));
    const tc: ToolCall = { id: 'tc-5', name: 'file_read', input: {} };
    const result = await (worker as unknown as { executeTool: (tc: ToolCall) => Promise<string> }).executeTool(tc);
    expect(result).toContain('Tool error');
  });

  it('also fast-fails a tool-tagged systemic error (e.g. web_search when every backend is down)', async () => {
    // web-search.ts throws `Object.assign(new Error(...), { systemic: true })`
    // when all backends fail — a shape classifyProviderError alone would not
    // recognise (it is not a provider/model error), so executeTool checks the
    // tag directly too.
    const err = Object.assign(new Error('Web search for "x" failed across all backends'), { systemic: true });
    const worker = makeWorkerWithFailingTool(err);
    const tc: ToolCall = { id: 'tc-4', name: 'web_search', input: {} };
    await expect(
      (worker as unknown as { executeTool: (tc: ToolCall) => Promise<string> }).executeTool(tc),
    ).rejects.toMatchObject({ name: 'CriticalToolError' });
  });
});

describe('T3Worker.selfTest — fails closed, not open, when grading itself breaks', () => {
  function makeWorkerForSelfTest(generateImpl: CascadeRouter['generate']) {
    return new T3Worker(makeRouter(generateImpl), makeToolRegistry(), 't2-parent');
  }

  it('reports completeness as FAILED when the grading response has no parseable JSON, instead of a clean pass', async () => {
    // Regression: this used to be { passed: [all three], failed: [] } — a
    // grading response that doesn't parse (malformed JSON, or none at all)
    // silently counted as a clean pass, letting an ungrounded or off-topic
    // worker output sail through undetected.
    const worker = makeWorkerForSelfTest(vi.fn().mockResolvedValue(makeResult('not json at all')));
    const result = await (worker as unknown as {
      selfTest: (a: T2ToT3Assignment, output: string) => Promise<{ checksRun: string[]; passed: string[]; failed: string[] }>;
    }).selfTest(makeAssignment(), 'some output');
    expect(result.failed).toContain('completeness');
    expect(result.passed).not.toContain('completeness');
  });
});

describe('shouldRequireArtifact', () => {
  const fileTask = { description: 'Write a spec to specs/pump.md', expectedOutput: 'A saved file specs/pump.md' };

  it('does NOT require an artifact when the worker has no file-writing tool', () => {
    // The hosted chat run enables only web tools — requiring a file it cannot
    // create is what produced the "stalled waiting for artifact creation" bug.
    expect(shouldRequireArtifact(fileTask, ['web_search', 'web_fetch'])).toBe(false);
    expect(shouldRequireArtifact({ files: ['out.pdf'] }, ['web_search'])).toBe(false);
  });

  it('requires an artifact when a file-writing tool is available and a file is asked for', () => {
    expect(shouldRequireArtifact(fileTask, ['file_write', 'file_read'])).toBe(true);
    expect(shouldRequireArtifact({ files: ['out.pdf'] }, ['file_write'])).toBe(true);
    expect(shouldRequireArtifact({ description: 'create a file called notes.txt' }, ['file_edit'])).toBe(true);
    expect(shouldRequireArtifact(fileTask, ['shell'])).toBe(true); // shell can write files too
  });

  it('does not require an artifact for a pure question, even with file tools', () => {
    expect(shouldRequireArtifact(
      { description: 'Determine the Flare KOD pump specifications', expectedOutput: 'A concise answer' },
      ['file_write', 'shell'],
    )).toBe(false);
  });

  it('tolerates an undefined assignment', () => {
    expect(shouldRequireArtifact(undefined, ['file_write'])).toBe(false);
  });

  it('recognises Office deliverables now that a tool can genuinely produce them', () => {
    // Before generate_document existed, `deck.pptx` could only ever have been
    // "satisfied" by writing text into a file PowerPoint refuses to open.
    expect(shouldRequireArtifact({ description: 'Build deck.pptx' }, ['generate_document'])).toBe(true);
    expect(shouldRequireArtifact({ description: 'Build book.xlsx' }, ['file_write'])).toBe(true);
    expect(shouldRequireArtifact({ description: 'Build deck.pptx' }, ['web_search'])).toBe(false);
  });
});

describe('missingVisualEvidence — "you asked for a picture, is there one?"', () => {
  const ASKS = { description: 'Build a deck with a chart of quarterly revenue', expectedOutput: 'deck.pptx' };
  const TOOLS = ['file_write', 'generate_image', 'generate_document'];

  it('flags prose that only DESCRIBES the visual it was asked for', () => {
    // The exact failure a real generated deck showed: an emphatic MUST-call
    // rule, and the output still had no image, no chart — just a paragraph
    // about what a chart would have shown.
    const issue = missingVisualEvidence(ASKS, 'The chart would show revenue rising each quarter.', [], TOOLS);
    expect(issue).toContain('no embedded image and no chart block');
    expect(issue).toContain('generate_image');
    expect(issue).toContain('chart:bar');
  });

  it('accepts a real chart block as evidence', () => {
    const out = '# Deck\n\n```chart:bar\nQuarter,Revenue\nQ1,120\n```\n';
    expect(missingVisualEvidence(ASKS, out, [], TOOLS)).toBeNull();
  });

  it('accepts an embedded image reference as evidence', () => {
    expect(missingVisualEvidence(ASKS, '![a cat](generated/cat.png)', [], TOOLS)).toBeNull();
  });

  it('accepts having actually called a tool that writes the visual into the binary', () => {
    // generate_document writes the picture into a file, so it will never show
    // up in the worker's text — the call itself is the evidence.
    expect(missingVisualEvidence(ASKS, 'Done.', ['generate_document'], TOOLS)).toBeNull();
    expect(missingVisualEvidence(ASKS, 'Done.', ['generate_image'], TOOLS)).toBeNull();
  });

  it('stays silent when the subtask never asked for a visual', () => {
    expect(missingVisualEvidence(
      { description: 'Summarise the Q3 numbers', expectedOutput: 'A paragraph' }, 'Revenue grew.', [], TOOLS,
    )).toBeNull();
  });

  it('stays silent when nothing registered could satisfy it', () => {
    // Demanding a picture from a worker with no way to make one is the
    // unsatisfiable-requirement bug verifyArtifacts already had to unlearn.
    expect(missingVisualEvidence(ASKS, 'Here is what a chart would show.', [], ['web_search'])).toBeNull();
  });
});
