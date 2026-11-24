import {
  DRIVER_PROVIDERS, HUB_PROVIDERS, MCP_PROVIDER, TERMINAL_JOB_STATUSES, derivePostStatus,
  type Context, type Data, type HubProvider, type PostStatus, type Row, type WorkerJobRecord, type WorkerJobStatus,
} from '@smartsell/contracts';
import { channelEffectiveMode, deviceOnline, localMinute, locate, object, time } from '../../../../../packages/domain/src/publishing/index.js';
import { approvalDeadline, channelLoginState, channelSettingsOrDefault } from '../account/channel-settings.js';
import { bindingFor, sessionFor } from '../account/device-control.js';
import { workspace } from '../workspace/brands.js';
import { approvalRejected } from '../workspace/views/hub-model.js';

/** Shared read helpers of the posting module (phase1-design §7). Every read is defensive: S3/S7 records may be absent. */

export const TARGET = 'publish_target';
const WORKER_JOB = 'worker_job';

export const agentCredential = (ctx: Context) => (ctx as Context & { agentCredentialId?: string }).agentCredentialId;
export const fromAgent = (ctx: Context) => ctx.role === 'agent' || !!agentCredential(ctx);
export const isHubProvider = (provider: unknown): provider is HubProvider => (HUB_PROVIDERS as readonly unknown[]).includes(provider);
export const hasDriver = (provider: unknown) => (DRIVER_PROVIDERS as readonly unknown[]).includes(provider);
export const mcpProvider = (provider: unknown) => isHubProvider(provider) ? MCP_PROVIDER[provider] : String(provider ?? '');

export function workspaceZone(ctx: Context): string {
  const zone = workspace(ctx).default_timezone;
  return typeof zone === 'string' && zone ? zone : 'UTC';
}
export function validZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true; } catch { return false; }
}
/** 'YYYY-MM-DD HH:mm' in `zone`, or null. */
export function localText(at: unknown, zone: string): string | null {
  if (typeof at !== 'string' || !Number.isFinite(time(at))) return null;
  return localMinute(at, zone).replace('T', ' ');
}
export const addMinutes = (at: string, minutes: number) => new Date(time(at) + minutes * 60_000).toISOString();

// ---------- Links (§9.6) ----------

export type LinkKind = 'post' | 'machine' | 'channel' | 'today' | 'calendar';
interface PostingHooks {
  publicOrigin?: string;
  /** S7's webUrl(ctx, kind, id) replaces the fallback routes at integration. */
  webUrl?(ctx: Context, kind: LinkKind, id?: string): string | undefined;
}
let hooks: PostingHooks = {};
export function configurePosting(next: PostingHooks) { hooks = { ...hooks, ...next }; }
export function postingOrigin() {
  return (hooks.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? `http://127.0.0.1:${process.env.PORT ?? 3401}`).replace(/\/+$/, '');
}
/** Monday of the week that holds `at` in `zone` (calendar `week=`). */
export function weekStart(at: string, zone: string): string {
  const day = localMinute(at, zone).slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  const weekday = date.getUTCDay() || 7;
  return new Date(date.getTime() - (weekday - 1) * 86_400_000).toISOString().slice(0, 10);
}
export function webUrl(ctx: Context, kind: LinkKind, id?: string, at?: string | null): string {
  const custom = hooks.webUrl?.(ctx, kind, id);
  if (custom) return custom;
  const base = `${postingOrigin()}/app/${encodeURIComponent(ctx.workspaceId)}`;
  switch (kind) {
    case 'post': return `${base}/posts/${encodeURIComponent(id ?? '')}`;
    case 'machine': return `${base}/machines/${encodeURIComponent(id ?? '')}`;
    case 'channel': return `${base}/channels/${encodeURIComponent(id ?? '')}`;
    case 'calendar': {
      // readCalendarParams reads only view, week, month, kinds, campaign and event (§7.2.6).
      const week = weekStart(at && Number.isFinite(time(at)) ? at : ctx.now, workspaceZone(ctx));
      return `${base}/calendar?view=week&week=${week}${id ? `&event=publish:${encodeURIComponent(id)}` : ''}`;
    }
    default: return base;
  }
}

// ---------- Machines and channels ----------

export const machineName = (device: Row | undefined) => String(device?.display_name ?? device?.name ?? 'machine');

export function channelMachine(ctx: Context, accountId: string) {
  const binding = bindingFor(ctx, accountId);
  const device = binding && typeof binding.device_id === 'string' && binding.connector_channel === 'browser'
    ? locate(ctx, 'connector_device', binding.device_id) : undefined;
  return { binding, device: device && device.status !== 'revoked' ? device : undefined };
}

export function machineRef(ctx: Context, device: Row | undefined) {
  return device ? { machine_id: device.id, name: machineName(device), online: deviceOnline(ctx, device) } : null;
}

