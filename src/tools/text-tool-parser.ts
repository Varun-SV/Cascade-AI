// ─────────────────────────────────────────────
//  Cascade AI — Text Tool Call Parser
// ─────────────────────────────────────────────
//
//  Parses ReAct-style tool invocations from LLM text output.
//  Used when the model does not support native tool-use (e.g. many Ollama
//  models). Deliberately tolerant: weaker models rarely emit the exact format,
//  so we accept <tool_call> blocks, fenced JSON, OpenAI-style {function:{…}}
//  echoes, and bare {name, input|arguments} objects anywhere in the text.
//
//  Format we teach:
//    <tool_call>
//    {"name": "shell", "input": {"command": "ls -la"}}
//    </tool_call>
//

import type { ToolCall } from '../types.js';
import { parseModelJson } from '../utils/json-extract.js';

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
// Fenced code blocks: ```json / ```tool_call / ``` … ``` containing a call object
const JSON_BLOCK_RE = /```(?:json|tool_call|tool)?\s*([\s\S]*?)```/g;

export interface ParsedTextToolCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * The calls written in a dedicated call format, in order. A block's end is
 * looked for outside its JSON strings, so a call whose argument shows an
 * example `</tool_call>` is not cut short, and nothing inside one block is
 * taken for another.
 */
function callSpans(text: string): Array<{ start: number; end: number; text: string }> {
  const spans: Array<{ start: number; end: number; text: string }> = [];
  const OPENERS = /<tool_call>|<function=[\w.-]+>|\[TOOL_CALLS\]|<\|python_tag\|>/g;
  let m: RegExpExecArray | null;
  while ((m = OPENERS.exec(text))) {
    const start = m.index;
    const tag = m[0];
    let end: number;
    if (tag === '[TOOL_CALLS]' || tag === '<|python_tag|>') {
      end = text.length;
    } else {
      const closer = tag === '<tool_call>' ? '</tool_call>' : '</function>';
      const at = indexOutsideStrings(text, closer, start + tag.length);
      if (at === -1) continue;
      end = at + closer.length;
    }
    spans.push({ start, end, text: text.slice(start, end) });
    OPENERS.lastIndex = end;
  }
  return spans;
}

/**
 * The call(s) in one call block, read from that block's own content only, so
 * an example inside its arguments is never parsed as a call of its own.
 */
function parseSpan(span: string): ParsedTextToolCall[] {
  const tc = /^<tool_call>([\s\S]*)<\/tool_call>$/.exec(span);
  if (tc) { const c = coerceCall(parseJsonLoose(tc[1]!.trim())); return c ? [c] : []; }
  const fn = /^<function=([\w.-]+)>([\s\S]*)<\/function>$/.exec(span);
  if (fn) {
    const args = fn[2]!.trim() ? parseJsonLoose(fn[2]!.trim()) : {};
    return [{ name: fn[1]!, input: args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {} }];
  }
  if (span.startsWith('[TOOL_CALLS]')) return mistralCalls(span);
  if (span.startsWith('<|python_tag|>')) {
    const rest = span.slice('<|python_tag|>'.length).trim();
    const end = rest.startsWith('{') ? jsonObjectEnd(rest) : -1;
    const c = end === -1 ? null : coerceCall(parseJsonLoose(rest.slice(0, end + 1)));
    return c ? [c] : [];
  }
  return [];
}

/** Index of `needle` at or after `from`, not inside a double-quoted JSON string; -1 if none. */
function indexOutsideStrings(text: string, needle: string, from: number): number {
  let inString = false;
  let escape = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (text.startsWith(needle, i)) return i;
  }
  return -1;
}

