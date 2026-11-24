import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import type { Exec } from './exec.js';

export const MAC_TAILSCALE_APP = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
export const KEY_EXPIRY_WARNING_DAYS = 30;
export const SERVE_CHECK_INTERVAL_MS = 10 * 60_000;

/** Owner-facing guidance (zh-Hant) printed by hub:init, hub:service and hub:doctor. */
export const TAILSCALE_TEXT = {
  notFound: '找不到 Tailscale。請先安裝並登入 Tailscale（macOS：從 App Store 或 https://tailscale.com/download 安裝；Windows：winget install Tailscale.Tailscale），再重跑這個命令。',
  notRunning: (state: string) => `Tailscale 目前不是連線狀態（${state}）。請先開啟 Tailscale 並登入，再重跑 pnpm hub:init。`,
  noDnsName: '讀不到這台機器的 Tailscale 名稱。請到 Tailscale 管理後台 → DNS 啟用 MagicDNS，然後重跑 pnpm hub:init。',
  httpsDisabled: '請到 Tailscale 管理後台 → DNS → 啟用 MagicDNS 與 HTTPS Certificates，然後重跑 pnpm hub:init',
  certificateTransparency: (name: string) => `提醒：啟用 HTTPS 憑證後，這台機器的完整名稱 ${name} 會寫進公開的憑證透明度（Certificate Transparency）紀錄。若名稱含有個人資訊（例如你的姓名），建議先到 Tailscale 管理後台把這台機器改成中性的名字（例如 hub），再重跑 pnpm hub:init。`,
  keyExpiry: '請到 Tailscale 管理後台 → Machines，對中樞與每一台 Worker 選 Disable key expiry；節點金鑰預設 180 天到期，到期後機器會默默離開 tailnet。',
  keyExpiringSoon: (date: string, days: number) => `中樞的 Tailscale 節點金鑰將在 ${date} 到期（剩 ${days} 天）。請到 Tailscale 管理後台 → Machines，對這台機器選 Disable key expiry。`,
  serveMissing: (target: string) => `tailscale serve 沒有把 443 轉送到 ${target}。請執行：tailscale serve --bg --https=443 ${target}（或重跑 pnpm hub:init）。`,
  /** E46 (SEC-3): Funnel puts the hub on the public internet; SmartSell is meant to be reachable from the tailnet only. */
  funnelOn: (hostPort: string, target: string) => {
    const port = hostPort.split(':').at(-1) ?? '443';
    const url = `https://${hostPort.slice(0, -(port.length + 1))}${port === '443' ? '' : `:${port}`}`;
    const fix = port === '443'
      ? `tailscale serve --bg --https=443 ${target}（以 serve 重新設定 443 就會關閉 Funnel，只留在 tailnet 內；或重跑 pnpm hub:init）`
      : `tailscale funnel --https=${port} off`;
    return `中樞被 Tailscale Funnel 公開到網際網路（${url}）：任何人都能連到登入頁、配對與 Agent 連線端點，而 SmartSell 只該在你的 tailnet 內使用。請執行：${fix}。`;
  },
};

export class TailscaleError extends Error {
  constructor(readonly code: 'not_found' | 'not_running' | 'no_dns_name' | 'https_disabled' | 'command_failed' | 'invalid_output', message: string) {
    super(message);
    this.name = 'TailscaleError';
  }
}

/** Where the CLI lives (§2.5): the macOS App bundle or PATH; `%ProgramFiles%\Tailscale\tailscale.exe` on Windows. */
export function tailscaleCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env) {
  if (platform === 'darwin') return [MAC_TAILSCALE_APP, 'tailscale'];
  if (platform === 'win32') return [win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'Tailscale', 'tailscale.exe'), 'tailscale'];
  return ['tailscale'];
}

export async function findTailscale(exec: Exec, options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; exists?: (path: string) => boolean } = {}) {
  const exists = options.exists ?? existsSync;
  // An explicit CLI path wins (non-standard installs; tests and E2E point it at a fake CLI).
  const explicit = (options.env ?? process.env).SMARTSELL_TAILSCALE_CLI;
  if (explicit) return exists(explicit) ? explicit : undefined;
  for (const candidate of tailscaleCandidates(options.platform, options.env)) {
    if (candidate.includes('/') || candidate.includes('\\')) {
      if (exists(candidate)) return candidate;
      continue;
    }
    const probe = await exec(candidate, ['version'], { timeoutMs: 10_000 });
    if (probe.code === 0) return candidate;
  }
  return undefined;
}

export interface TailnetSelf {
  backendState: string;
  running: boolean;
  /** `Self.DNSName` without the trailing dot, e.g. `hub.tail1234.ts.net`. */
  dnsName: string | null;
  hostName: string | null;
  /** `Self.KeyExpiry`; null when key expiry is disabled. */
  keyExpiry: string | null;
  certDomains: string[];
  origin: string | null;
}

