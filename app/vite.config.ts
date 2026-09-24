import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      // Shared with cloud/web so both chats agree on what is maths.
      '@cascade/markdown': resolve(__dirname, '../src/core/markdown/index.ts'),
    },
  },
  build: {
    outDir: 'dist-renderer',
    emptyOutDir: true,
  },
});
