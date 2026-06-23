import { useEffect } from 'react';
import { useAppDispatch, useAppSelector, setTheme, type ThemePref } from '../store/index.js';

// Apply the resolved theme to <html data-theme="…"> so the CSS token blocks in
// index.html (`:root` = light, `:root[data-theme="dark"]` = dark) take effect.
function applyDocumentTheme(dark: boolean): void {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/**
 * Syncs the desktop appearance preference (System / Light / Dark) into Redux and
 * onto the document. The source of truth lives in the main process
 * (`nativeTheme`, persisted in cascade-desktop.json); here we read it on mount
 * and subscribe to live OS / preference changes. Mounted once near the app root.
 */
export function useThemeSync(): void {
  const dispatch = useAppDispatch();
  const dark = useAppSelector((s) => s.app.themeDark);

  useEffect(() => {
    const bridge = window.cascade?.theme;
    if (!bridge) {
      // Browser/dev fallback: follow the OS via the media query.
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const set = () => dispatch(setTheme({ preference: 'system', dark: mq.matches }));
      set();
      mq.addEventListener('change', set);
      return () => mq.removeEventListener('change', set);
    }
    bridge.get().then((s) => dispatch(setTheme({ preference: s.preference, dark: s.shouldUseDark })));
    bridge.onChanged((s) => dispatch(setTheme({ preference: s.preference, dark: s.shouldUseDark })));
  }, [dispatch]);

  // Keep the document attribute in sync with the resolved dark flag.
  useEffect(() => { applyDocumentTheme(dark); }, [dark]);
}

/** Change the appearance preference; persists in the main process and updates state. */
export async function setThemePreference(dispatch: ReturnType<typeof useAppDispatch>, preference: ThemePref): Promise<void> {
  const bridge = window.cascade?.theme;
  if (bridge) {
    const res = await bridge.set(preference);
    dispatch(setTheme({ preference: res.preference, dark: res.shouldUseDark }));
  } else {
    // Dev fallback without the Electron bridge.
    const dark = preference === 'dark' || (preference === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
    dispatch(setTheme({ preference, dark }));
  }
}
