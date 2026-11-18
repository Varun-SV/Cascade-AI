import { describe, expect, it, vi } from 'vitest';
import { desktopHandoffNotice, handoffFiles } from './desktopHandoff.js';

describe('handing a message to the desktop app', () => {
  it('says nothing of files when there are none', () => {
    expect(desktopHandoffNotice([])).not.toMatch(/with it|couldn't/);
  });

  it('says which files go with it, and names any that could not be read', () => {
    expect(desktopHandoffNotice(['report.pdf'])).toMatch(/report\.pdf goes with it\./);
    expect(desktopHandoffNotice(['a.png', 'b.pdf'], ['c.png'])).toMatch(/a\.png, b\.pdf go with it\. c\.png couldn't be read: attach it again in the app\./);
  });

  it('reads images as their bytes and documents as their text; a failure is named, not dropped', async () => {
    const image = vi.fn(async (id: string) => {
      if (id === 'gone') throw new Error('404');
      return { mime: 'image/png', data: 'QUJD' };
    });
    const text = vi.fn(async () => ({ filename: 'server-name.pdf', text: 'the text' }));
    const out = await handoffFiles([
      { id: 'i1', mime: 'image/png', kind: 'image', filename: 'shot.png' },
      { id: 'd1', mime: 'application/pdf', kind: 'document', filename: null },
      { id: 'gone', mime: 'image/jpeg', kind: 'image', filename: null },
    ], { image, text });
    expect(out.files).toEqual([
      { kind: 'image', mime: 'image/png', filename: 'shot.png', data: 'QUJD' },
      { kind: 'document', filename: 'server-name.pdf', text: 'the text' },
    ]);
    expect(out.missed).toEqual(['an image']);
  });
});
