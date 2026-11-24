// Per-job timetable (§8.5): download → preflight → final prepare → go →
// publish → read-back, plus the offline-go rules (§5.7), blockers (§5.9),
// revocation, the owner's Resume and the emergency stop. The invariants of
// §5.11 rule 3 are enforced here: `submitting` is on disk before the click,
// and a job found in `submitting` or `result_pending` is only ever read back.
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { join, extname } from 'node:path';
import {
  AUTO_RESUME_BLOCKERS, CLOCK_MARGIN_MS, GO_OFFLINE_ATTEMPTS, GO_OFFLINE_MIN_GAP_MS, OWNER_RESUME_BLOCKERS, PAUSED_GO_RETRY_MS,
  PREFLIGHT_SKIP_IF_CHECKED_WITHIN_MIN, type Blocker, type BlockerCode, type CheckLoginPayload, type ClaimedJob, type DeviceBlocker,
  type GoResponse, type JobReportData, type JobReportEvent, type PublishPostPayload, type PublishWindow,
} from './contracts.ts';
import type { Timers } from './clock.ts';
import type { RuntimeEventBus, LocalJobView } from './events.ts';
import { isLocalFinal, isPreRun, type JobStore, type LocalJob, type LocalState } from './job-store.ts';
import { MediaHashMismatch, MediaUnavailable, type MediaCache } from './media-cache.ts';
import { ProfileError, type ProfileLease, type Profiles } from './profiles.ts';
import { HubError } from './protocol.ts';
import { blockerMessage, channelLabel, localTime, missedMessage } from '../drivers/messages.ts';
import type { DriverRegistry } from '../drivers/registry.ts';
import type { SelectorStore } from '../drivers/selectors.ts';
import { DriverAbort, type DriverBlocker, type DriverContext, type PublishDriver, type PublishOutcome } from '../drivers/types.ts';

export interface RunnerSettings {
  machineId: string;
  machineName: string;
  /** SMARTSELL_TEST_PREPARE_LEAD_SEC overrides prepare_lead_min in test mode. */
  prepareLeadMs?: number;
  /** SMARTSELL_TEST_OFFLINE_STALENESS_SEC overrides offline_go_max_staleness_min in test mode. */
  offlineStalenessMs?: number;
  readbackScheduleSec: readonly number[];
  blockerPollMs: number;
  /** headless runner --dry-run: never click, even for real jobs. */
  localDryRun?: boolean;
  platformUrl(provider: 'x' | 'tiktok', path: string): string;
  chromeRetryMs?: number;
  mediaRetryMs?: number;
  goRetryMs?: number;
  log?(message: string, detail?: object): void;
}

export interface RunnerHub { go(body: { job_id: string; fencing_token: number }): Promise<GoResponse> }

export interface RunnerDeps {
  store: JobStore;
  hub: RunnerHub;
  media: Pick<MediaCache, 'ensureAll' | 'release' | 'dir'>;
  profiles: Pick<Profiles, 'acquire' | 'closeIdle'>;
  drivers: Pick<DriverRegistry, 'get' | 'markOutdated' | 'markHealthy'>;
  selectors: Pick<SelectorStore, 'table'>;
  time: Timers;
  events: RuntimeEventBus;
  /** Called after any outbox write so the supervisor sends it promptly. */
  flushSoon(): void;
  /** §5.7 rule 3: whether the hub clock offset is known and within CLOCK_MARGIN_MS. */
  clockTrusted(): boolean;
  settings: RunnerSettings;
}

class Mutex {
  #tail = Promise.resolve();
  async lock(): Promise<() => void> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    return release;
  }
}

const MANUAL_RESUME: readonly BlockerCode[] = OWNER_RESUME_BLOCKERS;
const OBSERVE_CODES: readonly BlockerCode[] = ['captcha', 'two_factor', 'login_expired', 'identity_mismatch'];
const LAUNCH_CODES: readonly BlockerCode[] = ['chrome_unavailable', 'profile_in_use'];

export type OfflineCheck = { ok: true } | { ok: false; reason: string };

