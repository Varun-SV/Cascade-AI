export interface RuntimeSnapshot {
  scope?: string;
  source?: string;
  fetchedAt?: string;
  sessions: any[];
  nodes: any[];
  logs: any[];
}

export function mergeRuntimeSnapshots(prev: RuntimeSnapshot, next: RuntimeSnapshot): RuntimeSnapshot {
  const sessionMap = new Map((prev.sessions || []).map((s) => [s.sessionId, s] as const));
  for (const session of next.sessions || []) sessionMap.set(session.sessionId, session);

  const nodeMap = new Map((prev.nodes || []).map((n) => [n.tierId, n] as const));
  for (const node of next.nodes || []) nodeMap.set(node.tierId, node);

  const logMap = new Map((prev.logs || []).map((l) => [l.id, l] as const));
  for (const log of next.logs || []) logMap.set(log.id, log);

  return {
    ...prev,
    ...next,
    sessions: [...sessionMap.values()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')),
    nodes: [...nodeMap.values()].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')),
    logs: [...logMap.values()].sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || '')),
  };
}

export function formatNodeLabel(label: string, role: string): string {
  const prefix = new RegExp(`^\\[${role}\\]\\s+`, 'i');
  return label.replace(prefix, '');
}
