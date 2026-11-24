import { chmodSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { defaultHubDir, HUB_DEFAULT_PORT } from '../config.js';
import { nodeExec, pnpmCommand, type Exec } from './exec.js';
import { mergeHubEnv, randomSecretHex, readHubEnvFile } from './hub-env.js';
import { configureServe, findTailscale, hostnameLooksPersonal, keyExpiryWarning, serveStatus, TAILSCALE_TEXT, tailscaleStatus, TailscaleError } from './tailscale.js';

export const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

export interface HubInitOptions {
  hubDir?: string;
  /** Answer yes to every question (unattended install-hub runs). */
  yes?: boolean;
  /** Force the service question's answer; undefined asks. */
  service?: boolean;
  /** Force the worker:release question's answer; undefined asks. */
  workerRelease?: boolean;
  skipWebBuild?: boolean;
}

export interface HubInitDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exec?: Exec;
  log?: (line: string) => void;
  ask?: (question: string, defaultYes: boolean) => Promise<boolean>;
  repoRoot?: string;
  now?: () => Date;
  /** Path existence check used for locating the Tailscale binary. */
  exists?: (path: string) => boolean;
}

export interface HubInitResult { ok: boolean; hubDir: string; publicOrigin?: string; setupUrl?: string; message?: string }

export async function terminalAsk(question: string, defaultYes: boolean) {
  if (!process.stdin.isTTY) return defaultYes;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
    return answer ? ['y', 'yes', '是', '好'].includes(answer) : defaultYes;
  } finally {
    rl.close();
  }
}

function newestMtime(path: string, depth = 0): number {
  if (!existsSync(path)) return 0;
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.mtimeMs;
  if (depth > 12) return stat.mtimeMs;
  let newest = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    newest = Math.max(newest, newestMtime(join(path, entry.name), depth + 1));
  }
  return newest;
}

/** True when `apps/web/dist/index.html` is newer than every Web source the build reads (§2.5 step 7). */
export function webDistFresh(repoRoot: string, distDir = join(repoRoot, 'apps/web/dist')) {
  const index = join(distDir, 'index.html');
  if (!existsSync(index)) return false;
  const built = statSync(index).mtimeMs;
  const sources = ['apps/web/src', 'apps/web/index.html', 'apps/web/package.json', 'apps/web/vite.config.ts', 'apps/web/public',
    'packages/ui/src', 'packages/sdk/src', 'packages/contracts/src', 'pnpm-lock.yaml'];
  return sources.every(source => newestMtime(join(repoRoot, source)) <= built);
}

export function setupUrl(publicOrigin: string, setupToken: string) {
  return `${publicOrigin}/setup#setup-token=${setupToken}`;
}

