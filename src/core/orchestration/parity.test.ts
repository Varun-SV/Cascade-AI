import { describe, expect, it } from 'vitest';
import { compileTaskGraph } from './task-graph.js';
import { DependencyScheduler } from './scheduler.js';

/**
 * Behaviour-parity harness for the T1/T2 scheduler migration.
 *
 * T1 (runT2sWithDependencies) and T2 (runWithDependencies + breakCycles) each
 * carried their own Kahn implementation. Replacing them is the kind of change
 * that fails silently: a wrong wave order does not throw, it just runs work
 * before its inputs exist and produces a subtly worse answer. Unit tests on the
 * new scheduler alone cannot catch that — they only prove the new code is
 * self-consistent.
 *
 * So this pins the new implementation against a faithful copy of the OLD
 * algorithm across many generated graphs. `referenceWaves` below is that copy,
 * lifted from the shape both tiers used, and lives only in this test file.
 *
 * On acyclic graphs the two must agree exactly — that is the migration's
 * safety claim. On cyclic graphs they deliberately DIVERGE, and the divergence
 * is the bug being fixed; that case is asserted separately at the bottom rather
 * than swept into the parity loop.
 */

interface RefNode { id: string; dependsOn: string[] }

/** The pre-migration algorithm: Kahn's, collecting each zero-in-degree wave. */
function referenceWaves(nodes: readonly RefNode[]): string[][] {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();
  for (const node of nodes) {
    inDegree.set(node.id, 0);
    if (!dependents.has(node.id)) dependents.set(node.id, new Set());
  }
  for (const node of nodes) {
    for (const dependencyId of node.dependsOn) {
      dependents.get(dependencyId)!.add(node.id);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
    }
  }

  const done = new Set<string>();
  const waves: string[][] = [];
  while (done.size < nodes.length) {
    // Source order, exactly as both tiers iterated their arrays.
    const ready = nodes.filter((node) => !done.has(node.id) && (inDegree.get(node.id) ?? 0) === 0);
    if (ready.length === 0) break; // cyclic — handled outside the parity claim
    waves.push(ready.map((node) => node.id));
    for (const node of ready) {
      done.add(node.id);
      for (const dependentId of dependents.get(node.id) ?? []) {
        inDegree.set(dependentId, (inDegree.get(dependentId) ?? 1) - 1);
      }
    }
  }
  return waves;
}

async function schedulerWaves(nodes: readonly RefNode[]): Promise<string[][]> {
  const compiled = compileTaskGraph(
    nodes.map((node) => ({
      id: node.id,
      title: node.id,
      kind: 'subtask' as const,
      dependsOn: node.dependsOn,
      payload: node.id,
    })),
    { mode: 'repair' },
  );
  const result = await new DependencyScheduler(compiled.graph, {
    execute: async (node) => node.id,
  }).run();
  return result.waves.map((wave) => [...wave]);
}

/** Deterministic PRNG so a failure is reproducible from the seed alone. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Random DAG: edges only ever point backwards in index order, which makes a
 * cycle impossible by construction rather than by rejection sampling.
 */
function randomDag(seed: number, size: number, density: number): RefNode[] {
  const next = rng(seed);
  const nodes: RefNode[] = [];
  for (let index = 0; index < size; index++) {
    const dependsOn: string[] = [];
    for (let earlier = 0; earlier < index; earlier++) {
      if (next() < density) dependsOn.push(`n${earlier}`);
    }
    nodes.push({ id: `n${index}`, dependsOn });
  }
  return nodes;
}

describe('scheduler parity with the pre-migration Kahn implementation', () => {
  it('produces identical waves across 600 generated DAGs', async () => {
    const mismatches: string[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      for (const density of [0.1, 0.3, 0.6]) {
        const size = 2 + (seed % 12);
        const nodes = randomDag(seed, size, density);
        const expected = referenceWaves(nodes);
        const actual = await schedulerWaves(nodes);
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          mismatches.push(
            `seed=${seed} density=${density} size=${size}\n` +
            `  reference: ${JSON.stringify(expected)}\n` +
            `  scheduler: ${JSON.stringify(actual)}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('agrees on the shapes both tiers actually produce', async () => {
    const shapes: Record<string, RefNode[]> = {
      // Every section independent — the common T1 plan.
      fanout: [
        { id: 'a', dependsOn: [] }, { id: 'b', dependsOn: [] }, { id: 'c', dependsOn: [] },
      ],
      // Strictly sequential — "write code, then test it".
      chain: [
        { id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }, { id: 'c', dependsOn: ['b'] },
      ],
      // Fan out then join, the shape a research→synthesize plan makes.
      diamond: [
        { id: 'a', dependsOn: [] },
        { id: 'b', dependsOn: ['a'] },
        { id: 'c', dependsOn: ['a'] },
        { id: 'd', dependsOn: ['b', 'c'] },
      ],
      // A single node, which is the correct plan for a small task.
      single: [{ id: 'only', dependsOn: [] }],
    };
    for (const [name, nodes] of Object.entries(shapes)) {
      expect(await schedulerWaves(nodes), name).toEqual(referenceWaves(nodes));
    }
  });

  it('DIVERGES from the reference on a cycle — which is the fix, not a regression', async () => {
    // root → a ⇄ b → tail. The old algorithm drains only `root`, then stalls
    // with three nodes left and no zero-in-degree node; both tiers then broke
    // the cycle by zeroing everything it could not reach, including `tail`.
    const nodes: RefNode[] = [
      { id: 'root', dependsOn: [] },
      { id: 'a', dependsOn: ['root', 'b'] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'tail', dependsOn: ['b'] },
    ];
    expect(referenceWaves(nodes)).toEqual([['root']]); // stalls, never schedules the rest

    // The compiler repairs only the two real cycle members, so `tail` still
    // waits for `b` instead of being force-started alongside `root`.
    expect(await schedulerWaves(nodes)).toEqual([['root', 'b'], ['a', 'tail']]);
  });
});
