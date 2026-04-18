// ─────────────────────────────────────────────
//  Cascade AI — First-Run Setup Wizard (Ink TUI)
// ─────────────────────────────────────────────
//
//  Flow: PROVIDER_SELECT → API_KEYS → FETCH_MODELS → TIER_ASSIGN → SAVE
//
//  Supports multiple Azure deployments and multiple OpenAI-compatible
//  endpoints — each appears as a separate selectable entry in tier assignment.

import React, { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { Box, Text, useApp, useInput, render } from 'ink';
import SelectInput from 'ink-select-input';
import Spinner from 'ink-spinner';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CascadeConfigSchema } from '../../config/schema.js';
import { CASCADE_CONFIG_FILE, GLOBAL_CONFIG_DIR } from '../../constants.js';
import type { CascadeConfig } from '../../types.js';
import { SafeTextInput } from '../components/SafeTextInput.js';

// ── Types ─────────────────────────────────────

type ProviderType = 'anthropic' | 'openai' | 'gemini' | 'azure' | 'ollama' | 'openai-compatible';

interface ProviderEntry {
  id: string;
  type: ProviderType;
  label: string;          // display name
  apiKey?: string;
  baseUrl?: string;
  deploymentName?: string;
}

interface FetchedModel {
  id: string;
  name: string;
  providerLabel: string;
}

type WizardStep =
  | 'PROVIDER_SELECT'
  | 'API_KEYS'
  | 'FETCH_MODELS'
  | 'TIER_ASSIGN'
  | 'SAVE';

interface WizardState {
  step: WizardStep;
  selectedTypes: Set<ProviderType>;
  entries: ProviderEntry[];          // one per configured provider/deployment
  currentEntryIdx: number;           // which entry we are collecting keys for
  addingAnotherAzure: boolean;
  addingAnotherCompat: boolean;
  fetchedModels: FetchedModel[];
  fetchLog: string[];
  tierT1: string;                    // 'auto' or model id
  tierT2: string;
  tierT3: string;
  tierSelectFocus: 'T1' | 'T2' | 'T3';
  error: string | null;
}

type WizardAction =
  | { type: 'TOGGLE_PROVIDER'; provider: ProviderType }
  | { type: 'TOGGLE_ALL' }
  | { type: 'INVERT_SELECTION' }
  | { type: 'CONFIRM_PROVIDERS' }
  | { type: 'SET_ENTRY_FIELD'; field: keyof ProviderEntry; value: string }
  | { type: 'NEXT_ENTRY' }
  | { type: 'ADD_AZURE' }
  | { type: 'ADD_COMPAT' }
  | { type: 'SKIP_MORE' }
  | { type: 'SET_FETCH_LOG'; line: string }
  | { type: 'SET_MODELS'; models: FetchedModel[] }
  | { type: 'GO_FETCH' }
  | { type: 'SET_TIER'; tier: 'T1' | 'T2' | 'T3'; value: string }
  | { type: 'SET_TIER_FOCUS'; tier: 'T1' | 'T2' | 'T3' }
  | { type: 'GO_SAVE' }
  | { type: 'SET_ERROR'; error: string };

const PROVIDER_LABELS: Record<ProviderType, string> = {
  anthropic: 'Anthropic Claude',
  openai: 'OpenAI GPT',
  gemini: 'Google Gemini',
  azure: 'Azure OpenAI',
  ollama: 'Ollama (local)',
  'openai-compatible': 'OpenAI-Compatible',
};

const providerOrder: ProviderType[] = ['anthropic', 'openai', 'gemini', 'azure', 'ollama', 'openai-compatible'];

function buildInitialEntries(types: Set<ProviderType>): ProviderEntry[] {
  return [...types].map(type => ({
    id: randomUUID(),
    type,
    label: type === 'azure' ? 'Azure deployment 1'
      : type === 'openai-compatible' ? 'Custom endpoint 1'
      : PROVIDER_LABELS[type],
  }));
}

