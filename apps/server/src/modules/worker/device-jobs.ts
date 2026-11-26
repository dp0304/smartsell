import {
  FACT_EVENTS, Problem, WORKER_JOB_KINDS, isFactReport,
  type Blocker, type BlockerCode, type ClaimedJob, type Context, type Data, type DeviceBlocker, type DevicePosture, type DriverHealth,
  type GoDenyReason, type HeartbeatV2Response, type HeldJobState, type JobReportEvent, type RevokeReason, type Row, type WorkerJobKind,
} from '@smartsell/contracts';
import { activePause, approvalValid, channelEffectiveMode, channelSettingsFor, inPublishWindow, localMinute } from '../../../../../packages/domain/src/publishing/index.js';
import { alertHandleChanged, alertLateFact, alertOfflineStaleSettings } from '../alerts/index.js';
import { bindingOf } from './dispatch.js';
import { hostCaches } from './host-cache.js';
import {
  JOB, addEvent, bumpSyncGeneration, conflict, fullBlocker, isTerminal, iso, jobEvents, jobs, locate, now, setJob, str, syncGeneration, time, workerTiming,
  workerHost,
} from './model.js';
import { recordClaimPresence, recordHeartbeatPresence } from './presence.js';
import { cancelSuccessorsAfterLateFact, releaseSuccessors, waitingOn } from './successors.js';
import { externalIdFromUrl } from './sync.js';

const bad = (message: string) => new Problem(422, 'INVALID_DEVICE_BODY', message);
const int = (value: unknown, min: number, max: number, name: string) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw bad(`Invalid ${name}`);
  return value;
};
const idText = (value: unknown, name: string) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw bad(`Invalid ${name}`);
  return value;
};
const shaList = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)).slice(0, 20) : [];
/** A Worker-supplied string kept on a row, cut to `max` characters (the event detail is clipped separately, model.ts). */
const clip = (value: unknown, max: number) => typeof value === 'string' && value ? value.slice(0, max) : undefined;

// ---------- Report hygiene: what one paired machine may write (security audit S7) ----------

/** Device reports kept per job. A Worker following §5.4.3 sends a few dozen per fence (blockers are sent once per code and stage). */
export const MAX_REPORTS_PER_JOB = 500;
/**
 * Claims of a job its machine did not list as held (a Worker restart re-takes it under a new fence) per job. A paired
 * machine claiming in a loop would otherwise add a fence, a holder entry and a "claimed" event each time; past this the
 * job is no longer handed out again by claim, and its lease runs out as usual.
 */
export const MAX_RECOVERY_CLAIMS_PER_JOB = 100;
/** fence_holders keeps the most recent fences only; an older fence falls back to the job's current machine (heldFence). */
const FENCE_HOLDERS_KEPT = 32;

function withHolder(job: Row, fence: number, deviceId: string) {
  const holders: Record<string, string> = { ...(job.fence_holders as Record<string, string> | undefined ?? {}), [String(fence)]: deviceId };
  const fences = Object.keys(holders).map(Number).sort((a, b) => a - b);
  for (const old of fences.slice(0, Math.max(0, fences.length - FENCE_HOLDERS_KEPT))) delete holders[String(old)];
  return holders;
}
const TRACE_MAX_JSON = 16 * 1024;
/** §5.4.3 result.url: the post's link on its platform. X and TikTok are what the Worker's drivers produce (canonical links). */
const RESULT_HOSTS: Record<string, readonly string[]> = { x: ['x.com', 'twitter.com'], tiktok: ['www.tiktok.com', 'tiktok.com'] };

function providerOf(ctx: Context, job: Row): string {
  return str((job.payload as Data | undefined)?.provider) ?? str(accountOf(ctx, job)?.provider) ?? '';
}

/**
 * A result link the owner may open from the post: https on the job's own platform, no credentials or port. In test mode
 * (config.testTiming) the loopback fixture origin of that platform is accepted too (§8.14). Anything else is dropped, not
 * thrown: the report is still a fact (§5.4.3) — only its link is not trusted.
 */
export function resultUrl(ctx: Context, job: Row, value: unknown): { url: string | null; rejected: boolean } {
  if (value === undefined || value === null || value === '') return { url: null, rejected: false };
  if (typeof value !== 'string' || value.length > 2048) return { url: null, rejected: true };
  let url: URL;
  try { url = new URL(value); } catch { return { url: null, rejected: true }; }
  const provider = providerOf(ctx, job);
  const fixture = workerHost().testTiming?.platformOrigins?.[provider as 'x' | 'tiktok'];
  if (fixture && url.origin === fixture) return { url: url.href, rejected: false };
  const ok = url.protocol === 'https:' && !url.username && !url.password && !url.port && (RESULT_HOSTS[provider] ?? []).includes(url.hostname);
  return ok ? { url: url.href, rejected: false } : { url: null, rejected: true };
}

/** X and TikTok post IDs are digits; other providers keep a short opaque ID. */
function postId(ctx: Context, job: Row, value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return (providerOf(ctx, job) in RESULT_HOSTS ? /^\d{1,32}$/ : /^[A-Za-z0-9_-]{1,128}$/).test(value) ? value : null;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
}

/** dry_run_done.trace: at most 60 steps and 16 KiB in all (it lives on the job row). */
function boundedTrace(value: unknown): Data[] {
  if (!Array.isArray(value)) return [];
  const out: Data[] = [];
  let size = 2;
  for (const item of value.slice(0, 60)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const length = JSON.stringify(item).length + 1;
    if (size + length > TRACE_MAX_JSON) break;
    size += length;
    out.push(item as Data);
  }
  return out;
}

/** The result fields a fact may write, each checked and bounded. */
function resultFields(ctx: Context, job: Row, data: Data) {
  const link = resultUrl(ctx, job, data.url);
  const externalPostId = postId(ctx, job, data.external_post_id) ?? externalIdFromUrl(link.url);
  return { url: link.url, url_rejected: link.rejected, external_post_id: externalPostId, published_at: isoOrNull(data.published_at) };
}

