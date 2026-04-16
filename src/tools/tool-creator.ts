// ─────────────────────────────────────────────
//  Cascade AI — Runtime Tool Creator (opt-in)
// ─────────────────────────────────────────────
//
//  Allows Cascade to generate and register new tools at runtime when no
//  existing tool can handle a required operation.
//
//  SAFETY:
//  - Requires `enableToolCreation: true` in config (off by default)
//  - Generated code runs in node:vm with a restricted sandbox context
//  - HTTP (fetch) calls are allowed but gated by the approval workflow
//  - Tools are session-scoped and not persisted
//

import { createContext, runInContext } from 'node:vm';
import { BaseTool } from './base.js';
import type { ToolExecuteOptions } from '../types.js';
import type { ToolRegistry } from './registry.js';
import type { CascadeRouter } from '../core/router/index.js';

// ── Generated tool schema ──────────────────────

interface GeneratedToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Raw JS function body — receives `input` and `fetch`, returns string | Promise<string> */
  executeCode: string;
  isDangerous: boolean;
}

// ── Dynamic tool class factory ─────────────────

class DynamicTool extends BaseTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  private executeCode: string;
  private _isDangerous: boolean;

  constructor(spec: GeneratedToolSpec) {
    super();
    this.name = spec.name;
    this.description = spec.description;
    this.inputSchema = spec.inputSchema;
    this.executeCode = spec.executeCode;
    this._isDangerous = spec.isDangerous;
  }

  isDangerous(): boolean {
    return this._isDangerous;
  }

  async execute(input: Record<string, unknown>, _options: ToolExecuteOptions): Promise<string> {
    // Sandbox: expose only fetch and basic globals — no require, no fs, no process
    const sandbox: Record<string, unknown> = {
      input,
      fetch: globalThis.fetch,
      JSON,
      Math,
      Date,
      console: { log: () => {}, error: () => {} }, // Silenced
      setTimeout,
      clearTimeout,
      Promise,
      Error,
      String,
      Number,
      Boolean,
      Array,
      Object,
      result: undefined as string | undefined,
    };

    const context = createContext(sandbox);
    const wrapped = `(async () => { ${this.executeCode} })().then(r => { result = String(r ?? ''); }).catch(e => { result = 'Tool error: ' + e.message; });`;

    try {
      const promise = runInContext(wrapped, context, {
        timeout: 15_000,
        breakOnSigint: true,
        filename: `dynamic_tool_${this.name}.js`,
        displayErrors: true,
      });
      await promise;
      return (sandbox['result'] as string | undefined) ?? '';
    } catch (err) {
      return `Dynamic tool error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

// ── ToolCreator class ──────────────────────────

const TOOL_CREATOR_PROMPT = `You are a tool-generation assistant for the Cascade AI system.
Generate a minimal, safe JavaScript tool function for the described operation.

Rules:
- Return ONLY a JSON object with these fields: name, description, inputSchema, executeCode, isDangerous
- executeCode is a self-contained JavaScript function body that:
  - Receives: input (object), fetch (if HTTP needed)
  - Returns: a string result
  - Uses no require(), no fs, no process — only fetch, JSON, Math, Date, String, Number, Array, Object
  - Must complete in under 15 seconds
- isDangerous should be true only if the tool makes write operations or external HTTP calls
- name must be snake_case, start with "dynamic_", max 40 chars
- description must be ≤ 120 chars

Example executeCode for an HTTP tool:
"const res = await fetch(input.url); const text = await res.text(); return text.slice(0, 2000);"

Return ONLY valid JSON — no other text.`;

export class ToolCreator {
  private router: CascadeRouter;
  private registry: ToolRegistry;
  private createdTools: Set<string> = new Set();

  constructor(router: CascadeRouter, registry: ToolRegistry) {
    this.router = router;
    this.registry = registry;
  }

  /**
   * Generate a new tool from a description and register it with the ToolRegistry.
   * Returns the tool name if successful, null if generation failed.
   */
  async createTool(description: string, context: string): Promise<string | null> {
    const prompt = `${TOOL_CREATOR_PROMPT}

Task context: ${context.slice(0, 200)}
Required capability: ${description.slice(0, 300)}`;

    try {
      const result = await this.router.generate('T3', {
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 600,
      });

      const jsonMatch = /\{[\s\S]*\}/.exec(result.content);
      if (!jsonMatch) {
        return null;
      }

      const spec = JSON.parse(jsonMatch[0]) as GeneratedToolSpec;

      // Validate required fields
      if (!spec.name || !spec.description || !spec.executeCode || !spec.inputSchema) {
        return null;
      }

      // Ensure unique name in this session
      if (this.createdTools.has(spec.name) || this.registry.hasTool(spec.name)) {
        spec.name = `${spec.name}_${Date.now() % 10000}`;
      }

      // Validate the generated code compiles (non-executing check)
      try {
        createContext({ input: {}, fetch: globalThis.fetch });
        // Syntax check only — don't execute
        new Function('input', 'fetch', spec.executeCode);
      } catch (err) {
        return null;
      }

      const tool = new DynamicTool(spec);
      this.registry.register(tool);
      this.createdTools.add(spec.name);

      return spec.name;
    } catch {
      return null;
    }
  }

  /**
   * Returns the names of all tools created in this session.
   */
  getCreatedTools(): string[] {
    return Array.from(this.createdTools);
  }
}
