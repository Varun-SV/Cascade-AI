// ─────────────────────────────────────────────
//  Cascade AI — What /undo and /checkpoints say
// ─────────────────────────────────────────────

import type { Checkpoint, UndoResult } from '../../core/checkpoints.js';

const list = (paths: string[], max = 8): string =>
  paths.slice(0, max).map((p) => `  ${p}`).join('\n') + (paths.length > max ? `\n  …and ${paths.length - max} more` : '');

const ago = (iso: string, now = Date.now()): string => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
};

export function describeUndo(r: UndoResult): string {
  if (!r.runs.length) return 'Nothing to undo: no run in this project has a checkpoint left that isn\'t undone already.';
  const which = r.runs.length === 1 ? `run #${r.runs[0]!.n} ("${r.runs[0]!.label}")` : `the last ${r.runs.length} runs (#${r.runs.at(-1)!.n}–#${r.runs[0]!.n})`;
  const parts = [`Undid ${which}.`];
  if (!r.restored.length && !r.removed.length && !r.skipped.length) parts.push('It had not changed any files.');
  if (r.restored.length) parts.push(`Put back as they were (${r.restored.length}):\n${list(r.restored)}`);
  if (r.removed.length) parts.push(`Removed, as the run made them (${r.removed.length}):\n${list(r.removed)}`);
  if (r.skipped.length) {
    parts.push(`Left alone, because they changed again after the run (${r.skipped.length}):\n${list(r.skipped)}\n`
      + `/undo --force puts these back too, losing the later changes.`);
  }
  parts.push('Files your .gitignore leaves out (node_modules, build output) aren\'t kept, and anything that left this computer (a push, a deploy, a message) can\'t be taken back.');
  return parts.join('\n\n');
}

export function describeCheckpoints(all: Checkpoint[], now = Date.now()): string {
  if (!all.length) return 'No checkpoints yet. Cascade records your project before and after each run, so /undo can take a run back.';
  const rows = all.slice(-15).reverse().map((c) => {
    const changed = c.changed === undefined ? 'running or stopped' : c.changed === 1 ? '1 file' : `${c.changed} files`;
    return `  #${String(c.n).padEnd(4)}${ago(c.at, now).padEnd(12)}${changed.padEnd(20)}${c.undone ? '(undone) ' : c.partial ? '(partly undone) ' : ''}${c.label}`;
  });
  const open = all.filter((c) => !c.undone).length;
  return [`Checkpoints, newest first (${open} can be undone):`, ...rows, '', '/undo takes back the newest; /undo 3 the last three.'].join('\n');
}