/** `pnpm hub:init` (§2.5): an interactive, re-runnable first-time setup. */
export async function hubInit(options: HubInitOptions = {}, deps: HubInitDeps = {}): Promise<HubInitResult> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? nodeExec;
  const log = deps.log ?? ((line: string) => console.log(line));
  const ask = options.yes ? async () => true : deps.ask ?? terminalAsk;
  const repoRoot = deps.repoRoot ?? REPO_ROOT;
  const hubDir = resolve(options.hubDir ?? (env.SMARTSELL_HUB_DIR || defaultHubDir(platform, env)));
  const stop = (message: string): HubInitResult => { log(`[停止] ${message}`); return { ok: false, hubDir, message }; };

  // 1. Hub directory, private to this user.
  mkdirSync(hubDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(hubDir, 'logs'), { recursive: true, mode: 0o700 });
  if (platform !== 'win32') {
    chmodSync(hubDir, 0o700);
    chmodSync(join(hubDir, 'logs'), 0o700);
  }
  log(`[1/10] 中樞資料夾：${hubDir}`);

  // 2–3. Tailscale CLI and this machine's ts.net name.
  const bin = await findTailscale(exec, { platform, env, exists: deps.exists });
  if (!bin) return stop(TAILSCALE_TEXT.notFound);
  let self;
  try { self = await tailscaleStatus(exec, bin); } catch (error) {
    return stop(error instanceof TailscaleError ? error.message : `讀取 Tailscale 狀態失敗：${(error as Error).message}`);
  }
  if (!self.running) return stop(TAILSCALE_TEXT.notRunning(self.backendState));
  if (!self.dnsName || !self.origin) return stop(TAILSCALE_TEXT.noDnsName);
  const tailnetOrigin = self.origin;
  log(`[2/10] Tailscale 名稱：${self.dnsName}`);
  if (hostnameLooksPersonal(self.dnsName)) {
    log(TAILSCALE_TEXT.certificateTransparency(self.dnsName));
    if (!await ask(`仍要用 ${self.dnsName} 這個名稱繼續嗎？`, false)) return stop('已停止。改好機器名稱後請重跑 pnpm hub:init。');
  }

  // 4. tailscale serve → 127.0.0.1:<port>; verify it took effect.
  const port = Number(readHubEnvFile(hubDir, platform).values.PORT ?? HUB_DEFAULT_PORT);
  const configured = await configureServe(exec, bin, port);
  if (!configured.ok) {
    if (configured.detail) log(configured.detail);
    return stop(configured.message);
  }
  const serve = await serveStatus(exec, bin, port, self.dnsName);
  if (!serve.ok) return stop(serve.reason ?? TAILSCALE_TEXT.serveMissing(`http://127.0.0.1:${port}`));
  log(`[3/10] tailscale serve：https://${self.dnsName} → http://127.0.0.1:${port}`);
  // E46: `serve` on 443 just closed any Funnel there; one on another port that still reaches the hub is reported.
  if (serve.funnel) log(`[警告] ${TAILSCALE_TEXT.funnelOn(serve.funnel_host_port!, `http://127.0.0.1:${port}`)}`);

  // 5. Node key expiry.
  log(`[4/10] ${TAILSCALE_TEXT.keyExpiry}`);
  const expiry = keyExpiryWarning(self.keyExpiry, deps.now?.());
  if (expiry) log(`[警告] ${TAILSCALE_TEXT.keyExpiringSoon(expiry.date, expiry.days)}`);

  // 6. hub.env: keep every existing value.
  const merged = mergeHubEnv(hubDir, { APP_SECRET: randomSecretHex(), SETUP_TOKEN: randomSecretHex(), PUBLIC_ORIGIN: tailnetOrigin, PORT: String(HUB_DEFAULT_PORT) }, platform);
  const settings = readHubEnvFile(hubDir, platform).values;
  log(`[5/10] 已寫入 ${merged.path}（新增：${merged.added.join('、') || '無'}；保留原值：${merged.kept.join('、') || '無'}）`);
  const publicOrigin = settings.PUBLIC_ORIGIN ?? tailnetOrigin;
  if (publicOrigin !== tailnetOrigin) {
    log(`[警告] hub.env 的 PUBLIC_ORIGIN 是 ${publicOrigin}，但這台機器的 Tailscale 網址是 ${tailnetOrigin}。若機器改過名稱，請把 hub.env 的 PUBLIC_ORIGIN 改成 ${tailnetOrigin}，所有 Worker 也要重新配對。`);
  }

  // 7. Web build.
  if (options.skipWebBuild) log('[6/10] 略過 Web 建置（--skip-web-build）');
  else if (webDistFresh(repoRoot)) log('[6/10] Web 已是最新，略過建置');
  else {
    log('[6/10] 建置 Web：pnpm --filter @smartsell/web build');
    const built = await exec(pnpmCommand(platform), ['--filter', '@smartsell/web', 'build'], { cwd: repoRoot, inherit: true, timeoutMs: 15 * 60_000 });
    if (built.code !== 0) return stop(`Web 建置失敗（pnpm --filter @smartsell/web build，結束碼 ${built.code}）。請看上面的錯誤訊息，修正後重跑 pnpm hub:init。`);
  }

  // 7b. Relay bundle served at GET /agent/relay.mjs (§6.1, S5 ledger item 6); without it the route answers 503.
  log('[6/10] 建置 relay：pnpm --filter @smartsell/agent-relay build');
  const relay = await exec(pnpmCommand(platform), ['--filter', '@smartsell/agent-relay', 'build'], { cwd: repoRoot, inherit: true, timeoutMs: 5 * 60_000 });
  if (relay.code !== 0) {
    log(`[警告] relay 建置失敗（結束碼 ${relay.code}）。中樞仍可使用，但 GET /agent/relay.mjs 會回 503 RELAY_BUNDLE_MISSING；修正後執行 pnpm --filter @smartsell/agent-relay build。`);
  }

  // 8. Worker installers.
  const downloads = join(hubDir, 'worker-downloads');
  const release = options.workerRelease ?? await ask('要現在建置這台機器能建置的 SmartSell Worker 安裝包嗎？（pnpm worker:release）', true);
  if (release) {
    mkdirSync(downloads, { recursive: true, mode: 0o700 });
    log(`[7/10] 建置 Worker 安裝包：pnpm worker:release --out "${downloads}"`);
    const built = await exec(pnpmCommand(platform), ['worker:release', '--out', downloads], { cwd: repoRoot, inherit: true, timeoutMs: 60 * 60_000 });
    if (built.code !== 0) log(`[警告] Worker 安裝包建置失敗（結束碼 ${built.code}）。中樞仍可使用；修正後可再執行 pnpm worker:release --out "${downloads}"。`);
  } else {
    log('[7/10] 略過 Worker 安裝包；之後可執行 pnpm worker:release。');
  }
  if (platform !== 'win32') {
    log(`[提示] Windows 安裝包只能在 Windows 機器上建置：在那台機器安裝 git、Node 24 與 pnpm，取得原始碼後執行 pnpm worker:release --win，再把 dist/worker-release/ 的檔案複製到中樞的 ${downloads}（例如 tailscale file cp）。`);
  } else {
    log(`[提示] macOS 安裝包要在 Mac 上建置：執行 pnpm worker:release 後，把 dist/worker-release/ 的檔案複製到中樞的 ${downloads}。`);
  }

  // 9. Service.
  const service = options.service ?? await ask('要把中樞安裝成開機或登入後自動執行的服務嗎？（pnpm hub:service install）', true);
  if (service) {
    log('[8/10] 安裝服務：pnpm hub:service install');
    const installed = await exec(process.execPath, ['--import', 'tsx', join(repoRoot, 'scripts/hub-service.mjs'), 'install', '--hub-dir', hubDir],
      { cwd: repoRoot, inherit: true, timeoutMs: 15 * 60_000, env: { ...env, SMARTSELL_HUB_DIR: hubDir } });
    if (installed.code !== 0) log('[警告] 服務沒有安裝成功，請看上面的說明；修正後執行 pnpm hub:service install。');
  } else {
    log('[8/10] 略過服務安裝；可用 pnpm hub 手動啟動，或之後執行 pnpm hub:service install。');
  }

  // 10. First-run URL.
  log('[9/10] 請把你的筆電與手機也加入同一個 tailnet，通知中的連結才打得開。');
  const url = setupUrl(publicOrigin, settings.SETUP_TOKEN!);
  log('[10/10] 在已加入 tailnet 的瀏覽器開啟下面的網址，建立擁有者帳號（建立後這個網址就會失效）：');
  log(url);
  return { ok: true, hubDir, publicOrigin, setupUrl: url };
}
