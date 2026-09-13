from pathlib import Path

p = Path('src/browser/remote/controller.ts')
s = p.read_text()

old = '''  private async releaseIfIdle(runId: string, waitForTeardown = true): Promise<void> {
    const held = this.runs.get(runId);
    if (!held) return;
    this.runs.delete(runId);
    const teardown = this.teardown(runId, held);
    // Ordinarily the refusal waits until the provider session is actually gone.
    // There is one deliberate exception: `act()` still owns the action slot.
    // An unwatch may already be in `held.watchQueue` waiting for THAT slot, and
    // teardown waits for watchQueue before detaching. Awaiting it from the slot
    // holder makes a cycle: act -> teardown -> unwatch -> action slot -> act.
    // Start/record teardown now, but let the action's finally release the slot;
    // the queued unwatch then finishes and the recorded teardown follows it.
    if (waitForTeardown) await teardown;
  }
'''
new = '''  private async releaseIfIdle(runId: string, releaseSlot?: () => void): Promise<void> {
    const held = this.runs.get(runId);
    if (!held) {
      releaseSlot?.();
      return;
    }
    this.runs.delete(runId);
    // Start teardown while the run is already unreachable, but release the
    // caller's action slot BEFORE awaiting it. `disposeRun()` waits for the
    // watch queue, and an unwatch in that queue may itself be waiting for this
    // exact slot. Releasing here breaks that cycle without weakening the older
    // contract: the refusal still does not return until the provider session is
    // actually handed back.
    const teardown = this.teardown(runId, held);
    releaseSlot?.();
    await teardown;
  }
'''
if s.count(old) != 1:
    raise SystemExit(f'releaseIfIdle patched shape: expected 1, found {s.count(old)}')
s = s.replace(old, new, 1)

old_call = 'await this.releaseIfIdle(runId, false);'
new_call = 'await this.releaseIfIdle(runId, () => lease_.endAction(token));'
if s.count(old_call) != 4:
    raise SystemExit(f'slot-held release calls: expected 4, found {s.count(old_call)}')
s = s.replace(old_call, new_call)

p.write_text(s)
