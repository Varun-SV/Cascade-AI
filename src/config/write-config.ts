// ─────────────────────────────────────────────
//  Cascade AI — writing the workspace config, reporting whether it worked
// ─────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';

/**
 * Write the workspace config file, returning whether it is actually on disk.
 *
 * Separated from its caller so the failure path can be exercised: the dashboard
 * swallowed every error from this write and acknowledged the save regardless,
 * so a read-only config directory produced a mutated in-memory config, a failed
 * write, a cheerful "Saved" in the panel with the typed keys cleared, and
 * settings that vanished at the next restart.
 *
 * The error text is returned rather than thrown because the caller reports it
 * to a person: "could not write the config file" plus the reason is actionable,
 * and an exception here would abort a save that had already applied.
 */
export function writeConfigFile(configPath: string, config: unknown): { ok: true } | { ok: false; error: string } {
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