/**
 * The machine must have held the fence it reports under: claim records each fence's machine in fence_holders. A fence with
 * no recorded holder (dispatch, 換機器 and retire bumps, or jobs from before fence_holders) belongs to the job's machine.
 */
function heldFence(job: Row, deviceId: string, fence: number): boolean {
  const holder = (job.fence_holders as Record<string, unknown> | undefined)?.[String(fence)];
  return holder !== undefined ? holder === deviceId : job.device_id === deviceId;
}
const revokedStatus = (reason: unknown) => reason === 'superseded' ? 'superseded' as const : 'cancelled' as const;

// ---------- Hold and go checks (§5.4.4 items 3–8) ----------

function accountOf(ctx: Context, job: Row) { return locate(ctx, 'social_account', job.social_account_id); }
function targetOf(ctx: Context, job: Row) { return locate(ctx, 'publish_target', job.publish_target_id); }

/** Item 4: any pause — workspace/brand/account pause_switch, the target paused, or the machine paused. */
function paused(ctx: Context, job: Row): boolean {
  const device = locate(ctx, 'connector_device', job.device_id);
  if (device?.paused === true) return true;
  const target = targetOf(ctx, job);
  if (target) return target.plan_status === 'paused' || !!activePause(ctx, target);
  const account = accountOf(ctx, job);
  return !!activePause(ctx, { brand_id: account?.brand_id, social_account_id: job.social_account_id });
}

/** The current effective mode as the Worker may use it: a withdrawn risk acknowledgement means assist (§4.5). */
export function currentMode(ctx: Context, job: Row): 'auto' | 'assist' {
  if (job.dry_run === true) return 'auto';
  const account = accountOf(ctx, job);
  const settings = account ? channelSettingsFor(ctx, account.id) : undefined;
  if (!account || !settings) return job.mode === 'auto' ? 'auto' : 'assist';
  return channelEffectiveMode(account.provider, settings) === 'auto' ? 'auto' : 'assist';
}

/** Items 3–6: what a go would refuse right now. These are also the heartbeat's hold (§5.4.1). */
export function holdReason(ctx: Context, job: Row): { reason: GoDenyReason; release: boolean } | null {
  if (job.revoke) return { reason: 'revoked', release: true };
  if (paused(ctx, job)) return { reason: 'paused', release: false };
  if (job.kind === 'publish_post' && job.dry_run !== true) {
    const target = targetOf(ctx, job);
    if (!target || target.plan_status !== 'ready' || target.frozen_hash !== job.frozen_hash || !approvalValid(ctx, target, String(job.frozen_hash))) {
      return { reason: 'approval_invalid', release: true };
    }
  }
  const binding = bindingOf(ctx, job.social_account_id);
  if (!binding || binding.device_id !== job.device_id) return { reason: 'rebound', release: true };
  return null;
}

/** Item 7: published or running posts of the account on the local day of `at`, excluding this job. */
function dayCount(ctx: Context, job: Row, zone: string, at: string): number {
  const day = localMinute(at, zone).slice(0, 10);
  return jobs(ctx).filter(row => row.id !== job.id && row.social_account_id === job.social_account_id && row.kind === 'publish_post' && row.dry_run !== true &&
    ['running', 'submitting', 'result_pending', 'succeeded', 'outcome_unknown', 'unreported'].includes(String(row.status)) &&
    localMinute(String(row.started_at ?? row.go_at ?? row.not_before), zone).slice(0, 10) === day).length;
}

/**
 * Items 7–8. E38: judged at max(now, not_before). A go may arrive up to 60 s early (item 2) and the Worker posts at
 * not_before at the earliest, so a post scheduled at the window start is not missed because its go came a moment early.
 */
function limitReason(ctx: Context, job: Row): GoDenyReason | null {
  if (job.dry_run === true || job.kind !== 'publish_post') return null;
  const settings = channelSettingsFor(ctx, job.social_account_id);
  if (!settings) return null;
  const notBefore = time(job.not_before);
  const at = Number.isFinite(notBefore) && notBefore > now(ctx) ? iso(notBefore) : ctx.now;
  if (dayCount(ctx, job, settings.timezone, at) >= settings.daily_cap) return 'daily_cap_reached';
  if (!inPublishWindow(settings.window, at, settings.timezone)) return 'outside_window';
  return null;
}

function heldState(ctx: Context, job: Row): HeldJobState {
  const hold = holdReason(ctx, job);
  return { job_id: job.id, fencing_token: Number(job.fencing_token), hold: !!hold, hold_reason: hold?.reason ?? null, mode: currentMode(ctx, job),
    resume_token: Number(job.resume_token ?? 0) };
}

/** Remembers what the machine was last told, so an offline run on older settings can be named afterwards (§5.4.3 started). */
function noteSynced(ctx: Context, job: Row, state: { hold: boolean; mode: 'auto' | 'assist' }) {
  const previous = job.synced_view as Data | undefined;
  if (previous?.hold === state.hold && previous?.mode === state.mode) return;
  ctx.update(JOB, job.id, { synced_view: { hold: state.hold, mode: state.mode, at: ctx.now } });
}

// ---------- Heartbeat v2 (§5.4.1) ----------

function channelsFor(ctx: Context, device: Row): HeartbeatV2Response['channels'] {
  const out: HeartbeatV2Response['channels'] = [];
  for (const binding of ctx.list('account_execution_binding')) {
    if (binding.device_id !== device.id || binding.connector_channel !== 'browser' || !['connector', 'hybrid'].includes(String(binding.mode))) continue;
    const account = locate(ctx, 'social_account', binding.social_account_id);
    const settings = account ? channelSettingsFor(ctx, account.id) : undefined;
    if (!account || account.status !== 'active' || !settings) continue;
    const mode = channelEffectiveMode(account.provider, settings);
    out.push({
      social_account_id: account.id, provider: account.provider as HeartbeatV2Response['channels'][number]['provider'], handle: str(account.handle) ?? null,
      expected_identity: String(account.external_account_id ?? ''), profile_key: settings.chrome_profile_key, effective_mode: mode,
      paused: !!activePause(ctx, { brand_id: account.brand_id, social_account_id: account.id }), settings_generation: settings.settings_generation,
      login_check_requested: jobs(ctx).some(job => job.kind === 'check_login' && job.social_account_id === account.id && job.status === 'queued' && job.device_id === device.id),
    });
  }
  return out;
}

