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

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
// Fenced code blocks: ```json / ```tool_call / ``` … ``` containing a call object
const JSON_BLOCK_RE = /```(?:json|tool_call|tool)?\s*([\s\S]*?)```/g;

export interface ParsedTextToolCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Extract tool calls from a text response. Tries progressively looser
 * strategies, stopping at the first that yields results:
 *   1. <tool_call>…</tool_call> blocks (the taught format)
 *   2. ```json|tool_call``` fenced blocks
 *   3. bare {name, input|arguments} (or {function:{…}}) objects anywhere in text
 */
export function parseTextToolCalls(text: string): ParsedTextToolCall[] {
  const xml = collect(text, TOOL_CALL_RE);
  if (xml.length > 0) return xml;

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
    if (/['"]name['"]\s*:/.test(candidate) && /['"](?:input|arguments)['"]\s*:/.test(candidate)) {
      const call = coerceCall(parseJsonLoose(candidate));
      if (call) results.push(call);
    }
    i = end;
  }
  return results;
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

  const rawInput = obj.input ?? obj.arguments ?? (fn ? (fn.input ?? fn.arguments) : undefined);
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
