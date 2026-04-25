// ─────────────────────────────────────────────
//  Cascade AI — Runtime Tool Creator (opt-in)
// ─────────────────────────────────────────────
//
//  Allows Cascade to generate and register new tools at runtime when no
//  existing tool can handle a required operation.
//
//  SAFETY:
//  - Requires `enableToolCreation: true` in config (on by default)
//  - Generated tools run in node:vm with a restricted sandbox
//  - Generated tools CAN call existing registered cascade tools via callTool()
//  - Dangerous tool access requires approval via the PermissionEscalator chain
//    (T3 → T2 → T1 → user) before execution
//  - Tools are session-scoped and not persisted
//

import { createContext, runInContext } from 'node:vm';
import { BaseTool } from './base.js';
import type { ToolExecuteOptions } from '../types.js';
import type { ToolRegistry } from './registry.js';
import type { CascadeRouter } from '../core/router/index.js';
import type { PermissionEscalator } from '../core/permissions/escalator.js';
import type { PermissionRequest } from '../types.js';

// ── Generated tool schema ──────────────────────

interface GeneratedToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Raw JS function body — receives `input`, `fetch`, and `callTool`. Returns string | Promise<string> */
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
  private registry: ToolRegistry;
  private escalator?: PermissionEscalator;

  constructor(spec: GeneratedToolSpec, registry: ToolRegistry, escalator?: PermissionEscalator) {
    super();
    this.name = spec.name;
    this.description = spec.description;
    this.inputSchema = spec.inputSchema;
    this.executeCode = spec.executeCode;
    this._isDangerous = spec.isDangerous;
    this.registry = registry;
    this.escalator = escalator;
  }

  isDangerous(): boolean {
    return this._isDangerous;
  }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const registry = this.registry;
    const escalator = this.escalator;

    // callTool gives generated tools access to the full registered cascade tool set.
    // Dangerous tools require escalation approval before running.
    const callTool = async (toolName: string, toolInput: Record<string, unknown>): Promise<string> => {
      if (!registry.hasTool(toolName)) return `Tool not found: ${toolName}`;

      if (registry.isDangerous(toolName)) {
        if (escalator) {
          const req: PermissionRequest = {
            id: `dynamic-${this.name}-${toolName}-${Date.now()}`,
            requestedBy: `dynamic_tool:${this.name}`,
            parentT2Id: options.tierId,
            toolName,
            input: toolInput,
            isDangerous: true,
            subtaskContext: `Dynamic tool "${this.name}" requesting access to "${toolName}"`,
            sectionContext: `Dynamic tool "${this.name}"`,
          };
          const decision = await escalator.requestPermission(req);
          if (!decision.approved) {
            return `Permission denied for ${toolName} (decided by ${decision.decidedBy}).`;
          }
        }
        // No escalator: fall through and let tool's own approval gate handle it
      }

      try {
        const result = await registry.execute(toolName, toolInput, options);
        return typeof result === 'string' ? result : JSON.stringify(result);
      } catch (err) {
        return `Error calling ${toolName}: ${err instanceof Error ? err.message : String(err)}`;
      }
    };

    // Sandbox: fetch, JSON, Math, Date, and callTool for cascade tool access
    const sandbox: Record<string, unknown> = {
      input,
      fetch: globalThis.fetch,
      callTool,
      JSON,
      Math,
      Date,
      console: { log: () => {}, error: () => {} },
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
- executeCode is a self-contained JavaScript async function body that:
  - Receives: input (object), fetch (for HTTP), callTool(toolName, input) (to call any registered cascade tool)
  - Returns: a string result
  - For file operations, prefer: await callTool('file_read', { path: input.path })
  - For shell commands, prefer: await callTool('shell', { command: 'ls -la' })
  - For pure computation / HTTP: use fetch or built-ins (JSON, Math, Date, String, Number, Array, Object)
  - Must complete in under 15 seconds
- isDangerous: true if the tool calls dangerous cascade tools (shell, file_write, file_delete, git) or makes HTTP calls that write data
- name must be snake_case, start with "dynamic_", max 40 chars
- description must be ≤ 120 chars

Example for a file-summary tool:
{
  "name": "dynamic_summarize_file",
  "description": "Read a file and return a one-paragraph summary",
  "inputSchema": { "path": { "type": "string", "description": "File path to summarize" } },
  "executeCode": "const content = await callTool('file_read', { path: input.path }); return content.slice(0, 500);",
  "isDangerous": false
}

Return ONLY valid JSON — no other text.`;

export class ToolCreator {
  private router: CascadeRouter;
  private registry: ToolRegistry;
  private escalator?: PermissionEscalator;
  private createdTools: Set<string> = new Set();

  constructor(router: CascadeRouter, registry: ToolRegistry) {
    this.router = router;
    this.registry = registry;
  }

  setPermissionEscalator(escalator: PermissionEscalator): void {
    this.escalator = escalator;
  }

  /**
   * Generate a new tool from a description and register it with the ToolRegistry.
   * The generated tool has access to all registered cascade tools via callTool().
   * Returns the tool name if successful, null if generation failed.
   */
  async createTool(description: string, context: string): Promise<string | null> {
    const prompt = `${TOOL_CREATOR_PROMPT}

Task context: ${context.slice(0, 200)}
Required capability: ${description.slice(0, 300)}`;

    try {
      const result = await this.router.generate('T3', {
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 800,
      });

      const jsonMatch = /\{[\s\S]*\}/.exec(result.content);
      if (!jsonMatch) return null;

      const spec = JSON.parse(jsonMatch[0]) as GeneratedToolSpec;

      if (!spec.name || !spec.description || !spec.executeCode || !spec.inputSchema) return null;

      // Ensure unique name in this session
      if (this.createdTools.has(spec.name) || this.registry.hasTool(spec.name)) {
        spec.name = `${spec.name}_${Date.now() % 10000}`;
      }

      // Syntax check only — don't execute
      try {
        new Function('input', 'fetch', 'callTool', spec.executeCode);
      } catch {
        return null;
      }

      const tool = new DynamicTool(spec, this.registry, this.escalator);
      this.registry.register(tool);
      this.createdTools.add(spec.name);

      return spec.name;
    } catch {
      return null;
    }
  }

  /** Returns the names of all tools created in this session. */
  getCreatedTools(): string[] {
    return Array.from(this.createdTools);
  }
}
