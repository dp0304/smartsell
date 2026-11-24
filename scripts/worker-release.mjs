// pnpm worker:release [--out <dir>] [--arch arm64|x64] [--win] [--skip-build] [--print-config]
//                     [--electron-zip-dir <dir> --electron-version <v> --allow-electron-version]
//
// Builds the unsigned SmartSell Worker installers for this OS (§8.18) and writes, next to each package,
// latest-<platform>.json = {version, platform, file, sha256, bytes, built_at} (S1 ledger: exactly these keys).
//   macOS host  → mac-arm64 and mac-x64: .dmg (the file the manifest names) and .zip
//   Windows host → win-x64: NSIS .exe (`--win`; NSIS cannot be built on macOS or Linux)
// On the hub the default output is <hubDir>/worker-downloads; elsewhere dist/worker-release/, with a reminder to
// copy the files to the hub (for example `tailscale file cp`). A package is copied before its manifest, so the hub
// never advertises a file that is not there yet.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultHubDir } from '../apps/server/src/config.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'connector-desktop');
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/;
export const MANIFEST_KEYS = ['version', 'platform', 'file', 'sha256', 'bytes', 'built_at'];

export function parseReleaseArgs(argv) {
  const out = { out: null, arch: null, win: false, skipBuild: false, printConfig: false, electronZipDir: null, electronVersion: null, allowElectronVersion: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    const value = () => {
      const next = argv[++index];
      if (next === undefined || next.startsWith('--')) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case '--': break;
      case '--out': out.out = resolve(value()); break;
      case '--arch': out.arch = value(); if (!['arm64', 'x64'].includes(out.arch)) throw new Error('--arch must be arm64 or x64'); break;
      case '--win': out.win = true; break;
      case '--skip-build': out.skipBuild = true; break;
      case '--print-config': out.printConfig = true; break;
      case '--electron-zip-dir': out.electronZipDir = resolve(value()); break;
      case '--electron-version': out.electronVersion = value(); break;
      case '--allow-electron-version': out.allowElectronVersion = true; break;
      case '--help': case '-h': out.help = true; break;
      default: throw new Error(`Unknown option ${arg}`);
    }
  }
  return out;
}

/** <hubDir>/worker-downloads when this machine is the hub (hub.env exists), else dist/worker-release/. */
export function defaultOutDir({ env = process.env, platform = process.platform, repoRoot = REPO_ROOT, exists = existsSync } = {}) {
  const hubDir = env.SMARTSELL_HUB_DIR || defaultHubDir(platform, env);
  if (exists(join(hubDir, 'hub.env'))) return { dir: join(hubDir, 'worker-downloads'), onHub: true };
  return { dir: join(repoRoot, 'dist', 'worker-release'), onHub: false };
}

