import { randomUUID } from 'node:crypto';
import {
  AUTOMATION_NOTICE_VERSION, HUB_PROVIDERS, Problem, RISK_ACK_PROVIDERS, TERMINAL_JOB_STATUSES, riskAckCurrent,
  type ApprovalMode, type ChannelReadiness, type ChannelSettingsRecord, type Context, type EffectiveMode, type HubProvider,
  type LoginState, type PlatformDefaults, type RevokeReason, type Row, type WorkerJobRecord, type WorkerJobStatus,
} from '@smartsell/contracts';
import {
  TIKTOK_REQUIRED_OPTIONS, assessTarget, channelEffectiveMode, channelSettingsFor, deviceConnected, hasExecutionRisk, locate, time,
} from '../../../../../packages/domain/src/publishing/index.js';
import { workspace } from '../workspace/brands.js';
import { bindingFor, sessionFor } from './device-control.js';
import { audit } from './input.js';

/** phase1-design §3.3. One row per hub channel, looked up by social_account_id. */
export const CHANNEL_SETTINGS = 'channel_settings';
type Assessment = { overall: string };

// ---------- Worker job engine hooks (C3) ----------

/**
 * The S3 job engine (modules/worker) installs these with setWorkerEngineHooks() when it loads. Until then the defaults never
 * pretend to have done Worker work: they do nothing only where no Worker job exists, and otherwise refuse explicitly.
 */
export interface WorkerEngineHooks {
  revokeForTarget(ctx: Context, target: Row, reason: RevokeReason): void;
  bumpSyncGeneration(ctx: Context, deviceIds: string[], reason: string): number;
  moveQueuedChannelJobs(ctx: Context, socialAccountId: string, newDeviceId: string): { moved: number };
  createCheckLoginJob(ctx: Context, socialAccountId: string, opts: { openLoginWindow: boolean }): WorkerJobRecord;
}
const engineUnavailable = (what: string) => new Problem(503, 'WORKER_ENGINE_UNAVAILABLE', `Worker 工作引擎尚未啟用，無法${what}`);
const liveJobs = (ctx: Context, match: (job: Row) => boolean) =>
  ctx.list('worker_job').filter(job => match(job) && !TERMINAL_JOB_STATUSES.includes(job.status as WorkerJobStatus));
const defaultHooks: WorkerEngineHooks = {
  revokeForTarget(ctx, target) {
    if (liveJobs(ctx, job => job.publish_target_id === target.id).length) throw engineUnavailable('撤回這則貼文的 Worker 工作');
  },
  bumpSyncGeneration: () => 0,
  moveQueuedChannelJobs(ctx, socialAccountId) {
    if (liveJobs(ctx, job => job.social_account_id === socialAccountId).length) throw engineUnavailable('把排程移到新機器');
    return { moved: 0 };
  },
  createCheckLoginJob() { throw engineUnavailable('建立登入檢查'); },
};
let hooks: WorkerEngineHooks = defaultHooks;
/** Installs the job engine. Returns a function that restores the previous hooks (tests). */
export function setWorkerEngineHooks(next: Partial<WorkerEngineHooks>): () => void {
  const previous = hooks;
  hooks = { ...hooks, ...next };
  return () => { hooks = previous; };
}
export const workerEngine = (): WorkerEngineHooks => hooks;

// ---------- Planning hooks ----------

/**
 * planning/index.ts imports this module, so this module must not import planning back: account loads first and the cycle
 * would reach execution and content before they initialize. Planning registers its submit/retire functions when it loads.
 */
export interface PlanningHooks {
  submit(ctx: Context, target: Row): Row;
  retireRequest(ctx: Context, row: Row, reason: string, status?: string): void;
  /** E35: submits again the hub targets a pause or paused machine held before approval (planning resubmitWaiting). */
  resubmitWaiting(ctx: Context, match: (target: Row) => boolean): number;
}
let planning: PlanningHooks | undefined;
export function registerPlanningHooks(next: PlanningHooks) { planning = next; }
function planningHooks(): PlanningHooks {
  if (!planning) throw new Problem(500, 'PLANNING_UNAVAILABLE', 'The planning module is not loaded');
  return planning;
}
/**
 * E35 for a resumed machine: the posts of the channels bound to it that waited for submission. Without the planning module
 * loaded there are no publish targets to move, so this returns 0 instead of failing the resume.
 */
