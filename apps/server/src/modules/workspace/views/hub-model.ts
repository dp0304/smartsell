import {
  DRIVER_PROVIDERS, HUB_PROVIDERS, MCP_PROVIDER, Problem, TERMINAL_JOB_STATUSES, derivePostStatus, hubSawStart,
  type Blocker, type Context, type Data, type DriverHealth, type EffectiveMode, type HubProvider, type PostStatus, type Presence,
  type RouteKind, type Row, type WorkerJobRecord, type WorkerJobStatus,
} from '@smartsell/contracts';
import { channelEffectiveMode, deviceConnected, deviceOnline, localMinute, locate, object, time } from '../../../../../../packages/domain/src/publishing/index.js';
import { approvalDeadline, channelSettingsOrDefault } from '../../account/channel-settings.js';
import { bindingFor } from '../../account/device-control.js';
import { workspace } from '../brands.js';

/**
 * Shared read helpers for the phase 1 read models (phase1-design §9.7, S7). Every function only reads; every Worker record is
 * read defensively because the job engine (S3) may not have written it yet. Status comes from the single derivePostStatus.
 */

export const TARGET = 'publish_target';
export const JOB = 'worker_job';
export const JOB_EVENT = 'worker_job_event';

export const isHubProvider = (provider: unknown): provider is HubProvider => (HUB_PROVIDERS as readonly unknown[]).includes(provider);
export const hasDriver = (provider: unknown) => (DRIVER_PROVIDERS as readonly unknown[]).includes(provider);
export const mcpProvider = (provider: unknown) => isHubProvider(provider) ? MCP_PROVIDER[provider] : String(provider ?? '');
export const str = (value: unknown) => typeof value === 'string' && value ? value : undefined;
export const isLive = (job: Pick<WorkerJobRecord, 'status'> | undefined) => !!job && !TERMINAL_JOB_STATUSES.includes(job.status as WorkerJobStatus);
const PROVIDER_LABEL: Record<string, string> = { x: 'X', tiktok: 'TikTok', youtube: 'YouTube', meta_instagram: 'Instagram', meta_facebook: 'Facebook' };
export const providerLabel = (provider: unknown) => PROVIDER_LABEL[String(provider)] ?? String(provider ?? '');

/** Unknown query parameters are refused (§9.7 「查詢參數嚴格驗證」), not silently ignored (B20). */
export function strictQuery(query: Record<string, string | undefined>, allowed: readonly string[]) {
  const unknown = Object.keys(query).find(key => !allowed.includes(key));
  if (unknown) {
    const message = `Unknown query parameter ${unknown}. Allowed: ${allowed.join(', ') || 'none'}`;
    throw new Problem(422, 'INVALID_ARGUMENTS', message, { issues: [{ path: unknown, message }] });
  }
}
export function invalidQuery(path: string, message: string): never {
  throw new Problem(422, 'INVALID_ARGUMENTS', message, { issues: [{ path, message }] });
}

// ---------- Time ----------

export function validZone(zone: unknown): zone is string {
  if (typeof zone !== 'string' || !zone) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}
export function workspaceZone(ctx: Context): string {
  const zone = workspace(ctx).default_timezone;
  return validZone(zone) ? zone : 'UTC';
}
/** 'YYYY-MM-DD HH:mm' in `zone`, or null. */
export function localText(at: unknown, zone: string): string | null {
  if (typeof at !== 'string' || !Number.isFinite(time(at))) return null;
  return localMinute(at, zone).replace('T', ' ');
}
export const localDay = (at: string, zone: string) => localMinute(at, zone).slice(0, 10);
export const addMinutes = (at: string, minutes: number) => new Date(time(at) + minutes * 60_000).toISOString();
export const iso = (ms: number) => new Date(ms).toISOString();

// ---------- Machines ----------

