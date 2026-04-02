/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        cascade: {
          50:  '#f3f0ff',
          100: '#e9e4ff',
          200: '#d5cbfe',
          300: '#b7a6fc',
          400: '#9575f9',
          500: '#7c6af7',
          600: '#6347f0',
          700: '#5334dc',
          800: '#452cb8',
          900: '#3a2796',
          950: '#231766',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Cascadia Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
