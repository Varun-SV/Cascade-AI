// The tools a cloud run may be given in a folder, as the consent window offers them.
// (The main process checks the same list again: app/electron/workspace-consent.ts.)

export const READ_TOOLS = ['file_list', 'file_read', 'glob', 'grep'] as const;
export const EDIT_TOOLS = [...READ_TOOLS, 'file_delete', 'file_edit', 'file_write'] as const;
export const ALL_TOOLS = [...EDIT_TOOLS, 'git', 'run_code', 'shell'] as const;

export const PRESETS = [
  { id: 'read', title: 'Read only', tools: READ_TOOLS as readonly string[] },
  { id: 'edit', title: 'Read and edit files', tools: EDIT_TOOLS as readonly string[] },
  { id: 'all', title: 'Everything', tools: ALL_TOOLS as readonly string[] },
] as const;

export const TOOL_NOTES: Record<string, string> = {
  file_list: 'List files', file_read: 'Read files', glob: 'Find files by name', grep: 'Search inside files',
  file_write: 'Create and overwrite files', file_edit: 'Edit files', file_delete: 'Delete files',
  shell: 'Run shell commands', git: 'Run git', run_code: 'Run code',
};

/** The preset a selection is exactly, else null. */
export function presetOfSelection(selected: readonly string[]): string | null {
  const set = new Set(selected);
  return PRESETS.find((p) => p.tools.length === set.size && p.tools.every((t) => set.has(t)))?.id ?? null;
}

/** One tool turned on or off; the result is in the canonical order. */
export function toggleTool(selected: readonly string[], tool: string, on: boolean): string[] {
  const set = new Set(selected);
  if (on) set.add(tool); else set.delete(tool);
  return ALL_TOOLS.filter((t) => set.has(t));
}

/** The folder's own name, for display where the whole path isn't needed. */
export function folderName(folder: string | null): string {
  if (!folder) return '';
  return folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;
}

/** Minutes left on a question, at least one. */
export function minutesLeft(expiresAt: number, now: number): number {
  return Math.max(1, Math.round((expiresAt - now) / 60_000));
}