/** Where the object opening `text` closes, string-aware; -1 if it never does. */
function jsonObjectEnd(text: string): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/** [start, end) of each fenced code block (an unclosed one runs to the end) and each inline code span. */
function codeRegions(text: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  let rest = text;
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)/g)) {
    regions.push([m.index!, m.index! + m[0].length]);
    rest = rest.slice(0, m.index!) + ' '.repeat(m[0].length) + rest.slice(m.index! + m[0].length);
  }
  for (const m of rest.matchAll(/`[^`\n]*`/g)) regions.push([m.index!, m.index! + m[0].length]);
  return regions;
}

/**
 * Tool calls a model wrote as text although it was handed native tools.
 *
 * Stricter than `parseTextToolCalls`, because here an answer that merely
 * mentions a call must not be taken for one: the call has to be in one of the
 * dedicated call formats (`<tool_call>`, `<function=…>`, `[TOOL_CALLS]`,
 * `<|python_tag|>`), or the reply has to open with it, and it has to name a
 * tool this worker actually has. A call inside a code block or inline code is
 * an example being shown, not a call — unless the whole reply is that one
 * fenced block, which is how some models send a call.
 */
export function strayTextToolCalls(
  text: string,
  tools: ReadonlyArray<{ name: string }>,
): ParsedTextToolCall[] {
  if (!text) return [];
  const trimmed = text.trim();
  const whole = /^```[\w-]*[ \t]*\n([\s\S]*?)\n?[ \t]*```$/.exec(trimmed);
  if (whole && !whole[1]!.includes('```')) return strayTextToolCalls(whole[1]!, tools);
  // The call blocks are found first, and code blocks are looked for only in
  // the text around them, so backticks inside a call's own arguments (a file
  // it writes, a command it runs) are never mistaken for a code block. A call
  // block that starts inside a code block or inline code is an example.
  // A reply that opens with a call object is that call, whatever its string
  // values say: a file it writes may show a <tool_call> example.
  if (trimmed.startsWith('{')) {
    const end = jsonObjectEnd(trimmed);
    const one = end === -1 ? null : coerceCall(parseJsonLoose(trimmed.slice(0, end + 1)));
    const lead = one ? [one] : [];
    if (lead.length > 0) {
      const names = new Set(tools.map((t) => t.name));
      return lead.every((c) => names.has(c.name)) ? lead : [];
    }
  }
  const spans = callSpans(trimmed);
  let around = trimmed;
  for (const { start, end } of spans) around = around.slice(0, start) + ' '.repeat(end - start) + around.slice(end);
  const quoted = codeRegions(around);
  const live = spans.filter(({ start }) => !quoted.some(([a, b]) => start >= a && start < b));
  // Each accepted call is parsed from the reply as written, never from a
  // copy with anything taken out.
  const calls = live.length > 0
    ? live.flatMap((sp) => parseSpan(sp.text))
    : trimmed.startsWith('{') ? parseTextToolCalls(trimmed) : [];
  const names = new Set(tools.map((t) => t.name));
  return calls.length > 0 && calls.every((c) => names.has(c.name)) ? calls : [];
}

/**
 * Extract tool calls from a text response. Tries progressively looser
 * strategies, stopping at the first that yields results:
 *   1. <tool_call>…</tool_call> blocks (the taught format)
 *   2. ```json|tool_call``` fenced blocks
 *   3. bare {name, input|arguments} (or {function:{…}}) objects anywhere in text
 */
export function parseTextToolCalls(text: string): ParsedTextToolCall[] {
  // Calls in a dedicated format are read block by block, each from its own
  // content, so an example inside one call's arguments is never a call.
  const blocks = callSpans(text).flatMap((sp) => parseSpan(sp.text));
  if (blocks.length > 0) return blocks;

  const xml = collect(text, TOOL_CALL_RE);
  if (xml.length > 0) return xml;

  const fns = functionTags(text);
  if (fns.length > 0) return fns;

  const mistral = mistralCalls(text);
  if (mistral.length > 0) return mistral;

  const fenced = collect(text, JSON_BLOCK_RE);
  if (fenced.length > 0) return fenced;

  return tryBareObjects(text);
}

/** Run a capturing regex over the text and coerce each captured group into a call. */
function collect(text: string, re: RegExp): ParsedTextToolCall[] {
  const results: ParsedTextToolCall[] = [];
  let match: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((match = re.exec(text)) !== null) {
    const body = (match[1] ?? '').trim();
    const parsed = parseJsonLoose(body);
    const call = coerceCall(parsed);
    if (call) results.push(call);
  }
  return results;
}

/**
 * Scan the text for balanced {…} objects that look like a tool call and parse
 * them. Brace matching is string-aware so quoted braces don't confuse depth.
 */
function tryBareObjects(text: string): ParsedTextToolCall[] {
  const results: ParsedTextToolCall[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end === -1) break;
    const candidate = text.slice(i, end + 1);
    // Accept both double- and single-quoted keys; parseJsonLoose normalises the
    // latter before parsing.
    if (/['"]name['"]\s*:/.test(candidate) && /['"](?:input|arguments|parameters)['"]\s*:/.test(candidate)) {
      const call = coerceCall(parseJsonLoose(candidate));
      if (call) results.push(call);
    }
    i = end;
  }
  return results;
}

/** `<function=name>{…}</function>`, the format of Llama 3.1's and some Qwen templates. */
function functionTags(text: string): ParsedTextToolCall[] {
  const out: ParsedTextToolCall[] = [];
  for (const m of text.matchAll(/<function=([\w.-]+)>\s*([\s\S]*?)\s*<\/function>/g)) {
    const parsed = m[2] ? parseJsonLoose(m[2]) : {};
    out.push({ name: m[1]!, input: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} });
  }
  return out;
}

/** `[TOOL_CALLS] [{"name": …, "arguments": {…}}]`, Mistral's format. */
function mistralCalls(text: string): ParsedTextToolCall[] {
  const at = text.indexOf('[TOOL_CALLS]');
  if (at === -1) return [];
  const list = parseModelJson<unknown[]>(text.slice(at + '[TOOL_CALLS]'.length), 'array') ?? [];
  return list.map(coerceCall).filter((c): c is ParsedTextToolCall => c !== null);
}

