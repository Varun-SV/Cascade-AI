import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { armFatalReport, takeFatalReport } from './fatal-report.js';
import { ExitGuard, previousEndingNotice } from './exit-guard.js';

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fatal-report-'));

const report = {
  header: { event: 'Allocation failed - JavaScript heap out of memory', trigger: 'FatalError', commandLine: ['node', 'cascade'] },
  javascriptStack: { message: 'No stack.', stack: ['Unavailable.'] },
  environmentVariables: { ANTHROPIC_API_KEY: 'sk-secret' },
};

describe('fatal-error reports', () => {
  it('asks Node to write one beside the exit record, leaving out the environment where it can', () => {
    const d = dir();
    const api = { directory: '', filename: '', reportOnFatalError: false } as { directory: string; filename: string; reportOnFatalError: boolean; excludeEnv?: boolean };
    armFatalReport(d, api);
    expect(api).toMatchObject({ directory: d, filename: 'fatal-report.json', reportOnFatalError: true, excludeEnv: true });
    expect(() => armFatalReport(d, undefined)).not.toThrow();
  });

  it('takes only the event and the stack, never the rest, and deletes the file', () => {
    const d = dir();
    fs.writeFileSync(path.join(d, 'fatal-report.json'), JSON.stringify(report));
    const got = takeFatalReport(d);
    expect(got).toMatchObject({ event: 'Allocation failed - JavaScript heap out of memory', stack: 'No stack.\nUnavailable.' });
    expect(JSON.stringify(got)).not.toContain('sk-secret');
    expect(fs.existsSync(path.join(d, 'fatal-report.json'))).toBe(false);
    expect(takeFatalReport(d)).toBeNull();
  });

  it('the next start says Node killed it, and why, instead of "stopped without warning"', () => {
    const d = dir();
    const file = path.join(d, 'last-exit.json');
    new ExitGuard(file, '1.0.0').begin();
    fs.writeFileSync(path.join(d, 'fatal-report.json'), JSON.stringify(report));
    const next = new ExitGuard(file, '1.0.0');
    const record = next.explainPrevious(takeFatalReport(d));
    expect(previousEndingNotice(record)).toMatch(/Node stopped Cascade with a fatal error: Allocation failed - JavaScript heap out of memory/);
    // /logs exit reads the same, explained record.
    expect(next.previous()?.error).toContain('No stack.');
  });

  it('a clean ending is left alone, and no report leaves the record as it was', () => {
    const d = dir();
    const file = path.join(d, 'last-exit.json');
    const g = new ExitGuard(file, '1.0.0');
    g.begin();
    g.end({ clean: true, reason: 'You quit Cascade.' });
    expect(new ExitGuard(file, '1.0.0').explainPrevious({ event: 'x', at: Date.now() })?.reason).toBe('You quit Cascade.');
    const h = new ExitGuard(path.join(dir(), 'last-exit.json'), '1.0.0');
    expect(h.explainPrevious(null)).toBeNull();
  });
});
