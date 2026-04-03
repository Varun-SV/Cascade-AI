// ─────────────────────────────────────────────
//  Cascade AI — Interactive REPL (ink)
// ─────────────────────────────────────────────

import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  ApprovalRequest,
  CascadeConfig,
  ConversationMessage,
  RuntimeNode,
  Theme,
} from '../../types.js';
import { CASCADE_DB_FILE } from '../../constants.js';
import { Cascade } from '../../core/cascade.js';
import { MemoryStore } from '../../memory/store.js';
import { getTheme } from '../themes/index.js';
import { SlashCommandRegistry } from '../slash/index.js';
import { AgentTree, type TierNode } from './components/AgentTree.js';
import { ChatMessage } from './components/ChatMessage.js';
import { StatusBar } from './components/StatusBar.js';
import { ApprovalPrompt } from './components/ApprovalPrompt.js';
import { CostTracker } from './components/CostTracker.js';

interface Message {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  timestamp: string;
}

interface FlatTreeNode extends TierNode {
  parentId?: string;
}

interface ReplState {
  messages: Message[];
  agentTree: TierNode | null;
  isStreaming: boolean;
  streamBuffer: string;
  totalTokens: number;
  totalCostUsd: number;
  callsByProvider: Record<string, number>;
  callsByTier: Record<string, number>;
  approvalRequest: ApprovalRequest | null;
  showCost: boolean;
  error: string | null;
}

type ReplAction =
  | { type: 'ADD_MESSAGE'; message: Message }
  | { type: 'APPEND_STREAM'; text: string }
  | { type: 'COMMIT_STREAM'; finalText: string; timestamp?: string }
  | { type: 'SET_TREE'; tree: TierNode | null }
  | { type: 'UPDATE_COST'; tokens: number; costUsd: number; byProvider: Record<string,number>; byTier: Record<string,number> }
  | { type: 'SET_APPROVAL'; request: ApprovalRequest | null }
  | { type: 'CLEAR' }
  | { type: 'TOGGLE_COST' }
  | { type: 'SET_ERROR'; error: string | null };

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
      return { ...state, messages: [...state.messages, msg], isStreaming: false, streamBuffer: '' };
    }
    case 'SET_TREE':
      return { ...state, agentTree: action.tree };
    case 'UPDATE_COST':
      return { ...state, totalTokens: action.tokens, totalCostUsd: action.costUsd, callsByProvider: action.byProvider, callsByTier: action.byTier };
    case 'SET_APPROVAL':
      return { ...state, approvalRequest: action.request };
    case 'CLEAR':
      return { ...state, messages: [], agentTree: null, streamBuffer: '', totalTokens: 0, totalCostUsd: 0 };
    case 'TOGGLE_COST':
      return { ...state, showCost: !state.showCost };
    case 'SET_ERROR':
      return { ...state, error: action.error };
    default:
      return state;
  }
}

interface ReplProps {
  config: CascadeConfig;
  workspacePath: string;
  themeName: string;
  initialPrompt?: string;
}

