// ─────────────────────────────────────────────
//  Cascade AI — Run accounting waiting for a window
// ─────────────────────────────────────────────
//
//  The desktop app copies each run's cost to the signed-in account from its
//  renderer, which hears it as `run:accounting`. A run can end with no window
//  open: on macOS the backend and its scheduler keep running after the last
//  window closes, and a one-shot broadcast then reaches no one. So each
//  report is kept here until a window says it has handled it, and replayed to
//  every window that connects. Its id doubles as the run's id in the cloud,
//  which adds a run once per id, so a replay after a lost confirmation is not
//  counted twice.

import { randomUUID } from 'node:crypto';

/** How many unconfirmed reports are kept; the oldest go first. */
export const MAX_PENDING_ACCOUNTING = 200;

export class PendingAccounting<T extends object> {
  private readonly pending = new Map<string, T & { id: string }>();

  constructor(private readonly max = MAX_PENDING_ACCOUNTING) {}

  /** Keeps a report until it is confirmed, and returns it with its id. */
  add(report: T): T & { id: string } {
    const kept = { ...report, id: randomUUID() };
    this.pending.set(kept.id, kept);
    while (this.pending.size > this.max) this.pending.delete(this.pending.keys().next().value!);
    return kept;
  }

  /** A window handled this report (sent it to the cloud, or skipped it). */
  confirm(id: unknown): void {
    if (typeof id === 'string') this.pending.delete(id);
  }

  /** Every report not yet confirmed, oldest first, for a window that just connected. */
  unconfirmed(): Array<T & { id: string }> {
    return [...this.pending.values()];
  }

  get size(): number {
    return this.pending.size;
  }
}