/**
 * A held job the machine no longer lists is re-issued (lost local copy). Not a check_login waiting on the owner (WE-5): the
 * Worker finished it locally, ignores a re-issue, and the re-issue only bumped the fence every heartbeat; a check the Worker
 * really lost is queued again when its lease expires (§5.13 item 6).
 */
const recoverable = (job: Row) => ['claimed', 'ready', 'needs_owner'].includes(String(job.status)) && !(job.kind === 'check_login' && job.status === 'needs_owner');

function claimableNow(ctx: Context, job: Row, horizonMs: number): boolean {
  if (job.status !== 'queued' || job.media_pending === true || waitingOn(ctx, job)) return false;
  if (time(job.not_after) < now(ctx)) return false;
  return job.kind === 'check_login' || time(job.not_before) <= now(ctx) + horizonMs;
}

/** Revocation and release both end here: releasing (or a revoked running job) → cancelled / superseded. */
function release(ctx: Context, job: Row, via: string, extra: Data = {}) {
  const revoke = job.revoke as Data | null;
  addEvent(ctx, job, 'released', { via, reason: revoke?.reason ?? null, ...extra }, { actor: 'device' });
  setJob(ctx, job, { status: revokedStatus(revoke?.reason), finished_at: ctx.now, blocker: null });
}

export function heartbeatV2(ctx: Context, device: Row, body: Data): HeartbeatV2Response {
  const clientVersion = typeof body.client_version === 'string' && body.client_version.length <= 80 ? body.client_version : '';
  const drivers = Array.isArray(body.drivers) ? (body.drivers as DriverHealth[]).filter(item => item && typeof item === 'object').slice(0, 10) : undefined;
  const listed = Array.isArray(body.jobs) ? (body.jobs as Data[]).filter(item => typeof item?.job_id === 'string').slice(0, 200) : [];
  const released = Array.isArray(body.released_jobs) ? (body.released_jobs as unknown[]).filter((id): id is string => typeof id === 'string').slice(0, 200) : [];
  const patch = recordHeartbeatPresence(ctx, device, {
    protocol: 2, client_version: clientVersion, drivers, worker_time: str(body.worker_time), outbox_depth: Number.isSafeInteger(body.outbox_depth) ? Number(body.outbox_depth) : 0,
    posture: body.posture && typeof body.posture === 'object' ? body.posture as DevicePosture : undefined,
    remote_access: body.remote_access === null || (body.remote_access && typeof body.remote_access === 'object') ? body.remote_access : undefined,
    applied_sync_generation: Number.isSafeInteger(body.applied_sync_generation) ? Number(body.applied_sync_generation) : undefined,
  });
  // E9: the CPU decides which macOS package latest_worker names; stored only when it changes (no write per heartbeat).
  const arch = body.arch === 'arm64' || body.arch === 'x64' ? body.arch : undefined;
  const write = arch && device.arch !== arch ? { ...patch, arch } : patch;
  if (write) ctx.update('connector_device', device.id, write);
  // The hub treats released_jobs exactly like `released` reports (§5.4.1).
  for (const id of released) {
    const job = locate(ctx, JOB, id);
    if (!job || job.device_id !== device.id || isTerminal(job) || job.submitting_at) continue;
    if (job.status === 'releasing' || (job.revoke && ['running', 'needs_owner', 'claimed', 'ready'].includes(String(job.status)))) release(ctx, job, 'heartbeat');
  }
  const held = new Set(listed.map(item => String(item.job_id)));
  const states: HeldJobState[] = [];
  for (const id of held) {
    const job = locate(ctx, JOB, id);
    if (!job || job.device_id !== device.id || isTerminal(job)) continue;
    const state = heldState(ctx, job);
    states.push(state);
    noteSynced(ctx, job, state);
  }
  const mine = jobs(ctx).filter(job => job.device_id === device.id);
  const revoked = mine.filter(job => job.revoke && (job.status === 'releasing' || ['running', 'needs_owner', 'claimed', 'ready'].includes(String(job.status))) && !job.submitting_at)
    .map(job => ({ job_id: job.id, reason: (job.revoke as Data).reason as RevokeReason }));
  const recover = mine.filter(job => recoverable(job) && !held.has(job.id));
  const claimable = mine.filter(job => claimableNow(ctx, job, 24 * 3_600_000)).length + recover.length;
  const caches = hostCaches();
  return {
    status: 'online', protocol: 2, server_time: new Date().toISOString(), paused: device.paused === true,
    pause_all: !!activePause(ctx, {}), claimable, sync_generation: syncGeneration(ctx), jobs: states, revoked_jobs: revoked,
    channels: channelsFor(ctx, device), latest_worker: caches.latestWorker(device, arch), driver_config: caches.driverConfig(),
  };
}

// ---------- jobs.claim (§5.4.2) ----------

