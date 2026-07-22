// ─────────────────────────────────────────────
//  Cascade AI — Theme Registry
// ─────────────────────────────────────────────

import type { CascadeThemeName, Theme, ThemeColors, ThemeName } from '../../types.js';

function defineTheme(name: CascadeThemeName, colors: ThemeColors): Theme {
  return { name, colors };
}

// The canonical Cascade brand palette: intelligence flows down the tiers and
// the colour flows with it — azure (T1) → sky (T2) → teal (T3).
export const midnightTheme = defineTheme('midnight', {
  primary: '#4C8DFF', secondary: '#38B0DE', accent: '#2DD4BF',
  success: '#3DD68C', warning: '#F5B54B', error: '#F76D6D', info: '#4C8DFF',
  muted: '#8A93A8', background: '#0A0E1A', foreground: '#E8ECF6', border: '#202A3E',
  t1Color: '#4C8DFF', t2Color: '#38B0DE', t3Color: '#2DD4BF',
});

export const auroraTheme = defineTheme('aurora', {
  primary: '#6F8CFF', secondary: '#A78BFA', accent: '#45E0B8',
  success: '#45E0B8', warning: '#FFD166', error: '#FF6B8A', info: '#6FB7FF',
  muted: '#7890A8', background: '#071019', foreground: '#EAF7F5', border: '#20384A',
  t1Color: '#FFD166', t2Color: '#8B9CFF', t3Color: '#45E0B8',
});

export const emberTheme = defineTheme('ember', {
  primary: '#FF8A5B', secondary: '#FFB36B', accent: '#F7C75B',
  success: '#72D69A', warning: '#F7C75B', error: '#FF647C', info: '#73B7FF',
  muted: '#9A8078', background: '#120C0B', foreground: '#FFF1E9', border: '#463027',
  t1Color: '#F7C75B', t2Color: '#FF8A5B', t3Color: '#72D69A',
});

export const tideTheme = defineTheme('tide', {
  primary: '#4DA8FF', secondary: '#65C7F7', accent: '#51E1D4',
  success: '#63D9A5', warning: '#F2C879', error: '#F0718B', info: '#4DA8FF',
  muted: '#71899C', background: '#061017', foreground: '#E8F5FA', border: '#1C3947',
  t1Color: '#F2C879', t2Color: '#65A8F7', t3Color: '#51E1D4',
});

export const bloomTheme = defineTheme('bloom', {
  primary: '#C084FC', secondary: '#F08BB4', accent: '#7DD3FC',
  success: '#6EE7B7', warning: '#FBCB78', error: '#FB7185', info: '#7DD3FC',
  muted: '#9B83A8', background: '#140D19', foreground: '#F8EEFC', border: '#412B4D',
  t1Color: '#FBCB78', t2Color: '#C084FC', t3Color: '#7DD3FC',
});

export const daybreakTheme = defineTheme('daybreak', {
  primary: '#6857D9', secondary: '#826AE6', accent: '#087F91',
  success: '#087A55', warning: '#A86408', error: '#C83253', info: '#2563A8',
  muted: '#667085', background: '#F7F7FB', foreground: '#202336', border: '#D9DCE8',
  t1Color: '#A86408', t2Color: '#6857D9', t3Color: '#087F91',
});

const canonicalThemes: Record<CascadeThemeName, Theme> = {
  midnight: midnightTheme, aurora: auroraTheme, ember: emberTheme,
  tide: tideTheme, bloom: bloomTheme, daybreak: daybreakTheme,
};

export const THEME_ALIASES: Record<string, CascadeThemeName> = {
  cascade: 'midnight', dark: 'aurora', light: 'daybreak',
  dracula: 'bloom', nord: 'tide', solarized: 'ember',
};

export function resolveThemeName(name: ThemeName | string): CascadeThemeName {
  return (name in canonicalThemes ? name : THEME_ALIASES[name]) as CascadeThemeName || 'midnight';
}

export function getTheme(name: ThemeName | string): Theme {
  return canonicalThemes[resolveThemeName(name)] ?? midnightTheme;
}

export function listThemes(): Theme[] {
  return Object.values(canonicalThemes);
}

// Backward-compatible named exports for consumers that imported the old palette symbols.
export const cascadeTheme = midnightTheme;
export const darkTheme = auroraTheme;
export const lightTheme = daybreakTheme;
export const draculaTheme = bloomTheme;
export const nordTheme = tideTheme;
export const solarizedTheme = emberTheme;
