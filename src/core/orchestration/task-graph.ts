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

function cycleNodes<TPayload>(nodes: readonly TaskGraphNode<TPayload>[]): Set<string> {
  const inDegree = new Map(nodes.map((node) => [node.id, node.dependsOn.length] as const));
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    dependents.set(node.id, []);
  }
  for (const node of nodes) {
    for (const dependencyId of node.dependsOn) {
      dependents.get(dependencyId)?.push(node.id);
    }
  }

  const queue = nodes.filter((node) => (inDegree.get(node.id) ?? 0) === 0).map((node) => node.id);
  const visited = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    visited.add(id);
    for (const dependentId of dependents.get(id) ?? []) {
      const next = (inDegree.get(dependentId) ?? 1) - 1;
      inDegree.set(dependentId, next);
      if (next === 0) queue.push(dependentId);
    }
  }

  return new Set(nodes.map((node) => node.id).filter((id) => !visited.has(id)));
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
