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

export interface ParsedTextToolCall {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Extract all <tool_call>…</tool_call> blocks from a text response.
 * Gracefully ignores malformed JSON blocks.
 */
export function parseTextToolCalls(text: string): ParsedTextToolCall[] {
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

After a tool is called, you will receive the result as a user message and should continue.
Only call one tool at a time. When you have enough information, provide your final answer.`;
}