type PresenceContext = Context & { presence?: (deviceId: string) => Presence | undefined };
/** C14: in-memory presence when the hub injected it; never throws. */
export function presenceOf(ctx: Context, deviceId: string): Presence | undefined {
  try { return (ctx as PresenceContext).presence?.(deviceId); } catch { return undefined; }
}
export const machineName = (device: Row | undefined) => str(device?.display_name) ?? str(device?.name) ?? '機器';
export const machineOnline = (ctx: Context, device: Row | undefined) => deviceOnline(ctx, device);
/** Heartbeating, paused or not (U3: a paused machine is not offline). */
export const machineConnected = (ctx: Context, device: Row | undefined) => deviceConnected(ctx, device);
export function lastSeen(ctx: Context, device: Row): string | null {
  return str(presenceOf(ctx, device.id)?.last_seen_at) ?? str(device.last_seen_at) ?? null;
}
export function machineDrivers(ctx: Context, device: Row): DriverHealth[] {
  const drivers = presenceOf(ctx, device.id)?.drivers ?? device.drivers;
  return Array.isArray(drivers) ? drivers.filter(item => item && typeof item === 'object') as DriverHealth[] : [];
}
/** `vnc://…` or RDP, only when the machine itself reported that the owner turned remote access on (§4.5, Appendix D 10). */
export function remoteUrl(device: Row | undefined): string | null {
  const access = object(device?.remote_access);
  if (typeof access.host !== 'string' || !/^[A-Za-z0-9.-]{1,253}$/.test(access.host)) return null;
  return access.kind === 'vnc' ? `vnc://${access.host}` : access.kind === 'rdp' ? `rdp://full%20address=s:${access.host}` : null;
}

// ---------- Channels ----------

export function hubChannels(ctx: Context): Row[] {
  return ctx.list('social_account').filter(row => isHubProvider(row.provider) && row.status === 'active')
    .sort((a, b) => String(a.provider).localeCompare(String(b.provider)) || String(a.handle ?? a.display_name ?? '').localeCompare(String(b.handle ?? b.display_name ?? '')) || a.id.localeCompare(b.id));
}
export function activeMachines(ctx: Context): Row[] {
  return ctx.list('connector_device').filter(row => row.status === 'active')
    .sort((a, b) => machineName(a).localeCompare(machineName(b)) || a.id.localeCompare(b.id));
}
export const handleOf = (account: Row | undefined) => str(account?.handle)?.replace(/^@/, '') ?? null;
/** 'X @makemylure' (the same rule as S2's channelLabel) and tolerant of a missing account. */
export function channelLabelOf(account: Row | undefined): string {
  if (!account) return '帳號';
  const handle = handleOf(account);
  return `${providerLabel(account.provider)} ${handle ? `@${handle}` : str(account.display_name) ?? str(account.external_account_id) ?? ''}`.trim();
}
/** The machine the channel is bound to (Worker route: connector binding on the browser channel). */
export function channelDevice(ctx: Context, accountId: string): Row | undefined {
  const binding = bindingFor(ctx, accountId);
  const device = binding && typeof binding.device_id === 'string' && binding.connector_channel === 'browser'
    ? locate(ctx, 'connector_device', binding.device_id) : undefined;
  return device && device.status !== 'revoked' ? device : undefined;
}
export function effectiveModeOf(ctx: Context, account: Row): EffectiveMode {
  return channelEffectiveMode(account.provider, channelSettingsOrDefault(ctx, account.id));
}

// ---------- Jobs ----------

export const allJobs = (ctx: Context) => ctx.list(JOB) as unknown as (WorkerJobRecord & Row)[];
export function jobsForTarget(ctx: Context, targetId: string) {
  return allJobs(ctx).filter(job => job.publish_target_id === targetId && job.kind === 'publish_post')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
}
/** The job the target points at (S3 keeps worker_job_id on the live job), else its newest job. */
export function latestJob(ctx: Context, target: Row): (WorkerJobRecord & Row) | undefined {
  const pointed = typeof target.worker_job_id === 'string' ? allJobs(ctx).find(job => job.id === target.worker_job_id) : undefined;
  return pointed ?? jobsForTarget(ctx, target.id)[0];
}
export function jobEvents(ctx: Context, jobId: string): Row[] {
  return ctx.list(JOB_EVENT).filter(row => row.job_id === jobId)
    .sort((a, b) => String(a.at ?? a.created_at).localeCompare(String(b.at ?? b.created_at)) || String(a.created_at).localeCompare(String(b.created_at)));
}
export function platformPostFor(ctx: Context, targetId: string): Row | undefined {
  return ctx.list('platform_post').find(row => row.publish_target_id === targetId && ['system_verified', 'manual_confirmed'].includes(String(row.verification)));
}
export const isHubTarget = (ctx: Context, target: Row) => isHubProvider(locate(ctx, 'social_account', target.social_account_id)?.provider);

