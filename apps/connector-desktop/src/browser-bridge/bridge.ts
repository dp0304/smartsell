// The Worker's end of the SmartSell extension (core-automation-proposal §3.2). Chrome starts the native messaging host
// registered for com.smartsell.worker (native-host.ts writes it); the host is a byte relay (`nc -U` on macOS, a
// PowerShell pipe relay on Windows) between Chrome and this server's socket, so both ends speak Chrome's native
// messaging framing: a 32-bit little-endian length, then UTF-8 JSON. One connection is one Chrome profile with the
// extension installed.
//
// The socket lives in the Worker's data directory (0700) with mode 0600; on Windows it is a named pipe, which the
// default DACL opens read/write only to this user and administrators. No other authentication: a process that can open
// it already runs as the owner.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Chrome refuses messages to the extension above 1 MiB; replies to us may be up to 64 MiB (screenshots). */
export const MAX_TO_EXTENSION = 1024 * 1024;
export const MAX_FROM_EXTENSION = 64 * 1024 * 1024;
/** macOS limits sun_path to 104 bytes (Linux 108). */
const SUN_PATH_MAX = 100;

export function bridgeSocketPath(dataDir: string, platform = process.platform) {
  const digest = createHash('sha256').update(dataDir).digest('hex').slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\smartsell-worker-${digest}`;
  const inDataDir = join(dataDir, 'browser.sock');
  return Buffer.byteLength(inDataDir) <= SUN_PATH_MAX ? inDataDir : join(tmpdir(), `smartsell-${digest}.sock`);
}

export function encodeFrame(message: unknown) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Incremental decoder; throws on a frame above `max` (the connection is then closed). */
export class FrameReader {
  #buffer: Buffer = Buffer.alloc(0);
  constructor(private readonly max: number) {}
  push(chunk: Buffer): unknown[] {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    const out: unknown[] = [];
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32LE(0);
      if (length > this.max) throw new Error(`Frame of ${length} bytes is above the limit`);
      if (this.#buffer.length < 4 + length) break;
      const body = this.#buffer.subarray(4, 4 + length);
      this.#buffer = this.#buffer.subarray(4 + length);
      try { out.push(JSON.parse(body.toString('utf8'))); } catch { /* skip a malformed frame */ }
    }
    return out;
  }
}

export interface BrowserHello { install_id: string; version: string; chrome: string | null; file_access: boolean }
export type BrowserEvent =
  | { type: 'event'; tabId: number; method: string; params: Record<string, unknown> }
  | { type: 'detached'; tabId: number; reason: string }
  | { type: 'closed'; tabId: number };

export class BridgeRequestError extends Error {
  constructor(message: string, readonly op: string) { super(message); this.name = 'BridgeRequestError'; }
}
export class BrowserDisconnected extends Error {
  constructor() { super('Chrome 與 SmartSell Worker 的連線中斷了。'); this.name = 'BrowserDisconnected'; }
}

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; op: string };

/** One Chrome profile with the SmartSell extension, connected through its native host. */
export class BridgeBrowser {
  readonly id = randomUUID();
  readonly connectedAt: number;
  #pending = new Map<number, Pending>();
  #listeners = new Set<(event: BrowserEvent) => void>();
  #closeListeners = new Set<() => void>();
  #next = 0;
  #connected = true;

  constructor(private readonly socket: Socket, readonly hello: BrowserHello, now: number) { this.connectedAt = now; }

  /**
   * §3.5 measurement, read on every attach and never changed: what pages see in navigator.webdriver while SmartSell's
   * debugger is attached (expected false in the owner's Chrome). null until the first attach.
   */
  webdriver: boolean | null = null;

  get installId() { return this.hello.install_id; }
  get connected() { return this.#connected && !this.socket.destroyed; }

  request<T = unknown>(op: string, args: Record<string, unknown> = {}, timeoutMs = 10_000): Promise<T> {
    if (!this.connected) return Promise.reject(new BrowserDisconnected());
    const id = ++this.#next;
    const frame = encodeFrame({ id, op, ...args });
    if (frame.length - 4 > MAX_TO_EXTENSION) return Promise.reject(new BridgeRequestError('Request too large for Chrome', op));
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new BridgeRequestError('Chrome 沒有及時回應。', op)); }, timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve: value => resolve(value as T), reject, timer, op });
      this.socket.write(frame);
    });
  }

  onEvent(listener: (event: BrowserEvent) => void) {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  onClose(listener: () => void) {
    this.#closeListeners.add(listener);
    return () => { this.#closeListeners.delete(listener); };
  }

  /** @internal */
  deliver(message: Record<string, unknown>) {
    if (typeof message.id === 'number') {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined) pending.reject(new BridgeRequestError(String(message.error), pending.op));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.type === 'event' || message.type === 'detached' || message.type === 'closed') {
      for (const listener of this.#listeners) {
        try { listener(message as BrowserEvent); } catch { /* a listener must not break the bridge */ }
      }
    }
  }

  /** @internal */
  closed() {
    if (!this.#connected) return;
    this.#connected = false;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new BrowserDisconnected()); }
    this.#pending.clear();
    for (const listener of this.#closeListeners) { try { listener(); } catch { /* ignore */ } }
  }

  disconnect() { this.socket.destroy(); }
}

export interface BrowserBridgeOptions {
  socketPath: string;
  now?(): number;
  log?(message: string, detail?: object): void;
  /** A connection must say hello within this time (default 10 s). */
  helloTimeoutMs?: number;
}

export class BrowserBridge {
  #server?: Server;
  #browsers = new Map<string, BridgeBrowser>();
  #listeners = new Set<() => void>();
  #sockets = new Set<Socket>();

  constructor(private readonly options: BrowserBridgeOptions) {}

  get socketPath() { return this.options.socketPath; }

  async listen() {
    if (this.#server) return;
    if (process.platform !== 'win32') rmSync(this.options.socketPath, { force: true });
    const server = createServer(socket => this.#accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.socketPath, () => { server.off('error', reject); resolve(); });
    });
    if (process.platform !== 'win32') { try { chmodSync(this.options.socketPath, 0o600); } catch { /* best effort */ } }
    server.on('error', error => this.options.log?.('browser bridge error', { error: String(error) }));
    this.#server = server;
  }

  #accept(socket: Socket) {
    this.#sockets.add(socket);
    const reader = new FrameReader(MAX_FROM_EXTENSION);
    let browser: BridgeBrowser | undefined;
    const helloTimer = setTimeout(() => { if (!browser) socket.destroy(); }, this.options.helloTimeoutMs ?? 10_000);
    helloTimer.unref?.();
    socket.on('data', chunk => {
      let messages: unknown[];
      try { messages = reader.push(chunk); } catch { socket.destroy(); return; }
      for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const record = message as Record<string, unknown>;
        if (!browser) {
          if (record.type !== 'hello' || typeof record.install_id !== 'string' || !/^[0-9a-f-]{36}$/.test(record.install_id)) continue;
          clearTimeout(helloTimer);
          const hello: BrowserHello = { install_id: record.install_id, version: String(record.version ?? ''),
            chrome: typeof record.chrome === 'string' ? record.chrome : null, file_access: record.file_access === true };
          // The same profile reconnecting (service worker restart, Chrome restart) replaces its stale connection.
          this.#browsers.get(hello.install_id)?.disconnect();
          browser = new BridgeBrowser(socket, hello, this.options.now?.() ?? Date.now());
          this.#browsers.set(hello.install_id, browser);
          this.options.log?.('browser connected', { install_id: hello.install_id, version: hello.version, chrome: hello.chrome, file_access: hello.file_access });
          this.#changed();
        } else browser.deliver(record);
      }
    });
    const gone = () => {
      clearTimeout(helloTimer);
      this.#sockets.delete(socket);
      if (!browser) return;
      browser.closed();
      if (this.#browsers.get(browser.installId) === browser) {
        this.#browsers.delete(browser.installId);
        this.options.log?.('browser disconnected', { install_id: browser.installId });
        this.#changed();
      }
    };
    socket.on('close', gone);
    socket.on('error', () => socket.destroy());
  }

  #changed() { for (const listener of this.#listeners) { try { listener(); } catch { /* ignore */ } } }

  onChange(listener: () => void) {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  browsers(): BridgeBrowser[] { return [...this.#browsers.values()].filter(browser => browser.connected); }

  browser(installId: string) {
    const found = this.#browsers.get(installId);
    return found?.connected ? found : undefined;
  }

  /** Resolves with the first connected browser (already connected or the next one), or undefined on timeout. */
  waitForBrowser(timeoutMs: number): Promise<BridgeBrowser | undefined> {
    const [first] = this.browsers();
    if (first) return Promise.resolve(first);
    return new Promise(resolve => {
      const timer = setTimeout(() => { stop(); resolve(undefined); }, timeoutMs);
      const stop = this.onChange(() => {
        const [next] = this.browsers();
        if (next) { clearTimeout(timer); stop(); resolve(next); }
      });
    });
  }

  async close() {
    for (const socket of this.#sockets) socket.destroy();
    const server = this.#server;
    this.#server = undefined;
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (process.platform !== 'win32') rmSync(this.options.socketPath, { force: true });
  }
}
