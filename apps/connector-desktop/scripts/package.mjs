import { build, Platform } from 'electron-builder';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { releaseConfig } from './config.mjs';

const [target, mode] = process.argv.slice(2);
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
const projectDir = fileURLToPath(new URL('../', import.meta.url));
const electronDist = fileURLToPath(new URL('../node_modules/electron/dist/', import.meta.url));
await access(new URL(mac ? 'Electron.app' : 'electron.exe', new URL('../node_modules/electron/dist/', import.meta.url))).catch(() => {
  throw new Error('Pinned Electron runtime is missing. Run node node_modules/electron/install.js');
});
if (local) process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
const platform = mac ? Platform.MAC : Platform.WINDOWS;
await build({
  projectDir,
  targets: platform.createTarget(local ? 'dir' : mac ? ['dmg', 'zip'] : 'nsis'),
  publish: 'never',
  config: {
    appId: 'com.smartsell.connector',
    directories: { output: local ? 'release-local' : 'release' },
    files: ['dist/main.cjs', 'dist/preload.cjs', 'dist/ui/index.html', 'dist/ui/renderer.js', 'dist/ui/styles.css', 'dist/smartsell-install-skills.mjs', 'package.json'],
    electronDist,
    asar: true,
    asarUnpack: ['dist/smartsell-install-skills.mjs'],
    npmRebuild: false,
    forceCodeSigning: !local,
    electronFuses: {
      runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
      grantFileProtocolExtraPrivileges: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true,
    },
    publish: !local && !mac ? [{ provider: 'generic', url: release.update.feed }] : null,
    mac: {
      identity: local ? '-' : process.env.SMARTSELL_MAC_IDENTITY,
      hardenedRuntime: !local,
      notarize: !local,
      category: 'public.app-category.business',
    },
    win: { signtoolOptions: local ? undefined : { publisherName: [release.update.publisher], signingHashAlgorithms: ['sha256'] } },
  },
});
