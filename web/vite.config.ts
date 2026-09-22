import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// vite 8 builds with rolldown, whose `manualChunks` accepts ONLY the function
// form. The object form this replaces did not warn and carry on — the build
// died with "manualChunks is not a function", which is at least loud.
//
// Same three groups as before, but each now names its whole family. The object
// form took each entry package AND its dependency subtree, which is how one
// entry of `['reactflow']` captured a library that only re-exports from
// `@reactflow/*`; a function sees one module id at a time and gets no subtree,
// so the first pass at this produced no reactflow chunk at all and quietly
// folded it into the main bundle — a build that succeeds while undoing the
// splitting it was configured for.
//
// Matched on the module's path inside node_modules with slashes on both sides,
// so `react` cannot swallow `react-dom` or `reactflow`, and a local file that
// merely mentions a package name is not swept in.
const VENDOR_CHUNKS: ReadonlyArray<readonly [chunk: string, packages: readonly string[]]> = [
  ['react', ['react', 'react-dom', 'scheduler']],
  ['reactflow', ['reactflow', '@reactflow']],
  ['socketio', ['socket.io-client', 'socket.io-parser', 'engine.io-client', 'engine.io-parser']],
];

function manualChunks(id: string): string | undefined {
  const normalized = id.replace(/\\/g, '/');
  for (const [chunk, packages] of VENDOR_CHUNKS) {
    if (packages.some((pkg) => normalized.includes(`/node_modules/${pkg}/`))) return chunk;
  }
  return undefined;
}

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
      output: { manualChunks },
    },
  },
});
