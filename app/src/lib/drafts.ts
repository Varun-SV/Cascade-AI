// ─────────────────────────────────────────────
//  Cascade Desktop — messages waiting to be sent
// ─────────────────────────────────────────────
//
//  A chat handed over from the web can end on a message to send here. It waits in
//  that session's composer until sent, whether or not the dialog that imported it
//  is still open, and across restarts. Its files are held for the session by the
//  backend (POST /api/attachments/hold), so they're there when it's sent.

import type { ComposerDraft } from '../store/index.js';

const KEY = 'cascade-composer-drafts';

export function loadDrafts(): Record<string, ComposerDraft> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, ComposerDraft> = {};
    for (const [id, d] of Object.entries(raw as Record<string, unknown>)) {
      const draft = d as Partial<ComposerDraft> | null;
      if (draft && draft.sessionId === id && typeof draft.prompt === 'string' && Array.isArray(draft.attachments)) {
        out[id] = { sessionId: id, prompt: draft.prompt, attachments: draft.attachments };
      }
    }
    return out;
  } catch {
    return {};
  }
}

export function saveDrafts(drafts: Record<string, ComposerDraft>): void {
  try { localStorage.setItem(KEY, JSON.stringify(drafts)); } catch { /* storage unavailable: kept for this window */ }
}
