// ─────────────────────────────────────────────
//  Cascade AI — The thinking level the desktop composer sends with a run
// ─────────────────────────────────────────────
//
//  One setting per run: how much the run's models think. 'auto' leaves each
//  model at its own default and isn't sent. Azure deployments never get it
//  (src/providers/thinking.ts), so with only Azure set up it is unavailable.

export type ThinkingLevel = 'auto' | 'off' | 'low' | 'medium' | 'high';
export const THINKING_LEVELS: readonly ThinkingLevel[] = ['auto', 'off', 'low', 'medium', 'high'];

export const THINKING_LABELS: Record<ThinkingLevel, string> = {
  auto: 'Thinking: Auto',
  off: 'Thinking: Off',
  low: 'Thinking: Low',
  medium: 'Thinking: Medium',
  high: 'Thinking: High',
};

const KEY = 'cascade.desktop.thinkingLevel';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const storage = (): Store | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };

export function loadThinkingLevel(store: Store | null = storage()): ThinkingLevel {
  try {
    const v = store?.getItem(KEY) ?? '';
    return (THINKING_LEVELS as readonly string[]).includes(v) ? v as ThinkingLevel : 'auto';
  } catch { return 'auto'; }
}

export function saveThinkingLevel(level: ThinkingLevel, store: Store | null = storage()): void {
  try {
    if (level === 'auto') store?.removeItem(KEY);
    else store?.setItem(KEY, level);
  } catch { /* storage unavailable */ }
}

/** True when every provider with a key is an Azure deployment: the setting would do nothing. */
export function thinkingUnavailable(providersWithKey: readonly string[] | undefined): boolean {
  return !!providersWithKey?.length && providersWithKey.every((p) => p === 'azure');
}

/** The run payload's `thinking` field: present only for a level other than auto. */
export function thinkingField(level: ThinkingLevel, unavailable: boolean): { thinking?: Exclude<ThinkingLevel, 'auto'> } {
  return level === 'auto' || unavailable ? {} : { thinking: level };
}
