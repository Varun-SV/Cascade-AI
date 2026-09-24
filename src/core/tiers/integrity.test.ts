// ─────────────────────────────────────────────
//  Cascade AI — Never pass off work that did not happen
// ─────────────────────────────────────────────
//
//  One rule, every prompt that can hand the user an answer. Each door is
//  tested here rather than beside its tier, so a new door that forgets the
//  rule has an obvious place to be missed from.

import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CascadeConfig, GenerateResult, T2ToT3Assignment, T2Result, ToolCall, ToolDefinition } from '../../types.js';
import type { CascadeRouter } from '../router/index.js';
import type { ToolRegistry } from '../../tools/registry.js';
import { ACTING_INTEGRITY_RULE, REPORTING_INTEGRITY_RULE, appendToolRecord, describeArgs, describeHandedWork, describeToolRecord, recordToolCall, toolReportedFailure, type ToolRecordEntry } from './integrity.js';
import { PeerBus } from '../peer/bus.js';
import { T3Worker, buildWorkerRules } from './t3-worker.js';
import { T2Manager } from './t2-manager.js';
import { T1Administrator, type TaskPlan } from './t1-administrator.js';

function makeResult(content: string, toolCalls?: ToolCall[]): GenerateResult {
  return {
    content,
    toolCalls,
    finishReason: toolCalls?.length ? 'tool_use' : 'stop',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostUsd: 0 },
  };
}

function assignment(overrides: Partial<T2ToT3Assignment> = {}): T2ToT3Assignment {
  return {
    subtaskId: 'probe',
    subtaskTitle: 'Probe the chatbot',
    description: 'Open the site with browser control, ask the chatbot the three questions, and return its answers verbatim',
    expectedOutput: 'The chatbot’s three answers, unchanged',
    constraints: [],
    peerT3Ids: [],
    parentT2: 't2-1',
    ...overrides,
  };
}

/** The refusal the browser controller throws when every session is taken. */
const REFUSAL = 'All 1 browser session are in use by other runs. Try again when one finishes, or raise the session limit in settings.';

function browserRegistry(execute = vi.fn().mockRejectedValue(new Error(REFUSAL))): ToolRegistry {
  const defs: ToolDefinition[] = [{ name: 'browser_control', description: 'Drive a browser', inputSchema: {} }];
  return {
    getToolDefinitions: () => defs,
    requiresApproval: () => false,
    isDangerous: () => false,
    hasTool: (n: string) => n === 'browser_control',
    execute,
  } as unknown as ToolRegistry;
}

type Call = { tier: string; systemPrompt: string; content: string };

const PASS = '{"completeness":"pass","correctness":"pass","compliance":"pass","notes":"ok"}';

/** Records every model call; the self-test passes and everything else answers `text`. */
function recordingRouter(text: string, extra: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  const router = {
    generate: vi.fn(async (tier: string, options: { messages: Array<{ content: unknown }>; systemPrompt?: string }) => {
      const latest = options.messages[options.messages.length - 1];
      const content = typeof latest?.content === 'string' ? latest.content : '';
      calls.push({ tier, systemPrompt: options.systemPrompt ?? '', content });
      return makeResult(content.startsWith('Self-test this output') ? PASS : text);
    }),
    getModelForTier: () => undefined,
    ...extra,
  } as unknown as CascadeRouter;
  return { router, calls };
}

const noTools = () => ({ ...browserRegistry(), getToolDefinitions: () => [] }) as unknown as ToolRegistry;

/**
 * A worker that reaches for the browser once, is refused, and then reports
 * exactly what the reported run did: answers it never obtained.
 */
function fabricatingRouter(opts: {
  selfTest?: (prompt: string) => string;
  reflection?: boolean;
} = {}) {
  const calls: Call[] = [];
  let loop = 0;
  const generate = vi.fn(async (tier: string, options: { messages: Array<{ content: unknown }>; systemPrompt?: string }) => {
    const latest = options.messages[options.messages.length - 1];
    const content = typeof latest?.content === 'string' ? latest.content : '';
    calls.push({ tier, systemPrompt: options.systemPrompt ?? '', content });
    if (content.startsWith('Self-test this output')) {
      return makeResult(opts.selfTest?.(content) ?? PASS);
    }
    if (content.includes('independent critic')) return makeResult('{"sufficient": false, "notes": "the answers are missing"}');
    if (content.startsWith('Improve the following')) return makeResult('Improved output');
    loop += 1;
    if (loop === 1) return makeResult('', [{ id: 'b1', name: 'browser_control', input: { action: 'navigate', url: 'https://example.test' } }]);
    return makeResult('I logged in and asked the chatbot. It answered: "Yes", "No", "Maybe".');
  });
  const router = {
    generate,
    getModelForTier: () => undefined,
    ...(opts.reflection ? { getReflectionConfig: () => ({ enabled: true, maxRounds: 1 }) } : {}),
  } as unknown as CascadeRouter;
  return { router, calls };
}