/**
 * E37: the target's latest approval request was rejected by the owner and no newer request exists. Planning points
 * target.approval_request_id at each new request, so the scan for a newer one only runs for a rejected link.
 */
export function approvalRejected(ctx: Context, target: Row): boolean {
  const linked = locate(ctx, 'approval_request', target.approval_request_id);
  if (linked?.status !== 'rejected') return false;
  return !ctx.list('approval_request').some(row => row.id !== linked.id && row.resource_id === target.id &&
    String(row.created_at ?? '') > String(linked.created_at ?? ''));
}

/** E36: a force release counts as E17's missed run only when the hub has no record that the job started. */
export const forceReleasedUnstarted = (job: Row | undefined) => job?.force_released === true && !hubSawStart(job);

/**
 * E36: whether the post page may offer 「強制釋放」 for this job — it is releasing or unreported and the hub never saw it start
 * (go, started or submitting). hub_jobs_force_release refuses the others with 409 POSSIBLY_SENT. postActions also requires
 * the machine to be offline (§5.14).
 */
export const canForceRelease = (job: Row | undefined) => !!job && ['releasing', 'unreported'].includes(String(job.status)) && !hubSawStart(job);

/**
 * The single status derivation (Appendix A derivePostStatus) with this target's inputs. A job the owner force-released
 * before the hub saw it start (E17, E36) is passed as such, so the contract derives a missed run (「改到…」) instead of a
 * scheduled post that never comes; a rejected latest approval request derives `rejected` (E37).
 */
export function postStatus(ctx: Context, target: Row, job = latestJob(ctx, target)): PostStatus {
  const deadline = target.plan_status === 'awaiting_approval' ? approvalDeadline(ctx, target) : null;
  const released = (job as Row | undefined)?.force_released === true;
  return derivePostStatus({
    plan_status: String(target.plan_status), precheck_summary: typeof target.precheck_summary === 'string' ? target.precheck_summary : null,
    has_platform_post: !!platformPostFor(ctx, target.id), job_status: job?.status ?? null,
    job_revoke_reason: job?.revoke?.reason ?? null, approval_lapsed: !!deadline && time(deadline) <= time(ctx.now),
    // Before E36 a started job could be force-released; such a legacy row still shows as missed, with its own reason below.
    job_force_released: released, approval_rejected: approvalRejected(ctx, target),
  });
}

/** Why a missed post did not go out: the job's own missed event, else the approval deadline (§4.2). */
export function missedReason(ctx: Context, target: Row, job: Row | undefined, status: PostStatus): string | null {
  if (status !== 'missed') return null;
  if (!job || target.plan_status === 'awaiting_approval') return 'not_approved';
  // E36: only a release without any start on record says the machine was off; a legacy release of a started job does not.
  if (job.force_released === true) return forceReleasedUnstarted(job) ? 'machine_was_off' : 'released_unconfirmed';
  const events = jobEvents(ctx, job.id).reverse();
  for (const event of events) {
    const detail = object(event.detail);
    if (event.event === 'missed_machine_off') return 'machine_was_off';
    if (event.event === 'missed_unclaimed') {
      const reason = str(detail.reason);
      return reason === 'media_unavailable' || reason === 'machine_retired' ? reason : 'machine_was_off';
    }
    if (event.event === 'missed' && str(detail.reason)) return String(detail.reason);
  }
  return 'late';
}

export const caption = (ctx: Context, target: Row): string => {
  const revision = locate(ctx, 'content_revision', target.variant_revision_id);
  const rendered = object(revision?.rendered);
  return typeof rendered.text === 'string' ? rendered.text : typeof revision?.body === 'string' ? revision.body : '';
};
export const excerpt = (text: string, max: number) => [...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text;

export function targetZone(ctx: Context, target: Row): string {
  const zone = target.schedule_tz;
  return validZone(zone) ? zone : workspaceZone(ctx);
}
export const blockerOf = (job: Row | undefined) => (job?.blocker ?? null) as Blocker | null;
export const dataOf = (value: unknown): Data => object(value);
export const routeKindOf = (account: Row, mode: EffectiveMode, device: Row | undefined): RouteKind =>
  hasDriver(account.provider) && mode !== 'owner' && device ? 'machine' : 'owner';
