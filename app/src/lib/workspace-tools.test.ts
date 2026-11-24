import { describe, expect, it } from 'vitest';
import { ALL_TOOLS, PRESETS, folderName, minutesLeft, presetOfSelection, toggleTool } from './workspace-tools.js';

describe('workspace tool choices', () => {
  it('names a preset only when the selection is exactly it', () => {
    expect(presetOfSelection(PRESETS[0].tools)).toBe('read');
    expect(presetOfSelection(PRESETS[1].tools)).toBe('edit');
    expect(presetOfSelection(ALL_TOOLS)).toBe('all');
    expect(presetOfSelection(['file_read', 'shell'])).toBeNull();
  });
  it('toggles one tool and keeps the canonical order', () => {
    expect(toggleTool(['file_read'], 'shell', true)).toEqual(['file_read', 'shell']);
    expect(toggleTool(['file_read', 'shell'], 'file_read', false)).toEqual(['shell']);
    expect(toggleTool([], 'nope', true)).toEqual([]);
  });
  it('shows a folder by its own name and a question\'s time left as at least a minute', () => {
    expect(folderName('/home/a/proj')).toBe('proj');
    expect(folderName('C:\\x\\proj\\')).toBe('proj');
    expect(folderName(null)).toBe('');
    expect(minutesLeft(1000, 0)).toBe(1);
    expect(minutesLeft(5 * 60_000, 0)).toBe(5);
  });
});