function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case 'TOGGLE_PROVIDER': {
      const next = new Set(state.selectedTypes);
      if (next.has(action.provider)) next.delete(action.provider);
      else next.add(action.provider);
      return { ...state, selectedTypes: next };
    }
    case 'TOGGLE_ALL': {
      const allSelected = state.selectedTypes.size === providerOrder.length;
      return { ...state, selectedTypes: allSelected ? new Set() : new Set(providerOrder) };
    }
    case 'INVERT_SELECTION': {
      const next = new Set<ProviderType>();
      providerOrder.forEach(p => {
        if (!state.selectedTypes.has(p)) next.add(p);
      });
      return { ...state, selectedTypes: next };
    }
    case 'CONFIRM_PROVIDERS': {
      const entries = buildInitialEntries(state.selectedTypes);
      return { ...state, entries, currentEntryIdx: 0, step: 'API_KEYS' };
    }
    case 'SET_ENTRY_FIELD': {
      const updated = [...state.entries];
      updated[state.currentEntryIdx] = {
        ...updated[state.currentEntryIdx]!,
        [action.field]: action.value,
      };
      return { ...state, entries: updated };
    }
    case 'NEXT_ENTRY': {
      const next = state.currentEntryIdx + 1;
      if (next >= state.entries.length) {
        return { ...state, step: 'FETCH_MODELS', currentEntryIdx: 0 };
      }
      return { ...state, currentEntryIdx: next };
    }
    case 'ADD_AZURE': {
      const newEntry: ProviderEntry = {
        id: randomUUID(),
        type: 'azure',
        label: `Azure deployment ${state.entries.filter(e => e.type === 'azure').length + 1}`,
      };
      return {
        ...state,
        entries: [...state.entries, newEntry],
        currentEntryIdx: state.entries.length,
        addingAnotherAzure: false,
      };
    }
    case 'ADD_COMPAT': {
      const newEntry: ProviderEntry = {
        id: randomUUID(),
        type: 'openai-compatible',
        label: `Custom endpoint ${state.entries.filter(e => e.type === 'openai-compatible').length + 1}`,
      };
      return {
        ...state,
        entries: [...state.entries, newEntry],
        currentEntryIdx: state.entries.length,
        addingAnotherCompat: false,
      };
    }
    case 'SKIP_MORE':
      return { ...state, addingAnotherAzure: false, addingAnotherCompat: false, step: 'FETCH_MODELS', currentEntryIdx: 0 };
    case 'GO_FETCH':
      return { ...state, step: 'FETCH_MODELS', fetchLog: [], fetchedModels: [] };
    case 'SET_FETCH_LOG':
      return { ...state, fetchLog: [...state.fetchLog, action.line] };
    case 'SET_MODELS':
      return { ...state, fetchedModels: action.models, step: 'TIER_ASSIGN' };
    case 'SET_TIER':
      return {
        ...state,
        tierT1: action.tier === 'T1' ? action.value : state.tierT1,
        tierT2: action.tier === 'T2' ? action.value : state.tierT2,
        tierT3: action.tier === 'T3' ? action.value : state.tierT3,
      };
    case 'SET_TIER_FOCUS':
      return { ...state, tierSelectFocus: action.tier };
    case 'GO_SAVE':
      return { ...state, step: 'SAVE' };
    case 'SET_ERROR':
      return { ...state, error: action.error };
    default:
      return state;
  }
}

// ── Main Wizard Component ─────────────────────

interface SetupWizardProps {
  workspacePath: string;
  onComplete: (config: CascadeConfig) => void;
}

