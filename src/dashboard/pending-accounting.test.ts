import { describe, expect, it } from 'vitest';
import { PendingAccounting } from './pending-accounting.js';

describe('run accounting waiting for a window', () => {
  it('keeps each report with an id until a window confirms it', () => {
    const pending = new PendingAccounting<{ sessionId: string }>();
    const a = pending.add({ sessionId: 's1' });
    const b = pending.add({ sessionId: 's2' });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(pending.unconfirmed().map((r) => r.sessionId)).toEqual(['s1', 's2']);
    pending.confirm(a.id);
    expect(pending.unconfirmed()).toEqual([b]);
    pending.confirm(undefined);
    pending.confirm(42);
    expect(pending.size).toBe(1);
  });

  it('drops the oldest beyond its limit', () => {
    const pending = new PendingAccounting<{ n: number }>(3);
    for (let n = 1; n <= 5; n++) pending.add({ n });
    expect(pending.unconfirmed().map((r) => r.n)).toEqual([3, 4, 5]);
  });
});
