import { createHash } from 'node:crypto';
import {
  OWNER_RESUME_BLOCKERS, Problem, READBACK_SCHEDULE_SEC, RESULT_PENDING_GUARD_SEC, TERMINAL_JOB_STATUSES,
  type Blocker, type BlockerCode, type Context, type Data, type DeviceBlocker, type Row, type WorkerJobStatus,
} from '@smartsell/contracts';
import type { Storage } from '../../../../../packages/media-store/src/storage.js';
import { BLOCKER_COPY, fill } from '../alerts/copy.js';
import { alertJobStatus } from '../alerts/index.js';
import { releaseSuccessors } from './successors.js';
import { syncTaskFromJob } from './sync.js';

/** Record kinds owned by the job engine (phase1-design §3.5, §3.6). */
export const JOB = 'worker_job';
export const EVENT = 'worker_job_event';
export const SYNC = 'worker_sync';

// ---------- Host wiring (bootstrap / publish-host) ----------

export interface TestTiming { offlineStalenessSec?: number; readbackScheduleSec?: number[]; unreportedGraceSec?: number; prepareLeadSec?: number }
export interface WorkerHostOptions {
  /** config.testTiming: only set by the test environment (§2.3). */
  testTiming?: TestTiming;
  workerDownloadDirectory?: string;
  /** <hubDir>/driver-config (§8.11). Undefined outside hub mode: driver-config then answers an explicit 404. */
  driverConfigDirectory?: string;
  /** Media storage for signed downloads (§6.6) and evidence (§8.13). */
  storage?: Storage;
  /** SHA-256 and size (and, from test-clip.json, the probe values) of the Worker's bundled dry-run clip (§8.12). */
  bundledClip?: { sha256: string; bytes: number; width?: number | null; height?: number | null; duration_ms?: number | null };
}
let host: WorkerHostOptions = {};
export function configureWorkerHost(next: WorkerHostOptions) { host = { ...host, ...next }; }
export const workerHost = (): Readonly<WorkerHostOptions> => host;

/** Job timing, shortened only by config.testTiming (§10.2). */
export function workerTiming() {
  const test = host.testTiming;
  const readback = test?.readbackScheduleSec?.length ? test.readbackScheduleSec : READBACK_SCHEDULE_SEC;
  return {
    prepareLeadMin: test?.prepareLeadSec !== undefined ? test.prepareLeadSec / 60 : 30,
    offlineStalenessMin: test?.offlineStalenessSec !== undefined ? test.offlineStalenessSec / 60 : 30,
    unreportedGraceMs: (test?.unreportedGraceSec ?? 600) * 1000,
    /** §5.8: the hub waits for the Worker's whole read-back schedule plus 30 minutes. */
    resultPendingGuardMs: (test?.readbackScheduleSec?.length ? readback.reduce((sum, value) => sum + value, 0) + 1800 : RESULT_PENDING_GUARD_SEC) * 1000,
    leaseAfterMs: 15 * 60_000,
  };
}

// ---------- Small helpers ----------

export const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
export const iso = (ms: number) => new Date(ms).toISOString();
export const now = (ctx: Context) => Date.parse(ctx.now);
export const isTerminal = (job: Row) => TERMINAL_JOB_STATUSES.includes(job.status as WorkerJobStatus);
export const str = (value: unknown) => typeof value === 'string' && value ? value : undefined;
export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export function locate(ctx: Context, kind: string, id: unknown): Row | undefined {
  if (typeof id !== 'string' || !id) return undefined;
  return ctx.list(kind).find(row => row.id === id);
}
export const conflict = (code: string, message: string, details?: Data) => new Problem(409, code, message, details);

export const jobs = (ctx: Context) => ctx.list(JOB);
export const liveJobs = (ctx: Context, match: (job: Row) => boolean = () => true) => jobs(ctx).filter(job => !isTerminal(job) && match(job));
export const jobEvents = (ctx: Context, jobId: string) => ctx.list(EVENT).filter(row => row.job_id === jobId)
  .sort((a, b) => String(a.at).localeCompare(String(b.at)) || String(a.created_at).localeCompare(String(b.created_at)));

/** The newest publish job of a target: target.worker_job_id, else the newest by creation. C3 latestJobForTarget. */
export function latestJobForTarget(ctx: Context, targetId: string): Row | undefined {
  const target = locate(ctx, 'publish_target', targetId);
  const linked = locate(ctx, JOB, target?.worker_job_id);
  if (linked) return linked;
  return jobs(ctx).filter(job => job.publish_target_id === targetId)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.id.localeCompare(a.id))[0];
}

export function machineName(ctx: Context, deviceId: unknown): string {
  const device = locate(ctx, 'connector_device', deviceId);
  return str(device?.display_name) ?? str(device?.name) ?? '機器';
}

const PROVIDER_LABEL: Record<string, string> = { x: 'X', tiktok: 'TikTok', youtube: 'YouTube', meta_instagram: 'Instagram', meta_facebook: 'Facebook' };
/** 'X @makemylure' (same rule as S2's channelLabel), tolerant of a missing account. */
export function channelName(ctx: Context, accountId: unknown): string {
  const account = locate(ctx, 'social_account', accountId);
  if (!account) return '帳號';
  const provider = PROVIDER_LABEL[String(account.provider)] ?? String(account.provider ?? '');
  const handle = str(account.handle)?.replace(/^@/, '');
  return `${provider} ${handle ? `@${handle}` : str(account.display_name) ?? str(account.external_account_id) ?? ''}`.trim();
}

/** Local "09:30" style deadline in the channel time zone, for blocker copy. */
export function localClock(iso: unknown, zone: string): string {
  const at = time(iso);
  if (!Number.isFinite(at)) return '';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  } catch { return new Date(at).toISOString().slice(11, 16); }
}