/** `sleep_enabled` and similar machine warnings derived from the posture the Worker reported (§3.2). */
export function machineWarnings(device: Row | undefined): { code: string; message: string }[] {
  const posture = object(device?.posture);
  const sleep = Math.max(Number(posture.sleep_idle_min) || 0, Number(posture.power_plan_sleep_min) || 0);
  const warnings: { code: string; message: string }[] = [];
  if (device && sleep > 0) warnings.push({ code: 'sleep_enabled', message: `${machineName(device)} sleeps after ${sleep} min idle.` });
  if (device && posture.auto_login === 'off') warnings.push({ code: 'no_auto_login', message: `${machineName(device)} needs someone to log in after a restart.` });
  return warnings;
}

export function effectiveModeFor(ctx: Context, account: Row) {
  return channelEffectiveMode(account.provider, channelSettingsOrDefault(ctx, account.id));
}

export function loginSummary(ctx: Context, accountId: string) {
  try {
    const login = channelLoginState(ctx, accountId);
    return { state: login.state, checked_at: login.checked_at };
  } catch {
    return { state: 'unknown' as const, checked_at: null };
  }
}

/** When the channel's login was last observed (§5.12); null when never. */
export function loginCheckedAt(ctx: Context, accountId: string): string | null {
  const binding = bindingFor(ctx, accountId);
  const session = binding && binding.connector_channel === 'browser' ? sessionFor(ctx, binding) : undefined;
  const at = session?.checked_at ?? session?.verified_at;
  return typeof at === 'string' && Number.isFinite(time(at)) ? at : null;
}

// ---------- Worker jobs (C1 types, read defensively) ----------

export const isLiveJob = (job: Pick<WorkerJobRecord, 'status'> | undefined) =>
  !!job && !TERMINAL_JOB_STATUSES.includes(job.status as WorkerJobStatus);

export function jobsForTarget(ctx: Context, targetId: string): WorkerJobRecord[] {
  return (ctx.list(WORKER_JOB) as unknown as WorkerJobRecord[]).filter(job => job.publish_target_id === targetId && job.kind === 'publish_post')
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id)));
}
/** The job the target points at, else its newest job. */
export function latestJob(ctx: Context, target: Row): WorkerJobRecord | undefined {
  const pointed = typeof target.worker_job_id === 'string'
    ? (ctx.list(WORKER_JOB) as unknown as WorkerJobRecord[]).find(job => job.id === target.worker_job_id) : undefined;
  return pointed ?? jobsForTarget(ctx, target.id)[0];
}
export function liveCheckLoginJob(ctx: Context, accountId: string): WorkerJobRecord | undefined {
  return (ctx.list(WORKER_JOB) as unknown as WorkerJobRecord[])
    .filter(job => job.kind === 'check_login' && job.social_account_id === accountId && isLiveJob(job))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
}

export function platformPostFor(ctx: Context, targetId: string): Row | undefined {
  return ctx.list('platform_post').find(row => row.publish_target_id === targetId && ['system_verified', 'manual_confirmed'].includes(String(row.verification)));
}

/**
 * The single status derivation (Appendix A derivePostStatus) with this target's inputs — the same inputs as the views'
 * postStatus (workspace/views/hub-model.ts): a rejected latest approval request derives `rejected` for the Agent too (E37).
 */
export function postStatus(ctx: Context, target: Row, job = latestJob(ctx, target)): PostStatus {
  const deadline = target.plan_status === 'awaiting_approval' ? approvalDeadline(ctx, target) : null;
  return derivePostStatus({
    plan_status: String(target.plan_status), precheck_summary: typeof target.precheck_summary === 'string' ? target.precheck_summary : null,
    has_platform_post: !!platformPostFor(ctx, target.id), job_status: job?.status ?? null, job_revoke_reason: job?.revoke?.reason ?? null,
    approval_lapsed: !!deadline && time(deadline) <= time(ctx.now), job_force_released: job?.force_released === true,
    approval_rejected: approvalRejected(ctx, target),
  });
}

export function precheckItems(ctx: Context, target: Row): Row[] {
  const runId = target.last_precheck_run_id;
  return typeof runId === 'string' ? ctx.list('precheck_item').filter(item => item.run_id === runId) : [];
}

export const isData = (value: unknown): value is Data => !!value && typeof value === 'object' && !Array.isArray(value);
/**
 * The code of a Problem-shaped error. Duck-typed on purpose: the domain package imports the contracts by relative path, so its
 * Problem is a different class instance from '@smartsell/contracts' and `instanceof` is false across that boundary.
 */
export function problemCode(error: unknown): string | undefined {
  return isData(error) && typeof error.code === 'string' && typeof error.status === 'number' ? error.code : undefined;
}
export const problemStatus = (error: unknown) => isData(error) && typeof error.status === 'number' ? error.status : 500;
