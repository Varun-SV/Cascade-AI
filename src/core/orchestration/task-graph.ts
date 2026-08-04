export type TaskGraphNodeKind = 'section' | 'subtask';
export type TaskGraphValidationMode = 'strict' | 'repair';

export interface TaskGraphInputNode<TPayload> {
  id: string;
  title: string;
  kind: TaskGraphNodeKind;
  dependsOn?: readonly string[];
  payload: TPayload;
}

export interface TaskGraphNode<TPayload> {
  id: string;
  title: string;
  kind: TaskGraphNodeKind;
  dependsOn: readonly string[];
  payload: TPayload;
  /** Stable source order used to keep execution deterministic. */
  ordinal: number;
}

export interface TaskGraph<TPayload> {
  nodes: readonly TaskGraphNode<TPayload>[];
}

export type TaskGraphIssueCode =
  | 'INVALID_NODE'
  | 'DUPLICATE_NODE_ID'
  | 'SELF_DEPENDENCY'
  | 'UNKNOWN_DEPENDENCY'
  | 'CYCLE_EDGE_REMOVED';

export interface TaskGraphIssue {
  code: TaskGraphIssueCode;
  message: string;
  nodeId?: string;
  dependencyId?: string;
}

export interface CompiledTaskGraph<TPayload> {
  graph: TaskGraph<TPayload>;
  issues: readonly TaskGraphIssue[];
}

export interface CompileTaskGraphOptions {
  /**
   * strict: reject malformed LLM plans.
   * repair: preserve today's graceful-degradation behaviour by dropping only
   * invalid dependency edges and duplicate/invalid nodes.
   */
  mode?: TaskGraphValidationMode;
}

export class TaskGraphValidationError extends Error {
  constructor(public readonly issues: readonly TaskGraphIssue[]) {
    super(issues.map((issue) => issue.message).join('; '));
    this.name = 'TaskGraphValidationError';
  }
}

function normalizeDependencies(input: readonly string[] | undefined): string[] {
  if (!input?.length) return [];
  return [...new Set(input.map((dependency) => dependency.trim()).filter(Boolean))];
}

/**
 * The nodes that genuinely sit ON a cycle — members of a strongly connected
 * component of two or more nodes (or, defensively, a self-edge).
 *
 * This deliberately does NOT use "whatever a topological sort could not reach".
 * Kahn's algorithm stalls on a cycle AND on everything downstream of one, since
 * a downstream node's in-degree never falls to zero while its dependency is
 * stuck. Treating that whole stalled set as "the cycle" made the repair below
 * strip dependencies from innocent downstream nodes: given root → a ⇄ b → tail,
 * `tail` lost its edge to `b` and became immediately schedulable, so it ran in
 * the first wave — before the work it consumes. A repair pass meant to make a
 * bad plan runnable was silently making a runnable plan wrong, and nothing threw.
 *
 * Tarjan's algorithm, iterative rather than recursive: depth is bounded by the
 * node count, and while planner graphs are small, a stack overflow inside the
 * trust boundary would be a poor way to find the ceiling.
 */
function cycleNodes<TPayload>(nodes: readonly TaskGraphNode<TPayload>[]): Set<string> {
  const adjacency = new Map<string, readonly string[]>(
    nodes.map((node) => [node.id, node.dependsOn] as const),
  );

  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const inCycle = new Set<string>();
  let counter = 0;

  const open = (id: string): void => {
    index.set(id, counter);
    lowlink.set(id, counter);
    counter++;
    stack.push(id);
    onStack.add(id);
  };

  for (const root of nodes) {
    if (index.has(root.id)) continue;
    open(root.id);
    // Each frame is a node plus how far through its edges we are, which is what
    // the recursive form keeps in the call stack.
    const frames: Array<{ id: string; edge: number }> = [{ id: root.id, edge: 0 }];

    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const neighbours = adjacency.get(frame.id) ?? [];

      if (frame.edge < neighbours.length) {
        const next = neighbours[frame.edge]!;
        frame.edge++;
        // Unknown dependencies are already stripped upstream; skipping them here
        // too keeps this function correct when called on its own.
        if (!adjacency.has(next)) continue;
        if (!index.has(next)) {
          open(next);
          frames.push({ id: next, edge: 0 });
        } else if (onStack.has(next)) {
          lowlink.set(frame.id, Math.min(lowlink.get(frame.id)!, index.get(next)!));
        }
        continue;
      }

      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) {
        lowlink.set(parent.id, Math.min(lowlink.get(parent.id)!, lowlink.get(frame.id)!));
      }

      if (lowlink.get(frame.id) === index.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.id) break;
        }
        // A single node is only cyclic if it points at itself. compileTaskGraph
        // strips self-dependencies before calling this, so that arm is reached
        // only by a direct caller.
        const cyclic = component.length > 1
          || (adjacency.get(component[0]!) ?? []).includes(component[0]!);
        if (cyclic) for (const member of component) inCycle.add(member);
      }
    }
  }

  return inCycle;
}

