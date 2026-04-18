// ─────────────────────────────────────────────
//  Cascade AI — Interactive Model Picker
// ─────────────────────────────────────────────
//
//  Three-step picker, modelled after Claude Code's `/model` UX:
//
//    1. PROVIDER  — list of configured providers + "Auto"
//    2. TIER      — T1 / T2 / T3 (which tier to configure)
//    3. MODEL     — list of models for that provider + "Auto"
//
//  Both ↑ and ↓ arrows (plus j/k and Tab) move the cursor. Enter confirms,
//  Esc goes back one step (and closes the picker from the first step).
//  The previous build used ink-select-input which only responded to
//  the up arrow inside this component due to the REPL intercepting
//  key.downArrow for history navigation — we now roll our own key
//  handler so the picker is unambiguously the focused surface.

import React, { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ModelInfo, ProviderType, TierRole } from '../../../types.js';

export type ModelPickerSelection =
  | { kind: 'auto'; tier: TierRole }
  | { kind: 'pick'; tier: TierRole; modelId: string; provider: ProviderType };

interface Props {
  providers: ProviderType[];
  modelsByProvider: Map<ProviderType, ModelInfo[]>;
  /** When the user confirms a selection, the REPL persists it + updates the router. */
  onSelect?: (selection: ModelPickerSelection) => void;
  onClose: () => void;
}

type Step = 'PROVIDER' | 'TIER' | 'MODEL';

const TIERS: Array<{ id: TierRole; label: string; hint: string }> = [
  { id: 'T1', label: 'T1 — Administrator', hint: 'complex reasoning · runs once per task' },
  { id: 'T2', label: 'T2 — Manager',       hint: 'per-section planning · a few calls per task' },
  { id: 'T3', label: 'T3 — Worker',        hint: 'high volume · many parallel runs' },
];

interface MenuItem {
  label: string;
  sublabel?: string;
  value: string;
}

