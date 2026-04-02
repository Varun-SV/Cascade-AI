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
 * High-level SDK entry point.
 * Loads config from the workspace and runs a task.
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

  const cascade = new Cascade(config);
  await cascade.init();

  return cascade.run({
    prompt,
    workspacePath,
    ...options,
  });
}

/**
 * Create a Cascade instance with custom config (no file system required).
 */
export function createCascade(config: Partial<CascadeConfig>): Cascade {
  const parsed = CascadeConfigSchema.parse(config);
  return new Cascade(parsed);
}

/**
 * Simple streaming helper — collects tokens into a callback.
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
