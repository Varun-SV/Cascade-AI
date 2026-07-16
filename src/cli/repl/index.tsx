// ─────────────────────────────────────────────
//  Cascade AI — Interactive REPL (ink)
// ─────────────────────────────────────────────

import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Static, Text, useApp, useInput, useStdout } from 'ink';
import { SafeTextInput } from '../components/SafeTextInput.js';
import { sanitizeTerminalInput, containsMouseSequence } from '../utils/terminal-input.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  ApprovalRequest,
  CascadeConfig,
  ConversationMessage,
  ModelInfo,
  PeerMessageEvent,
  ProviderType,
  RuntimeNode,
  RuntimeNodeLog,
  Session,
  Theme,
  Message,
} from '../../types.js';
import { CASCADE_DB_FILE, GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE } from '../../constants.js';
import { Cascade, type DecisionLogEntry } from '../../core/cascade.js';
import { MemoryStore } from '../../memory/store.js';
import { ModelSelector } from '../../core/router/selector.js';
import { OpenAIProvider } from '../../providers/openai.js';
import { GeminiProvider } from '../../providers/gemini.js';
import { AnthropicProvider } from '../../providers/anthropic.js';
import { OllamaProvider } from '../../providers/ollama.js';
import { OpenAICompatibleProvider } from '../../providers/openai-compatible.js';
import type { BaseProvider } from '../../providers/base.js';
import { getTheme } from '../themes/index.js';
import { SlashCommandRegistry } from '../slash/index.js';
import { computeAdaptiveLayoutMode, computeLiveAreaBudget, computeTranscriptRows, flattenTranscript, windowTranscript } from './layout.js';
import { disableMouseReporting } from '../utils/terminal-input.js';
import { writeClipboardSync } from '../utils/clipboard.js';
import { AgentTree, type TierNode } from './components/AgentTree.js';
import { TimelinePanel } from './components/TimelinePanel.js';
import { StatusBar } from './components/StatusBar.js';
import { HintBar } from './components/HintBar.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { ModelsDisplay, type ModelPickerSelection } from './components/ModelsDisplay.js';
import { CostTracker } from './components/CostTracker.js';
import { CompactStatus } from './components/CompactStatus.js';
import { ChatMessage } from './components/ChatMessage.js';
import { PeerFeed } from './components/PeerFeed.js';
import { PlanApproval, type PlanApprovalRequest } from './components/PlanApproval.js';

// Keep only the most recent peer-comms events — a long run can produce
// thousands and the feed only ever shows the last handful.
const PEER_EVENT_BUFFER = 50;

// Show only the last N lines of a streaming buffer in the live area so a
// long generation can't push the rest of the TUI off-screen. The full text
// appears in scrollback once the stream commits as a message.
function tailLines(text: string, n: number): string[] {
  const lines = text.split('\n');
  return lines.slice(-n);
}

function activeTierSummary(root: TierNode | null): { t2: number; t3: number; action?: string } {
  const summary: { t2: number; t3: number; action?: string } = { t2: 0, t3: 0 };
  const visit = (node: TierNode) => {
    if (node.status === 'ACTIVE') {
      if (node.role === 'T2') summary.t2 += 1;
      if (node.role === 'T3') summary.t3 += 1;
      summary.action ??= node.currentAction;
    }
    node.children?.forEach(visit);
  };
  if (root) visit(root);
  return summary;
}

interface WelcomeBannerProps {
  theme: Theme;
  config: CascadeConfig;
  workspacePath: string;
  sessionId: string;
}

function WelcomeBanner({ theme, config, workspacePath, sessionId }: WelcomeBannerProps) {
  const t1 = config.models?.t1 ?? 'auto';
  const t2 = config.models?.t2 ?? 'auto';
  const t3 = config.models?.t3 ?? 'auto';
  const folder = workspacePath.split(/[/\\]/).pop() ?? workspacePath;

  return (
    <Box flexDirection="column" paddingY={1} paddingLeft={2}>
      <Text color={theme.colors.primary} bold>◈ CASCADE AI</Text>
      <Text color={theme.colors.muted}>
        {'T1: '}<Text color={theme.colors.foreground}>{t1}</Text>
        {'  T2: '}<Text color={theme.colors.foreground}>{t2}</Text>
        {'  T3: '}<Text color={theme.colors.foreground}>{t3}</Text>
      </Text>
      <Text color={theme.colors.muted}>
        {'workspace: '}<Text color={theme.colors.foreground}>{folder}</Text>
        {'  ·  session: '}<Text color={theme.colors.foreground}>{sessionId.slice(0, 8)}</Text>
      </Text>
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          {'Type '}<Text color={theme.colors.accent} bold>/help</Text>{' for commands  ·  Esc to cancel  ·  Ctrl+C to exit'}
        </Text>
      </Box>
    </Box>
  );
}

interface FlatTreeNode extends TierNode {
  parentId?: string;
}

interface RootTierEvent {
  role: 'T1' | 'T2' | 'T3';
}

interface TierStatusEvent {
  tierId: string;
  role: 'T1' | 'T2' | 'T3';
  parentId?: string;
  label?: string;
  status: RuntimeNode['status'];
  currentAction?: string;
  progressPct?: number;
  output?: string;
}

interface ReplState {
  messages: Message[];
  agentTree: TierNode | null;
  isStreaming: boolean;
  isExecuting: boolean;
  streamBuffer: string;
  totalTokens: number;
  totalCostUsd: number;
  callsByProvider: Record<string, number>;
  callsByTier: Record<string, number>;
  costByTier: Record<string, number>;
  tokensByTier: Record<string, number>;
  costByFeature: Record<string, number>;
  savedUsd: number;
  savedPct: number;
  peerEvents: PeerMessageEvent[];
  showComms: boolean;
  approvalRequest: ApprovalRequest | null;
  showCost: boolean;
  showDetails: boolean;
  error: string | null;
  activeTool: string | null;
}

type ReplAction =
  | { type: 'ADD_MESSAGE'; message: Message }
  | { type: 'APPEND_STREAM'; text: string }
  | { type: 'COMMIT_STREAM'; finalText: string; timestamp?: string }
  | { type: 'SET_TREE'; tree: TierNode | null }
  | { type: 'UPDATE_COST'; tokens: number; costUsd: number; byProvider: Record<string,number>; byTier: Record<string,number>; costByTier: Record<string,number>; tokensByTier: Record<string,number>; costByFeature: Record<string,number>; savedUsd: number; savedPct: number }
  | { type: 'SET_APPROVAL'; request: ApprovalRequest | null }
  | { type: 'SET_EXECUTING'; isExecuting: boolean }
  | { type: 'SET_STREAMING'; isStreaming: boolean }
  | { type: 'ADD_PEER_EVENTS'; events: PeerMessageEvent[] }
  | { type: 'CLEAR_PEER_EVENTS' }
  | { type: 'TOGGLE_COMMS' }
  | { type: 'CLEAR' }
  | { type: 'TOGGLE_COST' }
  | { type: 'TOGGLE_DETAILS' }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_ACTIVE_TOOL'; toolName: string | null }
  | { type: 'CLEAR_TREE' };

function replReducer(state: ReplState, action: ReplAction): ReplState {
  switch (action.type) {
    case 'ADD_MESSAGE':
      return { ...state, messages: [...state.messages, action.message], isStreaming: false, streamBuffer: '' };
    case 'APPEND_STREAM':
      return { ...state, isStreaming: true, streamBuffer: state.streamBuffer + action.text };
    case 'COMMIT_STREAM': {
      const msg: Message = {
        id: randomUUID(),
        role: 'assistant',
        content: action.finalText,
        timestamp: action.timestamp ?? new Date().toISOString(),
      };
      return { ...state, messages: [...state.messages, msg], isStreaming: false, streamBuffer: '', activeTool: null };
    }
    case 'SET_TREE':
      return { ...state, agentTree: action.tree };
    case 'UPDATE_COST':
      return { ...state, totalTokens: action.tokens, totalCostUsd: action.costUsd, callsByProvider: action.byProvider, callsByTier: action.byTier, costByTier: action.costByTier, tokensByTier: action.tokensByTier, costByFeature: action.costByFeature, savedUsd: action.savedUsd, savedPct: action.savedPct };
    case 'SET_APPROVAL':
      return { ...state, approvalRequest: action.request };
    case 'SET_EXECUTING':
      return { ...state, isExecuting: action.isExecuting };
    case 'SET_STREAMING':
      return { ...state, isStreaming: action.isStreaming };
    case 'ADD_PEER_EVENTS':
      return { ...state, peerEvents: [...state.peerEvents, ...action.events].slice(-PEER_EVENT_BUFFER) };
    case 'CLEAR_PEER_EVENTS':
      return state.peerEvents.length ? { ...state, peerEvents: [] } : state;
    case 'TOGGLE_COMMS':
      return { ...state, showComms: !state.showComms };
    case 'CLEAR':
      return { ...state, messages: [], agentTree: null, streamBuffer: '', totalTokens: 0, totalCostUsd: 0, callsByProvider: {}, callsByTier: {}, costByTier: {}, tokensByTier: {}, costByFeature: {}, savedUsd: 0, savedPct: 0, peerEvents: [], activeTool: null };
    case 'CLEAR_TREE':
      return { ...state, agentTree: null };
    case 'TOGGLE_COST':
      return { ...state, showCost: !state.showCost };
    case 'TOGGLE_DETAILS':
      return { ...state, showDetails: !state.showDetails };
    case 'SET_ERROR':
      return { ...state, error: action.error };
    case 'SET_ACTIVE_TOOL':
      return { ...state, activeTool: action.toolName };
    default:
      return state;
  }
}

interface ReplProps {
  config: CascadeConfig;
  workspacePath: string;
  themeName: string;
  initialPrompt?: string;
  identityName?: string;
  /** Alternate-screen mode: no terminal scrollback, so history renders as an in-app transcript. */
  altScreen?: boolean;
}

