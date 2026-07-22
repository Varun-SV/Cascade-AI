export type DesktopThemeName = 'midnight' | 'aurora' | 'ember' | 'tide' | 'bloom' | 'daybreak';

export interface DesktopTheme {
  id: DesktopThemeName;
  label: string;
  description: string;
  dark: boolean;
  colors: {
    bgBase: string; bgSurface: string; bgRaised: string; bgOverlay: string; bgHover: string; bgActive: string;
    border: string; borderStrong: string;
    text: string; textMuted: string; textDim: string;
    accent: string; accentHover: string; accentDim: string; accent2: string;
    t1: string; t2: string; t3: string;
    success: string; warn: string; danger: string; info: string;
  };
}

export const DESKTOP_THEMES: DesktopTheme[] = [
  {
    id: 'midnight', label: 'Midnight', description: 'The cascade — azure to teal over deep navy', dark: true,
    colors: { bgBase: '#0a0e1a', bgSurface: '#0f121c', bgRaised: '#151927', bgOverlay: '#1b2031', bgHover: '#232940', bgActive: '#2d3450', border: '#202a3e', borderStrong: '#323a56', text: '#e8ecf6', textMuted: '#8a93a8', textDim: '#555d78', accent: '#4c8dff', accentHover: '#6ba0ff', accentDim: '#16233f', accent2: '#2dd4bf', t1: '#4c8dff', t2: '#38b0de', t3: '#2dd4bf', success: '#3dd68c', warn: '#f5b54b', danger: '#f76d6d', info: '#4c8dff' },
  },
  {
    id: 'aurora', label: 'Aurora', description: 'Cool indigo and mint', dark: true,
    colors: { bgBase: '#071019', bgSurface: '#0c1722', bgRaised: '#122130', bgOverlay: '#182b3b', bgHover: '#20384a', bgActive: '#29475c', border: '#1a3041', borderStrong: '#2d4d61', text: '#eaf7f5', textMuted: '#87a4b2', textDim: '#526f7d', accent: '#6f8cff', accentHover: '#89a0ff', accentDim: '#233660', accent2: '#45e0b8', t1: '#ffd166', t2: '#8b9cff', t3: '#45e0b8', success: '#45e0b8', warn: '#ffd166', danger: '#ff6b8a', info: '#6fb7ff' },
  },
  {
    id: 'ember', label: 'Ember', description: 'Warm charcoal and copper', dark: true,
    colors: { bgBase: '#120c0b', bgSurface: '#1a1210', bgRaised: '#241917', bgOverlay: '#2e201c', bgHover: '#3a2822', bgActive: '#493129', border: '#35241f', borderStrong: '#51362d', text: '#fff1e9', textMuted: '#b99b8f', textDim: '#765f57', accent: '#ff8a5b', accentHover: '#ffa17d', accentDim: '#593020', accent2: '#f7c75b', t1: '#f7c75b', t2: '#ff8a5b', t3: '#72d69a', success: '#72d69a', warn: '#f7c75b', danger: '#ff647c', info: '#73b7ff' },
  },
  {
    id: 'tide', label: 'Tide', description: 'Ocean blue and sea glass', dark: true,
    colors: { bgBase: '#061017', bgSurface: '#0b1820', bgRaised: '#10232d', bgOverlay: '#162e3a', bgHover: '#1c3947', bgActive: '#254958', border: '#18313d', borderStrong: '#29505f', text: '#e8f5fa', textMuted: '#83a1ae', textDim: '#506e7a', accent: '#4da8ff', accentHover: '#70baff', accentDim: '#173e63', accent2: '#51e1d4', t1: '#f2c879', t2: '#65a8f7', t3: '#51e1d4', success: '#63d9a5', warn: '#f2c879', danger: '#f0718b', info: '#4da8ff' },
  },
  {
    id: 'bloom', label: 'Bloom', description: 'Aubergine, lilac, and rose', dark: true,
    colors: { bgBase: '#140d19', bgSurface: '#1d1224', bgRaised: '#291931', bgOverlay: '#34203f', bgHover: '#412b4d', bgActive: '#52345f', border: '#382342', borderStrong: '#563364', text: '#f8eefc', textMuted: '#b398bc', textDim: '#765f7f', accent: '#c084fc', accentHover: '#d29cff', accentDim: '#49305e', accent2: '#f08bb4', t1: '#fbcb78', t2: '#c084fc', t3: '#7dd3fc', success: '#6ee7b7', warn: '#fbcb78', danger: '#fb7185', info: '#7dd3fc' },
  },
  {
    id: 'daybreak', label: 'Daybreak', description: 'Warm daylight with crisp indigo', dark: false,
    colors: { bgBase: '#f7f7fb', bgSurface: '#ffffff', bgRaised: '#f0f1f7', bgOverlay: '#e8eaf2', bgHover: '#e2e4ee', bgActive: '#d7dae7', border: '#d9dce8', borderStrong: '#c5c9d9', text: '#202336', textMuted: '#667085', textDim: '#98a0b3', accent: '#6857d9', accentHover: '#5948c9', accentDim: '#e3dfff', accent2: '#087f91', t1: '#a86408', t2: '#6857d9', t3: '#087f91', success: '#087a55', warn: '#a86408', danger: '#c83253', info: '#2563a8' },
  },
];

export function getDesktopTheme(name: string): DesktopTheme {
  return DESKTOP_THEMES.find((theme) => theme.id === name) ?? DESKTOP_THEMES[0]!;
}

export function applyDesktopTheme(name: DesktopThemeName): void {
  const theme = getDesktopTheme(name);
  const root = document.documentElement;
  const c = theme.colors;
  const vars: Record<string, string> = {
    '--bg-base': c.bgBase, '--bg-surface': c.bgSurface, '--bg-raised': c.bgRaised,
    '--bg-overlay': c.bgOverlay, '--bg-hover': c.bgHover, '--bg-active': c.bgActive,
    '--border': c.border, '--border-strong': c.borderStrong,
    '--text': c.text, '--text-muted': c.textMuted, '--text-dim': c.textDim,
    '--accent': c.accent, '--accent-hover': c.accentHover, '--accent-dim': c.accentDim,
    '--accent-2': c.accent2, '--t1': c.t1, '--t2': c.t2, '--t3': c.t3,
    '--success': c.success, '--warn': c.warn, '--danger': c.danger, '--info': c.info,
  };
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.dark ? 'dark' : 'light';
}
