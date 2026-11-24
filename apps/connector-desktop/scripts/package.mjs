// Packages the Worker App.
//   node scripts/package.mjs --unsigned [--arch arm64|x64] [--out <dir>] [--electron-zip-dir <dir> --electron-version <v>] [--print-config]
//       Phase 1 (§8.18): unsigned dmg + zip on macOS (arm64 and x64), NSIS x64 on Windows. No signing requirement, no
//       update feed. Run `node scripts/build.mjs --packaged` first. The last stdout line is `ARTIFACTS <json>`.
//   node scripts/package.mjs mac|win [--local-dir]
//       Phase 7 signed release (Developer ID + notarization / Authenticode), unchanged.
import { Arch, build, Platform } from 'electron-builder';
import { existsSync, readFileSync } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseConfig } from './config.mjs';
import { builderConfig, hostTarget } from './package-config.mjs';

const projectDir = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const index = args.indexOf(name); return index !== -1 ? args[index + 1] : undefined; };

async function unsigned() {
  const target = hostTarget(process.platform);
  if (!target) throw new Error('Unsigned installers are built on macOS (dmg/zip) or Windows (NSIS).');
  const arch = option('--arch');
  if (arch && !['arm64', 'x64'].includes(arch)) throw new Error('--arch must be arm64 or x64');
  if (target === 'win' && arch && arch !== 'x64') throw new Error('Windows installers are x64 only');
  const output = resolve(option('--out') ?? join(projectDir, 'release', 'unsigned'));
  const pinned = JSON.parse(readFileSync(join(projectDir, 'node_modules/electron/package.json'), 'utf8')).version;
  const version = option('--electron-version') ?? pinned;
  if (version !== pinned && !flag('--allow-electron-version')) {
    throw new Error(`Electron ${version} differs from the pinned ${pinned}; pass --allow-electron-version for a local verification build only`);
  }
  const zipDir = option('--electron-zip-dir');
  const archs = target === 'win' ? ['x64'] : arch ? [arch] : ['arm64', 'x64'];
  const release = releaseConfig(process.platform);
  const configs = archs.map(each => {
    let electronDist;
    if (zipDir) {
      electronDist = join(resolve(zipDir), `electron-v${version}-${target === 'mac' ? 'darwin' : 'win32'}-${each}.zip`);
      if (!existsSync(electronDist)) throw new Error(`Missing ${electronDist}`);
    } else if (version === pinned && each === process.arch && existsSync(join(projectDir, 'node_modules/electron/dist'))) {
      electronDist = join(projectDir, 'node_modules/electron/dist');
    }
    // Otherwise electron-builder fetches the pinned Electron for this arch into its cache (normal release host behaviour).
    return builderConfig({ target, unsigned: true, arch: target === 'mac' ? each : undefined, output: join(output, target === 'mac' ? each : 'x64'),
      electronDist, electronVersion: version === pinned ? undefined : version, release });
  });
  if (flag('--print-config')) { console.log(JSON.stringify(configs, null, 2)); return; }
  for (const file of ['dist/main.cjs', 'dist/preload.cjs', 'dist/ui/index.html', 'dist/agent-relay/smartsell-relay.mjs', 'resources/test-clip.mp4']) {
    await access(join(projectDir, file)).catch(() => { throw new Error(`Missing ${file}: run node scripts/build.mjs --packaged first`); });
  }
  if (!/define_RELEASE_default = \{[^}]*packaged: true/.test(readFileSync(join(projectDir, 'dist/main.cjs'), 'utf8'))) throw new Error('dist/main.cjs was not built with --packaged');
  // No Developer ID lookup and no keychain access for an unsigned build.
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  const artifacts = [];
  for (const [index, config] of configs.entries()) {
    const each = archs[index];
    const platform = target === 'mac' ? Platform.MAC : Platform.WINDOWS;
    const built = await build({ projectDir, targets: platform.createTarget(null, each === 'arm64' ? Arch.arm64 : Arch.x64), publish: 'never', config });
    for (const path of built) if (/\.(dmg|zip|exe)$/.test(path)) artifacts.push({ path, arch: each, platform: `${target}-${each}` });
  }
  if (!artifacts.length) {
    for (const each of archs) for (const name of await readdir(join(output, target === 'mac' ? each : 'x64')).catch(() => [])) {
      if (/\.(dmg|zip|exe)$/.test(name)) artifacts.push({ path: join(output, target === 'mac' ? each : 'x64', name), arch: each, platform: `${target}-${each}` });
    }
  }
  console.log(`ARTIFACTS ${JSON.stringify(artifacts)}`);
}

async function signed() {
  const [target, mode] = args;
  const local = mode === '--local-dir';
  const mac = target === 'mac';
  if ((!mac && target !== 'win') || (mode && !local) || process.platform !== (mac ? 'darwin' : 'win32')) {
    throw new Error('Package on the matching macOS or Windows release host');
  }
  const release = releaseConfig(process.platform);
  if (local && release.update) throw new Error('Remove SMARTSELL_UPDATE_FEED before packaging an unsigned development build');
  if (!local) {
    if (!release.api || !release.workbench || !release.update) throw new Error('Release service, workbench and signed update feed are required');
    if (mac && (!process.env.SMARTSELL_MAC_IDENTITY || !process.env.APPLE_KEYCHAIN_PROFILE)) {
      throw new Error('Missing Developer ID Application signing identity or Apple notarytool keychain profile');
    }
    if (!mac && (!process.env.SMARTSELL_WIN_PUBLISHER || !(process.env.WIN_CSC_LINK || process.env.CSC_LINK))) {
      throw new Error('Missing Authenticode certificate (WIN_CSC_LINK or CSC_LINK) or expected publisher');
    }
  }
  const electronDist = fileURLToPath(new URL('../node_modules/electron/dist/', import.meta.url));
  await access(new URL(mac ? 'Electron.app' : 'electron.exe', new URL('../node_modules/electron/dist/', import.meta.url))).catch(() => {
    throw new Error('Pinned Electron runtime is missing. Run node node_modules/electron/install.js');
  });
  if (local) process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  const platform = mac ? Platform.MAC : Platform.WINDOWS;
  const config = builderConfig({ target, unsigned: local, output: local ? 'release-local' : 'release', electronDist, release,
    macIdentity: process.env.SMARTSELL_MAC_IDENTITY, winPublisher: release.update?.publisher });
  if (local) { delete config.mac?.target; if (config.win) config.win.target = 'dir'; }
  await build({ projectDir, targets: platform.createTarget(local ? 'dir' : mac ? ['dmg', 'zip'] : 'nsis'), publish: 'never', config });
}

await (flag('--unsigned') ? unsigned() : signed());
