// Small localStorage-backed client preferences (device-local, not synced).

const LOCAL_MODEL_KEY = 'cascade-cloud-local-model';
const REDUCE_MOTION_KEY = 'cascade-cloud-reduce-motion';
const FAST_MODEL_KEY = 'cascade-cloud-fast-model';
const THEME_KEY = 'cascade-cloud-theme';
const DENSITY_KEY = 'cascade-cloud-density';
const UI_MODE_KEY = 'cascade-cloud-ui-mode';
const TIER_PARAMS_KEY = 'cascade-cloud-tier-params';
const EXT_CONTEXT_KEY = 'cascade-cloud-ext-context';
const SHARE_LEARNING_KEY = 'cascade-cloud-share-learning';

export type ThemeMode = 'light' | 'dark' | 'system';
export type Density = 'comfortable' | 'compact';
/** Simple = minimal chat; Advanced = full console (routing controls, tier detail). */
export type UiMode = 'simple' | 'advanced';

function readString<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeString(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function readBool(key: string, fallback = false): boolean {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === '1';
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* storage unavailable (private mode) — preference just won't persist */
  }
}

/** Opt-in: run the in-browser model to auto-title conversations. Off by default. */
export const localModelEnabled = () => readBool(LOCAL_MODEL_KEY, false);
export const setLocalModelEnabled = (v: boolean) => writeBool(LOCAL_MODEL_KEY, v);

/** Appearance: reduce/disable non-essential animation. Off by default. */
export const reduceMotionEnabled = () => readBool(REDUCE_MOTION_KEY, false);
export const setReduceMotionEnabled = (v: boolean) => writeBool(REDUCE_MOTION_KEY, v);

/** Contribute anonymous model-outcome stats to the shared learning pool. On by
 *  default; only a Pro user's opt-out is honored server-side (free always on). */
export const shareLearning = () => readBool(SHARE_LEARNING_KEY, true);
export const setShareLearning = (v: boolean) => writeBool(SHARE_LEARNING_KEY, v);

/** Colour theme: light, dark, or follow the OS. Default: system. */
export const themeMode = (): ThemeMode => readString(THEME_KEY, ['light', 'dark', 'system'] as const, 'system');
export const setThemeMode = (v: ThemeMode) => writeString(THEME_KEY, v);

/** Layout density. Default: comfortable. */
export const density = (): Density => readString(DENSITY_KEY, ['comfortable', 'compact'] as const, 'comfortable');
export const setDensity = (v: Density) => writeString(DENSITY_KEY, v);

/** UI mode: minimal chat (default) vs. full console. */
export const uiMode = (): UiMode => readString(UI_MODE_KEY, ['simple', 'advanced'] as const, 'simple');
export const setUiMode = (v: UiMode) => writeString(UI_MODE_KEY, v);

/** Advanced per-tier generation knobs. Both fields optional per tier. */
export interface TierParam { maxTokens?: number; temperature?: number }
export interface TierParams { t1?: TierParam; t2?: TierParam; t3?: TierParam }

/** Read the stored per-tier params (empty object when unset/corrupt). */
export function tierParams(): TierParams {
  try {
    const raw = localStorage.getItem(TIER_PARAMS_KEY);
    return raw ? (JSON.parse(raw) as TierParams) : {};
  } catch {
    return {};
  }
}

/** Persist per-tier params, pruning empty tiers/fields so unset knobs stay unset. */
export function setTierParams(v: TierParams): void {
  const prune = (p?: TierParam): TierParam | undefined => {
    if (!p) return undefined;
    const out: TierParam = {};
    if (typeof p.maxTokens === 'number' && p.maxTokens > 0) out.maxTokens = Math.floor(p.maxTokens);
    if (typeof p.temperature === 'number' && p.temperature >= 0 && p.temperature <= 2) out.temperature = p.temperature;
    return Object.keys(out).length ? out : undefined;
  };
  const cleaned: TierParams = {};
  for (const tier of ['t1', 't2', 't3'] as const) {
    const p = prune(v[tier]);
    if (p) cleaned[tier] = p;
  }
  try {
    if (Object.keys(cleaned).length) localStorage.setItem(TIER_PARAMS_KEY, JSON.stringify(cleaned));
    else localStorage.removeItem(TIER_PARAMS_KEY);
  } catch { /* storage unavailable */ }
}

/** Extended context: compact oversized history/input to fit the model window. */
export interface ExtendedContextPref { enabled: boolean; maxMultiplier: 2 | 3 }

export function extendedContext(): ExtendedContextPref {
  try {
    const raw = localStorage.getItem(EXT_CONTEXT_KEY);
    if (!raw) return { enabled: false, maxMultiplier: 2 };
    const p = JSON.parse(raw) as Partial<ExtendedContextPref>;
    return { enabled: !!p.enabled, maxMultiplier: p.maxMultiplier === 3 ? 3 : 2 };
  } catch {
    return { enabled: false, maxMultiplier: 2 };
  }
}

export function setExtendedContext(v: ExtendedContextPref): void {
  try { localStorage.setItem(EXT_CONTEXT_KEY, JSON.stringify({ enabled: !!v.enabled, maxMultiplier: v.maxMultiplier === 3 ? 3 : 2 })); }
  catch { /* storage unavailable */ }
}

/** Optional model id to pin for "Fast answer" (blank = auto-pick a mid model). */
export function fastAnswerModel(): string {
  try { return localStorage.getItem(FAST_MODEL_KEY)?.trim() || ''; } catch { return ''; }
}
export function setFastAnswerModel(v: string): void {
  try {
    const t = v.trim();
    if (t) localStorage.setItem(FAST_MODEL_KEY, t);
    else localStorage.removeItem(FAST_MODEL_KEY);
  } catch { /* storage unavailable */ }
}
