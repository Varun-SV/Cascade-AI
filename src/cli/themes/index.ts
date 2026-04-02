// ─────────────────────────────────────────────
//  Cascade AI — Theme Registry
// ─────────────────────────────────────────────

import type { Theme, ThemeName } from '../../types.js';

const cascadeTheme: Theme = {
  name: 'cascade',
  colors: {
    primary:    '#7C6AF7',   // Cascade violet
    secondary:  '#A78BFA',
    accent:     '#06B6D4',   // Cyan
    success:    '#10B981',
    warning:    '#F59E0B',
    error:      '#EF4444',
    info:       '#3B82F6',
    muted:      '#6B7280',
    background: '#0F0F1A',
    foreground: '#E2E8F0',
    border:     '#2D2B55',
    t1Color:    '#7C6AF7',   // Violet
    t2Color:    '#06B6D4',   // Cyan
    t3Color:    '#10B981',   // Green
  },
};

const darkTheme: Theme = {
  name: 'dark',
  colors: {
    primary:    '#60A5FA',
    secondary:  '#818CF8',
    accent:     '#34D399',
    success:    '#34D399',
    warning:    '#FBBF24',
    error:      '#F87171',
    info:       '#60A5FA',
    muted:      '#6B7280',
    background: '#111827',
    foreground: '#F9FAFB',
    border:     '#374151',
    t1Color:    '#60A5FA',
    t2Color:    '#818CF8',
    t3Color:    '#34D399',
  },
};

const lightTheme: Theme = {
  name: 'light',
  colors: {
    primary:    '#2563EB',
    secondary:  '#7C3AED',
    accent:     '#0891B2',
    success:    '#059669',
    warning:    '#D97706',
    error:      '#DC2626',
    info:       '#2563EB',
    muted:      '#6B7280',
    background: '#FFFFFF',
    foreground: '#111827',
    border:     '#E5E7EB',
    t1Color:    '#2563EB',
    t2Color:    '#7C3AED',
    t3Color:    '#059669',
  },
};

const draculaTheme: Theme = {
  name: 'dracula',
  colors: {
    primary:    '#BD93F9',
    secondary:  '#FF79C6',
    accent:     '#8BE9FD',
    success:    '#50FA7B',
    warning:    '#FFB86C',
    error:      '#FF5555',
    info:       '#8BE9FD',
    muted:      '#6272A4',
    background: '#282A36',
    foreground: '#F8F8F2',
    border:     '#44475A',
    t1Color:    '#BD93F9',
    t2Color:    '#FF79C6',
    t3Color:    '#50FA7B',
  },
};

const nordTheme: Theme = {
  name: 'nord',
  colors: {
    primary:    '#88C0D0',
    secondary:  '#81A1C1',
    accent:     '#A3BE8C',
    success:    '#A3BE8C',
    warning:    '#EBCB8B',
    error:      '#BF616A',
    info:       '#5E81AC',
    muted:      '#4C566A',
    background: '#2E3440',
    foreground: '#ECEFF4',
    border:     '#3B4252',
    t1Color:    '#88C0D0',
    t2Color:    '#81A1C1',
    t3Color:    '#A3BE8C',
  },
};

const solarizedTheme: Theme = {
  name: 'solarized',
  colors: {
    primary:    '#268BD2',
    secondary:  '#2AA198',
    accent:     '#B58900',
    success:    '#859900',
    warning:    '#CB4B16',
    error:      '#DC322F',
    info:       '#268BD2',
    muted:      '#657B83',
    background: '#002B36',
    foreground: '#839496',
    border:     '#073642',
    t1Color:    '#268BD2',
    t2Color:    '#2AA198',
    t3Color:    '#859900',
  },
};

const themes: Map<ThemeName, Theme> = new Map([
  ['cascade',   cascadeTheme],
  ['dark',      darkTheme],
  ['light',     lightTheme],
  ['dracula',   draculaTheme],
  ['nord',      nordTheme],
  ['solarized', solarizedTheme],
]);

export function getTheme(name: ThemeName | string): Theme {
  return themes.get(name as ThemeName) ?? cascadeTheme;
}

export function listThemes(): Theme[] {
  return Array.from(themes.values());
}

export { cascadeTheme, darkTheme, lightTheme, draculaTheme, nordTheme, solarizedTheme };
