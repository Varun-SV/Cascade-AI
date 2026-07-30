// ─────────────────────────────────────────────
//  Cascade AI — Dead-model memory
// ─────────────────────────────────────────────
//
//  A model id that 404s is dead for this account: wrong id, retired preview,
//  or not enabled for this key. The router already drops it from the candidate
//  pool — but only in memory, and only after something has already paid a call
//  to find out.
//
//  That is not enough, for two reasons the /why panel makes obvious:
//
//    1. A T3 wave runs CONCURRENTLY. Every worker in the wave picks the same
//       per-subtask model, fires at the same moment, and each independently
//       discovers it is dead. One run showed twelve identical
//       `gemini-2.0-flash → gemini-2.5-flash (model not found)` failovers.
//       In-memory removal cannot help a simultaneous burst — the first worker
//       hasn't recorded anything by the time the twelfth has already called.
//    2. The memory dies with the process. Tomorrow's run pays the same twelve
//       calls to learn the same fact.
//
//  So the verdict is persisted, and consulted BEFORE selection rather than
//  after failure. The burst still happens once; it never happens again.
//
//  Entries EXPIRE. This is the load-bearing design choice: a model that 404s
//  today may exist next month — previews get promoted, quotas get granted,
//  regions light up. A permanent blocklist would quietly and unfixably shrink
//  the routing pool over time, and the user would have no idea why their best
//  model stopped being chosen. A stale entry costs one wasted call to
//  rediscover; a permanent one costs the model forever.
//
//  "The burst never happens again" only holds if persistence actually
//  persists. It didn't: fileDeadModelPersistence used a dynamic require('fs')
//  inside its function bodies, on the theory that this runs in the router's
//  constructor path and needs to stay synchronous. That reasoning doesn't
//  hold — a static import is exactly as synchronous as a dynamic require; only
//  the fs function called determines sync vs async, not how the module got
//  in. And in the ESM build (what `bin/cascade.js` actually runs), esbuild's
//  __require shim has no real `require` to fall back to and throws "Dynamic
//  require of \"fs\" is not supported" — silently swallowed by restore()'s and
//  flush()'s own try/catch as "best-effort," so the file was never actually
//  read or written. Every run started amnesiac and repaid the whole burst.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** How long a dead verdict stands before the model is retried. */
export const DEAD_MODEL_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface DeadModelRecord {
  /** `provider:modelId` — the same key shape the failover event reports. */
  key: string;
  provider: string;
  modelId: string;
  /** Provider's own words, kept verbatim so the user can act on them. */
  reason: string;
  firstSeenAt: number;
  lastSeenAt: number;
  /** How many times this model has been found dead. */
  hits: number;
}

/**
 * Where records live between runs. Desktop/CLI back this with a JSON file,
 * the cloud server with a per-user table. Both are synchronous-optional: a
 * store that fails to load must never stop a run.
 */
export interface DeadModelPersistence {
  load(): DeadModelRecord[];
  save(records: DeadModelRecord[]): void;
}

export function deadModelKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

export class DeadModelStore {
  private records = new Map<string, DeadModelRecord>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(
    private persistence?: DeadModelPersistence,
    opts: { ttlMs?: number; now?: () => number } = {},
  ) {
    this.ttlMs = opts.ttlMs ?? DEAD_MODEL_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.restore();
  }

  private restore(): void {
    if (!this.persistence) return;
    try {
      for (const r of this.persistence.load()) {
        if (!this.isExpired(r)) this.records.set(r.key, r);
      }
    } catch {
      // A corrupt or unreadable store must not stop a run — the cost of
      // ignoring it is rediscovering dead models, which is where we started.
    }
  }

  private isExpired(r: DeadModelRecord): boolean {
    return this.now() - r.lastSeenAt > this.ttlMs;
  }

  private flush(): void {
    if (!this.persistence) return;
    try {
      this.persistence.save([...this.records.values()]);
    } catch { /* best-effort; see restore() */ }
  }

  /**
   * Record that a model was found dead. Returns true when this is the first
   * time (so the caller can log it once rather than once per concurrent
   * worker in the wave that discovered it).
   */
  record(provider: string, modelId: string, reason: string): boolean {
    const key = deadModelKey(provider, modelId);
    const now = this.now();
    const existing = this.records.get(key);
    if (existing && !this.isExpired(existing)) {
      existing.lastSeenAt = now;
      existing.hits += 1;
      this.flush();
      return false;
    }
    this.records.set(key, {
      key, provider, modelId, reason,
      firstSeenAt: now, lastSeenAt: now, hits: 1,
    });
    this.flush();
    return true;
  }

  /** True when this model is known dead and the verdict has not expired. */
  isDead(provider: string, modelId: string): boolean {
    const r = this.records.get(deadModelKey(provider, modelId));
    if (!r) return false;
    if (this.isExpired(r)) {
      // Expired verdicts are dropped on read, so the model becomes selectable
      // again without needing a separate sweep.
      this.records.delete(r.key);
      this.flush();
      return false;
    }
    return true;
  }

  /** Why a model is considered dead, for /why and the models command. */
  reasonFor(provider: string, modelId: string): string | null {
    const r = this.records.get(deadModelKey(provider, modelId));
    return r && !this.isExpired(r) ? r.reason : null;
  }

  /** Live records, expired ones filtered out. */
  list(): DeadModelRecord[] {
    const live = [...this.records.values()].filter((r) => !this.isExpired(r));
    return live.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /**
   * Forget a verdict — used when the user fixes the underlying problem (adds
   * the model to their project, gets quota) and wants it retried now rather
   * than after the TTL.
   */
  forget(provider: string, modelId: string): boolean {
    const removed = this.records.delete(deadModelKey(provider, modelId));
    if (removed) this.flush();
    return removed;
  }

  clear(): void {
    this.records.clear();
    this.flush();
  }
}

/** File-backed persistence for desktop and CLI. */
export function fileDeadModelPersistence(filePath: string): DeadModelPersistence {
  return {
    load(): DeadModelRecord[] {
      if (!existsSync(filePath)) return [];
      const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
      return Array.isArray(raw) ? raw as DeadModelRecord[] : [];
    },
    save(records: DeadModelRecord[]): void {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(records, null, 2));
    },
  };
}
