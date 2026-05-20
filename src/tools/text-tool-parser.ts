// ─────────────────────────────────────────────
//  Cascade AI — Text Tool Call Parser
// ─────────────────────────────────────────────
//
//  Parses ReAct-style tool invocations from LLM text output.
//  Used when the model does not support native tool-use (e.g. Ollama).
//
//  Format:
//    <tool_call>
//    {"name": "shell", "input": {"command": "ls -la"}}
//    </tool_call>
//

import type { ToolCall } from '../types.js';

const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
// Pattern B: ```json {...} ``` blocks containing a tool-call shaped object
const JSON_BLOCK_RE = /```json\s*([\s\S]*?)\s*```/g;
// Pattern C: inline {"function": {"name": "...", "arguments": {...}}} objects (OpenAI echo format)
const FUNCTION_OBJ_RE = /\{\s*"function"\s*:\s*\{[^}]*"name"\s*:[^}]*\}\s*\}/g;

export interface ParsedTextToolCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Extract tool calls from a text response.
 *
 * Tries three strategies in priority order, stopping at the first that yields results:
 *   1. <tool_call>…</tool_call> XML blocks (primary format)
 *   2. ```json … ``` code blocks containing a {name, input} object
 *   3. {"function": {"name": "…", "arguments": {…}}} inline objects (OpenAI echo format)
 */
export function parseTextToolCalls(text: string): ParsedTextToolCall[] {
  const results = tryXmlBlocks(text);
  if (results.length > 0) return results;

  const jsonBlockResults = tryJsonCodeBlocks(text);
  if (jsonBlockResults.length > 0) return jsonBlockResults;

  return tryFunctionCallObjects(text);
}

function tryXmlBlocks(text: string): ParsedTextToolCall[] {
  const results: ParsedTextToolCall[] = [];
  let match: RegExpExecArray | null;
  TOOL_CALL_RE.lastIndex = 0;

  while ((match = TOOL_CALL_RE.exec(text)) !== null) {
    try {
      const raw = JSON.parse(match[1]!) as { name?: unknown; input?: unknown };
      if (typeof raw.name !== 'string') continue;
      const input = typeof raw.input === 'object' && raw.input !== null
        ? raw.input as Record<string, unknown>
        : {};
      results.push({ name: raw.name, input });
    } catch {
      // Skip malformed block
    }
  }
  return results;
}

function tryJsonCodeBlocks(text: string): ParsedTextToolCall[] {
  const results: ParsedTextToolCall[] = [];
  let match: RegExpExecArray | null;
  JSON_BLOCK_RE.lastIndex = 0;

  while ((match = JSON_BLOCK_RE.exec(text)) !== null) {
    try {
      const raw = JSON.parse(match[1]!) as { name?: unknown; input?: unknown };
      if (typeof raw.name !== 'string') continue;
      const input = typeof raw.input === 'object' && raw.input !== null
        ? raw.input as Record<string, unknown>
        : {};
      results.push({ name: raw.name, input });
    } catch {
      // Skip malformed block
    }
  }
  return results;
}

function tryFunctionCallObjects(text: string): ParsedTextToolCall[] {
  const results: ParsedTextToolCall[] = [];
  let match: RegExpExecArray | null;
  FUNCTION_OBJ_RE.lastIndex = 0;

  while ((match = FUNCTION_OBJ_RE.exec(text)) !== null) {
    try {
      const raw = JSON.parse(match[0]!) as {
        function?: { name?: unknown; arguments?: unknown }
      };
      const fn = raw.function;
      if (!fn || typeof fn.name !== 'string') continue;
      const input = typeof fn.arguments === 'object' && fn.arguments !== null
        ? fn.arguments as Record<string, unknown>
        : {};
      results.push({ name: fn.name, input });
    } catch {
      // Skip malformed object
    }
  }
  return results;
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

/**
 * Build the system-prompt appendix that teaches a non-tool-capable model
 * how to invoke tools via text.
 */
export function buildTextToolSystemPrompt(tools: Array<{ name: string; description: string; inputSchema?: { properties?: Record<string, { description?: string }> } }>): string {
  const toolDefs = tools.map(t => {
    const props = t.inputSchema?.properties ?? {};
    const paramLines = Object.entries(props)
      .map(([k, v]) => `    "${k}": "<${v.description ?? k}>"`);
    return `• ${t.name}: ${t.description}
  Input: {${paramLines.length ? '\n' + paramLines.join(',\n') + '\n  ' : ''}}`;
  }).join('\n');

  return `
TOOL USE INSTRUCTIONS:
You do not have native tool-use capability. To call a tool, write a <tool_call> block:

<tool_call>
{"name": "<tool_name>", "input": {<parameters>}}
</tool_call>

Available tools:
${toolDefs}

EXAMPLE — calling the "shell" tool to list files:
<tool_call>
{"name": "shell", "input": {"command": "ls -la /workspace"}}
</tool_call>

You will then receive a user message with the result, then continue your work.
Only call one tool at a time. When you have enough information, provide your final answer.`;
}
