// ─────────────────────────────────────────────
//  Cascade AI — Interactive REPL (ink)
// ─────────────────────────────────────────────

import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
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
  ProviderType,
  RuntimeNode,
  RuntimeNodeLog,
  Session,
  Theme,
  Message,
} from '../../types.js';
import { CASCADE_DB_FILE, GLOBAL_CONFIG_DIR, GLOBAL_RUNTIME_DB_FILE } from '../../constants.js';
import { Cascade } from '../../core/cascade.js';
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
import { AgentTree, type TierNode } from './components/AgentTree.js';
import { TimelinePanel } from './components/TimelinePanel.js';
import { StatusBar } from './components/StatusBar.js';
import { HintBar } from './components/HintBar.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { ModelsDisplay, type ModelPickerSelection } from './components/ModelsDisplay.js';
import { CostTracker } from './components/CostTracker.js';
import { CompactStatus } from './components/CompactStatus.js';
import { formatToLines } from './utils/line-buffer.js';

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
  | { type: 'UPDATE_COST'; tokens: number; costUsd: number; byProvider: Record<string,number>; byTier: Record<string,number>; costByTier: Record<string,number>; tokensByTier: Record<string,number> }
  | { type: 'SET_APPROVAL'; request: ApprovalRequest | null }
  | { type: 'SET_EXECUTING'; isExecuting: boolean }
  | { type: 'SET_STREAMING'; isStreaming: boolean }
  | { type: 'CLEAR' }
  | { type: 'TOGGLE_COST' }
  | { type: 'TOGGLE_DETAILS' }
  | { type: 'SET_ERROR'; error: string | null }
  | { type: 'SET_ACTIVE_TOOL'; toolName: string | null };

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
      return { ...state, totalTokens: action.tokens, totalCostUsd: action.costUsd, callsByProvider: action.byProvider, callsByTier: action.byTier, costByTier: action.costByTier, tokensByTier: action.tokensByTier };
    case 'SET_APPROVAL':
      return { ...state, approvalRequest: action.request };
    case 'SET_EXECUTING':
      return { ...state, isExecuting: action.isExecuting };
    case 'SET_STREAMING':
      return { ...state, isStreaming: action.isStreaming };
    case 'CLEAR':
      return { ...state, messages: [], agentTree: null, streamBuffer: '', totalTokens: 0, totalCostUsd: 0, activeTool: null };
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

