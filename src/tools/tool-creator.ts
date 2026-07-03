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

import { Worker } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BaseTool } from './base.js';
import { safeFetch } from './utils/safe-fetch.js';
import type { ToolExecuteOptions } from '../types.js';
import type { ToolRegistry } from './registry.js';
import type { CascadeRouter } from '../core/router/index.js';
import type { PermissionEscalator } from '../core/permissions/escalator.js';
import type { PermissionRequest } from '../types.js';

export type SandboxMode = 'isolate' | 'worker' | 'auto';

// ── Optional hard-isolate runtime (isolated-vm) ────
//
//  A `node:worker_threads` Worker is a robustness boundary (kill timeout, memory
//  cap, crash containment) but NOT a security one: generated code still sees Node
//  globals (`process`, `process.binding`, …) inside the worker. `isolated-vm` runs
//  it in a hard V8 isolate whose global has NO Node built-ins at all — real
//  capability confinement — reaching the host ONLY through the same escalator-gated
//  `callTool` and SSRF-guarded `fetch` bridges. It's an optional native dependency:
//  if it's absent or failed to build we transparently fall back to the worker.
//
//  The addon's surface is declared LOCALLY (structural types below) and loaded via
//  a non-literal dynamic import: a literal `import type ... from 'isolated-vm'`
//  makes COMPILATION require the optional module to be installed, which broke the
//  release build wherever it didn't install (e.g. the Node 20 CI publish job had
//  no matching prebuild). Nothing here may reference the module's own types.

interface IvmContext {
  global: { set(name: string, value: unknown): Promise<void> };
}
interface IvmScript {
  run(context: IvmContext, options?: { timeout?: number; promise?: boolean }): Promise<unknown>;
}
interface IvmIsolate {
  createContext(): Promise<IvmContext>;
  compileScript(code: string): Promise<IvmScript>;
  dispose(): void;
}
interface IvmModule {
  Isolate: new (options?: { memoryLimit?: number }) => IvmIsolate;
  Reference: new (value: unknown) => unknown;
  ExternalCopy: new (value: unknown) => { copyInto(): unknown };
}

// undefined = not yet attempted; null = unavailable (absent / failed to build).
let ivmCache: IvmModule | null | undefined;
let ivmWarned = false;

async function loadIsolatedVm(): Promise<IvmModule | null> {
  if (ivmCache !== undefined) return ivmCache;
  try {
    // Non-literal specifier: tsc must not resolve the OPTIONAL module at compile
    // time, and bundlers keep the import dynamic instead of inlining it.
    const specifier = 'isolated-vm';
    const mod = (await import(specifier)) as { default?: IvmModule } & IvmModule;
    ivmCache = mod.default ?? mod;
  } catch {
    ivmCache = null;
  }
  return ivmCache;
}

