// ─────────────────────────────────────────────
//  Cascade AI — What Node says when it kills the process
// ─────────────────────────────────────────────
//
//  Some endings run no handler at all: the heap running out of memory, a
//  fatal V8 error. The exit record can then only say "stopped without
//  warning". Node can write a diagnostic report at that moment; this asks it
//  to, beside the exit record, and reads it on the next start.
//
//  A report holds far more than is needed: environment variables (API keys
//  among them), the command line, network interfaces. Only the event and the
//  JavaScript stack are taken from it, and the file is deleted once read.

import fs from 'node:fs';
import path from 'node:path';

const FILE = 'fatal-report.json';

/** What a fatal-error report says, and nothing else from it. */
export interface FatalReport {
  /** Node's own words, e.g. "Allocation failed - JavaScript heap out of memory". */
  event: string;
  /** The JavaScript stack at the time, when there was one. */
  stack?: string;
  /** When it was written (ms). */
  at: number;
}

interface ReportApi {
  directory: string;
  filename: string;
  reportOnFatalError: boolean;
  excludeEnv?: boolean;
  excludeNetwork?: boolean;
}

/** Asks Node to write a report into `dir` if the process dies of a fatal error. Never throws. */
export function armFatalReport(dir: string, report: ReportApi | undefined = (process as { report?: ReportApi }).report): void {
  if (!report) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Left out where this Node can: the file is deleted once read either way.
    try { report.excludeEnv = true; } catch { /* older Node */ }
    try { report.excludeNetwork = true; } catch { /* older Node */ }
    report.directory = dir;
    report.filename = FILE;
    report.reportOnFatalError = true;
  } catch {
    // Diagnostics must never stop Cascade starting.
  }
}

/**
 * The report a previous session left in `dir`, if any, and deletes it. Only
 * one written after `since` (ms) counts: an older one belongs to an older session.
 */
export function takeFatalReport(dir: string, since = 0): FatalReport | null {
  const file = path.join(dir, FILE);
  let raw: string;
  let at: number;
  try {
    at = fs.statSync(file).mtimeMs;
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try { fs.unlinkSync(file); } catch { /* read once either way */ }
  if (at < since) return null;
  try {
    const r = JSON.parse(raw) as { header?: { event?: unknown }; javascriptStack?: { message?: unknown; stack?: unknown } };
    const event = typeof r.header?.event === 'string' && r.header.event ? r.header.event : 'a fatal error';
    const js = r.javascriptStack;
    const lines = [
      typeof js?.message === 'string' ? js.message : '',
      ...(Array.isArray(js?.stack) ? js.stack.filter((l): l is string => typeof l === 'string').slice(0, 15) : []),
    ].filter(Boolean);
    return { event, at, ...(lines.length ? { stack: lines.join('\n') } : {}) };
  } catch {
    return { event: 'a fatal error (its report could not be read)', at };
  }
}
