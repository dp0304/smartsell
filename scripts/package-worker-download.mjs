import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  throw new Error('Run this development package command using arm64 Node on Apple silicon macOS');
}
const root = fileURLToPath(new URL('../', import.meta.url));
const release = join(root, 'apps/connector-desktop/release-local/mac-arm64');
const downloads = join(root, '.local/worker-downloads');
const filename = 'SmartSell-Worker-mac-arm64.zip';
const run = (command, args) => execFileSync(command, args, { cwd: root, stdio: 'inherit' });

run('pnpm', ['--filter', '@smartsell/connector-desktop', 'build']);
run('pnpm', ['--filter', '@smartsell/connector-desktop', 'exec', 'node', 'scripts/package.mjs', 'mac', '--local-dir']);
const apps = readdirSync(release, { withFileTypes: true }).filter(entry => entry.isDirectory() && entry.name.endsWith('.app'));
if (apps.length !== 1) throw new Error(`Expected one macOS app in ${release}`);
mkdirSync(downloads, { recursive: true });
const stage = mkdtempSync(join(downloads, '.staging-'));
try {
  const zip = join(stage, filename);
  run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', join(release, apps[0].name), zip]);
  renameSync(zip, join(downloads, filename));
} finally {
  rmSync(stage, { recursive: true, force: true });
}
console.log(`Worker download ready at ${join(downloads, filename)}`);