export const ModelsDisplay: React.FC<Props> = ({
  providers,
  modelsByProvider,
  onSelect,
  onClose,
}) => {
  const [step, setStep] = useState<Step>('PROVIDER');
  const [cursor, setCursor] = useState(0);
  const [picked, setPicked] = useState<{ provider?: ProviderType | 'auto'; tier?: TierRole }>({});

  // ── Step → menu items ──────────────────────────
  const providerItems = useMemo<MenuItem[]>(() => {
    const base: MenuItem[] = [
      { label: '◇ Auto', sublabel: 'let Cascade pick per tier — recommended', value: 'auto' },
    ];
    for (const p of providers) {
      const count = modelsByProvider.get(p)?.length ?? 0;
      base.push({ label: p, sublabel: `${count} model${count === 1 ? '' : 's'} discovered`, value: p });
    }
    return base;
  }, [providers, modelsByProvider]);

  const tierItems = useMemo<MenuItem[]>(
    () => TIERS.map(t => ({ label: t.label, sublabel: t.hint, value: t.id })),
    [],
  );

  const modelItems = useMemo<MenuItem[]>(() => {
    if (!picked.provider || picked.provider === 'auto') return [];
    const list = (modelsByProvider.get(picked.provider as ProviderType) ?? [])
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id));
    const items: MenuItem[] = [
      { label: '◇ Auto', sublabel: 'best available from this provider', value: '__auto__' },
    ];
    for (const m of list) {
      const ctx = m.contextWindow >= 1_000_000
        ? `${(m.contextWindow / 1_000_000).toFixed(1)}M ctx`
        : m.contextWindow >= 1_000
          ? `${Math.round(m.contextWindow / 1_000)}K ctx`
          : `${m.contextWindow} ctx`;
      items.push({ label: m.name, sublabel: `${m.id}  ·  ${ctx}`, value: m.id });
    }
    return items;
  }, [picked.provider, modelsByProvider]);

  const currentItems: MenuItem[] =
    step === 'PROVIDER' ? providerItems : step === 'TIER' ? tierItems : modelItems;

  // ── Input handling — fixes the "only ↑ works" regression ────────
  useInput((input, key) => {
    if (key.escape) {
      if (step === 'MODEL') { setStep('TIER'); setCursor(0); return; }
      if (step === 'TIER')  { setStep('PROVIDER'); setCursor(0); return; }
      onClose();
      return;
    }

    if (key.upArrow || input === 'k') {
      setCursor(c => (currentItems.length === 0 ? 0 : (c - 1 + currentItems.length) % currentItems.length));
      return;
    }
    if (key.downArrow || key.tab || input === 'j') {
      setCursor(c => (currentItems.length === 0 ? 0 : (c + 1) % currentItems.length));
      return;
    }
    // j/k handled above; numeric 1-9 jumps directly
    if (/^[1-9]$/.test(input)) {
      const idx = parseInt(input, 10) - 1;
      if (idx < currentItems.length) setCursor(idx);
      return;
    }

    if (key.return) {
      const selected = currentItems[cursor];
      if (!selected) return;

      if (step === 'PROVIDER') {
        if (selected.value === 'auto') {
          // Auto across all tiers — still ask which tier to clear the pin on
          setPicked({ provider: 'auto' });
          setStep('TIER');
          setCursor(0);
          return;
        }
        setPicked({ provider: selected.value as ProviderType });
        setStep('TIER');
        setCursor(0);
        return;
      }

      if (step === 'TIER') {
        const tier = selected.value as TierRole;
        if (picked.provider === 'auto') {
          onSelect?.({ kind: 'auto', tier });
          onClose();
          return;
        }
        setPicked(p => ({ ...p, tier }));
        setStep('MODEL');
        setCursor(0);
        return;
      }

      // step === 'MODEL'
      if (!picked.tier || !picked.provider || picked.provider === 'auto') {
        onClose();
        return;
      }
      if (selected.value === '__auto__') {
        onSelect?.({ kind: 'auto', tier: picked.tier });
      } else {
        onSelect?.({
          kind: 'pick',
          tier: picked.tier,
          provider: picked.provider as ProviderType,
          modelId: selected.value,
        });
      }
      onClose();
    }
  });

  // ── Presentation helpers ──────────────────────
  const title =
    step === 'PROVIDER' ? '◈ SELECT PROVIDER'
    : step === 'TIER'   ? `◈ APPLY ${picked.provider === 'auto' ? 'AUTO' : String(picked.provider).toUpperCase()} TO WHICH TIER?`
    :                      `◈ ${String(picked.provider).toUpperCase()} → SELECT MODEL FOR ${picked.tier}`;

  const breadcrumb =
    step === 'PROVIDER' ? 'Step 1 / 3'
    : step === 'TIER'   ? `Step 2 / 3  ·  provider: ${picked.provider}`
    :                     `Step 3 / 3  ·  ${picked.provider} → ${picked.tier}`;

  const PAGE_SIZE = 8;
  const viewStart = Math.max(0, Math.min(cursor - Math.floor(PAGE_SIZE / 2), currentItems.length - PAGE_SIZE));
  const visibleItems = currentItems.slice(viewStart, viewStart + PAGE_SIZE);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="cyan">{title}</Text>
        <Text color="gray">[Esc back  ·  Enter select]</Text>
      </Box>
      <Box marginBottom={1}>
        <Text color="gray">{breadcrumb}  ·  ↑/↓ navigate  ·  1–9 jump</Text>
      </Box>

      {currentItems.length === 0 ? (
        <Text italic color="yellow">No items to show.</Text>
      ) : (
        <Box flexDirection="column">
          {viewStart > 0 && <Text color="gray" dimColor>  ↑ {viewStart} more above</Text>}
          {visibleItems.map((item, i) => {
            const globalIdx = viewStart + i;
            const focused = globalIdx === cursor;
            return (
              <Box key={`${step}-${item.value}-${globalIdx}`} flexDirection="row">
                <Text color={focused ? 'green' : 'gray'}>{focused ? '❯ ' : '  '}</Text>
                <Box flexDirection="column">
                  <Text color={focused ? 'white' : 'gray'} bold={focused}>{item.label}</Text>
                  {item.sublabel && (
                    <Text color="gray" dimColor>{`    ${item.sublabel}`}</Text>
                  )}
                </Box>
              </Box>
            );
          })}
          {viewStart + PAGE_SIZE < currentItems.length && <Text color="gray" dimColor>  ↓ {currentItems.length - viewStart - PAGE_SIZE} more below</Text>}
        </Box>
      )}
    </Box>
  );
};
