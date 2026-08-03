import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Office document parser + renderers are shared with the SDK's
// `generate_document` tool (see src/core/documents). Aliased rather than copied
// so cloud/web and desktop/CLI can never disagree about what a chart block or a
// Markdown slide deck means. The module is deliberately DOM-free and Node-free,
// so it bundles for the browser unchanged.
const documents = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/core/documents/index.ts',
);

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@cascade/documents': documents },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: true },
      '/auth': { target: 'http://localhost:8787', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:8787', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
