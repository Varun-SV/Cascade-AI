// ─────────────────────────────────────────────
//  Cascade AI — Run accounting waiting for a window
// ─────────────────────────────────────────────
//
//  The desktop app copies each run's cost to the signed-in account from its
//  renderer, which hears it as `run:accounting`. A run can end with no window
//  open: on macOS the backend and its scheduler keep running after the last
//  window closes, and a one-shot broadcast then reaches no one. So each
//  report is kept until a window says it has handled it, and replayed to
//  every window that connects. Its id doubles as the run's id in the cloud,
//  which adds a run once per id, so a replay after a lost confirmation is not
//  counted twice.
//
//  Nothing unconfirmed is dropped. With a file, reports are kept on disk as
//  well (one JSON line per report or confirmation), so they also survive the
//  app quitting; the file is rewritten without confirmed ones from time to
//  time. Writing is best-effort: if the file cannot be written, reports are
//  still kept for as long as the process runs.

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Confirmations written before the file is rewritten without them. */
const COMPACT_AFTER = 200;

type Line<T> = { add: T & { id: string } } | { confirm: string };

export class PendingAccounting<T extends object> {
  private readonly pending = new Map<string, T & { id: string }>();
  private confirmedSinceCompact = 0;
  private writable: boolean;

  /** `file`: where to keep reports across restarts; none keeps them in memory only. */
  constructor(private readonly file?: string) {
    this.writable = !!file;
    if (!file) return;
    try {
      for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!raw.trim()) continue;
        let line: Line<T>;
        try { line = JSON.parse(raw) as Line<T>; } catch { continue; } // a torn last line
        if ('add' in line && line.add && typeof line.add.id === 'string') this.pending.set(line.add.id, line.add);
        else if ('confirm' in line) this.pending.delete(line.confirm);
      }
    } catch { /* no file yet */ }
    this.compact();
  }

  /** Keeps a report until it is confirmed, and returns it with its id. */
  add(report: T): T & { id: string } {
    const kept = { ...report, id: randomUUID() };
    this.pending.set(kept.id, kept);
    this.append({ add: kept });
    return kept;
  }

  /**
   * Replaces a kept report with its final form, under the same id: written
   * down provisionally when a run ended, completed once its calls settled.
   */
  replace(id: string, report: T): T & { id: string } {
    const kept = { ...report, id };
    this.pending.set(id, kept);
    this.append({ add: kept });
    return kept;
  }

  /** A window handled this report (sent it to the cloud, or skipped it). */
  confirm(id: unknown): void {
    if (typeof id !== 'string' || !this.pending.delete(id)) return;
    this.append({ confirm: id });
    if (++this.confirmedSinceCompact >= COMPACT_AFTER) this.compact();
  }

  /** Every report not yet confirmed, oldest first, for a window that just connected. */
  unconfirmed(): Array<T & { id: string }> {
    return [...this.pending.values()];
  }

  get size(): number {
    return this.pending.size;
  }

  private append(line: Line<T>): void {
    if (!this.writable || !this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    } catch (err) {
      this.writable = false;
      console.warn('[dashboard] could not keep run accounting on disk; keeping it in memory:', err);
    }
  }

  /** Rewrites the file with only the reports still waiting. */
  private compact(): void {
    this.confirmedSinceCompact = 0;
    if (!this.writable || !this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      const body = [...this.pending.values()].map((add) => `${JSON.stringify({ add })}\n`).join('');
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      this.writable = false;
      console.warn('[dashboard] could not keep run accounting on disk; keeping it in memory:', err);
    }
  }
}
