// Theme + density controller. Resolves the stored theme mode (light / dark /
// system) to a concrete palette on <html data-theme>, and keeps it in sync with
// the OS when the mode is "system". Density rides on <html data-density>.
//
// A tiny inline script in index.html applies the same attributes before first
// paint (no flash); this module owns the live updates after the app mounts.

import { themeMode, density, type ThemeMode, type Density } from './prefs.js';

const prefersDark = () =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;

/** The concrete palette ('light' | 'dark') a mode resolves to right now. */
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  return mode === 'system' ? (prefersDark() ? 'dark' : 'light') : mode;
}

/** Write the resolved palette to the document. */
export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = resolveTheme(mode);
}

/** Write the density to the document. */
export function applyDensity(value: Density): void {
  document.documentElement.dataset.density = value;
}

/**
 * Apply the stored theme + density and, while the mode is "system", follow OS
 * changes live. Returns a cleanup that detaches the OS listener. Call once from
 * the app root; re-call (via the returned cleanup then a fresh call) when the
 * user changes the mode so the listener reflects the new choice.
 */
export function initTheme(): () => void {
  applyTheme(themeMode());
  applyDensity(density());

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    // Only the "system" mode tracks the OS; an explicit choice is left alone.
    if (themeMode() === 'system') applyTheme('system');
  };
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}
