// Laptop Agent mode: owner alert stream (§5.9 channel 2, §6.2). Subscribes to
// GET /api/v1/agent/alerts/stream with the agent connection token (read-only
// SSE), shows every owner_alert as an OS notification whose click opens
// web_url, keeps the last 20, and reconnects with Last-Event-ID so nothing is
// lost across hub restarts or Wi-Fi drops. A fresh subscription starts at the
// newest alert (the hub sends `id:` first), so history is never replayed.
import type { OwnerAlert } from '@smartsell/contracts';

export const ALERT_STREAM_PATH = '/api/v1/agent/alerts/stream';
const MAX_EVENT = 256 * 1024;
const RECENT = 20;

export type AlertStreamState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'unauthorized' | 'stopped';

export interface AlertStreamOptions {
  hubOrigin: string;
  token: string;
  fetch?: typeof fetch;
  /** Restricts the stream to one machine (the Worker App's own alerts, S10 ledger item 16). */
  machineId?: string;
  /** Resume point across App restarts. */
  lastEventId?: string | null;
  saveLastEventId?(id: string): void;
  onAlert(alert: OwnerAlert, meta: { id: string | null; replayed: boolean }): void;
  onState?(state: AlertStreamState, detail: { retry_ms: number | null; error: string | null }): void;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  random?(): number;
  /** Reconnect when nothing (not even a heartbeat comment) arrived for this long. */
  idleTimeoutMs?: number;
}

export interface SseEvent { id: string | null; event: string; data: string; retry: number | null }

/** Incremental text/event-stream parser (WHATWG rules: id, event, data, retry; comments ignored). */
export class SseParser {
  #buffer = '';
  #data: string[] = [];
  #event = '';
  #id: string | null = null;
  #retry: number | null = null;
  #touched = false;

