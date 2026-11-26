import { statfsSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { configuration, HubConfigError } from '../config.js';
import { inspectWorkerRelease, WORKER_PLATFORMS } from '../worker-downloads.js';
import { nodeExec, type Exec } from './exec.js';
import { BACKUP_STALE_MS, backupDirectory, latestBackup } from './backup.js';
import { prepareHubEnvironment, runHubChecks } from './startup.js';
import { describeHubStatus, readHubStatus } from './status-file.js';
import { agentPlistPath, DAEMON_PLIST, fileVaultStatus, hubPort, installedMode, MAC_NOTES, macAutoLogin, readyz, serviceNodeIssue, serviceState,
  WINDOWS_TASK_NAME } from './service.js';
import { findTailscale, keyExpiryWarning, serveStatus, serveTarget, TAILSCALE_TEXT, tailscaleStatus } from './tailscale.js';

export type DoctorLevel = 'ok' | 'warn' | 'error';
export interface DoctorLine { level: DoctorLevel; text: string }
export const MIN_FREE_BYTES = 10 * 1024 ** 3;

export interface DoctorDeps {
  exec?: Exec;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  uid?: number;
  fetch?: typeof fetch;
  now?: () => Date;
  freeBytes?: (path: string) => number | undefined;
  log?: (line: string) => void;
  /** Reads an installed launchd plist (AO-3); defaults to the file on disk. */
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
}

const defaultFreeBytes = (path: string) => {
  try { const stat = statfsSync(path); return stat.bavail * stat.bsize; } catch { return undefined; }
};

/** `pmset -g`: minutes before system sleep and disk sleep on the current power source. */
export function parsePmset(output: string) {
  const value = (key: string) => {
    const match = new RegExp(`^\\s*${key}\\s+(\\d+)`, 'm').exec(output);
    return match ? Number(match[1]) : undefined;
  };
  return { sleep: value('sleep'), disksleep: value('disksleep') };
}

/** `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE`: AC standby timeout in seconds. */
export function parsePowercfgStandby(output: string) {
  const match = /Current AC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(output);
  return match ? parseInt(match[1], 16) : undefined;
}

/** Every check of §2.13; each problem is one line the owner can act on. */
export async function runDoctor(argv: readonly string[], deps: DoctorDeps = {}): Promise<DoctorLine[]> {
  const platform = deps.platform ?? process.platform;
  const exec = deps.exec ?? nodeExec;
  const now = deps.now ?? (() => new Date());
  const env = { ...(deps.env ?? process.env) };
  const home = deps.home ?? homedir();
  const uid = deps.uid ?? process.getuid?.() ?? 0;
  const lines: DoctorLine[] = [];
  const ok = (text: string) => lines.push({ level: 'ok', text });
  const warn = (text: string) => lines.push({ level: 'warn', text });
  const error = (text: string) => lines.push({ level: 'error', text });

  const { values } = parseArgs({ args: argv.filter(arg => arg !== '--'), options: { 'hub-dir': { type: 'string' } } });
  const prepared = prepareHubEnvironment(values['hub-dir'] ? ['--hub-dir', values['hub-dir']] : [], env, platform);
  const hubDir = prepared.hubDir;
  ok(`中樞資料夾：${hubDir}`);
  for (const issue of prepared.issues) (issue.level === 'error' ? error : warn)(issue.message);

  // Configuration and startup checks, exactly as hub.ts --check runs them.
  let config: ReturnType<typeof configuration> | undefined;
  try {
    config = configuration(env);
    ok(`設定：PUBLIC_ORIGIN ${config.origin}，PORT ${config.port}`);
  } catch (failure) {
    error(failure instanceof HubConfigError || failure instanceof Error ? failure.message : String(failure));
  }
  if (config) {
    for (const issue of await runHubChecks(config, { platform, env, exec })) (issue.level === 'error' ? error : warn)(issue.message);
  }

  // Service, status.json, /readyz.
  const service = await serviceState(platform, exec, home, uid);
  (service.installed ? service.running ? ok : warn : warn)(service.installed ? service.text : `${service.text} 安裝後重開機也會自動執行。`);
  // AO-3: a service file naming a Homebrew keg that `brew upgrade` removed cannot start the hub again.
  const macMode = platform === 'darwin' ? installedMode(platform, home, deps.exists) : undefined;
  if (macMode) {
    const issue = serviceNodeIssue(macMode === 'daemon' ? DAEMON_PLIST : agentPlistPath(home), { read: deps.readFile, exists: deps.exists });
    if (issue) (issue.level === 'error' ? error : warn)(issue.text);
  }
  const status = readHubStatus(hubDir);
  const statusText = `狀態檔：${describeHubStatus(status)}`;
  if (status.status === 'ok' && status.value.state === 'running') ok(statusText);
  else if (status.status === 'ok' && status.value.state === 'stopped') warn(statusText);
  else if (status.status === 'missing') warn(statusText);
  else error(statusText);
  const port = config?.port ?? hubPort(hubDir, platform);
  if (await readyz(port, deps.fetch)) ok(`/readyz 正常（http://127.0.0.1:${port}）`);
  else error(`中樞沒有回應 http://127.0.0.1:${port}/readyz。請看上面的狀態檔說明；服務已安裝時可執行 pnpm hub:service status。`);

  // Tailscale.
  const bin = await findTailscale(exec, { platform, env });
  if (!bin) error(TAILSCALE_TEXT.notFound);
  else {
    const self = await tailscaleStatus(exec, bin).catch((failure: Error) => { error(failure.message); return undefined; });
    if (self && !self.running) error(TAILSCALE_TEXT.notRunning(self.backendState));
    if (self?.running) {
      ok(`Tailscale：${self.dnsName ?? '(沒有 MagicDNS 名稱)'}`);
      if (config && self.origin && config.origin !== self.origin) {
        error(`hub.env 的 PUBLIC_ORIGIN 是 ${config.origin}，但這台機器的 Tailscale 網址是 ${self.origin}。機器改過名稱時，請把 PUBLIC_ORIGIN 改成 ${self.origin}，並讓每台 Worker 重新配對。`);
      }
      if (self.dnsName && self.certDomains.length && !self.certDomains.includes(self.dnsName)) error(TAILSCALE_TEXT.httpsDisabled);
      else if (!self.certDomains.length) warn(`看不到 HTTPS 憑證網域。若網頁打不開：${TAILSCALE_TEXT.httpsDisabled}`);
      else ok('HTTPS 憑證已啟用');
      const expiry = keyExpiryWarning(self.keyExpiry, now());
      if (expiry) warn(TAILSCALE_TEXT.keyExpiringSoon(expiry.date, expiry.days));
      else if (self.keyExpiry) ok(`節點金鑰到期日：${self.keyExpiry.slice(0, 10)}（${TAILSCALE_TEXT.keyExpiry}）`);
      else ok('節點金鑰到期已關閉');
    }
    const serve = await serveStatus(exec, bin, port, self?.dnsName);
    if (serve.ok) ok(`tailscale serve：443 → http://127.0.0.1:${port}`);
    else error(serve.reason ?? TAILSCALE_TEXT.serveMissing(`http://127.0.0.1:${port}`));
    // E46 (SEC-3): the hub is meant for the tailnet only; Funnel makes it public.
    if (serve.funnel) error(TAILSCALE_TEXT.funnelOn(serve.funnel_host_port!, serveTarget(port)));
    else if (serve.ok) ok('沒有開啟 Tailscale Funnel（中樞只在 tailnet 內）');
  }

  // E45: daily copies of the data file in <hubDir>/backups.
  const backup = latestBackup(hubDir);
  const age = backup ? now().getTime() - backup.at : undefined;
  if (!backup) warn(`還沒有資料備份（${backupDirectory(hubDir)}）。中樞執行一分鐘後會自動備份，之後每天一份；若中樞已執行超過一天仍沒有，請看 logs/hub.out.log 的「每日備份失敗」。`);
  else if (age! > BACKUP_STALE_MS) warn(`最新的資料備份是 ${Math.floor(age! / 3_600_000)} 小時前（${backup.path}）。中樞每天備份一次；請確認中樞在執行中，並看 logs/hub.out.log 的「每日備份失敗」。`);
  else ok(`最新的資料備份：${backup.path}（${Math.max(0, Math.floor(age! / 3_600_000))} 小時前）`);

  // Disk space.
  const free = (deps.freeBytes ?? defaultFreeBytes)(hubDir);
  if (free === undefined) warn(`無法讀取 ${hubDir} 所在磁碟的剩餘空間。`);
  else if (free < MIN_FREE_BYTES) warn(`中樞磁碟只剩 ${(free / 1024 ** 3).toFixed(1)} GB（建議至少 10 GB）。請清出空間，或刪除已發布的舊媒體。`);
  else ok(`磁碟剩餘 ${(free / 1024 ** 3).toFixed(0)} GB`);

  // Power and reboot behaviour.
  if (platform === 'darwin') {
    const fileVault = await fileVaultStatus(exec);
    if (fileVault === 'on') warn('FileVault 已開啟：Mac 重開機後要有人在開機畫面輸入密碼，中樞才會執行。三種選擇：(1) 關閉 FileVault 並開啟自動登入或用 --mode daemon；(2) 保持 FileVault、加 UPS，計畫內重開機用 sudo fdesetup authrestart；(3) 改用 Windows 中樞。');
    else if (fileVault === 'off') ok('FileVault 已關閉');
    else warn('無法判斷 FileVault 狀態（fdesetup status）。');
    const mode = installedMode(platform, home);
    if (mode !== 'daemon') {
      const autoLogin = await macAutoLogin(exec);
      if (autoLogin === false) warn(MAC_NOTES.agentNeedsLogin);
      else if (autoLogin) ok('已開啟自動登入');
    }
    const pmset = await exec('pmset', ['-g'], { timeoutMs: 10_000 });
    const power = parsePmset(pmset.stdout);
    if (power.sleep === undefined) warn('無法讀取睡眠設定（pmset -g）。');
    else if (power.sleep !== 0 || (power.disksleep ?? 0) !== 0) warn(`中樞會在閒置 ${power.sleep} 分鐘後睡眠。${MAC_NOTES.sleep}`);
    else ok('睡眠已關閉');
  } else if (platform === 'win32') {
    const standby = parsePowercfgStandby((await exec('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE'], { timeoutMs: 10_000 })).stdout);
    if (standby === undefined) warn('無法讀取電源計畫的睡眠設定（powercfg）。');
    else if (standby !== 0) warn(`中樞接上電源時會在閒置 ${Math.round(standby / 60)} 分鐘後睡眠。請到 設定 → 系統 → 電源 → 螢幕與睡眠，把「接上電源時睡眠」設為「永不」。`);
    else ok('接上電源時不睡眠');
    const task = await exec('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME, '/XML'], { timeoutMs: 15_000 });
    if (task.code === 0 && /<BootTrigger/.test(task.stdout)) ok('排程工作以開機觸發（無人登入也會執行）');
    else if (task.code === 0 && /<LogonTrigger/.test(task.stdout)) warn('排程工作以登入觸發：重開機後要有人登入（或用 netplwiz 設定自動登入）中樞才會執行；建議改用 pnpm hub:service install --mode boot。');
    // AO-2: a task from before the supervisor never restarts a hub that crashed after starting.
    if (task.code === 0 && /<Exec>/.test(task.stdout) && !/--supervise/.test(task.stdout)) {
      error('排程工作是舊版設定：中樞啟動後若崩潰，工作排程器不會重新啟動它，要等下次開機或登入。請執行 pnpm hub:service install --mode boot（或 --mode logon）重新安裝，新版會由監督程序自動重啟中樞。');
    } else if (task.code === 0 && /--supervise/.test(task.stdout)) ok('排程工作由監督程序執行（中樞崩潰後會自動重啟）');
  }

  // Worker installers.
  const downloads = config?.workerDownloadDirectory;
  for (const platformName of WORKER_PLATFORMS) {
    const release = await inspectWorkerRelease(downloads, platformName);
    if (release.status === 'ok' && !release.release.signature) {
      warn(`Worker 安裝包 ${platformName}：${release.release.version} 沒有發行簽章（S1 之前建置的）。內建發行公鑰的 Worker 會拒絕這個更新；請重新執行 pnpm worker:release。`);
    } else if (release.status === 'ok') ok(`Worker 安裝包 ${platformName}：${release.release.version}（${release.release.file}，已簽章）`);
    else if (release.status === 'missing') warn(`沒有 ${platformName} 的 Worker 安裝包。請執行 pnpm worker:release${platformName === 'win-x64' ? '（Windows 安裝包要在 Windows 機器上建置）' : ''}，並放到 ${downloads ?? '<hubDir>/worker-downloads'}。`);
    else error(`latest-${platformName}.json 不正確：${release.reason}。請重新執行 pnpm worker:release。`);
  }
  return lines;
}

const prefix: Record<DoctorLevel, string> = { ok: '[OK]', warn: '[警告]', error: '[錯誤]' };

export async function doctorMain(argv: readonly string[], deps: DoctorDeps = {}) {
  const log = deps.log ?? ((line: string) => console.log(line));
  const lines = await runDoctor(argv, deps);
  for (const line of lines) log(`${prefix[line.level]} ${line.text}`);
  const errors = lines.filter(line => line.level === 'error').length;
  const warnings = lines.filter(line => line.level === 'warn').length;
  log(errors ? `有 ${errors} 個錯誤、${warnings} 個警告。` : warnings ? `沒有錯誤，有 ${warnings} 個警告。` : '全部正常。');
  return errors ? 1 : 0;
}