export function parseTailscaleStatus(json: string): TailnetSelf {
  let value: Record<string, unknown>;
  try { value = JSON.parse(json); } catch { throw new TailscaleError('invalid_output', 'tailscale status --json 的輸出不是 JSON'); }
  if (!value || typeof value !== 'object') throw new TailscaleError('invalid_output', 'tailscale status --json 的輸出格式不正確');
  const self = (value.Self ?? {}) as Record<string, unknown>;
  const backendState = typeof value.BackendState === 'string' ? value.BackendState : 'Unknown';
  const dnsName = typeof self.DNSName === 'string' && self.DNSName ? self.DNSName.replace(/\.$/, '').toLowerCase() : null;
  const keyExpiry = typeof self.KeyExpiry === 'string' && self.KeyExpiry && !self.KeyExpiry.startsWith('0001-') ? self.KeyExpiry : null;
  const certDomains = Array.isArray(value.CertDomains) ? value.CertDomains.filter((item): item is string => typeof item === 'string') : [];
  return {
    backendState, running: backendState === 'Running', dnsName, hostName: typeof self.HostName === 'string' ? self.HostName : null,
    keyExpiry, certDomains, origin: dnsName ? `https://${dnsName}` : null,
  };
}

export async function tailscaleStatus(exec: Exec, bin: string) {
  const result = await exec(bin, ['status', '--json'], { timeoutMs: 15_000 });
  if (result.error === 'ENOENT') throw new TailscaleError('not_found', TAILSCALE_TEXT.notFound);
  // `status` exits non-zero while logged out but still prints JSON with BackendState.
  if (!result.stdout.trim()) throw new TailscaleError('command_failed', `tailscale status 失敗：${(result.stderr || result.error || '').trim()}`);
  return parseTailscaleStatus(result.stdout);
}

export const serveTarget = (port: number) => `http://127.0.0.1:${port}`;
export const serveArgs = (port: number) => ['serve', '--bg', '--https=443', serveTarget(port)];

type ServeConfig = {
  TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>; Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  /** `host:port` → true when `tailscale funnel` made that port public (ipn.ServeConfig.AllowFunnel). */
  AllowFunnel?: Record<string, boolean>; Foreground?: Record<string, ServeConfig>;
};

export interface ServeCheck {
  ok: boolean; reason?: string;
  /** E46 (SEC-3): set when Tailscale Funnel exposes a port that reaches the hub; `funnel_host_port` names it. */
  funnel?: true; funnel_host_port?: string;
}

const sameTarget = (proxy: string | undefined, port: number) => !!proxy &&
  [serveTarget(port), `http://localhost:${port}`, `127.0.0.1:${port}`, `localhost:${port}`, String(port)].includes(proxy.replace(/\/$/, ''));

/**
 * E46 (SEC-3): the `host:port` that Tailscale Funnel makes public and that reaches the hub (any web handler proxying to
 * it, or a TCP forward), from the top-level and every Foreground config; undefined when the hub stays tailnet-only.
 */
export function funnelExposure(value: ServeConfig, port: number): string | undefined {
  const configs = [value, ...Object.values(value?.Foreground ?? {})].filter(config => config && typeof config === 'object');
  const open = new Set(configs.flatMap(config => Object.entries(config.AllowFunnel ?? {}).filter(([, on]) => on === true).map(([hostPort]) => hostPort)));
  for (const hostPort of open) {
    const tcpPort = hostPort.split(':').at(-1) ?? '';
    const reaches = configs.some(config => Object.values(config.Web?.[hostPort]?.Handlers ?? {}).some(handler => sameTarget(handler?.Proxy, port)) ||
      sameTarget(config.TCP?.[tcpPort]?.TCPForward, port));
    if (reaches) return hostPort;
  }
  return undefined;
}

/** Checks `tailscale serve status --json` for 443 (HTTPS) proxying `/` to the hub (§2.7), and for Funnel (E46). */
export function parseServeStatus(json: string, port: number, dnsName?: string | null): ServeCheck {
  let value: ServeConfig;
  try { value = JSON.parse(json || '{}'); } catch { return { ok: false, reason: 'tailscale serve status --json 的輸出不是 JSON' }; }
  if (!value || typeof value !== 'object') return { ok: false, reason: TAILSCALE_TEXT.serveMissing(serveTarget(port)) };
  const exposed = funnelExposure(value, port);
  const funnel = exposed ? { funnel: true as const, funnel_host_port: exposed } : {};
  const configs = [value, ...Object.values(value?.Foreground ?? {})];
  for (const config of configs) {
    if (config?.TCP?.['443']?.HTTPS !== true) continue;
    for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
      if (!hostPort.endsWith(':443')) continue;
      if (dnsName && hostPort.slice(0, -4).toLowerCase() !== dnsName.toLowerCase()) continue;
      if (sameTarget(web?.Handlers?.['/']?.Proxy, port)) return { ok: true, ...funnel };
    }
  }
  return { ok: false, reason: TAILSCALE_TEXT.serveMissing(serveTarget(port)), ...funnel };
}