async function refreshModelCache(store: MemoryStore, providers: CascadeConfig['providers']) {
  for (const provider of providers) {
    try {
      const dummyId = provider.type === 'azure' ? provider.deploymentName || 'azure-model' : 'dummy';
      const dummyModel: ModelInfo = { id: dummyId, name: dummyId, provider: provider.type, contextWindow: 0, isVisionCapable: false, inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 0, supportsStreaming: false, isLocal: false };
      let instance: BaseProvider | undefined;
      if (provider.type === 'openai') instance = new OpenAIProvider(provider, dummyModel);
      else if (provider.type === 'gemini') instance = new GeminiProvider(provider, dummyModel);
      else if (provider.type === 'anthropic') instance = new AnthropicProvider(provider, dummyModel);
      else if (provider.type === 'ollama') instance = new OllamaProvider(provider, dummyModel);
      else if (provider.type === 'openai-compatible') instance = new OpenAICompatibleProvider(provider, dummyModel);
      else if (provider.type === 'azure') {
        const { AzureOpenAIProvider } = await import('../../providers/azure.js');
        instance = new AzureOpenAIProvider(provider, dummyModel);
      }
      if (instance) {
        const fetched = await instance.listModels();
        for (const m of fetched) store.upsertCachedModel(m);
      }
    } catch (err) { console.error(`Failed refresh: ${provider.type}`, err); }
  }
}

