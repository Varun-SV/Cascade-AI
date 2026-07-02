import { describe, expect, it } from 'vitest';
import { GuidanceQueue } from './guidance.js';

describe('GuidanceQueue', () => {
  it('delivers a broadcast entry to every consumer exactly once', () => {
    const q = new GuidanceQueue();
    q.push('use tabs not spaces');
    expect(q.drain('T3_aaa').map((e) => e.text)).toEqual(['use tabs not spaces']);
    expect(q.drain('T3_bbb').map((e) => e.text)).toEqual(['use tabs not spaces']);
    // Second drain from the same consumer: nothing new.
    expect(q.drain('T3_aaa')).toEqual([]);
  });

  it('targets a specific node by exact id or prefix', () => {
    const q = new GuidanceQueue();
    q.push('only for worker aaa', 'T3_aaa');
    expect(q.drain('T3_aaa').length).toBe(1);
    expect(q.drain('T3_bbb').length).toBe(0);

    q.push('for any T3', 'T3');
    expect(q.drain('T3_aaa').length).toBe(1);
    expect(q.drain('T3_bbb').length).toBe(1);
  });

  it('a late-joining consumer still sees earlier guidance', () => {
    const q = new GuidanceQueue();
    q.push('first');
    q.push('second');
    expect(q.drain('T3_late').map((e) => e.text)).toEqual(['first', 'second']);
  });
});