  push(chunk: string): SseEvent[] {
    this.#buffer += chunk;
    if (this.#buffer.length > MAX_EVENT && !this.#buffer.includes('\n')) throw new Error('SSE line too long');
    const out: SseEvent[] = [];
    let index: number;
    while ((index = this.#buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = this.#buffer.slice(0, index);
      const width = this.#buffer.startsWith('\r\n', index) ? 2 : 1;
      this.#buffer = this.#buffer.slice(index + width);
      if (line === '') {
        if (this.#touched && (this.#data.length || this.#retry !== null || this.#id !== null)) {
          out.push({ id: this.#id, event: this.#event || 'message', data: this.#data.join('\n'), retry: this.#retry });
        }
        this.#data = []; this.#event = ''; this.#retry = null; this.#touched = false;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      this.#touched = true;
      if (field === 'data') this.#data.push(value);
      else if (field === 'event') this.#event = value;
      else if (field === 'id' && !value.includes('\0')) this.#id = value;
      else if (field === 'retry' && /^\d+$/.test(value)) this.#retry = Number(value);
    }
    return out;
  }
}

function isOwnerAlert(value: unknown): value is OwnerAlert {
  const alert = value as OwnerAlert;
  return !!alert && typeof alert === 'object' && typeof alert.id === 'string' && typeof alert.kind === 'string' &&
    typeof alert.title === 'string' && typeof alert.body === 'string' && typeof alert.web_url === 'string' &&
    ['urgent', 'normal', 'info'].includes(alert.severity);
}

const defaultSleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
});

export class AlertStream {
  readonly #o: AlertStreamOptions;
  #state: AlertStreamState = 'idle';
  #stop = new AbortController();
  #lastId: string | null;
  #retryMs = 2000;
  #failures = 0;
  #loop?: Promise<void>;
  #recent: OwnerAlert[] = [];
  /** True until the first event of a connection that resumed with Last-Event-ID has been delivered. */
  #resuming = false;

  constructor(options: AlertStreamOptions) {
    this.#o = options;
    this.#lastId = options.lastEventId && /^\d{1,15}$/.test(options.lastEventId) ? options.lastEventId : null;
  }

  get state() { return this.#state; }
  get lastEventId() { return this.#lastId; }
  recent(): OwnerAlert[] { return this.#recent.map(alert => ({ ...alert })); }

  start() {
    if (this.#loop) return this.#loop;
    this.#stop = new AbortController();
    this.#loop = this.#run().finally(() => { this.#loop = undefined; });
    return this.#loop;
  }

  async stop() {
    this.#stop.abort();
    await this.#loop?.catch(() => {});
    this.#set('stopped', null, null);
  }

  #set(state: AlertStreamState, retry: number | null, error: string | null) {
    this.#state = state;
    this.#o.onState?.(state, { retry_ms: retry, error });
  }

  async #run() {
    const sleep = this.#o.sleep ?? defaultSleep;
    while (!this.#stop.signal.aborted) {
      const outcome = await this.#connect();
      if (this.#stop.signal.aborted) break;
      if (outcome === 'unauthorized') { this.#set('unauthorized', null, 'UNAUTHENTICATED'); return; }
      // A clean end (hub restart) waits the server's retry; errors back off 2 s → 60 s with ±20% jitter.
      const base = outcome === 'ended' ? this.#retryMs : Math.min(60_000, this.#retryMs * 2 ** Math.min(this.#failures - 1, 5));
      const delay = Math.round(base * (0.8 + 0.4 * (this.#o.random ?? Math.random)()));
      this.#set('reconnecting', delay, outcome === 'ended' ? null : outcome);
      await sleep(delay, this.#stop.signal);
    }
  }

  async #connect(): Promise<'ended' | 'unauthorized' | string> {
    this.#set(this.#failures ? 'reconnecting' : 'connecting', null, null);
    const url = new URL(ALERT_STREAM_PATH, this.#o.hubOrigin);
    if (this.#o.machineId) url.searchParams.set('machine_id', this.#o.machineId);
    const headers: Record<string, string> = { authorization: `Bearer ${this.#o.token}`, accept: 'text/event-stream', 'cache-control': 'no-cache' };
    if (this.#lastId !== null) headers['last-event-id'] = this.#lastId;
    this.#resuming = this.#lastId !== null;
    const connection = new AbortController();
    const signal = AbortSignal.any([this.#stop.signal, connection.signal]);
    let idle: ReturnType<typeof setTimeout> | undefined;
    const touch = () => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => connection.abort(new Error('idle')), this.#o.idleTimeoutMs ?? 45_000);
      idle.unref?.();
    };
    try {
      touch();
      const response = await (this.#o.fetch ?? fetch)(url, { headers, signal, redirect: 'error', cache: 'no-store' });
      if (response.status === 401 || response.status === 403) { await response.body?.cancel().catch(() => {}); return 'unauthorized'; }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => {});
        this.#failures += 1;
        return `HTTP_${response.status}`;
      }
      if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
        await response.body.cancel().catch(() => {});
        this.#failures += 1;
        return 'NOT_EVENT_STREAM';
      }
      this.#failures = 0;
      this.#set('open', null, null);
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          touch();
          for (const event of parser.push(decoder.decode(value, { stream: true }))) this.#dispatch(event);
        }
      } finally { reader.releaseLock(); }
      return 'ended';
    } catch (error) {
      if (this.#stop.signal.aborted) return 'ended';
      this.#failures += 1;
      return error instanceof Error && error.message === 'idle' ? 'IDLE_TIMEOUT' : 'NETWORK';
    } finally {
      if (idle) clearTimeout(idle);
      connection.abort();
    }
  }

  #dispatch(event: SseEvent) {
    if (event.retry !== null) this.#retryMs = Math.min(Math.max(event.retry, 500), 60_000);
    if (event.event === 'owner_alert') {
      let alert: unknown;
      try { alert = JSON.parse(event.data); } catch { alert = undefined; }
      if (isOwnerAlert(alert)) {
        this.#recent.unshift(alert);
        this.#recent.length = Math.min(this.#recent.length, RECENT);
        try { this.#o.onAlert(alert, { id: event.id, replayed: this.#resuming }); } catch { /* UI handler errors never stop the stream */ }
      }
    }
    if (event.id !== null && /^\d{1,15}$/.test(event.id)) {
      this.#lastId = event.id;
      try { this.#o.saveLastEventId?.(event.id); } catch { /* best effort */ }
    }
  }
}

/** Alerts older than this are listed but not shown as OS notifications (after a long App shutdown). */
export const NOTIFY_MAX_AGE_MS = 60 * 60_000;

export function shouldNotify(alert: OwnerAlert, now: number) {
  const at = Date.parse(alert.at);
  return !Number.isFinite(at) || now - at <= NOTIFY_MAX_AGE_MS;
}