export function Repl({ config, workspacePath, themeName, initialPrompt, identityName, altScreen = false }: ReplProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [theme, setTheme] = useState<Theme>(() => getTheme(themeName));
  const [input, setInput] = useState('');
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [identities, setIdentities] = useState<Array<{ id: string; name: string; isDefault: boolean }>>([]);
  const [currentIdentityId, setCurrentIdentityId] = useState<string | undefined>(config.defaultIdentityId);
  const [state, dispatch] = useReducer(replReducer, { messages: [], agentTree: null, isStreaming: false, isExecuting: false, streamBuffer: '', totalTokens: 0, totalCostUsd: 0, callsByProvider: {}, callsByTier: {}, costByTier: {}, tokensByTier: {}, costByFeature: {}, savedUsd: 0, savedPct: 0, peerEvents: [], showComms: true, approvalRequest: null, showCost: false, showDetails: false, error: null, activeTool: null });
  const [isShowingModels, setIsShowingModels] = useState(false);
  const [planApprovalRequest, setPlanApprovalRequest] = useState<PlanApprovalRequest | null>(null);
  // Alt-screen transcript scroll position, in lines up from the newest line.
  const [historyOffset, setHistoryOffset] = useState(0);
  // Current transcript geometry for the PgUp/PgDn handler (set during render).
  const transcriptMetaRef = useRef({ rows: 0, lines: 0 });
  const [cachedModels, setCachedModels] = useState<Map<ProviderType, ModelInfo[]>>(new Map());
  const cascadeRef = useRef<Cascade | null>(null);
  const storeRef = useRef<MemoryStore | null>(null);
  const slashRef = useRef(new SlashCommandRegistry());
  const approvalResolverRef = useRef<((decision: { approved: boolean; always: boolean }) => void) | null>(null);
  const decisionLogRef = useRef<DecisionLogEntry[]>([]);
  const sessionIdRef = useRef(randomUUID());
  const startedAtRef = useRef(new Date().toISOString());
  const treeNodesRef = useRef<Map<string, FlatTreeNode>>(new Map());
  const nodeLogsRef = useRef<Map<string, string[]>>(new Map());
  const [startupWarning, setStartupWarning] = useState<string | null>(null);
  const [timelineIndex, setTimelineIndex] = useState(0);
  const [treeScrollOffset, setTreeScrollOffset] = useState(0);
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const [quitAttempted, setQuitAttempted] = useState(false);
  const [cancelAttempted, setCancelAttempted] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [commandRunning, setCommandRunning] = useState(false);
  // AbortController for the in-progress run, so Ctrl+C / ESC can cancel the task.
  const runAbortRef = useRef<AbortController | null>(null);
  // Ref mirror of cancelAttempted — read synchronously in the key handler so a
  // rapid double-press isn't dropped by a stale React state value.
  const cancelArmedRef = useRef(false);
  const isInputLockedRef = useRef(false);
  const lockTimerRef = useRef<NodeJS.Timeout | null>(null);

  const lockInputTemporarily = useCallback(() => {
    isInputLockedRef.current = true;
    if (lockTimerRef.current) clearTimeout(lockTimerRef.current);
    lockTimerRef.current = setTimeout(() => { isInputLockedRef.current = false; }, 200);
  }, []);

  const sessionTitle = state.messages.find(m => m.role === 'user')?.content.slice(0, 72) ?? 'Cascade Session';
  const lastUserPrompt = useRef<string | null>(null);
  const lastSubmittedInputRef = useRef<string | null>(null);
  const sessionTitleGeneratedRef = useRef(false);
  const rootTierIdRef = useRef<'T1' | 't2-root' | 't3-root'>('T1');
  const SLASH_PAGE_SIZE = 8;
  const isTypingCommand = input.startsWith('/');
  // Full list of matching commands (names only — used for index cycling & Tab)
  const slashCompletions = isTypingCommand ? (
    input.startsWith('/identity ')
      ? identities.map(i => `/identity ${i.name}`).filter(c => c.startsWith(input))
      : slashRef.current.getCompletions(input)
  ) : [];
  // Paired list with descriptions for the suggestion panel
  const slashEntries = isTypingCommand ? (
    input.startsWith('/identity ')
      ? identities.map(i => `/identity ${i.name}`).filter(c => c.startsWith(input)).map(c => ({ command: c, description: '' }))
      : slashRef.current.getCompletionEntries(input)
  ) : [];
  // Viewport: keep selected item visible, centred in the window
  const slashViewStart = Math.max(
    0,
    Math.min(
      slashIndex - Math.floor(SLASH_PAGE_SIZE / 2),
      slashEntries.length - SLASH_PAGE_SIZE,
    ),
  );

  const persistMessage = useCallback((role: 'user' | 'assistant' | 'system', content: string, timestamp: string) => {
    storeRef.current?.addMessage({ id: randomUUID(), sessionId: sessionIdRef.current, role, content, timestamp });
  }, []);

  /**
   * Apply a selection from the interactive model picker:
   *   - update the in-memory CascadeConfig.models[tier]
   *   - persist the updated config to .cascade/config.json
   *   - hot-swap the running router via overrideTierModel (if a concrete
   *     ModelInfo is available in the model cache)
   *   - print a short confirmation in the chat stream
   */
  const applyModelPick = useCallback(async (sel: ModelPickerSelection) => {
    const tierKey = sel.tier.toLowerCase() as 't1' | 't2' | 't3';
    const tierLabel = sel.tier;

    // Update in-memory config (mutating is OK here — this is a TUI session
    // local copy; runCascade hasn't persisted it elsewhere).
    if (sel.kind === 'auto') {
      delete (config.models as Record<string, string | undefined>)[tierKey];
    } else {
      (config.models as Record<string, string | undefined>)[tierKey] = `${sel.provider}:${sel.modelId}`;
    }

    // Hot-swap the live router — best-effort.
    try {
      const router = cascadeRef.current?.getRouter();
      if (router && sel.kind === 'pick') {
        const candidate = (cachedModels.get(sel.provider) ?? []).find(m => m.id === sel.modelId);
        if (candidate) router.overrideTierModel(tierLabel, candidate);
      }
    } catch {
      /* hot-swap is best effort; persisted config will take effect next start */
    }

    // Persist .cascade/config.json
    const configPath = path.join(workspacePath, '.cascade', 'config.json');
    try {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({
        type: 'ADD_MESSAGE',
        message: { id: randomUUID(), role: 'error', content: `Failed to persist model selection: ${msg}`, timestamp: new Date().toISOString() },
      });
      return;
    }

    const summary = sel.kind === 'auto'
      ? `${tierLabel} → Auto (Cascade will pick best available).`
      : `${tierLabel} → ${sel.modelId}  (provider: ${sel.provider}).`;
    dispatch({
      type: 'ADD_MESSAGE',
      message: { id: randomUUID(), role: 'system', content: `✔ Model updated — ${summary}`, timestamp: new Date().toISOString() },
    });
  }, [config, workspacePath, cachedModels]);

  const globalStoreRef = useRef<MemoryStore | null>(null);

  const persistRuntimeSession = useCallback((status: 'ACTIVE' | 'COMPLETED' | 'FAILED', latestPrompt?: string) => {
    const runtimeSession = { sessionId: sessionIdRef.current, title: sessionTitle, workspacePath, status, startedAt: startedAtRef.current, updatedAt: new Date().toISOString(), latestPrompt, isGlobal: false };
    storeRef.current?.upsertRuntimeSession(runtimeSession);
    globalStoreRef.current?.upsertRuntimeSession({ ...runtimeSession, isGlobal: true });
  }, [sessionTitle, workspacePath]);

  const rebuildTree = useCallback(() => { dispatch({ type: 'SET_TREE', tree: buildTreeFromFlatNodes([...treeNodesRef.current.values()]) }); }, []);

  const recordNodeEvent = useCallback((event: TierStatusEvent) => {
    const existing = treeNodesRef.current.get(event.tierId);
    const node: FlatTreeNode = { id: event.tierId, role: event.role ?? existing?.role ?? 'T3', label: event.label ?? existing?.label ?? event.tierId, status: event.status ?? existing?.status ?? 'IDLE', currentAction: event.currentAction ?? existing?.currentAction, progressPct: event.progressPct ?? existing?.progressPct, parentId: event.parentId ?? existing?.parentId, children: [] };
    treeNodesRef.current.set(event.tierId, node);
    const store = storeRef.current;
    if (store) {
      const runtimeNode: RuntimeNode = { tierId: node.id, sessionId: sessionIdRef.current, parentId: node.parentId, role: node.role, label: node.label, status: node.status, currentAction: node.currentAction, progressPct: node.progressPct, updatedAt: new Date().toISOString(), workspacePath, isGlobal: false, output: event.output };
      store.upsertRuntimeNode(runtimeNode);
      globalStoreRef.current?.upsertRuntimeNode({ ...runtimeNode, isGlobal: true });
    }
    const history = nodeLogsRef.current.get(node.id) ?? [];
    nodeLogsRef.current.set(node.id, [...history.slice(-24), [node.status, node.currentAction].filter(Boolean).join(' — ')]);
    rebuildTree();
  }, [rebuildTree, workspacePath]);

  useEffect(() => {
    // Silence verbose SDK warnings that pollute the TUI
    const originalWarn = console.warn;
    const originalLog = console.log;

    console.warn = (...args: unknown[]) => {
      const msg = args.join(' ');
      if (msg.includes('non-text parts') || msg.includes('functionCall')) return;
      originalWarn(...args);
    };

    // Also silence some direct logs if they leak
    console.log = (...args: unknown[]) => {
      const msg = args.join(' ');
      if (msg.includes('non-text parts')) return;
      originalLog(...args);
    };

    const store = new MemoryStore(path.join(workspacePath, CASCADE_DB_FILE));
    storeRef.current = store;
    globalStoreRef.current = new MemoryStore(path.join(os.homedir(), GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE));
    const identityRows = store.listIdentities().map(i => ({ id: i.id, name: i.name, isDefault: i.isDefault }));
    setIdentities(identityRows);
    let initialIdentityId = config.defaultIdentityId ?? identityRows.find(i => i.isDefault)?.id ?? identityRows[0]?.id;
    if (identityName) {
      const match = identityRows.find(i => i.id === identityName || i.name.toLowerCase() === identityName.toLowerCase());
      if (match) initialIdentityId = match.id;
      else console.warn(`Identity '${identityName}' not found. Using default.`);
    }
    setCurrentIdentityId(initialIdentityId);
    const loadCache = async () => {
      const models = store.getCachedModels();
      const map = new Map<ProviderType, ModelInfo[]>();
      for (const m of models) { const list = map.get(m.provider) ?? []; list.push(m); map.set(m.provider, list); }
      setCachedModels(map);
      if (models.length === 0 || store.getCacheAge() > 24 * 60 * 60 * 1000) await refreshModelCache(store, config.providers);
    };
    loadCache();
    store.createSession({ id: sessionIdRef.current, title: 'Cascade Session', createdAt: startedAtRef.current, updatedAt: startedAtRef.current, identityId: config.defaultIdentityId ?? 'default', workspacePath, messages: [], metadata: { totalTokens: 0, totalCostUsd: 0, modelsUsed: [], toolsUsed: [], taskCount: 0 } });
    persistRuntimeSession('ACTIVE');
    cascadeRef.current = new Cascade(config, workspacePath);
    cascadeRef.current.init().catch(err => setStartupWarning(`Init failed: ${err.message}`));
    validateConfiguredModels(config).then(setStartupWarning);
    return () => {
      persistRuntimeSession('COMPLETED');
      // Close any MCP servers / telemetry the Cascade orchestrator opened so
      // we don't leak child processes when the REPL exits.
      cascadeRef.current?.close().catch(() => { /* ignored on shutdown */ });
      globalStoreRef.current?.close();
      store.close();
      console.warn = originalWarn;
      console.log = originalLog;
    };
  }, []);
  
  useEffect(() => {
    if (slashCompletions.length > 0 && slashIndex >= slashCompletions.length) {
      setSlashIndex(0);
    } else if (slashCompletions.length === 0 && slashIndex !== 0) {
      setSlashIndex(0);
    }
  }, [slashCompletions.length, slashIndex]);

  // New messages snap the alt-screen transcript back to the newest line.
  useEffect(() => {
    setHistoryOffset(0);
  }, [state.messages.length]);

  // The completed agent tree collapses on the user's NEXT keystroke (see the
  // input onChange handler) rather than on an idle timer. A timer-driven
  // repaint while the user is away wipes any in-progress mouse selection —
  // when nothing is executing and nobody is typing, the screen must stay
  // perfectly still so native drag-select + right-click copy work.

  const handleSlashCommand = useCallback(async (trimmed: string) => {
    const result = await slashRef.current.handle(trimmed, {
      sessionId: sessionIdRef.current,
      workspacePath,
      onOutput: (text) => {
        const safeText = stringifySlashOutput(text);
        if (!safeText) return;
        const timestamp = new Date().toISOString();
        dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'assistant', content: safeText, timestamp } });
        persistMessage('assistant', safeText, timestamp);
      },
      onClear: () => dispatch({ type: 'CLEAR' }),
      onExit: () => exit(),
      onThemeChange: (name) => setTheme(getTheme(name)),
      onExport: async (fmt) => {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const exportPath = path.join(workspacePath, `cascade-export-${stamp}.${fmt === 'json' ? 'json' : 'md'}`);
        if (fmt === 'json') {
          await fs.writeFile(exportPath, JSON.stringify({ sessionId: sessionIdRef.current, messages: state.messages }, null, 2), 'utf-8');
        } else {
          const markdown = state.messages.map((msg) => `## ${msg.role.toUpperCase()} — ${msg.timestamp}\n\n${msg.content}`).join('\n\n');
          await fs.writeFile(exportPath, markdown, 'utf-8');
        }
      },
      onRollback: async () => {
        const store = storeRef.current;
        if (!store) return 'No database connection.';
        const snapshots = store.getLatestFileSnapshots(sessionIdRef.current);
        if (!snapshots.length) return 'No file snapshots found for this session.';
        for (const { filePath, content } of snapshots) {
          try { await fs.writeFile(filePath, content, 'utf-8'); } catch (err) { console.error(`Restore failed: ${filePath}`, err); }
        }
        return `Restored ${snapshots.length} files to their initial session state.`;
      },
      onSteer: (args: string[]) => {
        const text = args.join(' ').trim();
        if (!text) return 'Usage: /steer <correction for the active workers>';
        const cascade = cascadeRef.current;
        if (!cascade) return 'No active Cascade instance.';
        cascade.injectGuidance(text);
        return 'Guidance queued — active workers apply it on their next step. (No task running? It applies to the next run\'s workers.)';
      },
      onBranch: async () => {
        const store = storeRef.current;
        if (!store) return;
        const newSessionId = randomUUID();
        try {
          store.branchSession(sessionIdRef.current, newSessionId);
          sessionIdRef.current = newSessionId;
          const timestamp = new Date().toISOString();
          dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'assistant', content: `Branched session. New Session ID: ${newSessionId}`, timestamp } });
        } catch (err) { console.error(`Branching failed:`, err); }
      },
      onModelInfo: () => {
        const router = cascadeRef.current?.getRouter();
        if (!router) return 'No models loaded';
        return ['T1', 'T2', 'T3'].map((t) => {
          const tier = t as 'T1' | 'T2' | 'T3';
          const m = router.getModelForTier(tier);
          const configured = config.models[tier.toLowerCase() as 't1' | 't2' | 't3'];
          return `${t}: ${m?.name ?? 'none'} (${m?.provider ?? '—'})${configured ? ` | configured: ${configured}` : ''}`;
        }).join('\n');
      },
      onModelPicker: async () => { setIsShowingModels(true); return 'Opening model picker — choose provider → tier → model (ESC to exit).'; },
      onModelsInfo: async () => { setIsShowingModels(true); return 'Opening interactive models explorer... (ESC to exit)'; },
      onProvidersInfo: () => listConfiguredProviders(config),
      onConfigInfo: () => formatConfigSummary(config),
      onRetry: async () => {
        const prompt = lastUserPrompt.current;
        if (!prompt) return 'No previous user prompt to retry.';
        await handleSubmit(prompt);
        return `Retried: ${prompt}`;
      },
      onSearch: async (args) => searchSessionsAndMessages(args.join(' ').trim(), workspacePath),
      onDiagnose: async () => diagnoseRuntime(config, workspacePath),
      onLogs: async (args) => showRecentLogs(args, workspacePath),
      onResume: async (args) => {
        const snapshot = await loadSessionSnapshot(args, workspacePath);
        if (typeof snapshot === 'string') return snapshot;
        hydrateResumeState(snapshot, { dispatch, treeNodesRef, nodeLogsRef, sessionIdRef, startedAtRef, setInputHistory, setHistoryIndex, setCurrentIdentityId, storeRef });
        return `Restored session ${snapshot.session.title} with ${snapshot.messages.length} messages.`;
      },
      onMcpList: async () => {
        const cascade = cascadeRef.current;
        if (!cascade) return 'Cascade not initialized.';
        const toolRegistry = cascade.getToolRegistry();
        const tools = toolRegistry.getToolDefinitions().filter(t => t.name.startsWith('mcp::'));
        if (tools.length === 0) return 'No MCP tools connected.';
        
        const servers = new Set<string>();
        tools.forEach(t => servers.add(t.name.split('::')[1]!));
        
        const lines = [`Connected MCP Servers (${servers.size}):`];
        for (const server of servers) {
          const serverTools = tools.filter(t => t.name.startsWith(`mcp::${server}::`));
          lines.push(`\n● ${server} (${serverTools.length} tools)`);
          serverTools.forEach(t => lines.push(`  - ${t.name.split('::')[2]} — ${t.description.replace(`[MCP:${server}] `, '')}`));
        }
        return lines.join('\n');
      },
      onCopy: (args) => {
        const n = Math.max(1, Number.parseInt(args[0] ?? '1', 10) || 1);
        const assistants = state.messages.filter((m) => m.role === 'assistant');
        const msg = assistants[assistants.length - n];
        if (!msg) return n === 1 ? 'No assistant response to copy yet.' : `No response found ${n} back.`;
        const method = writeClipboardSync(msg.content);
        if (!method) {
          return 'Copy failed — no clipboard tool found (pbcopy/clip/xclip/wl-copy) and not running in a terminal.';
        }
        const which = n === 1 ? 'last response' : `response ${n} back`;
        return method === 'osc52'
          ? `✔ Copied ${which} (${msg.content.length} chars) via terminal escape — works over SSH if your terminal supports OSC 52.`
          : `✔ Copied ${which} (${msg.content.length} chars) to clipboard.`;
      },
      onWhy: () => formatDecisionTrail(decisionLogRef.current),
      onRate: (args) => {
        const cascade = cascadeRef.current;
        if (!cascade) return 'Not ready yet.';
        const rating = (args[0] ?? '').toLowerCase();
        if (rating !== 'good' && rating !== 'bad') {
          return 'Usage: /rate good | bad';
        }
        const recorded = cascade.rateLastRun(rating as 'good' | 'bad');
        if (!recorded) return 'Nothing to rate — run a task first, or auto-routing is not enabled.';
        return rating === 'good'
          ? '✔ Rated good — models used for this task type got a boost.'
          : '✔ Rated bad — models used for this task type were penalised. Auto-routing will try alternatives next time.';
      },
      onComms: () => {
        dispatch({ type: 'TOGGLE_COMMS' });
        return state.showComms
          ? 'Agent comms feed hidden. /comms to bring it back.'
          : 'Agent comms feed enabled — agent-to-agent traffic will appear during runs.';
      },
      onCostInfo: () => { dispatch({ type: 'TOGGLE_COST' }); return ''; },
      onBudget: (args) => {
        const router = cascadeRef.current?.getRouter();
        if (!router) return 'Router not initialised yet.';

        if (args[0] === 'set' && args[1]) {
          const amount = parseFloat(args[1].replace(/^\$/, ''));
          if (isNaN(amount) || amount <= 0) {
            return 'Invalid amount. Usage: /budget set 1.00';
          }
          router.setSessionBudget(amount);
          return `✔ Session budget set to $${amount.toFixed(2)}. Cascade will stop new tasks once this limit is reached.`;
        }

        if (args[0] === 'clear') {
          router.setSessionBudget(null);
          return '✔ Session budget cap removed.';
        }

        // Show current status
        const cap = router.getSessionBudget();
        const spent = router.getSessionSpend();
        if (!cap) {
          return `Session budget: none (no cap set)\nSpent so far:   $${spent.toFixed(6)}\n\nSet a cap with: /budget set <amount>  (e.g. /budget set 0.50)`;
        }
        const remaining = Math.max(0, cap - spent);
        const pct = Math.min(100, Math.round((spent / cap) * 100));
        const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
        return `Session budget:  $${cap.toFixed(2)}\nSpent:           $${spent.toFixed(6)} (${pct}%)\nRemaining:       $${remaining.toFixed(6)}\n[${bar}]`;
      },
      onCompact: async () => {
        const prompt = 'Please summarize our conversation so far to keep the context compact and efficient.';
        await handleSubmit(prompt);
        return 'Triggered context compaction. The agent will now summarize the history...';
      },
      onStatus: () => formatRuntimeStatus([...treeNodesRef.current.values()], nodeLogsRef.current),
      onTree: () => { 
        dispatch({ type: 'TOGGLE_DETAILS' }); 
        return 'Toggled agent tree visualization.'; 
      },
      onSessions: async () => {
        const store = storeRef.current;
        if (!store) return 'No session store loaded.';
        const sessions = store.listSessions(undefined, 12);
        if (!sessions.length) return 'No saved sessions yet.';
        return sessions.map((s, idx) => `${idx + 1}. ${s.title}\n   id: ${s.id}\n   updated: ${new Date(s.updatedAt).toLocaleString()}\n   tokens: ${s.metadata.totalTokens} · cost: $${s.metadata.totalCostUsd.toFixed(4)}`).join('\n\n');
      },
      onIdentity: async (args) => {
        if (args.length === 0) {
          if (identities.length === 0) return 'No identities found.';
          const list = identities.map(id => {
            const isActive = id.id === currentIdentityId;
            const isDef = id.isDefault ? ' [Default]' : '';
            return `  ${isActive ? '●' : '○'} ${id.name} (${id.id.slice(0, 8)}...)${isDef}`;
          }).join('\n');
          return `Available identities:\n\n${list}\n\nUse /identity <name|id> to switch.`;
        }
        const target = args.join(' ').trim();
        const match = identities.find((identity) => identity.id === target || identity.name.toLowerCase() === target.toLowerCase() || identity.id.startsWith(target));
        if (!match) return `Unknown identity: ${target}`;
        setCurrentIdentityId(match.id);
        storeRef.current?.updateSession(sessionIdRef.current, { identityId: match.id, updatedAt: new Date().toISOString() });
        return `Active identity set to ${match.name}`;
      },
      onAuto: (args) => {
        const cascade = cascadeRef.current;
        if (!cascade) return 'Not ready yet.';
        const sub = (args[0] ?? '').toLowerCase();
        if (sub === 'on' || sub === 'enable') {
          cascade.setAutonomy('auto');
          return '✔ Autonomous mode ON — plans auto-approve and non-dangerous tools run without prompts. Dangerous tools still ask, and budget caps still stop runaway cost.';
        }
        if (sub === 'off' || sub === 'disable') {
          cascade.setAutonomy('manual');
          return '✔ Autonomous mode OFF — plan and tool approvals will prompt as usual.';
        }
        return `Autonomous mode: ${cascade.getAutonomy() === 'auto' ? 'ON' : 'OFF'}\nToggle with  /auto on  or  /auto off`;
      },
      onPlan: async (args) => {
        const cascade = cascadeRef.current;
        if (!cascade) return 'Not ready yet.';
        const prompt = args.join(' ').trim();
        if (!prompt) return 'Usage: /plan <prompt> — previews the decomposition without running it.';
        try {
          return formatPlanPreview(await cascade.previewPlan(prompt));
        } catch (e) {
          return `Could not build a plan preview: ${e instanceof Error ? e.message : String(e)}`;
        }
      },
      onReplan: async (args) => {
        const lastUser = [...state.messages].reverse().find((m) => m.role === 'user');
        if (!lastUser || typeof lastUser.content !== 'string') return 'Nothing to re-plan yet — run a task first.';
        const guidance = args.join(' ').trim();
        const prompt = guidance
          ? `Re-plan and improve on the previous attempt. Guidance: ${guidance}\n\nOriginal task: ${lastUser.content}`
          : `Re-plan and improve on the previous attempt at this task:\n\n${lastUser.content}`;
        await handleSubmit(prompt);
        return guidance ? 'Re-planning with your guidance…' : 'Re-planning the last task…';
      },
      onContinue: async (args) => {
        const cascade = cascadeRef.current;
        if (!cascade) return 'Not ready yet.';
        if (!cascade.hasResumableRun()) return 'Nothing to continue — no task was stopped by the budget cap.';
        const n = args[0] ? parseInt(args[0].replace(/[^0-9]/g, ''), 10) : NaN;
        const prompt = cascade.prepareResume(Number.isFinite(n) && n > 0 ? { maxTokens: n } : {});
        if (!prompt) return 'Nothing to continue.';
        await handleSubmit(prompt);
        return '';
      },
    });

    if (result.output) {
      const safeOutput = stringifySlashOutput(result.output);
      const timestamp = new Date().toISOString();
      dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'assistant', content: safeOutput, timestamp } });
      persistMessage('assistant', safeOutput, timestamp);
    }
  }, [workspacePath, exit, state.messages, identities, currentIdentityId, persistMessage]);

  const handleSubmit = useCallback(async (userInput: string) => {
    if (slashCompletions.length > 0) {
      const selected = slashCompletions[slashIndex];
      if (selected && selected !== userInput.trim()) {
        setInput(selected + ' ');
        setSlashIndex(0);
        return;
      }
    }
    const trimmed = userInput.trim();
    if (!trimmed) return;
    if (state.isExecuting) {
      if (slashRef.current.isSlashCommand(trimmed)) {
        setInput('');
        dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'user', content: trimmed, timestamp: new Date().toISOString() } });
        setCommandRunning(true);
        try { await handleSlashCommand(trimmed); } finally { setCommandRunning(false); }
        return;
      }
      setQueuedMessages(prev => [...prev, trimmed]);
      setInput('');
      return;
    }
    // Don't record slash commands in the up-arrow history — recalling /why, /cost
    // etc. isn't useful and conflicts with the scroll mechanism. Only real prompts.
    if (!slashRef.current.isSlashCommand(trimmed)) {
      setInputHistory((prev) => [trimmed, ...prev.filter((item) => item !== trimmed)].slice(0, 100));
    }
    setHistoryIndex(null);
    if (slashRef.current.isSlashCommand(trimmed)) {
      // Echo the command immediately so there's a visual cue it was sent, and
      // show a running indicator while async commands (e.g. /plan) do their work.
      dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'user', content: trimmed, timestamp: new Date().toISOString() } });
      setCommandRunning(true);
      try { await handleSlashCommand(trimmed); } finally { setCommandRunning(false); }
      return;
    }
    const timestamp = new Date().toISOString();
    dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'user', content: trimmed, timestamp } });
    persistMessage('user', trimmed, timestamp);
    lastUserPrompt.current = trimmed;
    lastSubmittedInputRef.current = trimmed;
    setInput('');
    dispatch({ type: 'SET_EXECUTING', isExecuting: true });
    dispatch({ type: 'SET_STREAMING', isStreaming: true });
    const cascade = cascadeRef.current;
    if (!cascade) {
      // Cascade failed to initialise — don't leave the UI stuck with
      // isExecuting=true (input field disabled, spinner running forever).
      dispatch({ type: 'SET_EXECUTING', isExecuting: false });
      dispatch({ type: 'SET_STREAMING', isStreaming: false });
      dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'error', content: 'Cascade not initialised. Check your configuration and restart.', timestamp: new Date().toISOString() } });
      return;
    }
    treeNodesRef.current.clear(); rebuildTree(); setTreeScrollOffset(0);
    dispatch({ type: 'CLEAR_PEER_EVENTS' });
    const onRoot = ({ role }: RootTierEvent) => {
      const tierId = role === 'T1' ? 'T1' : `${role.toLowerCase()}-root` as 't2-root' | 't3-root';
      rootTierIdRef.current = tierId;
      recordNodeEvent({ tierId, role, label: 'Initializing', status: 'ACTIVE' });
    };
    let currentStreamBuffer = '';
    let streamThrottleTimeout: NodeJS.Timeout | null = null;
    const flushStream = () => { if (currentStreamBuffer) { dispatch({ type: 'APPEND_STREAM', text: currentStreamBuffer }); currentStreamBuffer = ''; } streamThrottleTimeout = null; };
    const onStream = ({ text, tierId }: { text: string; tierId: string }) => {
      if (tierId !== rootTierIdRef.current) return; // Hide non-root streams from main chat
      currentStreamBuffer += (text ?? '');
      if (!streamThrottleTimeout) streamThrottleTimeout = setTimeout(flushStream, 50);
    };
    // tier:status fires very frequently during execution. Coalesce into 100ms
    // batches so we don't trigger SET_TREE + UPDATE_COST on every event — the
    // unbatched version flickered badly on maximized terminals.
    const pendingStatusEvents: TierStatusEvent[] = [];
    let statusThrottleTimeout: NodeJS.Timeout | null = null;
    const flushStatus = () => {
      const events = pendingStatusEvents.splice(0);
      let lastTool: string | null = null;
      for (const ev of events) {
        recordNodeEvent(ev);
        if (ev.currentAction?.startsWith('Using tool:')) {
          lastTool = ev.currentAction.replace('Using tool:', '').trim();
        }
      }
      if (lastTool !== null) dispatch({ type: 'SET_ACTIVE_TOOL', toolName: lastTool });
      const stats = cascade.getRouter().getStats();
      const savings = cascade.getRouter().getDelegationSavings();
      dispatch({ type: 'UPDATE_COST', tokens: stats.totalTokens, costUsd: stats.totalCostUsd, byProvider: stats.callsByProvider, byTier: stats.callsByTier, costByTier: stats.costByTier, tokensByTier: stats.tokensByTier, costByFeature: stats.costByFeature, savedUsd: savings.savedUsd, savedPct: savings.savedPct });
      statusThrottleTimeout = null;
    };
    cascade.on('tier:root', onRoot);
    cascade.on('stream:token', onStream);
    cascade.on('tier:status', (ev: TierStatusEvent) => {
      pendingStatusEvents.push(ev);
      if (!statusThrottleTimeout) statusThrottleTimeout = setTimeout(flushStatus, 100);
    });
    // Agent-to-agent comms — same 100ms coalescing as tier:status so a
    // chatty swarm of T3s can't render-thrash the live area.
    const pendingPeerEvents: PeerMessageEvent[] = [];
    let peerThrottleTimeout: NodeJS.Timeout | null = null;
    const flushPeerEvents = () => {
      const events = pendingPeerEvents.splice(0);
      if (events.length) dispatch({ type: 'ADD_PEER_EVENTS', events });
      peerThrottleTimeout = null;
    };
    cascade.on('peer:message', (ev: PeerMessageEvent) => {
      pendingPeerEvents.push(ev);
      if (!peerThrottleTimeout) peerThrottleTimeout = setTimeout(flushPeerEvents, 100);
    });
    cascade.on('run:cancelled', (payload: { reason?: string; partialOutput?: string }) => {
      dispatch({
        type: 'ADD_MESSAGE',
        message: {
          id: randomUUID(),
          role: 'system',
          content: `⊘ Task cancelled${payload.partialOutput ? ' — partial work above is kept.' : '.'}`,
          timestamp: new Date().toISOString(),
        },
      });
    });
    cascade.on('budget:warning', (payload: { spentUsd: number; capUsd: number; spendPct: number; remainingUsd: number }) => {
      const bar = '█'.repeat(Math.round(payload.spendPct / 10)) + '░'.repeat(10 - Math.round(payload.spendPct / 10));
      dispatch({
        type: 'ADD_MESSAGE',
        message: {
          id: randomUUID(),
          role: 'system',
          content: `⚠ Budget warning: ${payload.spendPct}% used ($${payload.spentUsd.toFixed(4)} of $${payload.capUsd.toFixed(2)}) — $${payload.remainingUsd.toFixed(4)} remaining  [${bar}]`,
          timestamp: new Date().toISOString(),
        },
      });
    });
    cascade.on('budget:exceeded', (payload: { reason: string }) => {
      dispatch({
        type: 'ADD_MESSAGE',
        message: {
          id: randomUUID(),
          role: 'error',
          content: `Budget exceeded: ${payload.reason}. New LLM calls rejected.`,
          timestamp: new Date().toISOString(),
        },
      });
    });
    // Boardroom: pause Complex runs for plan sign-off (planApproval: 'always').
    cascade.on('plan:approval-required', (payload: PlanApprovalRequest) => {
      setPlanApprovalRequest(payload);
    });
    // Re-use the approval dialog for MCP server spawn requests. These are the
    // riskiest events we expose — an arbitrary subprocess.
    cascade.on('mcp:approval-required', (payload: { server: { name: string; command: string; args?: string[] } }) => {
      const server = payload.server;
      dispatch({
        type: 'SET_APPROVAL',
        request: {
          id: `mcp-${server.name}`,
          tierId: 'MCP',
          toolName: `mcp::${server.name}`,
          input: { command: server.command, args: server.args ?? [] },
          description: `Spawn MCP server "${server.name}" via command: ${server.command} ${server.args?.join(' ') ?? ''}`,
          isDangerous: true,
        },
      });
      approvalResolverRef.current = ({ approved }) => cascade.resolveMcpApproval(server.name, approved);
    });
    try {
      runAbortRef.current = new AbortController();
      const result = await cascade.run({
        prompt: trimmed,
        workspacePath,
        signal: runAbortRef.current.signal,
        identityId: currentIdentityId,
        conversationHistory: toConversationHistory(state.messages),
        approvalCallback: async (req) => {
          dispatch({ type: 'SET_APPROVAL', request: req });
          return new Promise<{ approved: boolean; always: boolean }>((resolve) => {
            approvalResolverRef.current = resolve;
          });
        }
      });
      flushStream();
      flushStatus();
      flushPeerEvents();
      const stats = cascade.getRouter().getStats();
      const savings = cascade.getRouter().getDelegationSavings();
      dispatch({ type: 'UPDATE_COST', tokens: stats.totalTokens, costUsd: stats.totalCostUsd, byProvider: stats.callsByProvider, byTier: stats.callsByTier, costByTier: stats.costByTier, tokensByTier: stats.tokensByTier, costByFeature: stats.costByFeature, savedUsd: savings.savedUsd, savedPct: savings.savedPct });
      dispatch({ type: 'COMMIT_STREAM', finalText: result.output, timestamp: new Date().toISOString() });
      persistMessage('assistant', result.output, new Date().toISOString());
      // One-line run receipt — the delegation economics in scrollback.
      const receipt = formatRunReceipt(result, stats.totalCostUsd, savings);
      if (receipt) {
        dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'system', content: receipt, timestamp: new Date().toISOString() } });
      }
      // Generate AI session name on first exchange (async, fire-and-forget)
      if (!sessionTitleGeneratedRef.current && storeRef.current) {
        sessionTitleGeneratedRef.current = true;
        generateSessionName(trimmed, cascadeRef.current).then(name => {
          if (name && storeRef.current) {
            storeRef.current.updateSession(sessionIdRef.current, { title: name, updatedAt: new Date().toISOString() });
            persistRuntimeSession('ACTIVE');
          }
        }).catch(() => { /* non-critical */ });
      }
    } catch (err: unknown) { 
      const message = err instanceof Error ? err.message : String(err);
      dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'error', content: message, timestamp: new Date().toISOString() } }); 
    }
    finally {
      if (streamThrottleTimeout) { clearTimeout(streamThrottleTimeout); streamThrottleTimeout = null; }
      if (statusThrottleTimeout) { clearTimeout(statusThrottleTimeout); statusThrottleTimeout = null; }
      if (peerThrottleTimeout) { clearTimeout(peerThrottleTimeout); peerThrottleTimeout = null; }
      decisionLogRef.current = cascade.getDecisionLog();
      cascade.removeAllListeners();
      setPlanApprovalRequest(null);
      const finalStats = cascade.getRouter().getStats();
      const currentSession = storeRef.current?.getSession(sessionIdRef.current);
      if (currentSession) {
        storeRef.current?.updateSession(sessionIdRef.current, {
          metadata: {
            ...currentSession.metadata,
            totalTokens: finalStats.totalTokens,
            totalCostUsd: finalStats.totalCostUsd,
          }
        });
      }
      runAbortRef.current = null;
      cancelArmedRef.current = false;
      setCancelAttempted(false);
      setCancelling(false);
      dispatch({ type: 'SET_EXECUTING', isExecuting: false });
    }
  }, [handleSlashCommand, persistMessage, state.messages, workspacePath, rebuildTree, recordNodeEvent, slashCompletions, slashIndex, state.isExecuting]);

  useInput((_input, key) => {
    // When the interactive model picker is open it owns the keyboard.
    // Let Ctrl+C still exit, but route every other key (incl. arrows, Enter,
    // Tab, number keys, Esc) to the picker's own useInput so navigation
    // isn't hijacked — this is the root-cause fix for the "only ↑ worked
    // in the model selector" regression.
    if (isShowingModels) {
      if (key.ctrl && _input === 'c') {
        if (quitAttempted) { exit(); return; }
        setQuitAttempted(true);
      }
      return;
    }
    if (key.ctrl && _input === 'c') {
      // A task is running → Ctrl+C cancels it (double-press confirm), not exit.
      if (state.isExecuting) {
        if (cancelArmedRef.current) {
          cancelArmedRef.current = false;
          setCancelAttempted(false);
          setCancelling(true);
          runAbortRef.current?.abort();
          return;
        }
        cancelArmedRef.current = true;
        setCancelAttempted(true);
        return;
      }
      // Idle → quit Cascade (double-press confirm).
      if (quitAttempted) {
        exit();
        return;
      }
      setQuitAttempted(true);
      return;
    }
    if (key.escape) {
      // ESC cancels a running task outright (single press).
      if (state.isExecuting) { cancelArmedRef.current = false; setCancelAttempted(false); setCancelling(true); runAbortRef.current?.abort(); return; }
      if (quitAttempted) { setQuitAttempted(false); return; }
      if (isShowingModels) { setIsShowingModels(false); return; }
      if (queuedMessages.length > 0) {
        setInput(queuedMessages[0]!);
        setQueuedMessages(p => p.slice(1));
        return;
      }
      // Restore last submitted message if input is empty and not currently executing
      if (!input && lastSubmittedInputRef.current && !state.isExecuting) {
        setInput(lastSubmittedInputRef.current);
        setHistoryIndex(null);
        return;
      }
      setInput('');
      setHistoryIndex(null);
      return;
    }
    // Alt-screen transcript scrolling — PgUp/PgDn page through history.
    if (altScreen && (key.pageUp || key.pageDown)) {
      const { rows: tRows, lines: tLines } = transcriptMetaRef.current;
      const step = Math.max(1, tRows - 1);
      const maxOffset = Math.max(0, tLines - tRows);
      setHistoryOffset((prev) => Math.min(Math.max(0, key.pageUp ? prev + step : prev - step), maxOffset));
      return;
    }
    if (key.upArrow && !input.includes('\n')) {
      if (slashCompletions.length > 0) { setSlashIndex(p => (p <= 0 ? slashCompletions.length - 1 : p - 1)); return; }
      const nextIndex = historyIndex === null ? 0 : Math.min(historyIndex + 1, inputHistory.length - 1);
      if (inputHistory[nextIndex]) { setHistoryIndex(nextIndex); setInput(inputHistory[nextIndex]!); }
    } else if (key.downArrow && !input.includes('\n')) {
      if (slashCompletions.length > 0) { setSlashIndex(p => (p + 1) % slashCompletions.length); return; }
      if (historyIndex === null) return;
      const nextIndex = historyIndex - 1; setHistoryIndex(nextIndex < 0 ? null : nextIndex); setInput(nextIndex < 0 ? '' : inputHistory[nextIndex]!);
    } else if (key.tab && slashCompletions.length > 0) {
      const selected = slashCompletions[slashIndex];
      if (selected) {
        setInput(selected + ' ');
        setSlashIndex(0);
        return;
      }
    }
    // Ensure slashIndex is handled when characters are deleted
    if ((key.backspace || key.delete) && slashCompletions.length > 0) {
      setSlashIndex(0);
    }
  });

  // Terminal dimensions react to resize events so the layout budget and
  // StatusBar width never go stale mid-session (previously `columns` was
  // read once per render with a 100-col fallback and never refreshed).
  const [termSize, setTermSize] = useState(() => ({
    columns: stdout?.columns ?? 100,
    rows: stdout?.rows ?? 40,
  }));
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setTermSize({ columns: stdout.columns ?? 100, rows: stdout.rows ?? 40 });
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);
  const width = termSize.columns;
  const adaptiveMode = computeAdaptiveLayoutMode(termSize.columns, termSize.rows);

  // Row budget for live panels — shrinks panels before the live area can
  // outgrow the viewport, which would force Ink into full-screen redraws
  // (the flicker users see on small/busy terminals).
  const budgetOpts = {
    isTypingCommand,
    showCost: state.showCost && adaptiveMode !== 'narrow',
    showDetails: state.showDetails && adaptiveMode === 'wide',
    showComms: state.showComms && state.peerEvents.length > 0 && adaptiveMode === 'wide',
  };
  const liveBudget = computeLiveAreaBudget(termSize.rows, budgetOpts);
  const tierSummary = activeTierSummary(state.agentTree);

  // Alt-screen transcript: history renders as a line-windowed view
  // (PgUp/PgDn) because the alternate screen has no native scrollback.
  const transcriptRows = altScreen
    ? computeTranscriptRows(termSize.rows, liveBudget, { ...budgetOpts, treeVisible: state.agentTree != null })
    : 0;
  const transcriptLines = altScreen ? flattenTranscript(state.messages) : [];
  const transcript = altScreen ? windowTranscript(transcriptLines, historyOffset, transcriptRows) : null;
  transcriptMetaRef.current = { rows: transcriptRows, lines: transcriptLines.length };

  useEffect(() => {
    // Actively DISABLE mouse reporting on mount so the terminal's own
    // scrollback handles the wheel (and PgUp / PgDn) and native drag-select
    // + right-click copy keep working. Completed messages live in the
    // scrollback via Ink <Static> since v0.5.4 — if we capture mouse events
    // here, the wheel scrolls nothing and the user can't see history. The
    // strip-and-swallow branch below stays as defense-in-depth in case
    // another layer turns capture back on.
    disableMouseReporting();

    const onData = (data: Buffer) => {
      const str = data.toString();

      if (containsMouseSequence(str)) {
        lockInputTemporarily();
        return; // swallow — the terminal's native scrollback handles wheel
      }

      // Ctrl+Up / Ctrl+Down — scroll the agent tree (not the chat).
      if (str === '\x1b[1;5A') { setTreeScrollOffset(p => Math.max(0, p - 1)); return; }
      if (str === '\x1b[1;5B') { setTreeScrollOffset(p => p + 1); return; }

      // Forward-delete (\x1b[3~) is handled by SafeTextInput's own raw-stdin
      // listener — we deliberately don't handle it here to avoid duplicates.
    };

    process.stdin.on('data', onData);
    return () => {
      disableMouseReporting();
      process.stdin.removeListener('data', onData);
    };
  }, [lockInputTemporarily]);

  return (
    <Box flexDirection="column" width={width}>
      {/* Conversation history.
          Normal mode: Static items are written to the terminal scrollback
          ONCE and never re-rendered — this is what kills the per-render
          write cost that flickered on maximized terminals.
          Alt-screen mode: no scrollback exists, so history renders as a
          fixed-height line window scrolled with PgUp/PgDn. */}
      {altScreen && transcript ? (
        <Box flexDirection="column" paddingX={1} height={transcriptRows + 2}>
          <Text color={theme.colors.muted} dimColor>
            {transcript.above > 0 ? `↑ ${transcript.above} more lines · PgUp` : ' '}
          </Text>
          {transcript.visible.map((line, i) => {
            if (line.headerRole) {
              const style = TRANSCRIPT_HEADER_STYLE[line.headerRole];
              return (
                <Text key={`h-${i}`} color={theme.colors[style.color]} bold>
                  {style.prefix} {style.label}
                </Text>
              );
            }
            return <Text key={`l-${i}`} wrap="truncate-end">{line.text || ' '}</Text>;
          })}
          <Text color={theme.colors.muted} dimColor>
            {transcript.below > 0 ? `↓ ${transcript.below} more lines · PgDn` : ' '}
          </Text>
        </Box>
      ) : (
        <Static items={state.messages}>
          {(msg) => (
            <ChatMessage
              key={msg.id}
              role={msg.role}
              content={msg.content}
              timestamp={msg.timestamp}
              theme={theme}
            />
          )}
        </Static>
      )}

      {/* ── Live area: everything below re-renders on each batch ── */}

      <StatusBar
        theme={theme}
        tierModels={{
          t1: config.models?.t1,
          t2: config.models?.t2,
          t3: config.models?.t3,
        }}
        tokens={state.totalTokens}
        costUsd={state.totalCostUsd}
        savedUsd={state.savedUsd}
        workspacePath={workspacePath}
        isExecuting={state.isExecuting}
        activeTier={state.agentTree?.status === 'ACTIVE' ? 'T1' : undefined}
      />

      {startupWarning && (
        <Box paddingX={2}>
          <Text color="yellow">{startupWarning}</Text>
        </Box>
      )}

      {state.messages.length === 0 && !state.isStreaming && (
        <WelcomeBanner theme={theme} config={config} workspacePath={workspacePath} sessionId={sessionIdRef.current} />
      )}

      {/* Live streaming response — capped to the last 8 lines so a long
          generation can't push the rest of the live area off-screen. The
          full text shows in scrollback once it commits. */}
      {state.isStreaming && state.streamBuffer && (
        <Box flexDirection="column" paddingX={1} marginTop={1}>
          <Box>
            <Text color={theme.colors.accent} bold>◈ CASCADE</Text>
            <Text color={theme.colors.muted}> streaming…</Text>
          </Box>
          {tailLines(state.streamBuffer, 8).map((line, i) => (
            <Text key={i} wrap="wrap">{line}</Text>
          ))}
        </Box>
      )}

      {isShowingModels && (
        <Box paddingX={1}>
          <ModelsDisplay
            providers={config.providers.map(p => p.type)}
            modelsByProvider={cachedModels}
            onSelect={(sel) => { void applyModelPick(sel); }}
            onClose={() => setIsShowingModels(false)}
          />
        </Box>
      )}

      {/* Compact agent tree — collapses on the next keystroke after completion */}
      {adaptiveMode === 'narrow' && state.agentTree ? (
        <CompactStatus
          theme={theme}
          activeT2Count={tierSummary.t2}
          activeT3Count={tierSummary.t3}
          currentAction={tierSummary.action ?? state.agentTree.currentAction}
          activeTool={state.activeTool}
          isStreaming={state.isStreaming}
        />
      ) : (
        <AgentTree
          root={state.agentTree}
          theme={theme}
          scrollOffset={treeScrollOffset}
          maxRows={adaptiveMode === 'medium' ? Math.min(4, liveBudget.treeMaxRows) : liveBudget.treeMaxRows}
        />
      )}

      {/* Agent-to-agent comms feed — the radio chatter between workers */}
      {adaptiveMode === 'wide' && state.showComms && liveBudget.commsMaxEvents > 0 && (
        <PeerFeed events={state.peerEvents} theme={theme} maxRows={liveBudget.commsMaxEvents} />
      )}

      {adaptiveMode === 'wide' && state.showDetails && liveBudget.showTimeline && (
        <TimelinePanel nodes={[...treeNodesRef.current.values()]} theme={theme} currentIndex={timelineIndex} onChangeIndex={setTimelineIndex} />
      )}
      {adaptiveMode !== 'narrow' && state.showCost && <CostTracker theme={theme} totalTokens={state.totalTokens} totalCostUsd={state.totalCostUsd} callsByProvider={state.callsByProvider} callsByTier={state.callsByTier} costByTier={state.costByTier} tokensByTier={state.tokensByTier} costByFeature={state.costByFeature} compact={liveBudget.costCompact} savedUsd={state.savedUsd} savedPct={state.savedPct} />}
      {liveBudget.collapsed && (state.showCost || state.showDetails || state.agentTree != null) && (
        <Text color={theme.colors.muted} dimColor>  ▸ panels collapsed (small terminal)</Text>
      )}
      {state.approvalRequest && <ApprovalPrompt request={state.approvalRequest} theme={theme} onDecision={(decision) => { dispatch({ type: 'SET_APPROVAL', request: null }); approvalResolverRef.current?.(decision); }} />}
      {planApprovalRequest && (
        <PlanApproval
          request={planApprovalRequest}
          theme={theme}
          editable={config.planReview?.editable !== false}
          onDecision={(approved, note, editedPlan) => {
            setPlanApprovalRequest(null);
            // editedPlan is structurally a TaskPlan (the original minus dropped sections).
            cascadeRef.current?.resolvePlanApproval(approved, note, editedPlan as never);
          }}
        />
      )}
      {/* Suggestion panel — fixed height so the input below doesn't jump as
          entries filter while typing. Sized for header (1) + 8 entries +
          up to 2 scroll indicators = 11 rows worst case. */}
      {isTypingCommand && (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.border} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text color={theme.colors.muted}>Commands  ↑↓ navigate · ↵ select · Tab complete</Text>
            {slashEntries.length > SLASH_PAGE_SIZE && (
              <Text color={theme.colors.muted} dimColor>
                {slashIndex + 1}/{slashEntries.length}
              </Text>
            )}
          </Box>
          {/* Constant layout: 1 "above" row + exactly SLASH_PAGE_SIZE item rows
              + 1 "below" row, every slot always rendered (blank when empty). A
              stable row count and one <Text> per row let Ink fully clear each
              line, so scrolling never leaves residue from a longer prior frame. */}
          <Text color={theme.colors.muted} dimColor wrap="truncate">
            {slashViewStart > 0 ? `  ↑ ${slashViewStart} more above` : ' '}
          </Text>
          {Array.from({ length: SLASH_PAGE_SIZE }).map((_, i) => {
            const globalIdx = slashViewStart + i;
            const entry = slashEntries[globalIdx];
            if (!entry) return <Text key={`slash-empty-${i}`}> </Text>;
            const isSelected = globalIdx === slashIndex;
            return (
              <Box key={entry.command} flexDirection="row">
                <Box width={18} flexShrink={0}>
                  <Text color={isSelected ? theme.colors.accent : theme.colors.foreground} bold={isSelected} wrap="truncate">
                    {(isSelected ? '› ' : '  ') + entry.command}
                  </Text>
                </Box>
                <Text color={theme.colors.muted} dimColor wrap="truncate">
                  {entry.description || ' '}
                </Text>
              </Box>
            );
          })}
          <Text color={theme.colors.muted} dimColor wrap="truncate">
            {slashViewStart + SLASH_PAGE_SIZE < slashEntries.length
              ? `  ↓ ${slashEntries.length - slashViewStart - SLASH_PAGE_SIZE} more below`
              : ' '}
          </Text>
        </Box>
      )}
      {/* ── Hint bar — keyboard shortcuts, hidden during execution ── */}
      <HintBar theme={theme} isExecuting={state.isExecuting} />

      <Box borderStyle="round" borderColor={(quitAttempted || cancelAttempted || cancelling) ? 'red' : (state.isStreaming ? theme.colors.accent : theme.colors.border)} paddingX={2} flexDirection="column">
        {cancelling ? (
          <Box marginBottom={0}>
            <Text color="red" bold> ⊘ Cancelling — stopping in-flight work… </Text>
          </Box>
        ) : cancelAttempted ? (
          <Box marginBottom={0}>
            <Text color="red" bold> Press Ctrl+C again (or ESC) to cancel the running task </Text>
          </Box>
        ) : quitAttempted ? (
          <Box marginBottom={0}>
            <Text color="red" bold> Press Ctrl+C again to quit or ESC to return to TUI </Text>
          </Box>
        ) : commandRunning ? (
          <Box marginBottom={0}>
            <Text color={theme.colors.accent} bold> ⠋ Running command… </Text>
          </Box>
        ) : null}
        <Box flexDirection="row">
          <Text color={theme.colors.primary} bold>› {queuedMessages.length > 0 ? <Text color={theme.colors.accent}>[QUEUED] </Text> : ''}</Text>
          <SafeTextInput
            focus={!state.approvalRequest && !planApprovalRequest && !isShowingModels}
            value={input}
            manageMouseReporting={false}
            onChange={(val) => {
              if (isInputLockedRef.current) return;
              // Collapse the completed agent tree and comms feed now that the
              // user is typing again — this replaces the old idle timer, whose
              // repaint could wipe an in-progress mouse selection.
              if (!state.isExecuting && val.length > 0) {
                if (state.agentTree != null) dispatch({ type: 'CLEAR_TREE' });
                if (state.peerEvents.length > 0) dispatch({ type: 'CLEAR_PEER_EVENTS' });
              }
              // Defense in depth — SafeTextInput already sanitizes, but a brief
              // input-lock window can still pass through values we'd rather drop.
              setInput(sanitizeTerminalInput(val));
            }}
            onSubmit={handleSubmit}
            placeholder={state.isStreaming ? "Wait for response or type next prompt to queue…" : "Ask Cascade anything… (/help for commands)"}
          />
        </Box>
      </Box>
    </Box>
  );
}