export function jobZone(ctx: Context, job: Row): string {
  const settings = ctx.list('channel_settings').find(row => row.social_account_id === job.social_account_id);
  return str(settings?.timezone) ?? str((job.payload as Data | undefined)?.timezone) ?? 'UTC';
}

/** §5.9: every blocker names the machine and the account and carries an owner sentence (Appendix C.2). */
export function fullBlocker(ctx: Context, job: Row, input: Partial<DeviceBlocker> & { code: BlockerCode; phase: Blocker['phase'] }): Blocker {
  const machine = machineName(ctx, job.device_id);
  const channel = channelName(ctx, job.social_account_id);
  const deadline = localClock(job.not_after, jobZone(ctx, job));
  const template = Object.hasOwn(BLOCKER_COPY, input.code) ? BLOCKER_COPY[input.code] : undefined;
  const owner = OWNER_RESUME_BLOCKERS.includes(input.code);
  const resumable: Blocker['resumable_by'] = input.code === 'result_conflict' || input.phase === 'after_submit' ? 'none' : owner ? 'owner' : 'auto';
  const message = template ? fill(template, { machine, channel, deadline, step: input.step, platform_message: str(input.message)?.slice(0, 200) })
    : str(input.message) ?? `${machine} 的 ${channel} 需要你處理（截止 ${deadline}）。`;
  return {
    code: input.code, phase: input.phase, message, resumable_by: resumable, machine_id: String(job.device_id), machine_name: machine,
    social_account_id: String(job.social_account_id), channel_label: channel,
    ...(input.step && { step: String(input.step).slice(0, 120) }), ...(input.url && { url: String(input.url).slice(0, 2048) }),
    ...(Array.isArray(input.evidence_sha256) && { evidence_sha256: input.evidence_sha256.filter(item => /^[a-f0-9]{64}$/.test(String(item))).slice(0, 20) }),
    at: str(input.at) ?? new Date().toISOString(),
  };
}

// ---------- Events, status changes, sync generation ----------

const clipDetail = (detail: Data): Data => {
  const text = JSON.stringify(detail);
  if (text.length <= 4096) return detail;
  return { truncated: true, keys: Object.keys(detail).slice(0, 20), excerpt: text.slice(0, 3800) };
};

export function addEvent(ctx: Context, job: Row, event: string, detail: Data = {}, extra: {
  actor?: 'hub' | 'device' | 'human' | 'agent'; worker_time?: string | null; event_id?: string | null; fencing_token?: number | null; seq?: number | null;
  fence_override?: boolean;
} = {}): Row {
  return ctx.create(EVENT, {
    job_id: job.id, at: ctx.now, worker_time: extra.worker_time ?? null, event_id: extra.event_id ?? null,
    fencing_token: extra.fencing_token ?? null, seq: extra.seq ?? null, event, actor: extra.actor ?? 'hub', detail: clipDetail(detail),
    ...(extra.fence_override && { fence_override: true }),
    publish_target_id: job.publish_target_id ?? null, device_id: job.device_id ?? null,
  });
}

/**
 * The only writer of worker_job rows. A status change emits `worker.job.status_changed` (C3, S10 subscribes), raises the
 * owner alert in the same transaction, syncs execution_task/attempt (§5.2) and releases or cancels waiting successors.
 */
export function setJob(ctx: Context, job: Row, patch: Data): Row {
  const next = ctx.update(JOB, job.id, patch);
  const changed = patch.status !== undefined && patch.status !== job.status;
  if (changed) {
    const payload = { job_id: job.id, from: job.status, to: next.status, publish_target_id: next.publish_target_id ?? null,
      social_account_id: next.social_account_id ?? null, device_id: next.device_id ?? null, blocker_code: (next.blocker as Blocker | null)?.code ?? null };
    ctx.emit('worker.job.status_changed', payload);
    // S10's helper is idempotent with its subscriber; an alert problem must never fail a Worker fact (§0 rule 4).
    try { alertJobStatus(ctx, payload as Parameters<typeof alertJobStatus>[1]); } catch { /* the subscriber retries */ }
  }
  if (changed || (patch.submitting_at !== undefined && patch.submitting_at !== job.submitting_at)) syncTaskFromJob(ctx, next);
  // outcome_unknown is not terminal but already decides a waiting successor (cancelled, §5.2).
  if (changed && (isTerminal(next) || next.status === 'outcome_unknown')) releaseSuccessors(ctx, next);
  return locate(ctx, JOB, job.id) ?? next;
}

/** C3: §5.4.1 sync_generation. Records which machines the change affects so views can show sync_behind. */
export function bumpSyncGeneration(ctx: Context, deviceIds: string[], reason: string): number {
  const row = ctx.list(SYNC)[0];
  const generation = Number(row?.generation ?? 0) + 1;
  const devices = { ...(row?.devices as Record<string, Data> | undefined ?? {}) };
  for (const id of new Set(deviceIds.filter(Boolean))) devices[id] = { generation, at: ctx.now, reason };
  if (row) ctx.update(SYNC, row.id, { generation, devices });
  else ctx.create(SYNC, { generation, devices });
  return generation;
}
export const syncGeneration = (ctx: Context) => Number(ctx.list(SYNC)[0]?.generation ?? 0);
/** The newest change affecting one machine: S7's sync_behind compares it with presence.applied_sync_generation. */
export function deviceSyncState(ctx: Context, deviceId: string): { generation: number; at: string | null; reason: string | null } {
  const entry = ((ctx.list(SYNC)[0]?.devices ?? {}) as Record<string, Data>)[deviceId];
  return { generation: Number(entry?.generation ?? 0), at: str(entry?.at) ?? null, reason: str(entry?.reason) ?? null };
}