export function claimJobs(ctx: Context, device: Row, body: Data) {
  const kinds = Array.isArray(body.kinds) ? (body.kinds as unknown[]).filter((kind): kind is WorkerJobKind => (WORKER_JOB_KINDS as readonly unknown[]).includes(kind)) : [...WORKER_JOB_KINDS];
  const horizon = body.horizon_minutes === undefined ? 1440 : int(body.horizon_minutes, 0, 7 * 1440, 'horizon_minutes');
  const max = body.max === undefined ? 10 : int(body.max, 1, 50, 'max');
  const held = new Set(Array.isArray(body.held_job_ids) ? (body.held_job_ids as unknown[]).filter((id): id is string => typeof id === 'string').slice(0, 500) : []);
  recordClaimPresence(ctx, device);
  const serverTime = new Date().toISOString();
  if (device.paused === true) return { jobs: [], server_time: serverTime };
  const candidates: Row[] = [];
  for (const job of jobs(ctx).filter(row => row.device_id === device.id && kinds.includes(row.kind as WorkerJobKind))) {
    if (job.status === 'queued' && time(job.not_after) < now(ctx)) {
      addEvent(ctx, job, 'missed_unclaimed', { reason: job.media_pending ? 'media_unavailable' : 'unclaimed', via: 'claim' });
      setJob(ctx, job, { status: 'missed', finished_at: ctx.now });
      continue;
    }
    if (claimableNow(ctx, job, horizon * 60_000)) candidates.push(job);
    else if (recoverable(job) && !held.has(job.id) && job.media_pending !== true && Number(job.recovery_claims ?? 0) < MAX_RECOVERY_CLAIMS_PER_JOB) candidates.push(job);
  }
  candidates.sort((a, b) => time(a.not_before) - time(b.not_before));
  const out: ClaimedJob[] = [];
  for (const job of candidates.slice(0, max)) {
    const fencing = Number(job.fencing_token ?? 0) + 1;
    const mode = currentMode(ctx, job);
    const lease = iso(time(job.not_after) + workerTiming().leaseAfterMs);
    const next = setJob(ctx, job, {
      fencing_token: fencing, fence_holders: withHolder(job, fencing, device.id),
      ...(job.status !== 'queued' && { recovery_claims: Number(job.recovery_claims ?? 0) + 1 }),
      lease_expires_at: lease, claimed_at: job.claimed_at ?? ctx.now, mode,
      ...(job.status === 'queued' && { status: 'claimed' }), synced_view: { hold: false, mode, at: ctx.now },
    });
    addEvent(ctx, next, 'claimed', { fencing_token: fencing, recovery: job.status !== 'queued' }, { actor: 'device', fencing_token: fencing });
    out.push({
      job_id: next.id, kind: next.kind as WorkerJobKind, fencing_token: fencing, mode, dry_run: next.dry_run === true,
      not_before: String(next.not_before), not_after: String(next.not_after), lease_expires_at: lease, prepare_lead_min: Number(next.prepare_lead_min),
      offline_go_max_staleness_min: Number(next.offline_go_max_staleness_min), payload_hash: String(next.payload_hash), payload: next.payload as ClaimedJob['payload'],
    });
  }
  return { jobs: out, server_time: serverTime };
}

// ---------- jobs.go (§5.4.4) ----------

export function goJob(ctx: Context, device: Row, body: Data) {
  const jobId = idText(body.job_id, 'job_id');
  const fence = int(body.fencing_token, 0, Number.MAX_SAFE_INTEGER, 'fencing_token');
  const job = locate(ctx, JOB, jobId);
  const serverTime = new Date().toISOString();
  const deny = (reason: GoDenyReason, releaseJob: boolean, record = true) => {
    if (job && record) {
      const last = jobEvents(ctx, job.id).at(-1);
      if (!(last?.event === 'go_denied' && (last.detail as Data | undefined)?.reason === reason)) addEvent(ctx, job, 'go_denied', { reason, release: releaseJob }, { actor: 'device', fencing_token: fence });
    }
    return { go: false as const, reason, release: releaseJob };
  };
  if (!job || job.device_id !== device.id || Number(job.fencing_token) !== fence) return deny('fence_lost', false, false);
  const status = String(job.status);
  // WE-3, WE-10: a job the hub already revoked is answered `revoked` + release before any other check — also a releasing job
  // (whose state check would say invalid_state and leave the hub waiting for a `released` that never comes) and a running job
  // asking again (the Worker has not clicked: it writes submitting before the click and never asks go after it).
  if (job.revoke && !job.submitting_at && (status === 'releasing' || status === 'running' || LIVE_PRE_RUN.includes(status))) return deny('revoked', true);
  // Idempotent resend: the answer the Worker may have lost (§5.4.4 item 1) — unless a hold the hub knows of now says otherwise.
  if (status === 'running' && job.go_source === 'hub') {
    const hold = holdReason(ctx, job);
    if (hold) return deny(hold.reason, hold.release);
    return { go: true as const, mode: (job.go_mode ?? job.mode) as 'auto' | 'assist', server_time: serverTime };
  }
  if (!LIVE_PRE_RUN.includes(status)) return deny('invalid_state', false);
  if (now(ctx) < time(job.not_before) - 60_000) return deny('too_early', false, false);
  if (now(ctx) > time(job.not_after)) {
    // The Worker never runs a job after this answer (§5.6), so the hub ends it now instead of waiting for a report.
    deny('too_late', false);
    if (!job.submitting_at) {
      // A job held by a pause missed its window because of the pause, whichever arrives first: this go or the Worker's own
      // missed{paused} report (E2E-2c). The owner then reads 「暫停中沒有發出」, not 「超過遲到上限」.
      addEvent(ctx, job, 'missed', { reason: paused(ctx, job) ? 'paused' : 'late', via: 'go' });
      setJob(ctx, job, { status: 'missed', finished_at: ctx.now });
    }
    return { go: false as const, reason: 'too_late' as const, release: false };
  }
  const hold = holdReason(ctx, job);
  if (hold) return deny(hold.reason, hold.release);
  const limit = limitReason(ctx, job);
  if (limit) {
    deny(limit, true);
    addEvent(ctx, job, 'missed', { reason: limit, via: 'go' });
    setJob(ctx, job, { status: 'missed', finished_at: ctx.now });
    return { go: false as const, reason: limit, release: true };
  }
  const mode = currentMode(ctx, job);
  setJob(ctx, job, { status: 'running', go_at: ctx.now, go_source: 'hub', go_mode: mode, mode, blocker: null });
  addEvent(ctx, job, 'go', { mode }, { actor: 'device', fencing_token: fence });
  return { go: true as const, mode, server_time: serverTime };
}

// ---------- jobs.report (§5.4.3) ----------

const POSSIBLY_SENT_EVENTS: readonly JobReportEvent[] = ['submitting', 'submitted', 'result', 'outcome_unknown'];
const LIVE_PRE_RUN = ['claimed', 'ready', 'needs_owner'];
/** A check_login blocked on these stays with the Worker, which retries Chrome until not_after (§8.5); any other blocker ends it. */
const CHECK_RETRIED_ON_MACHINE: readonly BlockerCode[] = ['chrome_unavailable', 'profile_in_use'];

