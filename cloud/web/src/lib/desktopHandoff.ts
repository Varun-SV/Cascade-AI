// Run on my desktop (Settings → Browser): a message that needs the browser is handed to
// the desktop app with a one-time code. Its files go with it: images as their bytes,
// documents as the text a run reads from them.

import type { ChatAttachment } from '../chat/useChatSession.js';
import { fetchUploadBase64, fetchUploadText, type HandoffAttachment } from './api.js';

const nameOf = (a: Pick<ChatAttachment, 'filename' | 'kind'>): string => a.filename || (a.kind === 'document' ? 'a document' : 'an image');

/** The message's files, read for the handoff; any that can't be read are named instead. */
export async function handoffFiles(
  attachments: ChatAttachment[],
  get: { image: typeof fetchUploadBase64; text: typeof fetchUploadText } = { image: fetchUploadBase64, text: fetchUploadText },
): Promise<{ files: HandoffAttachment[]; missed: string[] }> {
  const files: HandoffAttachment[] = [];
  const missed: string[] = [];
  for (const a of attachments) {
    try {
      if (a.kind === 'document') {
        const d = await get.text(a.id);
        files.push({ kind: 'document', filename: a.filename || d.filename, text: d.text });
      } else {
        const img = await get.image(a.id);
        files.push({ kind: 'image', mime: img.mime || a.mime, filename: a.filename ?? null, data: img.data });
      }
    } catch {
      missed.push(nameOf(a));
    }
  }
  return { files, missed };
}

/** What the desktop handoff says first: which files go with it, and any that couldn't. */
export function desktopHandoffNotice(sent: string[], missed: string[] = []): string {
  let out = 'Browser runs happen in your desktop app (Settings → Browser). Send this chat there to run it; the reply comes back here when the app syncs.';
  if (sent.length) out += ` ${sent.join(', ')} ${sent.length === 1 ? 'goes' : 'go'} with it.`;
  if (missed.length) out += ` ${missed.join(', ')} couldn't be read: attach ${missed.length === 1 ? 'it' : 'them'} again in the app.`;
  return out;
}

export const handoffFileName = (f: HandoffAttachment): string => f.filename || (f.kind === 'document' ? 'a document' : 'an image');
