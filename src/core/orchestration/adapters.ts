import type { T1ToT2Assignment } from '../../types.js';
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

/**
 * The subtask fields the graph actually needs. Generic over the whole record so
 * both the planner's `T3SubtaskSpec` and T2's richer `T2ToT3Assignment` compile
 * without a cast — they carry the same identity and dependency fields, and the
 * payload comes back out at its original type.
 */
export interface SubtaskGraphInput {
  subtaskId: string;
  subtaskTitle: string;
  dependsOn?: string[];
}

export function compileSubtaskGraph<TSubtask extends SubtaskGraphInput>(
  subtasks: readonly TSubtask[],
): CompiledTaskGraph<TSubtask> {
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
