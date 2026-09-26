// ─────────────────────────────────────────────
//  Cascade AI — writing the workspace config, reporting whether it worked
// ─────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import type { ProviderConfig } from '../types.js';
import { saveProjectCredentials, withoutCredentials } from './global-credentials.js';
import { globalDir, projectStateDir, statePath, STATE } from './project-state.js';

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

/**
 * Write a project's config where it is kept (config/project-state.ts) — with
 * no provider key in it: the keys go to the machine-global credential store,
 * a project's own among them (config/global-credentials.ts). Every writer of
 * a project's config comes through here, so none can leave a key beside it.
 */
export function writeProjectConfig(
  workspacePath: string,
  config: { providers?: ProviderConfig[] } & Record<string, unknown>,
  globalDirPath: string = globalDir(),
  /** The providers the caller started from, so a key another process saved meanwhile is kept (see saveProjectCredentials). */
  base?: ProviderConfig[],
): { ok: true } | { ok: false; error: string } {
  const providers = config.providers ?? [];
  // The keys first: with the config written and the keys not, a key just
  // entered would be gone on the next load.
  let undo: () => void;
  try {
    undo = saveProjectCredentials(globalDirPath, path.basename(projectStateDir(workspacePath)), providers, base);
  } catch (err) {
    return { ok: false, error: `the provider keys could not be saved: ${err instanceof Error ? err.message : String(err)}` };
  }
  // Both or neither: a config that could not be written takes the keys'
  // change back, or a key added, replaced or removed would stand for every
  // project while the save reported it had not happened.
  const written = writeConfigFile(statePath(workspacePath, STATE.config), { ...config, providers: withoutCredentials(providers) });
  if (!written.ok) {
    try { undo(); } catch (err) {
      return { ok: false, error: `${written.error}; and the provider keys, saved first, could not be put back: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return written;
}