function deviceBlocker(value: unknown, fallbackPhase: Blocker['phase']): DeviceBlocker & { code: BlockerCode } {
  const input = (value && typeof value === 'object' ? value : {}) as Data;
  const code = (typeof input.code === 'string' && /^[a-z0-9_]{1,64}$/.test(input.code) ? input.code : 'platform_error') as BlockerCode;
  const phase = input.phase === 'prepare' || input.phase === 'before_submit' || input.phase === 'after_submit' ? input.phase : fallbackPhase;
  return { code, phase, message: str(input.message)?.slice(0, 500) ?? '', at: isoOrNull(input.at) ?? new Date().toISOString(),
    ...(typeof input.step === 'string' && { step: input.step.slice(0, 120) }), ...(typeof input.url === 'string' && { url: input.url.slice(0, 2048) }),
    evidence_sha256: shaList(input.evidence_sha256) };
}

/** browser_session follows prepare and check_login reports (§3.3, §5.4.3 prepared / prepare_blocked / login_state). */
function updateSession(ctx: Context, job: Row, status: string, observed: { identity?: string | null; handle?: string | null; evidence?: string | null } = {}) {
  const binding = bindingOf(ctx, job.social_account_id);
  if (!binding || binding.device_id !== job.device_id) return;
  const session = ctx.list('browser_session').find(row => row.binding_id === binding.id && row.device_id === binding.device_id && row.status !== 'revoked');
  if (!session) return;
  ctx.update('browser_session', session.id, {
    status, checked_at: ctx.now, last_check_job_id: job.id, ...(status === 'verified' && { verified_at: ctx.now }),
    ...(observed.identity != null && { observed_identity: observed.identity }), ...(observed.handle != null && { observed_handle: observed.handle }),
    ...(observed.evidence && { evidence_file_id: observed.evidence }),
  });
}

function noteHandle(ctx: Context, job: Row, value: unknown) {
  const handle = typeof value === 'string' ? value.trim().replace(/^@/, '').toLowerCase() : '';
  if (!handle || !/^[a-z0-9_.]{1,64}$/.test(handle)) return;
  const account = accountOf(ctx, job);
  if (!account || account.handle === handle) return;
  ctx.update('social_account', account.id, { handle });
  addEvent(ctx, job, 'handle_changed', { from: account.handle ?? null, to: handle });
  // E10: tell the owner (a first handle, from null, is not a change and raises nothing).
  alertHandleChanged(ctx, { social_account_id: account.id, from: str(account.handle) ?? null, to: handle, machine_id: str(job.device_id) ?? null, job_id: job.id });
}

const sessionStatusFor = (code: string) => code === 'login_expired' ? 'login_required' : code === 'captcha' || code === 'two_factor' ? 'challenge'
  : code === 'identity_mismatch' ? 'identity_mismatch' : undefined;

/** Evidence the hub stored for this job, by SHA-256 (§8.13). */
function evidenceFor(ctx: Context, job: Row, hashes: string[]) {
  const files = new Map(ctx.list('file_object').filter(row => row.purpose === 'evidence' && row.worker_job_id === job.id && !row.deleted_at).map(row => [String(row.sha256), row]));
  const ids: string[] = [];
  const missing: string[] = [];
  for (const hash of hashes) {
    const file = files.get(hash);
    const evidence = file && ctx.list('evidence').find(row => row.file_object_id === file.id && row.linked_resource_type === 'worker_job' && row.linked_resource_id === job.id);
    if (evidence) ids.push(evidence.id); else missing.push(hash);
  }
  return { ids, missing };
}

function lateBy(job: Row, startedAt: unknown) {
  const started = time(startedAt);
  return Number.isFinite(started) ? Math.max(0, Math.round((started - time(job.not_before)) / 1000)) : 0;
}

function workerTimeOr(ctx: Context, value: unknown) {
  const at = time(value);
  return Number.isFinite(at) && at <= now(ctx) + 120_000 && at > now(ctx) - 7 * 86_400_000 ? new Date(at).toISOString() : ctx.now;
}

/**
 * started{go:'offline'}: the hold or mode the hub would give now differs from what the machine last received — or the machine
 * ran on something other than the hub's last view (WE-9). synced_view is written when a heartbeat commits, before its answer
 * reaches the Worker, so it may never have been delivered: a mode the Worker reports that differs from it, or an offline run
 * although the hub's last view said hold, proves the Worker ran on an older view.
 */
function staleOfflineRun(ctx: Context, job: Row, reportedMode: unknown, startedAt: string): boolean {
  const synced = job.synced_view as Data | undefined;
  if (!synced) return false;
  const hold = holdReason(ctx, { ...job, revoke: job.revoke });
  if ((!!hold && synced.hold === false) || currentMode(ctx, job) !== synced.mode) return true;
  // Only a view the hub computed before the run says what the machine should have run on.
  if (!(time(synced.at) <= time(startedAt))) return false;
  if (synced.hold === true) return true;
  return (reportedMode === 'auto' || reportedMode === 'assist') && reportedMode !== synced.mode;
}