function localParts(at: number, timeZone: string) {
  const format = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false })
    .formatToParts(new Date(at));
  let parts: Intl.DateTimeFormatPart[];
  try { parts = format(timeZone); } catch { parts = format('UTC'); }
  const get = (type: string) => parts.find(part => part.type === type)?.value ?? '';
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${hour}:${get('minute')}`, weekday };
}

/** limits.window check in the job's time zone (§5.7 rule 6). */
export function insideWindow(window: PublishWindow | null, at: number, timeZone: string) {
  if (!window) return true;
  const { time, weekday } = localParts(at, timeZone);
  if (window.days.length && !window.days.includes(weekday as PublishWindow['days'][number])) return false;
  return window.start <= window.end ? time >= window.start && time <= window.end : time >= window.start || time <= window.end;
}
export const localDate = (at: number, timeZone: string) => localParts(at, timeZone).date;

/**
 * §5.7 rules 2–6 for one job, evaluated on what is on disk. Rule 1 (two
 * unreachable go attempts at least 5 s apart) is checked by the caller.
 */
export function offlineGoAllowed(job: LocalJob, state: { last_sync_at: string | null; successes: { social_account_id: string; local_date: string }[] },
  now: number, clockTrusted: boolean, stalenessMs: number): OfflineCheck {
  const claimed = job.claimed;
  if (!state.last_sync_at || now - Date.parse(state.last_sync_at) > stalenessMs) return { ok: false, reason: 'stale_sync' };
  if (!clockTrusted) return { ok: false, reason: 'clock_unknown' };
  if (now < Date.parse(claimed.not_before) || now > Date.parse(claimed.not_after)) return { ok: false, reason: 'outside_time' };
  if (!(job.state === 'ready' || job.state === 'waiting_go') || !job.prepared_at || job.blocker) return { ok: false, reason: 'not_ready' };
  if (job.revoked) return { ok: false, reason: 'revoked' };
  if (job.sync.hold) return { ok: false, reason: 'hold' };
  // The hub stopped listing this held job in its last heartbeat: never run it offline.
  if ((job.hub_absent ?? 0) > 0) return { ok: false, reason: 'hub_absent' };
  if (job.sync.machine_paused || job.sync.pause_all || job.sync.channel_paused) return { ok: false, reason: 'paused' };
  if (job.offline_go_disabled) return { ok: false, reason: 'offline_go_disabled' };
  if (claimed.kind !== 'publish_post') return { ok: false, reason: 'not_publish' };
  if (!claimed.dry_run) {
    const payload = claimed.payload as PublishPostPayload;
    const today = localDate(now, payload.timezone);
    const done = state.successes.filter(item => item.social_account_id === payload.channel.social_account_id && item.local_date === today).length;
    if (done >= payload.limits.daily_cap) return { ok: false, reason: 'daily_cap' };
    if (!insideWindow(payload.limits.window, now, payload.timezone)) return { ok: false, reason: 'outside_window' };
  }
  return { ok: true };
}

interface Session { ctx: DriverContext; driver: PublishDriver; lease: ProfileLease }

export class JobRunner {
  readonly #deps: RunnerDeps;
  readonly #loops = new Map<string, Promise<void>>();
  readonly #wakers = new Map<string, Set<() => void>>();
  readonly #publish = new Mutex();
  #stopped = new AbortController();
  #emergency = new AbortController();
  #startedAt = 0;
  #slept = new Set<string>();
  /** Profiles whose Chrome holds a filled draft waiting for the owner's Post click (WA-2). */
  readonly #ownerWaiting = new Set<string>();

  constructor(deps: RunnerDeps) { this.#deps = deps; }

  get #store() { return this.#deps.store; }
  #now() { return this.#deps.time.now(); }
  #log(message: string, detail?: object) { this.#deps.settings.log?.(message, detail); }

  // ---------- lifecycle ----------

  /** Restart recovery (§8.4) and loops for every held job. */
  start() {
    this.#startedAt = this.#now();
    if (this.#store.state().emergency_stop) this.#emergency.abort(new DriverAbort());
    // WA-6: a terminal fact written with the final state but not yet in the outbox (the process died in between).
    for (const job of this.#store.jobs()) if (job.pending_report) this.#queuePending(job.claimed.job_id, true);
    for (const job of this.#store.jobs()) {
      if (isLocalFinal(job.state)) continue;
      // A job interrupted in preflighting/preparing simply runs that stage again.
      if (job.state === 'preflighting') this.#store.update(job.claimed.job_id, value => { value.state = 'media_ready'; });
      if (job.state === 'preparing') this.#store.update(job.claimed.job_id, value => { value.state = value.preflight_at ? 'media_ready' : 'claimed'; });
      this.#ensureLoop(job.claimed.job_id);
    }
    this.#emitJobs();
  }

  async stop() {
    this.#stopped.abort(new DriverAbort());
    for (const id of this.#wakers.keys()) this.#wake(id);
    await Promise.allSettled([...this.#loops.values()]);
  }

  /** Waits for every job loop to settle (tests). */
  idle() { return Promise.allSettled([...this.#loops.values()]); }

  /** New jobs from jobs.claim. */
  addClaimed(jobs: ClaimedJob[]) {
    const state = this.#store.state();
    for (const claimed of jobs) {
      const existing = this.#store.get(claimed.job_id);
      if (existing?.state === 'done') { this.#log('ignoring re-issued finished job', { job_id: claimed.job_id }); continue; }
      if (existing && !isLocalFinal(existing.state)) {
        // The hub re-issued a job we hold (local data mismatch): adopt the new fence; seq restarts at 1.
        if (existing.fence !== claimed.fencing_token) this.#store.update(claimed.job_id, job => { job.claimed = claimed; job.fence = claimed.fencing_token; job.next_seq = 1; });
        continue;
      }
      const channelId = claimed.payload.channel.social_account_id;
      const channel = state.channels.find(item => item.social_account_id === channelId);
      const job: LocalJob = {
        claimed, state: 'claimed', media_paths: {}, readback_attempts: 0,
        sync: { hold: false, hold_reason: null, mode: claimed.mode, resume_token: 0, machine_paused: state.machine?.paused ?? false,
          pause_all: state.machine?.pause_all ?? false, channel_paused: channel?.paused ?? false, synced_at: new Date(this.#now()).toISOString() },
        last_sync_at: state.last_sync_at ?? new Date(this.#now()).toISOString(),
        offline_go_disabled: false, revoked: false, fence: claimed.fencing_token, next_seq: 1,
      };
      this.#store.put(job);
      this.#ensureLoop(claimed.job_id);
    }
    this.#emitJobs();
  }

  /** Called after every heartbeat the supervisor wrote to disk (hold, mode, resume_token, revocations). */
  synced() {
    for (const job of this.#store.jobs()) {
      if (isLocalFinal(job.state)) continue;
      this.#ensureLoop(job.claimed.job_id);
      this.#wake(job.claimed.job_id);
    }
  }

  /** 409 JOB_FENCE_LOST on a lease report: before running, stop the job locally (§8.2). */
  fenceLost(jobId: string) {
    const job = this.#store.get(jobId);
    if (!job || isLocalFinal(job.state) || !isPreRun(job.state)) return;
    this.#finish(jobId, 'released', 'fence_lost');
    this.#wake(jobId);
  }

  /** Tray emergency stop (§8.5). */
  emergencyStop() {
    this.#store.updateState(state => { state.emergency_stop = true; });
    this.#emergency.abort(new DriverAbort());
    for (const job of this.#store.jobs()) {
      if (isLocalFinal(job.state)) continue;
      if (job.state === 'submitting' || job.state === 'result_pending') {
        this.#finish(job.claimed.job_id, 'done', 'owner_stopped',
          { event: 'outcome_unknown', reason: 'owner_stopped', evidence_sha256: this.#evidence(job.claimed.job_id) });
      } else if (job.blocker?.code !== 'owner_stopped') {
        this.#raise(job.claimed.job_id, { code: 'owner_stopped', phase: 'before_submit', message: '' }, 'before_submit', { alert: false });
      }
      this.#wake(job.claimed.job_id);
    }
  }

  /** The owner pressed Resume in the App after an emergency stop. */
  resumeAfterStop() {
    this.#store.updateState(state => { state.emergency_stop = false; });
    this.#emergency = new AbortController();
    for (const job of this.#store.jobs()) {
      if (job.blocker?.code !== 'owner_stopped' || isLocalFinal(job.state)) continue;
      this.#store.update(job.claimed.job_id, value => { delete value.blocker; delete value.blocker_stage; value.state = 'media_ready'; delete value.prepared_at; });
      this.#ensureLoop(job.claimed.job_id);
      this.#wake(job.claimed.job_id);
    }
  }

  get emergencyStopped() { return this.#store.state().emergency_stop; }

  // ---------- loop plumbing ----------

  #ensureLoop(id: string) {
    if (this.#loops.has(id) || this.#stopped.signal.aborted) return;
    const loop = this.#run(id).catch(error => this.#log('job loop failed', { job_id: id, error: String(error) }))
      .finally(() => { this.#loops.delete(id); this.#emitJobs(); });
    this.#loops.set(id, loop);
  }

  #wake(id: string) {
    const set = this.#wakers.get(id);
    if (!set) return;
    for (const fn of [...set]) fn();
  }

  /** Sleeps until `at` (hub time) or until woken by a sync/revocation. Returns true when woken early. */
  async #waitUntil(id: string, at: number) {
    const delay = at - this.#now();
    if (delay <= 0) return false;
    const controller = new AbortController();
    let woken = false;
    const wake = () => { woken = true; controller.abort(); };
    let set = this.#wakers.get(id);
    if (!set) { set = new Set(); this.#wakers.set(id, set); }
    set.add(wake);
    const onStop = () => controller.abort();
    this.#stopped.signal.addEventListener('abort', onStop, { once: true });
    try { await this.#deps.time.sleep(delay, controller.signal); }
    catch { /* woken or stopped */ }
    finally { set.delete(wake); this.#stopped.signal.removeEventListener('abort', onStop); }
    // A wake-up far later than planned means the machine was asleep (§5.6 machine_was_off).
    if (!woken && this.#now() - at > 60_000) this.#slept.add(id);
    return woken;
  }

  async #run(id: string) {
    let guard = 0;
    let spin = { at: -1, count: 0 };
    while (!this.#stopped.signal.aborted) {
      // Safety net: many steps without time moving means a state cycle; never let it spin.
      const tick = this.#now();
      spin = spin.at === tick ? { at: tick, count: spin.count + 1 } : { at: tick, count: 0 };
      if (spin.count > 50) { this.#log('job loop is cycling; pausing it', { job_id: id }); await this.#waitUntil(id, tick + 1000); spin = { at: -1, count: 0 }; }
      const job = this.#store.get(id);
      if (!job || isLocalFinal(job.state)) return;
      const before = JSON.stringify([job.state, job.blocker?.code, job.readback_attempts, job.next_seq]);
      if (job.claimed.kind === 'check_login') await this.#checkLogin(job);
      else await this.#stepPublish(job);
      this.#emitJobs();
      const after = this.#store.get(id);
      // Defensive: a step that changed nothing and did not wait must not spin.
      if (after && JSON.stringify([after.state, after.blocker?.code, after.readback_attempts, after.next_seq]) === before) {
        if (++guard > 3) { await this.#waitUntil(id, this.#now() + 1000); guard = 0; }
      } else guard = 0;
    }
  }

  // ---------- reports and state ----------

  #report(id: string, event: JobReportEvent, data: JobReportData) {
    this.#store.enqueue(id, event, data, new Date(this.#now()).toISOString());
    this.#deps.flushSoon();
  }

  #evidence(id: string) { return this.#store.evidence(id).map(record => record.sha256); }

  /**
   * Ends a job locally. A terminal fact (`report`) is written in the same atomic job write as the final state, then
   * moved to the outbox; local cleanup comes last and never throws (WA-6): a busy cache file on Windows or a crash
   * between two writes can no longer lose the result, outcome_unknown or after_submit blocker the hub waits for.
   */
  #finish(id: string, state: Extract<LocalState, 'done' | 'missed' | 'released' | 'failed'>, reason: string, report?: JobReportData,
    change?: (job: LocalJob) => void) {
    const at = new Date(this.#now()).toISOString();
    this.#store.update(id, job => {
      change?.(job);
      job.state = state; job.finished_at = at; job.final_reason = reason;
      if (report) job.pending_report = { event_id: randomUUID(), event: report.event, data: report, at };
    });
    if (report) this.#queuePending(id);
    try { this.#deps.media.release(id); } catch (error) { this.#log('media cache release failed', { job_id: id, error: String(error) }); }
    try { rmSync(join(this.#deps.media.dir, 'staging', id), { recursive: true, force: true }); }
    catch (error) { this.#log('staging cleanup failed', { job_id: id, error: String(error) }); }
  }

  /** Moves a job's pending terminal fact to the outbox (once: on recovery an entry with its event_id already counts). */
  #queuePending(id: string, recovering = false) {
    const pending = this.#store.get(id)?.pending_report;
    if (!pending) return;
    if (!recovering || !this.#store.outbox().some(entry => entry.event_id === pending.event_id)) {
      this.#store.enqueue(id, pending.event, pending.data, pending.at, pending.event_id);
    }
    this.#store.update(id, job => { delete job.pending_report; });
    this.#deps.flushSoon();
  }

  #messages(job: LocalJob) {
    const channel = job.claimed.payload.channel;
    const timeZone = 'timezone' in job.claimed.payload ? (job.claimed.payload as PublishPostPayload).timezone : Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      machine: this.#deps.settings.machineName,
      channel: channelLabel(job.claimed.payload.provider, channel.handle, channel.display_name),
      deadline: localTime(job.claimed.not_after, timeZone),
    };
  }

  #fullBlocker(job: LocalJob, blocker: DriverBlocker): Blocker {
    const code = blocker.code;
    const messages = this.#messages(job);
    return {
      code, phase: blocker.phase, message: blocker.message || blockerMessage(code, { ...messages, step: blocker.step }, blocker.phase),
      resumable_by: AUTO_RESUME_BLOCKERS.includes(code) ? 'auto' : OWNER_RESUME_BLOCKERS.includes(code) ? 'owner' : 'none',
      machine_id: this.#deps.settings.machineId, machine_name: this.#deps.settings.machineName,
      social_account_id: job.claimed.payload.channel.social_account_id, channel_label: messages.channel,
      ...(blocker.step && { step: blocker.step }), ...(blocker.url && { url: blocker.url }),
      ...(blocker.evidence_sha256?.length && { evidence_sha256: blocker.evidence_sha256 }), at: new Date(this.#now()).toISOString(),
    };
  }

  #deviceBlocker(blocker: Blocker): DeviceBlocker {
    const { machine_id: _m, machine_name: _n, social_account_id: _s, channel_label: _c, resumable_by: _r, ...rest } = blocker;
    return rest;
  }

  /**
   * Records a blocker once per (code, stage): local state first, then the report
   * (prepare_blocked for prepare stages, blocked otherwise), then the local alert.
   */
  #raise(id: string, driverBlocker: DriverBlocker, stage: 'preflight' | 'final' | 'before_submit', options: { alert?: boolean; keepState?: boolean } = {}) {
    const job = this.#store.get(id)!;
    if (job.blocker?.code === driverBlocker.code && job.blocker_stage === stage) return job.blocker;
    const blocker = this.#fullBlocker(job, { ...driverBlocker, phase: stage === 'before_submit' ? 'before_submit' : 'prepare' });
    this.#store.update(id, value => {
      value.blocker = blocker; value.blocker_stage = stage; value.blocker_resume_token = value.sync.resume_token;
      if (!options.keepState) value.state = 'blocked';
    });
    if (driverBlocker.code === 'driver_outdated') this.#deps.drivers.markOutdated(job.claimed.payload.provider as 'x' | 'tiktok', driverBlocker.step);
    if (stage === 'before_submit') this.#report(id, 'blocked', { event: 'blocked', blocker: this.#deviceBlocker(blocker) });
    else this.#report(id, 'prepare_blocked', { event: 'prepare_blocked', stage, blocker: this.#deviceBlocker(blocker) });
    if (options.alert !== false) {
      this.#deps.events.emit('local_alert', {
        kind: blocker.code === 'owner_click_required' ? 'owner_click' : 'blocker',
        title: `${blocker.channel_label} 需要你處理`, body: blocker.message, web_url: null, job_id: id,
      });
    }
    return blocker;
  }

  #clearBlocker(id: string, state: LocalState) {
    this.#store.update(id, job => { delete job.blocker; delete job.blocker_stage; delete job.blocker_resume_token; job.state = state; });
  }

  #missed(job: LocalJob) {
    const id = job.claimed.job_id;
    const notAfter = Date.parse(job.claimed.not_after);
    let reason: 'late' | 'machine_was_off' | 'owner_not_clicked' | 'prepare_blocked' | 'chrome_unavailable' | 'paused';
    if (notAfter < this.#startedAt || this.#slept.has(id)) reason = 'machine_was_off';
    else if (job.sync.machine_paused || job.sync.pause_all || job.sync.channel_paused || job.sync.hold_reason === 'paused' || job.final_reason === 'go_paused') reason = 'paused';
    else if (job.blocker && LAUNCH_CODES.includes(job.blocker.code)) reason = 'chrome_unavailable';
    else if (job.blocker?.code === 'owner_click_required' || job.blocker?.code === 'caption_rejected') reason = 'owner_not_clicked';
    else if (job.blocker) reason = 'prepare_blocked';
    else reason = 'late';
    this.#finish(id, 'missed', reason, { event: 'missed', reason });
    this.#deps.events.emit('local_alert', { kind: 'missed', title: `${this.#messages(job).channel} 這則沒有發出`, body: missedMessage(this.#messages(job), reason), web_url: null });
  }

  /** Revoked before running: mark released and report it in the next heartbeat's released_jobs (§8.5). */
  #releaseLocal(id: string) {
    // released_jobs first: a crash before the final state only repeats this step on restart (WA-6).
    this.#store.updateState(state => { if (!state.released_jobs.includes(id)) state.released_jobs.push(id); });
    this.#finish(id, 'released', 'revoked');
  }

  // ---------- driver sessions ----------

  #mediaPaths(job: LocalJob) {
    if (job.claimed.kind !== 'publish_post') return [];
    const payload = job.claimed.payload as PublishPostPayload;
    return payload.media.map(media => job.media_paths[media.file_id ?? media.bundled ?? media.sha256]).filter((path): path is string => !!path);
  }

  #signal(extra?: AbortSignal) {
    return AbortSignal.any([this.#stopped.signal, this.#emergency.signal, ...(extra ? [extra] : [])]);
  }

  async #session<T>(job: LocalJob, fn: (session: Session) => Promise<T>, options: { abortOnRevoke?: boolean } = {}): Promise<T> {
    const provider = job.claimed.payload.provider;
    const driver = this.#deps.drivers.get(provider);
    if (!driver) throw new DriverMissing(provider);
    const id = job.claimed.job_id;
    // Prepare and read-only observation stop as soon as the job is revoked; publish() handles revocation itself.
    const local = new AbortController();
    let watcher: (() => void) | undefined;
    if (options.abortOnRevoke) {
      watcher = () => { const current = this.#store.get(id); if (current?.revoked && isPreRun(current.state)) local.abort(new DriverAbort()); };
      let set = this.#wakers.get(id);
      if (!set) { set = new Set(); this.#wakers.set(id, set); }
      set.add(watcher);
    }
    const signal = this.#signal(local.signal);
    let lease: ProfileLease;
    try { lease = await this.#deps.profiles.acquire(job.claimed.payload.channel.profile_key, signal); }
    catch (error) { if (watcher) this.#wakers.get(id)?.delete(watcher); throw error; }
    const ctx: DriverContext = {
      page: lease.page,
      platformUrl: path => this.#deps.settings.platformUrl(provider as 'x' | 'tiktok', path),
      expectedIdentity: job.claimed.payload.channel.expected_identity,
      signal,
      evidence: async label => this.#store.addEvidence(id, label, await lease.page.screenshot({ quality: 70, maxWidth: 1600 }), 'image/jpeg', new Date(this.#now()).toISOString()),
      log: (step, detail) => this.#log(`${provider} ${step}`, { job_id: id, ...detail }),
      now: () => this.#now(),
      sleep: ms => this.#deps.time.sleep(ms, signal),
      selectors: this.#deps.selectors.table,
      mediaPaths: this.#mediaPaths(job),
      blockerPollMs: this.#deps.settings.blockerPollMs,
      trace: [],
      messages: this.#messages(job),
    };
    try { return await fn({ ctx, driver, lease }); }
    finally {
      lease.release();
      if (watcher) this.#wakers.get(id)?.delete(watcher);
    }
  }

  /** Converts launch failures and unexpected driver errors into blockers. */
  #sessionBlocker(error: unknown, job: LocalJob): DriverBlocker | null {
    if (error instanceof DriverAbort || this.#stopped.signal.aborted) return null;
    const messages = this.#messages(job);
    if (error instanceof ProfileError) return { code: error.code, phase: 'prepare', message: blockerMessage(error.code, messages) };
    if (error instanceof DriverMissing) return { code: 'driver_outdated', phase: 'prepare', step: 'driver', message: `SmartSell 第 1 階段沒有 ${error.provider} 的驅動，這則沒有執行。` };
    this.#log('driver error', { job_id: job.claimed.job_id, error: error instanceof Error ? error.stack ?? error.message : String(error) });
    return { code: 'chrome_unavailable', phase: 'prepare', message: blockerMessage('chrome_unavailable', messages) };
  }

  // ---------- publish_post ----------

  #prepareLead(job: LocalJob) { return this.#deps.settings.prepareLeadMs ?? job.claimed.prepare_lead_min * 60_000; }
  #staleness(job: LocalJob) { return this.#deps.settings.offlineStalenessMs ?? job.claimed.offline_go_max_staleness_min * 60_000; }

  async #stepPublish(job: LocalJob) {
    const id = job.claimed.job_id;
    const now = this.#now();
    const notBefore = Date.parse(job.claimed.not_before), notAfter = Date.parse(job.claimed.not_after);
    if (isPreRun(job.state) && job.revoked) return this.#releaseLocal(id);
    if (isPreRun(job.state) && now > notAfter) return this.#missed(job);
    if (this.emergencyStopped && isPreRun(job.state)) {
      if (job.blocker?.code !== 'owner_stopped') this.#raise(id, { code: 'owner_stopped', phase: 'before_submit', message: '' }, 'before_submit', { alert: false });
      await this.#waitUntil(id, notAfter + 1);
      return;
    }
    switch (job.state) {
      case 'claimed': case 'downloading': return this.#download(job);
      case 'media_ready': case 'preflighting': {
        if (!job.preflight_at) return this.#preflight(job);
        const prepareAt = notBefore - this.#prepareLead(job);
        if (now < prepareAt) { await this.#waitUntil(id, prepareAt); return; }
        return this.#prepare(job, 'final');
      }
      case 'preparing': return this.#prepare(job, 'final');
      case 'blocked': return this.#blocked(job);
      case 'ready': {
        if (now < notBefore) { await this.#waitUntil(id, notBefore); return; }
        this.#store.update(id, value => { value.state = 'waiting_go'; });
        return this.#go(this.#store.get(id)!);
      }
      case 'waiting_go': return this.#go(job);
      case 'running': {
        // §8.4: interrupted before `submitting` was written, so the button was not clicked.
        if (now <= notAfter) { this.#store.update(id, value => { value.state = 'waiting_go'; }); return this.#go(this.#store.get(id)!); }
        return this.#missed({ ...job, state: 'waiting_go' });
      }
      case 'submitting': case 'result_pending': return this.#readBack(job);
    }
  }

  async #download(job: LocalJob) {
    const id = job.claimed.job_id;
    if (job.state !== 'downloading') this.#store.update(id, value => { value.state = 'downloading'; });
    try {
      const cached = await this.#deps.media.ensureAll(job.claimed, this.#signal());
      const staged = this.#stage(id, job.claimed, cached);
      this.#store.update(id, value => { value.media_paths = staged; value.state = 'media_ready'; });
      if (job.blocker?.code === 'media_unavailable') this.#clearBlocker(id, 'media_ready');
    } catch (error) {
      if (error instanceof MediaHashMismatch) {
        this.#finish(id, 'failed', 'media_hash_mismatch', { event: 'failed', code: 'media_hash_mismatch', message: blockerMessage('media_hash_mismatch', this.#messages(job)) });
        return;
      }
      if (error instanceof HubError && error.kind === 'fence_lost') { this.#finish(id, 'released', 'fence_lost'); return; }
      if (error instanceof MediaUnavailable || (error instanceof HubError && (error.kind === 'client' || error.kind === 'device_revoked'))) {
        this.#raise(id, { code: 'media_unavailable', phase: 'prepare', message: blockerMessage('media_unavailable', this.#messages(job)) }, 'preflight', { keepState: true });
      }
      if (this.#stopped.signal.aborted) return;
      await this.#waitUntil(id, this.#now() + (this.#deps.settings.mediaRetryMs ?? 30_000));
    }
  }

  /**
   * Media goes to the platform under its original file name (a hard link into
   * the cache, so nothing is copied): the cache file itself is named by hash.
   */
  #stage(id: string, claimed: ClaimedJob, cached: Record<string, string>) {
    const payload = claimed.payload as PublishPostPayload;
    const dir = join(this.#deps.media.dir, 'staging', id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const out: Record<string, string> = {};
    payload.media.forEach((media, index) => {
      const key = media.file_id ?? media.bundled ?? media.sha256;
      const source = cached[key];
      if (!source) return;
      const safe = (media.filename || `media-${index}`).replace(/[^A-Za-z0-9._ -]/g, '_').slice(-120) || `media-${index}`;
      const name = extname(safe) ? safe : `${safe}${media.mime === 'video/quicktime' ? '.mov' : media.kind === 'image' ? '.jpg' : '.mp4'}`;
      const target = join(dir, `${index}-${name}`);
      if (!existsSync(target)) {
        try { linkSync(source, target); } catch { copyFileSync(source, target); }
      }
      out[key] = target;
    });
    return out;
  }

  async #preflight(job: LocalJob) {
    const id = job.claimed.job_id;
    const channelId = job.claimed.payload.channel.social_account_id;
    const lastCheck = this.#store.state().channel_checks[channelId];
    if (lastCheck && this.#now() - Date.parse(lastCheck) < PREFLIGHT_SKIP_IF_CHECKED_WITHIN_MIN * 60_000) {
      this.#store.update(id, value => { value.preflight_at = new Date(this.#now()).toISOString(); });
      return;
    }
    return this.#prepare(job, 'preflight');
  }

  /** Preflight (checkLogin) or final prepare, with read-only observation of auto-resume blockers in the same tab. */
  async #prepare(job: LocalJob, stage: 'preflight' | 'final') {
    const id = job.claimed.job_id;
    this.#store.update(id, value => { value.state = stage === 'preflight' ? 'preflighting' : 'preparing'; });
    const notAfter = Date.parse(job.claimed.not_after);
    let outcome: { ok: true; identity: string; handle: string | null } | { ok: false; blocker: DriverBlocker } | null;
    try {
      outcome = await this.#session(job, async ({ ctx, driver, lease }) => {
        while (true) {
          const current = this.#store.get(id)!;
          let result: { ok: true; identity: string; handle: string | null } | { ok: false; blocker: DriverBlocker };
          if (stage === 'preflight') {
            const login = await driver.checkLogin(ctx);
            if (login.state === 'verified') result = { ok: true, identity: login.identity!, handle: login.handle };
            else {
              const seen = login.state === 'identity_mismatch' ? null : await driver.detectBlocker(ctx, 'prepare');
              const code: BlockerCode = login.state === 'identity_mismatch' ? 'identity_mismatch' : seen?.code ?? (login.state === 'challenge' ? 'captcha' : 'login_expired');
              result = { ok: false, blocker: seen ?? { code, phase: 'prepare', message: blockerMessage(code, ctx.messages), evidence_sha256: login.evidence_sha256 } };
            }
          } else result = await driver.prepare(ctx, current.claimed);
          if (result.ok) return result;
          this.#raise(id, result.blocker, stage);
          if (!OBSERVE_CODES.includes(result.blocker.code)) return result;
          // Read-only observation of the same tab until cleared or not_after (§5.9). No reload, no navigation.
          lease.pin(true);
          const cleared = await driver.awaitBlockerCleared(ctx, result.blocker, notAfter).finally(() => lease.pin(false));
          if (!cleared) return result;
        }
      }, { abortOnRevoke: true });
    } catch (error) {
      const blocker = this.#sessionBlocker(error, job);
      if (!blocker) return;
      outcome = { ok: false, blocker };
      this.#raise(id, blocker, stage);
    }
    if (!outcome) return;
    if (!outcome.ok) {
      if (this.#store.get(id)?.state !== 'blocked') this.#store.update(id, value => { value.state = 'blocked'; });
      return;
    }
    const at = new Date(this.#now()).toISOString();
    const provider = job.claimed.payload.provider as 'x' | 'tiktok';
    const driver = this.#deps.drivers.get(provider)!;
    this.#store.update(id, value => {
      delete value.blocker; delete value.blocker_stage; delete value.blocker_resume_token;
      if (stage === 'preflight') { value.preflight_at = at; value.state = 'media_ready'; }
      else { value.prepared_at = at; value.state = 'ready'; }
    });
    this.#store.updateState(state => { state.channel_checks[job.claimed.payload.channel.social_account_id] = at; });
    this.#deps.drivers.markHealthy(provider);
    this.#report(id, 'prepared', { event: 'prepared', stage, login: 'verified', identity: outcome.identity, handle: outcome.handle, media_ok: true,
      driver: { provider, version: driver.version } });
  }

  async #blocked(job: LocalJob) {
    const id = job.claimed.job_id;
    const blocker = job.blocker;
    const notAfter = Date.parse(job.claimed.not_after);
    const back: LocalState = job.blocker_stage === 'preflight' ? (job.media_paths && Object.keys(job.media_paths).length ? 'media_ready' : 'claimed') : 'media_ready';
    if (!blocker) { this.#store.update(id, value => { value.state = back; }); return; }
    if (blocker.code === 'owner_stopped') {
      if (this.emergencyStopped) { await this.#waitUntil(id, notAfter + 1); return; }
      this.#store.update(id, value => { delete value.prepared_at; });
      return this.#clearBlocker(id, 'media_ready');
    }
    if (blocker.code === 'media_unavailable') return this.#clearBlocker(id, 'claimed');
    if (MANUAL_RESUME.includes(blocker.code)) {
      // Owner-resume: stop and wait until the hub's resume_token grows (§5.9, §8.5).
      if (job.sync.resume_token > (job.blocker_resume_token ?? 0)) {
        this.#store.update(id, value => { delete value.prepared_at; if (value.blocker_stage === 'preflight') delete value.preflight_at; });
        return this.#clearBlocker(id, back);
      }
      await this.#waitUntil(id, notAfter + 1);
      return;
    }
    if (LAUNCH_CODES.includes(blocker.code)) {
      await this.#waitUntil(id, Math.min(notAfter + 1, Date.parse(blocker.at) + (this.#deps.settings.chromeRetryMs ?? 300_000)));
      if (this.#now() > notAfter) return;
      return this.#retryStage(job);
    }
    if (blocker.code === 'owner_click_required') { await this.#waitUntil(id, notAfter + 1); return; }
    // Auto-resume verification blockers after a restart: run the stage again (one navigation), which observes read-only.
    return this.#retryStage(job);
  }

  #retryStage(job: LocalJob) {
    const id = job.claimed.job_id;
    if (job.blocker_stage === 'before_submit') { this.#store.update(id, value => { value.state = 'waiting_go'; }); return; }
    if (job.blocker_stage === 'preflight') return this.#prepare(this.#store.get(id)!, 'preflight');
    return this.#prepare(this.#store.get(id)!, 'final');
  }

  async #go(job: LocalJob) {
    const id = job.claimed.job_id;
    const notAfter = Date.parse(job.claimed.not_after);
    const profileKey = job.claimed.payload.channel.profile_key;
    const failures: number[] = [];
    while (!this.#stopped.signal.aborted) {
      // WA-2: this account's Chrome holds an earlier draft for the owner's Post click. Wait for that outside the
      // publish lock, so posts of other accounts on this machine are not held up behind it.
      if (this.#ownerWaiting.has(profileKey) && this.#now() <= notAfter) {
        await this.#waitUntil(id, Math.min(notAfter + 1, this.#now() + 5_000));
        continue;
      }
      // One publish at a time (§8.5): the lock is held from the go attempt through the click, never while waiting
      // (it is released when an owner-click wait begins, WA-2).
      const unlock = await this.#publish.lock();
      let keep = false;
      try {
        const current = this.#store.get(id)!;
        if (isLocalFinal(current.state)) return;
        if (current.revoked) return this.#releaseLocal(id);
        if (this.emergencyStopped) return;
        if (this.#now() > notAfter) return this.#missed(current);
        let response: GoResponse;
        try { response = await this.#deps.hub.go({ job_id: id, fencing_token: current.fence }); }
        catch (error) {
          const failure = error instanceof HubError ? error : new HubError('network', String(error));
          if (failure.kind === 'fence_lost') return this.#finish(id, 'released', 'fence_lost');
          if (!failure.unreachable) { failures.length = 0; }
          else {
            failures.push(this.#now());
            const n = failures.length;
            if (n >= GO_OFFLINE_ATTEMPTS && failures[n - 1] - failures[n - GO_OFFLINE_ATTEMPTS] >= GO_OFFLINE_MIN_GAP_MS) {
              const latest = this.#store.get(id)!;
              const check = offlineGoAllowed(latest, this.#store.state(), this.#now(), this.#deps.clockTrusted(), this.#staleness(latest));
              if (check.ok) { keep = true; try { return await this.#execute(latest, 'offline', latest.sync.mode, unlock); } finally { unlock(); } }
              this.#log('offline go refused', { job_id: id, reason: check.reason });
            }
          }
          unlock();
          await this.#waitUntil(id, this.#now() + (this.#deps.settings.goRetryMs ?? GO_OFFLINE_MIN_GAP_MS));
          continue;
        }
        failures.length = 0;
        if (response.go) {
          this.#store.update(id, value => { value.offline_go_disabled = false; });
          keep = true;
          try { return await this.#execute(this.#store.get(id)!, 'hub', response.mode, unlock); } finally { unlock(); }
        }
        if (response.reason !== 'too_early') this.#store.update(id, value => { value.offline_go_disabled = true; });
        switch (response.reason) {
          case 'too_early':
            unlock();
            await this.#waitUntil(id, Math.max(this.#now() + 1000, Math.min(Date.parse(current.claimed.not_before), this.#now() + 5000)));
            continue;
          case 'paused':
            this.#store.update(id, value => { value.final_reason = 'go_paused'; });
            unlock();
            // Retry every 30 s until not_after, then report missed{paused} (§5.4.4 item 4).
            await this.#waitUntil(id, Math.min(notAfter + 1, this.#now() + PAUSED_GO_RETRY_MS));
            continue;
          // The job moved to another machine: this lease is gone and a report would be refused.
          case 'fence_lost': return this.#finish(id, 'released', response.reason);
          // WA-3 / WE-3: invalid_state is the answer for a job the hub is releasing (a cancel or reschedule that beat the
          // next heartbeat) or no longer runs here. Nothing was clicked: report `released` so the hub can finish it.
          case 'invalid_state': case 'revoked': case 'approval_invalid': case 'rebound':
            return this.#finish(id, 'released', response.reason, { event: 'released' });
          case 'daily_cap_reached': case 'outside_window':
            // The hub already moved the job to missed (§5.4.4 items 7–8).
            return this.#finish(id, 'missed', response.reason);
          // WA-3: past not_after by the hub's clock. The Worker will not run it, so it says so: missed{late}.
          case 'too_late': return this.#missed(this.#store.get(id)!);
          default: return this.#finish(id, 'released', String(response.reason), { event: 'released' });
        }
      } finally { if (!keep) unlock(); }
    }
  }

  async #execute(job: LocalJob, goSource: 'hub' | 'offline', mode: 'auto' | 'assist', unlock: () => void) {
    const id = job.claimed.job_id;
    const notAfter = Date.parse(job.claimed.not_after);
    const profileKey = job.claimed.payload.channel.profile_key;
    const startedAt = new Date(this.#now()).toISOString();
    // `started` goes to the outbox before the driver runs (§8.5, §5.7 rule 7).
    this.#store.update(id, value => { value.state = 'running'; value.started_at = startedAt; value.go_source = goSource; value.run_mode = mode; delete value.blocker; delete value.blocker_stage; });
    this.#report(id, 'started', { event: 'started', go: goSource, mode });
    const dryRun = job.claimed.dry_run || !!this.#deps.settings.localDryRun;
    let trace: DriverContext['trace'] = [];
    let outcome: PublishOutcome | { kind: 'error'; error: unknown };
    let ownerLease: ProfileLease | undefined;
    try {
      outcome = await this.#session(job, async ({ ctx, driver, lease }) => {
        trace = ctx.trace;
        ownerLease = lease;
        return driver.publish(ctx, job.claimed, {
          dryRun, mode,
          onBeforeClick: async () => {
            const current = this.#store.get(id)!;
            if (current.revoked || this.emergencyStopped || this.#stopped.signal.aborted) return false;
            // §5.11 rule 3: `submitting` is fsynced locally and queued before the single click.
            this.#store.update(id, value => { value.state = 'submitting'; value.submitting_at = new Date(this.#now()).toISOString(); });
            this.#report(id, 'submitting', { event: 'submitting' });
            return true;
          },
          revoked: () => !!this.#store.get(id)?.revoked || this.emergencyStopped,
          ownerWaitUntil: notAfter,
          onOwnerWait: async blocker => {
            // The page is filled and waits for the owner's Post click: keep this account's Chrome (lease and pin) but
            // let the next post of another account go (WA-2). The lock covers go → fill → one click only.
            lease.pin(true);
            this.#ownerWaiting.add(profileKey);
            unlock();
            await lease.page.bringToFront().catch(() => {});
            this.#raise(id, blocker, 'before_submit', { keepState: true });
          },
        });
      });
    } catch (error) { outcome = { kind: 'error', error }; }
    finally {
      ownerLease?.pin(false);
      if (this.#ownerWaiting.delete(profileKey)) for (const other of [...this.#wakers.keys()]) if (other !== id) this.#wake(other);
    }
    unlock();
    const current = this.#store.get(id)!;
    if (isLocalFinal(current.state)) return; // finished meanwhile (emergency stop reported outcome_unknown)
    const clicked = current.state === 'submitting';
    switch (outcome.kind) {
      case 'error': {
        if (clicked) return; // Unknown whether the click went out: read back only (the loop continues in `submitting`).
        if (outcome.error instanceof DriverAbort || this.#stopped.signal.aborted) {
          if (this.emergencyStopped) this.#raise(id, { code: 'owner_stopped', phase: 'before_submit', message: '' }, 'before_submit', { alert: false });
          else this.#store.update(id, value => { value.state = 'waiting_go'; });
          return;
        }
        const blocker = this.#sessionBlocker(outcome.error, current) ?? { code: 'chrome_unavailable' as const, phase: 'before_submit' as const, message: '' };
        this.#raise(id, blocker, 'before_submit');
        return;
      }
      case 'dry_run_done':
        if (job.claimed.dry_run) {
          this.#finish(id, 'done', 'dry_run', { event: 'dry_run_done', evidence_sha256: outcome.evidence_sha256, trace });
        } else {
          // Local --dry-run against a real job: explicitly not posted, and the job ends here locally.
          this.#raise(id, { code: 'owner_stopped', phase: 'before_submit', message: `${this.#deps.settings.machineName} 以本機試跑模式執行，沒有按發布。` }, 'before_submit');
          this.#finish(id, 'released', 'local_dry_run');
        }
        return;
      case 'aborted':
        this.#finish(id, 'released', 'revoked', { event: 'released' });
        return;
      case 'failed':
        this.#finish(id, 'failed', outcome.code, { event: 'failed', code: outcome.code, message: outcome.message, evidence_sha256: outcome.evidence_sha256 });
        return;
      case 'blocked': {
        const blocker = outcome.blocker;
        if (blocker.phase === 'after_submit' || clicked) {
          // The owner finishes or checks this post in this very window (TikTok: the video is uploaded, the owner clicks
          // Post; X: the error page). Keep that Chrome open past the idle close until the next job takes the profile.
          ownerLease?.pin(true);
          this.#finish(id, 'done', blocker.code, { event: 'blocked', blocker: this.#deviceBlocker(this.#fullBlocker(current, { ...blocker, phase: 'after_submit' })) });
          this.#deps.events.emit('local_alert', { kind: 'blocker', title: `${this.#messages(current).channel} 需要你確認`, body: blocker.message, web_url: null });
          return;
        }
        if ((blocker.code === 'owner_click_required' || blocker.code === 'caption_rejected') && this.#now() >= notAfter) {
          return this.#missed({ ...current, blocker: current.blocker ?? this.#fullBlocker(current, blocker) });
        }
        this.#raise(id, blocker, 'before_submit');
        if (OBSERVE_CODES.includes(blocker.code)) {
          // Observe the same tab read-only, outside the publish lock, then try again within the window.
          try {
            const cleared = await this.#session(this.#store.get(id)!, async ({ ctx, driver, lease }) => {
              lease.pin(true);
              try { return await driver.awaitBlockerCleared(ctx, blocker, notAfter); } finally { lease.pin(false); }
            }, { abortOnRevoke: true });
            if (cleared) this.#store.update(id, value => { value.state = 'waiting_go'; delete value.blocker; delete value.blocker_stage; });
          } catch { /* Stays blocked; the loop decides. */ }
        }
        return;
      }
      case 'submitted': {
        if (current.state !== 'submitting') {
          // The owner clicked Post on this machine (assist): no click by us, but the post may exist.
          this.#store.update(id, value => { value.state = 'submitting'; value.submitting_at = new Date(this.#now()).toISOString(); });
          this.#report(id, 'submitting', { event: 'submitting' });
        }
        this.#store.update(id, value => {
          value.state = 'result_pending'; value.submitted_at = new Date(this.#now()).toISOString(); value.submitted_by = outcome.submitted_by;
          value.hint = outcome.hint; delete value.blocker; delete value.blocker_stage;
        });
        this.#report(id, 'submitted', { event: 'submitted', ...(outcome.hint.url && { toast_url: outcome.hint.url }) });
        this.#deps.drivers.markHealthy(job.claimed.payload.provider as 'x' | 'tiktok');
        return;
      }
    }
  }

  /** §5.8 read-back: immediately, then READBACK_SCHEDULE_SEC; never clicks. */
  async #readBack(job: LocalJob) {
    const id = job.claimed.job_id;
    if (job.next_readback_at && this.#now() < Date.parse(job.next_readback_at)) { await this.#waitUntil(id, Date.parse(job.next_readback_at)); return; }
    const payload = job.claimed.payload as PublishPostPayload;
    // WA-1: read-back accepts only posts created after the click (minus a small clock skew), so it is measured from the
    // click (`submitting` is written right before it), not from the confirmation that came up to a minute later.
    const submittedAt = Date.parse(job.submitting_at ?? job.submitted_at ?? job.started_at ?? new Date(this.#now()).toISOString());
    let result: Awaited<ReturnType<PublishDriver['readBack']>> | null = null;
    try {
      result = await this.#session(job, ({ ctx, driver }) => driver.readBack(ctx, job.claimed, {
        ...job.hint, submittedAt, captionPrefix: [...payload.caption.text].slice(0, 30).join(''),
      }));
    } catch (error) {
      if (error instanceof DriverAbort || this.#stopped.signal.aborted) return;
      this.#log('read-back failed', { job_id: id, error: String(error) });
    }
    if (result?.kind === 'found') {
      const evidence = this.#evidence(id);
      this.#finish(id, 'done', 'result', { event: 'result', url: result.url, external_post_id: result.external_post_id, published_at: result.published_at,
        evidence_sha256: evidence, submitted_by: job.submitted_by ?? 'auto', go: job.go_source ?? 'hub' }, value => {
        value.result = { url: result.url, external_post_id: result.external_post_id, published_at: result.published_at, evidence_sha256: evidence };
      });
      this.#store.updateState(state => {
        state.successes.push({ social_account_id: payload.channel.social_account_id, local_date: localDate(submittedAt, payload.timezone), job_id: id });
        state.successes = state.successes.filter(item => this.#now() - Date.parse(`${item.local_date}T00:00:00Z`) < 3 * 86_400_000);
      });
      return;
    }
    const schedule = this.#deps.settings.readbackScheduleSec;
    const attempt = job.readback_attempts + 1;
    if (attempt > schedule.length) {
      let evidence = this.#evidence(id);
      try { evidence = [...new Set([...evidence, await this.#session(job, ({ ctx }) => ctx.evidence('readback_exhausted'))])]; } catch { /* keep what we have */ }
      this.#finish(id, 'done', 'outcome_unknown', { event: 'outcome_unknown', reason: 'readback_exhausted', evidence_sha256: evidence });
      this.#deps.events.emit('local_alert', { kind: 'blocker', title: `${this.#messages(job).channel} 結果不明`,
        body: `${this.#deps.settings.machineName} 已點擊發布，但讀不到 ${this.#messages(job).channel} 的貼文網址。請貼上網址，或確認沒有發出；系統不會自動重發。`, web_url: null });
      return;
    }
    const nextAt = new Date(this.#now() + schedule[attempt - 1] * 1000).toISOString();
    this.#store.update(id, value => { value.readback_attempts = attempt; value.next_readback_at = nextAt; if (value.state === 'submitting' && value.submitted_at) value.state = 'result_pending'; });
    this.#report(id, 'readback_pending', { event: 'readback_pending', attempt, next_at: nextAt });
  }

  // ---------- check_login ----------

  async #checkLogin(job: LocalJob) {
    const id = job.claimed.job_id;
    const payload = job.claimed.payload as CheckLoginPayload;
    const notAfter = Date.parse(job.claimed.not_after);
    if (job.revoked) return this.#releaseLocal(id);
    if (this.#now() > notAfter) {
      this.#finish(id, 'missed', 'late', { event: 'missed', reason: notAfter < this.#startedAt ? 'machine_was_off' : 'late' });
      return;
    }
    if (job.state === 'blocked' && job.blocker && LAUNCH_CODES.includes(job.blocker.code)) {
      await this.#waitUntil(id, Math.min(notAfter + 1, Date.parse(job.blocker.at) + (this.#deps.settings.chromeRetryMs ?? 300_000)));
      if (this.#now() > notAfter) return;
    }
    this.#store.update(id, value => { value.state = 'preflighting'; });
    try {
      const login = await this.#session(job, async ({ ctx, driver, lease }) => {
        let seen = await driver.checkLogin(ctx);
        if (seen.state !== 'verified' && payload.open_login_window) {
          // The owner signs in on this machine; observe read-only every poll interval, up to not_after (§5.12).
          await ctx.page.bringToFront();
          lease.pin(true);
          try {
            const code: BlockerCode = seen.state === 'identity_mismatch' ? 'identity_mismatch' : seen.state === 'challenge' ? 'captcha' : 'login_expired';
            const blocker = (seen.state === 'identity_mismatch' ? null : await driver.detectBlocker(ctx, 'prepare')) ?? { code, phase: 'prepare' as const, message: '' };
            if (await driver.awaitBlockerCleared(ctx, blocker, notAfter)) seen = await driver.checkLogin(ctx);
          } finally { lease.pin(false); }
        }
        return seen;
      });
      const at = new Date(this.#now()).toISOString();
      if (login.state === 'verified') this.#store.updateState(state => { state.channel_checks[payload.channel.social_account_id] = at; });
      this.#finish(id, 'done', `login_${login.state}`, { event: 'login_state', state: login.state, identity: login.identity, handle: login.handle, evidence_sha256: login.evidence_sha256 });
    } catch (error) {
      const blocker = this.#sessionBlocker(error, job);
      if (!blocker) { this.#store.update(id, value => { value.state = 'claimed'; }); return; }
      if (LAUNCH_CODES.includes(blocker.code)) this.#raise(id, blocker, 'preflight');
      else {
        this.#finish(id, 'done', blocker.code, { event: 'prepare_blocked', stage: 'preflight', blocker: this.#deviceBlocker(this.#fullBlocker(job, blocker)) });
      }
    }
  }

  // ---------- views for the shell ----------

  views(): LocalJobView[] {
    return this.#store.jobs().filter(job => !isLocalFinal(job.state)).map(job => ({
      job_id: job.claimed.job_id, kind: job.claimed.kind, provider: job.claimed.payload.provider,
      channel_label: this.#messages(job).channel, state: job.state, not_before: job.claimed.not_before, not_after: job.claimed.not_after,
      blocker: job.blocker ? { code: job.blocker.code, message: job.blocker.message } : null, dry_run: job.claimed.dry_run,
      social_account_id: job.claimed.payload.channel.social_account_id, profile_key: job.claimed.payload.channel.profile_key,
    }));
  }

  #emitJobs() {
    const jobs = this.views();
    this.#deps.events.emit('jobs_changed', { jobs });
    const publish = jobs.filter(job => job.kind === 'publish_post');
    const next = publish.map(job => job.not_before).sort()[0] ?? null;
    this.#deps.events.emitJobsHeld({ publish_jobs: publish.length, next_due_at: next });
  }

  /** Housekeeping hook for the supervisor's tick. */
  tick() { this.#deps.profiles.closeIdle(); }
}

class DriverMissing extends Error {
  constructor(readonly provider: string) { super(`No driver for ${provider}`); this.name = 'DriverMissing'; }
}
