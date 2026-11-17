// ─────────────────────────────────────────────
//  Cascade Desktop — files sent with a message
// ─────────────────────────────────────────────
//
//  A file is uploaded to the local backend first and its id goes with the message
//  (a socket event has no room for an image). Images are shown from the backend
//  through an object URL, since an <img> can't send the session token.

import { useEffect, useState } from 'react';
import type { ChatAttachmentRef } from '../store/index.js';

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
/** As the backend takes them (src/dashboard/run-files.ts): 10 a message, an image up to about 5 MB. */
export const MAX_FILES = 10;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type NewAttachment =
  | { kind: 'image'; mime: string; filename: string | null; data: string }
  | { kind: 'document'; filename: string; text: string };

export async function uploadAttachment(port: number, token: string, file: NewAttachment): Promise<ChatAttachmentRef> {
  const res = await fetch(`http://localhost:${port}/api/attachments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(file),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; kind?: 'image' | 'document'; mime?: string; filename?: string | null; error?: string };
  if (!res.ok || !body.id || !body.kind) throw new Error(body.error ?? 'That file could not be added.');
  return { id: body.id, kind: body.kind, mime: body.mime ?? '', filename: body.filename ?? null };
}

/** An image the user picked or pasted, read for upload; a reason when it can't be. */
export async function readImageFile(file: File): Promise<NewAttachment | { error: string }> {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return { error: `${file.name || 'That file'} isn't a PNG, JPEG, WebP or GIF image.` };
  if (file.size > MAX_IMAGE_BYTES) return { error: `${file.name || 'That image'} is larger than 5 MB.` };
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { kind: 'image', mime: file.type, filename: file.name || null, data: btoa(bin) };
}

/** An image kept by the backend, as a URL an <img> can show; null until it loads. */
export function useAttachmentImage(port: number, token: string, id: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id) return;
    let made: string | null = null;
    let live = true;
    void fetch(`http://localhost:${port}/api/attachments/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => { if (b && live) { made = URL.createObjectURL(b); setUrl(made); } })
      .catch(() => { /* shown as a name instead */ });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [port, token, id]);
  return url;
}

export const attachmentName = (a: Pick<ChatAttachmentRef, 'filename' | 'kind'>): string => a.filename || (a.kind === 'document' ? 'Document' : 'Image');