export function Repl({ config, workspacePath, themeName, initialPrompt, identityName }: ReplProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [theme, setTheme] = useState<Theme>(() => getTheme(themeName));
  const [input, setInput] = useState('');
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [identities, setIdentities] = useState<Array<{ id: string; name: string; isDefault: boolean }>>([]);
  const [currentIdentityId, setCurrentIdentityId] = useState<string | undefined>(config.defaultIdentityId);
  const [state, dispatch] = useReducer(replReducer, { messages: [], agentTree: null, isStreaming: false, isExecuting: false, streamBuffer: '', totalTokens: 0, totalCostUsd: 0, callsByProvider: {}, callsByTier: {}, costByTier: {}, tokensByTier: {}, approvalRequest: null, showCost: false, showDetails: false, error: null, activeTool: null });
  const [isShowingModels, setIsShowingModels] = useState(false);
  const [cachedModels, setCachedModels] = useState<Map<ProviderType, ModelInfo[]>>(new Map());
  const cascadeRef = useRef<Cascade | null>(null);
  const storeRef = useRef<MemoryStore | null>(null);
  const slashRef = useRef(new SlashCommandRegistry());
  const approvalResolverRef = useRef<((decision: { approved: boolean; always: boolean }) => void) | null>(null);
  const sessionIdRef = useRef(randomUUID());
  const startedAtRef = useRef(new Date().toISOString());
  const treeNodesRef = useRef<Map<string, FlatTreeNode>>(new Map());
  const nodeLogsRef = useRef<Map<string, string[]>>(new Map());
  const [startupWarning, setStartupWarning] = useState<string | null>(null);
  const [timelineIndex, setTimelineIndex] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [isAutoScrolling, setIsAutoScrolling] = useState(true);
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const [quitAttempted, setQuitAttempted] = useState(false);
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
      (config.models as Record<string, string | undefined>)[tierKey] = sel.modelId;
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
        await handleSlashCommand(trimmed);
        return;
      }
      setQueuedMessages(prev => [...prev, trimmed]);
      setInput('');
      return;
    }
    setInputHistory((prev) => [trimmed, ...prev.filter((item) => item !== trimmed)].slice(0, 100));
    setHistoryIndex(null);
    if (slashRef.current.isSlashCommand(trimmed)) { await handleSlashCommand(trimmed); return; }
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
    treeNodesRef.current.clear(); rebuildTree();
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
    cascade.on('tier:root', onRoot);
    cascade.on('stream:token', onStream);
    cascade.on('tier:status', (ev: TierStatusEvent) => {
      recordNodeEvent(ev);
      const stats = cascade.getRouter().getStats();
      dispatch({ type: 'UPDATE_COST', tokens: stats.totalTokens, costUsd: stats.totalCostUsd, byProvider: stats.callsByProvider, byTier: stats.callsByTier, costByTier: stats.costByTier, tokensByTier: stats.tokensByTier });
      // Extract active tool from currentAction if present
      if (ev.currentAction?.startsWith('Using tool:')) {
        const toolName = ev.currentAction.replace('Using tool:', '').trim();
        dispatch({ type: 'SET_ACTIVE_TOOL', toolName });
      }
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
      const result = await cascade.run({
        prompt: trimmed,
        workspacePath,
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
      const stats = cascade.getRouter().getStats();
      dispatch({ type: 'UPDATE_COST', tokens: stats.totalTokens, costUsd: stats.totalCostUsd, byProvider: stats.callsByProvider, byTier: stats.callsByTier, costByTier: stats.costByTier, tokensByTier: stats.tokensByTier });
      dispatch({ type: 'COMMIT_STREAM', finalText: result.output, timestamp: new Date().toISOString() });
      persistMessage('assistant', result.output, new Date().toISOString());
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
      cascade.removeAllListeners(); 
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
      if (quitAttempted) {
        exit();
        return;
      }
      setQuitAttempted(true);
      return;
    }
    if (key.escape) {
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
    const maxScroll = Math.max(0, allLines.length - chatWindowHeight);
    if (key.pageUp || (key.shift && key.upArrow)) { 
      setIsAutoScrolling(false); 
      setScrollOffset(p => Math.max(0, p - 5)); 
    }
    if (key.pageDown || (key.shift && key.downArrow)) { 
      setScrollOffset(p => { 
        const next = p + 5; 
        if (next >= maxScroll) { setIsAutoScrolling(true); return maxScroll; }
        return next; 
      }); 
    }
    
    // Ensure slashIndex is handled when characters are deleted
    if ((key.backspace || key.delete) && slashCompletions.length > 0) {
      setSlashIndex(0);
    }
  });

  const allLinesRef = useRef<number>(0);
  const chatWindowHeightRef = useRef<number>(10);
  const isAutoScrollingRef = useRef<boolean>(true);

  const width = stdout?.columns ?? 100;
  const height = stdout?.rows ?? 24;
  
  // Calculate dynamic heights exactly to prevent screen flickering
  const hasActiveOrFailed = (node: TierNode): boolean => {
    if (node.status === 'ACTIVE' || node.status === 'FAILED') return true;
    return node.children?.some(hasActiveOrFailed) ?? false;
  };

  let agentTreeHeight = 0;
  if (state.agentTree && hasActiveOrFailed(state.agentTree)) {
    agentTreeHeight = 1; // Header row
    const childrenCount = state.agentTree.children?.length ?? 0;
    agentTreeHeight += Math.min(childrenCount, 6); // Up to 6 T2 rows
    if (childrenCount > 6) agentTreeHeight += 1; // "... more sections" row
  }

  let timelineHeight = 0;
  if (state.showDetails && treeNodesRef.current.size > 0) {
    timelineHeight = 1; // "Activity Log" header
    timelineHeight += Math.min(3, treeNodesRef.current.size); // Up to 3 logs
  }

  const statusHeight = agentTreeHeight + timelineHeight;
  const costHeight = state.showCost ? 6 : 0;
  const approvalHeight = state.approvalRequest ? 12 : 0;
  const slashVisibleCount = Math.min(SLASH_PAGE_SIZE, slashEntries.length);
  const slashHeight = isTypingCommand ? SLASH_PAGE_SIZE + 2 : 0; // Fixes flicker by preserving constant layout height during command typing
  const chromeHeight = statusHeight + costHeight + approvalHeight + slashHeight + 7; // Input(3) + Status(2) + Margins(2)
  const totalCap = Math.floor(height * 0.7);

  const availableHeight = Math.max(4, height - chromeHeight);
  const allLines = formatToLines(
    state.isStreaming 
      ? [...state.messages, { id: 'stream', role: 'assistant', content: state.streamBuffer, timestamp: new Date().toISOString() } as Message] 
      : state.messages,
    width - 4,
    theme
  );

  const chatWindowHeight = Math.min(allLines.length || (state.isStreaming ? 0 : 4), availableHeight);
  const maxScroll = Math.max(0, allLines.length - chatWindowHeight);

  useEffect(() => {
    if (isAutoScrolling) {
      setScrollOffset(maxScroll);
    }
  }, [allLines.length, isAutoScrolling, maxScroll]);

  useEffect(() => {
    allLinesRef.current = allLines.length;
    chatWindowHeightRef.current = chatWindowHeight;
    isAutoScrollingRef.current = isAutoScrolling;
  }, [allLines.length, isAutoScrolling, chatWindowHeight]);

  useEffect(() => {
    // Enable mouse reporting (1000: mouse move/press, 1006: SGR mode).
    // SafeTextInput honours `manageMouseReporting={false}` so it won't disable
    // this on mount. Bracketed-paste mode is enabled by SafeTextInput itself.
    process.stdout.write('\x1b[?1000h\x1b[?1006h');

    const onData = (data: Buffer) => {
      const str = data.toString();

      // SGR mouse sequence → handle scroll wheel, swallow the rest.
      if (containsMouseSequence(str)) {
        // Lock input ONLY for mouse sequences to prevent them leaking into the prompt.
        // ⚠ Do NOT lock for all \x1b sequences — that would block Delete (\x1b[3~),
        //   arrow keys, Home, End, and other navigation escape sequences.
        lockInputTemporarily();
        const mouseMatch = str.match(/\x1b\[<(\d+);\d+;\d+[Mm]/);
        if (mouseMatch) {
          const code = parseInt(mouseMatch[1]!, 10);
          if (code === 64) { // Wheel Up
            setIsAutoScrolling(false);
            setScrollOffset(p => Math.max(0, p - 3));
          } else if (code === 65) { // Wheel Down
            setScrollOffset(p => {
              const next = p + 3;
              const max = Math.max(0, allLinesRef.current - chatWindowHeightRef.current);
              if (next >= max) { setIsAutoScrolling(true); return max; }
              return next;
            });
          }
        }
        return; // Consumed by mouse handler
      }

      // Forward-delete (\x1b[3~) is handled by SafeTextInput's own raw-stdin
      // listener — it correctly removes the character AT the cursor, not the
      // last character of the buffer. We deliberately do NOT handle it here
      // to avoid double-deletions.
    };

    process.stdin.on('data', onData);
    return () => {
      process.stdout.write('\x1b[?1000l\x1b[?1006l');
      process.stdin.removeListener('data', onData);
    };
  }, [lockInputTemporarily]);

  const visibleLines = allLines.slice(scrollOffset, scrollOffset + chatWindowHeight);
  const showScrollAlert = !isAutoScrolling;
  const chatHeight = chatWindowHeight - (showScrollAlert ? 1 : 0);
  const currentIdentity = identities.find((id) => id.id === currentIdentityId)?.name ?? 'Default';
  const modelName = cascadeRef.current?.getRouter().getModelForTier('T1')?.name ?? 'Initializing...';

  return (
    <Box flexDirection="column" width={width}>
      {/* ── Status bar — top, always visible ── */}
      <StatusBar
        theme={theme}
        tierModels={{
          t1: config.models?.t1,
          t2: config.models?.t2,
          t3: config.models?.t3,
        }}
        tokens={state.totalTokens}
        costUsd={state.totalCostUsd}
        workspacePath={workspacePath}
        isExecuting={state.isExecuting}
        activeTier={state.agentTree?.status === 'ACTIVE' ? 'T1' : undefined}
      />

      <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.border} paddingX={1} height={chatWindowHeight + 2}>
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {showScrollAlert && (
            <Box justifyContent="center" height={1}>
              <Text backgroundColor="blue" color="white" bold> ⇡ SCROLLED UP — PgDn TO BOTTOM ⇣ </Text>
            </Box>
          )}
          <Box flexDirection="column" height={chatHeight}>
            {visibleLines.map((line, i) => (
              <Text key={i}>{line}</Text>
            ))}
          </Box>
        </Box>
      </Box>

      <Box flexDirection="column" paddingX={1}>
        {state.messages.length === 0 && !state.isStreaming && (
          <WelcomeBanner theme={theme} config={config} workspacePath={workspacePath} sessionId={sessionIdRef.current} />
        )}
        {isShowingModels && (
          <ModelsDisplay
            providers={config.providers.map(p => p.type)}
            modelsByProvider={cachedModels}
            onSelect={(sel) => { void applyModelPick(sel); }}
            onClose={() => setIsShowingModels(false)}
          />
        )}
      </Box>

      {/* ── Compact agent tree — auto-hides when idle ── */}
      <AgentTree root={state.agentTree} theme={theme} />

      {state.showDetails && (
        <TimelinePanel nodes={[...treeNodesRef.current.values()]} theme={theme} currentIndex={timelineIndex} onChangeIndex={setTimelineIndex} />
      )}
      {state.showCost && <CostTracker theme={theme} totalTokens={state.totalTokens} totalCostUsd={state.totalCostUsd} callsByProvider={state.callsByProvider} callsByTier={state.callsByTier} costByTier={state.costByTier} tokensByTier={state.tokensByTier} />}
      {state.approvalRequest && <ApprovalPrompt request={state.approvalRequest} theme={theme} onDecision={(decision) => { dispatch({ type: 'SET_APPROVAL', request: null }); approvalResolverRef.current?.(decision); }} />}
      {slashEntries.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.border} paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text color={theme.colors.muted}>Commands  ↑↓ navigate · ↵ select · Tab complete</Text>
            {slashEntries.length > SLASH_PAGE_SIZE && (
              <Text color={theme.colors.muted} dimColor>
                {slashIndex + 1}/{slashEntries.length}
              </Text>
            )}
          </Box>
          {slashViewStart > 0 && (
            <Text color={theme.colors.muted} dimColor>  ↑ {slashViewStart} more above</Text>
          )}
          {slashEntries.slice(slashViewStart, slashViewStart + SLASH_PAGE_SIZE).map((entry, i) => {
            const globalIdx = slashViewStart + i;
            const isSelected = globalIdx === slashIndex;
            return (
              <Box key={entry.command} flexDirection="row">
                <Text color={isSelected ? theme.colors.accent : theme.colors.foreground} bold={isSelected}>
                  {isSelected ? '› ' : '  '}
                </Text>
                <Box width={16}>
                  <Text color={isSelected ? theme.colors.accent : theme.colors.foreground} bold={isSelected}>
                    {entry.command}
                  </Text>
                </Box>
                {entry.description ? (
                  <Text color={theme.colors.muted} dimColor> {entry.description}</Text>
                ) : null}
              </Box>
            );
          })}
          {slashViewStart + SLASH_PAGE_SIZE < slashEntries.length && (
            <Text color={theme.colors.muted} dimColor>  ↓ {slashEntries.length - slashViewStart - SLASH_PAGE_SIZE} more below</Text>
          )}
        </Box>
      )}
      {/* ── Hint bar — keyboard shortcuts, hidden during execution ── */}
      <HintBar theme={theme} isExecuting={state.isExecuting} />

      <Box borderStyle="round" borderColor={quitAttempted ? 'red' : (state.isStreaming ? theme.colors.accent : theme.colors.border)} paddingX={2} flexDirection="column">
        {quitAttempted && (
          <Box marginBottom={0}>
            <Text color="red" bold> Press Ctrl+C again to quit or ESC to return to TUI </Text>
          </Box>
        )}
        <Box flexDirection="row">
          <Text color={theme.colors.primary} bold>▸ {queuedMessages.length > 0 ? <Text color={theme.colors.accent}>[QUEUED] </Text> : ''}</Text>
          <SafeTextInput
            focus={!state.approvalRequest && !isShowingModels}
            value={input}
            manageMouseReporting={false}
            onChange={(val) => {
              if (isInputLockedRef.current) return;
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
  const lower = id.toLowerCase();
  if (lower.includes('gpt')) return 'openai';
  if (lower.includes('claude')) return 'anthropic';
  if (lower.includes('gemini')) return 'gemini';
  return providers[0]?.type || null;
}

function listConfiguredProviders(config: CascadeConfig): string { return config.providers.map(p => p.type).join(', '); }
function formatConfigSummary(config: CascadeConfig): string { return `Theme: ${config.theme}, Port: ${config.dashboard.port}`; }
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
