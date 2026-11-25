import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ExitGuard, claimStopSignals, describe as describeError, handOverStopSignal, previousEndingNotice, signalExitCode } from './exit-guard.js';

const fresh = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exit-guard-')), 'state', 'last-exit.json');

describe('ExitGuard', () => {
  it('a rejection with no reason is still reported, not thrown on (Codex on 4daf87b)', () => {
    expect(describeError(undefined)).toBe('undefined');
    const guard = new ExitGuard(fresh(), '1.0.0');
    guard.begin();
    expect(() => guard.survive(undefined)).not.toThrow();
  });

  it('still says how the last session ended once this one has begun (Codex on 53bc237)', () => {
    const file = fresh();
    const last = new ExitGuard(file, '1.0.0');
    last.begin();
    last.end({ clean: false, code: 1, reason: 'Cascade crashed: boom', error: 'Error: boom\n    at x' });
    const now = new ExitGuard(file, '1.0.1');
    now.begin();
    // The file now holds this session's "still running" record…
    expect(new ExitGuard(file, '1.0.1').previous()?.reason).toMatch(/stopped without warning/);
    // …and the running session still answers with the crash.
    expect(now.previous()).toMatchObject({ reason: 'Cascade crashed: boom', version: '1.0.0' });
  });

  it('a session that is killed outright leaves a record that says so on the next start', () => {
    const file = fresh();
    new ExitGuard(file, '9.9.9').begin();
    // …and nothing else: as taskkill /F would leave it.
    const before = new ExitGuard(file, '9.9.9').previous();
    expect(before).toMatchObject({ clean: false, version: '9.9.9' });
    expect(previousEndingNotice(before)).toMatch(/^The last session ended unexpectedly .*stopped without warning/);
  });

  it('writes the first ending it is told, with what was going on and the errors it carried on past', () => {
    const file = fresh();
    let t = 1_000_000;
    const guard = new ExitGuard(file, '1.0.0', () => t);
    guard.begin();
    guard.setActivity('"build the tracker" — last step: T3 Web dashboard: file_write src/api.py');
    guard.survive(new Error('socket hang up'));
    t += 65_000;
    guard.end({ clean: false, signal: 'SIGTERM', code: 143, reason: 'It was sent SIGTERM.' });
    guard.end({ clean: true, reason: 'You quit Cascade.' });
    const record = new ExitGuard(file, '1.0.0').previous()!;
    expect(record).toMatchObject({ clean: false, signal: 'SIGTERM', code: 143, uptimeSec: 65, running: expect.stringContaining('file_write src/api.py') });
    expect(record.survived).toEqual([expect.stringContaining('socket hang up')]);
    expect(previousEndingNotice(record)).toContain('It was working on: "build the tracker"');
  });

  it('a quit the person chose is not reported on the next start', () => {
    const file = fresh();
    const guard = new ExitGuard(file, '1.0.0');
    guard.begin();
    guard.end({ clean: true, reason: 'You quit Cascade.', code: 0 });
    expect(previousEndingNotice(guard.previous())).toBeNull();
  });

  it('keeps only the last ten errors survived, and never fails over an unwritable record', () => {
    // A path under a regular file: no folder can be made there.
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exit-guard-')), 'a-file');
    fs.writeFileSync(blocker, 'x');
    const guard = new ExitGuard(path.join(blocker, 'state', 'last-exit.json'), '1.0.0');
    for (let i = 0; i < 15; i++) guard.survive(`err ${i}`);
    expect(() => guard.begin()).not.toThrow();
    expect(() => guard.end({ clean: false, reason: 'x' })).not.toThrow();
  });

  it('reports exit codes as shells do', () => {
    expect(signalExitCode('SIGTERM')).toBe(143);
    expect(signalExitCode('SIGHUP')).toBe(129);
  });

  it('names the native code it was running when the process died there, and forgets it once that is over', () => {
    const file = fresh();
    const guard = new ExitGuard(file, '1.0.0');
    guard.begin();
    guard.noteNative('running the agent-written tool dynamic_x in the isolated-vm sandbox');
    // Killed here, as a native crash leaves it.
    const crashed = new ExitGuard(file, '1.0.0').previous();
    expect(crashed).toMatchObject({ clean: false, running: expect.stringContaining('dynamic_x') });
    expect(previousEndingNotice(crashed)).toMatch(/while running the agent-written tool dynamic_x.*Most likely that crashed/);
    guard.noteNative(null);
    const after = new ExitGuard(file, '1.0.0').previous();
    expect(after?.running).toBeUndefined();
    expect(after?.reason).toMatch(/stopped without warning: another program ended it/);
    // A clean end is not overwritten by a late note.
    guard.end({ clean: true, reason: 'quit' });
    guard.noteNative('late');
    expect(new ExitGuard(file, '1.0.0').previous()).toMatchObject({ clean: true, reason: 'quit' });
  });

  it('says where a session died that was waiting on, or had just answered, an approval', () => {
    const file = fresh();
    const g = new ExitGuard(file, '1.0.0');
    g.begin();
    g.noteStep('waiting for your answer on dynamic_run_shell_cmd');
    expect(new ExitGuard(file, '1.0.0').previous()).toMatchObject({ clean: false, running: 'waiting for your answer on dynamic_run_shell_cmd' });
    g.noteStep('carrying on after you answered "n" to dynamic_run_shell_cmd');
    expect(previousEndingNotice(new ExitGuard(file, '1.0.0').previous())).toMatch(/It was working on: carrying on after you answered "n" to dynamic_run_shell_cmd/);
    // A native run names itself over the step; the step returns once it is over.
    g.noteNative('running the agent-written tool x in the isolated-vm sandbox');
    expect(new ExitGuard(file, '1.0.0').previous()?.running).toMatch(/isolated-vm/);
    g.noteNative(null);
    expect(new ExitGuard(file, '1.0.0').previous()?.running).toMatch(/answered "n"/);
    g.noteStep(null);
    expect(new ExitGuard(file, '1.0.0').previous()?.running).toBeUndefined();
  });
});

describe('stop signals claimed by a command', () => {
  it('go to the command that claimed them until it lets go', () => {
    expect(handOverStopSignal('SIGINT')).toBe(false);
    const fn = vi.fn();
    const release = claimStopSignals(fn);
    expect(handOverStopSignal('SIGTERM')).toBe(true);
    expect(fn).toHaveBeenCalledWith('SIGTERM');
    release();
    expect(handOverStopSignal('SIGINT')).toBe(false);
  });

  it('an old release does not drop a newer claim', () => {
    const first = claimStopSignals(vi.fn());
    const second = vi.fn();
    const releaseSecond = claimStopSignals(second);
    first();
    expect(handOverStopSignal('SIGINT')).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    releaseSecond();
  });
});