function throwIfStrict(mode: TaskGraphValidationMode, issues: readonly TaskGraphIssue[]): void {
  if (mode === 'strict' && issues.length > 0) {
    throw new TaskGraphValidationError(issues);
  }
}

/**
 * Compile untrusted planner output into a deterministic, schedulable graph.
 * The compiler is the trust boundary between LLM-authored JSON and execution.
 */
export function compileTaskGraph<TPayload>(
  inputNodes: readonly TaskGraphInputNode<TPayload>[],
  options: CompileTaskGraphOptions = {},
): CompiledTaskGraph<TPayload> {
  const mode = options.mode ?? 'strict';
  const issues: TaskGraphIssue[] = [];
  if (inputNodes.length === 0) {
    issues.push({ code: 'INVALID_NODE', message: 'Task graph requires at least one node' });
    throwIfStrict(mode, issues);
  }
  const seen = new Set<string>();
  const nodes: TaskGraphNode<TPayload>[] = [];

  for (let ordinal = 0; ordinal < inputNodes.length; ordinal++) {
    const input = inputNodes[ordinal]!;
    const id = input.id?.trim();
    const title = input.title?.trim();
    if (!id || !title) {
      issues.push({
        code: 'INVALID_NODE',
        nodeId: id || undefined,
        message: `Task graph node at index ${ordinal} requires a non-empty id and title`,
      });
      continue;
    }
    if (seen.has(id)) {
      issues.push({
        code: 'DUPLICATE_NODE_ID',
        nodeId: id,
        message: `Duplicate task graph node id: ${id}`,
      });
      continue;
    }
    seen.add(id);
    nodes.push({
      id,
      title,
      kind: input.kind,
      dependsOn: normalizeDependencies(input.dependsOn),
      payload: input.payload,
      ordinal,
    });
  }
  throwIfStrict(mode, issues);

  const ids = new Set(nodes.map((node) => node.id));
  const sanitized = nodes.map((node) => {
    const dependsOn: string[] = [];
    for (const dependencyId of node.dependsOn) {
      if (dependencyId === node.id) {
        issues.push({
          code: 'SELF_DEPENDENCY',
          nodeId: node.id,
          dependencyId,
          message: `Task graph node ${node.id} cannot depend on itself`,
        });
        continue;
      }
      if (!ids.has(dependencyId)) {
        issues.push({
          code: 'UNKNOWN_DEPENDENCY',
          nodeId: node.id,
          dependencyId,
          message: `Task graph node ${node.id} depends on unknown node ${dependencyId}`,
        });
        continue;
      }
      dependsOn.push(dependencyId);
    }
    return { ...node, dependsOn };
  });
  throwIfStrict(mode, issues);

  const cyclic = cycleNodes(sanitized);
  let repaired = sanitized;
  if (cyclic.size > 0) {
    const cycleIssues: TaskGraphIssue[] = [];
    repaired = sanitized.map((node) => {
      if (!cyclic.has(node.id)) return node;
      const dependsOn = node.dependsOn.filter((dependencyId) => {
        if (!cyclic.has(dependencyId)) return true;
        cycleIssues.push({
          code: 'CYCLE_EDGE_REMOVED',
          nodeId: node.id,
          dependencyId,
          message: `Removed cyclic dependency ${dependencyId} -> ${node.id}`,
        });
        return false;
      });
      return { ...node, dependsOn };
    });
    issues.push(...cycleIssues);
    throwIfStrict(mode, cycleIssues);
  }

  // Defensive invariant: repair mode must always produce a schedulable graph.
  const remainingCycle = cycleNodes(repaired);
  if (remainingCycle.size > 0) {
    throw new TaskGraphValidationError([
      {
        code: 'INVALID_NODE',
        message: `Task graph remained cyclic after repair: ${[...remainingCycle].join(', ')}`,
      },
    ]);
  }

  return {
    graph: { nodes: repaired.sort((a, b) => a.ordinal - b.ordinal) },
    issues,
  };
}
