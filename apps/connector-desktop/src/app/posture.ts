// Machine posture (§3.2, §8.2, §12.1 risk 9): idle sleep, battery, automatic
// login, FileVault and an already-enabled remote screen, sent with heartbeat
// v2 (`posture`, `remote_access`). Everything is read-only: SmartSell never
// changes these settings (Appendix D item 10). Commands run without a shell,
// with a timeout; their output is parsed by pure functions tested with fakes.
import { execFile } from 'node:child_process';
import { hostname, release } from 'node:os';
import type { DevicePosture, RemoteAccess } from '@smartsell/contracts';

export interface RunResult { code: number; stdout: string; stderr: string }
export type Run = (file: string, args: string[]) => Promise<RunResult>;

export const nodeRun: Run = (file, args) => new Promise(resolve => {
  execFile(file, args, { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
    const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? Number((error as { code: number }).code) : -1) : 0;
    resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
  });
});

/** `pmset -g`: the system idle sleep in minutes (0 = never). */
export function parsePmsetSleep(text: string): number | null {
  const match = /^\s*sleep\s+(\d+)/m.exec(text);
  return match ? Number(match[1]) : null;
}

/** `pmset -g batt`: "Now drawing from 'Battery Power'" or "'AC Power'". */
export function parsePmsetBattery(text: string): boolean | null {
  if (/drawing from 'Battery Power'/.test(text)) return true;
  if (/drawing from '(AC|UPS) Power'/.test(text)) return false;
  return null;
}

/** `fdesetup status`. */
export function parseFdesetup(text: string): 'on' | 'off' | 'unknown' {
  if (/FileVault is On/i.test(text)) return 'on';
  if (/FileVault is Off/i.test(text)) return 'off';
  return 'unknown';
}

/** `defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser`: a user name means on; "does not exist" means off. */
export function parseMacAutoLogin(result: RunResult): 'on' | 'off' | 'unknown' {
  if (result.code === 0 && result.stdout.trim()) return 'on';
  if (/does not exist/i.test(result.stderr) || (result.code === 1 && !result.stdout.trim())) return 'off';
  return 'unknown';
}

/**
 * `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE`: the AC "sleep after" in minutes (0 = never).
 * The labels are localized, so when the English label is missing the AC index is the second-to-last hex value
 * (powercfg always prints AC then DC last).
 */
export function parsePowercfgSleepMin(text: string): number | null {
  const english = /Current AC Power Setting Index:\s*0x([0-9a-f]+)/i.exec(text);
  let hex = english?.[1];
  if (!hex) {
    const values = [...text.matchAll(/:\s*0x([0-9a-f]+)\s*$/gim)].map(match => match[1]);
    hex = values.length >= 2 ? values[values.length - 2] : undefined;
  }
  if (!hex) return null;
  const seconds = Number.parseInt(hex, 16);
  return Number.isFinite(seconds) ? Math.round(seconds / 60) : null;
}

/** `reg query … Winlogon /v AutoAdminLogon`. */
export function parseWindowsAutoLogin(result: RunResult): 'on' | 'off' | 'unknown' {
  const match = /AutoAdminLogon\s+REG_\w+\s+(\S+)/i.exec(result.stdout);
  if (match) return match[1] === '1' ? 'on' : 'off';
  if (result.code !== 0) return 'off'; // the value is absent
  return 'unknown';
}

/** `reg query …\Terminal Server /v fDenyTSConnections`: 0 means Remote Desktop is enabled. */
export function parseRdpEnabled(result: RunResult): boolean {
  const match = /fDenyTSConnections\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(result.stdout);
  return !!match && Number.parseInt(match[1], 16) === 0;
}

/** `netstat -an -p tcp` on macOS: Screen Sharing / Remote Management listen on 5900. */
export function parseVncListening(text: string): boolean {
  return /^tcp[46]*\s+\d+\s+\d+\s+(?:\*|[\d.:]+|::)[.:]5900\s+\S+\s+LISTEN/im.test(text);
}

/** `tailscale status --json`: this machine's MagicDNS name, used for the vnc:// or rdp link. */
export function parseTailscaleDnsName(text: string): string | null {
  try {
    const value = JSON.parse(text) as { Self?: { DNSName?: unknown } };
    const name = typeof value.Self?.DNSName === 'string' ? value.Self.DNSName.replace(/\.$/, '') : '';
    return /^[a-z0-9.-]{1,253}$/i.test(name) ? name : null;
  } catch { return null; }
}

export interface PostureDeps {
  platform: NodeJS.Platform;
  run?: Run;
  osRelease?: string;
  /** Electron powerMonitor.isOnBatteryPower(); falls back to pmset on macOS. */
  onBattery?(): boolean;
  hostname?(): string;
  tailscalePaths?: string[];
  now?(): number;
  log?(message: string, detail?: object): void;
}

const TAILSCALE_PATHS: Record<string, string[]> = {
  darwin: ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'],
  win32: ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe'],
};

