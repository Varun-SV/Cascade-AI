// ─────────────────────────────────────────────
//  Cascade AI — Config Validator
// ─────────────────────────────────────────────

import { z } from 'zod';
import { CascadeConfigSchema } from './schema.js';
import type { CascadeConfig } from '../types.js';

export class CascadeConfigError extends Error {
  public readonly issues: z.ZodIssue[];

  constructor(result: z.SafeParseError<unknown>) {
    const summary = result.error.issues
      .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    super(`Invalid cascade configuration:\n${summary}`);
    this.name = 'CascadeConfigError';
    this.issues = result.error.issues;
  }
}

/**
 * Validates raw config input (from YAML, JSON, or programmatic usage) against
 * the Zod CascadeConfigSchema. Throws `CascadeConfigError` with a detailed
 * issue list if validation fails.
 *
 * @param raw - Untrusted config object (e.g. from fs.readFileSync + yaml.parse)
 * @returns A fully populated, type-safe `CascadeConfig` with all defaults applied.
 */
export function validateConfig(raw: unknown): CascadeConfig {
  const result = CascadeConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new CascadeConfigError(result);
  }
  return result.data as unknown as CascadeConfig;
}

/**
 * Like `validateConfig` but returns `null` on failure instead of throwing.
 * Useful for config file watchers where you want to log and skip.
 */
export function tryValidateConfig(raw: unknown): CascadeConfig | null {
  try {
    return validateConfig(raw);
  } catch {
    return null;
  }
}