const TRANSCRIPT_HEADER_STYLE: Record<'user' | 'assistant' | 'system' | 'error', { prefix: string; label: string; color: 'primary' | 'accent' | 'muted' | 'error' }> = {
  user: { prefix: '▸', label: 'USER', color: 'primary' },
  assistant: { prefix: '◈', label: 'CASCADE', color: 'accent' },
  system: { prefix: '◦', label: 'SYSTEM', color: 'muted' },
  error: { prefix: '✗', label: 'ERROR', color: 'error' },
};

const DECISION_KIND_LABEL: Record<DecisionLogEntry['kind'], string> = {
  complexity: 'Complexity',
  model: 'Models',
  failover: 'Failover',
  escalation: 'Escalation',
  context: 'Context',
};

function formatPlanPreview(plan: { complexity: string; sections: Array<{ sectionTitle: string; t3Subtasks?: unknown[] }>; reasoning?: string }): string {
  if (!plan?.sections?.length) return 'No plan could be produced for that prompt.';
  const lines = plan.sections.map((s, i) => {
    const workers = s.t3Subtasks?.length ?? 0;
    return `  ${i + 1}. ${s.sectionTitle}${workers ? `  (${workers} worker${workers !== 1 ? 's' : ''})` : ''}`;
  });
  const n = plan.sections.length;
  return [
    `Plan preview — ${plan.complexity} · ${n} section${n !== 1 ? 's' : ''} (not executed):`,
    ...lines,
    plan.reasoning ? `\n${plan.reasoning}` : '',
    '\nSend the prompt normally to run it.',
  ].filter(Boolean).join('\n');
}

