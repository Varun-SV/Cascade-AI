/**
 * runtime.ts — pure utility functions for runtime data manipulation.
 *
 * These helpers operate on plain data and have no React or Redux dependencies,
 * making them easy to unit-test in isolation.
 */

import type { RuntimeSnapshotPayload as RuntimeSnapshot } from '../types/protocol';

/**
 * Deep-merge two runtime snapshots, deduplicating by natural key.
 * Later items in `next` win over `prev` for the same key.
 *
 * Note: logs are sorted ascending (oldest first) so they can be
 * appended to a virtual-list without reordering on every update.
 * The original code sorted descending, which reversed display order.
 */
export function mergeRuntimeSnapshots(
  prev: RuntimeSnapshot,
  next: RuntimeSnapshot,
): RuntimeSnapshot {
  const sessionMap = new Map(
    (prev.sessions ?? []).map((s) => [s.sessionId, s] as const),
  );
  for (const s of next.sessions ?? []) sessionMap.set(s.sessionId, s);

  const nodeMap = new Map(
    (prev.nodes ?? []).map((n) => [n.tierId, n] as const),
  );
  for (const n of next.nodes ?? []) nodeMap.set(n.tierId, n);

  const logMap = new Map(
    (prev.logs ?? []).map((l) => [l.id, l] as const),
  );
  for (const l of next.logs ?? []) logMap.set(l.id, l);

  return {
    ...prev,
    ...next,
    sessions: [...sessionMap.values()].sort(
      // Newest session first
      (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    ),
    nodes: [...nodeMap.values()].sort(
      // Most-recently-updated node first
      (a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''),
    ),
    logs: [...logMap.values()].sort(
      // Oldest log first (ascending chronological) — was descending in original
      (a, b) => (a.timestamp ?? '').localeCompare(b.timestamp ?? ''),
    ),
  };
}

/**
 * Strip the tier-role prefix (e.g. "[T2] ") from a node label if present.
 * Useful for display contexts where the role badge is already shown.
 */
export function formatNodeLabel(label: string, role: string): string {
  return label.replace(new RegExp(`^\\[${role}\\]\\s+`, 'i'), '');
}
