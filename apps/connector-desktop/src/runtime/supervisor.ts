// Connection loop (§8.2): heartbeat v2 every 15 s; after each success the
// hub's hold/mode/resume_token/pause flags are written to disk (fsync) and
// only then last_sync_at; the outbox is drained before claiming; failures
// back off 2–60 s with ±20% jitter (15 s cap when a job is due within 10 min).
import {
  isFactReport, type DevicePosture, type HeartbeatV2Request, type HeartbeatV2Response, type JobReportData, type RemoteAccess,
} from './contracts.ts';
import type { HubClock } from './clock.ts';
import type { ConnectionEvent, ConnectionState, RuntimeEventBus } from './events.ts';
import { isLocalFinal, type JobStore, type StoredOutboxEntry } from './job-store.ts';
import type { JobRunner } from './job-runner.ts';
import type { Profiles } from './profiles.ts';
import { EVIDENCE_MAX_BYTES, HubError, type HubApi } from './protocol.ts';
import { compareVersions, type SelectorStore } from '../drivers/selectors.ts';
import type { DriverRegistry } from '../drivers/registry.ts';

export const HEARTBEAT_MS = 15_000;
const BACKOFF_STEPS_S = [2, 4, 8, 16, 32, 60];
const POSTURE_EVERY_MS = 30 * 60_000;
const UNREACHABLE_ALERT_MS = 10 * 60_000;

/** Reconnect delay after `failures` consecutive failures (≥ 1). The jitter is for the hub link only, never for platform pages. */
export function backoffDelay(failures: number, jobDueSoon: boolean, random: () => number = Math.random) {
  const base = BACKOFF_STEPS_S[Math.min(Math.max(failures, 1), BACKOFF_STEPS_S.length) - 1] * 1000;
  const capped = jobDueSoon ? Math.min(base, 15_000) : base;
  return Math.round(capped * (0.8 + 0.4 * random()));
}

/** E9: only the two architectures the installers are built for; anything else is omitted (the hub then defaults). */
export function heartbeatArch(arch: string): HeartbeatV2Request['arch'] | undefined {
  return arch === 'arm64' || arch === 'x64' ? arch : undefined;
}

function versionNewer(offered: string, current: string) {
  const parse = (value: string) => value.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0);
  const left = parse(offered), right = parse(current);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0);
  }
  return false;
}

function evidenceRefs(data: JobReportData): string[] {
  const value = data as { evidence_sha256?: string[]; blocker?: { evidence_sha256?: string[] } };
  return [...(value.evidence_sha256 ?? []), ...(value.blocker?.evidence_sha256 ?? [])];
}

export interface SupervisorOptions {
  hub: HubApi;
  store: JobStore;
  runner: JobRunner;
  clock: HubClock;
  events: RuntimeEventBus;
  drivers: Pick<DriverRegistry, 'health'>;
  selectors: SelectorStore;
  profiles?: Pick<Profiles, 'ensure'>;
  clientVersion: string;
  /** E9: CPU architecture sent in heartbeat v2 so latest_worker names this machine's package. Defaults to process.arch. */
  arch?: string;
  heartbeatMs?: number;
  posture?: () => DevicePosture | null;
  remoteAccess?: () => RemoteAccess | null;
  random?: () => number;
  log?(message: string, detail?: object): void;
}

export class Supervisor {
  readonly #o: SupervisorOptions;
  #stopped = false;
  #failures = 0;
  #firstFailureAt: number | null = null;
  #unreachableAlerted = false;
  #state: ConnectionState = 'starting';
  #message: string | null = null;
  #lastSuccessAt: number | null = null;
  #nextRetryAt: number | null = null;
  #flushing: Promise<void> | null = null;
  #flushAgain = false;
  #rejectedConfig: string | null = null;
  #announcedUpdate: string | null = null;
  #sleep?: AbortController;
  #loop?: Promise<void>;
  #ticks = 0;

  constructor(options: SupervisorOptions) {
    this.#o = options;
    // The last known offset survives restarts so offline go can still check the clock (§5.7 rule 3).
    const offset = options.store.state().clock_offset_ms;
    if (offset !== null && options.clock.offsetMs === null) options.clock.restore(offset);
  }

