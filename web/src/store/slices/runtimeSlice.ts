import { createSlice, createSelector, createAsyncThunk, type PayloadAction } from '@reduxjs/toolkit';
import type { RuntimeSession, RuntimeNode, RuntimeNodeLog, RuntimeSnapshot } from '../../hooks/useWebSocket';

export const fetchHistory = createAsyncThunk(
  'runtime/fetchHistory',
  async ({ sessionId, before, limit = 100 }: { sessionId: string; before?: string; limit?: number }, { getState }) => {
    const token = localStorage.getItem('cascade_token');
    const response = await fetch(`/api/runtime/logs/${sessionId}?limit=${limit}${before ? `&before=${before}` : ''}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw new Error('Failed to fetch history');
    const logs = await response.json() as RuntimeNodeLog[];
    return { sessionId, logs };
  }
);

interface RuntimeState {
  sessions: Record<string, RuntimeSession>;
  nodes: Record<string, RuntimeNode>;
  logs: Record<string, RuntimeNodeLog[]>;
  activeSessionId: string | null;
  scope: 'workspace' | 'global';
  connected: boolean;
}

const initialState: RuntimeState = {
  sessions: {},
  nodes: {},
  logs: {},
  activeSessionId: null,
  scope: 'workspace',
  connected: false,
};

export const runtimeSlice = createSlice({
  name: 'runtime',
  initialState,
  reducers: {
    setConnected: (state, action: PayloadAction<boolean>) => {
      state.connected = action.payload;
    },
    setScope: (state, action: PayloadAction<'workspace' | 'global'>) => {
      state.scope = action.payload;
    },
    setActiveSession: (state, action: PayloadAction<string | null>) => {
      state.activeSessionId = action.payload;
    },
    updateRTKSnapshot: (state, action: PayloadAction<RuntimeSnapshot>) => {
      const { sessions, scope } = action.payload;
      if (scope) state.scope = scope as any;
      
      // Update sessions (normalized)
      sessions.forEach(s => {
        state.sessions[s.sessionId] = { ...(state.sessions[s.sessionId] || {}), ...s };
      });

      // If no active session, pick the first one from the new list
      if (!state.activeSessionId && sessions.length > 0) {
        state.activeSessionId = sessions.find(s => s.status === 'ACTIVE')?.sessionId || sessions[0].sessionId;
      }
    },
    updateSessionDetails: (state, action: PayloadAction<{ sessionId: string; nodes: RuntimeNode[]; logs: RuntimeNodeLog[] }>) => {
      const { sessionId, nodes, logs } = action.payload;
      
      // Update nodes for this session
      nodes.forEach(n => {
        const key = `${sessionId}:${n.tierId}`;
        state.nodes[key] = { ...(state.nodes[key] || {}), ...n };
      });

      // Update logs (merge and sort)
      const existingLogs = state.logs[sessionId] || [];
      const logMap = new Map(existingLogs.map(l => [l.id, l]));
      logs.forEach(l => logMap.set(l.id, l));
      state.logs[sessionId] = Array.from(logMap.values())
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .slice(-1000); // Cap logs at 1000
    },
    appendLog: (state, action: PayloadAction<RuntimeNodeLog>) => {
      const log = action.payload;
      const history = state.logs[log.sessionId] || [];
      if (!history.find(l => l.id === log.id)) {
        state.logs[log.sessionId] = [...history, log].slice(-1000);
      }
    }
  },
  extraReducers: (builder) => {
    builder.addCase(fetchHistory.fulfilled, (state, action) => {
      const { sessionId, logs } = action.payload;
      const existing = state.logs[sessionId] || [];
      const logMap = new Map(existing.map(l => [l.id, l]));
      logs.forEach(l => logMap.set(l.id, l));
      state.logs[sessionId] = Array.from(logMap.values())
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
        .slice(-2000); // Allow more for history
    });
  }
});

export const { setConnected, setScope, setActiveSession, updateRTKSnapshot, updateSessionDetails, appendLog } = runtimeSlice.actions;

// Selectors
export const selectRuntime = (state: { runtime: RuntimeState }) => state.runtime;
export const selectSessions = createSelector(selectRuntime, r => Object.values(r.sessions).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()));
export const selectActiveSession = createSelector(selectRuntime, r => r.activeSessionId ? r.sessions[r.activeSessionId] : null);
export const selectActiveNodes = createSelector(selectRuntime, r => {
  if (!r.activeSessionId) return [];
  return Object.values(r.nodes).filter(n => n.sessionId === r.activeSessionId);
});
export const selectActiveLogs = createSelector(selectRuntime, r => r.activeSessionId ? r.logs[r.activeSessionId] || [] : []);

export default runtimeSlice.reducer;