function formatDecisionTrail(entries: DecisionLogEntry[]): string {
  if (!entries.length) {
    return 'No decision trail yet — run a prompt first, then /why explains how it was routed.';
  }
  const lines = entries.map((e, i) => `  ${i + 1}. ${DECISION_KIND_LABEL[e.kind]}: ${e.detail}`);
  return ['Decision trail for the last run', ...lines].join('\n');
}

function formatRunReceipt(
  result: { durationMs: number; t2Results: Array<{ t3Results?: unknown[] }> },
  totalCostUsd: number,
  savings: { savedUsd: number; savedPct: number },
): string {
  const seconds = Math.max(1, Math.round(result.durationMs / 1000));
  const managers = result.t2Results.length;
  const workers = result.t2Results.reduce((sum, r) => sum + (r.t3Results?.length ?? 0), 0);
  const parts = [`✔ Done in ${seconds}s`];
  if (managers > 0) parts.push(`${managers} manager${managers !== 1 ? 's' : ''}`);
  if (workers > 0) parts.push(`${workers} worker${workers !== 1 ? 's' : ''}`);
  parts.push(`$${totalCostUsd.toFixed(4)}`);
  const line = parts.join(' · ');
  return savings.savedUsd > 0
    ? `${line} (saved $${savings.savedUsd.toFixed(4)} — ${savings.savedPct}% vs. all-T1)`
    : line;
}

