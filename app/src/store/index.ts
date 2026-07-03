import { configureStore, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { useDispatch, useSelector } from 'react-redux';

// ─── Types ────────────────────────────────────────────────────────────────────
export type ViewMode = 'onboarding' | 'cockpit' | 'chat' | 'code';
export type ThemePref = 'system' | 'light' | 'dark' | 'midnight';

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

export interface RuntimeSession {
  sessionId: string;
  title: string;
  workspacePath: string;
  status: 'ACTIVE' | 'COMPLETED' | 'FAILED';
  startedAt: string;
  updatedAt: string;
  latestPrompt?: string;
  isGlobal?: boolean;
}

export interface AppTab {
  id: string;
  type: 'file' | 'session';
  title: string;
  path?: string;
  sessionId?: string;
  isDirty?: boolean;
}

/** A tool-approval request escalated to the user for a decision. */
export interface PendingApproval {
  id: string;
  sessionId?: string;
  toolName: string;
  input?: Record<string, unknown>;
  requestedBy?: string;
  subtaskContext?: string;
  sectionContext?: string;
  /** Advisory verdicts recorded by T2/T1 as the request escalated. */
  trail?: Array<{ tier: 'T2' | 'T1'; verdict: 'approve' | 'deny' | 'unsure'; reason?: string }>;
}

export interface AppState {
  view: ViewMode;
  connected: boolean;
  reconnecting: boolean;
  backendError: string | null;
  showSettings: boolean;
  backendPort: number;
  authToken: string;
  sessionId: string | null;
  sessionTitle: string;
  totalCostUsd: number;
  totalTokens: number;
  activeModel: { t1: string; t2: string; t3: string; chat: string };
  agents: AgentNode[];
  messages: ChatMessage[];
  workspacePath: string;
  terminalVisible: boolean;
  /** Directory the integrated terminal should open in (falls back to workspacePath). */
  terminalCwd: string | null;
  codeChatVisible: boolean;
  helpContext: string | null;
  themePref: ThemePref;
  themeDark: boolean;
  // v0.12.0 additions
  sessions: RuntimeSession[];
  activeSessionId: string | null;
  sessionSidebarCollapsed: boolean;
  openTabs: AppTab[];
  activeTabId: string | null;
  onboardingDone: boolean;
  /** Tool-approval requests awaiting the user's decision (FIFO). */
  pendingApprovals: PendingApproval[];
  /** Agent node selected in the Cockpit graph (shows its live detail panel). */
  selectedNodeId: string | null;
  /** Transient peer-communication edges, auto-expired shortly after arriving. */
  peerEdges: PeerEdge[];
  /** Manual routing override — pins the run's root tier (Auto = classifier decides). */
  forceTier: 'auto' | 'T1' | 'T2' | 'T3';
  /**
   * A run is in flight. Store-level (NOT component state) so the Stop control
   * survives view switches — views are conditionally mounted, so any useState
   * tracking this dies the moment the user leaves the view that started the run.
   */
  runActive: boolean;
  /** The sessionId of the in-flight run — the target for session:halt. */
  runSessionId: string | null;
}

/** A live T3↔T3 / T2↔T2 message, drawn as a transient edge in the graph. */
export interface PeerEdge {
  id: string;
  fromId: string;
  toId: string;
  syncType?: string;
  at: number;
}

const initialState: AppState = {
  view: 'cockpit',
  connected: false,
  reconnecting: false,
  backendError: null,
  showSettings: false,
  backendPort: 0,
  authToken: '',
  sessionId: null,
  sessionTitle: 'Cascade AI',
  totalCostUsd: 0,
  totalTokens: 0,
  activeModel: { t1: 'auto', t2: 'auto', t3: 'auto', chat: 'auto' },
  agents: [],
  messages: [],
  workspacePath: '',
  terminalVisible: false,
  terminalCwd: null,
  codeChatVisible: false,
  helpContext: null,
  themePref: 'system',
  themeDark: true,
  sessions: [],
  activeSessionId: null,
  sessionSidebarCollapsed: false,
  openTabs: [],
  activeTabId: null,
  onboardingDone: true, // assume done until we check IPC; avoids onboarding flash
  pendingApprovals: [],
  selectedNodeId: null,
  peerEdges: [],
  forceTier: 'auto',
  runActive: false,
  runSessionId: null,
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
    setBackendError(state, action: PayloadAction<string | null>) {
      state.backendError = action.payload;
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
      // Preserve the accumulated per-node stream across status updates (which
      // arrive without it) so the node-detail panel keeps the worker's output.
      if (idx >= 0) state.agents[idx] = { ...action.payload, stream: state.agents[idx]!.stream };
      else state.agents.push(action.payload);
    },
    // Per-node live output (every tier), shown in the Cockpit node-detail panel.
    appendAgentStream(state, action: PayloadAction<{ id: string; text: string }>) {
      const node = state.agents.find((a) => a.id === action.payload.id);
      if (node) node.stream = (node.stream ?? '') + action.payload.text;
    },
    selectNode(state, action: PayloadAction<string | null>) {
      state.selectedNodeId = action.payload;
    },
    addPeerEdge(state, action: PayloadAction<PeerEdge>) {
      state.peerEdges.push(action.payload);
      if (state.peerEdges.length > 40) state.peerEdges.splice(0, state.peerEdges.length - 40);
    },
    expirePeerEdges(state, action: PayloadAction<number>) {
      state.peerEdges = state.peerEdges.filter((e) => e.at > action.payload);
    },
    setForceTier(state, action: PayloadAction<'auto' | 'T1' | 'T2' | 'T3'>) {
      state.forceTier = action.payload;
    },
    // Run lifecycle — dispatched wherever a run starts (ChatPanel, Cockpit) and
    // ended by the GLOBAL session:complete/session:error handlers in App.tsx.
    runStarted(state, action: PayloadAction<{ sessionId: string }>) {
      state.runActive = true;
      state.runSessionId = action.payload.sessionId;
    },
    runEnded(state) {
      state.runActive = false;
      state.runSessionId = null;
    },
    appendMessage(state, action: PayloadAction<ChatMessage>) {
      state.messages.push(action.payload);
    },
    // Resume a stored session: replace the live transcript wholesale and make
    // the session current, so the next send continues it server-side.
    loadTranscript(state, action: PayloadAction<{ sessionId: string; messages: ChatMessage[] }>) {
      state.messages = action.payload.messages;
      state.sessionId = action.payload.sessionId;
      state.activeSessionId = action.payload.sessionId;
    },
    updateLastMessage(state, action: PayloadAction<{ content: string; streaming: boolean }>) {
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant') {
        // Append streamed deltas (the backend emits token-by-token); an empty
        // content with streaming:false is the completion signal (no-op append).
        last.content += action.payload.content;
        last.streaming = action.payload.streaming;
      }
    },
    finalizeLastMessage(state, action: PayloadAction<{ finalOutput?: string }>) {
      const last = state.messages[state.messages.length - 1];
      if (last?.role === 'assistant') {
        if (!last.content && action.payload.finalOutput) {
          last.content = action.payload.finalOutput;
        }
        last.streaming = false;
      }
    },
    setWorkspacePath(state, action: PayloadAction<string>) {
      state.workspacePath = action.payload;
    },
    toggleTerminal(state) {
      state.terminalVisible = !state.terminalVisible;
    },
    // "Open Terminal Here" from the file explorer: point the PTY at the
    // folder and make sure the bottom panel is showing.
    openTerminalAt(state, action: PayloadAction<string>) {
      state.terminalCwd = action.payload;
      state.terminalVisible = true;
    },
    toggleCodeChat(state) {
      state.codeChatVisible = !state.codeChatVisible;
    },
    setHelpContext(state, action: PayloadAction<string | null>) {
      state.helpContext = action.payload;
    },
    setTheme(state, action: PayloadAction<{ preference: ThemePref; dark: boolean }>) {
      state.themePref = action.payload.preference;
      state.themeDark = action.payload.dark;
    },
    setActiveModel(state, action: PayloadAction<Partial<{ t1: string; t2: string; t3: string }>>) {
      state.activeModel = { ...state.activeModel, ...action.payload };
    },
    setActiveModelT1(state, action: PayloadAction<string>) {
      state.activeModel.t1 = action.payload;
    },
    setActiveModelChat(state, action: PayloadAction<string>) {
      state.activeModel.chat = action.payload;
    },
    // Session sidebar
    setSessions(state, action: PayloadAction<RuntimeSession[]>) {
      state.sessions = action.payload;
    },
    setActiveSessionId(state, action: PayloadAction<string | null>) {
      state.activeSessionId = action.payload;
    },
    removeSession(state, action: PayloadAction<string>) {
      state.sessions = state.sessions.filter((s) => s.sessionId !== action.payload);
      if (state.activeSessionId === action.payload) state.activeSessionId = null;
    },
    toggleSessionSidebar(state) {
      state.sessionSidebarCollapsed = !state.sessionSidebarCollapsed;
    },
    setSessionSidebarCollapsed(state, action: PayloadAction<boolean>) {
      state.sessionSidebarCollapsed = action.payload;
    },
    // Tool approvals
    enqueueApproval(state, action: PayloadAction<PendingApproval>) {
      if (!state.pendingApprovals.some((a) => a.id === action.payload.id)) {
        state.pendingApprovals.push(action.payload);
      }
    },
    dequeueApproval(state, action: PayloadAction<string>) {
      state.pendingApprovals = state.pendingApprovals.filter((a) => a.id !== action.payload);
    },
    clearApprovals(state) {
      state.pendingApprovals = [];
    },
    // Tab bar
    openTab(state, action: PayloadAction<AppTab>) {
      const existing = state.openTabs.findIndex((t) => t.id === action.payload.id);
      if (existing < 0) state.openTabs.push(action.payload);
      state.activeTabId = action.payload.id;
    },
    closeTab(state, action: PayloadAction<string>) {
      const idx = state.openTabs.findIndex((t) => t.id === action.payload);
      state.openTabs = state.openTabs.filter((t) => t.id !== action.payload);
      if (state.activeTabId === action.payload) {
        state.activeTabId = state.openTabs[Math.max(0, idx - 1)]?.id ?? null;
      }
    },
    setActiveTab(state, action: PayloadAction<string>) {
      state.activeTabId = action.payload;
    },
    setTabDirty(state, action: PayloadAction<{ id: string; dirty: boolean }>) {
      const tab = state.openTabs.find((t) => t.id === action.payload.id);
      if (tab) tab.isDirty = action.payload.dirty;
    },
    // Onboarding
    setOnboardingDone(state, action: PayloadAction<boolean>) {
      state.onboardingDone = action.payload;
      if (action.payload && state.view === 'onboarding') state.view = 'cockpit';
    },
  },
});

export const {
  setView, setConnected, setReconnecting, setBackendError, setShowSettings, setMeta, setSessionId, updateCost,
  setAgents, upsertAgent, appendMessage, updateLastMessage, finalizeLastMessage, loadTranscript,
  setWorkspacePath, toggleTerminal, openTerminalAt, toggleCodeChat, setHelpContext, setTheme, setActiveModel, setActiveModelT1, setActiveModelChat,
  setSessions, setActiveSessionId, removeSession, toggleSessionSidebar, setSessionSidebarCollapsed,
  enqueueApproval, dequeueApproval, clearApprovals,
  appendAgentStream, selectNode, addPeerEdge, expirePeerEdges, setForceTier, runStarted, runEnded,
  openTab, closeTab, setActiveTab, setTabDirty,
  setOnboardingDone,
} = appSlice.actions;

// ─── Store ────────────────────────────────────────────────────────────────────
export const store = configureStore({ reducer: { app: appSlice.reducer } });

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

export const useAppDispatch = () => useDispatch<AppDispatch>();
export const useAppSelector = <T>(selector: (s: RootState) => T) => useSelector(selector);
