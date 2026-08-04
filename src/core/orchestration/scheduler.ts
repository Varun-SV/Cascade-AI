import type { TaskGraph, TaskGraphNode } from './task-graph.js';

export type SchedulerExecutionMode = 'parallel' | 'sequential';

export interface SchedulerHooks<TPayload, TResult> {
  execute(node: TaskGraphNode<TPayload>): Promise<TResult>;
  onWaveStart?(nodes: readonly TaskGraphNode<TPayload>[], wave: number): void | Promise<void>;
  onNodeComplete?(node: TaskGraphNode<TPayload>, result: TResult): void | Promise<void>;
}

export interface SchedulerOptions {
  mode?: SchedulerExecutionMode;
}

export interface SchedulerResult<TResult> {
  results: ReadonlyMap<string, TResult>;
  waves: readonly (readonly string[])[];
}

/**
 * Shared deterministic dependency scheduler for T1 sections and T2 subtasks.
 * Graph validation/repair belongs in compileTaskGraph; this class only executes
 * a valid DAG in stable source order.
 */
export class DependencyScheduler<TPayload, TResult> {
  constructor(
    private readonly graph: TaskGraph<TPayload>,
    private readonly hooks: SchedulerHooks<TPayload, TResult>,
    private readonly options: SchedulerOptions = {},
  ) {}

  async run(): Promise<SchedulerResult<TResult>> {
    const nodes = [...this.graph.nodes].sort((a, b) => a.ordinal - b.ordinal);
    const inDegree = new Map(nodes.map((node) => [node.id, node.dependsOn.length] as const));
    const dependents = new Map<string, string[]>();
    for (const node of nodes) dependents.set(node.id, []);
    for (const node of nodes) {
      for (const dependencyId of node.dependsOn) {
        dependents.get(dependencyId)?.push(node.id);
      }
    }

    const completed = new Set<string>();
    const results = new Map<string, TResult>();
    const waves: string[][] = [];
    let wave = 0;

    while (completed.size < nodes.length) {
      const ready = nodes.filter((node) => !completed.has(node.id) && (inDegree.get(node.id) ?? 0) === 0);
      if (ready.length === 0) {
        throw new Error('Dependency scheduler received a cyclic or incomplete task graph');
      }

      waves.push(ready.map((node) => node.id));
      await this.hooks.onWaveStart?.(ready, wave);

      const runOne = async (node: TaskGraphNode<TPayload>) => {
        const result = await this.hooks.execute(node);
        results.set(node.id, result);
        completed.add(node.id);
        for (const dependentId of dependents.get(node.id) ?? []) {
          inDegree.set(dependentId, Math.max(0, (inDegree.get(dependentId) ?? 1) - 1));
        }
        await this.hooks.onNodeComplete?.(node, result);
      };

      if ((this.options.mode ?? 'parallel') === 'sequential') {
        for (const node of ready) await runOne(node);
      } else {
        await Promise.all(ready.map(runOne));
      }
      wave++;
    }

    return { results, waves };
  }
}
