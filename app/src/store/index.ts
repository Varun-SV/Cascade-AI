import { configureStore, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';

// ─── Types ────────────────────────────────────────────────────────────────────
export type ViewMode = 'cockpit' | 'chat' | 'code';

export interface AgentNode {
  id: string;
  tier: 'T1' | 'T2' | 'T3';
  label: string;
  status: 'IDLE' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'ESCALATED';
  progressPct?: number;
  currentAction?: string;
  parentId?: string;
  stream?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  timestamp: number;
  streaming?: boolean;
}

export interface AppState {
  view: ViewMode;
  connected: boolean;
  reconnecting: boolean;
  showSettings: boolean;
  backendPort: number;
  authToken: string;
  sessionId: string | null;
  sessionTitle: string;
  totalCostUsd: number;
  totalTokens: number;
  activeModel: { t1: string; t2: string; t3: string };
  agents: AgentNode[];
  messages: ChatMessage[];
  workspacePath: string;
  terminalVisible: boolean;
  helpContext: string | null;
}

const initialState: AppState = {
  view: 'cockpit',
  connected: false,
  reconnecting: false,
  showSettings: false,
  backendPort: 0,
  authToken: '',
  sessionId: null,
  sessionTitle: 'Cascade AI',
  totalCostUsd: 0,
  totalTokens: 0,
  activeModel: { t1: 'auto', t2: 'auto', t3: 'auto' },
  agents: [],
  messages: [],
  workspacePath: '',
  terminalVisible: false,
  helpContext: null,
};

// ─── Slice ────────────────────────────────────────────────────────────────────
const appSlice = createSlice({
  name: 'app',
  initialState,
  reducers: {
    setView(state, action: PayloadAction<ViewMode>) {
      state.view = action.payload;
    },
    setConnected(state, action: PayloadAction<boolean>) {
      state.connected = action.payload;
    },
    setReconnecting(state, action: PayloadAction<boolean>) {
      state.reconnecting = action.payload;
    },
    setShowSettings(state, action: PayloadAction<boolean>) {
      state.showSettings = action.payload;
    },
    setMeta(state, action: PayloadAction<{ port: number; token: string }>) {
      state.backendPort = action.payload.port;
      state.authToken = action.payload.token;
    },
    setSessionId(state, action: PayloadAction<string | null>) {
      state.sessionId = action.payload;
    },
    updateCost(state, action: PayloadAction<{ totalCostUsd: number; totalTokens: number }>) {
      state.totalCostUsd = action.payload.totalCostUsd;
      state.totalTokens = action.payload.totalTokens;
    },
    setAgents(state, action: PayloadAction<AgentNode[]>) {
      state.agents = action.payload;
    },
    upsertAgent(state, action: PayloadAction<AgentNode>) {
      const idx = state.agents.findIndex((a) => a.id === action.payload.id);
      if (idx >= 0) state.agents[idx] = action.payload;
      else state.agents.push(action.payload);
    },
    appendMessage(state, action: PayloadAction<ChatMessage>) {
      state.messages.push(action.payload);
    },
    updateLastMessage(state, action: PayloadAction<{ content: string; streaming: boolean }>) {
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant') {
        last.content = action.payload.content;
        last.streaming = action.payload.streaming;
      }
    },
    setWorkspacePath(state, action: PayloadAction<string>) {
      state.workspacePath = action.payload;
    },
    toggleTerminal(state) {
      state.terminalVisible = !state.terminalVisible;
    },
    setHelpContext(state, action: PayloadAction<string | null>) {
      state.helpContext = action.payload;
    },
    setActiveModel(state, action: PayloadAction<Partial<{ t1: string; t2: string; t3: string }>>) {
      state.activeModel = { ...state.activeModel, ...action.payload };
    },
  },
});

export const {
  setView, setConnected, setReconnecting, setShowSettings, setMeta, setSessionId, updateCost,
  setAgents, upsertAgent, appendMessage, updateLastMessage,
  setWorkspacePath, toggleTerminal, setHelpContext, setActiveModel,
} = appSlice.actions;

// ─── Store ────────────────────────────────────────────────────────────────────
export const store = configureStore({ reducer: { app: appSlice.reducer } });

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector = <T>(selector: (s: RootState) => T) => useSelector(selector);
