import { defineConfig, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';

// The repository launcher supplies its own API target. Standalone Web uses the default API port.
const target = process.env.SMARTSELL_API_TARGET ?? 'http://127.0.0.1:3401';
const loopbackAuthority = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/;
const apiTarget = URL.parse(target);
// '/agent/' (with the slash): the relay bundle the setup page tells the laptop to download (O6), not the /agent-connect page.
const proxy: Record<string, string | ProxyOptions> = Object.fromEntries([
  '/api', '/mcp', '/oauth', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/r/', '/agent/',
].map(path => [path, target]));

if (apiTarget?.protocol === 'http:' && loopbackAuthority.test(apiTarget.host)) {
  proxy['/api'] = {
    target,
    changeOrigin: true,
    configure(proxyServer) {
      proxyServer.on('proxyReq', (outgoing, request) => {
        const path = request.url?.split('?', 1)[0];
        const { host } = request.headers;
        const setup = (request.method === 'GET' && path === '/api/v1/setup/status') ||
          (request.method === 'POST' && path === '/api/v1/setup');
        // Local setup validates the original Web authority against its allowed origins.
        if (setup && host && loopbackAuthority.test(host)) outgoing.setHeader('host', host);
      });
    },
  };
}

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
