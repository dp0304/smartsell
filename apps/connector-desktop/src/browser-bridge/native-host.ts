// Registers the native messaging host com.smartsell.worker for the owner's Chrome, so the SmartSell extension can reach
// this Worker (core-automation-proposal §3.2). The host is a byte relay between Chrome's stdio and the bridge socket:
// - macOS / Linux: `nc -U <socket>` (Apple ships nc; no runtime to install, nothing of ours runs inside Chrome's child);
// - Windows: a PowerShell script that copies stdio to and from the bridge's named pipe.
// The packaged App cannot be the host itself: its Electron fuse runAsNode is off on purpose (§8.18).
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const NATIVE_HOST_NAME = 'com.smartsell.worker';
/**
 * Ids allowed to connect: the unpacked extension shipped with the Worker (fixed by the `key` in extension/manifest.json).
 * A Chrome Web Store listing gets its own id; add it here when it exists.
 */
export const EXTENSION_IDS = ['ghfcogpklmadimibmifjhfhlcncpcncp'] as const;

/** Per-user NativeMessagingHosts folders of Chrome channels (and Chromium) on this platform. */
export function chromeHostDirs(platform = process.platform, home = homedir(), env = process.env): string[] {
  if (platform === 'darwin') {
    const root = join(home, 'Library', 'Application Support');
    return ['Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome Canary', 'Chromium'].map(dir => join(root, dir, 'NativeMessagingHosts'));
  }
  if (platform === 'linux') {
    const config = env.XDG_CONFIG_HOME || join(home, '.config');
    return ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'chromium'].map(dir => join(config, dir, 'NativeMessagingHosts'));
  }
  return [];
}

/** Registry keys (HKCU) Chrome reads on Windows. */
export const WINDOWS_REGISTRY_KEYS = [`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
  `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`];

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function hostManifest(path: string, extensionIds: readonly string[] = EXTENSION_IDS) {
  return {
    name: NATIVE_HOST_NAME,
    description: 'SmartSell Worker: lets the SmartSell extension reach the Worker App on this computer',
    path, type: 'stdio',
    allowed_origins: extensionIds.map(id => `chrome-extension://${id}/`),
  };
}

export function posixWrapper(socketPath: string, nc = '/usr/bin/nc') {
  return `#!/bin/sh\n# SmartSell Worker native messaging host: relays Chrome's messages to the running Worker, byte for byte.\nexec ${shellQuote(nc)} -U ${shellQuote(socketPath)}\n`;
}

export function windowsWrapper() {
  return '@echo off\r\npowershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0smartsell-native-host.ps1"\r\n';
}

export function windowsRelay(pipePath: string) {
  const name = pipePath.replace(/^\\\\\.\\pipe\\/, '');
  return [
    '# SmartSell Worker native messaging host: relays Chrome\'s messages to the running Worker, byte for byte.',
    `$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${name.replaceAll("'", "''")}', [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::Asynchronous)`,
    'try { $client.Connect(3000) } catch { exit 1 }',
    '$stdin = [Console]::OpenStandardInput()',
    '$stdout = [Console]::OpenStandardOutput()',
    '$up = $stdin.CopyToAsync($client)',
    '$down = $client.CopyToAsync($stdout)',
    '[void][System.Threading.Tasks.Task]::WaitAny(@($up, $down))',
    '$client.Dispose()',
    '',
  ].join('\r\n');
}

export interface RegisterOptions {
  dataDir: string;
  socketPath: string;
  platform?: NodeJS.Platform;
  home?: string;
  /** Override for tests: write the manifest into these folders instead of the user's Chrome folders. */
  hostDirs?: string[];
  extensionIds?: readonly string[];
  /** Windows registry writer; tests replace it. */
  reg?(args: string[]): Promise<void>;
}

export interface Registration { wrapper: string; manifests: string[]; registry: string[] }

const runReg = async (args: string[]) => { await promisify(execFile)('reg', args, { windowsHide: true }); };

/**
 * Writes the wrapper into <dataDir>/native-host and the host manifest into each Chrome channel that is installed
 * (its user-data folder exists), or into `hostDirs`. Safe to run on every start; returns what it wrote.
 */
export async function registerNativeHost(options: RegisterOptions): Promise<Registration> {
  const platform = options.platform ?? process.platform;
  const dir = join(options.dataDir, 'native-host');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifests: string[] = [];
  const registry: string[] = [];
  if (platform === 'win32') {
    const wrapper = join(dir, 'smartsell-native-host.cmd');
    writeFileSync(join(dir, 'smartsell-native-host.ps1'), windowsRelay(options.socketPath));
    writeFileSync(wrapper, windowsWrapper());
    const manifest = join(dir, `${NATIVE_HOST_NAME}.json`);
    writeFileSync(manifest, `${JSON.stringify(hostManifest(wrapper, options.extensionIds), null, 2)}\n`);
    manifests.push(manifest);
    for (const dirOverride of options.hostDirs ?? []) {
      mkdirSync(dirOverride, { recursive: true });
      const copy = join(dirOverride, `${NATIVE_HOST_NAME}.json`);
      writeFileSync(copy, `${JSON.stringify(hostManifest(wrapper, options.extensionIds), null, 2)}\n`);
      manifests.push(copy);
    }
    if (!options.hostDirs) {
      for (const key of WINDOWS_REGISTRY_KEYS) {
        await (options.reg ?? runReg)(['add', key, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f']);
        registry.push(key);
      }
    }
    return { wrapper, manifests, registry };
  }
  const wrapper = join(dir, 'smartsell-native-host');
  writeFileSync(wrapper, posixWrapper(options.socketPath, platform === 'darwin' ? '/usr/bin/nc' : 'nc'), { mode: 0o700 });
  const targets = options.hostDirs ?? chromeHostDirs(platform, options.home ?? homedir()).filter(hostDir => existsSync(join(hostDir, '..')));
  for (const hostDir of targets) {
    mkdirSync(hostDir, { recursive: true });
    const manifest = join(hostDir, `${NATIVE_HOST_NAME}.json`);
    writeFileSync(manifest, `${JSON.stringify(hostManifest(wrapper, options.extensionIds), null, 2)}\n`);
    manifests.push(manifest);
  }
  return { wrapper, manifests, registry };
}

/** Removes what registerNativeHost wrote (the owner switched back to separate profiles, or uninstall). */
export async function unregisterNativeHost(options: Omit<RegisterOptions, 'socketPath'>) {
  const platform = options.platform ?? process.platform;
  const targets = options.hostDirs ?? chromeHostDirs(platform, options.home ?? homedir());
  for (const hostDir of targets) rmSync(join(hostDir, `${NATIVE_HOST_NAME}.json`), { force: true });
  if (platform === 'win32' && !options.hostDirs) {
    for (const key of WINDOWS_REGISTRY_KEYS) await (options.reg ?? runReg)(['delete', key, '/f']).catch(() => {});
  }
  rmSync(join(options.dataDir, 'native-host'), { recursive: true, force: true });
}
