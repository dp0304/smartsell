import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { parseArgs } from 'node:util';
import { defaultHubDir, HUB_DEFAULT_PORT } from '../config.js';
import { nodeExec, type Exec } from './exec.js';
import { readHubEnvFile } from './hub-env.js';
import { REPO_ROOT, terminalAsk } from './init.js';
import { describeHubStatus, readHubStatus } from './status-file.js';
import { findTailscale, serveStatus, serveTarget, TAILSCALE_TEXT, tailscaleStatus } from './tailscale.js';

export const LAUNCHD_LABEL = 'com.smartsell.hub';
export const WINDOWS_TASK_NAME = 'SmartSell Hub';
export type ServiceMode = 'agent' | 'daemon' | 'logon' | 'boot';

export const xmlEscape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export interface LaunchdInput { nodePath: string; repo: string; hubDir: string; userName?: string }

const CELLAR_NODE = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/;

/**
 * AO-3 (E45): the node path a service file should name. Node reports its resolved path, for Homebrew a versioned keg
 * (`/opt/homebrew/Cellar/node@24/24.11.0/bin/node`) that `brew upgrade` deletes. The formula's `opt` link
 * (`/opt/homebrew/opt/node@24/bin/node`) always points at the installed version, so the service survives upgrades.
 */
export function stableNodePath(execPath: string, platform: NodeJS.Platform = process.platform, exists: (path: string) => boolean = existsSync) {
  if (platform !== 'darwin') return execPath;
  const match = CELLAR_NODE.exec(execPath);
  if (!match) return execPath;
  const opt = posix.join(match[1]!, 'opt', match[2]!, 'bin', 'node');
  return exists(opt) ? opt : execPath;
}

/** True for a Homebrew keg path that names one version (`…/Cellar/<formula>/<version>/bin/node`). */
export const versionedNodePath = (path: string) => CELLAR_NODE.test(path);

/** ProgramArguments[0] of a launchd plist this tool wrote (the node binary launchd executes). */
export function plistProgram(plist: string): string | undefined {
  const array = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plist)?.[1];
  return array === undefined ? undefined : array.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

/** Why the installed service file cannot start the hub after a Node upgrade, or undefined when it is fine. */
export function serviceNodeIssue(plistPath: string, deps: { read?: (path: string) => string; exists?: (path: string) => boolean } = {}):
  { level: 'error' | 'warn'; node: string; text: string } | undefined {
  const exists = deps.exists ?? existsSync;
  let text: string;
  try { text = (deps.read ?? (path => readFileSync(path, 'utf8')))(plistPath); } catch { return undefined; }
  const node = plistProgram(text);
  if (!node) return undefined;
  if (!exists(node)) {
    return { level: 'error', node, text: `中樞服務設定檔 ${plistPath} 指向的 Node（${node}）已不存在，多半是 brew upgrade 移除了舊版本；中樞下次重開機或崩潰後不會再啟動。請執行 pnpm hub:service install 重新安裝服務（會改用不隨版本變動的路徑）。` };
  }
  if (versionedNodePath(node)) {
    return { level: 'warn', node, text: `中樞服務設定檔 ${plistPath} 使用帶版本號的 Node 路徑（${node}），下一次 brew upgrade 後就會失效。請執行 pnpm hub:service install 重新安裝服務（會改用 Homebrew 的 opt 路徑）。` };
  }
  return undefined;
}

