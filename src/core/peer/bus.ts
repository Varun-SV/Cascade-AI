// ─────────────────────────────────────────────
//  Cascade AI — Peer-to-Peer Coordination Bus
// ─────────────────────────────────────────────

import EventEmitter from 'node:events';
import type { PeerMessage, PeerMessageEvent, PeerSyncType } from '../../types.js';

interface PeerOutput {
  subtaskId: string;
  fromId: string;
  output: string;
  status: 'COMPLETED' | 'FAILED' | 'ESCALATED';
  timestamp: string;
}

/**
 * PeerBus enables T3↔T3 and T2↔T2 communication within a task.
 * Each T2Manager creates one PeerBus and shares it with its T3Workers.
 * T1 creates one PeerBus and shares it with its T2Managers.
 */
interface BroadcastMessage {
  fromId: string;
  payload: unknown;
  timestamp: string;
}

interface FileLock {
  holderId: string;
  lockedAt: string;
  waiters: Array<() => void>;
}

export class PeerBus extends EventEmitter {
  private outputs: Map<string, PeerOutput> = new Map();
  private waiters: Map<string, Array<(output: PeerOutput) => void>> = new Map();
  private members: Set<string> = new Set();
  private barriers: Map<string, { total: number; arrived: Set<string> }> = new Map();
  private broadcastLog: BroadcastMessage[] = [];
  private fileLocks: Map<string, FileLock> = new Map();
  /** subtaskIds whose T3 is being retried by T2 — dependents should re-wait rather than fail fast */
  private retryPending: Set<string> = new Set();

  /** Called when any peer message or broadcast is sent — used for dashboard visibility. */
  onPeerMessage?: (event: PeerMessageEvent) => void;
  sessionId = '';

  register(peerId: string): void {
    this.members.add(peerId);
  }

  /**
   * Publish output — unblocks any peers waiting on this subtaskId
   */
  publish(fromId: string, subtaskId: string, output: string, status: PeerOutput['status']): void {
    const entry: PeerOutput = {
      subtaskId,
      fromId,
      output,
      status,
      timestamp: new Date().toISOString(),
    };

    this.outputs.set(subtaskId, entry);
    this.emit('output:ready', entry);

    // Resolve waiters
    const waiting = this.waiters.get(subtaskId) ?? [];
    for (const resolve of waiting) resolve(entry);
    this.waiters.delete(subtaskId);
  }

  /**
   * Mark a subtask as retry-pending so dependents re-wait instead of failing fast
   * when they see an ESCALATED status.
   */
  markRetryPending(subtaskId: string): void {
    this.retryPending.add(subtaskId);
    // Remove the cached ESCALATED output so waitFor() blocks for the retry result
    this.outputs.delete(subtaskId);
  }

  /** Called by T2 after retry resolves (success or final failure). */
  clearRetryPending(subtaskId: string): void {
    this.retryPending.delete(subtaskId);
  }

  isRetryPending(subtaskId: string): boolean {
    return this.retryPending.has(subtaskId);
  }

