// ─────────────────────────────────────────────
//  Desktop → Cascade Cloud — Conversation Handoff Client
// ─────────────────────────────────────────────
//
// "Open-and-continue" between the desktop app and the web app. The desktop
// backend is local and keyless w.r.t. the cloud, so it talks to the cloud's
// short-lived handoff courier (see cloud/server/src/handoff.ts) over plain,
// unauthenticated HTTPS: POST a transcript → get a code; GET a code → the
// transcript. The code is the only bearer secret; nothing is stored durably.

import type { ChatAttachmentRef } from '../store/index.js';
import type { NewAttachment } from './attachments.js';

/** A file with a message: an image's bytes, or a document's text (carried web → desktop). */
export type HandoffAttachment =
  | { kind: 'image'; mime: string; filename: string | null; data: string }
  | { kind: 'document'; filename: string; text: string };

export interface HandoffMessage {
  role: string;
  content: string;
  attachments?: HandoffAttachment[];
}

/**
 * Keep a redeemed chat's files in the local backend, each message with the ids of
 * its own. One the backend won't take is named, so it isn't lost silently.
 */
export async function keepHandoffFiles(
  messages: HandoffMessage[],
  upload: (file: NewAttachment) => Promise<ChatAttachmentRef>,
): Promise<{ messages: Array<HandoffMessage & { files: ChatAttachmentRef[] }>; missed: string[] }> {
  const missed: string[] = [];
  const out: Array<HandoffMessage & { files: ChatAttachmentRef[] }> = [];
  for (const m of messages) {
    const files: ChatAttachmentRef[] = [];
    for (const a of m.attachments ?? []) {
      try {
        files.push(await upload(a));
      } catch {
        missed.push(a.filename || (a.kind === 'document' ? 'a document' : 'an image'));
      }
    }
    out.push({ role: m.role, content: m.content, files });
  }
  return { messages: out, missed };
}

export interface HandoffSnapshot {
  title: string | null;
  skillId: string | null;
  messages: HandoffMessage[];
  expiresAt: number;
}

// The hosted cloud origin. Overridable for dev / self-host via a localStorage
// key or a global, so a local cloud server can be targeted without a rebuild.
export function cloudBaseUrl(): string {
  try {
    const override = localStorage.getItem('cascade-cloud-url');
    if (override && /^https?:\/\//.test(override)) return override.replace(/\/+$/, '');
  } catch {
    /* localStorage unavailable */
  }
  const g = (globalThis as { __CASCADE_CLOUD_URL__?: string }).__CASCADE_CLOUD_URL__;
  if (g && /^https?:\/\//.test(g)) return g.replace(/\/+$/, '');
  return 'https://cascadeai.in';
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  return body.error ?? fallback;
}

/** Snapshot a transcript into a short-lived code to pick up on the web. */
export async function createCloudHandoff(input: {
  title: string | null;
  skillId: string | null;
  messages: HandoffMessage[];
}): Promise<{ code: string; expiresAt: number }> {
  const res = await fetch(`${cloudBaseUrl()}/api/handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Request failed: ${res.status}`));
  return res.json() as Promise<{ code: string; expiresAt: number }>;
}

/** Redeem a code minted on the web → its transcript snapshot. */
export async function fetchCloudHandoff(code: string): Promise<HandoffSnapshot> {
  const res = await fetch(`${cloudBaseUrl()}/api/handoff/${encodeURIComponent(code)}`);
  if (!res.ok) throw new Error(await errorMessage(res, 'That code is invalid or has expired.'));
  return res.json() as Promise<HandoffSnapshot>;
}