/** Transition for one report on a live job (or a fact on any job). Never throws for facts. */
function applyReport(ctx: Context, job: Row, event: JobReportEvent, data: Data, workerTime: string): Data {
  const status = String(job.status);
  const started = !!job.started_at || ['running', 'submitting', 'result_pending'].includes(status);
  switch (event) {
    case 'prepared': {
      const stage = data.stage === 'final' ? 'final' : 'preflight';
      updateSession(ctx, job, 'verified', { identity: clip(data.identity, 128) ?? null, handle: clip(data.handle, 128) ?? null });
      noteHandle(ctx, job, data.handle);
      if (!LIVE_PRE_RUN.includes(status)) return { applied: false };
      const auto = job.blocker && (job.blocker as Blocker).resumable_by !== 'none';
      setJob(ctx, job, {
        status: stage === 'final' ? 'ready' : status === 'ready' ? 'ready' : 'claimed',
        ...(stage === 'final' ? { prepared_at: ctx.now } : { preflight_at: ctx.now }), ...(auto ? { blocker: null } : {}),
        ...(data.driver && typeof data.driver === 'object' ? { driver: { provider: String((data.driver as Data).provider ?? '').slice(0, 80), version: String((data.driver as Data).version ?? '').slice(0, 80) } } : {}),
      });
      return { stage };
    }
    case 'prepare_blocked': {
      const blocker = fullBlocker(ctx, job, deviceBlocker(data.blocker, 'prepare'));
      const session = sessionStatusFor(blocker.code);
      if (session) updateSession(ctx, job, session);
      if (!LIVE_PRE_RUN.includes(status)) return { applied: false, code: blocker.code };
      // WE-5: a login check the Worker gave up on is over (only a Chrome that would not start is retried on the machine).
      if (job.kind === 'check_login' && !CHECK_RETRIED_ON_MACHINE.includes(blocker.code)) {
        setJob(ctx, job, { status: 'failed', finished_at: ctx.now, blocker: { ...blocker, phase: 'prepare' }, failure: { code: blocker.code, message: null } });
        return { code: blocker.code, stage: data.stage ?? null, check_ended: true };
      }
      setJob(ctx, job, { status: 'needs_owner', blocker: { ...blocker, phase: 'prepare' } });
      return { code: blocker.code, stage: data.stage ?? null };
    }
    case 'started': {
      const go = data.go === 'offline' ? 'offline' : 'hub';
      const startedAt = workerTimeOr(ctx, workerTime);
      const stale = go === 'offline' && staleOfflineRun(ctx, job, data.mode, startedAt);
      if ([...LIVE_PRE_RUN, 'releasing', 'running'].includes(status)) {
        setJob(ctx, job, { status: 'running', started_at: job.started_at ?? startedAt, go_source: job.go_source === 'hub' && go === 'hub' ? 'hub' : go,
          ...(data.mode === 'auto' || data.mode === 'assist' ? { run_mode: data.mode } : {}), blocker: null });
      } else if (!job.started_at) ctx.update(JOB, job.id, { started_at: startedAt });
      if (stale) {
        addEvent(ctx, job, 'offline_run_used_stale_settings', { synced: job.synced_view ?? null, mode_now: currentMode(ctx, job), hold_now: holdReason(ctx, job)?.reason ?? null });
        try { alertOfflineStaleSettings(ctx, { job_id: job.id, publish_target_id: str(job.publish_target_id) ?? null }); } catch { /* subscriber retries */ }
      }
      return { go };
    }
    case 'submitting':
      if (['submitting', 'result_pending', 'succeeded', 'outcome_unknown'].includes(status)) return { applied: false };
      setJob(ctx, job, { status: 'submitting', submitting_at: job.submitting_at ?? workerTimeOr(ctx, workerTime), started_at: job.started_at ?? workerTimeOr(ctx, workerTime) });
      return {};
    case 'submitted':
      if (['result_pending', 'succeeded', 'outcome_unknown'].includes(status)) return { applied: false };
      setJob(ctx, job, { status: 'result_pending', submitted_at: workerTimeOr(ctx, workerTime), submitting_at: job.submitting_at ?? workerTimeOr(ctx, workerTime),
        started_at: job.started_at ?? workerTimeOr(ctx, workerTime) });
      return { toast_url: clip(data.toast_url, 2048) ?? null };
    case 'readback_pending':
      return { attempt: data.attempt ?? null, next_at: data.next_at ?? null };
    case 'result': {
      if (status === 'succeeded') return { applied: false };
      const { url, url_rejected, external_post_id, published_at } = resultFields(ctx, job, data);
      const hashes = shaList(data.evidence_sha256);
      const evidence = evidenceFor(ctx, job, hashes);
      const result = {
        url, external_post_id, published_at,
        evidence_sha256: hashes, evidence_ids: evidence.ids, ...(evidence.missing.length && { evidence_missing: evidence.missing }),
        late_by_sec: lateBy(job, job.started_at),
      };
      setJob(ctx, job, { status: 'succeeded', result, submitted_by: data.submitted_by === 'owner' ? 'owner' : 'auto', finished_at: ctx.now,
        submitted_at: job.submitted_at ?? ctx.now, submitting_at: job.submitting_at ?? job.submitted_at ?? ctx.now, blocker: null });
      return { url, external_post_id: result.external_post_id, evidence_missing: evidence.missing, ...(url_rejected && { url_rejected: true }) };
    }
    case 'blocked': {
      const input = deviceBlocker(data.blocker, 'before_submit');
      if (input.phase === 'after_submit') {
        const blocker = fullBlocker(ctx, job, { ...input, phase: 'after_submit' });
        if (status !== 'outcome_unknown') setJob(ctx, job, { status: 'outcome_unknown', blocker, submitting_at: job.submitting_at ?? ctx.now });
        return { code: blocker.code, phase: 'after_submit' };
      }
      const blocker = fullBlocker(ctx, job, { ...input, phase: input.phase === 'prepare' ? 'prepare' : 'before_submit' });
      if (![...LIVE_PRE_RUN, 'running'].includes(status)) return { applied: false, code: blocker.code };
      const session = sessionStatusFor(blocker.code);
      if (session) updateSession(ctx, job, session);
      setJob(ctx, job, { status: 'needs_owner', blocker });
      return { code: blocker.code, phase: blocker.phase };
    }
    case 'failed': {
      const code = typeof data.code === 'string' && /^[a-z0-9_]{1,64}$/.test(data.code) ? data.code : 'platform_error';
      if (job.submitting_at) {
        // A failure after a recorded submitting cannot prove that nothing was posted.
        setJob(ctx, job, { status: 'outcome_unknown', blocker: fullBlocker(ctx, job, { code: 'platform_error', phase: 'after_submit', message: clip(data.message, 500) ?? '', at: ctx.now }) });
        return { code, conservative: 'outcome_unknown' };
      }
      setJob(ctx, job, { status: 'failed', finished_at: ctx.now, failure: { code, message: str(data.message)?.slice(0, 500) ?? null },
        ...(code === 'media_hash_mismatch' || code === 'upload_rejected' || code === 'caption_rejected'
          ? { blocker: fullBlocker(ctx, job, { code: code as BlockerCode, phase: 'before_submit', message: clip(data.message, 500) ?? '', at: ctx.now, evidence_sha256: shaList(data.evidence_sha256) }) } : {}) });
      return { code };
    }
    case 'missed': {
      const reason = typeof data.reason === 'string' ? data.reason.slice(0, 40) : 'late';
      if (job.revoke) { release(ctx, job, 'missed', { missed_reason: reason }); return { reason, revoked: true }; }
      setJob(ctx, job, { status: 'missed', finished_at: ctx.now });
      return { reason };
    }
    case 'dry_run_done': {
      if (job.dry_run !== true || status === 'succeeded') return { applied: false };
      const trace = boundedTrace(data.trace);
      setJob(ctx, job, { status: 'succeeded', finished_at: ctx.now, driver_trace: trace,
        result: { url: null, external_post_id: null, published_at: null, evidence_sha256: shaList(data.evidence_sha256), late_by_sec: 0, dry_run: true } });
      return { steps: trace.length };
    }
    case 'outcome_unknown':
      if (status !== 'outcome_unknown') setJob(ctx, job, { status: 'outcome_unknown', submitting_at: job.submitting_at ?? (started ? ctx.now : null) });
      return { reason: clip(data.reason, 200) ?? null };
    case 'released':
      if (job.status === 'releasing' || job.revoke || LIVE_PRE_RUN.includes(status) || status === 'running') {
        if (job.submitting_at) return { applied: false };
        release(ctx, job, 'report');
        return { reason: (job.revoke as Data | null)?.reason ?? null };
      }
      return { applied: false };
    case 'login_state': {
      if (job.kind !== 'check_login') return { applied: false };
      const state = typeof data.state === 'string' && data.state.length <= 40 ? data.state : 'login_required';
      const account = accountOf(ctx, job);
      const identity = clip(data.identity, 128) ?? null;
      const mismatch = state === 'verified' && !!identity && !!account && identity.toLowerCase() !== String(account.external_account_id ?? '').toLowerCase();
      const final = mismatch ? 'identity_mismatch' : state;
      const shot = ctx.list('file_object').find(row => row.purpose === 'evidence' && row.worker_job_id === job.id && shaList(data.evidence_sha256).includes(String(row.sha256)));
      updateSession(ctx, job, final === 'verified' ? 'verified' : ['login_required', 'identity_mismatch', 'challenge'].includes(final) ? final : 'login_required',
        { identity, handle: clip(data.handle, 128) ?? null, evidence: shot?.id ?? null });
      if (!mismatch) noteHandle(ctx, job, data.handle);
      const evidence = shaList(data.evidence_sha256);
      const result = { url: null, external_post_id: null, published_at: null, evidence_sha256: evidence, late_by_sec: 0, login_state: final };
      if (final === 'verified') setJob(ctx, job, { status: 'succeeded', finished_at: ctx.now, blocker: null, result });
      else {
        // WE-5: the check is over — the Worker finished it locally. It ends as failed with the login state and the blocker
        // (channel page, channel_check and the login_check_failed alert read them), so a new check or 「重新登入」 starts fresh
        // and the account can move machines; a live needs_owner check was re-issued every heartbeat for ~50 minutes.
        const code: BlockerCode = final === 'identity_mismatch' ? 'identity_mismatch' : final === 'challenge' ? 'captcha' : 'login_expired';
        setJob(ctx, job, { status: 'failed', finished_at: ctx.now, result, failure: { code, message: null },
          blocker: fullBlocker(ctx, job, { code, phase: 'prepare', message: '', at: ctx.now, evidence_sha256: evidence }) });
      }
      return { state: final };
    }
  }
  return { applied: false };
}

