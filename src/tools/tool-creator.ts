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
import fs from 'node:fs/promises';
import path from 'node:path';
import { BaseTool } from './base.js';
import { safeFetch } from './utils/safe-fetch.js';
import type { ToolExecuteOptions } from '../types.js';
import type { ToolRegistry } from './registry.js';
import type { CascadeRouter } from '../core/router/index.js';
import type { PermissionEscalator } from '../core/permissions/escalator.js';
import type { PermissionRequest } from '../types.js';

// ── Generated tool schema ──────────────────────

export interface GeneratedToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Raw JS function body — receives `input`, `fetch`, and `callTool`. Returns string | Promise<string> */
  executeCode: string;
  isDangerous: boolean;
}

/** File (under .cascade/) where created tools persist between runs. */
const DYNAMIC_TOOLS_FILE = 'dynamic-tools.json';

/**
 * Wrap a generated `inputSchema` into a valid JSON Schema object. LLMs commonly
 * emit just a properties map (`{ path: { type, description } }`); passed through
 * as-is that is malformed for every provider's function-calling. Detect the
 * already-correct shape and otherwise wrap it so created tools are callable on
 * Anthropic, OpenAI, Gemini, and Ollama alike.
 */
export function normalizeToolSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema && schema['type'] === 'object' && typeof schema['properties'] === 'object') {
    return schema;
  }
  const properties = (schema && typeof schema === 'object') ? schema : {};
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
  };
}

