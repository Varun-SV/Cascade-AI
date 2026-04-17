// ─────────────────────────────────────────────
//  Cascade AI — Programmatic SDK
// ─────────────────────────────────────────────

import type {
  CascadeConfig,
  CascadeRunOptions,
  CascadeRunResult,
  StreamChunk,
} from '../types.js';
import { Cascade } from '../core/cascade.js';
import { ConfigManager } from '../config/index.js';
import { CascadeConfigSchema } from '../config/schema.js';

export { Cascade } from '../core/cascade.js';
export * from '../types.js';

/**
 * High-level SDK entry point — loads config from the workspace and runs a task.
 *
 * Cascade automatically determines complexity and routes to the appropriate
 * tier: T3 (simple), T2 (moderate), or the full T1→T2→T3 hierarchy (complex).
 *
 * @param prompt - The natural-language task description to execute.
 * @param options - Optional overrides for run behavior, approval callbacks, etc.
 * @returns A resolved `CascadeRunResult` with the final output and metadata.
 *
 * @example
 * const result = await runCascade('Refactor the auth module to use JWT', {
 *   workspacePath: '/path/to/my/project',
 *   streamCallback: (chunk) => process.stdout.write(chunk.text ?? ''),
 *   approvalCallback: async (req) => {
 *     console.log(`Approve ${req.toolName}?`);
 *     return { approved: true, always: false };
 *   },
 * });
 * console.log(result.output);
 */
export async function runCascade(
  prompt: string,
  options: Partial<CascadeRunOptions> & { workspacePath?: string; config?: Partial<CascadeConfig> } = {},
): Promise<CascadeRunResult> {
  const workspacePath = options.workspacePath ?? process.cwd();

  const cm = new ConfigManager(workspacePath);
  await cm.load();
  const config = options.config
    ? CascadeConfigSchema.parse({ ...cm.getConfig(), ...options.config })
    : cm.getConfig();

  const cascade = new Cascade(config, workspacePath);
  await cascade.init();

  try {
    return await cascade.run({
      prompt,
      workspacePath,
      ...options,
    });
  } finally {
    // Fire-and-forget SDK invocations should not leak the MCP child
    // processes Cascade may have spawned. `createCascade` (which returns
    // the instance) still leaves cleanup to the caller.
    try { await cascade.close(); } catch { /* non-critical */ }
  }
}

/**
 * Create a `Cascade` instance with custom config — no filesystem config loading.
 *
 * Use this in environments where you control the config programmatically
 * (e.g. tests, serverless, embedded usage).
 *
 * @param config - Partial config; missing fields use schema defaults.
 * @param workspacePath - Workspace root (default: `process.cwd()`).
 *
 * @example
 * const cascade = createCascade({
 *   providers: [{ type: 'anthropic', apiKey: process.env.ANTHROPIC_KEY }],
 * });
 * cascade.on('stream:token', (e) => process.stdout.write(e.text));
 * await cascade.init();
 * await cascade.run({ prompt: 'Hello world', workspacePath: '.' });
 */
export function createCascade(
  config: Partial<CascadeConfig>,
  workspacePath: string = process.cwd(),
): Cascade {
  const parsed = CascadeConfigSchema.parse(config);
  return new Cascade(parsed, workspacePath);
}

/**
 * Convenience streaming helper — runs a task and delivers tokens via callback.
 *
 * @param prompt - The task to execute.
 * @param onToken - Called with each streamed text token as it arrives.
 * @param options - Same options as `runCascade`.
 *
 * @example
 * await streamCascade('Summarize this codebase', (token) => {
 *   process.stdout.write(token);
 * });
 */
export async function streamCascade(
  prompt: string,
  onToken: (text: string) => void,
  options: Partial<CascadeRunOptions> & { workspacePath?: string } = {},
): Promise<CascadeRunResult> {
  return runCascade(prompt, {
    ...options,
    streamCallback: (chunk: StreamChunk) => {
      if (chunk.text) onToken(chunk.text);
    },
  });
}
