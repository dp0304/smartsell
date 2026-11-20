import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The repository launcher supplies its own API target. Standalone Web uses the default API port.
const target = process.env.SMARTSELL_API_TARGET ?? 'http://127.0.0.1:3401';
const proxy = Object.fromEntries([
  '/api', '/mcp', '/oauth', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/r/',
].map(path => [path, target]));

export default defineConfig({
  plugins: [react()],
  cacheDir: process.env.SMARTSELL_VITE_CACHE_DIR,
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (/[/\\]node_modules[/\\](?:react|react-dom|scheduler)[/\\]/.test(id)) return 'react';
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy },
  preview: { host: '127.0.0.1', proxy },
});
