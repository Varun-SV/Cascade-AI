// ─────────────────────────────────────────────
//  Cascade AI — Why the CLI stopped
// ─────────────────────────────────────────────
//
//  The REPL used to end without a word in several ways: a SIGINT (which,
//  while the terminal is in raw mode, is never the person's own Ctrl+C; on
//  Windows it is usually a console Ctrl-C event from a command Cascade ran)
//  went to `process.exit(0)`; a stray promise rejection in a background task
//  killed the process; a command such as `taskkill /IM node.exe` killed it
//  outright. A person saw the screen freeze, then their shell prompt.
//
//  Now every ending is written down as it happens, a session that ended
//  without being able to write anything is noticed on the next start, and
//  the endings that need not end anything (a stray signal, a stray
//  rejection) no longer do.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

/** What the last session left behind. */
export interface ExitRecord {
  /** True only for an ending the person chose: /exit, or Ctrl+C twice when idle. */
  clean: boolean;
  /** In plain words, why it ended. */
  reason: string;
  at: string;
  pid: number;
  version: string;
  uptimeSec: number;
  code?: number;
  signal?: string;
  /** What Cascade was doing at the time: the task and the last step seen. */
  running?: string;
  /** For an error: its message and stack. */
  error?: string;
  /** Errors survived during the session (stray rejections), most recent last. */
  survived?: string[];
}

/** Notices for the REPL to show: a signal ignored, an error survived. */
export const guardEvents = new EventEmitter();

const MAX_SURVIVED = 10;

export class ExitGuard {
  private readonly startedAt: number;
  private activity: string | undefined;
  private survived: string[] = [];
  private written = false;

  constructor(private readonly file: string, private readonly version: string, private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  /**
   * The record the previous session left, if any. Read once, before begin()
   * writes this session's own over it: asked later (/logs exit), it still
   * says how the last session ended, not that this one is running.
   */
  previous(): ExitRecord | null {
    if (this.before !== undefined) return this.before;
    return (this.before = this.readRecord());
  }

  private before: ExitRecord | null | undefined;

  private readRecord(): ExitRecord | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<ExitRecord>;
      return typeof raw.reason === 'string' && typeof raw.clean === 'boolean' ? raw as ExitRecord : null;
    } catch {
      return null;
    }
  }

  /**
   * Marks this session as running. If it is then killed without warning (a
   * `taskkill /F`, the window closed, the machine sleeping for good), nothing
   * gets to overwrite this, and the next start says so.
   */
  begin(): void {
    this.previous();
    this.writeRecord({
      clean: false,
      reason: 'Cascade was stopped without warning: another program ended it (for example `taskkill /F` or `kill -9`), the terminal window was closed, or the computer shut down.',
    }, true);
  }

  /** What Cascade is doing now, for the record if it stops. Null when idle. */
  setActivity(text: string | null): void {
    this.activity = text ?? undefined;
  }

  /** An error the session carried on past. */
  survive(err: unknown): string {
    const text = describe(err);
    this.survived.push(`${new Date(this.now()).toISOString()} ${text.split('\n')[0]}`);
    if (this.survived.length > MAX_SURVIVED) this.survived.shift();
    return text;
  }

  /** Writes how the session ended. The first ending recorded is the one kept. */
  end(record: Omit<ExitRecord, 'at' | 'pid' | 'version' | 'uptimeSec' | 'running' | 'survived'>): void {
    if (this.written) return;
    this.written = true;
    this.writeRecord(record, false);
  }

  /** Where the record is kept, to point a person at it. */
  get path(): string { return this.file; }

  private writeRecord(record: Omit<ExitRecord, 'at' | 'pid' | 'version' | 'uptimeSec' | 'running' | 'survived'>, provisional: boolean): void {
    const full: ExitRecord = {
      ...record,
      at: new Date(this.now()).toISOString(),
      pid: process.pid,
      version: this.version,
      uptimeSec: Math.round((this.now() - this.startedAt) / 1000),
      ...(this.activity && !provisional ? { running: this.activity } : {}),
      ...(this.survived.length ? { survived: [...this.survived] } : {}),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // Synchronous on purpose: this runs from 'exit' and signal handlers.
      fs.writeFileSync(this.file, `${JSON.stringify(full, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // A record that can't be written must not stop the ending itself.
    }
  }
}

let current: ExitGuard | null = null;
let quitByUser = false;

/** The guard of the REPL now running, or null. */
export function setCurrentGuard(guard: ExitGuard | null): void { current = guard; quitByUser = false; }
export function currentGuard(): ExitGuard | null { return current; }
/** What the REPL is doing, for the record. Null when idle. */
export function noteActivity(text: string | null): void { current?.setActivity(text); }
/** The person chose to quit (/exit, Ctrl+C twice): the ending that follows is a clean one. */
export function markQuitByUser(): void { quitByUser = true; }
export function wasQuitByUser(): boolean { return quitByUser; }

/** One line for a person, from the previous session's record: null when it ended as they chose. */
export function previousEndingNotice(record: ExitRecord | null): string | null {
  if (!record || record.clean) return null;
  const when = record.at ? ` (${record.at.replace('T', ' ').replace(/\.\d+Z$/, ' UTC')})` : '';
  const doing = record.running ? ` It was working on: ${record.running}.` : '';
  return `The last session ended unexpectedly${when}: ${record.reason}${doing} /logs exit shows the details; /resume picks the session up.`;
}

/** A readable account of an error, stack included. */
export function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  try { return typeof err === 'string' ? err : JSON.stringify(err); } catch { return String(err); }
}

/** Exit status for a signal, as shells report it (128 + its number). */
export function signalExitCode(signal: string): number {
  const numbers: Record<string, number> = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 };
  return 128 + (numbers[signal] ?? 0);
}
