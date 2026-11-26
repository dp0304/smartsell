// pnpm worker:release [--out <dir>] [--arch arm64|x64] [--win] [--skip-build] [--print-config]
//                     [--electron-zip-dir <dir> --electron-version <v> --allow-electron-version]
//
// Builds the unsigned SmartSell Worker installers for this OS (§8.18) and writes, next to each package,
// latest-<platform>.json = {version, platform, file, sha256, bytes, built_at, signature} (S1 ledger: exactly these keys).
//
// Release signature (security review S1): `signature` is an Ed25519 signature (base64) over the canonical JSON
// {platform, sha256, version} (apps/connector-desktop/src/release-signature.ts). The private key is the PEM file named by
// SMARTSELL_RELEASE_SIGNING_KEY; when unset, ~/.smartsell/worker-release-key.pem (created on first use, mode 0600, never
// inside the repo). Its public key is built into the App (RELEASE.releasePublicKey), and the App refuses an update whose
// signature does not verify. Back up the key file and use the same one on every build machine: Workers built with one
// key never accept an update signed by another, they have to be reinstalled by hand.
//   macOS host  → mac-arm64 and mac-x64: .dmg (the file the manifest names) and .zip
//   Windows host → win-x64: NSIS .exe (`--win`; NSIS cannot be built on macOS or Linux)
// On the hub the default output is <hubDir>/worker-downloads; elsewhere dist/worker-release/, with a reminder to
// copy the files to the hub (for example `tailscale file cp`). A package is copied before its manifest, so the hub
// never advertises a file that is not there yet.
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defaultHubDir } from '../apps/server/src/config.ts';
import { encodeReleasePublicKey, releasePrivateKey, signRelease } from '../apps/connector-desktop/src/release-signature.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_DIR = join(REPO_ROOT, 'apps', 'connector-desktop');
const VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,64})?$/;
export const MANIFEST_KEYS = ['version', 'platform', 'file', 'sha256', 'bytes', 'built_at', 'signature'];
export const SIGNING_KEY_ENV = 'SMARTSELL_RELEASE_SIGNING_KEY';
export const defaultSigningKeyPath = (home = homedir()) => join(home, '.smartsell', 'worker-release-key.pem');

/**
 * The Ed25519 release signing key: the PEM named by SMARTSELL_RELEASE_SIGNING_KEY, else ~/.smartsell/worker-release-key.pem,
 * which is created (mode 0600) when it does not exist yet. A key inside the repository is refused so it is never committed.
 * Returns the private KeyObject and the base64 SPKI public key to build into the App; the private key is never printed.
 */
export function loadSigningKey({ env = process.env, home = homedir(), repoRoot = REPO_ROOT, platform = process.platform } = {}) {
  const configured = env[SIGNING_KEY_ENV]?.trim();
  const path = resolve(configured || defaultSigningKeyPath(home));
  const inside = relative(resolve(repoRoot), path);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    throw new Error(`發行簽章私鑰不可放在原始碼資料夾內（${path}），以免被提交；請放到 ~/.smartsell/ 之類的地方，並設定 ${SIGNING_KEY_ENV}。`);
  }
  let created = false;
  if (!existsSync(path)) {
    if (configured) throw new Error(`${SIGNING_KEY_ENV} 指向的檔案不存在：${path}`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const { privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(path, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
    if (platform !== 'win32') chmodSync(path, 0o600);
    created = true;
  }
  if (platform !== 'win32' && (statSync(path).mode & 0o077) !== 0) {
    throw new Error(`發行簽章私鑰 ${path} 其他使用者也讀得到；請執行 chmod 600 "${path}" 後再試。`);
  }
  let privateKey;
  try { privateKey = releasePrivateKey(readFileSync(path, 'utf8')); } catch (error) {
    throw new Error(`無法讀取發行簽章私鑰 ${path}：需要 Ed25519 的 PKCS#8 PEM（${error.message}）`);
  }
  return { path, created, privateKey, publicKey: encodeReleasePublicKey(privateKey) };
}

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

/** The manifest; with `signingKey` it carries `signature` over {platform, sha256, version} (release-signature.ts). */
export function manifestFor({ version, platform, file, sha256, bytes, builtAt, signingKey }) {
  if (!VERSION.test(version)) throw new Error(`version ${version} is not major.minor.patch[-pre]`);
  if (!['mac-arm64', 'mac-x64', 'win-x64'].includes(platform)) throw new Error(`unknown platform ${platform}`);
  if (basename(file) !== file || !/^[A-Za-z0-9][A-Za-z0-9._ -]{0,199}$/.test(file) || !['.zip', '.dmg', '.exe'].includes(extname(file).toLowerCase())) {
    throw new Error(`file ${file} must be a .zip, .dmg or .exe name without a path`);
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('sha256 must be 64 lowercase hex digits');
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw new Error('bytes must be a positive integer');
  const manifest = { version, platform, file, sha256, bytes, built_at: builtAt };
  return signingKey ? { ...manifest, signature: signRelease({ version, platform, sha256 }, signingKey) } : manifest;
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

/** Copies the packages into `outDir` (atomic rename) and then writes the signed latest-<platform>.json. */
export async function publishRelease({ outDir, artifacts, platforms, version, signingKey, now = () => new Date() }) {
  if (!signingKey) throw new Error('publishRelease needs the release signing key (loadSigningKey)');
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
    const manifest = manifestFor({ version, platform, file, sha256: await sha256File(path), bytes: statSync(path).size, builtAt: now().toISOString(), signingKey });
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
    const key = loadSigningKey({ env: deps.env ?? process.env, home: deps.home ?? homedir(), platform: hostPlatform });
    log(key.created
      ? `已建立發行簽章金鑰 ${key.path}（權限 0600）。請備份它，之後每次建置都用同一把：遺失或換了金鑰，已安裝的 Worker 會拒絕更新，只能手動重新安裝。`
      : `發行簽章金鑰：${key.path}`);
    log(`  發行公鑰（內建在 App 裡）：${key.publicKey}`);
    if (!args.skipBuild) {
      log('1/3 建置 App（RELEASE.packaged = true，內建發行公鑰）：node scripts/build.mjs --packaged');
      run(node, ['scripts/build.mjs', '--packaged'], { cwd: APP_DIR, env: { ...process.env, SMARTSELL_RELEASE_PUBLIC_KEY: key.publicKey } });
    } else if (!readFileSync(join(APP_DIR, 'dist', 'main.cjs'), 'utf8').includes(key.publicKey)) {
      throw new Error('dist/ 不是以這把發行金鑰建置的（--skip-build）；請拿掉 --skip-build 重新建置，否則新版 Worker 驗證不了之後的更新。');
    }
    log(`2/3 打包 ${platforms.join('、')}（未簽章）`);
    rmSync(staging, { recursive: true, force: true });
    const output = run(node, [...packageArgs, '--out', staging], { cwd: APP_DIR });
    const line = output.split('\n').reverse().find(each => each.startsWith('ARTIFACTS '));
    if (!line) throw new Error('打包沒有回報產生的檔案');
    const artifacts = JSON.parse(line.slice('ARTIFACTS '.length));
    log(`3/3 寫入 ${out.dir}`);
    const written = await publishRelease({ outDir: out.dir, artifacts, platforms, version, signingKey: key.privateKey });
    for (const { manifest, manifestPath } of written) log(`  ${manifest.platform}: ${manifest.file}  ${manifest.bytes} bytes  sha256 ${manifest.sha256}（已簽章）\n  → ${manifestPath}`);
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
