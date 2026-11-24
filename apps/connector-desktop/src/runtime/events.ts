// Runtime events for the App shell (interface C11, §11.2). The first five
// events are the frozen C11 set; `connection` and `jobs_changed` are additive
// (S9 review required, §11.1) so the shell can render §8.17 without polling.
import { EventEmitter } from 'node:events';

export interface JobsHeldEvent { publish_jobs: number; next_due_at: string | null }
export interface LocalAlertEvent {
  kind: 'blocker' | 'owner_click' | 'missed'; title: string; body: string; web_url: string | null;
  /** Additive (WA-8): the job that needs the owner on this machine; clicking the notification opens that job's Chrome. */
  job_id?: string;
}
export interface HubUnreachableEvent { since: string; jobs_due_2h: number }
export interface UpdateAvailableEvent {
  version: string; url: string; sha256: string;
  /** Additive (S9 C11 review suggestion 3): the package the hub offered, from heartbeat latest_worker.platform. */
  platform?: 'mac-arm64' | 'mac-x64' | 'win-x64';
}
export type ConnectionState = 'starting' | 'online' | 'reconnecting' | 'device_revoked' | 'stopped';
export interface ConnectionEvent {
  state: ConnectionState; next_retry_at: string | null; last_success_at: string | null;
  clock_offset_ms: number | null; clock_warning: boolean; message: string | null;
}
export interface LocalJobView {
  job_id: string; kind: string; provider: string; channel_label: string; state: string;
  not_before: string; not_after: string; blocker: { code: string; message: string } | null; dry_run: boolean;
  /** Additive (S9 C11 review): the shell wires 「開啟該 Chrome 處理」 without reading the job store. */
  social_account_id: string; profile_key: string;
}

/** Every `on()` returns a disposer that removes only that listener (S9 C11 review suggestion 2); C11 callers may ignore it. */
export type Unsubscribe = () => void;

export interface RuntimeEvents {
  on(event: 'jobs_held', fn: (e: JobsHeldEvent) => void): Unsubscribe;
  on(event: 'local_alert', fn: (e: LocalAlertEvent) => void): Unsubscribe;
  on(event: 'hub_unreachable', fn: (e: HubUnreachableEvent) => void): Unsubscribe;
  on(event: 'vault_locked', fn: () => void): Unsubscribe;
  on(event: 'update_available', fn: (e: UpdateAvailableEvent) => void): Unsubscribe;
  // Additive (not in frozen C11):
  on(event: 'connection', fn: (e: ConnectionEvent) => void): Unsubscribe;
  on(event: 'jobs_changed', fn: (e: { jobs: LocalJobView[] }) => void): Unsubscribe;
}

type EventMap = {
  jobs_held: [JobsHeldEvent];
  local_alert: [LocalAlertEvent];
  hub_unreachable: [HubUnreachableEvent];
  vault_locked: [];
  update_available: [UpdateAvailableEvent];
  connection: [ConnectionEvent];
  jobs_changed: [{ jobs: LocalJobView[] }];
};

/** Event hub shared by Supervisor and JobRunner. Listener errors never reach the runtime. */
export class RuntimeEventBus implements RuntimeEvents {
  readonly #emitter = new EventEmitter();
  #lastHeld = '';

  on<K extends keyof EventMap>(event: K, fn: (...args: EventMap[K]) => void): Unsubscribe {
    const listener = (...args: unknown[]) => {
      try { (fn as (...values: unknown[]) => void)(...args); } catch { /* The shell's handler must not break the runtime. */ }
    };
    this.#emitter.on(event, listener);
    return () => { this.#emitter.off(event, listener); };
  }

  /** Removes every listener of `event`; prefer the disposer `on()` returns. */
  off(event: keyof EventMap) { this.#emitter.removeAllListeners(event); }

  emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]) {
    this.#emitter.emit(event, ...args);
  }

  /** jobs_held is emitted only when its value changes, so power.ts can hold/release a blocker cheaply. */
  emitJobsHeld(event: JobsHeldEvent) {
    const key = JSON.stringify(event);
    if (key === this.#lastHeld) return;
    this.#lastHeld = key;
    this.emit('jobs_held', event);
  }
}