  /**
   * Wait for a specific subtask's output — resolves immediately if already available.
   * If the output is ESCALATED but a retry is pending, waits for the retry result.
   */
  waitFor(subtaskId: string, timeoutMs = 120_000): Promise<PeerOutput> {
    const existing = this.outputs.get(subtaskId);
    if (existing && !this.retryPending.has(subtaskId)) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const resolver = (output: PeerOutput) => {
        clearTimeout(timer);
        resolve(output);
      };

      const timer = setTimeout(() => {
        // Remove this specific resolver so publish() cannot call it after rejection
        const waiting = this.waiters.get(subtaskId);
        if (waiting) {
          const idx = waiting.indexOf(resolver);
          if (idx !== -1) waiting.splice(idx, 1);
          if (waiting.length === 0) this.waiters.delete(subtaskId);
        }
        reject(new Error(`Peer timeout waiting for subtask: ${subtaskId}`));
      }, timeoutMs);

      const resolvers = this.waiters.get(subtaskId) ?? [];
      resolvers.push(resolver);
      this.waiters.set(subtaskId, resolvers);
    });
  }

  /**
   * Get output if already available (non-blocking)
   */
  getOutput(subtaskId: string): PeerOutput | undefined {
    return this.outputs.get(subtaskId);
  }

  /**
   * Broadcast a message to all registered peers except sender.
   * Also logs to broadcastLog so collect() can retrieve recent broadcasts.
   */
  broadcast(fromId: string, payload: unknown): void {
    const timestamp = new Date().toISOString();
    const msg: PeerMessage = {
      fromId,
      toId: '*',
      type: 'SYNC_DATA',
      subtaskId: '',
      syncType: 'SHARE_OUTPUT',
      payload,
      timestamp,
    };
    this.broadcastLog.push({ fromId, payload, timestamp });
    this.emit('broadcast', msg);
    this.onPeerMessage?.({
      fromId,
      toId: undefined,
      syncType: 'SHARE_OUTPUT',
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      timestamp,
      sessionId: this.sessionId,
    });
  }

  /**
   * Collect all broadcast messages received within a time window.
   * Useful for T2 announcement gathering — call immediately after triggering broadcasts.
   */
  collect(timeoutMs: number): Promise<BroadcastMessage[]> {
    const collected: BroadcastMessage[] = [...this.broadcastLog];
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        off();
        resolve(collected);
      }, timeoutMs);

      const handler = (msg: PeerMessage) => {
        collected.push({ fromId: msg.fromId, payload: msg.payload, timestamp: msg.timestamp });
      };
      this.on('broadcast', handler);

      const off = () => {
        clearTimeout(timer);
        this.off('broadcast', handler);
      };

      // Also resolve early if all members have broadcast
      const checkComplete = () => {
        const broadcasters = new Set(collected.map(m => m.fromId));
        if (broadcasters.size >= this.members.size) {
          off();
          resolve(collected);
        }
      };
      this.on('broadcast', checkComplete);
    });
  }

  /**
   * Acquire an exclusive file lock — prevents concurrent T3 writes to the same file.
   * If the file is already locked, waits until the lock is released.
   */
  async lockFile(tierId: string, filePath: string, timeoutMs = 30_000): Promise<void> {
    const existing = this.fileLocks.get(filePath);
    if (!existing) {
      this.fileLocks.set(filePath, { holderId: tierId, lockedAt: new Date().toISOString(), waiters: [] });
      return;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`File lock timeout for ${filePath} (held by ${existing.holderId})`));
      }, timeoutMs);

      existing.waiters.push(() => {
        clearTimeout(timer);
        // Re-acquire for this tier
        this.fileLocks.set(filePath, { holderId: tierId, lockedAt: new Date().toISOString(), waiters: [] });
        resolve();
      });
    });
  }

  /**
   * Release a file lock — unblocks the next waiter if any.
   */
  releaseFile(tierId: string, filePath: string): void {
    const lock = this.fileLocks.get(filePath);
    if (!lock || lock.holderId !== tierId) return;

    const nextWaiter = lock.waiters.shift();
    if (nextWaiter) {
      nextWaiter();
    } else {
      this.fileLocks.delete(filePath);
    }
    this.emit(`file:released:${filePath}`, { tierId, filePath });
  }

  /**
   * Wait until a file lock is released (non-acquiring — just observes).
   * Used by T3s that want to read after another T3 finishes writing.
   */
  waitForFileRelease(filePath: string, timeoutMs = 30_000): Promise<void> {
    if (!this.fileLocks.has(filePath)) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for file release: ${filePath}`)), timeoutMs);
      this.once(`file:released:${filePath}`, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  /**
   * Check if a file is currently locked (non-blocking).
   */
  isFileLocked(filePath: string): boolean {
    return this.fileLocks.has(filePath);
  }

  /**
   * Clear broadcast log — call between phases to avoid stale announcements.
   */
  clearBroadcastLog(): void {
    this.broadcastLog = [];
  }

  /**
   * Send a targeted message to a specific peer
   */
  send(
    fromId: string,
    toId: string,
    syncType: PeerSyncType,
    subtaskId: string,
    payload: unknown,
  ): void {
    const timestamp = new Date().toISOString();
    const msg: PeerMessage = {
      fromId,
      toId,
      type: 'SYNC_DATA',
      subtaskId,
      syncType,
      payload,
      timestamp,
    };
    this.emit(`message:${toId}`, msg);
    this.emit('message', msg);
    this.onPeerMessage?.({
      fromId,
      toId,
      syncType: syncType ?? 'SHARE_OUTPUT',
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      timestamp,
      sessionId: this.sessionId,
    });
  }

  /**
   * Barrier — wait until N peers have all reached this point
   * Useful for fan-in synchronization
   */
  async barrier(peerId: string, barrierName: string, totalPeers: number): Promise<void> {
    if (!this.barriers.has(barrierName)) {
      this.barriers.set(barrierName, { total: totalPeers, arrived: new Set() });
    }

    const bar = this.barriers.get(barrierName)!;
    bar.arrived.add(peerId);

    if (bar.arrived.size >= bar.total) {
      this.emit(`barrier:${barrierName}`);
      return;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Barrier timeout: ${barrierName} (${bar.arrived.size}/${bar.total} arrived)`));
      }, 120_000);

      this.once(`barrier:${barrierName}`, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  getAllOutputs(): PeerOutput[] {
    return Array.from(this.outputs.values());
  }

  getMembers(): string[] {
    return Array.from(this.members);
  }
}