export async function readPosture(deps: PostureDeps): Promise<{ posture: DevicePosture | null; remote: RemoteAccess | null }> {
  const run = deps.run ?? nodeRun;
  const osRelease = deps.osRelease ?? release();
  const battery = () => { try { return deps.onBattery ? deps.onBattery() : null; } catch { return null; } };
  if (deps.platform === 'darwin') {
    const [pmset, batt, fde, login, version, netstat] = await Promise.all([
      run('/usr/bin/pmset', ['-g']), deps.onBattery ? Promise.resolve(null) : run('/usr/bin/pmset', ['-g', 'batt']),
      run('/usr/bin/fdesetup', ['status']), run('/usr/bin/defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'autoLoginUser']),
      run('/usr/bin/sw_vers', ['-productVersion']), run('/usr/sbin/netstat', ['-an', '-p', 'tcp']),
    ]);
    const filevault = fde.code === 0 ? parseFdesetup(fde.stdout) : 'unknown';
    // FileVault makes automatic login impossible, whatever loginwindow says.
    const autoLogin = filevault === 'on' ? 'off' : parseMacAutoLogin(login);
    const posture: DevicePosture = {
      os: 'darwin', os_version: version.code === 0 && version.stdout.trim() ? version.stdout.trim() : osRelease,
      sleep_idle_min: pmset.code === 0 ? parsePmsetSleep(pmset.stdout) : null,
      on_battery: deps.onBattery ? battery() : batt && batt.code === 0 ? parsePmsetBattery(batt.stdout) : null,
      auto_login: autoLogin, filevault, power_plan_sleep_min: null,
    };
    const remote = netstat.code === 0 && parseVncListening(netstat.stdout) ? { kind: 'vnc' as const, host: await remoteHost(deps, run) } : null;
    return { posture, remote };
  }
  if (deps.platform === 'win32') {
    const [standby, login, rdp] = await Promise.all([
      run('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE']),
      run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', '/v', 'AutoAdminLogon']),
      run('reg', ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server', '/v', 'fDenyTSConnections']),
    ]);
    const posture: DevicePosture = {
      os: 'win32', os_version: osRelease, sleep_idle_min: null, on_battery: battery(),
      auto_login: parseWindowsAutoLogin(login), filevault: 'n/a',
      power_plan_sleep_min: standby.code === 0 ? parsePowercfgSleepMin(standby.stdout) : null,
    };
    const remote = parseRdpEnabled(rdp) ? { kind: 'rdp' as const, host: await remoteHost(deps, run) } : null;
    return { posture, remote };
  }
  return { posture: null, remote: null };
}

async function remoteHost(deps: PostureDeps, run: Run) {
  for (const path of deps.tailscalePaths ?? TAILSCALE_PATHS[deps.platform] ?? []) {
    const result = await run(path, ['status', '--json']).catch(() => undefined);
    const name = result && result.code === 0 ? parseTailscaleDnsName(result.stdout) : null;
    if (name) return name;
  }
  return (deps.hostname ?? hostname)();
}

/**
 * Keeps the last reading so the Supervisor can read it synchronously on every heartbeat; refreshes every
 * 10 minutes and after the machine wakes. The Supervisor itself only sends it when it changed or every 30 min.
 */
export class PostureMonitor {
  readonly #deps: PostureDeps;
  #posture: DevicePosture | null = null;
  #remote: RemoteAccess | null = null;
  #timer?: ReturnType<typeof setInterval>;
  #reading?: Promise<void>;

  constructor(deps: PostureDeps) { this.#deps = deps; }

  current(): DevicePosture | null { return this.#posture; }
  remote(): RemoteAccess | null { return this.#remote; }

  refresh(): Promise<void> {
    this.#reading ??= readPosture(this.#deps).then(value => { this.#posture = value.posture; this.#remote = value.remote; })
      .catch(error => this.#deps.log?.('posture read failed', { error: String(error) }))
      .finally(() => { this.#reading = undefined; });
    return this.#reading;
  }

  start(everyMs = 10 * 60_000) {
    void this.refresh();
    this.#timer ??= setInterval(() => void this.refresh(), everyMs);
    this.#timer.unref?.();
  }

  stop() { if (this.#timer) clearInterval(this.#timer); this.#timer = undefined; }
}

/** One line per warning in the 「這台機器的設定」 section (§8.17 item 2), with how to change it. */
export function postureAdvice(posture: DevicePosture | null, remote: RemoteAccess | null): { code: string; text: string; how: string }[] {
  if (!posture) return [];
  const advice: { code: string; text: string; how: string }[] = [];
  const sleep = Math.max(posture.sleep_idle_min ?? 0, posture.power_plan_sleep_min ?? 0);
  if (sleep > 0) {
    advice.push({ code: 'sleep_enabled', text: `閒置 ${sleep} 分鐘後會睡眠；睡眠期間到點的貼文會錯過。`,
      how: posture.os === 'darwin' ? '系統設定 → 能源（或電池 → 選項）→ 開啟「防止自動睡眠」，或在終端機執行 sudo pmset -c sleep 0。'
        : '設定 → 系統 → 電源 → 「插入電源時，在下列時間後讓裝置進入睡眠狀態」選「永不」。' });
  }
  if (posture.on_battery) advice.push({ code: 'on_battery', text: '目前使用電池；沒電或闔上螢幕會錯過貼文。', how: '接上電源，並保持螢幕開啟。' });
  if (posture.auto_login !== 'on') {
    advice.push({ code: 'no_auto_login', text: `重開機後要有人登入，Worker 才會啟動${posture.filevault === 'on' ? '（FileVault 已開啟，無法自動登入）' : ''}。`,
      how: posture.os === 'darwin'
        ? (posture.filevault === 'on' ? '若要停電後自動恢復，需關閉 FileVault 並在「使用者與群組」開啟自動登入；或接受停電後到場輸入密碼並加 UPS。' : '系統設定 → 使用者與群組 → 「自動以此身分登入」。')
        : '執行 netplwiz，取消勾選「必須輸入使用者名稱和密碼」，或使用 Sysinternals Autologon。' });
  }
  if (remote) advice.push({ code: 'remote_access', text: `遠端畫面已開啟：${remote.kind === 'vnc' ? `vnc://${remote.host}` : `rdp://${remote.host}`}`, how: '主人可從筆電連進來按發布或處理驗證碼。' });
  return advice;
}
