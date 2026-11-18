import { describe, expect, it, vi } from 'vitest';
import { keepHandoffFiles } from './cloudHandoff.js';

describe('a chat redeemed from the web keeps its files here', () => {
  it('each message gets the ids of its own files; one not taken is named, not dropped', async () => {
    let n = 0;
    const upload = vi.fn(async (f: { kind: string; filename: string | null }) => {
      if (f.filename === 'huge.pdf') throw new Error('That document is too long.');
      n += 1;
      return { id: `f${n}`, kind: f.kind as 'image' | 'document', mime: '', filename: f.filename };
    });
    const out = await keepHandoffFiles([
      { role: 'user', content: 'earlier', attachments: [{ kind: 'document', filename: 'notes.txt', text: 'n' }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'open these', attachments: [
        { kind: 'image', mime: 'image/png', filename: null, data: 'QUJD' },
        { kind: 'document', filename: 'huge.pdf', text: 'x' },
      ] },
    ], upload);
    expect(out.messages.map((m) => m.files.map((f) => f.id))).toEqual([['f1'], [], ['f2']]);
    expect(out.messages[2]).toMatchObject({ role: 'user', content: 'open these' });
    expect(out.missed).toEqual(['huge.pdf']);
    expect(upload).toHaveBeenCalledTimes(3);
  });
});