function safeJsonParse(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string') return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ── Generated tool schema ──────────────────────

export interface GeneratedToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Raw JS function body — receives `input`, `fetch`, and `callTool`. Returns string | Promise<string> */
  executeCode: string;
  isDangerous: boolean;
  /**
   * Whether this tool's source is trusted (generated in THIS session) vs untrusted
   * (loaded from disk or received from a peer). Untrusted tools always re-escalate
   * their dangerous actions. Never persisted as trusted — forced false on reload.
   */
  trusted?: boolean;
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

// ── Worker sandbox ─────────────────────────────
//
//  Generated (LLM-authored, hence UNTRUSTED) code runs in a node:worker_threads
//  Worker, not in the main process. node:vm was never a security boundary — its
//  `timeout` can't stop async runaway, the code shares the main heap, and a throw
//  can take down the Ink TUI. The worker gives an enforceable kill timeout
//  (worker.terminate()), a memory cap (resourceLimits), and crash containment,
//  and — crucially — keeps Cascade's privileged objects (registry, router, the
//  PermissionEscalator) on the MAIN thread. The worker reaches them ONLY through a
//  message bridge whose callTool path is gated by the escalator and whose fetch
//  path is SSRF-guarded by safeFetch. (A hard V8 isolate would need isolated-vm;
//  worker + gating is the chosen dependency-free boundary.)

const DYNAMIC_TOOL_TIMEOUT_MS = 15_000;
const DYNAMIC_FETCH_MAX = 1_000_000;

// Fixed harness run inside the worker. The generated `executeCode` arrives as DATA
// via workerData (never imported as a module); `callTool`/`fetch` are bridged to
// the main thread. No `require`/`process` is in the generated code's scope.
const HARNESS_SRC = `
const { parentPort, workerData } = require('node:worker_threads');
const { executeCode, input } = workerData;
let nextId = 0;
const pending = new Map();
function bridge(kind, payload) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    parentPort.postMessage(Object.assign({ kind, id }, payload));
  });
}
parentPort.on('message', (msg) => {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error !== undefined) p.reject(new Error(msg.error));
  else p.resolve(msg.value);
});
const callTool = (name, toolInput) => bridge('callTool', { name: name, input: toolInput });
const fetch = async (url, init) => {
  const safeInit = init && typeof init === 'object'
    ? { method: init.method, headers: init.headers, body: typeof init.body === 'string' ? init.body : undefined }
    : undefined;
  const r = await bridge('fetch', { url: url, init: safeInit });
  return {
    ok: r.ok, status: r.status, statusText: r.statusText,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? r.contentType : null) },
    text: async () => r.body,
    json: async () => JSON.parse(r.body),
  };
};
(async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('input', 'callTool', 'fetch', 'console', executeCode);
  return await fn(input, callTool, fetch, { log() {}, error() {} });
})()
  .then((r) => parentPort.postMessage({ kind: 'result', value: String(r == null ? '' : r) }))
  .catch((e) => parentPort.postMessage({ kind: 'result', value: 'Tool error: ' + (e && e.message ? e.message : String(e)) }));
`;

/**
 * Validate that generated code compiles with the SAME async signature the worker
 * uses to run it, so `await callTool(...)` / `await fetch(...)` are valid (a plain
 * sync `new Function` wrongly rejects every I/O tool). Reused on creation AND when
 * re-validating untrusted persisted/peer specs before re-registering them.
 */
export function isExecutableToolCode(code: string): boolean {
  try {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor;
    new AsyncFunction('input', 'callTool', 'fetch', 'console', code);
    return true;
  } catch {
    return false;
  }
}

/** Run an agent-supplied fetch on the MAIN thread through the SSRF guard, marshaling
 *  a minimal Response for the worker (a real Response can't cross the thread). */
async function bridgeFetch(
  url: string,
  init: unknown,
): Promise<{ ok: boolean; status: number; statusText: string; contentType: string; body: string } | { __error: string }> {
  try {
    const i = (init && typeof init === 'object') ? (init as Record<string, unknown>) : {};
    const resp = await safeFetch(url, {
      method: typeof i['method'] === 'string' ? (i['method'] as string) : undefined,
      headers: i['headers'] as Record<string, string> | undefined,
      body: typeof i['body'] === 'string' ? (i['body'] as string) : undefined,
    });
    const contentType = resp.headers.get('content-type') ?? '';
    let body = '';
    try { body = await resp.text(); } catch { body = ''; }
    if (body.length > DYNAMIC_FETCH_MAX) body = body.slice(0, DYNAMIC_FETCH_MAX);
    return { ok: resp.ok, status: resp.status, statusText: resp.statusText, contentType, body };
  } catch (err) {
    // SSRF block / network error → reject the worker's fetch (like a real failure).
    return { __error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Dynamic tool class factory ─────────────────

class DynamicTool extends BaseTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  private executeCode: string;
  private _isDangerous: boolean;
  private registry: ToolRegistry;
  /** Resolve the CURRENT escalator at call time — covers tools registered before
   *  the per-run escalator was wired (persisted at init, received from a peer). */
  private getEscalator: () => PermissionEscalator | undefined;
  /** Untrusted = loaded from disk / a peer; its dangerous calls always re-prompt. */
  private trusted: boolean;
  /** Resolve the configured sandbox mode at call time (default 'auto'). */
  private getSandboxMode: () => SandboxMode;
  /** Optional diagnostics sink (routed through the host so it survives the Ink TUI). */
  private log: (msg: string) => void;

  constructor(
    spec: GeneratedToolSpec,
    registry: ToolRegistry,
    getEscalator: () => PermissionEscalator | undefined,
    trusted: boolean,
    getSandboxMode: () => SandboxMode = () => 'auto',
    log: (msg: string) => void = () => {},
  ) {
    super();
    this.name = spec.name;
    this.description = spec.description;
    this.inputSchema = spec.inputSchema;
    this.executeCode = spec.executeCode;
    this._isDangerous = spec.isDangerous;
    this.registry = registry;
    this.getEscalator = getEscalator;
    this.trusted = trusted;
    this.getSandboxMode = getSandboxMode;
    this.log = log;
  }

  isDangerous(): boolean {
    return this._isDangerous;
  }

  async execute(input: Record<string, unknown>, options: ToolExecuteOptions): Promise<string> {
    const registry = this.registry;

    // callTool runs on the MAIN thread (the worker bridges to it). Dangerous tools
    // require escalation; when NO approver is available we DEFAULT-DENY rather than
    // execute. Untrusted tools always re-prompt (forceReprompt bypasses the cache).
    const callTool = async (toolName: string, toolInput: Record<string, unknown>): Promise<string> => {
      if (!registry.hasTool(toolName)) return `Tool not found: ${toolName}`;

      if (registry.isDangerous(toolName)) {
        const escalator = this.getEscalator();
        if (!escalator) {
          return `Permission denied for "${toolName}": dynamic tool "${this.name}" has no approver available (default-deny).`;
        }
        const req: PermissionRequest = {
          id: `dynamic-${this.name}-${toolName}-${Date.now()}`,
          requestedBy: `dynamic_tool:${this.name}`,
          parentT2Id: options.tierId,
          toolName,
          input: toolInput,
          isDangerous: true,
          subtaskContext: `Dynamic tool "${this.name}" (${this.trusted ? 'trusted' : 'UNTRUSTED'}) requesting access to "${toolName}"`,
          sectionContext: `Dynamic tool "${this.name}"`,
          forceReprompt: !this.trusted,
        };
        const decision = await escalator.requestPermission(req);
        if (!decision.approved) {
          return `Permission denied for ${toolName} (decided by ${decision.decidedBy}).`;
        }
      }

      try {
        const result = await registry.execute(toolName, toolInput, options);
        return typeof result === 'string' ? result : JSON.stringify(result);
      } catch (err) {
        return `Error calling ${toolName}: ${err instanceof Error ? err.message : String(err)}`;
      }
    };

    // Choose the executor. 'isolate'/'auto' prefer the hard V8 isolate; both fall
    // back to the worker if isolated-vm isn't loadable ('isolate' warns once that
    // the confinement it asked for is unavailable). 'worker' skips the isolate.
    const mode = this.getSandboxMode();
    if (mode !== 'worker') {
      const ivm = await loadIsolatedVm();
      if (ivm) return this.runInIsolate(ivm, input, callTool);
      if (mode === 'isolate' && !ivmWarned) {
        ivmWarned = true;
        this.log('[tool-creator] isolated-vm is not available (not installed or failed to build) — dynamic tools fall back to the worker sandbox, which is NOT capability-confined. Install isolated-vm for a hard isolate.');
      }
    }
    return this.runInWorker(input, callTool);
  }

  /**
   * Run the generated code in a hard V8 isolate (isolated-vm). The isolate global
   * has no Node built-ins, so the code cannot see `process`, `require`, the
   * filesystem, or the network — it reaches the host ONLY through the injected
   * `callTool` (escalator-gated on the main thread) and `fetch` (SSRF-guarded via
   * bridgeFetch). `script.run({ timeout })` bounds synchronous CPU; an outer
   * wall-clock race + `isolate.dispose()` bounds async runaway (a never-resolving
   * await), mirroring the worker's terminate().
   */
  private async runInIsolate(
    ivm: IvmModule,
    input: Record<string, unknown>,
    callTool: (name: string, input: Record<string, unknown>) => Promise<string>,
  ): Promise<string> {
    const timeoutMs = Math.max(200, Number(process.env['CASCADE_DYNAMIC_TOOL_TIMEOUT_MS']) || DYNAMIC_TOOL_TIMEOUT_MS);
    const isolate = new ivm.Isolate({ memoryLimit: 128 });
    let disposed = false;
    const dispose = () => { if (!disposed) { disposed = true; try { isolate.dispose(); } catch { /* already gone */ } } };

    try {
      const context = await isolate.createContext();
      const jail = context.global;

      // Host bridges — the ONLY capabilities the isolate has. callTool is already
      // escalator-gated (dangerous tools) in execute(); fetch is SSRF-guarded.
      await jail.set('_callTool', new ivm.Reference(async (name: string, inputJson: string) => {
        const out = await callTool(String(name), safeJsonParse(inputJson));
        return String(out);
      }));
      await jail.set('_fetch', new ivm.Reference(async (url: string, initJson: string) => {
        const r = await bridgeFetch(String(url), safeJsonParse(initJson));
        return JSON.stringify(r);
      }));
      await jail.set('_input', new ivm.ExternalCopy(input).copyInto());
      await jail.set('_code', this.executeCode);

      // In-isolate preamble: rebuild the same (input, callTool, fetch, console)
      // async signature the generated body expects, marshaling across the boundary.
      const bootstrap = `
        const callTool = (name, toolInput) => _callTool.apply(undefined,
          [String(name), JSON.stringify(toolInput || {})],
          { result: { promise: true }, arguments: { copy: true } });
        const fetch = async (url, init) => {
          const raw = await _fetch.apply(undefined,
            [String(url), JSON.stringify(init || null)],
            { result: { promise: true }, arguments: { copy: true } });
          const r = JSON.parse(raw);
          if (r && r.__error) throw new Error(r.__error);
          return {
            ok: r.ok, status: r.status, statusText: r.statusText,
            headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? r.contentType : null) },
            text: async () => r.body,
            json: async () => JSON.parse(r.body),
          };
        };
        const console = { log() {}, error() {} };
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        const fn = new AsyncFunction('input', 'callTool', 'fetch', 'console', _code);
        (async () => { const r = await fn(_input, callTool, fetch, console); return String(r == null ? '' : r); })();
      `;
      const script = await isolate.compileScript(bootstrap);
      const runPromise = (script.run(context, { timeout: timeoutMs, promise: true }) as Promise<unknown>)
        .then((v) => String(v ?? ''));
      const timeoutPromise = new Promise<string>((resolve) => {
        const t = setTimeout(() => {
          dispose();
          resolve(`Dynamic tool "${this.name}" timed out after ${timeoutMs}ms and was terminated.`);
        }, timeoutMs + 500);
        t.unref?.();
      });
      return await Promise.race([runPromise, timeoutPromise]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/timed? out/i.test(msg)) {
        return `Dynamic tool "${this.name}" timed out after ${timeoutMs}ms and was terminated.`;
      }
      return `Tool error: ${msg}`;
    } finally {
      dispose();
    }
  }

  /** Spawn the worker, service its callTool/fetch bridge, enforce the kill timeout. */
  private runInWorker(
    input: Record<string, unknown>,
    callTool: (name: string, input: Record<string, unknown>) => Promise<string>,
  ): Promise<string> {
    // Tunable kill timeout (ops may shorten/lengthen; min 200ms).
    const timeoutMs = Math.max(200, Number(process.env['CASCADE_DYNAMIC_TOOL_TIMEOUT_MS']) || DYNAMIC_TOOL_TIMEOUT_MS);
    return new Promise<string>((resolve) => {
      let settled = false;
      const worker = new Worker(HARNESS_SRC, {
        eval: true,
        workerData: { executeCode: this.executeCode, input },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });

      const finish = (value: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate();
        resolve(value);
      };

      const timer = setTimeout(
        () => finish(`Dynamic tool "${this.name}" timed out after ${timeoutMs}ms and was terminated.`),
        timeoutMs,
      );
      timer.unref?.();

      worker.on('message', (msg: { kind?: string; id?: number; name?: string; input?: unknown; url?: string; init?: unknown; value?: unknown }) => {
        if (msg?.kind === 'result') {
          finish(typeof msg.value === 'string' ? msg.value : String(msg.value ?? ''));
        } else if (msg?.kind === 'callTool') {
          void (async () => {
            const value = await callTool(String(msg.name), (msg.input ?? {}) as Record<string, unknown>);
            if (!settled) worker.postMessage({ id: msg.id, value });
          })();
        } else if (msg?.kind === 'fetch') {
          void (async () => {
            const r = await bridgeFetch(String(msg.url), msg.init);
            if (settled) return;
            if ('__error' in r) worker.postMessage({ id: msg.id, error: r.__error });
            else worker.postMessage({ id: msg.id, value: r });
          })();
        }
      });
      worker.on('error', (err) => finish(`Dynamic tool error: ${err instanceof Error ? err.message : String(err)}`));
      worker.on('exit', (code) => { if (code !== 0) finish(`Dynamic tool "${this.name}" exited unexpectedly (code ${code}).`); });
    });
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
  /** When false, persisted tools are neither loaded nor written. */
  private persistEnabled: boolean;
  /** Sandbox runtime for generated tools; passed to each DynamicTool. */
  private sandboxMode: SandboxMode;
  private logger?: (msg: string) => void;
  /** name → spec, for persistence, broadcast, and re-registration. */
  private specs = new Map<string, GeneratedToolSpec>();
  /** capability fingerprint → tool name, so the same need isn't re-generated. */
  private capabilityIndex = new Map<string, string>();

  constructor(
    router: CascadeRouter,
    registry: ToolRegistry,
    workspacePath?: string,
    persistEnabled = true,
    sandboxMode: SandboxMode = 'auto',
  ) {
    this.router = router;
    this.registry = registry;
    this.workspacePath = workspacePath;
    this.persistEnabled = persistEnabled;
    this.sandboxMode = sandboxMode;
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

    // Validate the code compiles with the worker's async signature before
    // registering (the v0.9.5 fix — a sync check wrongly rejected every I/O tool).
    if (!isExecutableToolCode(spec.executeCode)) {
      this.log(`[tool-creator] Generated code for "${spec.name}" has a syntax error — discarded.`);
      return null;
    }

    // Generated in THIS session → trusted.
    this.registerSpec(spec, true);
    this.capabilityIndex.set(key, spec.name);
    this.log(`[tool-creator] Created tool "${spec.name}".`);

    // Persist so the tool survives future runs (peers are notified by the T2
    // manager over its worker bus right after this returns).
    void this.persist();

    return spec.name;
  }

  /**
   * Register a spec (from createTool, disk, or a peer) into the registry.
   * Idempotent — a name already present is skipped. `trusted` is set by the
   * caller and never inherited from disk: createTool passes true; persisted and
   * peer-broadcast specs pass false, so their dangerous actions always re-escalate.
   * The DynamicTool resolves the escalator lazily (`() => this.escalator`) so a
   * later setPermissionEscalator covers tools registered before the run wired it.
   */
  registerSpec(spec: GeneratedToolSpec, trusted = false): void {
    spec.trusted = trusted;
    if (this.registry.hasTool(spec.name)) {
      this.specs.set(spec.name, spec);
      return;
    }
    const tool = new DynamicTool(
      spec,
      this.registry,
      () => this.escalator,
      trusted,
      () => this.sandboxMode,
      (msg) => this.log(msg),
    );
    this.registry.register(tool);
    this.specs.set(spec.name, spec);
    this.capabilityIndex.set(capabilityKey(`${spec.description}`), spec.name);
  }

  /** Load tools persisted by previous runs and register them — as UNTRUSTED, and
   *  only after re-validating each spec (its source could have been tampered with
   *  or authored during a prior prompt-injected run). Untrusted tools re-escalate
   *  any dangerous action, so a silently-reloaded tool can't act without approval. */
  async loadPersistedTools(): Promise<void> {
    if (!this.workspacePath || !this.persistEnabled) return;
    const file = path.join(this.workspacePath, '.cascade', DYNAMIC_TOOLS_FILE);
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const specs = JSON.parse(raw) as GeneratedToolSpec[];
      if (!Array.isArray(specs)) return;
      let loaded = 0;
      let skipped = 0;
      for (const spec of specs) {
        if (!(spec?.name && spec.description && spec.executeCode && spec.inputSchema)
            || !isExecutableToolCode(spec.executeCode)) {
          skipped++;
          continue;
        }
        spec.inputSchema = normalizeToolSchema(spec.inputSchema);
        this.registerSpec(spec, false); // persisted → untrusted
        loaded++;
      }
      if (loaded || skipped) {
        this.log(`[tool-creator] Loaded ${loaded} persisted tool(s) as untrusted${skipped ? `, skipped ${skipped} invalid` : ''}.`);
      }
    } catch {
      // No persisted file yet, or unreadable — start fresh.
    }
  }

  private async persist(): Promise<void> {
    if (!this.workspacePath || !this.persistEnabled) return;
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
