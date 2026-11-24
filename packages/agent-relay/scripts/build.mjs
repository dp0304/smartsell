// The shebang comes from src/main.ts. Bundle the relay into one zero-dependency ESM file for `node smartsell-relay.mjs` (Node 20+) and GET /agent/relay.mjs.
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--outfile');
const outfile = outIndex === -1 ? resolve(root, 'dist/smartsell-relay.mjs') : resolve(args[outIndex + 1]);

async function loadEsbuild() {
  try { return await import('esbuild'); }
  catch {
    // This package has no dependencies; esbuild is pinned by the Worker app (apps/connector-desktop), which bundles the relay too.
    const require = createRequire(resolve(root, '../../apps/connector-desktop/package.json'));
    return import(pathToFileURL(require.resolve('esbuild')).href);
  }
}

const esbuild = await loadEsbuild();
await esbuild.build({
  entryPoints: [resolve(root, 'src/main.ts')],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'warning',
});
console.log(outfile);