/** Normalised capability fingerprint, used to avoid re-creating the same tool. */
function capabilityKey(text: string): string {
  return Array.from(
    new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => w.length > 2)),
  ).sort().join(' ');
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

    // The sandboxed fetch is SSRF-guarded: a generated tool (whose source is
    // produced by an LLM that may have ingested prompt-injected web content)
    // must not be able to reach loopback / cloud-metadata / private hosts.
    // NOTE: node:vm is NOT a security boundary against deliberately hostile
    // code (Object/Function reachability allows escape); it bounds accidental
    // misbehaviour and resource use. The real control is that dangerous
    // registered tools are still gated through the PermissionEscalator above.
    const guardedFetch = (url: string, init?: RequestInit) => safeFetch(url, init);

    // Sandbox: fetch, JSON, Math, Date, and callTool for cascade tool access
    const sandbox: Record<string, unknown> = {
      input,
      fetch: guardedFetch,
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
  private workspacePath?: string;
  private logger?: (msg: string) => void;
  /** name → spec, for persistence, broadcast, and re-registration. */
  private specs = new Map<string, GeneratedToolSpec>();
  /** capability fingerprint → tool name, so the same need isn't re-generated. */
  private capabilityIndex = new Map<string, string>();

  constructor(router: CascadeRouter, registry: ToolRegistry, workspacePath?: string) {
    this.router = router;
    this.registry = registry;
    this.workspacePath = workspacePath;
  }

  setPermissionEscalator(escalator: PermissionEscalator): void {
    this.escalator = escalator;
  }

  /** Route diagnostics through the host (Cascade) so they survive the Ink TUI. */
  setLogger(fn: (msg: string) => void): void {
    this.logger = fn;
  }

  /** Returns the stored spec for a created tool (for peer broadcast). */
  getSpec(name: string): GeneratedToolSpec | undefined {
    return this.specs.get(name);
  }

  private log(msg: string): void {
    if (this.logger) this.logger(msg);
  }

  /**
   * Generate a new tool from a description and register it with the ToolRegistry.
   * Returns the tool name on success, or null on failure (with a logged reason —
   * failures are no longer swallowed silently). Reuses an existing tool when the
   * same capability has already been created (dedup) so peers/runs don't
   * regenerate identical tools.
   */
  async createTool(description: string, context: string): Promise<string | null> {
    // ── Dedup: reuse a previously created tool for the same capability ──
    const key = capabilityKey(`${description} ${context}`);
    const existing = this.capabilityIndex.get(key);
    if (existing && this.registry.hasTool(existing)) {
      this.log(`[tool-creator] Reusing existing tool "${existing}" for: ${description.slice(0, 80)}`);
      return existing;
    }

    const prompt = `${TOOL_CREATOR_PROMPT}

Task context: ${context.slice(0, 200)}
Required capability: ${description.slice(0, 300)}`;

    let spec: GeneratedToolSpec | null = null;
    // One retry — weak models often miss strict-JSON on the first attempt.
    for (let attempt = 1; attempt <= 2 && !spec; attempt++) {
      try {
        const result = await this.router.generate('T3', {
          messages: [{ role: 'user', content: prompt }],
          maxTokens: 800,
        });
        const jsonMatch = /\{[\s\S]*\}/.exec(result.content);
        if (!jsonMatch) {
          this.log(`[tool-creator] Attempt ${attempt}: model returned no JSON object.`);
          continue;
        }
        const parsed = JSON.parse(jsonMatch[0]) as GeneratedToolSpec;
        if (!parsed.name || !parsed.description || !parsed.executeCode || !parsed.inputSchema) {
          this.log(`[tool-creator] Attempt ${attempt}: spec missing required fields (name/description/executeCode/inputSchema).`);
          continue;
        }
        spec = parsed;
      } catch (err) {
        this.log(`[tool-creator] Attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (!spec) {
      this.log(`[tool-creator] Could not generate a tool for: ${description.slice(0, 80)}`);
      return null;
    }

    // Wrap a bare properties map into a valid object schema so the tool is
    // callable across every provider.
    spec.inputSchema = normalizeToolSchema(spec.inputSchema);

    // Ensure a unique name
    if (this.specs.has(spec.name) || this.registry.hasTool(spec.name)) {
      spec.name = `${spec.name}_${Date.now() % 10000}`;
    }

    // Syntax check only — don't execute
    try {
      new Function('input', 'fetch', 'callTool', spec.executeCode);
    } catch (err) {
      this.log(`[tool-creator] Generated code for "${spec.name}" has a syntax error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }

    this.registerSpec(spec);
    this.capabilityIndex.set(key, spec.name);
    this.log(`[tool-creator] Created tool "${spec.name}".`);

    // Persist so the tool survives future runs (peers are notified by the T2
    // manager over its worker bus right after this returns).
    void this.persist();

    return spec.name;
  }

  /**
   * Register a spec (from createTool, disk, or a peer) into the registry.
   * Idempotent — a name already present is skipped.
   */
  registerSpec(spec: GeneratedToolSpec): void {
    if (this.registry.hasTool(spec.name)) {
      this.specs.set(spec.name, spec);
      return;
    }
    const tool = new DynamicTool(spec, this.registry, this.escalator);
    this.registry.register(tool);
    this.specs.set(spec.name, spec);
    this.capabilityIndex.set(capabilityKey(`${spec.description}`), spec.name);
  }

  /** Load tools persisted by previous runs and register them. */
  async loadPersistedTools(): Promise<void> {
    if (!this.workspacePath) return;
    const file = path.join(this.workspacePath, '.cascade', DYNAMIC_TOOLS_FILE);
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const specs = JSON.parse(raw) as GeneratedToolSpec[];
      if (!Array.isArray(specs)) return;
      let loaded = 0;
      for (const spec of specs) {
        if (spec?.name && spec.description && spec.executeCode && spec.inputSchema) {
          spec.inputSchema = normalizeToolSchema(spec.inputSchema);
          this.registerSpec(spec);
          loaded++;
        }
      }
      if (loaded) this.log(`[tool-creator] Loaded ${loaded} persisted tool(s).`);
    } catch {
      // No persisted file yet, or unreadable — start fresh.
    }
  }

  private async persist(): Promise<void> {
    if (!this.workspacePath) return;
    const dir = path.join(this.workspacePath, '.cascade');
    const file = path.join(dir, DYNAMIC_TOOLS_FILE);
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(file, JSON.stringify(Array.from(this.specs.values()), null, 2), 'utf-8');
    } catch (err) {
      this.log(`[tool-creator] Failed to persist tools: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Returns the names of all tools created in this session. */
  getCreatedTools(): string[] {
    return Array.from(this.specs.keys());
  }
}