export function Repl({ config, workspacePath, themeName, initialPrompt }: ReplProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();

  const [theme, setTheme] = useState<Theme>(() => getTheme(themeName));
  const [input, setInput] = useState('');
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const [identities, setIdentities] = useState<Array<{ id: string; name: string; isDefault: boolean }>>([]);
  const [currentIdentityId, setCurrentIdentityId] = useState<string | undefined>(config.defaultIdentityId);
  const [state, dispatch] = useReducer(replReducer, {
    messages: [],
    agentTree: null,
    isStreaming: false,
    streamBuffer: '',
    totalTokens: 0,
    totalCostUsd: 0,
    callsByProvider: {},
    callsByTier: {},
    approvalRequest: null,
    showCost: false,
    error: null,
  });

  const cascadeRef = useRef<Cascade | null>(null);
  const storeRef = useRef<MemoryStore | null>(null);
  const slashRef = useRef(new SlashCommandRegistry());
  const approvalResolverRef = useRef<((approved: boolean) => void) | null>(null);
  const sessionIdRef = useRef(randomUUID());
  const startedAtRef = useRef(new Date().toISOString());
  const treeNodesRef = useRef<Map<string, FlatTreeNode>>(new Map());
  const nodeLogsRef = useRef<Map<string, string[]>>(new Map());

  const sessionTitle = state.messages.find((msg) => msg.role === 'user')?.content.slice(0, 72) ?? 'Cascade Session';
  const slashCompletions = input.trim().startsWith('/')
    ? slashRef.current.getCompletions(input.trim().split(/\s+/)[0] ?? '').slice(0, 8)
    : [];

  const persistMessage = useCallback((role: 'user' | 'assistant' | 'system', content: string, timestamp: string) => {
    const store = storeRef.current;
    if (!store) return;
    store.addMessage({
      id: randomUUID(),
      sessionId: sessionIdRef.current,
      role,
      content,
      timestamp,
    });
  }, []);

  const persistSessionMetadata = useCallback(() => {
    const store = storeRef.current;
    const cascade = cascadeRef.current;
    if (!store || !cascade) return;
    const stats = cascade.getRouter().getStats();
    store.updateSession(sessionIdRef.current, {
      title: sessionTitle,
      updatedAt: new Date().toISOString(),
      metadata: {
        totalTokens: stats.totalTokens,
        totalCostUsd: stats.totalCostUsd,
        modelsUsed: ['T1', 'T2', 'T3']
          .map((tier) => cascade.getRouter().getModelForTier(tier as 'T1' | 'T2' | 'T3')?.name)
          .filter((name): name is string => Boolean(name)),
        toolsUsed: [],
        taskCount: state.messages.filter((msg) => msg.role === 'user').length,
      },
    });
  }, [sessionTitle, state.messages]);

  const persistRuntimeSession = useCallback((status: 'ACTIVE' | 'COMPLETED' | 'FAILED', latestPrompt?: string) => {
    const store = storeRef.current;
    if (!store) return;
    store.upsertRuntimeSession({
      sessionId: sessionIdRef.current,
      title: sessionTitle,
      workspacePath,
      status,
      startedAt: startedAtRef.current,
      updatedAt: new Date().toISOString(),
      latestPrompt,
    });
  }, [sessionTitle, workspacePath]);

  const rebuildTree = useCallback(() => {
    dispatch({ type: 'SET_TREE', tree: buildTreeFromFlatNodes([...treeNodesRef.current.values()]) });
  }, []);

  const recordNodeEvent = useCallback((event: {
    tierId: string;
    role?: 'T1' | 'T2' | 'T3';
    parentId?: string;
    label?: string;
    status?: FlatTreeNode['status'];
    currentAction?: string;
    progressPct?: number;
  }) => {
    const existing = treeNodesRef.current.get(event.tierId);
    const node: FlatTreeNode = {
      id: event.tierId,
      role: event.role ?? existing?.role ?? 'T3',
      label: event.label ?? existing?.label ?? event.tierId,
      status: event.status ?? existing?.status ?? 'IDLE',
      currentAction: event.currentAction ?? existing?.currentAction,
      progressPct: event.progressPct ?? existing?.progressPct,
      parentId: event.parentId ?? existing?.parentId,
      children: [],
    };

    if (node.role === 'T2') {
      for (const [id, value] of treeNodesRef.current.entries()) {
        if (id.startsWith('plan:t2:') && value.label === node.label) {
          treeNodesRef.current.delete(id);
        }
      }
    }

    treeNodesRef.current.set(event.tierId, node);

    const store = storeRef.current;
    if (store) {
      const runtimeNode: RuntimeNode = {
        tierId: node.id,
        sessionId: sessionIdRef.current,
        parentId: node.parentId,
        role: node.role,
        label: node.label,
        status: node.status,
        currentAction: node.currentAction,
        progressPct: node.progressPct,
        updatedAt: new Date().toISOString(),
      };
      store.upsertRuntimeNode(runtimeNode);
      store.addRuntimeNodeLog({
        id: randomUUID(),
        sessionId: sessionIdRef.current,
        tierId: node.id,
        role: node.role,
        label: node.label,
        status: node.status,
        currentAction: node.currentAction,
        progressPct: node.progressPct,
        timestamp: new Date().toISOString(),
      });
    }

    const history = nodeLogsRef.current.get(node.id) ?? [];
    const detail = [node.status, node.currentAction].filter(Boolean).join(' — ');
    nodeLogsRef.current.set(node.id, [...history.slice(-24), detail]);
    rebuildTree();
  }, [rebuildTree]);

  useEffect(() => {
    const dbPath = path.join(workspacePath, CASCADE_DB_FILE);
    const store = new MemoryStore(dbPath);
    storeRef.current = store;

    const identityRows = store.listIdentities().map((identity) => ({
      id: identity.id,
      name: identity.name,
      isDefault: identity.isDefault,
    }));
    setIdentities(identityRows);
    setCurrentIdentityId((current) => current ?? identityRows.find((identity) => identity.isDefault)?.id ?? identityRows[0]?.id);

    store.createSession({
      id: sessionIdRef.current,
      title: 'Cascade Session',
      createdAt: startedAtRef.current,
      updatedAt: startedAtRef.current,
      identityId: config.defaultIdentityId ?? identityRows.find((identity) => identity.isDefault)?.id ?? 'default',
      workspacePath,
      messages: [],
      metadata: {
        totalTokens: 0,
        totalCostUsd: 0,
        modelsUsed: [],
        toolsUsed: [],
        taskCount: 0,
      },
    });

    persistRuntimeSession('ACTIVE');

    cascadeRef.current = new Cascade(config);
    cascadeRef.current.init().catch((err: Error) => {
      dispatch({ type: 'SET_ERROR', error: `Init failed: ${err.message}` });
    });

    if (initialPrompt) {
      handleSubmit(initialPrompt);
    }

    return () => {
      persistSessionMetadata();
      persistRuntimeSession('COMPLETED');
      store.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSlashCommand = useCallback(async (trimmed: string) => {
    const result = await slashRef.current.handle(trimmed, {
      sessionId: sessionIdRef.current,
      workspacePath,
      onOutput: (text) => {
        if (!text) return;
        const timestamp = new Date().toISOString();
        dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'assistant', content: text, timestamp } });
        persistMessage('assistant', text, timestamp);
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
      onRollback: async () => {},
      onBranch: async () => {},
      onModelInfo: () => {
        const router = cascadeRef.current?.getRouter();
        if (!router) return 'No models loaded';
        return ['T1', 'T2', 'T3'].map((t) => {
          const m = router.getModelForTier(t as 'T1' | 'T2' | 'T3');
          return `${t}: ${m?.name ?? 'none'} (${m?.provider ?? '—'})`;
        }).join('\n');
      },
      onCostInfo: () => {
        dispatch({ type: 'TOGGLE_COST' });
        return '';
      },
      onCompact: async () => {},
      onStatus: () => formatRuntimeStatus([...treeNodesRef.current.values()], nodeLogsRef.current),
      onSessions: async () => {
        const store = storeRef.current;
        if (!store) return 'No session store loaded.';
        const sessions = store.listSessions(undefined, 12);
        if (!sessions.length) return 'No saved sessions yet.';
        return sessions.map((session, index) => (
          `${index + 1}. ${session.title}\n   id: ${session.id}\n   updated: ${new Date(session.updatedAt).toLocaleString()}\n   tokens: ${session.metadata.totalTokens} · cost: $${session.metadata.totalCostUsd.toFixed(4)}`
        )).join('\n\n');
      },
      onIdentity: async (args) => {
        if (!identities.length) return 'No identities available.';
        const target = args.join(' ').trim();
        if (!target) {
          return identities.map((identity) => {
            const marker = identity.id === currentIdentityId ? '→ current' : identity.isDefault ? 'default' : '';
            return `${identity.name} (${identity.id})${marker ? ` — ${marker}` : ''}`;
          }).join('\n');
        }
        const match = identities.find((identity) =>
          identity.id === target || identity.name.toLowerCase() === target.toLowerCase(),
        );
        if (!match) return `Unknown identity: ${target}`;
        setCurrentIdentityId(match.id);
        return `Active identity set to ${match.name}`;
      },
    });

    if (result.output) {
      const timestamp = new Date().toISOString();
      dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'assistant', content: result.output, timestamp } });
      persistMessage('assistant', result.output, timestamp);
    }
  }, [workspacePath, exit, state.messages, identities, currentIdentityId, persistMessage]);

  const handleSubmit = useCallback(async (userInput: string) => {
    const trimmed = userInput.trim();
    if (!trimmed) return;

    setInputHistory((prev) => [trimmed, ...prev.filter((item) => item !== trimmed)].slice(0, 100));
    setHistoryIndex(null);

    if (slashRef.current.isSlashCommand(trimmed)) {
      await handleSlashCommand(trimmed);
      return;
    }

    const timestamp = new Date().toISOString();

    dispatch({
      type: 'ADD_MESSAGE',
      message: { id: randomUUID(), role: 'user', content: trimmed, timestamp },
    });
    persistMessage('user', trimmed, timestamp);
    persistRuntimeSession('ACTIVE', trimmed);

    const cascade = cascadeRef.current;
    if (!cascade) return;

    treeNodesRef.current.clear();
    nodeLogsRef.current.clear();
    dispatch({ type: 'SET_TREE', tree: null });

    recordNodeEvent({
      tierId: 'router',
      role: 'T1',
      label: 'Determining Complexity',
      status: 'ACTIVE',
      currentAction: 'Analyzing recent conversation context',
    });

    const onRoot = ({ role }: { role: string }) => {
      treeNodesRef.current.delete('router');
      recordNodeEvent({
        tierId: role === 'T1' ? 'T1' : `${role.toLowerCase()}-root`,
        role: role as 'T1' | 'T2' | 'T3',
        label: role === 'T3' ? 'Direct Worker' : role === 'T2' ? 'Task Manager' : 'Administrator',
        status: 'ACTIVE',
      });
    };

    const onStream = ({ text }: { text: string }) => {
      if (!text) return;
      dispatch({ type: 'APPEND_STREAM', text });
    };

    const onTierStatus = (event: {
      tierId: string;
      role?: 'T1' | 'T2' | 'T3';
      parentId?: string;
      label?: string;
      status?: FlatTreeNode['status'];
      currentAction?: string;
      progressPct?: number;
    }) => {
      recordNodeEvent(event);
    };

    const onPlan = ({ plan }: { plan: { sections: Array<{ sectionTitle: string }> } }) => {
      const rootId = [...treeNodesRef.current.values()].find((node) => node.role === 'T1')?.id ?? 'T1';
      plan.sections.forEach((section, index) => {
        recordNodeEvent({
          tierId: `plan:t2:${index}`,
          role: 'T2',
          parentId: rootId,
          label: section.sectionTitle,
          status: 'IDLE',
          currentAction: 'Queued',
        });
      });
    };

    cascade.on('tier:root', onRoot);
    cascade.on('stream:token', onStream);
    cascade.on('tier:status', onTierStatus);
    cascade.on('plan', onPlan);

    try {
      const result = await cascade.run({
        prompt: trimmed,
        workspacePath,
        conversationHistory: toConversationHistory(state.messages),
        approvalCallback: async (req) => {
          dispatch({ type: 'SET_APPROVAL', request: req });
          return new Promise<boolean>((resolve) => {
            approvalResolverRef.current = resolve;
          });
        },
      });

      const finalTimestamp = new Date().toISOString();
      dispatch({ type: 'COMMIT_STREAM', finalText: result.output, timestamp: finalTimestamp });
      persistMessage('assistant', result.output, finalTimestamp);
      persistRuntimeSession('COMPLETED', trimmed);

      const stats = cascade.getRouter().getStats();
      dispatch({
        type: 'UPDATE_COST',
        tokens: stats.totalTokens,
        costUsd: stats.totalCostUsd,
        byProvider: stats.callsByProvider,
        byTier: stats.callsByTier,
      });
      persistSessionMetadata();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorTimestamp = new Date().toISOString();
      dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'error', content: msg, timestamp: errorTimestamp } });
      persistMessage('system', `ERROR: ${msg}`, errorTimestamp);
      persistRuntimeSession('FAILED', trimmed);
    } finally {
      cascade.removeListener('tier:root', onRoot);
      cascade.removeListener('stream:token', onStream);
      cascade.removeListener('tier:status', onTierStatus);
      cascade.removeListener('plan', onPlan);
    }
  }, [handleSlashCommand, persistMessage, persistRuntimeSession, recordNodeEvent, state.messages, workspacePath, persistSessionMetadata]);

  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') {
      exit();
      return;
    }

    if (key.tab && slashCompletions.length > 0) {
      const completion = slashCompletions[Math.min(slashIndex, slashCompletions.length - 1)] ?? slashCompletions[0];
      if (completion) {
        setInput(completion + ' ');
      }
      return;
    }

    if (key.upArrow) {
      if (slashCompletions.length > 0) {
        setSlashIndex((prev) => (prev <= 0 ? slashCompletions.length - 1 : prev - 1));
        return;
      }
      if (!inputHistory.length) return;
      const nextIndex = historyIndex === null ? 0 : Math.min(historyIndex + 1, inputHistory.length - 1);
      setHistoryIndex(nextIndex);
      setInput(inputHistory[nextIndex] ?? '');
      return;
    }

    if (key.downArrow) {
      if (slashCompletions.length > 0) {
        setSlashIndex((prev) => (prev + 1) % slashCompletions.length);
        return;
      }
      if (historyIndex === null) return;
      const nextIndex = historyIndex - 1;
      if (nextIndex < 0) {
        setHistoryIndex(null);
        setInput('');
        return;
      }
      setHistoryIndex(nextIndex);
      setInput(inputHistory[nextIndex] ?? '');
    }
  });

  const width = stdout?.columns ?? 100;
  const modelName = cascadeRef.current?.getRouter().getModelForTier('T1')?.name ?? 'Initializing...';
  const currentIdentity = identities.find((identity) => identity.id === currentIdentityId)?.name ?? 'Default';

  return (
    <Box flexDirection="column" width={width}>
      <Box borderStyle="double" borderColor={theme.colors.primary} paddingX={2} marginBottom={1}>
        <Text color={theme.colors.primary} bold>
          {'◈ CASCADE AI'} <Text color={theme.colors.muted}>— Multi-Tier Orchestration</Text>
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1}>
        {state.messages.length === 0 && (
          <Box marginY={1} paddingX={2}>
            <Text color={theme.colors.muted}>
              Type a message or <Text color={theme.colors.primary}>/help</Text> for commands.
            </Text>
          </Box>
        )}

        {state.messages.map((msg) => (
          <ChatMessage
            key={msg.id}
            role={msg.role}
            content={msg.content}
            theme={theme}
            timestamp={msg.timestamp}
          />
        ))}

        {state.isStreaming && state.streamBuffer && (
          <ChatMessage
            role="assistant"
            content={state.streamBuffer}
            theme={theme}
            isStreaming
          />
        )}

        {state.error && (
          <Box borderStyle="round" borderColor={theme.colors.error} paddingX={2} marginY={1}>
            <Text color={theme.colors.error}>{state.error}</Text>
          </Box>
        )}
      </Box>

      {state.agentTree && (
        <AgentTree root={state.agentTree} theme={theme} />
      )}

      {state.showCost && (
        <CostTracker
          theme={theme}
          totalTokens={state.totalTokens}
          totalCostUsd={state.totalCostUsd}
          callsByProvider={state.callsByProvider}
          callsByTier={state.callsByTier}
        />
      )}

      {state.approvalRequest && (
        <ApprovalPrompt
          request={state.approvalRequest}
          theme={theme}
          onDecision={(approved) => {
            dispatch({ type: 'SET_APPROVAL', request: null });
            approvalResolverRef.current?.(approved);
            approvalResolverRef.current = null;
          }}
        />
      )}

      {slashCompletions.length > 0 && (
        <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.border} paddingX={1} marginTop={1}>
          <Text color={theme.colors.muted}>Slash commands</Text>
          {slashCompletions.map((completion, index) => (
            <Text key={completion} color={index === slashIndex ? theme.colors.accent : theme.colors.foreground}>
              {index === slashIndex ? '› ' : '  '}{completion}
            </Text>
          ))}
        </Box>
      )}

      <Box
        borderStyle="round"
        borderColor={state.isStreaming ? theme.colors.accent : theme.colors.border}
        paddingX={2}
        marginTop={1}
      >
        <Text color={theme.colors.primary} bold>{'▸ '}</Text>
        <TextInput
          value={input}
          onChange={(val) => {
            setInput(val);
            setSlashIndex(0);
          }}
          onSubmit={(val) => {
            setInput('');
            setSlashIndex(0);
            handleSubmit(val);
          }}
          placeholder="Ask Cascade anything… (/help for commands)"
        />
      </Box>

      <StatusBar
        theme={theme}
        model={modelName}
        tokens={state.totalTokens}
        costUsd={state.totalCostUsd}
        sessionId={sessionIdRef.current}
        workspacePath={`${path.basename(workspacePath)} · ${currentIdentity}`}
        isStreaming={state.isStreaming}
      />
    </Box>
  );
}

