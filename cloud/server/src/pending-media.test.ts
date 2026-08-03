import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CloudStore } from './db.js';
import type { CloudEnv } from './env.js';
import {
  pendingMediaDir, pendingMediaPath, sweepPendingMedia, startPendingMediaSweeper,
  PENDING_MEDIA_SWEEP_INTERVAL_MS,
} from './pending-media.js';
import { PENDING_MEDIA_TTL_MS } from './entitlements.js';

describe('pending media sweeper', () => {
  let dir = '';
  let store: CloudStore | null = null;

  afterEach(async () => {
    store?.close();
    store = null;
    if (dir) await fs.rm(dir, { recursive: true, force: true });
    dir = '';
    vi.useRealTimers();
  });

  const setup = async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cascade-cloud-sweep-'));
    store = new CloudStore(path.join(dir, 'cloud.db'));
    const env = { DATA_DIR: dir } as CloudEnv;
    const user = store.upsertUser({ provider: 'dev', providerId: 'sweep', email: null, name: null, avatar: null });
    return { store, env, user };
  };

  /** A pending asset with bytes on disk, expiring `inMs` from now. */
  const park = async (
    store: CloudStore, env: CloudEnv, userId: string, name: string, inMs: number,
  ): Promise<string> => {
    const media = store.addPendingMedia({
      userId, conversationId: null, name, mime: 'image/png', size: 8, expiresAt: Date.now() + inMs,
    });
    await fs.mkdir(pendingMediaDir(env, userId), { recursive: true });
    await fs.writeFile(pendingMediaPath(env, userId, media.id), Buffer.from('12345678'));
    return media.id;
  };

  it('deletes the row AND the bytes of expired media, leaving fresh media alone', async () => {
    const { store, env, user } = await setup();
    const expired = await park(store, env, user.id, 'old.png', -1000);
    const fresh = await park(store, env, user.id, 'new.png', PENDING_MEDIA_TTL_MS);

    const removed = await sweepPendingMedia(env, store);

    expect(removed).toBe(1);
    // Expired: gone from the DB and gone from the volume. Deleting only the
    // row would leave bytes nothing ever reclaims.
    expect(store.getPendingMedia(expired, user.id)).toBeNull();
    await expect(fs.readFile(pendingMediaPath(env, user.id, expired))).rejects.toThrow();
    // Fresh: untouched, still listed, still readable.
    expect(store.listPendingMedia(user.id).map((m) => m.id)).toEqual([fresh]);
    expect((await fs.readFile(pendingMediaPath(env, user.id, fresh))).length).toBe(8);
    expect(store.sumUserPendingMediaBytes(user.id)).toBe(8);
  });

  it('never touches saved files, only pending media', async () => {
    const { store, env, user } = await setup();
    const saved = store.addFile({ userId: user.id, conversationId: null, name: 'kept.png', mime: 'image/png', size: 8 });
    await fs.mkdir(path.join(dir, 'tenants', user.id, 'files'), { recursive: true });
    await fs.writeFile(path.join(dir, 'tenants', user.id, 'files', saved.id), Buffer.from('12345678'));
    await park(store, env, user.id, 'old.png', -1000);

    await sweepPendingMedia(env, store);

    // A file the user explicitly saved is permanent — expiry is a property of
    // the pending area only.
    expect(store.getFile(saved.id, user.id)).not.toBeNull();
    expect((await fs.readFile(path.join(dir, 'tenants', user.id, 'files', saved.id))).length).toBe(8);
    expect(store.sumUserFileBytes(user.id)).toBe(8);
  });

  it('sweeps every tenant, not just the one that happens to be active', async () => {
    const { store, env } = await setup();
    const a = store.upsertUser({ provider: 'dev', providerId: 'a', email: null, name: null, avatar: null });
    const b = store.upsertUser({ provider: 'dev', providerId: 'b', email: null, name: null, avatar: null });
    await park(store, env, a.id, 'a.png', -1);
    await park(store, env, b.id, 'b.png', -1);

    expect(await sweepPendingMedia(env, store)).toBe(2);
    expect(store.listExpiredPendingMedia(Date.now())).toHaveLength(0);
  });

  it('drops the row even when the bytes have already vanished', async () => {
    const { store, env, user } = await setup();
    const id = await park(store, env, user.id, 'ghost.png', -1);
    await fs.rm(pendingMediaPath(env, user.id, id));

    // A missing file is not an error: what must not survive is a row claiming
    // bytes that aren't there (it would keep spending the pending allowance).
    expect(await sweepPendingMedia(env, store)).toBe(1);
    expect(store.getPendingMedia(id, user.id)).toBeNull();
  });

  it('the background sweeper runs at boot and on its interval, and stops when told', async () => {
    vi.useFakeTimers();
    const { store, env, user } = await setup();
    await park(store, env, user.id, 'boot.png', -1);

    const stop = startPendingMediaSweeper(env, store);
    // The boot sweep is deliberate: a redeploy is when the longest-dead asset
    // is most likely to be sitting around with nobody about to read it.
    await vi.waitFor(() => expect(store.listExpiredPendingMedia(Date.now())).toHaveLength(0));

    await park(store, env, user.id, 'later.png', -1);
    await vi.advanceTimersByTimeAsync(PENDING_MEDIA_SWEEP_INTERVAL_MS + 10);
    // The sweep itself is async (unlinks), so settle it rather than assuming
    // the timer callback finished the instant it fired.
    await vi.waitFor(() => expect(store.listExpiredPendingMedia(Date.now())).toHaveLength(0));

    stop();
    await park(store, env, user.id, 'after-stop.png', -1);
    await vi.advanceTimersByTimeAsync(PENDING_MEDIA_SWEEP_INTERVAL_MS * 3);
    expect(store.listExpiredPendingMedia(Date.now())).toHaveLength(1);
  });
});
