/**
 * Durable resume checkpoints.
 *
 * Before this, a stopped run was recoverable only through an in-memory field on
 * the Cascade instance, set on exactly one path (the budget cap). So the two
 * interruptions people actually hit — a crash, and Ctrl-C — lost every finished
 * section, and even a budget stop was lost the moment the process exited. The
 * work was on disk; the knowledge of what had been done was not.
 *
 * A checkpoint records the finished nodes of a run so a resume can restore them
 * instead of paying to produce them a second time. Design constraints, in the
 * order that shaped the code:
 *
 * - **A crash is one of the triggers.** Writes are atomic (temp file + rename),
 *   because the process dying mid-write is a case this store must survive, not
 *   an edge case. A half-written checkpoint that parses as valid JSON would be
 *   worse than none at all.
 * - **A corrupt or foreign checkpoint must never break the caller.** Listing
 *   skips anything unreadable, unparseable, or written by a schema version this
 *   build doesn't know. Resume is a convenience; it may degrade, never throw.
 * - **Checkpoints hold the user's prompt and partial output.** They are pruned
 *   by both count and age so that content does not accumulate in the workspace
 *   indefinitely.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Bump when the on-disk shape changes incompatibly. Older files are ignored. */
export const RESUME_SCHEMA_VERSION = 1;

export type ResumeReason = 'budget' | 'cancelled' | 'error' | 'breaker';

/** A node whose work is done and must not be re-run on resume. */
export interface CompletedNode {
  /** Stable id from the compiled task graph. */
  id: string;
  title: string;
  status: 'COMPLETED' | 'PARTIAL';
  output: string;
}

export interface ResumeCheckpoint {
  version: number;
  taskId: string;
  prompt: string;
  /** ISO-8601. */
  createdAt: string;
  reason: ResumeReason;
  /** Why the run stopped, in the words the user would see. */
  detail?: string;
  partialOutput: string;
  completed: CompletedNode[];
}

export interface ResumeStoreOptions {
  /** Directory checkpoints live in (created on demand). */
  dir: string;
  /** Keep at most this many, newest first. Default 5. */
  maxCheckpoints?: number;
  /** Discard checkpoints older than this. Default 7 days. */
  maxAgeMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
}

const DEFAULT_MAX_CHECKPOINTS = 5;
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Filenames are `<epochMs>-<taskId>.json`, so age and order need no file reads. */
const FILE_PATTERN = /^(\d+)-(.+)\.json$/;

/**
 * Keep task ids to characters that mean the same thing on every filesystem.
 * Separators are stripped, and runs of dots are collapsed too: `..` cannot
 * traverse once `/` is gone, but a filename should not need that argument made
 * about it to be seen as safe.
 */
function safeId(taskId: string): string {
  const cleaned = taskId.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_');
  return cleaned.slice(0, 100) || 'run';
}

function isCheckpoint(value: unknown): value is ResumeCheckpoint {
  if (typeof value !== 'object' || value === null) return false;
  const c = value as Partial<ResumeCheckpoint>;
  return (
    c.version === RESUME_SCHEMA_VERSION
    && typeof c.taskId === 'string'
    && typeof c.prompt === 'string'
    && typeof c.createdAt === 'string'
    && typeof c.partialOutput === 'string'
    && Array.isArray(c.completed)
  );
}

export class ResumeStore {
  private readonly dir: string;
  private readonly maxCheckpoints: number;
  private readonly maxAgeMs: number;
  private readonly now: () => number;