function toConversationHistory(messages: Message[]): ConversationMessage[] {
  return messages
    .filter((m): m is Message & { role: 'user' | 'assistant' | 'system' } => m.role !== 'error')
    .map((m) => ({ role: m.role, content: m.content }));
}

function buildTreeFromFlatNodes(nodes: FlatTreeNode[]): TierNode | null {
  if (!nodes.length) return null;
  const cloned = new Map<string, FlatTreeNode>();
  for (const node of nodes) cloned.set(node.id, { ...node, children: [] });
  const roots: FlatTreeNode[] = [];
  for (const node of cloned.values()) {
    if (node.parentId && cloned.has(node.parentId)) cloned.get(node.parentId)!.children!.push(node);
    else roots.push(node);
  }
  return roots[0] || null;
}

async function validateConfiguredModels(config: CascadeConfig): Promise<string | null> {
  const problems: string[] = [];
  if (config.models.t1 && !inferProviderFromModelId(config.models.t1, config.providers)) problems.push(`T1: ${config.models.t1}`);
  return problems.length ? `Model warnings: ${problems.join(', ')}` : null;
}

function inferProviderFromModelId(id: string, providers: CascadeConfig['providers']): ProviderType | null {
  if (id.includes(':')) {
    const prefix = id.split(':')[0]!.toLowerCase();
    const validProviders = ['anthropic', 'openai', 'gemini', 'azure', 'openai-compatible', 'ollama'];
    if (validProviders.includes(prefix)) {
      return prefix as ProviderType;
    }
  }
  const lower = id.toLowerCase();
  if (lower.includes('gpt')) return 'openai';
  if (lower.includes('claude')) return 'anthropic';
  if (lower.includes('gemini')) return 'gemini';
  return providers[0]?.type || null;
}