export function resubmitMachineTargets(ctx: Context, deviceId: string): number {
  if (!planning) return 0;
  const accounts = new Set(ctx.list('account_execution_binding').filter(row => row.device_id === deviceId).map(row => row.social_account_id));
  return accounts.size ? planning.resubmitWaiting(ctx, target => accounts.has(target.social_account_id)) : 0;
}

// ---------- Settings records ----------

export const isHubProvider = (provider: unknown): provider is HubProvider => (HUB_PROVIDERS as readonly unknown[]).includes(provider);
export const defaultDailyCap = (provider: unknown) => provider === 'x' ? 10 : 3;
export const newProfileKey = () => `ch-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
export const PROFILE_KEY = /^[a-z0-9-]{8,64}$/;

function workspaceZone(ctx: Context) {
  const zone = workspace(ctx).default_timezone;
  return typeof zone === 'string' && zone ? zone : 'UTC';
}

function defaults(ctx: Context, account: Row, profileKey?: string): Omit<ChannelSettingsRecord, 'id' | 'version' | 'created_at' | 'updated_at'> {
  const platform_defaults: PlatformDefaults = account.provider === 'x' ? { x: { reply_settings: 'everyone' } } : {};
  return {
    social_account_id: account.id, execution_mode: 'browser_auto', approval_mode: 'needs_approval', approval_mode_confirmed_at: null,
    automation_notice_ack: null, risk_ack: null, daily_cap: defaultDailyCap(account.provider), window: null, timezone: workspaceZone(ctx),
    lateness_limit_min: 30, caption_limit: null, chrome_profile_key: profileKey ?? newProfileKey(), platform_defaults,
    settings_generation: 1, approval_generation: 1,
  };
}

/** The stored row, or undefined. Never writes. */
export function channelSettings(ctx: Context, socialAccountId: string): ChannelSettingsRecord | undefined {
  return channelSettingsFor(ctx, socialAccountId);
}

/**
 * The stored row, or the defaults a new row would get, not persisted (id ''). Its version is 1, the version the row has once
 * created, so a page can send If-Match: 1 for its first save. For read-only paths.
 */
export function channelSettingsOrDefault(ctx: Context, socialAccountId: string): ChannelSettingsRecord {
  const stored = channelSettings(ctx, socialAccountId);
  if (stored) return stored;
  const account = ctx.get('social_account', socialAccountId);
  return { id: '', version: 1, created_at: ctx.now, updated_at: ctx.now, ...defaults(ctx, account) };
}

/**
 * Creates the row with defaults the first time (§3.3). Inside a read-only transaction it returns the unsaved defaults instead
 * of failing, so read models may call it; the row is written by the next write path (registration, settings, post_schedule).
 */
export function ensureChannelSettings(ctx: Context, socialAccountId: string, opts: { profileKey?: string } = {}): ChannelSettingsRecord {
  const stored = channelSettings(ctx, socialAccountId);
  if (stored) return stored;
  const account = ctx.get('social_account', socialAccountId);
  if (!isHubProvider(account.provider)) throw new Problem(422, 'CHANNEL_PROVIDER_UNSUPPORTED', `${String(account.provider)} 不是第 1 階段的帳號平台`);
  const values = defaults(ctx, account, opts.profileKey);
  try {
    const row = ctx.create(CHANNEL_SETTINGS, values) as unknown as ChannelSettingsRecord;
    ctx.emit('account.channel_settings.created', { social_account_id: account.id });
    return row;
  } catch (error) {
    if (error instanceof Error && error.message === 'Write in read-only transaction') {
      return { id: '', version: 1, created_at: ctx.now, updated_at: ctx.now, ...values };
    }
    throw error;
  }
}

export function effectiveMode(ctx: Context, socialAccountId: string): EffectiveMode {
  const account = ctx.get('social_account', socialAccountId);
  return channelEffectiveMode(account.provider, channelSettingsOrDefault(ctx, socialAccountId));
}

/** §4.1: the owner pre-authorized this channel to post whatever the Agent schedules, as long as precheck does not block it. */
export function isChannelDirect(ctx: Context, target: Row, assessment: Assessment): { ok: boolean; generation: number } {
  const settings = channelSettings(ctx, String(target.social_account_id));
  if (!settings) return { ok: false, generation: 0 };
  return { ok: settings.approval_mode === 'direct' && assessment.overall !== 'blocked', generation: settings.approval_generation };
}

const providerLabel: Record<string, string> = { x: 'X', tiktok: 'TikTok', youtube: 'YouTube', meta_instagram: 'Instagram', meta_facebook: 'Facebook' };
/** 'X @makemylure', falling back to the display name until the handle is known. */
export function channelLabel(ctx: Context, socialAccountId: string): string {
  const account = ctx.get('social_account', socialAccountId);
  const name = typeof account.handle === 'string' && account.handle ? `@${account.handle}` : String(account.display_name ?? account.external_account_id ?? '');
  return `${providerLabel[String(account.provider)] ?? String(account.provider)} ${name}`.trim();
}

export function tiktokDefaultsReady(defaultsValue: PlatformDefaults | undefined): boolean {
  const tiktok = defaultsValue?.tiktok as Record<string, unknown> | undefined;
  return !!tiktok && TIKTOK_REQUIRED_OPTIONS.every(key => tiktok[key] != null && tiktok[key] !== '');
}

/** §9.4 readiness checklist: the source of channels_list.blockers and the Today channel_setup card. */
export function channelReadiness(ctx: Context, socialAccountId: string): ChannelReadiness {
  const account = ctx.get('social_account', socialAccountId);
  const settings = channelSettingsOrDefault(ctx, socialAccountId);
  const binding = bindingFor(ctx, socialAccountId);
  const session = binding && binding.connector_channel === 'browser' ? sessionFor(ctx, binding) : undefined;
  return {
    logged_in: session?.status === 'verified',
    automation_notice: settings.automation_notice_ack?.version === AUTOMATION_NOTICE_VERSION,
    defaults_ready: account.provider !== 'tiktok' || tiktokDefaultsReady(settings.platform_defaults),
    approval_mode_chosen: !!settings.approval_mode_confirmed_at,
    risk_ack_or_assist: !(RISK_ACK_PROVIDERS as readonly unknown[]).includes(account.provider) || settings.execution_mode === 'browser_assist' || riskAckCurrent(settings.risk_ack),
    dry_run_passed: ctx.list('worker_job').some(job => job.social_account_id === socialAccountId && job.dry_run === true && job.status === 'succeeded'),
  };
}

/**
 * §3.3 LoginState: offline machine → unknown; an open check_login job → checking; otherwise the browser session status. A
 * paused machine that still heartbeats is not offline: its last observed login stands (U3).
 */
export function channelLoginState(ctx: Context, socialAccountId: string): { state: LoginState; checked_at: string | null; session_id: string | null } {
  const binding = bindingFor(ctx, socialAccountId);
  const session = binding && binding.connector_channel === 'browser' ? sessionFor(ctx, binding) : undefined;
  const checked_at = typeof session?.checked_at === 'string' ? session.checked_at : typeof session?.verified_at === 'string' ? session.verified_at : null;
  const result = (state: LoginState) => ({ state, checked_at, session_id: session?.id ?? null });
  const device = binding && typeof binding.device_id === 'string' ? locate(ctx, 'connector_device', binding.device_id) : undefined;
  if (!deviceConnected(ctx, device)) return result('unknown');
  if (liveJobs(ctx, job => job.kind === 'check_login' && job.social_account_id === socialAccountId).length) return result('checking');
  const status = String(session?.status ?? '');
  return result(['verified', 'login_required', 'identity_mismatch', 'challenge'].includes(status) ? status as LoginState : 'unknown');
}

/** The devices whose heartbeat carries this channel (§5.4.1 sync_generation). */
export function channelDevices(ctx: Context, socialAccountId: string): string[] {
  const deviceId = bindingFor(ctx, socialAccountId)?.device_id;
  return typeof deviceId === 'string' ? [deviceId] : [];
}

/**
 * E42: when the workspace time zone changes, every hub channel that still used the old workspace zone follows it; a channel
 * the owner set to another zone keeps it. Same rules as a settings save: settings_generation and the machine's sync generation
 * move, the change is audited, and account.channel_settings.changed lets posting.unblock resubmit posts that the old zone's
 * window or daily cap had blocked. Runs in the workspace_update transaction. Returns how many channels moved.
 */
export function followWorkspaceZone(ctx: Context, from: string, to: string): number {
  if (!from || !to || from === to) return 0;
  let moved = 0;
  for (const row of ctx.list(CHANNEL_SETTINGS) as unknown as ChannelSettingsRecord[]) {
    if (row.timezone !== from || !isHubProvider(locate(ctx, 'social_account', row.social_account_id)?.provider)) continue;
    const updated = ctx.update(CHANNEL_SETTINGS, row.id, { timezone: to, settings_generation: row.settings_generation + 1 }) as unknown as ChannelSettingsRecord;
    workerEngine().bumpSyncGeneration(ctx, channelDevices(ctx, row.social_account_id), 'channel_settings');
    audit(ctx, 'account.channel_settings.updated', { social_account_id: row.social_account_id, fields: ['timezone'], settings_generation: updated.settings_generation, via: 'workspace_timezone' });
    ctx.emit('account.channel_settings.changed', { social_account_id: row.social_account_id, generation: updated.settings_generation, approval_mode_changed: false, fields: ['timezone'] });
    moved++;
  }
  return moved;
}

/** approval_deadline = scheduled_at + lateness_limit_min (§4.2); null for a channel without settings or a time. */
export function approvalDeadline(ctx: Context, target: Row): string | null {
  const settings = channelSettings(ctx, String(target.social_account_id));
  if (!settings || typeof target.scheduled_at !== 'string' || !Number.isFinite(time(target.scheduled_at))) return null;
  return new Date(time(target.scheduled_at) + settings.lateness_limit_min * 60_000).toISOString();
}

/**
 * §4.1 table, run inside the settings transaction (never through a subscriber, so no target is left without a pending
 * request in between). Returns how many targets were resubmitted and how many channel-policy approvals were withdrawn.
 */
export function applyApprovalModeChange(ctx: Context, socialAccountId: string, from: ApprovalMode, to: ApprovalMode): { resubmitted: number; revoked: number } {
  const { submit, retireRequest } = planningHooks();
  let resubmitted = 0;
  let revoked = 0;
  if (from === to) return { resubmitted, revoked };
  const targets = ctx.list('publish_target').filter(row => row.social_account_id === socialAccountId);
  if (to === 'direct') {
    for (const row of targets) {
      const target = ctx.get('publish_target', row.id);
      if (target.plan_status !== 'awaiting_approval' || hasExecutionRisk(ctx, target)) continue;
      // Past its deadline the post cannot go out any more (derived as missed/not_approved); "改到…" resubmits it.
      const deadline = approvalDeadline(ctx, target);
      if (deadline && time(deadline) <= time(ctx.now)) continue;
      // submit() returns early on an equal pending request, so retire it first. Keep it when precheck would block anyway.
      const request = locate(ctx, 'approval_request', target.approval_request_id);
      if (request?.status === 'pending') {
        if (assessTarget(ctx, target, 'schedule').overall === 'blocked') continue;
        retireRequest(ctx, target, 'channel_approval_mode_changed');
      }
      submit(ctx, ctx.get('publish_target', target.id));
      resubmitted++;
    }
    return { resubmitted, revoked };
  }
  for (const row of targets) {
    const target = ctx.get('publish_target', row.id);
    if (!['ready', 'paused'].includes(String(target.plan_status))) continue;
    const request = locate(ctx, 'approval_request', target.approval_request_id);
    if (request?.approved_via !== 'channel_policy' || request.status !== 'approved') continue;
    // Invalidation runs blockUnsent, which asks the job engine to revoke the live job (approval_invalidated).
    retireRequest(ctx, target, 'channel_approval_mode_changed');
    revoked++;
    // A job that already started follows §5.10; the target cannot be resubmitted until it is resolved.
    if (hasExecutionRisk(ctx, target)) continue;
    const waiting = ctx.update('publish_target', target.id, {
      plan_status: 'awaiting_approval', frozen_hash: null, paused_by_switch_id: null, precheck_summary: 'stale',
      approval_invalidated_reason: 'channel_approval_mode_changed',
    });
    // E23: retireRequest ran while the target was still ready, which keeps a matching unstarted job (the go check would deny
    // it). Now that the post waits for approval, withdraw that job in the same transaction so every view shows 「待你核准」.
    workerEngine().revokeForTarget(ctx, waiting, 'approval_invalidated');
    submit(ctx, waiting);
    resubmitted++;
  }
  return { resubmitted, revoked };
}
