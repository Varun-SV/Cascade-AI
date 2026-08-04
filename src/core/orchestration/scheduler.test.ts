import { describe, expect, it } from 'vitest';
import { compileTaskGraph } from './task-graph.js';
import { DependencyScheduler } from './scheduler.js';

const graph = () => compileTaskGraph([
  { id: 'a', title: 'A', kind: 'subtask' as const, payload: 'a' },
  { id: 'b', title: 'B', kind: 'subtask' as const, dependsOn: ['a'], payload: 'b' },
  { id: 'c', title: 'C', kind: 'subtask' as const, dependsOn: ['a'], payload: 'c' },
  { id: 'd', title: 'D', kind: 'subtask' as const, dependsOn: ['b', 'c'], payload: 'd' },
]).graph;

describe('DependencyScheduler', () => {
  it('executes independent nodes in dependency waves', async () => {
    const starts: string[] = [];
    const scheduler = new DependencyScheduler(graph(), {
      execute: async (node) => {
        starts.push(node.id);
        return node.id.toUpperCase();
      },
    });

    const result = await scheduler.run();

    expect(result.waves).toEqual([['a'], ['b', 'c'], ['d']]);
    expect([...result.results.entries()]).toEqual([
      ['a', 'A'],
      ['b', 'B'],
      ['c', 'C'],
      ['d', 'D'],
    ]);
    expect(starts).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps deterministic source order in sequential mode', async () => {
    const order: string[] = [];
    const scheduler = new DependencyScheduler(graph(), {
      execute: async (node) => {
        order.push(node.id);
        return node.id;
      },
    }, { mode: 'sequential' });

    await scheduler.run();
    expect(order).toEqual(['a', 'b', 'c', 'd']);
  });

  it('surfaces each wave through hooks', async () => {
    const waves: string[][] = [];
    const scheduler = new DependencyScheduler(graph(), {
      execute: async (node) => node.id,
      onWaveStart: (nodes) => waves.push(nodes.map((node) => node.id)),
    });

    await scheduler.run();
    expect(waves).toEqual([['a'], ['b', 'c'], ['d']]);
  });
});

