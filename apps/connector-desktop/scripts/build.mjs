import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { releaseConfig } from './config.mjs';

const appDir = new URL('../', import.meta.url);
const release = releaseConfig(process.platform);
const options = { absWorkingDir: fileURLToPath(appDir), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron', 'electron-updater'] };
await build({ ...options, entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', define: { RELEASE: JSON.stringify(release) } });
await build({ ...options, entryPoints: ['src/preload.ts'], outfile: 'dist/preload.cjs' });
await mkdir(new URL('dist/', appDir), { recursive: true });
for (const file of ['index.html', 'styles.css']) {
  await copyFile(new URL(`ui/${file}`, appDir), new URL(`dist/ui/${file}`, appDir));
}
await build({ absWorkingDir: fileURLToPath(appDir), bundle: true, platform: 'browser', format: 'iife',
  entryPoints: ['ui/renderer.js'], outfile: 'dist/ui/renderer.js' });