function listConfiguredProviders(config: CascadeConfig): string { return config.providers.map(p => p.type).join(', '); }
function formatConfigSummary(config: CascadeConfig): string {
  const providers = config.providers?.map((p) => p.type).join(', ') || '(none)';
  const t1 = config.models?.t1 ?? 'auto';
  const t2 = config.models?.t2 ?? 'auto';
  const t3 = config.models?.t3 ?? 'auto';
  return [
    `Theme:         ${config.theme ?? 'cascade'}`,
    `Providers:     ${providers}`,
    `Models:        T1 ${t1}  ·  T2 ${t2}  ·  T3 ${t3}`,
    `Dashboard:     port ${config.dashboard?.port ?? '(unset)'}`,
    `Cascade Auto:  ${config.cascadeAuto ? 'on' : 'off'}`,
  ].join('\n');
}
function stringifySlashOutput(val: unknown): string { return typeof val === 'string' ? val : JSON.stringify(val); }
async function searchSessionsAndMessages(query: string, workspacePath: string): Promise<string> {
  if (!query) return 'Usage: /search <query>';
  const dbPath = path.join(workspacePath, CASCADE_DB_FILE);
  
  // Check if DB exists
  try {
    await fs.access(dbPath);
  } catch {
    return 'No database found. Start a conversation first.';
  }

  const store = new MemoryStore(dbPath);
  try {
    const sessions = store.listSessions(undefined, 20).filter((s) => s.title.toLowerCase().includes(query.toLowerCase()));
    const messages = store.searchMessages(query, 20);
    
    if (sessions.length === 0 && messages.length === 0) {
      return `No results found for "${query}".`;
    }

    const lines = [
      `🔍 Search results for "${query}":`,
      '',
      `📂 Sessions (${sessions.length}):`,
      ...sessions.slice(0, 5).map((s) => `  - ${s.title} (ID: ${s.id.slice(0, 8)}...)`),
      sessions.length > 5 ? `  ... and ${sessions.length - 5} more` : '',
      '',
      `💬 Messages (${messages.length}):`,
      ...messages.slice(0, 8).map((m) => `  - [${m.role.toUpperCase()}] ${m.content.slice(0, 100)}${m.content.length > 100 ? '...' : ''}`),
      messages.length > 8 ? `  ... and ${messages.length - 8} more` : '',
    ];
    return lines.filter(Boolean).join('\n');
  } catch (err: unknown) {
    return `Search failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally { store.close(); }
}

async function diagnoseRuntime(config: CascadeConfig, workspacePath: string): Promise<string> {
  const providers = config.providers.map((p) => `${p.type}${p.apiKey ? ' (key set)' : ' (no key)'}`).join('\n');
  const models = [`T1: ${config.models.t1 ?? 'default'}`, `T2: ${config.models.t2 ?? 'default'}`, `T3: ${config.models.t3 ?? 'default'}`].join('\n');
  const store = new MemoryStore(path.join(workspacePath, CASCADE_DB_FILE));
  try {
    const sessions = store.listSessions(undefined, 3);
    return [
      'Provider checks:', providers || 'No providers configured.', '',
      'Configured models:', models, '',
      `Local sessions: ${sessions.length}`,
      ...sessions.map((s) => `- ${s.title} (${s.id})`),
    ].join('\n');
  } finally { store.close(); }
}

async function showRecentLogs(args: string[], workspacePath: string): Promise<string> {
  const limit = Number.parseInt(args[0] ?? '10', 10) || 10;
  const store = new MemoryStore(path.join(workspacePath, CASCADE_DB_FILE));
  try {
    const logs = store.listRuntimeNodeLogs(undefined, undefined, limit);
    if (!logs.length) return 'No recent runtime logs.';
    return logs.map((log) => `[${log.timestamp}] ${log.role} ${log.label} — ${log.status}${log.currentAction ? ` — ${log.currentAction}` : ''}`).join('\n');
  } finally { store.close(); }
}

interface SessionResumeSnapshot {
  session: Session;
  messages: Message[];
  runtimeNodes: RuntimeNode[];
  runtimeLogs: RuntimeNodeLog[];
}

async function loadSessionSnapshot(args: string[], workspacePath: string): Promise<SessionResumeSnapshot | string> {
  const sessionId = args[0];
  if (!sessionId) return 'Usage: /resume <sessionId>';
  const store = new MemoryStore(path.join(workspacePath, CASCADE_DB_FILE));
  try {
    const session = store.getSession(sessionId);
    if (!session) return `Session not found: ${sessionId}`;
    return {
      session,
      messages: session.messages.map((m) => ({ id: m.id, role: m.role, content: m.content, timestamp: m.timestamp })),
      runtimeNodes: store.listRuntimeNodes(sessionId, 500),
      runtimeLogs: store.listRuntimeNodeLogs(sessionId, undefined, 500),
    };
  } finally { store.close(); }
}

function hydrateResumeState(snapshot: SessionResumeSnapshot, options: {
  dispatch: React.Dispatch<ReplAction>;
  treeNodesRef: React.MutableRefObject<Map<string, FlatTreeNode>>;
  nodeLogsRef: React.MutableRefObject<Map<string, string[]>>;
  sessionIdRef: React.MutableRefObject<string>;
  startedAtRef: React.MutableRefObject<string>;
  setInputHistory: React.Dispatch<React.SetStateAction<string[]>>;
  setHistoryIndex: React.Dispatch<React.SetStateAction<number | null>>;
  setCurrentIdentityId: React.Dispatch<React.SetStateAction<string | undefined>>;
  storeRef: React.MutableRefObject<MemoryStore | null>;
}) {
  const { dispatch, treeNodesRef, nodeLogsRef, sessionIdRef, startedAtRef, setInputHistory, setHistoryIndex, setCurrentIdentityId, storeRef } = options;
  sessionIdRef.current = snapshot.session.id;
  startedAtRef.current = snapshot.session.createdAt;
  setInputHistory(snapshot.messages.filter((m) => m.role === 'user').map((m) => m.content));
  setHistoryIndex(null);
  setCurrentIdentityId(snapshot.session.identityId);
  dispatch({ type: 'CLEAR' });
  for (const msg of snapshot.messages) { dispatch({ type: 'ADD_MESSAGE', message: msg } as ReplAction); }
  treeNodesRef.current.clear();
  nodeLogsRef.current.clear();
  for (const node of snapshot.runtimeNodes) {
    treeNodesRef.current.set(node.tierId, { id: node.tierId, role: node.role, label: node.label, status: node.status, currentAction: node.currentAction, progressPct: node.progressPct, children: [], parentId: node.parentId });
  }
  for (const log of snapshot.runtimeLogs) {
    const history = nodeLogsRef.current.get(log.tierId) ?? [];
    nodeLogsRef.current.set(log.tierId, [...history.slice(-24), [log.status, log.currentAction].filter(Boolean).join(' — ')]);
  }
  dispatch({ type: 'SET_TREE', tree: buildTreeFromFlatNodes([...treeNodesRef.current.values()]) });
  storeRef.current?.updateSession(snapshot.session.id, { updatedAt: new Date().toISOString() });
}

function formatRuntimeStatus(nodes: FlatTreeNode[], nodeLogs: Map<string, string[]>): string {
  if (!nodes.length) return 'No active agent tree.';
  const active = nodes.filter((node) => node.status === 'ACTIVE');
  const failed = nodes.filter((node) => node.status === 'FAILED' || node.status === 'ESCALATED');
  const lines = [`Active nodes: ${active.length}`, `Failed nodes: ${failed.length}`, ''];
  for (const node of [...active, ...failed].slice(0, 10)) {
    lines.push(`[${node.role}] ${node.label} — ${node.status}`);
    const recent = (nodeLogs.get(node.id) ?? []).slice(-2);
    for (const entry of recent) lines.push(`  · ${entry}`);
  }
  return lines.join('\n');
}

async function generateSessionName(firstMessage: string, cascade: Cascade | null): Promise<string | null> {
  if (!cascade) return null;
  try {
    const router = cascade.getRouter();
    const prompt = `Generate a concise 3-5 word session title for this AI conversation. Return ONLY the title, no punctuation, no quotes.\n\nFirst message: "${firstMessage.slice(0, 200)}"`;
    const result = await router.generate('T3', {
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 20,
    });
    const name = result.content.trim().replace(/^["']|["']$/g, '').slice(0, 60);
    return name || null;
  } catch {
    return null;
  }
}
