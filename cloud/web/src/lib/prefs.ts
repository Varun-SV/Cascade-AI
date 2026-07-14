// Small localStorage-backed client preferences (device-local, not synced).

const LOCAL_MODEL_KEY = 'cascade-cloud-local-model';
const REDUCE_MOTION_KEY = 'cascade-cloud-reduce-motion';

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