/**
 * §5.4.3: idempotent report ingestion. Facts are accepted from a machine in device_history under any fence it held (also a
 * lost one, also on an ended job); leases need the current fence. S7: a fence above the current one was never issued, and
 * a fence held by another machine (or never claimed by this one) is not this machine's to report under: JOB_FENCE_LOST.
 */
export function reportJob(ctx: Context, device: Row, body: Data) {
  const jobId = idText(body.job_id, 'job_id');
  const fence = int(body.fencing_token, 0, Number.MAX_SAFE_INTEGER, 'fencing_token');
  const seq = int(body.seq, 1, Number.MAX_SAFE_INTEGER, 'seq');
  if (typeof body.event_id !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(body.event_id)) throw bad('Invalid event_id');
  const eventId = body.event_id;
  const event = body.event as JobReportEvent;
  const known: readonly string[] = [...FACT_EVENTS, 'prepared', 'prepare_blocked', 'readback_pending', 'blocked', 'failed', 'missed', 'released', 'login_state'];
  if (typeof event !== 'string' || !known.includes(event)) throw bad('Unknown report event');
  const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data) ? body.data as Data : {};
  const workerTime = str(body.worker_time) ?? ctx.now;
  const job = locate(ctx, JOB, jobId);
  if (!job) throw new Problem(404, 'JOB_NOT_FOUND', 'Unknown job');
  const history = Array.isArray(job.device_history) ? job.device_history as string[] : [];
  if (!history.includes(device.id)) throw conflict('JOB_FENCE_LOST', 'This machine never held the job');
  if (fence > Number(job.fencing_token ?? 0)) throw conflict('JOB_FENCE_LOST', 'This fence was never issued');
  if (!heldFence(job, device.id, fence)) throw conflict('JOB_FENCE_LOST', 'This machine did not hold that fence');
  if (ctx.list('worker_job_event').some(row => row.job_id === job.id && row.event_id === eventId)) return { status: 'duplicate' };
  const reports = Number(job.report_count ?? 0);
  if (reports >= MAX_REPORTS_PER_JOB) throw new Problem(429, 'JOB_REPORT_LIMIT', `This job already has ${MAX_REPORTS_PER_JOB} reports`);
  const fact = isFactReport({ event, data: data as never });
  const leaseValid = fence === Number(job.fencing_token) && !isTerminal(job) && job.device_id === device.id;
  if (!fact && !leaseValid) throw conflict('JOB_FENCE_LOST', 'The lease for this job has moved on');
  const bySeq = { ...(job.seq_by_fence as Record<string, number> | undefined ?? {}) };
  const last = bySeq[String(fence)] ?? 0;
  if (seq > last + 1) throw conflict('SEQ_GAP', `Expected seq ${last + 1}`, { expected: last + 1 });
  if (seq <= last) throw conflict('SEQ_CONFLICT', `seq ${seq} was already used with another event_id`);
  bySeq[String(fence)] = seq;
  const marked = ctx.update(JOB, job.id, { seq_by_fence: bySeq, report_count: reports + 1 });
  const override = !leaseValid;
  const meta = { actor: 'device' as const, worker_time: workerTime, event_id: eventId, fencing_token: fence, seq, fence_override: override };
  // From here on a fact never throws: every conflict is recorded and answered with 200 (§5.4.3).
  let detail: Data = {};
  try {
    const possiblySentFact = POSSIBLY_SENT_EVENTS.includes(event) || (event === 'blocked' && (data.blocker as Data | undefined)?.phase === 'after_submit');
    // §5.4.3: only a job the hub released (or ended without a post) turns into a late fact. A succeeded job — read back or
    // confirmed by the owner — keeps its result: later facts are recorded only, with no alert (WE-1).
    const released = ['cancelled', 'superseded', 'missed', 'failed', 'releasing'].includes(String(marked.status));
    if (fact && possiblySentFact && released) {
      detail = lateFact(ctx, marked, event, data, workerTime);
    } else if (fact && isTerminal(marked)) {
      detail = { applied: false, terminal: marked.status, ...(marked.status === 'succeeded' && event === 'result' && differentPost(ctx, marked, data)) };
    } else {
      const revokedBefore = !!marked.revoke;
      detail = applyReport(ctx, marked, event, data, workerTime);
      if (revokedBefore && possiblySentFact && (detail as Data).applied !== false) {
        // Cancelled too late: the Worker had already clicked (§5.10). The owner is told; facts are kept.
        ctx.emit('worker.job.late_fact', { job_id: marked.id, publish_target_id: marked.publish_target_id ?? null, successor_cancelled: false });
        try { alertLateFact(ctx, { job_id: marked.id, publish_target_id: str(marked.publish_target_id) ?? null }); } catch { /* subscriber retries */ }
      }
    }
  } catch (error) {
    if (!fact) throw error;
    detail = { conflict: (error as { code?: string }).code ?? 'FACT_HANDLING_FAILED', message: String((error as Error).message ?? error).slice(0, 300) };
    const current = locate(ctx, JOB, job.id)!;
    addEvent(ctx, current, 'fact_conflict', detail);
    if (current.status !== 'outcome_unknown' && current.status !== 'succeeded') {
      try { setJob(ctx, current, { status: 'outcome_unknown', blocker: fullBlocker(ctx, current, { code: 'result_conflict', phase: 'after_submit', message: '', at: ctx.now }) }); }
      catch { ctx.update(JOB, current.id, { status: 'outcome_unknown' }); }
    }
  }
  addEvent(ctx, locate(ctx, JOB, job.id)!, event, { ...detail, ...(event === 'result' || event === 'dry_run_done' ? {} : summarize(data)) }, meta);
  return { status: 'ok' };
}

