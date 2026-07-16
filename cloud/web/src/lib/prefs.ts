// Small localStorage-backed client preferences (device-local, not synced).

const LOCAL_MODEL_KEY = 'cascade-cloud-local-model';
const REDUCE_MOTION_KEY = 'cascade-cloud-reduce-motion';
const FAST_MODEL_KEY = 'cascade-cloud-fast-model';

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
