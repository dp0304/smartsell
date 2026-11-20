import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { start } from './src/bootstrap.js';
import { configuration } from './src/config.js';

const args = process.argv.slice(2);
const preview = args[0] === 'preview';
if (preview) args.shift();
if (args[0] === '--') args.shift();
const { values } = parseArgs({ args, options: { host: { type: 'string' }, port: { type: 'string' }, 'no-watch': { type: 'boolean' } } });
const host = values.host ?? process.env.SMARTSELL_WEB_HOST ?? '127.0.0.1';
const port = Number(values.port ?? process.env.SMARTSELL_WEB_PORT ?? (preview ? 4173 : 5173));
if (process.env.NODE_ENV === 'production') throw new Error('Use the production server entry point with a same-origin proxy');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Web port');
const urlHost = (address: string) => address.includes(':') && !address.startsWith('[') ? `[${address}]` : address;
const loopbackForWildcard = (address: string) => address === '0.0.0.0' ? '127.0.0.1' : address === '::' ? '::1' : address;
const config = configuration({
  ...process.env,
  PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN ?? `http://${urlHost(loopbackForWildcard(host))}:${port}`,
});
if (port === config.port) throw new Error('Web and API ports must differ');
process.env.SMARTSELL_API_TARGET = `http://${urlHost(loopbackForWildcard(config.host))}:${config.port}`;
for (const hostname of [host, 'localhost', '127.0.0.1', '::1']) {
  config.origins.add(new URL(`http://${urlHost(hostname)}:${port}`).origin);
}

const root = new URL('../web/', import.meta.url);
const require = createRequire(new URL('package.json', root));
const vite = await import(pathToFileURL(require.resolve('vite')).href);
const app = await start(config);
try {
  const options = { root: fileURLToPath(root), configLoader: 'runner' };
  const listen = { host, port, strictPort: true };
  const web = preview ? await vite.preview({ ...options, preview: listen }) : await vite.createServer({
    ...options, server: { ...listen, ...(values['no-watch'] ? { watch: null, hmr: false } : {}) },
  });
  const closeWeb = web.close.bind(web);
  let closing: Promise<void> | undefined;
  // Vite calls web.close before exiting on SIGTERM. Release the database lock in that same shutdown.
  web.close = () => closing ??= Promise.all([closeWeb(), app.close()]).then(() => undefined);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void web.close().catch(() => { process.exitCode = 1; }));
  }
  if (!preview) await web.listen();
  web.printUrls();
} catch (error) {
  await app.close();
  throw error;
}