/** Which installers this host can build. */
export function releasePlatforms(hostPlatform, args) {
  if (args.win) {
    if (hostPlatform !== 'win32') {
      throw new Error('Windows 安裝包（NSIS）只能在 Windows 機器上建置：在那台機器安裝 git、Node 24 與 pnpm，取得原始碼後執行 pnpm worker:release --win，再把 dist/worker-release/ 的檔案複製到中樞的 <hubDir>/worker-downloads/。');
    }
    return ['win-x64'];
  }
  if (hostPlatform === 'darwin') return args.arch ? [`mac-${args.arch}`] : ['mac-arm64', 'mac-x64'];
  if (hostPlatform === 'win32') return ['win-x64'];
  throw new Error('Worker 安裝包要在 macOS（dmg、zip）或 Windows（NSIS）上建置。');
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

export function manifestFor({ version, platform, file, sha256, bytes, builtAt }) {
  if (!VERSION.test(version)) throw new Error(`version ${version} is not major.minor.patch[-pre]`);
  if (!['mac-arm64', 'mac-x64', 'win-x64'].includes(platform)) throw new Error(`unknown platform ${platform}`);
  if (basename(file) !== file || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/.test(file) || !['.zip', '.dmg', '.exe'].includes(extname(file).toLowerCase())) {
    throw new Error(`file ${file} must be a .zip, .dmg or .exe name without a path`);
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('sha256 must be 64 lowercase hex digits');
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('bytes must be a positive integer');
  return { version, platform, file, sha256, bytes, built_at: builtAt };
}

/** The manifest names the dmg on macOS (the update flow opens it) and the NSIS exe on Windows. */
export function choosePackage(artifacts, platform) {
  const mine = artifacts.filter(item => item.platform === platform);
  const wanted = platform === 'win-x64' ? ['.exe'] : ['.dmg', '.zip'];
  for (const ext of wanted) {
    const found = mine.find(item => extname(item.path).toLowerCase() === ext);
    if (found) return found;
  }
  return null;
}

/** Copies the packages into `outDir` (atomic rename) and then writes latest-<platform>.json. */
export async function publishRelease({ outDir, artifacts, platforms, version, now = () => new Date() }) {
  mkdirSync(outDir, { recursive: true });
  const written = [];
  for (const platform of platforms) {
    const chosen = choosePackage(artifacts, platform);
    if (!chosen) throw new Error(`沒有產生 ${platform} 的安裝包`);
    for (const item of artifacts.filter(each => each.platform === platform)) {
      const target = join(outDir, basename(item.path));
      const temp = `${target}.partial`;
      copyFileSync(item.path, temp);
      renameSync(temp, target);
    }
    const file = basename(chosen.path);
    const path = join(outDir, file);
    const manifest = manifestFor({ version, platform, file, sha256: await sha256File(path), bytes: statSync(path).size, builtAt: now().toISOString() });
    const manifestPath = join(outDir, `latest-${platform}.json`);
    writeFileSync(`${manifestPath}.partial`, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(`${manifestPath}.partial`, manifestPath);
    written.push({ manifest, manifestPath, path });
  }
  return written;
}

function run(file, args, options) {
  const result = spawnSync(file, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.status !== 0) throw new Error(`${[file, ...args].join(' ')} 失敗（結束碼 ${result.status ?? result.error?.message}）`);
  return result.stdout ?? '';
}

export async function main(argv, deps = {}) {
  const log = deps.log ?? (line => console.log(line));
  let args;
  try { args = parseReleaseArgs(argv); } catch (error) { log(`[錯誤] ${error.message}`); return 2; }
  if (args.help) { log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(line => line.startsWith('//')).map(line => line.slice(3)).join('\n')); return 0; }
  const hostPlatform = deps.platform ?? process.platform;
  let platforms;
  try { platforms = releasePlatforms(hostPlatform, args); } catch (error) { log(`[錯誤] ${error.message}`); return 2; }
  const version = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).version;
  const out = args.out ? { dir: args.out, onHub: false } : defaultOutDir({ platform: hostPlatform });
  const packageArgs = ['scripts/package.mjs', '--unsigned', ...(args.arch ? ['--arch', args.arch] : []),
    ...(args.electronZipDir ? ['--electron-zip-dir', args.electronZipDir] : []), ...(args.electronVersion ? ['--electron-version', args.electronVersion] : []),
    ...(args.allowElectronVersion ? ['--allow-electron-version'] : [])];
  const node = process.execPath;
  if (args.printConfig) { run(node, [...packageArgs, '--print-config'], { cwd: APP_DIR }); return 0; }
  const staging = join(APP_DIR, 'release', 'unsigned');
  try {
    if (!args.skipBuild) {
      log('1/3 建置 App（RELEASE.packaged = true）：node scripts/build.mjs --packaged');
      run(node, ['scripts/build.mjs', '--packaged'], { cwd: APP_DIR });
    }
    log(`2/3 打包 ${platforms.join('、')}（未簽章）`);
    rmSync(staging, { recursive: true, force: true });
    const output = run(node, [...packageArgs, '--out', staging], { cwd: APP_DIR });
    const line = output.split('\n').reverse().find(each => each.startsWith('ARTIFACTS '));
    if (!line) throw new Error('打包沒有回報產生的檔案');
    const artifacts = JSON.parse(line.slice('ARTIFACTS '.length));
    log(`3/3 寫入 ${out.dir}`);
    const written = await publishRelease({ outDir: out.dir, artifacts, platforms, version });
    for (const { manifest, manifestPath } of written) log(`  ${manifest.platform}: ${manifest.file}  ${manifest.bytes} bytes  sha256 ${manifest.sha256}\n  → ${manifestPath}`);
    if (!out.onHub) log(`把 ${out.dir} 裡的檔案複製到中樞的 <hubDir>/worker-downloads/（例如 tailscale file cp），中樞的下載頁就會列出它們。`);
    log('這是未簽章的安裝包：macOS 第一次開啟要在「應用程式」對它按右鍵 →「打開」；Windows 的 SmartScreen 要按「其他資訊」→「仍要執行」。舊版 SmartSell Connector 要重新配對。');
    return 0;
  } catch (error) {
    log(`[失敗] ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
