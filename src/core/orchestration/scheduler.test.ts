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
