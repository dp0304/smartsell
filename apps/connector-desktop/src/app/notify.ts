// OS notifications (§5.9 channels 2 and 4, §8.2, §8.18). The Electron
// Notification class is injected so this module runs in node:test. Owner
// copy is zh-Hant; clicking a notification opens its web_url when it has one.

export interface NotificationLike {
  show(): void;
  on(event: 'click', listener: () => void): unknown;
}
export interface NotificationOptions { title: string; body: string; silent?: boolean; urgency?: 'normal' | 'critical' | 'low' }

export interface NotifierDeps {
  create(options: NotificationOptions): NotificationLike;
  supported(): boolean;
  /** Opens a web_url (shell.openExternal); only https or loopback http URLs are ever passed. */
  open(url: string): void;
  now?(): number;
  log?(message: string, detail?: object): void;
}

export interface ShownNotification { title: string; body: string; url: string | null; urgent: boolean; at: string; key: string | null }

export interface NotifyInput {
  title: string; body: string; url?: string | null; urgent?: boolean; key?: string;
  /** Click action when there is no web_url (WA-8: open the job's Chrome on this machine for the owner's Post click). */
  action?: () => void;
}

const HISTORY = 20;

export function safeWebUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const parsed = URL.parse(url);
  if (!parsed || parsed.username || parsed.password) return null;
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) return null;
  return parsed.href;
}

export class Notifier {
  readonly #deps: NotifierDeps;
  readonly #shownKeys = new Set<string>();
  readonly #history: ShownNotification[] = [];

  constructor(deps: NotifierDeps) { this.#deps = deps; }

  /** Shows one notification. A `key` is shown at most once per App run. Returns whether it was shown. */
  notify(input: NotifyInput): boolean {
    if (input.key) {
      if (this.#shownKeys.has(input.key)) return false;
      this.#shownKeys.add(input.key);
    }
    const url = safeWebUrl(input.url);
    const entry: ShownNotification = { title: input.title, body: input.body, url, urgent: input.urgent === true,
      at: new Date((this.#deps.now ?? Date.now)()).toISOString(), key: input.key ?? null };
    this.#history.unshift(entry);
    this.#history.length = Math.min(this.#history.length, HISTORY);
    if (!this.#deps.supported()) {
      this.#deps.log?.('OS notifications are not supported here', { title: input.title });
      return false;
    }
    try {
      const notification = this.#deps.create({ title: input.title, body: input.body, urgency: input.urgent ? 'critical' : 'normal' });
      if (url) notification.on('click', () => this.#deps.open(url));
      else if (input.action) {
        const action = input.action;
        notification.on('click', () => { try { action(); } catch (error) { this.#deps.log?.('notification action failed', { error: String(error) }); } });
      }
      notification.show();
      return true;
    } catch (error) {
      this.#deps.log?.('notification failed', { error: String(error) });
      return false;
    }
  }

  /** Forget a key so the same condition can notify again (for example the vault unlocked and locked again). */
  reset(key: string) { this.#shownKeys.delete(key); }

  history(): ShownNotification[] { return this.#history.map(item => ({ ...item })); }
}

/** Fixed owner copy for the notifications the App raises itself (zh-Hant, §5.9, §8.2, §8.18). */
export const COPY = {
  vaultLockedTitle: 'SmartSell 無法連線',
  vaultLocked(machine: string, platform: NodeJS.Platform) {
    return platform === 'darwin'
      ? `SmartSell 需要在 ${machine} 允許鑰匙圈存取，否則無法連線。請到 ${machine} 前開啟 SmartSell Worker，出現鑰匙圈提示時按「永遠允許」。`
      : `SmartSell 無法在 ${machine} 讀取配對金鑰（Windows 認證儲存），因此無法連線。請到 ${machine} 前開啟 SmartSell Worker 處理。`;
  },
  hubUnreachableTitle: '中樞連不上',
  hubUnreachable(machine: string, jobs: number) {
    return `中樞 10 分鐘連不上，${machine} 有 ${jobs} 則貼文待發；到點會依離線規則照發。`;
  },
  updateAvailableTitle: 'SmartSell Worker 有新版本',
  updateAvailable(version: string) { return `SmartSell Worker ${version} 可更新。打開 SmartSell Worker 按「更新」（有貼文正在發布時不能更新）。`; },
  deviceRevokedTitle: 'SmartSell Worker 已停止連線',
  deviceRevoked(machine: string, message: string | null) { return message ?? `${machine} 已在中樞被撤銷或停用。`; },
  agentUnauthorizedTitle: 'SmartSell 通知已中斷',
  agentUnauthorized: '這台筆電的連線已在中樞撤銷或過期。請在 SmartSell 按「連接 Codex／Claude Code」重新連接。',
} as const;
