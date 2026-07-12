import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: {
          50: '#f5f5f7',
          100: '#e4e4e9',
          200: '#a8a8b3',
          400: '#6b6b76',
          600: '#3a3a42',
          700: '#29292f',
          800: '#1c1c20',
          900: '#131316',
          950: '#0a0a0c',
        },
        accent: {
          300: '#ffcda1',
          400: '#ffb56b',
          500: '#ff8a3d',
          600: '#e56a1f',
          700: '#c2530f',
        },
        success: { 300: '#a7f0d1', 500: '#3ecf8e', 800: '#0f4a34', 950: '#0a2a1f' },
        warning: { 300: '#fbe3a1', 500: '#f2c94c', 800: '#4a3c0f', 950: '#2a220a' },
        danger: { 300: '#f9b8bb', 500: '#f2545b', 800: '#4a1013', 950: '#2a0a0c' },
        info: { 300: '#b9d9ff', 500: '#4f9dff', 800: '#0f2a4a', 950: '#0a1a2a' },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace'],
      },
    },
  },
  plugins: [typography],
};