describe('describeToolRecord — what the worker actually did', () => {
  it('says plainly when no tool ran, so a claimed action has nothing behind it', () => {
    expect(describeToolRecord([])).toBe('none — no tool was called');
  });

  it('lists each call with the start of what it returned, on one line', () => {
    const text = describeToolRecord([
      { name: 'web_search', result: 'Top result:\n  Example   Domain' },
      { name: 'browser_control', result: `Tool error: ${REFUSAL}` },
    ]);
    expect(text).toBe(`- web_search → Top result: Example Domain\n- browser_control → Tool error: ${REFUSAL}`);
  });

  it('clips a long result to its start, where the outcome and any error are', () => {
    const text = describeToolRecord([{ name: 'web_fetch', result: `OK ${'x'.repeat(500)}` }]);
    expect(text.startsWith('- web_fetch → OK xxx')).toBe(true);
    expect(text.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThan(200);
  });

  it('accounts for every call: the latest in full, the ones before with what each was asked and how it went', () => {
    // A bare "(3 earlier calls not shown)" left the grader told to fail an
    // action no LISTED call performed, while the call that performed it was
    // one of the three. A correct output citing call 1 of 15 read as invented.
    const record = [
      recordToolCall('browser_control', 'navigated to https://example.test', { action: 'navigate', url: 'https://example.test' }),
      { name: 'browser_control', result: `Tool error: ${REFUSAL}` },
      { name: 'web_fetch', result: 'OK' },
      ...Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, result: 'ok' })),
    ];
    const text = describeToolRecord(record);
    expect(text.split('\n').slice(0, 5)).toEqual([
      'Earlier calls (3):',
      '- browser_control(action=navigate, url=https://example.test) → returned a result',
      '- browser_control → an error or refusal',
      '- web_fetch → returned a result',
      'Most recent 12:',
    ]);
    expect(text).toContain('- t0 → ok');
    expect(text).toContain('- t11 → ok');
  });

  it('keeps which site an early navigation went to — a tally by tool could not say', () => {
    // "browser_control ×1 (1 returned a result)" was all the grader saw of
    // call 1 of 13, so an output naming the site it visited could not be
    // checked against anything.
    const record = [
      recordToolCall('browser_control', 'navigated', { action: 'navigate', url: 'https://first.test' }),
      ...Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, result: 'ok' })),
    ];
    expect(describeToolRecord(record)).toContain('- browser_control(action=navigate, url=https://first.test) → returned a result');
  });

  it('tallies by tool only the calls older than those, so the record stays bounded', () => {
    const record = [
      { name: 'web_search', result: 'ok' },
      { name: 'web_search', result: 'Tool error: 429 rate limited' },
      ...Array.from({ length: 48 }, (_, i) => ({ name: `o${i}`, result: 'ok' })),
      ...Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, result: 'ok' })),
    ];
    const lines = describeToolRecord(record).split('\n');
    expect(lines.slice(0, 3)).toEqual([
      'Earliest calls, by tool (2):',
      '- web_search ×2 (1 returned a result, 1 an error or refusal)',
      'Earlier calls (48):',
    ]);
    expect(lines).toContain('- o0 → returned a result');
    expect(lines).toContain('Most recent 12:');
  });

  it('counts a browser action the tool refused as a failure, in the words the tool really uses', async () => {
    // browser_control does not throw on a refused action: it returns
    // "Failed: …". That is how the session cap actually reaches the record,
    // and the summary counted it as a result.
    const { BrowserControlTool } = await import('../../tools/browser-control.js');
    const tool = new BrowserControlTool(async () => ({ ok: false, detail: REFUSAL }));
    const refused = await tool.execute({ action: 'navigate', url: 'https://example.test' }, { sessionId: 'run-1', tierId: 'w1' } as never);
    expect(refused.startsWith('Failed: '), 'the format this depends on').toBe(true);

    const record = [
      recordToolCall('browser_control', refused),
      recordToolCall('web_fetch', 'Failed to fetch https://example.test: ECONNREFUSED'),
      recordToolCall('grep', 'No matches found for: needle'),
      ...Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, result: 'ok' })),
    ];
    expect(describeToolRecord(record).split('\n').slice(1, 4)).toEqual([
      '- browser_control → an error or refusal',
      '- web_fetch → an error or refusal',
      '- grep → returned a result',
    ]);
  });

  it('counts every tool\u2019s own failure wording as a failure, and a success as a result', async () => {
    // Each tool words failure its own way. run_code's "Execution failed
    // (12ms):" was read as a result, so once it scrolled past the latest
    // twelve the grader was told code had run and produced output.
    const failures: Array<[string, string]> = [
      ['run_code', 'Execution failed (12ms):\nError: boom\nStderr: \nStdout: '],
      ['run_code', 'Execution timed out after 30s. Consider breaking the task into smaller pieces.'],
      ['run_code', 'Error: Python interpreter not found.\nPlease install Python and ensure it is in your PATH.\nTried: python3, python'],
      ['run_code', 'Error: Node.js interpreter not found.\nPlease install Node.js and ensure it is in your PATH.\nTried: node'],
      ['web_fetch', 'HTTP 404 Not Found from https://example.test/missing'],
      ['web_fetch', 'Refused to fetch http://10.0.0.1/: private address'],
      ['browser', 'Browser action "click" failed: element not found'],
      ['browser', 'Browser error (page reset): Target closed'],
      ['browser_control', 'Failed: All 1 browser session are in use.'],
      ['browser_control', 'Error: the browser could not perform "click" — detached'],
      ['summarise_csv', 'Dynamic tool "summarise_csv" timed out after 5000ms and was terminated.'],
      ['summarise_csv', 'Error calling web_fetch: nope'],
      ['summarise_csv', 'Permission denied for "shell": dynamic tool "summarise_csv" has no approver available (default-deny).'],
      ['github', 'Validation error from GitHub: bad ref'],
      ['github', 'github API error (500): Server Error'],
      ['github', 'gitlab request failed: ECONNRESET'],
      ['github', 'Rate limited by GitHub. Please wait a moment before trying again.'],
      ['transcribe_audio', 'Could not read the audio file at /tmp/a.wav.'],
      // No transcript is no evidence of what the audio said.
      ['transcribe_audio', 'whisper-1 returned an empty transcript — the file may be silent or in an unsupported format.'],
      ['transcribe_audio', 'No transcription model is available on your configured providers.'],
      ['generate_image', 'dall-e-3 needs the openai provider, which is not configured.'],
      ['generate_video', 'No video model is available on your configured providers.'],
      ['code_search', 'Code search failed: index is not built'],
      ['ask_user', 'They did not answer in time. Proceed on your best reading of the request, and say plainly which assumption you made.'],
      ['ask_user', 'There is nobody watching this run to answer. Proceed on your best reading of the request, and say plainly which assumption you made.'],
      ['mcp::docs::search', 'Tool error: rate limited'],
      ['file_read', 'Tool error: ENOENT: no such file'],
    ];
    const { ShellTool } = await import('../../tools/shell.js');
    const exited = await new ShellTool().execute({ command: 'exit 3' }, { tierId: 'T3', sessionId: 's' });
    expect(exited.startsWith('Exit 3:'), 'the format this depends on').toBe(true);
    failures.push(['shell', exited]);

    // Content that merely starts like a failure. Matched against every
    // result, each of these was graded "an error or refusal", and an answer
    // built on the page or file was rejected as unsupported.
    const successes: Array<[string, string]> = [
      ['run_code', 'Execution successful (8ms):\nStdout: Error: Python interpreter not found. (printed by the script)'],
      ['shell', '(no output)'], ['browser_control', 'Navigated to https://example.test'],
      ['file_read', 'Error handling in Go is explicit.'], ['file_read', 'Deployment notes: all green'],
      ['browser_control', 'Failed experiments in 2024 taught us three things'],
      ['browser_control', 'Error: 404 — the page you asked for is not here'],
      ['file_read', 'Build failed: 3 errors in src/app.ts'],
      ['file_read', 'Execution failed (12ms): copied from a CI log'],
      ['file_read', 'Error: this line is in the log file being read'],
      ['shell', 'Build failed: see above'],
      ['run_code', 'Execution successful (40ms):\nFailed: 0'],
      ['web_search', 'Error: messages in search results are still results'],
      ['ask_user', 'They answered:\n\nQ: Which region?\n  → They did not answer in time'],
      ['code_search', '# src/app.ts\nProvide a "query" to search the codebase — a comment in the code'],
    ];
    const filler = Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, result: 'ok' }));
    const outline = (entries: Array<[string, string]>) => describeToolRecord([
      ...entries.map(([name, result]) => recordToolCall(name, result)), ...filler,
    ]).split('\n').slice(1, 1 + entries.length);

    expect(outline(failures)).toEqual(failures.map(([name]) => `- ${name} → an error or refusal`));
    expect(outline(successes)).toEqual(successes.map(([name]) => `- ${name} → returned a result`));
  });

  it('knows every failure a built-in tool returns, read from the tools themselves', () => {
    // Three review rounds each found a tool whose failure wording was missing
    // from the table (run_code, github, code_search), because the table was
    // kept by hand. This reads every tool source for a returned string that
    // says it failed, and checks the table says so for THAT tool. A new tool,
    // or a new failure message, that the table does not know fails here.
    const toolsDir = fileURLToPath(new URL('../../tools/', import.meta.url));
    const FAILURE_WORDS = /fail|error|could not|cannot|unable|denied|refus|timed? out|not found|invalid|^provide |missing|not (?:available|enabled|installed|configured)|empty|unsupported|^no \w+ model|no page is open|is not one of those|did not answer|chose not to answer|nobody watching|stopped while/i;
    // Checked by name in the tests above, where the wording is spliced from
    // parts this scan cannot rebuild.
    const SPLICED = [/^\$\{outcome\.ok/, /^\$\{why\}/];
    const missed: string[] = [];
    let checked = 0;
    const STRING = String.raw`(['\`])((?:(?!\1).)*)\1`;
    for (const file of fs.readdirSync(toolsDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      // Null until the first tool class: a module-level helper, whose words
      // any tool in the file may return — generate-media's `resolve` answers
      // for all four media tools. Checked against every one of them.
      let tool: string | null = null;
      const tools: string[] = [];
      const found: Array<{ text: string; tool: string | null }> = [];
      // A message built as lines — `return [\n 'Error: …',\n …].join('\n')` —
      // starts on the line after the bracket. Missed at first: run_code's
      // "interpreter not found" is written that way.
      let arrayHead = false;
      // A `return` that runs on over lines — `return text\n ? … \n : '…';` —
      // returns whichever branch it takes. transcribe_audio's empty transcript
      // was the second branch of one, and nothing read it.
      let returnOpen = false;
      for (const line of fs.readFileSync(path.join(toolsDir, file), 'utf8').split('\n')) {
        const named = /readonly name = '([a-z_]+)'/.exec(line);
        if (named) { tool = named[1]!; tools.push(tool); }
        const texts: string[] = [];
        const opensArray = /(?:return|resolve\()\s*\[\s*$/.test(line);
        if (arrayHead) {
          const head = new RegExp(String.raw`^\s*${STRING}`).exec(line);
          if (head) texts.push(head[2]!);
          if (line.trim() && !line.trim().startsWith('//')) arrayHead = false;
        }
        const direct = new RegExp(String.raw`(?:return|resolve\()\s*${STRING}`).exec(line);
        if (direct) texts.push(direct[2]!);
        // A ternary's branches, on the return line or the lines it runs on to —
        // not a `??` fallback, and not a string inside a `${…}`, which is a
        // piece of the message rather than its start.
        const isReturn = /\breturn\b/.test(line);
        if (isReturn || returnOpen) {
          const outer = line.replace(/\$\{[^{}]*\}/g, '${x}');
          for (const m of outer.matchAll(new RegExp(String.raw`(?<!\?)[?:]\s*${STRING}`, 'g'))) texts.push(m[2]!);
        }
        // An error a shared helper hands back for a tool to return.
        const errorProp = new RegExp(String.raw`(?<![\w.])error:\s*${STRING}`).exec(line);
        if (errorProp) texts.push(errorProp[2]!);
        if (isReturn && !/^\s*return\s*\[\s*$/.test(line)) returnOpen = !/;\s*(?:\/\/.*)?$/.test(line);
        else if (returnOpen && /;\s*(?:\/\/.*)?$/.test(line)) returnOpen = false;
        if (opensArray) { arrayHead = true; continue; }
        for (const text of texts) found.push({ text, tool });
      }
      for (const { text, tool: owner } of found) {
        if (!FAILURE_WORDS.test(text) || SPLICED.some((r) => r.test(text))) continue;
        const sample = text.replace(/\$\{[^}]*\}/g, '404');
        for (const name of owner ? [owner] : tools.length ? tools : ['created_tool']) {
          checked++;
          if (!toolReportedFailure(name, sample)) missed.push(`${file} [${name}]: ${sample.slice(0, 80)}`);
        }
      }
    }
    expect(checked, 'the scan found the tools').toBeGreaterThan(40);
    expect(missed).toEqual([]);
  });

  it('stays bounded however many calls there were', () => {
    const record = Array.from({ length: 500 }, (_, i) => recordToolCall(
      i % 2 ? 'web_fetch' : 'web_search', 'x'.repeat(1000), { url: `https://x.test/${'y'.repeat(1000)}`, query: 'z'.repeat(1000) },
    ));
    // Twelve in full, 48 outlined, two tallied tools.
    expect(describeToolRecord(record).length).toBeLessThan(12 * 360 + 48 * 200 + 300);
  });

  it('keeps only the start of a result when the call is recorded, not the whole of it', () => {
    // Held for the life of the worker: a few file_reads of large files was
    // hundreds of megabytes kept to show the grader 160 characters of each.
    const entry = recordToolCall('file_read', `START ${'x'.repeat(1_000_000)}`);
    expect(entry.result.startsWith('START xxx')).toBe(true);
    expect(entry.result.length).toBeLessThanOrEqual(161);
    expect(entry.evidence?.length, 'no more of it than the model was shown').toBeLessThanOrEqual(12_000);
  });

  describe('evidence for what the output says', () => {
    const filler = (n: number) => 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.\n'.repeat(n);
    const REPORT = `Annual report\n${filler(40)}Revenue in 2025 was 4.2 billion across 31 markets.\n${filler(10)}`;
    /** The passages section, or '' when there is none. */
    const passagesIn = (text: string) => (text.includes('Passages from') ? text.slice(text.indexOf('Passages from')) : '');

    it('shows the grader a fact from past the start of a result, where the output took it from', () => {
      // Kept to 160 characters, a result could not show this: an accurate
      // answer from further into the page read the same as an invented one.
      const record = [recordToolCall('file_read', REPORT, { path: 'report.md' })];
      const text = describeToolRecord(record, 'Revenue in 2025 was 4.2 billion, across 31 markets.');
      expect(text).toContain('- file_read(path=report.md) → Annual report Lorem ipsum');
      expect(passagesIn(text)).toMatch(/^Passages from what those calls returned.*\n- file_read\(path=report\.md\): ".*Revenue in 2025 was 4\.2 billion across 31 markets\./);
    });

    it('shows what the page really said beside a figure the output changed', () => {
      const record = [recordToolCall('file_read', REPORT, { path: 'report.md' })];
      expect(passagesIn(describeToolRecord(record, 'Revenue in 2025 was 9.9 billion across 77 markets.'))).toContain('4.2 billion across 31 markets');
    });

    it('shows no passage for a claim nothing returned', () => {
      const record = [recordToolCall('file_read', REPORT, { path: 'report.md' })];
      expect(describeToolRecord(record, 'The chief executive resigned in March.')).not.toContain('Passages');
    });

    it('draws on any call still holding evidence, not only the latest twelve', () => {
      const record: ToolRecordEntry[] = [];
      appendToolRecord(record, recordToolCall('file_read', REPORT, { path: 'report.md' }));
      for (let i = 0; i < 30; i++) appendToolRecord(record, recordToolCall('web_search', `result ${i}`, { query: `q${i}` }));
      expect(passagesIn(describeToolRecord(record, 'Revenue in 2025 was 4.2 billion across 31 markets.')))
        .toMatch(/- file_read\(path=report\.md\): ".*Revenue in 2025 was 4\.2 billion/);
    });

    it('holds what the model was shown of a long result, and not the middle it never saw', () => {
      const long = `Head fact: the bridge opened in 1932.\n${filler(300)}Middle fact: the tower rose in 1889.\n${filler(300)}Tail fact: the canal closed in 1974.`;
      const record = [recordToolCall('web_fetch', long, { url: 'https://history.test' })];
      const text = passagesIn(describeToolRecord(record, 'The bridge opened in 1932, the tower rose in 1889 and the canal closed in 1974.'));
      expect(text).toContain('the bridge opened in 1932');
      expect(text, 'whole, not its figure without what it is about').toContain('the canal closed in 1974');
      expect(text, 'the model never saw the middle, so it is not evidence').not.toContain('the tower rose in 1889');
    });

    it('drops the record a cut went through, so half a credential cannot get past redaction', () => {
      // `truncateForContext` keeps the first 9,000 characters and the last
      // 3,000. Cut in two at either point, a key is not recognisable as one.
      const key = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
      const cutAtHead = `${'w '.repeat(4_490)}${key}\n${'m '.repeat(3_000)}`;
      const cutAtTail = `${'m '.repeat(6_000)}x${key}\n${'z '.repeat(1_480)}`;
      expect(cutAtHead.indexOf(key)).toBeLessThan(9_000);
      expect(cutAtHead.indexOf(key) + key.length, 'the head cut is inside the key').toBeGreaterThan(9_000);
      const tailStart = cutAtTail.length - 3_000;
      expect(cutAtTail.indexOf(key)).toBeLessThan(tailStart);
      expect(cutAtTail.indexOf(key) + key.length, 'the tail cut is inside the key').toBeGreaterThan(tailStart);
      for (const result of [cutAtHead, cutAtTail]) {
        const evidence = recordToolCall('file_read', result).evidence ?? '';
        expect(evidence.length, 'the rest is still kept').toBeGreaterThan(2_000);
        expect(evidence).not.toMatch(/AbCd|IjKl|QrSt|Yz01|6789/);
      }
    });

    it('still shows a short result once its call is older than the latest twelve', () => {
      // A short result has no evidence apart from itself, and the outline says
      // only "returned a result": an order number read early was lost.
      const record: ToolRecordEntry[] = [];
      appendToolRecord(record, recordToolCall('shop_api', 'Order 48213 created for Ada', { action: 'create' }));
      for (let i = 0; i < 20; i++) appendToolRecord(record, recordToolCall('web_search', `result ${i}`, { query: `q${i}` }));
      const text = describeToolRecord(record, 'Created order 48213 for Ada.');
      expect(text).toContain('- shop_api(action=create) → returned a result');
      expect(passagesIn(text)).toContain('- shop_api(action=create): "Order 48213 created for Ada"');
    });

    it('does not repeat a short result the latest calls already show whole', () => {
      const record = [recordToolCall('shop_api', 'Order 48213 created for Ada')];
      expect(describeToolRecord(record, 'Created order 48213 for Ada.')).toBe('- shop_api → Order 48213 created for Ada');
    });

    it('takes a credential out of an XML file a tool read', () => {
      const entry = recordToolCall('file_read', `<config>\n  <user>svc</user>\n  <password>hunter2</password>\n${'  <flag>on</flag>\n'.repeat(20)}</config>`);
      expect(`${entry.result} ${entry.evidence}`).not.toContain('hunter2');
      expect(entry.evidence).toContain('<password>[REDACTED_SECRET]</password>');
    });

    it('keeps the record\u2019s evidence within a budget, the oldest calls giving theirs up first', () => {
      const record: ToolRecordEntry[] = [];
      for (let i = 0; i < 60; i++) appendToolRecord(record, recordToolCall('file_read', `file ${i} ${filler(400)}`, { path: `f${i}` }));
      const held = record.reduce((sum, e) => sum + (e.evidence?.length ?? 0), 0);
      expect(held).toBeLessThanOrEqual(256_000);
      expect(record[59]!.evidence, 'the latest keeps its evidence').toBeDefined();
      expect(record[0]!.evidence, 'the oldest gave its up').toBeUndefined();
      expect(record[0]!.result, 'and still says what it returned').toMatch(/^file 0 Lorem/);
    });

    it('bounds the passages however much of the evidence bears on the output', () => {
      const record: ToolRecordEntry[] = [];
      const page = 'Revenue in 2025 was 4.2 billion across 31 markets. '.repeat(200);
      for (let i = 0; i < 12; i++) appendToolRecord(record, recordToolCall('file_read', page, { path: `r${i}` }));
      const passages = passagesIn(describeToolRecord(record, 'Revenue in 2025 was 4.2 billion across 31 markets.'));
      expect(passages.length).toBeGreaterThan(1_000);
      expect(passages.length).toBeLessThanOrEqual(6_200);
    });
  });

  describe('work handed over by the subtasks this one depends on', () => {
    it('is shown whole when it is short, with its credentials out', () => {
      expect(describeHandedWork([
        { from: 'visit', output: 'Visited https://shop.test and\n logged in with password: hunter2. The chatbot said "Yes".' },
      ], 'The chatbot said yes.')).toBe('- visit: Visited https://shop.test and logged in with password: [REDACTED_SECRET] The chatbot said "Yes".');
    });

    it('is shown as the passages that bear on the output when it is long', () => {
      const long = `${'Background notes on the shop and its catalogue. '.repeat(200)}The chatbot quoted a refund window of 45 days. ${'More notes. '.repeat(100)}`;
      const text = describeHandedWork([{ from: 'visit', output: long }], 'The refund window is 45 days.');
      expect(text.length).toBeLessThanOrEqual(4_200);
      expect(text).toMatch(/^Too long to show whole;.*\n- visit: ".*The chatbot quoted a refund window of 45 days\./);
    });
  });

  it('says what each call was asked to do, so a claim can be checked against more than the tool\u2019s name', () => {
    // "Filled #q" never says what was typed, and a successful shell command
    // may print nothing: an output claiming other text or another command
    // looked supported by the name and result alone.
    const entry = recordToolCall('browser_control', 'Filled #q', { action: 'fill', selector: '#q', value: 'what is dark matter?' });
    expect(describeToolRecord([entry])).toBe('- browser_control(action=fill, selector=#q, value=what is dark matter?) → Filled #q');
  });

  it('keeps secrets out of the record: secret-named arguments, and anything typed into a password field', () => {
    expect(describeArgs({ url: 'https://x.test', apiKey: 'sk-live-123', authorization: 'Bearer abc' }))
      .toBe('url=https://x.test, apiKey=[redacted], authorization=[redacted]');
    // The password arrives under a plain `value`; the selector gives it away.
    expect(describeArgs({ action: 'fill', selector: 'input[type=password]', value: 'hunter2' }))
      .toBe('action=fill, selector=input[type=password], value=[redacted]');
    expect(describeArgs({ action: 'fill', selector: '#password', value: 'hunter2' })).not.toContain('hunter2');
  });

  it('takes credentials out of what a tool returned — the grader may be another provider', () => {
    // file_read of a .env, or a shell command that echoes a token: the worker
    // saw it, but the self-test can run on a model that never did.
    const key = 'sk-proj-4f9a2b7c1d8e3f6a0b5c9d2e7f1a4b8c';
    const entry = recordToolCall('file_read', `OPENAI_API_KEY=${key}\nGITHUB_TOKEN=ghp_0123456789abcdefghijABCDEFGHIJ`);
    expect(entry.result).not.toContain(key);
    expect(entry.result).not.toContain('ghp_0123456789');
    expect(entry.result).toContain('OPENAI_API_KEY=[REDACTED_SECRET]');
  });

  it('names the tool that actually ran when the worker fell back, in every tier of the record', () => {
    // file_remove was not registered, and the fallback answered with
    // file_read. Once the call left the latest twelve it read as
    // "file_remove(path=a.txt) → returned a result": a deletion that never
    // happened, with nothing left to say so.
    const fell = recordToolCall('file_remove', '[Fallback via file_read]: contents of a.txt', { path: 'a.txt' }, 'file_read');
    const filler = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `t${i}`, result: 'ok' }));
    expect(describeToolRecord([fell])).toBe('- file_remove(path=a.txt) [ran as file_read] → [Fallback via file_read]: contents of a.txt');
    expect(describeToolRecord([fell, ...filler(12)]).split('\n')[1])
      .toBe('- file_remove(path=a.txt) [ran as file_read] → returned a result');
    expect(describeToolRecord([fell, ...filler(60)]).split('\n')[1])
      .toBe('- file_remove [ran as file_read] ×1 (1 returned a result)');
  });

  it('judges a fallback by the tool that ran, behind the marker', () => {
    const failed = recordToolCall('fetch_page', '[Fallback via web_fetch]: HTTP 503 Service Unavailable from https://x.test', {}, 'web_fetch');
    const lines = describeToolRecord([failed, ...Array.from({ length: 12 }, (_, i) => ({ name: `t${i}`, result: 'ok' }))]).split('\n');
    expect(lines[1]).toBe('- fetch_page [ran as web_fetch] → an error or refusal');
  });

  it('takes out a short labelled password too, not only long token-shaped values', () => {
    const entry = recordToolCall('shell', 'DB_PASSWORD=hunter2\nDB_HOST=db.internal');
    expect(entry.result).toBe('DB_PASSWORD=[REDACTED_SECRET] DB_HOST=db.internal');
  });

  it('takes the password out of a connection URL a tool printed', () => {
    const entry = recordToolCall('file_read', 'DATABASE_URL=postgres://dbuser:hunter2@db.example.com/prod');
    expect(entry.result).toBe('DATABASE_URL=postgres://dbuser:[REDACTED_SECRET]@db.example.com/prod');
  });

  it('takes credentials out of an argument whose name does not give them away', () => {
    const args = describeArgs({ command: "curl -H 'Authorization: Bearer abcdefghijklmnop1234' https://api.test" });
    expect(args).not.toContain('abcdefghijklmnop1234');
    expect(args).toContain('Bearer [REDACTED_SECRET]');
  });

  it('takes a short header credential out of what a tool printed', () => {
    const entry = recordToolCall('shell', '> GET /v1 HTTP/1.1\n> Authorization: Basic YTpi\n> Cookie: sid=abc');
    expect(entry.result).toBe('> GET /v1 HTTP/1.1 > Authorization: Basic [REDACTED_SECRET] > Cookie: [REDACTED_SECRET]');
  });

  it('keeps what a claim can be checked against: addresses and numbers are not credentials', () => {
    const entry = recordToolCall('web_fetch', 'Contact admin@example.com, server 10.0.0.7, call 555-123-4567');
    expect(entry.result).toBe('Contact admin@example.com, server 10.0.0.7, call 555-123-4567');
  });

  it('does not take a secret word inside an ordinary one as a secret', () => {
    // `auth` matched inside `author`, so a write to authors.txt or a fill
    // into #author recorded the text as [redacted] and the grader could not
    // check what was written.
    expect(describeArgs({ path: 'authors.txt', content: 'public biography' }))
      .toBe('path=authors.txt, content=public biography');
    expect(describeArgs({ action: 'fill', selector: '#author', value: 'Ada Lovelace' }))
      .toBe('action=fill, selector=#author, value=Ada Lovelace');
    expect(describeArgs({ selector: '#passage', text: 'Call me Ishmael', tokenizer: 'bpe' }))
      .toBe('selector=#passage, text=Call me Ishmael, tokenizer=bpe');
    expect(describeArgs({ action: 'press', key: 'Enter' }), 'a key press is not a credential').toBe('action=press, key=Enter');
  });

  it('still takes out what is typed into a secret field, however the field is spelled', () => {
    for (const selector of ['#login-password', 'input[name="apiKey"]', '#auth-token', '[data-field=pin]', '#otp']) {
      expect(describeArgs({ action: 'fill', selector, value: 'hunter2' }), selector).not.toContain('hunter2');
    }
    expect(describeArgs({ privateKey: 'abc', clientSecret: 'def' })).toBe('privateKey=[redacted], clientSecret=[redacted]');
  });

  it('keeps the argument summary bounded', () => {
    const args = describeArgs({ command: 'x'.repeat(10_000), cwd: '/tmp', env: { A: 'y'.repeat(500) } });
    expect(args.length).toBeLessThanOrEqual(161);
    expect(args.startsWith('command=xxx')).toBe(true);
  });

  it('marks an empty result rather than printing nothing after the arrow', () => {
    expect(describeToolRecord([{ name: 'shell', result: '  ' }])).toBe('- shell → (empty result)');
  });
});

describe('what the acting rule asks for', () => {
  it('lets a worker fix a call the tool told it how to fix, instead of stopping at the first error', () => {
    // executeTool's own validation says "supply them and call the tool
    // again", and a busy browser says to try again. A rule that stopped at
    // any error contradicted both.
    expect(ACTING_INTEGRITY_RULE).toContain('A tool error you can act on');
    expect(ACTING_INTEGRITY_RULE).toContain('correct the call and retry');
    expect(ACTING_INTEGRITY_RULE, 'stopping is for when there is no way forward').toMatch(/If you still cannot do what was asked .* keeps failing or refusing .* and stop\./);
  });

  it('still forbids inventing what could not be obtained', () => {
    expect(ACTING_INTEGRITY_RULE).toMatch(/^- Never present simulated, hypothetical or invented results as real\./);
    expect(ACTING_INTEGRITY_RULE).toContain('do not fill in plausible-looking results');
  });
});

describe('the rule reaches every prompt that can answer the user', () => {
  describe('T3 — the worker that does the work', () => {
    it('carries it whatever tools are registered, including none', () => {
      // Not tool-gated like the image and video rules: a capability with no
      // rule of its own is exactly the one that went unguarded.
      expect(buildWorkerRules(() => false)).toContain(ACTING_INTEGRITY_RULE);
      expect(buildWorkerRules(() => true)).toContain(ACTING_INTEGRITY_RULE);
    });

    it('shows the self-test what each tool returned, so a refused browser cannot pass as a visited one', async () => {
      const { router, calls } = fabricatingRouter();
      await new T3Worker(router, browserRegistry(), 't2-1').execute(assignment(), 'task-refused');

      const graded = calls.find((c) => c.content.startsWith('Self-test this output'));
      expect(graded?.content, 'the refusal is in front of the grader').toContain(`browser_control(action=navigate, url=https://example.test) → Tool error: ${REFUSAL}`);
      expect(graded?.content, 'and it is told what to do with it').toMatch(/"correctness" MUST be "fail" if the output presents simulated/);
    });

    it('keeps secrets the output quotes away from the grader and the critic, which can be other models', async () => {
      const { router, calls } = recordingRouter('Read .env: DB_PASSWORD=hunter2', {
        getReflectionConfig: () => ({ enabled: true, maxRounds: 1 }),
      });
      const result = await new T3Worker(router, noTools(), 't2-1').execute(assignment(), 'task-secret-output');

      const graded = calls.find((c) => c.content.startsWith('Self-test this output'));
      const critic = calls.find((c) => c.content.includes('independent critic'));
      expect(graded?.content).toContain('DB_PASSWORD=[REDACTED_SECRET]');
      expect(graded?.content).not.toContain('hunter2');
      expect(critic?.content).not.toContain('hunter2');
      expect(result.output, 'the deliverable itself is untouched here — T2 redacts at its boundary').toContain('hunter2');
    });

    it('tells the grader which tool really ran when a call fell back to a sibling', async () => {
      // A registry that has no file_remove, so the worker's fallback answers
      // it with file_read — the sibling whose name shares a word.
      const defs: ToolDefinition[] = [
        { name: 'file_remove', description: 'Delete a file', inputSchema: {} },
        { name: 'file_read', description: 'Read a file', inputSchema: {} },
      ];
      const execute = vi.fn(async (name: string) => {
        if (name === 'file_remove') throw new Error('Tool not found: file_remove');
        return 'contents of a.txt';
      });
      const registry = {
        getToolDefinitions: () => defs, requiresApproval: () => false, isDangerous: () => false,
        hasTool: (n: string) => n === 'file_read', execute,
      } as unknown as ToolRegistry;
      let loop = 0;
      const calls: Call[] = [];
      const router = {
        generate: vi.fn(async (tier: string, options: { messages: Array<{ content: unknown }>; systemPrompt?: string }) => {
          const latest = options.messages[options.messages.length - 1];
          const content = typeof latest?.content === 'string' ? latest.content : '';
          calls.push({ tier, systemPrompt: options.systemPrompt ?? '', content });
          if (content.startsWith('Self-test this output')) return makeResult(PASS);
          loop += 1;
          if (loop === 1) return makeResult('', [{ id: 'r1', name: 'file_remove', input: { path: 'a.txt' } }]);
          return makeResult('Deleted a.txt.');
        }),
        getModelForTier: () => undefined,
      } as unknown as CascadeRouter;
      await new T3Worker(router, registry, 't2-1').execute(assignment({ subtaskId: 'rm' }), 'task-fallback');

      const graded = calls.find((c) => c.content.startsWith('Self-test this output'));
      expect(graded?.content).toContain('- file_remove(path=a.txt) [ran as file_read] → [Fallback via file_read]: contents of a.txt');
      expect(graded?.content).toContain('"[ran as X]" means the tool asked for could not run');
    });

    it('does not fail an output whose first call errored and whose retry worked', async () => {
      // The grader was told to fail any claimed action whose call "returned an
      // error", which also caught the retry that went on to succeed.
      const execute = vi.fn()
        .mockRejectedValueOnce(new Error(REFUSAL))
        .mockResolvedValueOnce('navigated to https://example.test');
      let loop = 0;
      const calls: Call[] = [];
      const router = {
        generate: vi.fn(async (tier: string, options: { messages: Array<{ content: unknown }>; systemPrompt?: string }) => {
          const latest = options.messages[options.messages.length - 1];
          const content = typeof latest?.content === 'string' ? latest.content : '';
          calls.push({ tier, systemPrompt: options.systemPrompt ?? '', content });
          if (content.startsWith('Self-test this output')) return makeResult(PASS);
          loop += 1;
          if (loop <= 2) return makeResult('', [{ id: `b${loop}`, name: 'browser_control', input: { action: 'navigate', url: 'https://example.test' } }]);
          return makeResult('Opened https://example.test.');
        }),
        getModelForTier: () => undefined,
      } as unknown as CascadeRouter;
      await new T3Worker(router, browserRegistry(execute), 't2-1').execute(assignment(), 'task-retried');

      const graded = calls.find((c) => c.content.startsWith('Self-test this output'))?.content ?? '';
      expect(graded, 'both attempts are in the record').toContain(`browser_control(action=navigate, url=https://example.test) → Tool error: ${REFUSAL}`);
      expect(graded).toContain('browser_control(action=navigate, url=https://example.test) → navigated to https://example.test');
      expect(graded, 'and a retry that succeeded is said to count').toContain('a later retry that succeeded did');
      expect(graded).not.toContain('did not perform or that returned an error');
    });

    it('does not hold a tool\u2019s whole result for the life of the worker', async () => {
      const execute = vi.fn().mockResolvedValue(`PAGE ${'x'.repeat(500_000)}`);
      const worker = new T3Worker(fabricatingRouter().router, browserRegistry(execute), 't2-1');
      await worker.execute(assignment(), 'task-big');
      const record = (worker as unknown as { toolRecord: Array<{ result: string; evidence?: string }> }).toolRecord;
      expect(record).toHaveLength(1);
      expect(record[0]!.result.length).toBeLessThanOrEqual(161);
      expect(record[0]!.evidence?.length, 'no more than the model was shown').toBeLessThanOrEqual(12_000);
    });

    it('lets the self-test see the part of a long page the answer was taken from', async () => {
      // The answer is on the page, 2,000 characters in. The grader used to see
      // the first 160, and a true answer read the same as an invented one.
      const page = `Chat widget loaded. ${'Welcome to our help centre. '.repeat(70)}The assistant replied: our refund window is 45 days.`;
      const calls: Call[] = [];
      let loop = 0;
      const router = {
        generate: vi.fn(async (tier: string, options: { messages: Array<{ content: unknown }>; systemPrompt?: string }) => {
          const latest = options.messages[options.messages.length - 1];
          const content = typeof latest?.content === 'string' ? latest.content : '';
          calls.push({ tier, systemPrompt: options.systemPrompt ?? '', content });
          if (content.startsWith('Self-test this output')) return makeResult(PASS);
          loop += 1;
          if (loop === 1) return makeResult('', [{ id: 'b1', name: 'browser_control', input: { action: 'extract' } }]);
          return makeResult('The assistant replied that the refund window is 45 days.');
        }),
        getModelForTier: () => undefined,
      } as unknown as CascadeRouter;
      await new T3Worker(router, browserRegistry(vi.fn().mockResolvedValue(page)), 't2-1').execute(assignment(), 'task-long');

      const graded = calls.find((c) => c.content.startsWith('Self-test this output'))?.content ?? '';
      expect(graded).toMatch(/- browser_control\(action=extract\): ".*our refund window is 45 days\."/);
      expect(graded, 'and the grader is told what the passages are').toContain('the passages are the parts of the results');
    });

    it('shows the self-test what the subtasks it depends on did, which its own record cannot', async () => {
      // A summary of a dependency that visited the site reads as a claimed
      // visit with no call behind it: that subtask's calls are in ITS record.
      const bus = new PeerBus();
      bus.publish('t3-visit', 'visit', 'Opened https://shop.test with browser control. The chatbot answered "Yes".', 'COMPLETED');
      const { router, calls } = recordingRouter('The site was visited and the chatbot answered "Yes".');
      const worker = new T3Worker(router, noTools(), 't2-1');
      worker.setPeerBus(bus);
      await worker.execute(assignment({ subtaskId: 'summary', dependsOn: ['visit'] }), 'task-dep');

      const graded = calls.find((c) => c.content.startsWith('Self-test this output'))?.content ?? '';
      expect(graded).toContain('Work handed to this subtask by the subtasks it depends on, which made their own tool calls:\n- visit: Opened https://shop.test with browser control. The chatbot answered "Yes".');
      expect(graded).toContain('An action or result that the handed work above reports is supported too');
      expect(graded, 'its own record is still its own').toContain('none — no tool was called');

      // The next subtask this worker takes was handed nothing.
      calls.length = 0;
      await worker.execute(assignment({ subtaskId: 'other' }), 'task-next');
      const next = calls.find((c) => c.content.startsWith('Self-test this output'))?.content ?? '';
      expect(next).not.toContain('Work handed to this subtask');
      expect(next).not.toContain('handed work above');
    });

    it('tells the self-test when nothing was called at all', async () => {
      // The reported shape: no browser to reach, and a login claimed anyway.
      const { router, calls } = recordingRouter('I logged in and asked the chatbot.');
      await new T3Worker(router, noTools(), 't2-1').execute(assignment(), 'task-none');

      const graded = calls.find((c) => c.content.startsWith('Self-test this output'));
      expect(graded?.content).toContain('none — no tool was called');
    });

    it('keeps the record for one subtask only — a reused worker does not inherit the last one’s calls', async () => {
      const execute = vi.fn()
        .mockRejectedValueOnce(new Error(REFUSAL))
        .mockResolvedValueOnce('navigated to https://example.test');
      const worker = new T3Worker(fabricatingRouter().router, browserRegistry(execute), 't2-1');
      await worker.execute(assignment(), 'task-1');

      const second = fabricatingRouter();
      (worker as unknown as { router: CascadeRouter }).router = second.router;
      await worker.execute(assignment({ subtaskId: 'probe-2' }), 'task-2');

      const graded = second.calls.find((c) => c.content.startsWith('Self-test this output'));
      expect(graded?.content).toContain('browser_control(action=navigate, url=https://example.test) → navigated to https://example.test');
      expect(graded?.content, 'the first subtask’s refusal is not this one’s').not.toContain(REFUSAL);
    });

    it('carries it into the correction round, which replaces the worker’s own system prompt', async () => {
      // The round that exists to make a failed check pass is where covering a
      // gap is most tempting — and it ran with none of the worker's rules.
      const { router, calls } = fabricatingRouter({
        selfTest: () => '{"completeness":"pass","correctness":"fail","compliance":"pass","notes":"claims a login no tool performed"}',
      });
      await new T3Worker(router, browserRegistry(), 't2-1').execute(assignment(), 'task-correct');

      const correction = calls.find((c) => c.content.startsWith('The following output failed these checks'));
      expect(correction, 'a correction round ran').toBeDefined();
      expect(correction?.systemPrompt).toContain(ACTING_INTEGRITY_RULE);
      expect(correction?.content, 'and the ask itself allows "I could not"').toContain('never invent the missing result');
      expect(correction?.content, 'once the tool keeps failing, not at its first error').toContain('keeps failing or refusing');
    });

    it('grades the rewrite against the tool record, and keeps the verified output when it fails', async () => {
      // The rewrite ran after the self-test and went straight to COMPLETED:
      // filling the critic's gap with results it never obtained was checked
      // by nothing.
      const { router, calls } = fabricatingRouter({
        reflection: true,
        selfTest: (prompt) => prompt.includes('Output to test:\nImproved output')
          ? '{"completeness":"pass","correctness":"fail","compliance":"pass","notes":"answers no tool obtained"}'
          : PASS,
      });
      const result = await new T3Worker(router, browserRegistry(), 't2-1').execute(assignment(), 'task-reflect-graded');

      const graded = calls.filter((c) => c.content.startsWith('Self-test this output'));
      expect(graded.map((c) => c.content.includes('Output to test:\nImproved output'))).toEqual([false, true]);
      expect(graded[1]?.content).toContain(`→ Tool error: ${REFUSAL}`);
      expect(result.status).toBe('COMPLETED');
      expect(result.output, 'the output that passed').not.toBe('Improved output');
      expect(result.issues.join(' ')).toContain('Reflection\'s revision failed the self-test (correctness)');
    });

    it('uses the rewrite when it passes the same test', async () => {
      const { router } = fabricatingRouter({ reflection: true });
      const result = await new T3Worker(router, browserRegistry(), 't2-1').execute(assignment(), 'task-reflect-passed');
      expect(result.output).toBe('Improved output');
    });

    it('carries it into the tool-less rewrite, which can only close a gap in real work by inventing it', async () => {
      const { router, calls } = fabricatingRouter({ reflection: true });
      await new T3Worker(router, browserRegistry(), 't2-1').execute(assignment(), 'task-reflect');

      const rewrite = calls.find((c) => c.content.startsWith('Improve the following'));
      expect(rewrite, 'the rewrite ran').toBeDefined();
      expect(rewrite?.systemPrompt).toContain(ACTING_INTEGRITY_RULE);
      expect(rewrite?.content).toContain('You have no tools in this step');
    });
  });

  it('T2 — the section summary, which on a Moderate run is the answer', async () => {
    const { router, calls } = recordingRouter('worker output');
    await new T2Manager(router, noTools(), 't1-root').execute({
      sectionId: 's1', sectionTitle: 'Probe', description: 'Probe the chatbot', expectedOutput: 'answers',
      constraints: [], t3Subtasks: [{
        subtaskId: 'a', subtaskTitle: 'Ask', description: 'Ask', expectedOutput: 'answers', constraints: [], peerT3Ids: [], dependsOn: [],
      }],
    }, 'task-t2');

    const summary = calls.find((c) => c.content.startsWith('Summarize these T3 worker outputs'));
    expect(summary, 'the section was summarised').toBeDefined();
    expect(summary?.systemPrompt).toContain(REPORTING_INTEGRITY_RULE);
  });

  it('T2 — is shown the workers that did not finish, so a partial section cannot read as complete', async () => {
    // Failed workers were filtered out before the prompt was built: one of
    // two workers failing left a summary of the other alone, and the section
    // — PARTIAL, whose output adds no note of its own — looked finished.
    const { router, calls } = recordingRouter('summary');
    const t2 = new T2Manager(router, noTools(), 't1-root');
    const worker = (subtaskId: string, status: T2Result['t3Results'][number]['status'], output: string, issues: string[]) => ({
      subtaskId, status, output, issues, testResults: { checksRun: [], passed: [], failed: [] }, peerSyncsUsed: [], correctionAttempts: 0,
    });
    const aggregate = (results: T2Result['t3Results'], fail = false) => {
      if (fail) (router.generate as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('provider down'));
      return (t2 as unknown as { aggregateResults: (a: unknown, r: T2Result['t3Results'], o: object) => Promise<string> })
        .aggregateResults({ sectionTitle: 'Probe' }, results, {});
    };
    const results = [
      worker('ask-site', 'COMPLETED', 'The site answered "Yes".', []),
      worker('ask-follow-up', 'FAILED', '', [`Tool error: ${REFUSAL}`]),
    ];

    await aggregate(results);
    const summary = calls.find((c) => c.content.startsWith('Summarize these T3 worker outputs'));
    expect(summary?.content).toContain('NOT COMPLETED');
    expect(summary?.content).toContain(`[ask-follow-up — FAILED]: Tool error: ${REFUSAL}`);

    // And when the summary call itself fails, the raw fallback keeps it too.
    expect(await aggregate(results, true)).toContain(`[ask-follow-up — FAILED]: Tool error: ${REFUSAL}`);
  });

  it('T1 — the final compile, which on a Complex run is the answer', async () => {
    const { router, calls } = recordingRouter('compiled');
    const admin = new T1Administrator(router, {} as ToolRegistry, {} as CascadeConfig);
    await (admin as unknown as { compileFinalOutput: (p: string, plan: TaskPlan, r: T2Result[]) => Promise<string> })
      .compileFinalOutput('probe the chatbot', { complexity: 'Complex', sections: [], reasoning: '' }, [{
        sectionId: 's1', sectionTitle: 'Probe', status: 'COMPLETED', sectionSummary: 'done',
        t3Results: [], issues: [],
      } as T2Result]);

    const compile = calls.find((c) => c.content.startsWith('Compile a final, coherent response'));
    expect(compile, 'the compile ran').toBeDefined();
    expect(compile?.systemPrompt).toContain(REPORTING_INTEGRITY_RULE);
  });
});
