// ─────────────────────────────────────────────
//  Cascade Cloud Server — Pending (unsaved) media
// ─────────────────────────────────────────────
//
// A generated image or video is real binary that only exists because a
// server-side tool call produced it — unlike a text/office export, the browser
// has no source to re-render, so "don't store it until they ask" cannot mean
// "don't store it at all". It is parked here instead: bytes under the tenant's
// `tmp-media/` directory plus a `pending_media` row, outside the plan's storage
// quota, until the user either saves it (promotion into `files`, which is where
// the quota is charged) or lets it expire.
//
// Two things delete it. Callers sweep opportunistically at the natural entry
// points — the convention every other expiring artifact in this server follows
// (native-auth flows, the MCP-OAuth registry, the handoff store all sweep on
// access) — and `startPendingMediaSweeper` covers the case that convention
// cannot: a user who generated an image and never came back. Nothing else in
// this process reads that row again, so without a timer those bytes would sit
// on the volume forever.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { CloudEnv } from './env.js';
import type { CloudStore } from './db.js';
import { tenantScratchDir } from './paths.js';

/** Where unsaved generated media lives — sibling of the tenant's `files` dir. */
export function pendingMediaDir(env: CloudEnv, userId: string): string {
  return path.join(tenantScratchDir(env, userId), 'tmp-media');
}

/** Absolute path of one pending asset's bytes. Ids are server-generated. */
export function pendingMediaPath(env: CloudEnv, userId: string, id: string): string {
  return path.join(pendingMediaDir(env, userId), id);
}

/**
 * Delete every pending asset past its expiry — the DB row AND the bytes.
 *
 * The row is dropped only after the unlink is attempted, and a missing file is
 * not an error (it may already have been swept, or promoted): the invariant
 * worth protecting is that no row outlives its bytes claim on the volume.
 * Returns how many assets were removed.
 */
export async function sweepPendingMedia(env: CloudEnv, store: CloudStore, now = Date.now()): Promise<number> {
  const expired = store.listExpiredPendingMedia(now);
  for (const asset of expired) {
    try {
      await fs.rm(pendingMediaPath(env, asset.userId, asset.id), { force: true });
    } catch { /* best effort — the row still goes, so the space is reclaimable */ }
    store.deletePendingMediaById(asset.id);
  }
  return expired.length;
}

/** Fire-and-forget sweep for request paths that must not wait on disk I/O. */
export function sweepPendingMediaInBackground(env: CloudEnv, store: CloudStore, now = Date.now()): void {
  void sweepPendingMedia(env, store, now).catch(() => { /* best effort */ });
}

/** How often the background sweeper runs (hourly — the TTL is measured in days). */
export const PENDING_MEDIA_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Start the periodic sweep. Returns a stop function.
 *
 * `unref()` so a pending timer never holds the process open (tests, a graceful
 * shutdown); the interval is hourly because the TTL is a day — precision here
 * buys nothing and the sweep is one indexed DELETE plus a handful of unlinks.
 */
export function startPendingMediaSweeper(
  env: CloudEnv,
  store: CloudStore,
  intervalMs = PENDING_MEDIA_SWEEP_INTERVAL_MS,
): () => void {
  // Sweep once at boot too: a redeploy is exactly when a long-dead asset from
  // before the restart is most likely to be sitting around.
  sweepPendingMediaInBackground(env, store);
  const timer = setInterval(() => sweepPendingMediaInBackground(env, store), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