  constructor(options: ResumeStoreOptions) {
    this.dir = options.dir;
    this.maxCheckpoints = options.maxCheckpoints ?? DEFAULT_MAX_CHECKPOINTS;
    this.maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  /**
   * Persist a checkpoint and prune. Never throws: failing to save a resume file
   * must not turn a recoverable stop into a crash, which would be a strictly
   * worse outcome than the one this store exists to improve.
   */
  async save(checkpoint: Omit<ResumeCheckpoint, 'version' | 'createdAt'> & { createdAt?: string }): Promise<void> {
    try {
      const timestamp = this.now();
      const record: ResumeCheckpoint = {
        ...checkpoint,
        version: RESUME_SCHEMA_VERSION,
        createdAt: checkpoint.createdAt ?? new Date(timestamp).toISOString(),
      };

      await fs.mkdir(this.dir, { recursive: true });
      const finalPath = path.join(this.dir, `${timestamp}-${safeId(record.taskId)}.json`);

      // Atomic: a crash between write and rename leaves the temp file, never a
      // truncated checkpoint that would parse as a valid but incomplete run.
      const tempPath = `${finalPath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, JSON.stringify(record, null, 2), 'utf-8');
      await fs.rename(tempPath, finalPath);

      await this.prune();
    } catch {
      /* Resume is best-effort by design — see the note above. */
    }
  }

  /** Valid, unexpired checkpoints, newest first. */
  async list(): Promise<ResumeCheckpoint[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.dir);
    } catch {
      return []; // no directory yet — nothing to resume
    }

    const cutoff = this.now() - this.maxAgeMs;
    const candidates = entries
      .map((name) => ({ name, match: FILE_PATTERN.exec(name) }))
      .filter((e): e is { name: string; match: RegExpExecArray } => e.match !== null)
      .map((e) => ({ name: e.name, timestamp: Number(e.match[1]) }))
      .filter((e) => e.timestamp >= cutoff)
      .sort((a, b) => b.timestamp - a.timestamp);

    const checkpoints: ResumeCheckpoint[] = [];
    for (const candidate of candidates) {
      try {
        const raw = await fs.readFile(path.join(this.dir, candidate.name), 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        // A checkpoint from a newer (or corrupt) build is skipped, not fatal:
        // an unreadable file must never stop the readable ones being offered.
        if (isCheckpoint(parsed)) checkpoints.push(parsed);
      } catch {
        continue;
      }
    }
    return checkpoints;
  }

  /** The most recent resumable run, or null. */
  async latest(): Promise<ResumeCheckpoint | null> {
    return (await this.list())[0] ?? null;
  }

  /**
   * Load a checkpoint and delete it in the same step. Resuming twice from one
   * checkpoint would re-run restored work, so consumption is part of reading.
   */
  async consume(taskId?: string): Promise<ResumeCheckpoint | null> {
    const all = await this.list();
    const target = taskId ? all.find((c) => c.taskId === taskId) : all[0];
    if (!target) return null;
    await this.delete(target.taskId);
    return target;
  }

  /** Remove every checkpoint for a task id. */
  async delete(taskId: string): Promise<void> {
    try {
      const entries = await fs.readdir(this.dir);
      const wanted = safeId(taskId);
      await Promise.all(entries.map(async (name) => {
        const match = FILE_PATTERN.exec(name);
        if (match?.[2] === wanted) {
          await fs.rm(path.join(this.dir, name), { force: true });
        }
      }));
    } catch {
      /* nothing to delete */
    }
  }

  /** Drop expired checkpoints, then any beyond the newest `maxCheckpoints`. */
  async prune(): Promise<void> {
    try {
      const entries = await fs.readdir(this.dir);
      const cutoff = this.now() - this.maxAgeMs;

      const files = entries
        .map((name) => ({ name, match: FILE_PATTERN.exec(name) }))
        .filter((e): e is { name: string; match: RegExpExecArray } => e.match !== null)
        .map((e) => ({ name: e.name, timestamp: Number(e.match[1]) }))
        .sort((a, b) => b.timestamp - a.timestamp);

      const doomed = files.filter((f, index) => f.timestamp < cutoff || index >= this.maxCheckpoints);

      // Orphaned temp files mean a previous process died mid-write. Clear them
      // on the same age rule so they cannot accumulate silently.
      const staleTemps = entries.filter((name) => name.endsWith('.tmp'))
        .filter((name) => (Number(FILE_PATTERN.exec(name.replace(/\.\d+\.tmp$/, '.json'))?.[1]) || 0) < cutoff);

      await Promise.all([...doomed.map((f) => f.name), ...staleTemps].map(
        (name) => fs.rm(path.join(this.dir, name), { force: true }),
      ));
    } catch {
      /* pruning is maintenance — never fatal */
    }
  }
}

/**
 * Render restored work for a correction planner: enough for the model to know
 * what exists and not redo it, without pasting entire artifacts back into the
 * prompt (which is what the token budget was being spent on in the first place).
 */
export function summarizeCompleted(completed: readonly CompletedNode[], perNodeChars = 500): string {
  if (!completed.length) return '';
  const lines = completed.map((node) => {
    const body = node.output.length > perNodeChars
      ? `${node.output.slice(0, perNodeChars)}…`
      : node.output;
    return `- [${node.status}] ${node.title}\n  ${body.replace(/\n/g, '\n  ')}`;
  });
  return `ALREADY COMPLETED in a previous attempt — do NOT redo these:\n${lines.join('\n')}`;
}