describe('failure-aware dependency contracts', () => {
  /** a -> b -> c, plus an independent d. */
  const chain = (): TaskGraph<string> => ({
    nodes: [
      { id: 'a', ordinal: 0, dependsOn: [], payload: 'a', kind: 'section' },
      { id: 'b', ordinal: 1, dependsOn: ['a'], payload: 'b', kind: 'section' },
      { id: 'c', ordinal: 2, dependsOn: ['b'], payload: 'c', kind: 'section' },
      { id: 'd', ordinal: 3, dependsOn: [], payload: 'd', kind: 'section' },
    ],
  } as TaskGraph<string>);

  it('does not run a node whose dependency failed', async () => {
    // The bug: T1 converts worker errors into resolved FAILED results, so the
    // scheduler saw a fulfilled promise and released dependents anyway —
    // "run integration tests" started after "implement API" failed outright.
    const ran: string[] = [];
    const scheduler = new DependencyScheduler<string, string>(
      chain(),
      {
        execute: async (node) => { ran.push(node.id); return node.id === 'a' ? 'FAILED' : 'OK'; },
        classify: (_n, result) => (result === 'FAILED' ? 'failed' : 'succeeded'),
      },
      { onUpstreamFailure: 'block' },
    );

    const result = await scheduler.run();
    expect(ran).toEqual(['a', 'd']);           // b and c never attempted
    expect([...result.blocked.keys()].sort()).toEqual(['b', 'c']);
  });

  it('blocks transitively and names the chain', async () => {
    const scheduler = new DependencyScheduler<string, string>(
      chain(),
      {
        execute: async (node) => (node.id === 'a' ? 'FAILED' : 'OK'),
        classify: (_n, result) => (result === 'FAILED' ? 'failed' : 'succeeded'),
      },
      { onUpstreamFailure: 'block' },
    );

    const result = await scheduler.run();
    // c is two hops from the failure; it names the failed ROOT, which is the
    // thing that actually has to be fixed, not the intermediate that was itself
    // only blocked.
    expect(result.blocked.get('c')?.blockedBy).toEqual(['a']);
    expect(result.blocked.get('c')?.reason).toContain('failed');
  });

  it('lets an unrelated branch finish — blocking is scoped to descendants', async () => {
    const scheduler = new DependencyScheduler<string, string>(
      chain(),
      {
        execute: async (node) => (node.id === 'a' ? 'FAILED' : 'OK'),
        classify: (_n, result) => (result === 'FAILED' ? 'failed' : 'succeeded'),
      },
      { onUpstreamFailure: 'block' },
    );

    const result = await scheduler.run();
    expect(result.results.get('d')).toBe('OK');
    expect(result.blocked.has('d')).toBe(false);
  });

  it('treats PARTIAL as good enough to unblock dependents', async () => {
    // A degraded-but-real section can still feed the next one; cancelling that
    // work would cost more than letting it try.
    const ran: string[] = [];
    const scheduler = new DependencyScheduler<string, string>(
      chain(),
      {
        execute: async (node) => { ran.push(node.id); return node.id === 'a' ? 'PARTIAL' : 'OK'; },
        classify: (_n, result) => (result === 'FAILED' ? 'failed' : result === 'PARTIAL' ? 'partial' : 'succeeded'),
      },
      { onUpstreamFailure: 'block' },
    );

    await scheduler.run();
    expect(ran).toContain('b');
    expect(ran).toContain('c');
  });

  it('reports blocked nodes through the hook so callers can account for them', async () => {
    const seen: string[] = [];
    const scheduler = new DependencyScheduler<string, string>(
      chain(),
      {
        execute: async (node) => (node.id === 'a' ? 'FAILED' : 'OK'),
        classify: (_n, result) => (result === 'FAILED' ? 'failed' : 'succeeded'),
        onNodeBlocked: (node) => { seen.push(node.id); },
      },
      { onUpstreamFailure: 'block' },
    );

    await scheduler.run();
    expect(seen.sort()).toEqual(['b', 'c']);
  });

  it('defaults to the previous behaviour when no policy is given', async () => {
    // Failure awareness must be opt-in: an existing caller that passes no
    // classify/policy has to schedule exactly as it did before.
    const ran: string[] = [];
    const scheduler = new DependencyScheduler<string, string>(
      chain(),
      { execute: async (node) => { ran.push(node.id); return 'FAILED'; } },
    );

    const result = await scheduler.run();
    expect(ran.sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(result.blocked.size).toBe(0);
  });
});

describe('blocking is deterministic under provider latency', () => {
  /** Two independent parents, both failing, converging on one join node. */
  const join = (): TaskGraph<string> => ({
    nodes: [
      { id: 'p1', ordinal: 0, dependsOn: [], payload: 'p1', kind: 'section' },
      { id: 'p2', ordinal: 1, dependsOn: [], payload: 'p2', kind: 'section' },
      { id: 'join', ordinal: 2, dependsOn: ['p1', 'p2'], payload: 'join', kind: 'section' },
    ],
  } as TaskGraph<string>);

  const runWithDelays = async (d1: number, d2: number) => {
    const scheduler = new DependencyScheduler<string, string>(
      join(),
      {
        execute: async (node) => {
          const delay = node.id === 'p1' ? d1 : node.id === 'p2' ? d2 : 0;
          await new Promise((r) => setTimeout(r, delay));
          return 'FAILED';
        },
        classify: () => 'failed',
      },
      { onUpstreamFailure: 'block' },
    );
    return scheduler.run();
  };

  it('names the same causes whichever parent returns first', async () => {
    // Previously the first provider to return became the join node's SOLE
    // blockedBy, so inverting the delays changed the recorded cause. A
    // scheduler whose output depends on network timing cannot be reasoned about.
    const a = await runWithDelays(0, 30);
    const b = await runWithDelays(30, 0);

    expect(a.blocked.get('join')?.blockedBy).toEqual(['p1', 'p2']);
    expect(b.blocked.get('join')?.blockedBy).toEqual(['p1', 'p2']);
    expect(a.blocked.get('join')?.reason).toBe(b.blocked.get('join')?.reason);
  });

  it('reports every failed parent, not just the one that lost the race', async () => {
    const result = await runWithDelays(5, 5);
    expect(result.blocked.get('join')?.reason).toContain('"p1"');
    expect(result.blocked.get('join')?.reason).toContain('"p2"');
  });
});
