// ─────────────────────────────────────────────
//  Cascade AI — Peer-to-Peer Coordination Bus
// ─────────────────────────────────────────────

import EventEmitter from 'node:events';
import type { PeerMessage, PeerSyncType } from '../../types.js';

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
export class PeerBus extends EventEmitter {
  private outputs: Map<string, PeerOutput> = new Map();
  private waiters: Map<string, Array<(output: PeerOutput) => void>> = new Map();
  private members: Set<string> = new Set();
  private barriers: Map<string, { total: number; arrived: Set<string> }> = new Map();

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
   * Wait for a specific subtask's output — resolves immediately if already available
   */
  waitFor(subtaskId: string, timeoutMs = 120_000): Promise<PeerOutput> {
    const existing = this.outputs.get(subtaskId);
    if (existing) return Promise.resolve(existing);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Peer timeout waiting for subtask: ${subtaskId}`));
      }, timeoutMs);

      const resolvers = this.waiters.get(subtaskId) ?? [];
      resolvers.push((output) => {
        clearTimeout(timer);
        resolve(output);
      });
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
   * Broadcast a message to all registered peers except sender
   */
  broadcast(fromId: string, payload: unknown): void {
    const msg: PeerMessage = {
      fromId,
      toId: '*',
      type: 'SYNC_DATA',
      subtaskId: '',
      syncType: 'SHARE_OUTPUT',
      payload,
      timestamp: new Date().toISOString(),
    };
    this.emit('broadcast', msg);
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
    const msg: PeerMessage = {
      fromId,
      toId,
      type: 'SYNC_DATA',
      subtaskId,
      syncType,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.emit(`message:${toId}`, msg);
    this.emit('message', msg);
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
