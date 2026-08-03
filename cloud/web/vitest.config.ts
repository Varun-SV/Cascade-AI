import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Same alias as vite.config.ts — the exporter tests exercise the SHARED
// renderers, which is the point: one module, verified from both sides.
const documents = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/core/documents/index.ts',
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@cascade/documents': documents },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
