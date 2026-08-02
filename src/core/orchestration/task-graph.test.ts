import { describe, expect, it } from 'vitest';
import { compileTaskGraph, TaskGraphValidationError } from './task-graph.js';

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
});
