// electron-builder configuration for the Worker App (§8.18). Pure functions
// so the unsigned configuration (no signing requirement, no update feed,
// RELEASE.packaged recorded) is snapshot-tested on any host, including the
// Windows NSIS config that can only be built on Windows.

export const APP_ID = 'com.smartsell.worker';
export const PRODUCT_NAME = 'SmartSell Worker';
export const PACKAGED_FILES = ['dist/main.cjs', 'dist/preload.cjs', 'dist/ui/**', 'dist/smartsell-install-skills.mjs', 'package.json'];
const FUSES = {
  runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
  grantFileProtocolExtraPrivileges: false, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true,
};
/** The dry-run clip (§8.12) and the Node relay for Windows laptops (§6.1) ship as resources. */
export const EXTRA_RESOURCES = [
  { from: 'resources', to: 'resources', filter: ['test-clip.mp4', 'test-clip.json'] },
  { from: 'dist/agent-relay', to: 'agent-relay', filter: ['smartsell-relay.mjs'] },
  // The SmartSell Chrome extension (own-Chrome mode); the App copies it to Documents for 「載入未封裝項目」.
  { from: 'extension', to: 'extension', filter: ['manifest.json', 'background.js', 'popup.html', 'popup.js'] },
];

export const artifactName = (platform, arch) => `SmartSell-Worker-\${version}-${platform}-${arch}.\${ext}`;

/**
 * `unsigned` (Phase 1, §8.18): forceCodeSigning false, no publish/update feed, ad-hoc signature on macOS (arm64
 * binaries must carry one to launch), no hardened runtime, no notarization, dmg + zip; Windows: NSIS x64.
 */
export function builderConfig({ target, unsigned, arch, output, electronDist, electronVersion, release = {}, macIdentity, winPublisher }) {
  if (target !== 'mac' && target !== 'win') throw new Error('target must be mac or win');
  if (unsigned && release.update) throw new Error('Unsigned builds must not have an update feed');
  const signed = !unsigned;
  const config = {
    appId: APP_ID,
    productName: PRODUCT_NAME,
    directories: { output },
    files: PACKAGED_FILES,
    extraResources: EXTRA_RESOURCES,
    asar: true,
    asarUnpack: ['dist/smartsell-install-skills.mjs'],
    npmRebuild: false,
    forceCodeSigning: signed,
    electronFuses: FUSES,
    publish: signed && target === 'win' ? [{ provider: 'generic', url: release.update.feed }] : null,
    extraMetadata: { smartsell: { unsigned: !!unsigned, release_packaged: true } },
  };
  if (electronDist) config.electronDist = electronDist;
  if (electronVersion) config.electronVersion = electronVersion;
  if (target === 'mac') {
    const archs = arch ? [arch] : ['arm64', 'x64'];
    config.mac = {
      identity: unsigned ? '-' : macIdentity,
      hardenedRuntime: signed,
      notarize: signed,
      category: 'public.app-category.business',
      target: unsigned ? [{ target: 'dmg', arch: archs }, { target: 'zip', arch: archs }] : ['dmg', 'zip'],
      artifactName: artifactName('mac', '${arch}'),
    };
    config.dmg = { sign: false, writeUpdateInfo: false };
  } else {
    config.win = {
      target: [{ target: 'nsis', arch: ['x64'] }],
      artifactName: artifactName('win', 'x64'),
      verifyUpdateCodeSignature: !unsigned,
      ...(signed && { signtoolOptions: { publisherName: [winPublisher], signingHashAlgorithms: ['sha256'] } }),
    };
    config.nsis = {
      oneClick: true, perMachine: false, allowElevation: false, runAfterFinish: true,
      deleteAppDataOnUninstall: false, differentialPackage: false, artifactName: artifactName('win', 'x64'),
      shortcutName: PRODUCT_NAME, uninstallDisplayName: PRODUCT_NAME,
    };
  }
  return config;
}

/** Installers are built on their own OS: electron-builder's NSIS target runs only on Windows here (§8.18). */
export function hostTarget(platform) {
  if (platform === 'darwin') return 'mac';
  if (platform === 'win32') return 'win';
  return null;
}