export function SetupWizard({ workspacePath, onComplete }: SetupWizardProps): React.ReactElement {
  const { exit } = useApp();

  const [state, dispatch] = useReducer(wizardReducer, {
    step: 'PROVIDER_SELECT',
    selectedTypes: new Set<ProviderType>(),
    entries: [],
    currentEntryIdx: 0,
    addingAnotherAzure: false,
    addingAnotherCompat: false,
    fetchedModels: [],
    fetchLog: [],
    tierT1: 'auto',
    tierT2: 'auto',
    tierT3: 'auto',
    tierSelectFocus: 'T1',
    error: null,
  });

  const [providerCursor, setProviderCursor] = useState(0);
  const [fieldBuffer, setFieldBuffer] = useState('');
  const [fieldStage, setFieldStage] = useState<'apiKey' | 'baseUrl' | 'deploymentName' | 'label' | 'askMore'>('apiKey');
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // ── Step: FETCH_MODELS ───────────────────────
  useEffect(() => {
    if (state.step !== 'FETCH_MODELS') return;

    const run = async () => {
      const models: FetchedModel[] = [];
      // Always include "auto"
      for (const entry of state.entries) {
        try {
          dispatchRef.current({ type: 'SET_FETCH_LOG', line: `  ⠋ ${entry.label} — connecting...` });
          // Build a minimal provider config to call listModels
          const { type, apiKey, baseUrl, deploymentName } = entry;
          if (type === 'ollama') {
            const { OllamaProvider } = await import('../../providers/ollama.js');
            const dummyModel = { id: 'dummy', name: 'dummy', provider: type as never, contextWindow: 0, isVisionCapable: false, inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 0, supportsStreaming: false, isLocal: true };
            const p = new OllamaProvider({ type, baseUrl }, dummyModel);
            const fetched = await p.listModels();
            fetched.forEach(m => models.push({ id: m.id, name: m.name, providerLabel: entry.label }));
            dispatchRef.current({ type: 'SET_FETCH_LOG', line: `  ✔ ${entry.label} — ${fetched.length} models` });
          } else if (type === 'anthropic') {
            const { AnthropicProvider } = await import('../../providers/anthropic.js');
            const dummyModel = { id: 'dummy', name: 'dummy', provider: type as never, contextWindow: 0, isVisionCapable: false, inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 0, supportsStreaming: false, isLocal: false };
            const p = new AnthropicProvider({ type, apiKey }, dummyModel);
            const fetched = await p.listModels();
            fetched.forEach(m => models.push({ id: m.id, name: m.name, providerLabel: entry.label }));
            dispatchRef.current({ type: 'SET_FETCH_LOG', line: `  ✔ ${entry.label} — ${fetched.length} models` });
          } else if (type === 'openai' || type === 'openai-compatible') {
            const { OpenAIProvider } = await import('../../providers/openai.js');
            const { OpenAICompatibleProvider } = await import('../../providers/openai-compatible.js');
            const dummyModel = { id: 'dummy', name: 'dummy', provider: type as never, contextWindow: 0, isVisionCapable: false, inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 0, supportsStreaming: false, isLocal: false };
            const cfg = { type, apiKey, ...(baseUrl ? { baseUrl } : {}) };
            const p = type === 'openai' ? new OpenAIProvider(cfg as never, dummyModel) : new OpenAICompatibleProvider(cfg as never, dummyModel);
            const fetched = await p.listModels();
            fetched.forEach(m => models.push({ id: m.id, name: m.name, providerLabel: entry.label }));
            dispatchRef.current({ type: 'SET_FETCH_LOG', line: `  ✔ ${entry.label} — ${fetched.length} models` });
          } else if (type === 'gemini') {
            const { GeminiProvider } = await import('../../providers/gemini.js');
            const dummyModel = { id: 'dummy', name: 'dummy', provider: type as never, contextWindow: 0, isVisionCapable: false, inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 0, supportsStreaming: false, isLocal: false };
            const p = new GeminiProvider({ type, apiKey }, dummyModel);
            const fetched = await p.listModels();
            fetched.forEach(m => models.push({ id: m.id, name: m.name, providerLabel: entry.label }));
            dispatchRef.current({ type: 'SET_FETCH_LOG', line: `  ✔ ${entry.label} — ${fetched.length} models` });
          } else if (type === 'azure') {
            const { AzureOpenAIProvider } = await import('../../providers/azure.js');
            const dummyModel = { id: 'dummy', name: 'dummy', provider: type as never, contextWindow: 0, isVisionCapable: false, inputCostPer1kTokens: 0, outputCostPer1kTokens: 0, maxOutputTokens: 0, supportsStreaming: false, isLocal: false };
            const p = new AzureOpenAIProvider({ type, apiKey, baseUrl, deploymentName }, dummyModel);
            const fetched = await p.listModels();
            fetched.forEach(m => models.push({ id: m.id, name: m.name, providerLabel: entry.label }));
            dispatchRef.current({ type: 'SET_FETCH_LOG', line: `  ✔ ${entry.label} — ${fetched.length} models` });
          }
        } catch (err) {
          dispatchRef.current({ type: 'SET_FETCH_LOG', line: `  ✘ ${entry.label} — ${err instanceof Error ? err.message : 'failed'}` });
        }
      }
      dispatchRef.current({ type: 'SET_MODELS', models });
    };

    run();
  }, [state.step, state.entries]);

  // ── Step: SAVE ───────────────────────────────
  useEffect(() => {
    if (state.step !== 'SAVE') return;

    const run = async () => {
      try {
        const providers = state.entries.map(e => ({
          type: e.type,
          ...(e.apiKey ? { apiKey: e.apiKey } : {}),
          ...(e.baseUrl ? { baseUrl: e.baseUrl } : {}),
          ...(e.deploymentName ? { deploymentName: e.deploymentName } : {}),
        }));

        const models: Record<string, string> = {};
        if (state.tierT1 !== 'auto') models['t1'] = state.tierT1;
        if (state.tierT2 !== 'auto') models['t2'] = state.tierT2;
        if (state.tierT3 !== 'auto') models['t3'] = state.tierT3;

        const rawConfig = { providers, ...(Object.keys(models).length ? { models } : {}) };
        const config = CascadeConfigSchema.parse(rawConfig);

        const configDir = path.join(workspacePath, '.cascade');
        await fs.mkdir(configDir, { recursive: true });
        const configPath = path.join(workspacePath, CASCADE_CONFIG_FILE);
        await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');

        onComplete(config as CascadeConfig);
        exit();
      } catch (err) {
        dispatchRef.current({ type: 'SET_ERROR', error: err instanceof Error ? err.message : String(err) });
      }
    };

    run();
  }, [state.step, state.entries, state.tierT1, state.tierT2, state.tierT3, workspacePath, onComplete, exit]);

  // ── Input handling ────────────────────────────
  useInput((_input, key) => {
    if (state.step === 'PROVIDER_SELECT') {
      if (key.upArrow) setProviderCursor(p => Math.max(0, p - 1));
      if (key.downArrow) setProviderCursor(p => Math.min(providerOrder.length - 1, p + 1));
      if (_input === ' ') dispatch({ type: 'TOGGLE_PROVIDER', provider: providerOrder[providerCursor]! });
      if (_input === 'a') dispatch({ type: 'TOGGLE_ALL' });
      if (_input === 'i') dispatch({ type: 'INVERT_SELECTION' });
      if (key.return) {
        if (state.selectedTypes.size === 0) return;
        dispatch({ type: 'CONFIRM_PROVIDERS' });
        setFieldStage('apiKey');
        setFieldBuffer('');
      }
    }
    if (state.step === 'TIER_ASSIGN') {
      if (key.tab || key.downArrow) {
        const order: Array<'T1' | 'T2' | 'T3'> = ['T1', 'T2', 'T3'];
        const idx = order.indexOf(state.tierSelectFocus);
        dispatch({ type: 'SET_TIER_FOCUS', tier: order[(idx + 1) % 3]! });
      }
      if (key.return) dispatch({ type: 'GO_SAVE' });
    }
  });

  // ── Current entry being configured ──────────
  const currentEntry = state.entries[state.currentEntryIdx];

  const handleFieldSubmit = useCallback((val: string) => {
    if (!currentEntry) return;

    if (currentEntry.type === 'azure') {
      if (fieldStage === 'deploymentName') {
        dispatch({ type: 'SET_ENTRY_FIELD', field: 'deploymentName', value: val });
        setFieldBuffer('');
        setFieldStage('baseUrl');
      } else if (fieldStage === 'baseUrl') {
        dispatch({ type: 'SET_ENTRY_FIELD', field: 'baseUrl', value: val });
        setFieldBuffer('');
        setFieldStage('apiKey');
      } else if (fieldStage === 'apiKey') {
        dispatch({ type: 'SET_ENTRY_FIELD', field: 'apiKey', value: val });
        setFieldBuffer('');
        setFieldStage('askMore');
      }
    } else if (currentEntry.type === 'openai-compatible') {
      if (fieldStage === 'label') {
        dispatch({ type: 'SET_ENTRY_FIELD', field: 'label', value: val || currentEntry.label });
        setFieldBuffer('');
        setFieldStage('baseUrl');
      } else if (fieldStage === 'baseUrl') {
        dispatch({ type: 'SET_ENTRY_FIELD', field: 'baseUrl', value: val });
        setFieldBuffer('');
        setFieldStage('apiKey');
      } else if (fieldStage === 'apiKey') {
        dispatch({ type: 'SET_ENTRY_FIELD', field: 'apiKey', value: val });
        setFieldBuffer('');
        setFieldStage('askMore');
      }
    } else if (currentEntry.type === 'ollama') {
      dispatch({ type: 'SET_ENTRY_FIELD', field: 'baseUrl', value: val || 'http://localhost:11434' });
      setFieldBuffer('');
      dispatch({ type: 'NEXT_ENTRY' });
      setFieldStage('apiKey');
    } else {
      // anthropic / openai / gemini — just need apiKey
      dispatch({ type: 'SET_ENTRY_FIELD', field: 'apiKey', value: val });
      setFieldBuffer('');
      dispatch({ type: 'NEXT_ENTRY' });
      setFieldStage('apiKey');
    }
  }, [currentEntry, fieldStage]);

  // ── Render ────────────────────────────────────

  if (state.step === 'PROVIDER_SELECT') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text color="magenta" bold>? </Text>
          <Text bold>Which providers do you want to configure?</Text>
        </Box>
        <Box flexDirection="column">
          {providerOrder.map((p, i) => {
            const selected = state.selectedTypes.has(p);
            const focused = i === providerCursor;
            return (
              <Box key={p}>
                <Text color={focused ? 'magenta' : 'white'}>{focused ? '❯ ' : '  '}</Text>
                <Text color={selected ? 'green' : 'white'}>{selected ? '◉ ' : '◯ '}</Text>
                <Text color={focused ? 'magenta' : (selected ? 'white' : 'gray')}>{PROVIDER_LABELS[p]}</Text>
                {p === 'azure' && <Text dimColor>  — multiple deployments supported</Text>}
                {p === 'openai-compatible' && <Text dimColor>  — Groq, Together, custom</Text>}
                {p === 'ollama' && <Text dimColor>  — no API key needed</Text>}
              </Box>
            );
          })}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>(Press &lt;space&gt; to select, &lt;a&gt; to toggle all, &lt;i&gt; to invert selection, and &lt;enter&gt; to proceed)</Text>
        </Box>
        {state.error && <Text color="red">{state.error}</Text>}
      </Box>
    );
  }

  if (state.step === 'API_KEYS' && currentEntry) {
    const isAzure = currentEntry.type === 'azure';
    const isCompat = currentEntry.type === 'openai-compatible';
    const isOllama = currentEntry.type === 'ollama';

    if (fieldStage === 'askMore') {
      // After completing an Azure or compat entry, ask if they want another
      return (
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Box marginBottom={1}>
            <Text color="magenta" bold>? </Text>
            <Text bold>{isAzure ? 'Add another Azure deployment? (y/n)' : 'Add another custom endpoint? (y/n)'}</Text>
          </Box>
          <Box>
            <SelectInput
              items={[
                { label: 'Yes — add another', value: 'yes' },
                { label: 'No — continue', value: 'no' },
              ]}
              indicatorComponent={({ isSelected }) => <Text color="magenta">{isSelected ? '❯ ' : '  '}</Text>}
              itemComponent={({ isSelected, label }) => <Text color={isSelected ? 'magenta' : 'white'}>{label}</Text>}
              onSelect={(item) => {
                if (item.value === 'yes') {
                  if (isAzure) dispatch({ type: 'ADD_AZURE' });
                  else dispatch({ type: 'ADD_COMPAT' });
                  setFieldStage(isAzure ? 'deploymentName' : 'label');
                  setFieldBuffer('');
                } else {
                  dispatch({ type: 'NEXT_ENTRY' });
                  setFieldStage('apiKey');
                  setFieldBuffer('');
                }
              }}
            />
          </Box>
        </Box>
      );
    }

    const prompt =
      isAzure && fieldStage === 'deploymentName' ? `Azure deployment name (${currentEntry.label})` :
      isAzure && fieldStage === 'baseUrl' ? `Azure endpoint URL` :
      isCompat && fieldStage === 'label' ? `Name for this endpoint (e.g. Groq)` :
      isCompat && fieldStage === 'baseUrl' ? `Base URL (e.g. https://api.groq.com/openai/v1)` :
      isOllama ? `Ollama URL (Enter for http://localhost:11434)` :
      `${currentEntry.label} API Key`;

    const isMasked = fieldStage === 'apiKey';

    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text color="magenta" bold>? </Text>
          <Text bold>{prompt}</Text>
        </Box>
        <Box>
          <Text color="magenta">❯ </Text>
          <SafeTextInput
            value={fieldBuffer}
            onChange={setFieldBuffer}
            onSubmit={handleFieldSubmit}
            {...(isMasked ? { mask: '*' } : {})}
            placeholder={isOllama ? 'http://localhost:11434' : ''}
          />
        </Box>
        {isMasked && (
          <Box marginTop={1}>
            <Text dimColor>
              Tip: Ctrl+V pastes from clipboard. Most terminals also support right-click paste.
            </Text>
          </Box>
        )}
        {state.error && <Text color="red">{state.error}</Text>}
      </Box>
    );
  }

  if (state.step === 'FETCH_MODELS') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text color="magenta" bold>? </Text>
          <Text bold>Connecting to providers and fetching models...</Text>
        </Box>
        <Box flexDirection="column">
          {state.fetchLog.map((line, i) => <Text key={i}>{line}</Text>)}
          {state.fetchedModels.length === 0 && (
            <Box>
              <Spinner type="dots" />
            </Box>
          )}
        </Box>
      </Box>
    );
  }

  if (state.step === 'TIER_ASSIGN') {
    const modelOptions = [
      { label: 'Auto — let Cascade choose best available', value: 'auto' },
      ...state.fetchedModels.map(m => ({
        label: `${m.name}  [${m.providerLabel}]`,
        value: m.id,
      })),
    ];

    const tierLabel = (tier: 'T1' | 'T2' | 'T3', hint: string) => {
      const isFocused = state.tierSelectFocus === tier;
      const current = tier === 'T1' ? state.tierT1 : tier === 'T2' ? state.tierT2 : state.tierT3;
      
      if (!isFocused) {
        return (
          <Box key={tier}>
            <Text color="green" bold>✔ </Text>
            <Text bold>{tier} {hint}: </Text>
            <Text color="magenta">{current === 'auto' ? 'Auto — let Cascade choose best available' : state.fetchedModels.find(m => m.id === current)?.name || current}</Text>
          </Box>
        );
      }
      
      return (
        <Box flexDirection="column" marginBottom={1} key={tier}>
          <Box>
            <Text color="magenta" bold>? </Text>
            <Text bold>{tier} {hint}: </Text>
          </Box>
          <Box>
            <SelectInput
              items={modelOptions}
              onSelect={(item) => dispatch({ type: 'SET_TIER', tier, value: item.value })}
              indicatorComponent={({ isSelected }) => <Text color="magenta">{isSelected ? '❯ ' : '  '}</Text>}
              itemComponent={({ isSelected, label }) => <Text color={isSelected ? 'magenta' : 'white'}>{label}</Text>}
            />
          </Box>
        </Box>
      );
    };

    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box flexDirection="column">
          {tierLabel('T1', '(Administrator — complex reasoning, runs once per task)')}
          {tierLabel('T2', '(Manager — runs per section)')}
          {tierLabel('T3', '(Worker — high volume, many parallel runs)')}
        </Box>
        <Box marginTop={1}>
          <Text dimColor>(Tab/Arrow Down to skip tier, Enter to select or save)</Text>
        </Box>
        {state.error && <Text color="red">{state.error}</Text>}
      </Box>
    );
  }

  if (state.step === 'SAVE') {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box>
          <Text color="green" bold>✔ </Text>
          <Text bold>Setup complete!</Text>
        </Box>
        <Box marginTop={1}>
          <Spinner type="dots" />
          <Text> Writing .cascade/config.json...</Text>
        </Box>
        {state.error && <Text color="red">Error: {state.error}</Text>}
      </Box>
    );
  }

  return <Box />;
}

