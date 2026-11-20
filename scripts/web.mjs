import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../apps/web/', import.meta.url));
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { createServer, preview } = await import(pathToFileURL(require.resolve('vite')).href);
const isPreview = process.argv[2] === 'preview';
const listen = {
  host: process.env.SMARTSELL_WEB_HOST ?? '127.0.0.1',
  port: Number(process.env.SMARTSELL_WEB_PORT ?? (isPreview ? 4173 : 5173)),
  strictPort: true,
};
const options = { root, configLoader: 'runner' };
const server = isPreview
  ? await preview({ ...options, preview: listen })
  : await createServer({ ...options, server: listen });
if (!isPreview) await server.listen();
server.printUrls();
