// ─────────────────────────────────────────────
//  Cascade AI — files sent with a desktop message
// ─────────────────────────────────────────────
//
//  The desktop app uploads a file first (POST /api/attachments) and then sends its
//  id with the message, as the cloud does: a socket event has no room for an
//  image. A run gets images as images and documents as text before the request,
//  worded as a cloud run words them.

import type { ImageAttachment, MessageAttachmentRef, NewMessageAttachment } from '../types.js';

export const RUN_FILE_LIMITS = {
  /** Files on one message. */
  perMessage: 10,
  /** An image, base64: about 5 MB. */
  imageChars: 7_000_000,
  /** A document's text. */
  documentChars: 8_000_000,
  filename: 200,
  /** Images from earlier in a chat that a continued run is given again, latest first. */
  earlierImages: 4,
} as const;

const IMAGE_MIMES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** An upload's body, checked; refused whole when anything is off. */
export function parseNewAttachment(body: unknown): NewMessageAttachment | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const filename = typeof b['filename'] === 'string' ? b['filename'].trim().slice(0, RUN_FILE_LIMITS.filename) : '';
  if (b['kind'] === 'image') {
    const mime = b['mime'];
    const data = b['data'];
    if (typeof mime !== 'string' || !IMAGE_MIMES.has(mime)) return { error: 'An image must be PNG, JPEG, WebP or GIF.' };
    if (typeof data !== 'string' || !data || !BASE64.test(data)) return { error: 'That image could not be read.' };
    if (data.length > RUN_FILE_LIMITS.imageChars) return { error: 'That image is too large (5 MB at most).' };
    return { kind: 'image', mime, filename: filename || null, data };
  }
  if (b['kind'] === 'document') {
    const text = b['text'];
    if (typeof text !== 'string' || !text.trim()) return { error: 'That document has no text.' };
    if (text.length > RUN_FILE_LIMITS.documentChars) return { error: 'That document is too long.' };
    return { kind: 'document', filename: filename || 'document', text };
  }
  return { error: 'A file must be an image or a document.' };
}

/** The ids a run was sent, as strings, at most a message's worth. */
export function attachmentIdsFrom(raw: unknown): string[] {
  // Bounded before it's walked: a request names at most a message's files.
  if (!Array.isArray(raw) || raw.length > RUN_FILE_LIMITS.perMessage * 2) return [];
  const ids: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const x: unknown = raw[i];
    if (typeof x === 'string' && x.length > 0 && x.length <= 64 && !ids.includes(x)) ids.push(x);
  }
  return ids.slice(0, RUN_FILE_LIMITS.perMessage);
}

/** What a run gets from a message's files. */
export function filesForRun(files: Array<MessageAttachmentRef & { data: string }>): {
  images: ImageAttachment[];
  documents: Array<{ filename: string; text: string }>;
} {
  const images: ImageAttachment[] = [];
  const documents: Array<{ filename: string; text: string }> = [];
  for (const f of files) {
    if (f.kind === 'image' && IMAGE_MIMES.has(f.mime)) images.push({ type: 'base64', data: f.data, mimeType: f.mime as ImageAttachment['mimeType'] });
    else if (f.kind === 'document') documents.push({ filename: f.filename || 'document', text: f.data });
  }
  return { images, documents };
}

/** The request, with any documents before it, as a cloud run puts them. */
export function withDocuments(prompt: string, documents: Array<{ filename: string; text: string }>): string {
  if (!documents.length) return prompt;
  const blocks = documents.map((d) => `<document filename="${d.filename.replace(/"/g, '&quot;')}">\n${d.text}\n</document>`);
  return `The user attached ${documents.length === 1 ? 'a document' : `${documents.length} documents`}. `
    + `Use their contents as context for the request below:\n\n${blocks.join('\n\n')}\n\n---\n\n${prompt}`;
}