// ── Exported runner ───────────────────────────

export async function runSetupWizard(workspacePath: string): Promise<CascadeConfig> {
  // Prominent telemetry notice — shown on every first-run setup so users
  // understand the default is OFF and they can revisit the decision later.
  printTelemetryBanner();
  return new Promise((resolve) => {
    const { unmount } = render(
      React.createElement(SetupWizard, {
        workspacePath,
        onComplete: (config) => {
          unmount();
          resolve(config);
        },
      }),
      { exitOnCtrlC: true },
    );
  });
}

function printTelemetryBanner(): void {
  // Plain console output (outside Ink) so it survives re-mounts.
  // eslint-disable-next-line no-console
  console.log();
  // eslint-disable-next-line no-console
  console.log('  ┌──────────────────────────────────────────────────────────────┐');
  // eslint-disable-next-line no-console
  console.log('  │  Telemetry: OFF by default.                                  │');
  // eslint-disable-next-line no-console
  console.log('  │  Toggle anytime with:  cascade telemetry on | off | status   │');
  // eslint-disable-next-line no-console
  console.log('  │  Anonymous session metadata only — never prompts or output.  │');
  // eslint-disable-next-line no-console
  console.log('  └──────────────────────────────────────────────────────────────┘');
  // eslint-disable-next-line no-console
  console.log();
}
