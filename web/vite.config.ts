import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4891', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:4891', ws: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          reactflow: ['reactflow'],
          socketio: ['socket.io-client'],
        },
      },
    },
  },
});