/** Parse JSON, retrying once with single-quotes normalised to double-quotes. */
function parseJsonLoose(raw: string): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Some models emit single-quoted JSON; normalise quotes that aren't already
    // inside a double-quoted string and retry. Best-effort only.
    try {
      return JSON.parse(raw.replace(/'/g, '"'));
    } catch {
      return null;
    }
  }
}

/**
 * Normalise the many shapes weak models emit into {name, input}:
 *   {name, input}             {name, arguments}        {function:{name, arguments}}
 * `arguments` may itself be a JSON string.
 */
function coerceCall(raw: unknown): ParsedTextToolCall | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const fn = obj.function && typeof obj.function === 'object'
    ? obj.function as Record<string, unknown>
    : null;

  const name = typeof obj.name === 'string'
    ? obj.name
    : fn && typeof fn.name === 'string' ? fn.name : null;
  if (!name) return null;

  // `parameters` is Llama 3's name for them.
  const rawInput = obj.input ?? obj.arguments ?? obj.parameters
    ?? (fn ? (fn.input ?? fn.arguments ?? fn.parameters) : undefined);
  let input: Record<string, unknown> = {};
  if (rawInput && typeof rawInput === 'object') {
    input = rawInput as Record<string, unknown>;
  } else if (typeof rawInput === 'string') {
    const parsed = parseJsonLoose(rawInput);
    if (parsed && typeof parsed === 'object') input = parsed as Record<string, unknown>;
  }
  return { name, input };
}

/**
 * Convert a ParsedTextToolCall to a ToolCall with a generated id.
 */
export function toToolCall(parsed: ParsedTextToolCall, index: number): ToolCall {
  return {
    id: `text-tool-${Date.now()}-${index}`,
    name: parsed.name,
    input: parsed.input,
  };
}

interface SchemaProp {
  type?: unknown;
  description?: unknown;
  enum?: unknown;
}

/**
 * Build the system-prompt appendix that teaches a non-tool-capable model how to
 * invoke tools via text. Unlike the previous version this carries the FULL
 * parameter contract — types, required-ness, and enum values — so the model
 * emits valid arguments instead of guessing from a description alone.
 */
export function buildTextToolSystemPrompt(
  tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>,
): string {
  const toolDefs = tools.map(t => {
    const schema = (t.inputSchema ?? {}) as { properties?: unknown; required?: unknown };
    const props = (schema.properties && typeof schema.properties === 'object'
      ? schema.properties as Record<string, SchemaProp>
      : {});
    const required = Array.isArray(schema.required) ? schema.required as string[] : [];
    const paramLines = Object.entries(props).map(([k, v]) => {
      const type = typeof v.type === 'string' ? v.type : 'any';
      const desc = typeof v.description === 'string' ? v.description : k;
      const req = required.includes(k) ? ' [required]' : '';
      const enumVals = Array.isArray(v.enum)
        ? ` (one of: ${(v.enum as unknown[]).map(e => JSON.stringify(e)).join(', ')})`
        : '';
      return `    - ${k} (${type})${req}: ${desc}${enumVals}`;
    });
    return `• ${t.name} — ${t.description}${paramLines.length ? '\n' + paramLines.join('\n') : '\n    (no parameters)'}`;
  }).join('\n');

  return `
TOOL USE INSTRUCTIONS:
You do not have native tool-use capability. To call a tool, output a single <tool_call> block containing JSON with the tool name and its input arguments:

<tool_call>
{"name": "<tool_name>", "input": { ...arguments... }}
</tool_call>

Rules:
- Use exactly the parameter names shown below and include every [required] parameter.
- For parameters that list "one of", use one of those values verbatim.
- Emit valid JSON with double quotes. Call only ONE tool at a time, then wait for the result.

Available tools:
${toolDefs}

EXAMPLE — calling the "shell" tool to list files:
<tool_call>
{"name": "shell", "input": {"command": "ls -la"}}
</tool_call>

When you have enough information, stop calling tools and write your final answer.`;
}

/**
 * Terse follow-up appendix for iterations AFTER the first. Re-sending the full
 * per-parameter contract on every agent-loop turn (up to 15) wastes a large,
 * repeated block of tokens on models that are typically small/local to begin
 * with. By turn two the conversation history already contains the model's own
 * well-formed <tool_call> examples, so a name list + format skeleton suffices.
 */
export function buildTextToolReminder(
  tools: Array<{ name: string }>,
): string {
  return `
TOOL USE REMINDER:
Call tools with a single <tool_call>{"name": "<tool_name>", "input": { ... }}</tool_call> block (valid JSON, double quotes, one tool per turn), matching the argument shapes of your earlier calls in this conversation.
Available tools: ${tools.map(t => t.name).join(', ')}.
When you have enough information, stop calling tools and write your final answer.`;
}