  get state() { return this.#state; }
  get failures() { return this.#failures; }

  #log(message: string, detail?: object) { this.#o.log?.(message, detail); }

  #emitConnection() {
    const event: ConnectionEvent = {
      state: this.#state, message: this.#message,
      next_retry_at: this.#nextRetryAt ? new Date(this.#nextRetryAt).toISOString() : null,
      last_success_at: this.#lastSuccessAt ? new Date(this.#lastSuccessAt).toISOString() : null,
      clock_offset_ms: this.#o.clock.offsetMs, clock_warning: this.#o.clock.skewWarning,
    };
    this.#o.events.emit('connection', event);
  }

  start() {
    this.#stopped = false;
    this.#loop ??= this.#run();
    return this.#loop;
  }

  async stop() {
    this.#stopped = true;
    this.#sleep?.abort();
    await this.#loop?.catch(() => {});
    this.#loop = undefined;
    if (this.#state !== 'device_revoked') { this.#state = 'stopped'; this.#emitConnection(); }
  }

  async #run() {
    const ended = () => this.#stopped || this.#state === 'device_revoked';
    while (!ended()) {
      const delay = await this.tick();
      if (ended()) break;
      this.#sleep = new AbortController();
      try { await this.#o.clock.sleep(delay, this.#sleep.signal); } catch { /* woken */ }
    }
  }

  #jobsDueWithin(ms: number) {
    const now = this.#o.clock.now();
    return this.#o.store.jobs().filter(job => !isLocalFinal(job.state) && job.claimed.kind === 'publish_post' && Date.parse(job.claimed.not_before) - now <= ms).length;
  }

  /** One heartbeat cycle. Returns the delay before the next one. */
  async tick(): Promise<number> {
    const heartbeatMs = this.#o.heartbeatMs ?? HEARTBEAT_MS;
    try {
      const { request, postureKey } = this.#heartbeatRequest();
      const response = await this.#o.hub.heartbeat(request);
      this.#applyHeartbeat(request, response, postureKey);
      this.#onSuccess();
      await this.flushOutbox();
      if (response.claimable > 0 || this.#jobsDueWithin(2 * 3600_000) > 0) await this.#claim();
      await this.#driverConfig(response);
      if (response.latest_worker && versionNewer(response.latest_worker.version, this.#o.clientVersion) && this.#announcedUpdate !== response.latest_worker.version) {
        this.#announcedUpdate = response.latest_worker.version;
        this.#o.events.emit('update_available', { version: response.latest_worker.version, url: response.latest_worker.url, sha256: response.latest_worker.sha256,
          ...(response.latest_worker.platform && { platform: response.latest_worker.platform }),
          ...(response.latest_worker.signature && { signature: response.latest_worker.signature }) });
      }
      if (++this.#ticks % 20 === 0) this.#housekeeping();
      this.#o.runner.tick();
      return heartbeatMs;
    } catch (error) {
      return this.#onFailure(error);
    }
  }

  #housekeeping() {
    try { this.#o.store.collect(this.#o.clock.now()); } catch (error) { this.#log('store housekeeping failed', { error: String(error) }); }
  }

  #onSuccess() {
    this.#failures = 0;
    this.#firstFailureAt = null;
    this.#unreachableAlerted = false;
    this.#lastSuccessAt = this.#o.clock.now();
    this.#nextRetryAt = null;
    this.#state = 'online';
    this.#message = null;
    this.#emitConnection();
  }

  #onFailure(error: unknown): number {
    const failure = error instanceof HubError ? error : new HubError('network', error instanceof Error ? error.message : String(error));
    if (failure.kind === 'device_revoked' || failure.kind === 'proof_expired') {
      // §8.2: stop connecting and tell the owner on this machine.
      this.#state = 'device_revoked';
      this.#message = failure.kind === 'proof_expired' ? '這台機器的時間與中樞差太多，簽章一直被拒絕。請校正系統時間後重新啟動 SmartSell。' : '此機器已在中樞被撤銷或停用。';
      this.#nextRetryAt = null;
      this.#emitConnection();
      this.#log('device rejected by the hub', { code: failure.code, status: failure.status });
      return 0;
    }
    const now = this.#o.clock.now();
    this.#failures += 1;
    this.#firstFailureAt ??= now;
    // Facts still in the outbox (e.g. a post made offline while the hub was down) reconnect as fast as a job due soon,
    // so the hub hears the result within a minute of coming back (§5.7, E2E-2).
    const dueSoon = this.#jobsDueWithin(10 * 60_000) > 0 || this.#o.store.outboxDepth() > 0;
    const delay = failure.kind === 'busy' && failure.retryAfterMs !== null ? failure.retryAfterMs : backoffDelay(this.#failures, dueSoon, this.#o.random);
    this.#state = 'reconnecting';
    this.#message = null;
    this.#nextRetryAt = now + delay;
    this.#emitConnection();
    const due2h = this.#jobsDueWithin(2 * 3600_000);
    if (!this.#unreachableAlerted && now - this.#firstFailureAt >= UNREACHABLE_ALERT_MS && due2h > 0) {
      this.#unreachableAlerted = true;
      this.#o.events.emit('hub_unreachable', { since: new Date(this.#firstFailureAt).toISOString(), jobs_due_2h: due2h });
    }
    this.#log('heartbeat failed', { kind: failure.kind, status: failure.status, code: failure.code, retry_ms: delay });
    return delay;
  }

  #heartbeatRequest(): { request: HeartbeatV2Request; postureKey: string | undefined } {
    const { store, clock, selectors, drivers } = this.#o;
    const state = store.state();
    const jobs = store.jobs().filter(job => !isLocalFinal(job.state)).map(job => ({ job_id: job.claimed.job_id, local_state: job.state, fencing_token: job.fence }));
    const request: HeartbeatV2Request = {
      client_version: this.#o.clientVersion, protocol: 2, drivers: drivers.health(selectors.health), jobs,
      ...(state.released_jobs.length && { released_jobs: [...state.released_jobs] }),
      outbox_depth: store.outboxDepth(), worker_time: new Date(clock.now()).toISOString(), applied_sync_generation: state.applied_sync_generation,
    };
    const arch = heartbeatArch(this.#o.arch ?? process.arch);
    if (arch) request.arch = arch;
    // posture and remote_access only when changed, and at least every 30 minutes (§5.4.1).
    const posture = this.#o.posture?.() ?? null;
    const remote = this.#o.remoteAccess?.() ?? null;
    let postureKey: string | undefined;
    if (this.#o.posture || this.#o.remoteAccess) {
      const key = JSON.stringify([posture, remote]);
      const due = !state.posture_sent_at || clock.now() - Date.parse(state.posture_sent_at) >= POSTURE_EVERY_MS;
      if (key !== state.posture_key || due) {
        if (posture) request.posture = posture;
        if (this.#o.remoteAccess) request.remote_access = remote;
        postureKey = key;
      }
    }
    return { request, postureKey };
  }

  /** §8.2: write every synced value (fsync), then last_sync_at, then wake the runner. */
  #applyHeartbeat(request: HeartbeatV2Request, response: HeartbeatV2Response, sentPosture: string | undefined) {
    const { store, clock } = this.#o;
    if (!response || response.status !== 'online' || response.protocol !== 2 || !Array.isArray(response.jobs) || !Array.isArray(response.channels)) {
      throw new HubError('client', 'Unexpected heartbeat response');
    }
    const syncedAt = new Date(clock.now()).toISOString();
    const revoked = new Set((response.revoked_jobs ?? []).map(item => item.job_id));
    const channelPaused = new Map(response.channels.map(channel => [channel.social_account_id, channel.paused]));
    const lostFence: string[] = [];
    for (const job of store.jobs()) {
      if (isLocalFinal(job.state)) continue;
      const held = response.jobs.find(item => item.job_id === job.claimed.job_id);
      store.update(job.claimed.job_id, value => {
        if (held) {
          value.sync = { hold: held.hold, hold_reason: held.hold_reason, mode: held.mode, resume_token: held.resume_token,
            machine_paused: response.paused, pause_all: response.pause_all,
            channel_paused: channelPaused.get(value.claimed.payload.channel.social_account_id) ?? false, synced_at: syncedAt };
          value.hub_absent = 0;
          if (held.fencing_token !== value.fence) lostFence.push(value.claimed.job_id);
        } else if (!revoked.has(value.claimed.job_id)) {
          value.hub_absent = (value.hub_absent ?? 0) + 1;
        }
        if (revoked.has(value.claimed.job_id)) value.revoked = true;
      });
    }
    store.updateState(state => {
      state.machine = { paused: response.paused, pause_all: response.pause_all, synced_at: syncedAt };
      state.channels = response.channels;
      state.applied_sync_generation = response.sync_generation;
      state.clock_offset_ms = clock.offsetMs;
      const sent = new Set(request.released_jobs ?? []);
      state.released_jobs = state.released_jobs.filter(id => !sent.has(id));
      if (sentPosture !== undefined) { state.posture_key = sentPosture; state.posture_sent_at = syncedAt; }
    });
    // Only after the synced state is on disk.
    store.updateState(state => { state.last_sync_at = syncedAt; });
    for (const job of store.jobs()) {
      if (isLocalFinal(job.state)) continue;
      store.update(job.claimed.job_id, value => { value.last_sync_at = syncedAt; });
    }
    for (const id of lostFence) this.#o.runner.fenceLost(id);
    for (const channel of response.channels) {
      try { this.#o.profiles?.ensure(channel.profile_key); } catch { /* invalid key: ignored */ }
    }
    this.#o.runner.synced();
  }

  async #claim() {
    const { store, clock, hub } = this.#o;
    const pending = new Set(store.outbox().map(entry => entry.job_id));
    const held = [...new Set([...store.heldJobIds(), ...pending])];
    const response = await hub.claim({ kinds: ['publish_post', 'check_login'], horizon_minutes: 1440, max: 10, held_job_ids: held });
    if (!response || !Array.isArray(response.jobs)) throw new HubError('client', 'Unexpected claim response');
    store.updateState(state => { state.last_sync_at = new Date(clock.now()).toISOString(); });
    if (response.jobs.length) this.#o.runner.addClaimed(response.jobs);
  }

  async #driverConfig(response: HeartbeatV2Response) {
    const offered = response.driver_config;
    const { selectors } = this.#o;
    if (!offered || !selectors.needsUpdate(offered) || this.#rejectedConfig === `${offered.version}:${offered.sha256}`) return;
    try {
      const bytes = await this.#o.hub.driverConfig();
      const applied = selectors.apply(bytes, offered);
      if (!applied.ok) {
        this.#rejectedConfig = `${offered.version}:${offered.sha256}`;
        this.#log('driver config rejected', { version: offered.version, reason: applied.reason });
      } else this.#o.store.updateState(state => { state.driver_config = offered; });
    } catch (error) {
      this.#log('driver config download failed', { error: String(error) });
    }
  }

  /** Called by the runner after every outbox write. */
  flushSoon() {
    if (this.#state !== 'online') return;
    void this.flushOutbox().catch(error => this.#log('outbox flush failed', { error: String(error) }));
  }

  /** Sends the outbox in file order; evidence before the report that cites it (§8.13). */
  flushOutbox(): Promise<void> {
    if (this.#flushing) { this.#flushAgain = true; return this.#flushing; }
    this.#flushing = (async () => {
      try {
        do {
          this.#flushAgain = false;
          await this.#drain();
        } while (this.#flushAgain);
      } finally { this.#flushing = null; }
    })();
    return this.#flushing;
  }

  async #drain() {
    const { store, hub } = this.#o;
    let restart = true;
    let rounds = 0;
    while (restart && rounds++ < 8) {
      restart = false;
      for (const entry of store.outbox()) {
        if (!await this.#uploadEvidence(entry)) return;
        try {
          await hub.report(entry.report);
          store.removeOutbox(entry);
        } catch (error) {
          const failure = error instanceof HubError ? error : new HubError('network', String(error));
          if (failure.kind === 'fence_lost') {
            // §8.2: drop only this job's lease reports; facts keep going.
            for (const other of store.outbox()) if (other.job_id === entry.job_id && other.kind === 'lease') store.removeOutbox(other);
            if (entry.kind === 'fact') store.removeOutbox(entry);
            this.#o.runner.fenceLost(entry.job_id);
            restart = true;
            break;
          }
          if (failure.kind === 'seq_gap' && failure.expected !== null) {
            this.#renumber(entry, failure.expected);
            restart = true;
            break;
          }
          if (failure.kind === 'seq_conflict') {
            this.#log('SEQ_CONFLICT: dropping report', { job_id: entry.job_id, seq: entry.seq, event: entry.report.event });
            store.removeOutbox(entry);
            continue;
          }
          if (failure.kind === 'client') {
            this.#log('hub rejected report; dropping it', { job_id: entry.job_id, event: entry.report.event, status: failure.status, code: failure.code, fact: isFactReport(entry.report) });
            store.removeOutbox(entry);
            continue;
          }
          return; // network, server, busy, revoked: retry on the next cycle
        }
      }
    }
  }

  /** SEQ_GAP {expected}: resend from `expected`; if entries before it were dropped, renumber the pending ones (same event_id). */
  #renumber(entry: StoredOutboxEntry, expected: number) {
    const { store } = this.#o;
    const pending = store.outbox().filter(item => item.job_id === entry.job_id && item.fencing_token === entry.fencing_token).sort((a, b) => a.seq - b.seq);
    if (!pending.length || pending.some(item => item.seq === expected)) return;
    pending.forEach((item, index) => {
      const seq = expected + index;
      store.rewriteOutbox({ ...item, seq, report: { ...item.report, seq } });
    });
    const job = store.get(entry.job_id);
    if (job && job.fence === entry.fencing_token) store.update(entry.job_id, value => { value.next_seq = expected + pending.length; });
  }

  /**
   * Uploads the screenshots a report cites. A screenshot that can never be sent (WA-4: over the hub's 4 MiB limit, or
   * its file is gone) is marked rejected and logged like a hub 4xx, so the report still goes out (the hub records the
   * missing evidence) and the rest of the outbox is not held behind it. Only a hub that cannot be reached stops the drain.
   */
  async #uploadEvidence(entry: StoredOutboxEntry) {
    const { store, hub } = this.#o;
    const wanted = new Set(evidenceRefs(entry.report.data));
    if (!wanted.size) return true;
    const reject = (sha256: string, reason: string) => {
      this.#log('evidence not sent', { job_id: entry.job_id, sha256, reason });
      try { store.markEvidence(entry.job_id, sha256, 'rejected'); } catch (error) { this.#log('evidence index not writable', { job_id: entry.job_id, error: String(error) }); }
    };
    for (const record of store.evidence(entry.job_id)) {
      if (!wanted.has(record.sha256) || record.uploaded || record.rejected) continue;
      let bytes: Uint8Array;
      try { bytes = store.evidenceBytes(entry.job_id, record); }
      catch (error) { reject(record.sha256, `unreadable: ${(error as NodeJS.ErrnoException).code ?? String(error)}`); continue; }
      if (bytes.byteLength > EVIDENCE_MAX_BYTES) { reject(record.sha256, `too large: ${bytes.byteLength} bytes`); continue; }
      try {
        await hub.uploadEvidence(entry.job_id, entry.fencing_token, bytes, record.mime);
        store.markEvidence(entry.job_id, record.sha256, 'uploaded');
      } catch (error) {
        const failure = error instanceof HubError ? error : new HubError('network', String(error));
        if (failure.kind === 'client' || failure.kind === 'fence_lost') { reject(record.sha256, `hub refused: ${failure.status ?? ''} ${failure.code ?? failure.message}`.trim()); continue; }
        return false;
      }
    }
    return true;
  }

  snapshot() {
    const state = this.#o.store.state();
    return {
      connection: this.#state, message: this.#message,
      last_success_at: this.#lastSuccessAt ? new Date(this.#lastSuccessAt).toISOString() : null,
      next_retry_at: this.#nextRetryAt ? new Date(this.#nextRetryAt).toISOString() : null,
      clock_offset_ms: this.#o.clock.offsetMs, clock_warning: this.#o.clock.skewWarning,
      last_sync_at: state.last_sync_at, channels: state.channels, machine: state.machine,
      outbox_depth: this.#o.store.outboxDepth(), emergency_stop: state.emergency_stop,
      driver_config_version: this.#o.selectors.version, jobs: this.#o.runner.views(),
    };
  }
}

export { compareVersions };
