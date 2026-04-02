// ─────────────────────────────────────────────
//  Cascade AI — Interactive REPL (ink)
// ─────────────────────────────────────────────

import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import TextInput from 'ink-text-input';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type {
  ApprovalRequest,
  CascadeConfig,
  Theme,
} from '../../types.js';
import { Cascade } from '../../core/cascade.js';
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
  | { type: 'COMMIT_STREAM'; finalText: string }
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
        timestamp: new Date().toISOString(),
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
  const slashRef = useRef(new SlashCommandRegistry());
  const approvalResolverRef = useRef<((approved: boolean) => void) | null>(null);

  // Initialize Cascade
  useEffect(() => {
    cascadeRef.current = new Cascade(config);
    cascadeRef.current.init().catch((err: Error) => {
      dispatch({ type: 'SET_ERROR', error: `Init failed: ${err.message}` });
    });

    if (initialPrompt) {
      handleSubmit(initialPrompt);
    }
  }, []);

  const handleSubmit = useCallback(async (userInput: string) => {
    const trimmed = userInput.trim();
    if (!trimmed) return;

    // Handle slash commands
    if (slashRef.current.isSlashCommand(trimmed)) {
      const result = await slashRef.current.handle(trimmed, {
        sessionId: 'repl',
        workspacePath,
        onOutput: (text) => dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'assistant', content: text, timestamp: new Date().toISOString() } }),
        onClear: () => dispatch({ type: 'CLEAR' }),
        onExit: () => exit(),
        onThemeChange: (name) => setTheme(getTheme(name)),
        onExport: async (fmt) => {
          // Export handled externally
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
      });
      if (result.output) {
        dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'assistant', content: result.output, timestamp: new Date().toISOString() } });
      }
      return;
    }

    // Add user message
    dispatch({
      type: 'ADD_MESSAGE',
      message: { id: randomUUID(), role: 'user', content: trimmed, timestamp: new Date().toISOString() },
    });

    const cascade = cascadeRef.current;
    if (!cascade) return;

    // Build T1 tree node
    const rootNode: TierNode = { id: 'T1', role: 'T1', label: 'Administrator', status: 'ACTIVE', children: [] };
    dispatch({ type: 'SET_TREE', tree: rootNode });

    try {
      let streamText = '';

      cascade.on('stream:token', ({ text }: { text: string }) => {
        if (text) {
          streamText += text;
          dispatch({ type: 'APPEND_STREAM', text });
        }
      });

      cascade.on('tier:status', ({ tierId, status }: { tierId: string; status: string }) => {
        // Update agent tree in real-time (simplified)
        dispatch({ type: 'SET_TREE', tree: { ...rootNode, status: status as TierNode['status'] } });
      });

      cascade.on('plan', ({ plan }: { plan: { sections: Array<{ sectionTitle: string }> } }) => {
        rootNode.children = plan.sections.map((s, i) => ({
          id: `T2_${i}`,
          role: 'T2' as const,
          label: s.sectionTitle,
          status: 'IDLE' as const,
          children: [],
        }));
        dispatch({ type: 'SET_TREE', tree: { ...rootNode } });
      });

      cascade.once('tool:approval-request', (request: ApprovalRequest) => {
        dispatch({ type: 'SET_APPROVAL', request });
      });

      const result = await cascade.run({
        prompt: trimmed,
        workspacePath,
        approvalCallback: async (req) => {
          dispatch({ type: 'SET_APPROVAL', request: req });
          return new Promise<boolean>((resolve) => {
            approvalResolverRef.current = resolve;
          });
        },
      });

      dispatch({ type: 'COMMIT_STREAM', finalText: result.output });
      dispatch({ type: 'SET_TREE', tree: { ...rootNode, status: 'COMPLETED' } });

      const stats = cascade.getRouter().getStats();
      dispatch({
        type: 'UPDATE_COST',
        tokens: stats.totalTokens,
        costUsd: stats.totalCostUsd,
        byProvider: stats.callsByProvider,
        byTier: stats.callsByTier,
      });

      cascade.removeAllListeners('stream:token');
      cascade.removeAllListeners('tier:status');
      cascade.removeAllListeners('plan');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatch({ type: 'ADD_MESSAGE', message: { id: randomUUID(), role: 'error', content: msg, timestamp: new Date().toISOString() } });
      dispatch({ type: 'SET_TREE', tree: { ...rootNode, status: 'FAILED' } });
    }
  }, [workspacePath, exit]);

  useInput((_input, key) => {
    if (key.ctrl && _input === 'c') exit();
  });

  const width = stdout?.columns ?? 100;
  const modelName = cascadeRef.current?.getRouter().getModelForTier('T1')?.name ?? 'Initializing...';

  return (
    <Box flexDirection="column" width={width}>
      {/* Header banner */}
      <Box borderStyle="double" borderColor={theme.colors.primary} paddingX={2} marginBottom={1}>
        <Text color={theme.colors.primary} bold>
          {'◈ CASCADE AI'} <Text color={theme.colors.muted}>— Multi-Tier Orchestration</Text>
        </Text>
      </Box>

      {/* Messages */}
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

        {/* Streaming output */}
        {state.isStreaming && state.streamBuffer && (
          <ChatMessage
            role="assistant"
            content={state.streamBuffer}
            theme={theme}
            isStreaming
          />
        )}

        {/* Error banner */}
        {state.error && (
          <Box borderStyle="round" borderColor={theme.colors.error} paddingX={2} marginY={1}>
            <Text color={theme.colors.error}>{state.error}</Text>
          </Box>
        )}
      </Box>

      {/* Agent tree */}
      {state.agentTree && (
        <AgentTree root={state.agentTree} theme={theme} />
      )}

      {/* Cost tracker overlay */}
      {state.showCost && (
        <CostTracker
          theme={theme}
          totalTokens={state.totalTokens}
          totalCostUsd={state.totalCostUsd}
          callsByProvider={state.callsByProvider}
          callsByTier={state.callsByTier}
        />
      )}

      {/* Approval prompt */}
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

      {/* Input area */}
      <Box
        borderStyle="round"
        borderColor={state.isStreaming ? theme.colors.accent : theme.colors.border}
        paddingX={2}
        marginTop={1}
      >
        <Text color={theme.colors.primary} bold>{'▸ '}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={(val) => {
            setInput('');
            handleSubmit(val);
          }}
          placeholder="Ask Cascade anything… (/help for commands)"
        />
      </Box>

      {/* Status bar */}
      <StatusBar
        theme={theme}
        model={modelName}
        tokens={state.totalTokens}
        costUsd={state.totalCostUsd}
        sessionId="repl"
        workspacePath={path.basename(workspacePath)}
        isStreaming={state.isStreaming}
      />
    </Box>
  );
}
