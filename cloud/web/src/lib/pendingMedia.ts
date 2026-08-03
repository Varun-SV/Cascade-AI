import { useEffect, useState } from 'react';
import { fetchPendingMedia, type PendingMedia } from './api.js';

/**
 * Which generated images/videos in this account are still *unsaved*.
 *
 * A transcript only carries `![alt](/api/files/<id>)` — the same URL a saved
 * file has, deliberately, so the picture renders identically either way. That
 * leaves one question the markdown cannot answer: will this still be here
 * tomorrow? The server's `/api/pending-media` listing answers it, and it is
 * fetched (not remembered from the socket event that announced the asset) so a
 * page reload mid-conversation still shows the expiry badge and the Save
 * button rather than silently losing the chance to keep the image.
 *
 * Shared module state rather than per-component fetches: several messages in a
 * chat can each embed media and they'd otherwise each ask.
 */
let items: PendingMedia[] = [];
/**
 * Saved in THIS session. The item stays in `items` (so its card keeps
 * rendering with its metadata) and this marks it as done, surviving a remount
 * — pressing Save twice would hit a promoted row and read as an error. A
 * reload drops both, by which point the asset is a normal saved file with
 * nothing temporary to say about it.
 */
let saved = new Set<string>();
let loaded = false;
let inflight: Promise<void> | null = null;

export interface PendingMediaSnapshot {
  media: PendingMedia[];
  savedIds: Set<string>;
}

let snapshot: PendingMediaSnapshot = { media: items, savedIds: saved };
const listeners = new Set<(s: PendingMediaSnapshot) => void>();

function publish(): void {
  snapshot = { media: items, savedIds: saved };
  for (const l of listeners) l(snapshot);
}

/** Re-read the server's list. Failures are silent — this is a badge, not data. */
export function refreshPendingMedia(): Promise<void> {
  if (inflight) return inflight;
  inflight = fetchPendingMedia()
    .then(({ media }) => {
      items = media;
      // Forget save-marks for anything the server no longer lists, so the set
      // can't grow without bound across a long session.
      const live = new Set(media.map((m) => m.id));
      saved = new Set([...saved].filter((id) => live.has(id)));
      loaded = true;
      publish();
    })
    .catch(() => { /* not signed in / offline — no badge is better than a crash */ })
    .finally(() => { inflight = null; });
  return inflight;
}

/** Record a successful save so the card can show it and not offer Save again. */
export function markPendingMediaSaved(id: string): void {
  if (saved.has(id)) return;
  saved = new Set(saved).add(id);
  publish();
}

/**
 * Subscribe to the pending list. `enabled` is false for the many messages that
 * embed no media at all — those must not trigger the fetch.
 */
export function usePendingMedia(enabled: boolean): PendingMediaSnapshot {
  const [snap, setSnap] = useState(snapshot);
  useEffect(() => {
    if (!enabled) return;
    listeners.add(setSnap);
    setSnap(snapshot);
    if (!loaded) void refreshPendingMedia();
    return () => { listeners.delete(setSnap); };
  }, [enabled]);
  return enabled ? snap : snapshot;
}

/** Test-only: module state otherwise leaks between cases. */
export function _resetPendingMediaForTests(): void {
  items = [];
  saved = new Set();
  loaded = false;
  inflight = null;
  snapshot = { media: items, savedIds: saved };
  listeners.clear();
}
