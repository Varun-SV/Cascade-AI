import type { T1ToT2Assignment, T3SubtaskSpec } from '../../types.js';
import { compileTaskGraph, type CompiledTaskGraph } from './task-graph.js';

export function compileSectionGraph(
  sections: readonly T1ToT2Assignment[],
): CompiledTaskGraph<T1ToT2Assignment> {
  return compileTaskGraph(
    sections.map((section) => ({
      id: section.sectionId,
      title: section.sectionTitle,
      kind: 'section' as const,
      dependsOn: section.dependsOn,
      payload: section,
    })),
    { mode: 'repair' },
  );
}

export function compileSubtaskGraph(
  subtasks: readonly T3SubtaskSpec[],
): CompiledTaskGraph<T3SubtaskSpec> {
  return compileTaskGraph(
    subtasks.map((subtask) => ({
      id: subtask.subtaskId,
      title: subtask.subtaskTitle,
      kind: 'subtask' as const,
      dependsOn: subtask.dependsOn,
      payload: subtask,
    })),
    { mode: 'repair' },
  );
}
