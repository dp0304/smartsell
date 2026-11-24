// Hub clock offset (§8.2): every response updates
//   offset = server_time - (sent + rtt / 2)
// and every signature timestamp and job schedule uses now() + offset.

export interface Timers {
  /** Hub-corrected wall time in ms. */
  now(): number;
  /** Resolves after `ms` of hub time, or rejects with the signal's reason. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const CLOCK_WARN_MS = 30_000;

export interface ClockSource { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }

export const systemSource: ClockSource = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, Math.max(0, ms));
    const abort = () => { clearTimeout(timer); reject(signal!.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  }),
};

export class HubClock implements Timers {
  #offset: number | null;
  constructor(private readonly source: ClockSource = systemSource, initialOffset: number | null = null) {
    this.#offset = initialOffset;
  }

  /** Offset in ms between hub time and local time; null until the first response. */
  get offsetMs() { return this.#offset; }
  /** Raw local time (used to measure round trips). */
  localNow() { return this.source.now(); }
  now() { return this.source.now() + (this.#offset ?? 0); }
  sleep(ms: number, signal?: AbortSignal) { return this.source.sleep(ms, signal); }

  /** Records a measured exchange. `serverTime` is the body's server_time or the Date header. */
  observe(sentAt: number, receivedAt: number, serverTime: number | null) {
    if (serverTime === null || !Number.isFinite(serverTime) || receivedAt < sentAt) return;
    const rtt = receivedAt - sentAt;
    this.#offset = Math.round(serverTime - (sentAt + rtt / 2));
  }

  /** Restores the last persisted offset after a restart. */
  restore(offsetMs: number) { if (Number.isFinite(offsetMs)) this.#offset = Math.round(offsetMs); }

  /** Date-header only correction for 401 DEVICE_PROOF_EXPIRED (second resolution, so no RTT). */
  observeDate(serverDate: number | null) {
    if (serverDate === null || !Number.isFinite(serverDate)) return false;
    this.#offset = Math.round(serverDate - this.source.now());
    return true;
  }

  /** §5.7 rule 3: offline go needs a known offset no larger than CLOCK_MARGIN_MS. */
  trustedForOffline(marginMs: number) {
    return this.#offset !== null && Math.abs(this.#offset) <= marginMs;
  }

  /** §8.2: show a warning when the offset is larger than 30 seconds. */
  get skewWarning() { return this.#offset !== null && Math.abs(this.#offset) > CLOCK_WARN_MS; }
}

export function parseServerTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
