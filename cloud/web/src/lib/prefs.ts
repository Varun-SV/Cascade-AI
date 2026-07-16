// Small localStorage-backed client preferences (device-local, not synced).

const LOCAL_MODEL_KEY = 'cascade-cloud-local-model';
const REDUCE_MOTION_KEY = 'cascade-cloud-reduce-motion';
const FAST_MODEL_KEY = 'cascade-cloud-fast-model';
const THEME_KEY = 'cascade-cloud-theme';
const DENSITY_KEY = 'cascade-cloud-density';
const UI_MODE_KEY = 'cascade-cloud-ui-mode';

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

/** Colour theme: light, dark, or follow the OS. Default: system. */
export const themeMode = (): ThemeMode => readString(THEME_KEY, ['light', 'dark', 'system'] as const, 'system');
export const setThemeMode = (v: ThemeMode) => writeString(THEME_KEY, v);

/** Layout density. Default: comfortable. */
export const density = (): Density => readString(DENSITY_KEY, ['comfortable', 'compact'] as const, 'comfortable');
export const setDensity = (v: Density) => writeString(DENSITY_KEY, v);

/** UI mode: minimal chat (default) vs. full console. */
export const uiMode = (): UiMode => readString(UI_MODE_KEY, ['simple', 'advanced'] as const, 'simple');
export const setUiMode = (v: UiMode) => writeString(UI_MODE_KEY, v);

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
