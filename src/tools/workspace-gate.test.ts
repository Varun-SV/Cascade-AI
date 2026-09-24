import { describe, expect, it } from 'vitest';
import { WorkspaceGate } from './workspace-gate.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('WorkspaceGate', () => {
  it('lets shared callers in together, and one alone only once they have left', async () => {
    const gate = new WorkspaceGate();
    const events: string[] = [];
    const a = await gate.enter(false);
    const b = await gate.enter(false);
    const alone = gate.enter(true).then((leave) => { events.push('alone'); return leave; });
    await tick();
    expect(events).toEqual([]);
    a(); await tick();
    expect(events).toEqual([]);
    b(); await tick();
    expect(events).toEqual(['alone']);
  });

  it('holds back shared callers that come after one waiting to go alone, so it is not starved', async () => {
    const gate = new WorkspaceGate();
    const events: string[] = [];
    const first = await gate.enter(false);
    const alone = gate.enter(true).then((leave) => { events.push('alone'); return leave; });
    const later = gate.enter(false).then((leave) => { events.push('later'); return leave; });
    await tick();
    expect(events).toEqual([]);
    first(); await tick();
    expect(events).toEqual(['alone']);
    (await alone)(); await tick();
    expect(events).toEqual(['alone', 'later']);
    (await later)();
  });

  it('ignores a second leave', async () => {
    const gate = new WorkspaceGate();
    const leave = await gate.enter(false);
    leave(); leave();
    const alone = await gate.enter(true);
    let shared = false;
    void gate.enter(false).then(() => { shared = true; });
    await tick();
    expect(shared).toBe(false);
    alone(); await tick();
    expect(shared).toBe(true);
  });
});
