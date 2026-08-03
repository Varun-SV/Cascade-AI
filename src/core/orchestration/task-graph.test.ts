import { describe, expect, it } from 'vitest';
import { compileTaskGraph, TaskGraphValidationError } from './task-graph.js';
import { DependencyScheduler } from './scheduler.js';

const node = (id: string, dependsOn: string[] = []) => ({
  id,
  title: id.toUpperCase(),
  kind: 'subtask' as const,
  dependsOn,
  payload: { id },
});

describe('compileTaskGraph', () => {
  it('preserves stable source order and deduplicates dependencies', () => {
    const compiled = compileTaskGraph([
      node('a'),
      node('b', ['a', 'a']),
      node('c', ['a']),
    ]);

    expect(compiled.graph.nodes.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(compiled.graph.nodes[1]?.dependsOn).toEqual(['a']);
    expect(compiled.issues).toEqual([]);
  });

  it('rejects invalid dependencies in strict mode', () => {
    expect(() => compileTaskGraph([node('a', ['missing'])])).toThrow(TaskGraphValidationError);
  });

  it('repairs unknown and self dependencies at the planner trust boundary', () => {
    const compiled = compileTaskGraph([
      node('a', ['a', 'missing']),
      node('b', ['a']),
    ], { mode: 'repair' });

    expect(compiled.graph.nodes[0]?.dependsOn).toEqual([]);
    expect(compiled.graph.nodes[1]?.dependsOn).toEqual(['a']);
    expect(compiled.issues.map((issue) => issue.code)).toEqual([
      'SELF_DEPENDENCY',
      'UNKNOWN_DEPENDENCY',
    ]);
  });

  it('breaks only cycle-internal edges in repair mode', () => {
    const compiled = compileTaskGraph([
      node('root'),
      node('a', ['root', 'b']),
      node('b', ['a']),
      node('tail', ['b']),
    ], { mode: 'repair' });

    expect(compiled.graph.nodes.find((entry) => entry.id === 'a')?.dependsOn).toEqual(['root']);
    expect(compiled.graph.nodes.find((entry) => entry.id === 'b')?.dependsOn).toEqual([]);
    expect(compiled.graph.nodes.find((entry) => entry.id === 'tail')?.dependsOn).toEqual(['b']);
    expect(compiled.issues.filter((issue) => issue.code === 'CYCLE_EDGE_REMOVED')).toHaveLength(2);
  });

  it('keeps a repaired plan correctly ORDERED, not merely acyclic', async () => {
    // The consequence the assertions above only imply. Repair used to treat
    // everything a topological sort could not reach as "the cycle" — which
    // includes every node downstream of one — so `tail` lost its edge to `b`
    // and the scheduler put it in the FIRST wave, running it before the work it
    // consumes. Nothing threw: the graph was acyclic, just wrong. Asserting the
    // waves is what makes that visible, so this fails loudly if the cycle set
    // ever goes back to over-approximating.
    const compiled = compileTaskGraph([
      node('root'),
      node('a', ['root', 'b']),
      node('b', ['a']),
      node('tail', ['b']),
    ], { mode: 'repair' });

    const waves: string[][] = [];
    await new DependencyScheduler(compiled.graph, {
      execute: async (entry) => entry.id,
      onWaveStart: (entries) => { waves.push(entries.map((entry) => entry.id)); },
    }).run();

    // `tail` runs after `b`, never beside `root`.
    expect(waves).toEqual([['root', 'b'], ['a', 'tail']]);
  });

  it('does not treat a long dependency chain hanging off a cycle as cyclic', () => {
    // Kahn-based detection stalls further the longer the tail is, so a single
    // two-node cycle could strip dependencies from an unbounded number of
    // innocent nodes. Only the two real members may be touched.
    const compiled = compileTaskGraph([
      node('x', ['y']),
      node('y', ['x']),
      node('t1', ['x']),
      node('t2', ['t1']),
      node('t3', ['t2']),
    ], { mode: 'repair' });

    const dependsOn = (id: string) =>
      compiled.graph.nodes.find((entry) => entry.id === id)?.dependsOn;
    expect(dependsOn('t1')).toEqual(['x']);
    expect(dependsOn('t2')).toEqual(['t1']);
    expect(dependsOn('t3')).toEqual(['t2']);
    // Exactly one edge broken per cycle member, and nothing else.
    expect(compiled.issues.filter((issue) => issue.code === 'CYCLE_EDGE_REMOVED')).toHaveLength(2);
  });

  it('reports two disjoint cycles independently', () => {
    // Documents the multi-cycle case rather than pinning the SCC change: with
    // no nodes downstream of either cycle there is nothing for the old
    // over-approximation to wrongly include, so this passes either way. Kept
    // because "two separate cycles are both repaired" is worth stating.
    const compiled = compileTaskGraph([
      node('a1', ['a2']),
      node('a2', ['a1']),
      node('b1', ['b2']),
      node('b2', ['b1']),
      node('free'),
    ], { mode: 'repair' });

    expect(compiled.graph.nodes.find((entry) => entry.id === 'free')?.dependsOn).toEqual([]);
    expect(compiled.issues.filter((issue) => issue.code === 'CYCLE_EDGE_REMOVED')).toHaveLength(4);
  });
});
