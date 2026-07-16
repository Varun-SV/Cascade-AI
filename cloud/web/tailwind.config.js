import typography from '@tailwindcss/typography';

/**
 * Cascade "Bold Console" tokens.
 *
 * Every colour resolves from a CSS custom property holding space-separated RGB
 * channels (e.g. `--c-ink-900: 15 18 28`), wrapped so Tailwind's `/<alpha>`
 * opacity modifiers keep working (`bg-ink-900/55`, `border-elev/10`). The
 * channel values are redefined per theme in index.css (`:root` = dark,
 * `:root[data-theme="light"]` = light), so the *same* utility classes flip
 * automatically — no per-component theme branching.
 *
 * - `ink`    — the neutral ramp: 50/100 = brightest text … 900/950 = base surface.
 * - `accent` — Cascade violet, the primary brand/action colour.
 * - `elev`   — translucent elevation tint (white in dark, deep ink in light);
 *              use in place of raw `white/x` so overlays read in both themes.
 * - `t1/t2/t3` — orchestration tier accents (amber / violet / cyan).
 */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          50: 'rgb(var(--c-ink-50) / <alpha-value>)',
          100: 'rgb(var(--c-ink-100) / <alpha-value>)',
          200: 'rgb(var(--c-ink-200) / <alpha-value>)',
          300: 'rgb(var(--c-ink-300) / <alpha-value>)',
          400: 'rgb(var(--c-ink-400) / <alpha-value>)',
          500: 'rgb(var(--c-ink-500) / <alpha-value>)',
          600: 'rgb(var(--c-ink-600) / <alpha-value>)',
          700: 'rgb(var(--c-ink-700) / <alpha-value>)',
          800: 'rgb(var(--c-ink-800) / <alpha-value>)',
          900: 'rgb(var(--c-ink-900) / <alpha-value>)',
          950: 'rgb(var(--c-ink-950) / <alpha-value>)',
        },
        accent: {
          300: 'rgb(var(--c-accent-300) / <alpha-value>)',
          400: 'rgb(var(--c-accent-400) / <alpha-value>)',
          500: 'rgb(var(--c-accent-500) / <alpha-value>)',
          600: 'rgb(var(--c-accent-600) / <alpha-value>)',
          700: 'rgb(var(--c-accent-700) / <alpha-value>)',
        },
        // Elevation tint — stands in for raw white overlays so borders/fills
        // read on both dark and light surfaces.
        elev: 'rgb(var(--c-elev) / <alpha-value>)',
        // Orchestration tier accents.
        t1: 'rgb(var(--c-t1) / <alpha-value>)',
        t2: 'rgb(var(--c-t2) / <alpha-value>)',
        t3: 'rgb(var(--c-t3) / <alpha-value>)',
        success: {
          300: 'rgb(var(--c-success-300) / <alpha-value>)',
          500: 'rgb(var(--c-success-500) / <alpha-value>)',
          800: 'rgb(var(--c-success-800) / <alpha-value>)',
          950: 'rgb(var(--c-success-950) / <alpha-value>)',
        },
        warning: {
          300: 'rgb(var(--c-warning-300) / <alpha-value>)',
          500: 'rgb(var(--c-warning-500) / <alpha-value>)',
          800: 'rgb(var(--c-warning-800) / <alpha-value>)',
          950: 'rgb(var(--c-warning-950) / <alpha-value>)',
        },
        danger: {
          300: 'rgb(var(--c-danger-300) / <alpha-value>)',
          500: 'rgb(var(--c-danger-500) / <alpha-value>)',
          800: 'rgb(var(--c-danger-800) / <alpha-value>)',
          950: 'rgb(var(--c-danger-950) / <alpha-value>)',
        },
        info: {
          300: 'rgb(var(--c-info-300) / <alpha-value>)',
          500: 'rgb(var(--c-info-500) / <alpha-value>)',
          800: 'rgb(var(--c-info-800) / <alpha-value>)',
          950: 'rgb(var(--c-info-950) / <alpha-value>)',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace'],
      },
    },
  },
  plugins: [typography],
};
