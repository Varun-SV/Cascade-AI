// ─────────────────────────────────────────────
//  Cascade AI — /settings
// ─────────────────────────────────────────────
//
//    ◆ Settings   ‹ Autonomy & approvals ›  3/8
//    ▸ Mode                              auto
//      Show me the plan first            never
//      Wait for my answer                10 min
//    auto: Cascade works on its own and asks only before…
//    ✓ Mode: auto.
//    ↑↓ choose · ←→ section · ↵ change · / search · esc close

import React, { useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { CascadeConfig, Theme } from '../../../types.js';
import { SECTIONS, SETTINGS, display, nextValue, parseValue, type SectionId, type SettingItem } from '../../settings/spec.js';

interface SettingsPanelProps {
  /**
   * Whether it reads the keyboard. Off while a tool approval waits: the two
   * once both listened, and a `y` or `a` typed into a setting also allowed
   * the pending call.
   */
  active?: boolean;
  config: CascadeConfig;
  theme: Theme;
  initialSection?: SectionId;
  initialSearch?: string;
  /** Applies a value and says what happened. */
  onChange: (item: SettingItem, value: unknown) => Promise<string> | string;
  /** Carries out an action (sign in, sync…) and says what happened; `progress` shows a step on the way (a sign-in code). */
  onAction: (item: SettingItem, passphrase: string | undefined, progress: (text: string) => void) => Promise<string> | string;
  onClose: () => void;
}

type Editing = { item: SettingItem; buffer: string; passphrase: boolean } | null;

export function SettingsPanel({ config, theme, initialSection, initialSearch, onChange, onAction, onClose, active = true }: SettingsPanelProps): React.ReactElement {
  const [section, setSection] = useState(Math.max(0, SECTIONS.findIndex((s) => s.id === initialSection)));
  const [row, setRow] = useState(0);
  const [search, setSearch] = useState<string | null>(initialSearch ?? null);
  const [editing, setEditingState] = useState<Editing>(null);
  // Read by the key handler, which can run again before a redraw: Enter in the
  // same burst as the last characters typed (a pasted passphrase) must see them.
  const editingRef = useRef<Editing>(null);
  const setEditing = (next: Editing | ((e: Editing) => Editing)): void => {
    editingRef.current = typeof next === 'function' ? next(editingRef.current) : next;
    setEditingState(editingRef.current);
  };
  const [status, setStatus] = useState<{ text: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  // Values are read from the config, which the REPL changes in place: a tick redraws.
  const [, setTick] = useState(0);

  const items = useMemo(() => {
    if (search !== null && search.trim()) {
      const q = search.trim().toLowerCase();
      return SETTINGS.filter((s) => `${s.label} ${s.id} ${s.help} ${SECTIONS.find((x) => x.id === s.section)?.title ?? ''}`.toLowerCase().includes(q));
    }
    return SETTINGS.filter((s) => s.section === SECTIONS[section]!.id);
  }, [section, search]);
  const current = items[Math.min(row, Math.max(0, items.length - 1))];

  const report = async (work: Promise<string> | string, ok = true): Promise<void> => {
    setBusy(true);
    try {
      const text = await work;
      setStatus({ text, ok: ok && !/^(couldn'?t|could not|cancelled|sign in first)/i.test(text) });
    } catch (err) {
      setStatus({ text: err instanceof Error ? err.message : String(err), ok: false });
    } finally {
      setBusy(false);
      setProgress(null);
      setTick((t) => t + 1);
    }
  };

  const commit = (item: SettingItem, raw: string): void => {
    const parsed = parseValue(item, raw);
    if (!parsed.ok) { setStatus({ text: parsed.error, ok: false }); return; }
    void report(onChange(item, parsed.value));
  };

  const choose = (item: SettingItem): void => {
    switch (item.kind) {
      case 'toggle': case 'choice':
        void report(onChange(item, nextValue(item, config)));
        return;
      case 'action':
        if (item.passphrase) setEditing({ item, buffer: '', passphrase: true });
        else void report(onAction(item, undefined, setProgress));
        return;
      default: {
        const v = item.get?.(config);
        // A key is never put back on screen to edit: it is typed afresh.
        setEditing({ item, buffer: item.kind === 'secret' || v === undefined || v === null ? '' : String(v), passphrase: false });
      }
    }
  };

  useInput((input, key) => {
    if (busy) return;
    const editing = editingRef.current;
    if (editing) {
      if (key.escape) { setEditing(null); setStatus(null); return; }
      if (key.return) {
        const e = editing;
        setEditing(null);
        if (e.passphrase) void report(onAction(e.item, e.buffer, setProgress));
        else commit(e.item, e.buffer);
        return;
      }
      if (key.backspace || key.delete) { setEditing((e) => (e ? { ...e, buffer: e.buffer.slice(0, -1) } : e)); return; }
      // Updated from the latest state: keys that arrive before a redraw (fast typing, a paste) all count.
      if (input && !key.ctrl && !key.meta) setEditing((e) => (e ? { ...e, buffer: e.buffer + input.replace(/[\r\n]/g, '') } : e));
      return;
    }
    if (search !== null) {
      if (key.escape) { setSearch(null); setRow(0); return; }
      if (key.upArrow) { setRow((r) => Math.max(0, r - 1)); return; }
      if (key.downArrow) { setRow((r) => Math.min(items.length - 1, r + 1)); return; }
      if (key.return) { if (current) choose(current); return; }
      if (key.backspace || key.delete) { setSearch((q) => (q ?? '').slice(0, -1)); setRow(0); return; }
      if (input && !key.ctrl && !key.meta && !key.tab) { setSearch((q) => (q ?? '') + input); setRow(0); }
      return;
    }
    if (key.escape || input === 'q') { onClose(); return; }
    if (input === '/') { setSearch(''); setRow(0); setStatus(null); return; }
    if (key.upArrow || input === 'k') { setRow((r) => Math.max(0, r - 1)); return; }
    if (key.downArrow || input === 'j') { setRow((r) => Math.min(items.length - 1, r + 1)); return; }
    if (key.leftArrow || (key.shift && key.tab)) { setSection((s) => (s + SECTIONS.length - 1) % SECTIONS.length); setRow(0); setStatus(null); return; }
    if (key.rightArrow || key.tab) { setSection((s) => (s + 1) % SECTIONS.length); setRow(0); setStatus(null); return; }
    if (key.return || input === ' ') { if (current) choose(current); return; }
    if (/^[1-8]$/.test(input)) { setSection(Number(input) - 1); setRow(0); setStatus(null); }
  }, { isActive: active });

  const labelWidth = Math.max(28, ...items.map((i) => i.label.length + 2));
  const title = search !== null ? `search: ${search}${editing ? '' : '▌'}` : `‹ ${SECTIONS[section]!.title} ›`;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.colors.primary} paddingX={1} marginY={1}>
      <Text>
        <Text color={theme.colors.primary} bold>◆ Settings   </Text>
        <Text color={theme.colors.foreground} bold>{title}</Text>
        {search === null && <Text color={theme.colors.muted}>  {section + 1}/{SECTIONS.length}</Text>}
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {items.length === 0 && <Text color={theme.colors.muted}>  Nothing matches. Esc to go back.</Text>}
        {items.map((item, i) => {
          const selected = item === current;
          const value = editing?.item === item
            ? `${editing.passphrase || item.kind === 'secret' ? '•'.repeat(editing.buffer.length) : editing.buffer}▌`
            : item.kind === 'action' ? '↵' : display(item, config);
          return (
            <Text key={item.id} wrap="truncate-end">
              <Text color={selected ? theme.colors.primary : theme.colors.muted}>{selected ? '▸ ' : '  '}</Text>
              <Text color={selected ? theme.colors.foreground : theme.colors.muted} bold={selected}>{item.label.padEnd(labelWidth)}</Text>
              <Text color={item.kind === 'action' ? theme.colors.secondary : theme.colors.accent}>{value}</Text>
              {item.applies === 'restart' && <Text color={theme.colors.muted}>  ↻</Text>}
              {search !== null && <Text color={theme.colors.muted}>  · {SECTIONS.find((s) => s.id === item.section)?.title}</Text>}
            </Text>
          );
        })}
      </Box>
      {current && (
        <Box marginTop={1}>
          <Text color={theme.colors.muted} wrap="wrap">
            {editing?.passphrase ? 'Type your sync passphrase and press Enter (it is never sent or stored).'
              : editing ? `${current.help}  Enter to save, Esc to cancel${current.kind === 'number' || current.kind === 'text' || current.kind === 'secret' ? ', empty to clear' : ''}.`
                : current.help}
          </Text>
        </Box>
      )}
      {!active && <Text color={theme.colors.warning}>  Paused: answer the question below first.</Text>}
      {busy && <Text color={theme.colors.warning} wrap="wrap">  {progress ?? 'Working…'}</Text>}
      {!busy && status && <Text color={status.ok ? theme.colors.success : theme.colors.error} wrap="wrap">{status.ok ? '✓ ' : '✗ '}{status.text.replace(/^✓\s*/, '')}</Text>}
      <Box marginTop={1}>
        <Text color={theme.colors.muted}>
          ↑↓ choose · ←→ section · ↵ change · / search · esc close   ↻ applies on restart · saved for this project, keys for every project
        </Text>
      </Box>
    </Box>
  );
}