/** A result fact on a succeeded job that names another post than the recorded one (kept on the event for the owner to see). */
function differentPost(ctx: Context, job: Row, data: Data): Data {
  const recorded = str((job.result as Data | null)?.external_post_id);
  const reported = postId(ctx, job, data.external_post_id) ?? externalIdFromUrl(resultUrl(ctx, job, data.url).url);
  return recorded && reported && recorded !== reported ? { different_post: true, recorded_external_post_id: recorded } : {};
}

const summarize = (data: Data): Data => {
  const { trace: _trace, ...rest } = data as Data & { trace?: unknown };
  return rest;
};

/** A fact that says the job may have posted after the hub released it: the facts win, the successor is cancelled (§5.4.3). */
function lateFact(ctx: Context, job: Row, event: JobReportEvent, data: Data, workerTime: string): Data {
  const status = event === 'result' ? 'succeeded' : 'outcome_unknown';
  const fields = event === 'result' ? resultFields(ctx, job, data) : null;
  const url = fields?.url ?? null;
  const patch: Data = {
    status, submitting_at: job.submitting_at ?? workerTimeOr(ctx, workerTime), started_at: job.started_at ?? workerTimeOr(ctx, workerTime), fence_override: true,
    finished_at: status === 'succeeded' ? ctx.now : job.finished_at ?? null,
  };
  if (status === 'succeeded') {
    const hashes = shaList(data.evidence_sha256);
    const evidence = evidenceFor(ctx, job, hashes);
    patch.result = { url, external_post_id: fields?.external_post_id ?? null, published_at: fields?.published_at ?? null,
      evidence_sha256: hashes, evidence_ids: evidence.ids, late_by_sec: lateBy(job, job.started_at ?? workerTime), fence_override: true };
    patch.submitted_by = data.submitted_by === 'owner' ? 'owner' : 'auto';
  } else if (event === 'blocked') {
    patch.blocker = fullBlocker(ctx, job, { ...deviceBlocker(data.blocker, 'after_submit'), phase: 'after_submit' });
  }
  addEvent(ctx, job, 'late_fact_after_release', { previous_status: job.status, event, ...(url && { url }) }, { actor: 'device', fence_override: true });
  const next = setJob(ctx, job, patch);
  // outcome_unknown is not terminal, so cancel the waiting successor explicitly; a successor the release already let go
  // (force_release) is cancelled too as long as it has not started (§5.4.3).
  releaseSuccessors(ctx, next);
  cancelSuccessorsAfterLateFact(ctx, next);
  ctx.emit('worker.job.late_fact', { job_id: job.id, publish_target_id: job.publish_target_id ?? null, successor_cancelled: true });
  try { alertLateFact(ctx, { job_id: job.id, publish_target_id: str(job.publish_target_id) ?? null }); } catch { /* subscriber retries */ }
  bumpSyncGeneration(ctx, [String(job.device_id)], 'late_fact');
  return { late_fact: true, previous_status: job.status, status, ...(fields?.url_rejected && { url_rejected: true }) };
}
