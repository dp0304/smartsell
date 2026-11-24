import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_NAME } from '../apps/connector-desktop/scripts/package-config.mjs';

// CI check of the unsigned development package (`package.mjs mac|win --local-dir`). Release installers are built and
// checked by `pnpm worker:release` (§8.18); this only verifies the packaged app layout of the SmartSell Worker App.
const project = fileURLToPath(new URL('../apps/connector-desktop/', import.meta.url));
const output = resolve(project, 'release-local');
const archives = readdirSync(output, { recursive: true }).filter(path => /[/\\]app\.asar$/.test(path));
assert.equal(archives.length, 1, 'Expected one packaged Electron application');
const archive = resolve(output, archives[0]);
const executable = process.platform === 'darwin' ? `../MacOS/${PRODUCT_NAME}` : `../${PRODUCT_NAME}.exe`;
assert(statSync(resolve(dirname(archive), executable)).isFile(), 'Packaged application executable is missing');

const require = createRequire(new URL('../apps/connector-desktop/package.json', import.meta.url));
const builder = createRequire(require.resolve('electron-builder'));
const { extractFile } = createRequire(builder.resolve('app-builder-lib'))('@electron/asar');
const manifest = JSON.parse(extractFile(archive, 'package.json'));
const updater = JSON.parse(extractFile(archive, normalize('node_modules/electron-updater/package.json')));
assert.equal(manifest.main, 'dist/main.cjs');
assert.equal(updater.version, require('./package.json').dependencies['electron-updater']);
for (const entry of ['main.cjs', 'preload.cjs', 'ui/index.html', 'ui/renderer.js', 'ui/styles.css', 'smartsell-install-skills.mjs']) {
  assert.deepEqual(extractFile(archive, normalize(`dist/${entry}`)), readFileSync(resolve(project, 'dist', entry)), entry);
}
console.log(`Verified ${archives[0]} and the packaged executable`);