/** The PATH launchd gives the hub: node's own directory first, then Homebrew (ffprobe, brew tailscale) and the system. */
export const launchdPath = (nodePath: string) => [...new Set([posix.dirname(nodePath), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');

/** LaunchAgent (agent) or LaunchDaemon (daemon, with UserName) property list (§2.8). */
export function launchdPlist({ nodePath, repo, hubDir, userName }: LaunchdInput) {
  const s = (value: string) => `<string>${xmlEscape(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${s(LAUNCHD_LABEL)}
${userName ? `  <key>UserName</key>${s(userName)}\n` : ''}  <key>ProgramArguments</key>
  <array>
    ${s(nodePath)}
    ${s('--import')}
    ${s('tsx')}
    ${s(posix.join(repo, 'apps/server/hub.ts'))}
  </array>
  <key>WorkingDirectory</key>${s(repo)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>SMARTSELL_HUB_DIR</key>${s(hubDir)}
    <key>PATH</key>${s(launchdPath(nodePath))}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key>${s(posix.join(hubDir, 'logs/hub.out.log'))}
  <key>StandardErrorPath</key>${s(posix.join(hubDir, 'logs/hub.err.log'))}
</dict>
</plist>
`;
}

export interface TaskInput { mode: 'logon' | 'boot'; nodePath: string; repo: string; hubDir: string; userId: string }

/**
 * Task Scheduler definition (§2.8): logon trigger with the interactive token, or boot trigger that runs whether or not
 * the user is signed in. AO-2 (E45): the action is `hub.ts --supervise`. Task Scheduler's RestartOnFailure only retries
 * a task that failed to start; a hub that started and later exited non-zero would stay down until the next boot, so a
 * small supervisor process restarts it (supervisor.ts). RestartOnFailure stays for a supervisor that cannot start.
 */
export function windowsTaskXml({ mode, nodePath, repo, hubDir, userId }: TaskInput) {
  const e = xmlEscape;
  const trigger = mode === 'logon'
    ? `    <LogonTrigger>\n      <Enabled>true</Enabled>\n      <UserId>${e(userId)}</UserId>\n    </LogonTrigger>`
    : `    <BootTrigger>\n      <Enabled>true</Enabled>\n    </BootTrigger>`;
  const args = `--import tsx "${win32.join(repo, 'apps', 'server', 'hub.ts')}" --supervise --hub-dir "${hubDir}"`;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>SmartSell Hub (pnpm hub:service install --mode ${mode})</Description>
    <URI>\\${e(WINDOWS_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
${trigger}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${e(userId)}</UserId>
      <LogonType>${mode === 'logon' ? 'InteractiveToken' : 'Password'}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${e(nodePath)}</Command>
      <Arguments>${e(args)}</Arguments>
      <WorkingDirectory>${e(repo)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/** schtasks reads the XML in the encoding its declaration names; UTF-16LE with a BOM is what Task Scheduler exports. */
export const utf16le = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf16le')]);

export interface PlanFile { path: string; content: string | Buffer; mode?: number }
export interface PlanCommand { argv: string[]; allowFailure?: boolean; interactive?: boolean; description: string }
export interface ServicePlan { mode: ServiceMode; files: PlanFile[]; commands: PlanCommand[]; notes: string[]; removes: string[] }

export interface ServiceTarget {
  platform: NodeJS.Platform; mode: ServiceMode; nodePath: string; repo: string; hubDir: string; home: string; uid: number;
  userName: string; userId: string;
}

export const agentPlistPath = (home: string) => posix.join(home, 'Library/LaunchAgents', `${LAUNCHD_LABEL}.plist`);
export const DAEMON_PLIST = `/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist`;

export function defaultMode(platform: NodeJS.Platform): ServiceMode {
  if (platform === 'darwin') return 'agent';
  if (platform === 'win32') return 'logon';
  throw new Error('hub:service 只支援 macOS（launchd）與 Windows（工作排程器）。Linux 請自行以 systemd 執行 pnpm hub。');
}

export function validateMode(platform: NodeJS.Platform, mode: string): ServiceMode {
  const allowed = platform === 'darwin' ? ['agent', 'daemon'] : platform === 'win32' ? ['logon', 'boot'] : [];
  if (!allowed.includes(mode)) throw new Error(`--mode 在這個系統只能是 ${allowed.join(' 或 ') || '(不支援)'}（收到 ${mode}）`);
  return mode as ServiceMode;
}

export const MAC_NOTES = {
  fileVaultOn: [
    'FileVault 已開啟：Mac 重開機後要有人在開機畫面輸入密碼解鎖磁碟，在那之前中樞與任何服務都不會執行；FileVault 開啟時也無法設定自動登入。你有三種選擇：',
    '  1. 中樞關閉 FileVault（系統設定 → 隱私權與安全性 → FileVault），並開啟自動登入（--mode agent）或改用 --mode daemon；',
    '  2. 保持 FileVault，接受斷電重開後要有人到中樞輸入密碼，並建議加裝 UPS；計畫內的重開機請用 sudo fdesetup authrestart；',
    '  3. 改用 Windows 機器當中樞（pnpm hub:service install --mode boot，BitLocker 以 TPM 解鎖時開機不需要輸入密碼）。',
  ],
  agentNeedsLogin: '模式一（agent）要等使用者登入後才會啟動（Tailscale 的 macOS App 也是登入後才執行）。若中樞會無人重開機，請開啟自動登入（系統設定 → 使用者與群組 → 自動登入），或改用 --mode daemon。',
  daemonTailscale: '模式二（daemon）需要 tailscaled 以系統服務執行：brew install tailscale，然後 sudo brew services start tailscale（取代 Tailscale App），再重跑 pnpm hub:init 確認 tailscale serve。',
  sleep: '建議關閉中樞的睡眠：sudo pmset -c sleep 0 disksleep 0；若中樞是筆電，請接上電源並設定闔上螢幕不睡眠。',
};

export const WINDOWS_NOTES = {
  logon: '模式 logon 要等使用者登入後才會啟動。若中樞會無人重開機，請執行 netplwiz 設定自動登入，或改用 --mode boot（建議）。電源計畫請設定為「不睡眠」（設定 → 系統 → 電源 → 螢幕與睡眠 → 永不）。',
  boot: '模式 boot 不論使用者是否登入都會執行。建立工作時 Windows 會要求輸入你的 Windows 密碼：請在下面的提示中自己輸入，安裝腳本不會經手。BitLocker 以 TPM 解鎖時開機不需要輸入密碼。電源計畫請設定為「不睡眠」。',
};

export function planInstall(target: ServiceTarget): ServicePlan {
  const { platform, mode, nodePath, repo, hubDir, home, uid, userName, userId } = target;
  const logs = platform === 'win32' ? win32.join(hubDir, 'logs') : posix.join(hubDir, 'logs');
  if (platform === 'darwin' && mode === 'agent') {
    const plist = agentPlistPath(home);
    return {
      mode, removes: [],
      files: [{ path: plist, content: launchdPlist({ nodePath, repo, hubDir }), mode: 0o644 }],
      commands: [
        { argv: ['launchctl', 'bootout', `gui/${uid}/${LAUNCHD_LABEL}`], allowFailure: true, description: '卸下舊的 LaunchAgent（沒有時會失敗，可忽略）' },
        { argv: ['launchctl', 'enable', `gui/${uid}/${LAUNCHD_LABEL}`], allowFailure: true, description: '允許 LaunchAgent 執行' },
        { argv: ['launchctl', 'bootstrap', `gui/${uid}`, plist], description: '載入 LaunchAgent 並立即啟動' },
      ],
      notes: [MAC_NOTES.agentNeedsLogin, MAC_NOTES.sleep],
    };
  }
  if (platform === 'darwin' && mode === 'daemon') {
    const staging = posix.join(hubDir, `${LAUNCHD_LABEL}.daemon.plist`);
    return {
      mode, removes: [agentPlistPath(home)],
      files: [{ path: staging, content: launchdPlist({ nodePath, repo, hubDir, userName }), mode: 0o644 }],
      commands: [
        { argv: ['launchctl', 'bootout', `gui/${uid}/${LAUNCHD_LABEL}`], allowFailure: true, description: '卸下 LaunchAgent（若曾安裝模式一）' },
        { argv: ['sudo', 'install', '-m', '0644', '-o', 'root', '-g', 'wheel', staging, DAEMON_PLIST], interactive: true, description: '以 sudo 安裝 LaunchDaemon（會要求你的 macOS 密碼）' },
        { argv: ['sudo', 'launchctl', 'bootout', `system/${LAUNCHD_LABEL}`], allowFailure: true, interactive: true, description: '卸下舊的 LaunchDaemon（沒有時會失敗，可忽略）' },
        { argv: ['sudo', 'launchctl', 'bootstrap', 'system', DAEMON_PLIST], interactive: true, description: '載入 LaunchDaemon 並立即啟動' },
      ],
      notes: [MAC_NOTES.daemonTailscale, MAC_NOTES.sleep],
    };
  }
  if (platform === 'win32' && (mode === 'logon' || mode === 'boot')) {
    const xmlPath = win32.join(hubDir, 'smartsell-hub-task.xml');
    const create = ['schtasks', '/Create', '/TN', WINDOWS_TASK_NAME, '/XML', xmlPath, '/F'];
    return {
      mode, removes: [],
      files: [{ path: xmlPath, content: utf16le(windowsTaskXml({ mode, nodePath, repo, hubDir, userId })) }],
      commands: [
        mode === 'boot'
          ? { argv: [...create, '/RU', userId, '/RP', '*'], interactive: true, description: '建立開機觸發的排程工作（會要求你輸入 Windows 密碼）' }
          : { argv: create, description: '建立登入觸發的排程工作' },
        { argv: ['schtasks', '/Run', '/TN', WINDOWS_TASK_NAME], description: '立即啟動中樞' },
      ],
      notes: [mode === 'boot' ? WINDOWS_NOTES.boot : WINDOWS_NOTES.logon, `中樞的紀錄與狀態在 ${logs} 與 ${win32.join(hubDir, 'status.json')}。`],
    };
  }
  throw new Error(`不支援的組合：${platform} --mode ${mode}`);
}

export function planUninstall(target: Pick<ServiceTarget, 'platform' | 'mode' | 'home' | 'uid' | 'hubDir'>): ServicePlan {
  const { platform, mode, home, uid, hubDir } = target;
  if (platform === 'darwin' && mode === 'agent') {
    return { mode, files: [], notes: [], removes: [agentPlistPath(home)],
      commands: [{ argv: ['launchctl', 'bootout', `gui/${uid}/${LAUNCHD_LABEL}`], allowFailure: true, description: '停止並卸下 LaunchAgent' }] };
  }
  if (platform === 'darwin' && mode === 'daemon') {
    return { mode, files: [], notes: [], removes: [posix.join(hubDir, `${LAUNCHD_LABEL}.daemon.plist`)],
      commands: [
        { argv: ['sudo', 'launchctl', 'bootout', `system/${LAUNCHD_LABEL}`], allowFailure: true, interactive: true, description: '停止並卸下 LaunchDaemon' },
        { argv: ['sudo', 'rm', '-f', DAEMON_PLIST], interactive: true, description: '移除 LaunchDaemon 設定檔' },
      ] };
  }
  if (platform === 'win32') {
    return { mode, files: [], notes: [], removes: [win32.join(hubDir, 'smartsell-hub-task.xml')],
      commands: [
        { argv: ['schtasks', '/End', '/TN', WINDOWS_TASK_NAME], allowFailure: true, description: '停止中樞' },
        { argv: ['schtasks', '/Delete', '/TN', WINDOWS_TASK_NAME, '/F'], description: '刪除排程工作' },
      ] };
  }
  throw new Error(`不支援的組合：${platform} --mode ${mode}`);
}

export type FileVault = 'on' | 'off' | 'unknown';
export async function fileVaultStatus(exec: Exec): Promise<FileVault> {
  const result = await exec('fdesetup', ['status'], { timeoutMs: 10_000 });
  if (/FileVault is On/i.test(result.stdout)) return 'on';
  if (/FileVault is Off/i.test(result.stdout)) return 'off';
  return 'unknown';
}

export async function macAutoLogin(exec: Exec): Promise<boolean | undefined> {
  const result = await exec('defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser'], { timeoutMs: 10_000 });
  if (result.error === 'ENOENT') return undefined;
  return result.code === 0 && !!result.stdout.trim();
}

export interface ServiceDeps {
  exec?: Exec;
  /** The running node's own path; normalised by stableNodePath unless `nodePath` is given. */
  execPath?: string;
  exists?: (path: string) => boolean;
  log?: (line: string) => void;
  ask?: (question: string, defaultYes: boolean) => Promise<boolean>;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  writeFile?: (path: string, content: string | Buffer, mode?: number) => void;
  removeFile?: (path: string) => void;
  ensureDir?: (path: string) => void;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  home?: string;
  uid?: number;
  userName?: string;
  nodePath?: string;
  repo?: string;
}

/** Writes a service file (plist, task XML), creating its folder. */
export const writeServiceFile = (path: string, content: string | Buffer, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode === undefined ? undefined : { mode });
};

export async function runPlan(plan: ServicePlan, deps: Required<Pick<ServiceDeps, 'exec' | 'log' | 'writeFile' | 'removeFile'>>, dryRun: boolean) {
  for (const file of plan.files) {
    deps.log(`${dryRun ? '[dry-run] 會寫入' : '寫入'} ${file.path}`);
    if (!dryRun) deps.writeFile(file.path, file.content, file.mode);
  }
  for (const path of plan.removes) {
    deps.log(`${dryRun ? '[dry-run] 會移除' : '移除'} ${path}`);
    if (!dryRun) deps.removeFile(path);
  }
  for (const command of plan.commands) {
    deps.log(`${dryRun ? '[dry-run] ' : ''}${command.description}：${command.argv.map(arg => /\s/.test(arg) ? `"${arg}"` : arg).join(' ')}`);
    if (dryRun) continue;
    const [file, ...args] = command.argv;
    const result = await deps.exec(file, args, { inherit: command.interactive, timeoutMs: 5 * 60_000 });
    if (result.code !== 0 && !command.allowFailure) {
      return { ok: false as const, message: `命令失敗（結束碼 ${result.code}）：${command.argv.join(' ')}${result.stderr ? `\n${result.stderr.trim()}` : ''}` };
    }
  }
  return { ok: true as const };
}

export function hubPort(hubDir: string, platform: NodeJS.Platform) {
  const port = Number(readHubEnvFile(hubDir, platform).values.PORT ?? HUB_DEFAULT_PORT);
  return Number.isInteger(port) ? port : HUB_DEFAULT_PORT;
}

export async function readyz(port: number, fetcher: typeof fetch = fetch) {
  try {
    const response = await fetcher(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function waitForReady(port: number, deps: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> }, timeoutMs = 60_000) {
  const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let waited = 0; waited <= timeoutMs; waited += 2000) {
    if (await readyz(port, deps.fetch)) return true;
    await sleep(2000);
  }
  return false;
}

/** Which service flavour is installed, from the files on disk. */
export function installedMode(platform: NodeJS.Platform, home: string, exists: (path: string) => boolean = existsSync): ServiceMode | undefined {
  if (platform === 'darwin') return exists(DAEMON_PLIST) ? 'daemon' : exists(agentPlistPath(home)) ? 'agent' : undefined;
  return undefined;
}

export async function serviceState(platform: NodeJS.Platform, exec: Exec, home: string, uid: number) {
  if (platform === 'darwin') {
    const mode = installedMode(platform, home);
    if (!mode) return { installed: false, running: false, text: '沒有安裝 launchd 服務（pnpm hub:service install）。' };
    const domain = mode === 'daemon' ? `system/${LAUNCHD_LABEL}` : `gui/${uid}/${LAUNCHD_LABEL}`;
    const result = await exec('launchctl', ['print', domain], { timeoutMs: 10_000 });
    if (result.code !== 0) return { installed: true, running: false, text: `launchd 服務（${mode}）已安裝但沒有載入：${domain}` };
    const state = /^\s*state = (\S+)/m.exec(result.stdout)?.[1] ?? 'unknown';
    const pid = /^\s*pid = (\d+)/m.exec(result.stdout)?.[1];
    return { installed: true, running: state === 'running', text: `launchd 服務（${mode}）：${state}${pid ? `，pid ${pid}` : ''}` };
  }
  if (platform === 'win32') {
    const result = await exec('schtasks', ['/Query', '/TN', WINDOWS_TASK_NAME, '/FO', 'LIST', '/V'], { timeoutMs: 15_000 });
    if (result.code !== 0) return { installed: false, running: false, text: '沒有安裝排程工作（pnpm hub:service install）。' };
    const status = /^Status:\s*(.+)$/mi.exec(result.stdout)?.[1]?.trim() ?? 'Unknown';
    return { installed: true, running: /running/i.test(status), text: `排程工作「${WINDOWS_TASK_NAME}」：${status}` };
  }
  return { installed: false, running: false, text: '這個系統沒有支援的服務安裝方式。' };
}

function context(deps: ServiceDeps, hubDirOverride?: string) {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const info = (() => { try { return userInfo(); } catch { return undefined; } })();
  return {
    platform, env,
    exec: deps.exec ?? nodeExec,
    log: deps.log ?? ((line: string) => console.log(line)),
    ask: deps.ask ?? terminalAsk,
    writeFile: deps.writeFile ?? writeServiceFile,
    removeFile: deps.removeFile ?? ((path: string) => rmSync(path, { force: true })),
    ensureDir: deps.ensureDir ?? ((path: string) => { mkdirSync(path, { recursive: true, mode: 0o700 }); }),
    home: deps.home ?? homedir(),
    uid: deps.uid ?? process.getuid?.() ?? 0,
    userName: deps.userName ?? info?.username ?? env.USER ?? env.USERNAME ?? '',
    nodePath: deps.nodePath ?? stableNodePath(deps.execPath ?? process.execPath, platform, deps.exists),
    repo: deps.repo ?? resolve(REPO_ROOT),
    hubDir: resolve(hubDirOverride ?? (env.SMARTSELL_HUB_DIR || defaultHubDir(platform, env))),
  };
}

export const SERVICE_USAGE = `用法：pnpm hub:service <install|uninstall|status> [--mode agent|daemon|logon|boot] [--hub-dir <dir>] [--yes] [--dry-run]
  macOS：--mode agent（預設，登入後執行）或 --mode daemon（無人登入也能執行，需要 sudo）
  Windows：--mode logon（預設，登入後執行）或 --mode boot（建議，開機就執行）`;

/** `pnpm hub:service install|uninstall|status` (§2.8). Returns the process exit code. */
export async function serviceMain(argv: readonly string[], deps: ServiceDeps = {}): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv.filter(arg => arg !== '--'), allowPositionals: true, options: {
    mode: { type: 'string' }, 'hub-dir': { type: 'string' }, yes: { type: 'boolean', short: 'y' }, 'dry-run': { type: 'boolean' },
  } });
  const ctx = context(deps, values['hub-dir']);
  const { platform, log } = ctx;
  const command = positionals[0];
  if (!['install', 'uninstall', 'status'].includes(command ?? '')) {
    log(SERVICE_USAGE);
    return 2;
  }
  const userId = platform === 'win32' ? `${ctx.env.USERDOMAIN ? `${ctx.env.USERDOMAIN}\\` : ''}${ctx.userName}` : ctx.userName;
  if (command === 'status') return serviceStatus(ctx);
  let mode: ServiceMode;
  try {
    mode = values.mode ? validateMode(platform, values.mode) : command === 'uninstall' && installedMode(platform, ctx.home) || defaultMode(platform);
  } catch (error) {
    log((error as Error).message);
    return 2;
  }
  const dryRun = values['dry-run'] === true;
  if (command === 'uninstall') {
    const result = await runPlan(planUninstall({ platform, mode, home: ctx.home, uid: ctx.uid, hubDir: ctx.hubDir }), ctx, dryRun);
    log(result.ok ? `已移除中樞服務（${mode}）。資料夾 ${ctx.hubDir} 保留不動。` : result.message);
    return result.ok ? 0 : 1;
  }

  // install: refuse when the hub would not start (§2.5 step 6).
  log(`檢查中樞設定並載入程式：node --import tsx apps/server/hub.ts --check --hub-dir "${ctx.hubDir}" --load`);
  const check = await ctx.exec(ctx.nodePath, ['--import', 'tsx', join(ctx.repo, 'apps', 'server', 'hub.ts'), '--check', '--hub-dir', ctx.hubDir, '--load'],
    { cwd: ctx.repo, inherit: true, timeoutMs: 120_000, env: { ...ctx.env, SMARTSELL_HUB_DIR: ctx.hubDir } });
  if (check.code !== 0) {
    log('中樞設定檢查沒有通過，不安裝服務。請依上面的說明修正後重跑 pnpm hub:service install。');
    return 1;
  }
  if (platform === 'darwin') {
    if (mode === 'agent' && existsSync(DAEMON_PLIST)) {
      log(`已經以 daemon 模式安裝（${DAEMON_PLIST}）。請先執行 pnpm hub:service uninstall --mode daemon。`);
      return 1;
    }
    const fileVault = await fileVaultStatus(ctx.exec);
    if (fileVault === 'on') {
      for (const line of MAC_NOTES.fileVaultOn) log(line);
      if (!values.yes && !await ctx.ask('了解上述限制，仍要在這台 Mac 安裝中樞服務嗎？', false)) {
        log('已取消安裝。');
        return 1;
      }
    } else if (fileVault === 'unknown') {
      log('無法判斷 FileVault 狀態（fdesetup status）。若 FileVault 開啟，Mac 重開機後要有人輸入密碼，中樞才會執行。');
    } else if (mode === 'agent' && await macAutoLogin(ctx.exec) === false) {
      log('FileVault 已關閉，但沒有開啟自動登入。');
    }
  }
  const plan = planInstall({ platform, mode, nodePath: ctx.nodePath, repo: ctx.repo, hubDir: ctx.hubDir, home: ctx.home, uid: ctx.uid,
    userName: ctx.userName, userId });
  for (const note of plan.notes) log(`[提示] ${note}`);
  if (!dryRun) ctx.ensureDir(platform === 'win32' ? win32.join(ctx.hubDir, 'logs') : join(ctx.hubDir, 'logs'));
  const result = await runPlan(plan, ctx, dryRun);
  if (!result.ok) {
    log(result.message);
    return 1;
  }
  if (dryRun) return 0;
  const port = hubPort(ctx.hubDir, platform);
  log(`等待中樞回應 http://127.0.0.1:${port}/readyz …`);
  if (await waitForReady(port, deps)) {
    log(`中樞服務已安裝（${mode}）並在執行中。`);
    return 0;
  }
  log(`中樞服務已安裝（${mode}），但 60 秒內沒有回應。${describeHubStatus(readHubStatus(ctx.hubDir))}`);
  log('請執行 pnpm hub:doctor 查看原因。');
  return 1;
}

async function serviceStatus(ctx: ReturnType<typeof context>) {
  const { log, platform, exec } = ctx;
  const service = await serviceState(platform, exec, ctx.home, ctx.uid);
  log(service.text);
  log(`狀態檔：${describeHubStatus(readHubStatus(ctx.hubDir))}`);
  const port = hubPort(ctx.hubDir, platform);
  const ready = await readyz(port);
  log(ready ? `/readyz：正常（http://127.0.0.1:${port}）` : `/readyz：沒有回應（http://127.0.0.1:${port}）`);
  const bin = await findTailscale(exec, { platform, env: ctx.env });
  if (!bin) log('tailscale serve：找不到 Tailscale CLI');
  else {
    const self = await tailscaleStatus(exec, bin).catch(() => undefined);
    const serve = await serveStatus(exec, bin, port, self?.dnsName);
    log(serve.ok ? `tailscale serve：正常（https://${self?.dnsName ?? '?'} → http://127.0.0.1:${port}）` : `tailscale serve：${serve.reason}`);
    if (serve.funnel) log(`[警告] ${TAILSCALE_TEXT.funnelOn(serve.funnel_host_port!, serveTarget(port))}`);
  }
  return service.running && ready ? 0 : 1;
}
