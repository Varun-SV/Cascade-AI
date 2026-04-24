import {
  createSlice,
  createSelector,
  createAsyncThunk,
  type PayloadAction,
} from '@reduxjs/toolkit';
import type {
  RuntimeNode,
  RuntimeNodeLog,
  RuntimeScope,
  RuntimeSession,
  RuntimeSnapshotPayload,
} from '../../types/protocol';

// ── Async thunk ────────────────────────────────

export const fetchHistory = createAsyncThunk(
  'runtime/fetchHistory',
  async ({ sessionId, before, limit = 100 }: { sessionId: string; before?: string; limit?: number }) => {
    const token = localStorage.getItem('cascade_token') ?? '';
    const url = `/api/runtime/logs/${sessionId}?limit=${limit}${before ? `&before=${before}` : ''}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error('Failed to fetch history');
    const logs = (await response.json()) as RuntimeNodeLog[];
    return { sessionId, logs };
  },
);

// ── Peer message type ──────────────────────────

export interface PeerMessageRecord {
  fromId: string;
  toId?: string;
  syncType: string;
  payload?: string;
  timestamp: string;
  sessionId: string;
}

// ── State shape ────────────────────────────────

interface RuntimeState {
  sessions: Record<string, RuntimeSession>;
  nodes: Record<string, RuntimeNode>;
  // Per-session log IDs for O(1) duplicate detection
  logIds: Record<string, Set<string>>;
  logs: Record<string, RuntimeNodeLog[]>;
  activeSessionId: string | null;
  scope: RuntimeScope;
  connected: boolean;
  peerMessages: PeerMessageRecord[];
}

const initialState: RuntimeState = {
  sessions: {},
  nodes: {},
  logIds: {},
  logs: {},
  activeSessionId: null,
  scope: 'workspace',
  connected: false,
  peerMessages: [],
};

// ── Helpers ────────────────────────────────────

/** Merge a node array into the normalised node map. */
function mergeNodes(
  nodeMap: Record<string, RuntimeNode>,
  nodes: RuntimeNode[],
  sessionId?: string,
): void {
  for (const n of nodes) {
    // Nodes from REST snapshots may not carry sessionId; fill it in when provided
    const sid = n.sessionId ?? sessionId ?? '';
    const key = `${sid}:${n.tierId}`;
    const existing = nodeMap[key];
    // Preserve a non-null existing output — a later status-only update
    // (which has output: undefined) must NOT overwrite a previously-persisted result.
    const preservedOutput = n.output ?? existing?.output;
    nodeMap[key] = { ...existing, ...n, sessionId: sid, output: preservedOutput };
  }
}

/** Merge a log array into per-session logs, deduplicating in O(1). */
function mergeLogs(
  state: RuntimeState,
  sessionId: string,
  incoming: RuntimeNodeLog[],
  cap = 1000,
): void {
  if (!state.logIds[sessionId]) state.logIds[sessionId] = new Set();
  if (!state.logs[sessionId]) state.logs[sessionId] = [];

  const ids = state.logIds[sessionId]!;
  const list = state.logs[sessionId]!;

  for (const log of incoming) {
    if (ids.has(log.id)) continue;
    ids.add(log.id);
    list.push(log);
  }

  if (list.length > cap) {
    const removed = list.splice(0, list.length - cap);
    for (const r of removed) ids.delete(r.id);
  }
}

// ── Slice ──────────────────────────────────────

export const runtimeSlice = createSlice({
  name: 'runtime',
  initialState,
  reducers: {
    setConnected(state: RuntimeState, action: PayloadAction<boolean>) {
      state.connected = action.payload;
    },

    setScope(state: RuntimeState, action: PayloadAction<RuntimeScope>) {
      state.scope = action.payload;
    },

    setActiveSession(state: RuntimeState, action: PayloadAction<string | null>) {
      state.activeSessionId = action.payload;
    },

    /**
     * Applied to the full REST snapshot returned by /api/runtime.
     * Previously this ignored `nodes` — now it processes them too so the
     * topology graph is populated after the first HTTP fetch.
     */
    updateRTKSnapshot(state: RuntimeState, action: PayloadAction<RuntimeSnapshotPayload>) {
      const { sessions, nodes, logs, scope } = action.payload;

      // Scope — validated cast (avoids `as any`)
      if (scope === 'workspace' || scope === 'global') {
        state.scope = scope;
      }

      // Sessions
      for (const s of sessions) {
        state.sessions[s.sessionId] = { ...(state.sessions[s.sessionId] ?? {}), ...s };
      }

      // Auto-select active session
      if (!state.activeSessionId && sessions.length > 0) {
        state.activeSessionId =
          sessions.find((s: RuntimeSession) => s.status === 'ACTIVE')?.sessionId ?? sessions[0]!.sessionId;
      }

      // Nodes — previously missing, causing topology to stay empty after REST fetch
      if (nodes?.length) {
        mergeNodes(state.nodes, nodes);
      }

      // Logs (optional in snapshot)
      if (logs?.length) {
        for (const log of logs) {
          if (log.sessionId) mergeLogs(state, log.sessionId, [log]);
        }
      }
    },

    updateSessionDetails(
      state: RuntimeState,
      action: PayloadAction<{ sessionId: string; nodes: RuntimeNode[]; logs: RuntimeNodeLog[] }>,
    ) {
      const { sessionId, nodes, logs } = action.payload;
      mergeNodes(state.nodes, nodes, sessionId);
      mergeLogs(state, sessionId, logs);

      // Sort per-session logs by timestamp (cheap — only at socket push time)
      state.logs[sessionId]?.sort(
        (a: RuntimeNodeLog, b: RuntimeNodeLog) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
    },

    appendLog(state: RuntimeState, action: PayloadAction<RuntimeNodeLog>) {
      const log = action.payload;
      mergeLogs(state, log.sessionId, [log]);
    },

    clearFrontendGraphs(state: RuntimeState) {
      state.nodes = {};
      state.logIds = {};
      state.logs = {};
    },

    removeSessionsBulk(state: RuntimeState, action: PayloadAction<string[]>) {
      for (const id of action.payload) {
        delete state.sessions[id];
        // Clean up nodes and logs for removed sessions
        for (const key of Object.keys(state.nodes)) {
          if (state.nodes[key]?.sessionId === id) delete state.nodes[key];
        }
        delete state.logs[id];
        delete state.logIds[id];
      }
      // If active session was deleted, select the next available one
      if (state.activeSessionId && action.payload.includes(state.activeSessionId)) {
        const remaining = Object.values(state.sessions);
        state.activeSessionId = remaining[0]?.sessionId ?? null;
      }
    },

    addPeerMessage(state: RuntimeState, action: PayloadAction<PeerMessageRecord>) {
      state.peerMessages.push(action.payload);
      // Cap at 200 messages to prevent unbounded growth
      if (state.peerMessages.length > 200) {
        state.peerMessages = state.peerMessages.slice(-200);
      }
    },
  },

  extraReducers(builder) {
    builder.addCase(fetchHistory.fulfilled, (state: RuntimeState, action) => {
      const { sessionId, logs } = action.payload;
      mergeLogs(state, sessionId, logs, 2000);
      state.logs[sessionId]?.sort(
        (a: RuntimeNodeLog, b: RuntimeNodeLog) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
      );
    });
  },
});

export const {
  setConnected,
  setScope,
  setActiveSession,
  updateRTKSnapshot,
  updateSessionDetails,
  appendLog,
  clearFrontendGraphs,
  removeSessionsBulk,
  addPeerMessage,
} = runtimeSlice.actions;

// ── Selectors ──────────────────────────────────

const selectRuntime = (state: { runtime: RuntimeState }) => state.runtime;

export const selectSessions = createSelector(selectRuntime, (r: RuntimeState) =>
  Object.values(r.sessions).sort(
    (a: RuntimeSession, b: RuntimeSession) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  ),
);

export const selectActiveSession = createSelector(selectRuntime, (r: RuntimeState) =>
  r.activeSessionId ? (r.sessions[r.activeSessionId] ?? null) : null,
);

export const selectActiveNodes = createSelector(selectRuntime, (r: RuntimeState) => {
  if (!r.activeSessionId) return [];
  return Object.values(r.nodes).filter((n: RuntimeNode) => n.sessionId === r.activeSessionId);
});

export const selectActiveLogs = createSelector(selectRuntime, (r: RuntimeState) =>
  r.activeSessionId ? (r.logs[r.activeSessionId] ?? []) : [],
);

export const selectIsConnected = createSelector(selectRuntime, (r: RuntimeState) => r.connected);

export const selectPeerMessages = createSelector(selectRuntime, (r: RuntimeState) => r.peerMessages);

export default runtimeSlice.reducer;
