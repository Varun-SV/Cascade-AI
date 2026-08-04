import type { TaskGraph, TaskGraphNode } from './task-graph.js';

export type SchedulerExecutionMode = 'parallel' | 'sequential';

/**
 * How a finished node turned out.
 *
 * The scheduler used to know only "the promise resolved", which is not the same
 * question. T1 catches worker errors into an ordinary `T2Result { status:
 * 'FAILED' }` so one dead section cannot crash the run — a resolved value. The
 * scheduler saw success and released the dependents anyway, so "run the
 * integration tests" would start after "implement the API" had failed outright,
 * and then fail too, and bill for the privilege.
 *
 * `partial` deliberately does NOT block: partial output is usable, and treating
 * it as failure would cancel work that a degraded-but-real result can support.
 */
export type NodeOutcome = 'succeeded' | 'partial' | 'failed';

/** What to do with the dependents of a failed node. */
export type UpstreamFailurePolicy =
  /** Run them anyway — the historical behaviour, kept as the default. */
  | 'continue'
  /** Skip them, transitively, and report why. */
  | 'block';

/** Why a node never ran. */
export interface BlockedNode {
  /** The failed ancestors responsible, nearest first. */
  blockedBy: string[];
  reason: string;
}

export interface SchedulerHooks<TPayload, TResult> {
  execute(node: TaskGraphNode<TPayload>): Promise<TResult>;
  onWaveStart?(nodes: readonly TaskGraphNode<TPayload>[], wave: number): void | Promise<void>;
  onNodeComplete?(node: TaskGraphNode<TPayload>, result: TResult): void | Promise<void>;
  /**
   * Decide whether a result counts as success. Omit it and every result counts
   * as `succeeded`, which is exactly the previous behaviour — so adding failure
   * awareness to a caller is opt-in and cannot silently change an existing one.
   */
  classify?(node: TaskGraphNode<TPayload>, result: TResult): NodeOutcome;
  /**
   * A node that will never run because an ancestor failed. Callers use this to
   * synthesize a result for it, so downstream reporting still sees every node.
   */
  onNodeBlocked?(node: TaskGraphNode<TPayload>, blocked: BlockedNode): void | Promise<void>;
}

export interface SchedulerOptions {
  mode?: SchedulerExecutionMode;
  /** Defaults to 'continue' so existing callers behave exactly as before. */
  onUpstreamFailure?: UpstreamFailurePolicy;
}

export interface SchedulerResult<TResult> {
  results: ReadonlyMap<string, TResult>;
  waves: readonly (readonly string[])[];
  /** Nodes skipped because an ancestor failed. Empty under 'continue'. */
  blocked: ReadonlyMap<string, BlockedNode>;
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

    const policy = this.options.onUpstreamFailure ?? 'continue';
    const settled = new Set<string>();          // ran, or was skipped
    const results = new Map<string, TResult>();
    const blocked = new Map<string, BlockedNode>();
    const waves: string[][] = [];
    let wave = 0;

    /**
     * Mark every descendant of the wave's failed nodes as blocked.
     *
     * Takes ALL the wave's failures at once, in ordinal order, rather than one
     * at a time. Two failed siblings that converge on the same join node used to
     * race: whichever provider happened to return first became that node's sole
     * blockedBy, so the recorded cause changed with network latency. Here the
     * roots are collected first and every failed ancestor of a node is recorded,
     * so the answer is the same on every run.
     *
     * Walks the whole subtree, not just direct children: a node two hops
     * downstream is just as unable to do its job, and releasing it would only
     * produce a second failure whose cause is the first.
     */
    const blockDescendants = async (failedIds: readonly string[]) => {
      // rootsFor[nodeId] = every failed root this node descends from.
      const rootsFor = new Map<string, Set<string>>();
      const queue: Array<{ id: string; root: string }> = [];
      for (const rootId of failedIds) {
        for (const childId of dependents.get(rootId) ?? []) queue.push({ id: childId, root: rootId });
      }

      while (queue.length > 0) {
        const { id, root } = queue.shift()!;
        if (settled.has(id)) continue;

        const known = rootsFor.get(id);
        if (known) {
          // Already reached from another root: record this one too, but don't
          // re-walk the subtree we have already covered from here.
          if (!known.has(root)) known.add(root);
          continue;
        }
        rootsFor.set(id, new Set([root]));
        for (const childId of dependents.get(id) ?? []) queue.push({ id: childId, root });
      }

      // Emit in ordinal order so the hook fires deterministically too.
      for (const node of nodes) {
        const roots = rootsFor.get(node.id);
        if (!roots || settled.has(node.id)) continue;

        // Ordinal order again, so a join node blocked by two parents always
        // names them the same way round.
        const blockedBy = nodes.filter((n) => roots.has(n.id)).map((n) => n.id);
        const record: BlockedNode = {
          blockedBy,
          reason: blockedBy.length === 1
            ? `Required upstream node "${blockedBy[0]}" failed`
            : `Required upstream nodes ${blockedBy.map((id) => `"${id}"`).join(', ')} failed`,
        };
        blocked.set(node.id, record);
        settled.add(node.id);
        await this.hooks.onNodeBlocked?.(node, record);
      }
    };

    while (settled.size < nodes.length) {
      const ready = nodes.filter((node) => !settled.has(node.id) && (inDegree.get(node.id) ?? 0) === 0);
      if (ready.length === 0) {
        throw new Error('Dependency scheduler received a cyclic or incomplete task graph');
      }

      waves.push(ready.map((node) => node.id));
      await this.hooks.onWaveStart?.(ready, wave);

      // Outcomes are recorded BY ID and read back in ordinal order after the
      // wave. Pushing into a list as each worker resolves would order them by
      // provider latency, which is exactly the non-determinism this is meant to
      // remove — the ordering has to come from the graph, not the network.
      const outcomes = new Map<string, NodeOutcome>();

      const runOne = async (node: TaskGraphNode<TPayload>) => {
        const result = await this.hooks.execute(node);
        results.set(node.id, result);
        settled.add(node.id);

        const outcome = this.hooks.classify?.(node, result) ?? 'succeeded';
        outcomes.set(node.id, outcome);
        if (outcome === 'failed' && policy === 'block') {
          // Dependents stay locked; blocking happens below, in graph order.
        } else {
          // Succeeded, partial, or policy says carry on: release the dependents.
          for (const dependentId of dependents.get(node.id) ?? []) {
            inDegree.set(dependentId, Math.max(0, (inDegree.get(dependentId) ?? 1) - 1));
          }
        }
        await this.hooks.onNodeComplete?.(node, result);
      };

      if ((this.options.mode ?? 'parallel') === 'sequential') {
        for (const node of ready) await runOne(node);
      } else {
        await Promise.all(ready.map(runOne));
      }

      // `ready` is already ordinal-sorted, so this list is deterministic.
      const failedThisWave = ready
        .filter((node) => outcomes.get(node.id) === 'failed')
        .map((node) => node.id);
      if (policy === 'block' && failedThisWave.length > 0) {
        await blockDescendants(failedThisWave);
      }

      wave++;
    }

    return { results, waves, blocked };
  }
}