export async function serveStatus(exec: Exec, bin: string, port: number, dnsName?: string | null): Promise<ServeCheck> {
  const result = await exec(bin, ['serve', 'status', '--json'], { timeoutMs: 15_000 });
  if (result.error === 'ENOENT') return { ok: false, reason: TAILSCALE_TEXT.notFound };
  if (result.code !== 0) return { ok: false, reason: `tailscale serve status 失敗：${(result.stderr || result.error || '').trim()}` };
  return parseServeStatus(result.stdout, port, dnsName);
}

const httpsDisabledPattern = /https? (?:is )?(?:not|isn't) enabled|certificates? (?:are |is )?(?:not enabled|disabled)|enable https|serve is not enabled|login\.tailscale\.com\/f\/(?:serve|https)/i;

/** `tailscale serve --bg --https=443 http://127.0.0.1:<port>`; the setting persists across reboots (§2.7). */
export async function configureServe(exec: Exec, bin: string, port: number): Promise<{ ok: true } | { ok: false; code: 'https_disabled' | 'command_failed'; message: string; detail: string }> {
  const result = await exec(bin, serveArgs(port), { timeoutMs: 60_000 });
  if (result.code === 0 && !result.error) return { ok: true };
  const detail = `${result.stdout}\n${result.stderr}`.trim() || result.error || '';
  if (httpsDisabledPattern.test(detail) || result.error === 'ETIMEDOUT') return { ok: false, code: 'https_disabled', message: TAILSCALE_TEXT.httpsDisabled, detail };
  return { ok: false, code: 'command_failed', message: `tailscale serve 失敗：${detail}`, detail };
}

/** Days until the node key expires when that is within the warning window, else null. */
export function keyExpiryWarning(keyExpiry: string | null, now = new Date(), days = KEY_EXPIRY_WARNING_DAYS) {
  if (!keyExpiry) return null;
  const at = Date.parse(keyExpiry);
  if (Number.isNaN(at)) return null;
  const remaining = Math.floor((at - now.getTime()) / 86_400_000);
  return remaining <= days ? { days: Math.max(remaining, 0), date: new Date(at).toISOString().slice(0, 10) } : null;
}

const neutralNames = /^(?:hub|smartsell|smartsell-hub|ss-hub|server|home-?server|home-?hub|nas|mini|mac-?mini|mac-?studio|desktop|pc|win(?:dows)?(?:-?pc)?|mac|host)(?:-?\d{1,3})?$/i;

/** True unless the machine name is clearly neutral; the hub then prints the certificate-transparency reminder (§2.5). */
export function hostnameLooksPersonal(name: string | null) {
  if (!name) return false;
  return !neutralNames.test(name.split('.')[0]);
}

export interface TailscaleSnapshot {
  serve_ok: boolean | null; key_expiry: string | null; checked_at: string | null; reason?: string;
  /** E46: set (true) only when Tailscale Funnel exposes the hub to the internet; `funnel_warning` is the owner sentence. */
  funnel_on?: true; funnel_warning?: string;
}

/** Re-checks `tailscale serve` every 10 minutes for `/api/v1/hub/info` (§2.7). */
export function createTailscaleMonitor(options: { exec: Exec; port: number; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv;
  intervalMs?: number; now?: () => Date; findBinary?: () => Promise<string | undefined>; log?: (line: string) => void }) {
  const now = options.now ?? (() => new Date());
  let snapshot: TailscaleSnapshot = { serve_ok: null, key_expiry: null, checked_at: null };
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<TailscaleSnapshot> | undefined;
  const findBinary = options.findBinary ?? (() => findTailscale(options.exec, { platform: options.platform, env: options.env }));
  async function check(): Promise<TailscaleSnapshot> {
    const checkedAt = now().toISOString();
    const bin = await findBinary();
    if (!bin) return { serve_ok: false, key_expiry: null, checked_at: checkedAt, reason: TAILSCALE_TEXT.notFound };
    let self: TailnetSelf | undefined;
    try { self = await tailscaleStatus(options.exec, bin); } catch (error) {
      return { serve_ok: false, key_expiry: null, checked_at: checkedAt, reason: (error as Error).message };
    }
    const serve = await serveStatus(options.exec, bin, options.port, self.dnsName);
    return { serve_ok: serve.ok, key_expiry: self.keyExpiry, checked_at: checkedAt, ...(serve.reason ? { reason: serve.reason } : {}),
      ...(serve.funnel && { funnel_on: true, funnel_warning: TAILSCALE_TEXT.funnelOn(serve.funnel_host_port!, serveTarget(options.port)) }) };
  }
  return {
    snapshot: () => snapshot,
    refresh() {
      running ??= check().catch((error): TailscaleSnapshot => ({ serve_ok: false, key_expiry: null, checked_at: now().toISOString(), reason: (error as Error).message }))
        .then(result => {
          // E46: say it in the hub's own log too, once per change, so a funnel turned on later is not silent.
          if (result.funnel_on && !snapshot.funnel_on) options.log?.(`[警告] ${result.funnel_warning}`);
          snapshot = result; running = undefined; return result;
        });
      return running;
    },
    start() {
      if (timer) return;
      void this.refresh();
      timer = setInterval(() => void this.refresh(), options.intervalMs ?? SERVE_CHECK_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