function toConversationHistory(messages: Message[]): ConversationMessage[] {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({ role: message.role, content: message.content }));
}

function buildTreeFromFlatNodes(nodes: FlatTreeNode[]): TierNode | null {
  if (!nodes.length) return null;

  const cloned = new Map<string, FlatTreeNode>();
  for (const node of nodes) {
    cloned.set(node.id, { ...node, children: [] });
  }

  const roots: FlatTreeNode[] = [];

  for (const node of cloned.values()) {
    if (node.parentId && cloned.has(node.parentId) && node.parentId !== node.id) {
      cloned.get(node.parentId)?.children?.push(node);
    } else {
      roots.push(node);
    }
  }

  if (!roots.length) return null;
  roots.sort((a, b) => roleWeight(a.role) - roleWeight(b.role));
  const root = roots[0]!;
  if (roots.length > 1) {
    root.children = [...(root.children ?? []), ...roots.slice(1)];
  }
  return root;
}

function roleWeight(role: 'T1' | 'T2' | 'T3'): number {
  if (role === 'T1') return 0;
  if (role === 'T2') return 1;
  return 2;
}

function formatRuntimeStatus(nodes: FlatTreeNode[], nodeLogs: Map<string, string[]>): string {
  if (!nodes.length) return 'No active agent tree.';

  const active = nodes.filter((node) => node.status === 'ACTIVE');
  const completed = nodes.filter((node) => node.status === 'COMPLETED');
  const failed = nodes.filter((node) => node.status === 'FAILED' || node.status === 'ESCALATED');

  const lines = [
    `Active nodes: ${active.length}`,
    `Completed nodes: ${completed.length}`,
    `Failed/escalated nodes: ${failed.length}`,
    '',
  ];

  for (const node of [...active, ...failed, ...completed].slice(0, 12)) {
    lines.push(`[${node.role}] ${node.label} — ${node.status}`);
    if (node.currentAction) lines.push(`  action: ${node.currentAction}`);
    const recent = (nodeLogs.get(node.id) ?? []).slice(-3);
    for (const entry of recent) {
      if (entry) lines.push(`  · ${entry}`);
    }
  }

  return lines.join('\n');
}
