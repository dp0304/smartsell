import { createHash } from 'node:crypto';
import { Problem, type Context, type Data, type Row } from '../../../contracts/src/module.js';
import {
  AUTOMATION_NOTICE_VERSION, DRIVER_PROVIDERS, RISK_ACK_PROVIDERS, riskAckCurrent, xWeightedLength,
  type ChannelSettingsRecord, type EffectiveMode, type HubProvider, type Presence, type PublishWindow,
} from '../../../contracts/src/phase1.js';
import { inWindows, localMinute, resolveLocal } from './time.js';
export { inWindows, instant, localMinute, resolveLocal } from './time.js';

export const object = (value: unknown): Data => value && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
export const entries = (value: unknown): Data[] => Array.isArray(value) ? value.map(object) : [];
export const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
export const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
export function locate(ctx: Context, kind: string, id: unknown): Row | undefined {
  return typeof id === 'string' ? ctx.list(kind).find(row => row.id === id) : undefined;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function platformKey(platform: unknown) {
  return typeof platform === 'string' ? platform.replace(/^meta_/, '') : '';
}

export function checkAssetRights(ctx: Context, assetId: string, options: {
  platform: string; market?: string; usage: string; at: string; asset_version_id?: string; modified?: boolean; attribution?: string;
}) {
  const at = time(options.at);
  const market = String(locate(ctx, 'market', options.market)?.country_code ?? options.market ?? '').toUpperCase();
  const asset = locate(ctx, 'asset', assetId);
  if (!asset || asset.status === 'archived') return { allowed: false, code: 'asset_unavailable' };
  for (const binding of ctx.list('rights_grant_asset').filter(row => row.asset_id === assetId)) {
    if (binding.version_scope !== 'all_versions' && (binding.version_scope !== 'specific_version' || binding.asset_version_id !== (options.asset_version_id ?? asset.current_version_id))) continue;
    const grant = locate(ctx, 'rights_grant', binding.rights_grant_id);
    const terms = locate(ctx, 'rights_grant_revision', grant?.active_revision_id ?? grant?.current_revision_id);
    if (!grant || grant.brand_id !== asset.brand_id || !terms || terms.rights_grant_id !== grant.id || !['active', 'expiring'].includes(String(grant.status)) || grant.revoked_at) continue;
    if (!(at >= time(terms.valid_from)) || (terms.valid_until != null && !(at < time(terms.valid_until)))) continue;
    if (!list(terms.usages).includes(options.usage === 'organic' ? 'organic_social' : options.usage)) continue;
    if (terms.platforms != null && !list(terms.platforms).some(platform => platformKey(platform) === platformKey(options.platform))) continue;
    if (terms.regions != null && !list(terms.regions).some(region => typeof region === 'string' && region.toUpperCase() === market)) continue;
    if (options.modified && terms.allow_modification !== true) continue;
    if (terms.attribution_required && (typeof terms.attribution_text !== 'string' || !options.attribution?.includes(terms.attribution_text))) continue;
    return { allowed: true, code: 'covered', rights_grant_id: grant.id, rights_grant_revision_id: terms.id, valid_until: terms.valid_until, restrictions: terms.restrictions };
  }
  return { allowed: false, code: 'rights_not_covered' };
}

export function activePause(ctx: Context, target: Data) {
  const scopes: Data = { workspace: ctx.workspaceId, brand: target.brand_id, campaign: target.campaign_id, social_account: target.social_account_id };
  return ctx.list('pause_switch').find(row => !row.released_at && typeof row.scope_id === 'string' && row.scope_id === scopes[String(row.scope_type)]);
}

export function closeTarget(ctx: Context, target: Row, reason: string) {
  const current = ctx.get('publish_target', target.id);
  if (current.plan_status === 'closed') return current;
  const row = ctx.update('publish_target', target.id, { plan_status: 'closed', close_reason: reason });
  ctx.emit('planning.target.closed', { target_id: target.id, close_reason: reason });
  return row;
}

const publishOperations = new Set(['publish', 'publish_story', 'publish_short', 'publish_schedule']);

export function taskFor(ctx: Context, target: Data) {
  const belongs = (row: Row) => row.publish_target_id === target.id && (!row.operation || publishOperations.has(String(row.operation)));
  const linked = locate(ctx, 'execution_task', target.execution_task_id);
  if (linked && belongs(linked)) return linked;
  return ctx.list('execution_task').find(belongs);
}

export function hasExecutionRisk(ctx: Context, target: Data) {
  const task = taskFor(ctx, target);
  if (!task) return false;
  return !!task.active_attempt_id || list(task.pending_side_effects).length > 0 ||
    !['scheduled', 'queued', 'blocked'].includes(String(task.status)) ||
    ctx.list('execution_attempt').some(attempt => (attempt.execution_task_id ?? attempt.task_id) === task.id &&
      ['claimed', 'in_progress', 'accepted', 'outcome_unknown', 'unknown'].includes(String(attempt.status)));
}

export function invalidateTargets(ctx: Context, predicate: (target: Row) => boolean, reason: string) {
  for (const target of ctx.list('publish_target').filter(predicate)) {
    if (!['draft', 'ready', 'paused', 'awaiting_approval', 'changes_requested'].includes(String(target.plan_status))) continue;
    const request = locate(ctx, 'approval_request', target.approval_request_id);
    if (request && request.resource_type === 'planning.publish_target' && request.resource_id === target.id && ['approved', 'pending'].includes(String(request.status))) {
      ctx.update('approval_request', request.id, { status: 'invalidated', invalidated_reason: reason });
      ctx.emit('core.approval_request.invalidated', { request_id: request.id, resource_id: target.id, reason });
    }
    // E37: draft and changes_requested stay as they are. A post the owner rejected (or sent back for changes) must not turn into
    // one waiting for approval with no request, which an approval-mode switch or the §4 rule would then resubmit on its own.
    ctx.update('publish_target', target.id, {
      precheck_summary: 'stale', approval_invalidated_reason: reason,
      ...(!['draft', 'changes_requested'].includes(String(target.plan_status)) && !hasExecutionRisk(ctx, target) ? { plan_status: 'awaiting_approval', frozen_hash: null } : {}),
    });
    ctx.emit('planning.target.approval_invalidated', { target_id: target.id, reason });
  }
}

export function onRevisionCreated(ctx: Context, variant: Row, revision: Row) {
  for (const target of ctx.list('publish_target').filter(row => row.content_variant_id === variant.id && row.plan_status === 'draft' && row.follow_latest_revision !== false)) {
    ctx.update('publish_target', target.id, { variant_revision_id: revision.id, precheck_summary: 'stale' });
  }
  invalidateTargets(ctx, target => target.content_variant_id === variant.id && target.plan_status !== 'draft' && locate(ctx, 'content_revision', target.variant_revision_id)?.content_hash !== revision.content_hash, 'content_revision_changed');
}

export type Stage = 'schedule' | 'approval' | 'preflight' | 'execution';
export type Check = { check_key: string; severity: 'blocker' | 'risk' | 'info'; result: 'pass' | 'fail' | 'warn' | 'unknown'; message: string; detail: Data; fix_action?: Data };

function withinGrant(ctx: Context, grant: Row, target: Data, actor: unknown, actorType: unknown) {
  const now = time(ctx.now);
  if (typeof actor !== 'string' || grant.grantee_id !== actor || grant.grantee_type !== actorType || grant.revoked_at || (grant.status != null && grant.status !== 'active') || !list(grant.actions).includes('planning.target.approve') || !(now >= time(grant.valid_from)) || (grant.valid_until != null && !(now < time(grant.valid_until)))) return false;
  const membership = (ctx as Context & { isActiveWorkspaceMember?(id: string): boolean }).isActiveWorkspaceMember;
  if (actorType === 'user' && membership && !membership(actor)) return false;
  const scope = object(grant.resource_scope);
  const dimensions: Data = { brand_ids: target.brand_id, social_account_ids: target.social_account_id, campaign_ids: target.campaign_id, content_types: target.content_format };
  if (Object.entries(scope).some(([key, values]) => !(key in dimensions) || !list(values).includes(dimensions[key]))) return false;
  const constraints = object(grant.constraints);
  if (Object.keys(constraints).some(key => !['max_per_day', 'time_window', 'require_precheck'].includes(key))) return false;
  const zone = String(target.schedule_tz ?? 'UTC');
  const at = String(target.scheduled_at ?? ctx.now);
  if (constraints.time_window != null && !inWindows(constraints.time_window, at, zone)) return false;
  if (constraints.max_per_day != null) {
    const cap = constraints.max_per_day;
    if (!Number.isInteger(cap) || Number(cap) < 1) return false;
    const day = localMinute(at, zone).slice(0, 10);
    const count = ctx.list('approval_request').filter(req => {
      if (req.standing_grant_id !== grant.id || req.resource_id === target.id || req.status !== 'approved') return false;
      const other = locate(ctx, 'publish_target', req.resource_id);
      return other && localMinute(String(other.scheduled_at ?? req.created_at), zone).slice(0, 10) === day;
    }).length;
    if (count >= Number(cap)) return false;
  }
  return true;
}

export function findStandingGrant(ctx: Context, target: Data, overall: string) {
  return ctx.list('standing_grant').find(grant => withinGrant(ctx, grant, target, ctx.actorId, ctx.role === 'agent' ? 'agent_client' : 'user') && (object(grant.constraints).require_precheck !== 'pass' || overall === 'pass'));
}

export function approvalValid(ctx: Context, target: Data, hash: string) {
  const request = locate(ctx, 'approval_request', target.approval_request_id);
  if (target.frozen_hash !== hash || !request || request.resource_type !== 'planning.publish_target' || request.resource_id !== target.id || request.resource_hash !== hash || request.status !== 'approved') return false;
  if (request.approved_via === 'channel_policy') {
    // A channel-policy approval stands only while the owner keeps the channel on "direct" at the same approval generation (§4.1).
    const settings = channelSettingsFor(ctx, target.social_account_id);
    if (!settings || settings.approval_mode !== 'direct' || settings.approval_generation !== request.channel_approval_generation) return false;
  }
  if (request.policy_id) {
    const policy = locate(ctx, 'approval_policy', request.policy_id);
    if (!policy || policy.version !== request.policy_version || policy.active === false) return false;
  }
  if (request.standing_grant_id) {
    const grant = locate(ctx, 'standing_grant', request.standing_grant_id);
    const context = object(request.context);
    return !!grant && withinGrant(ctx, grant, target, context.submitted_by, context.submitted_by_type);
  }
  return true;
}

// ---------- Phase 1 channels (phase1-design §3.3, §4.4) ----------

/** The account's channel settings row. Looked up by social_account_id: store rows get their own generated id. */
export function channelSettingsFor(ctx: Context, accountId: unknown): ChannelSettingsRecord | undefined {
  if (typeof accountId !== 'string') return undefined;
  return ctx.list('channel_settings').find(row => row.social_account_id === accountId) as ChannelSettingsRecord | undefined;
}

/** §3.3 effectiveMode truth table. Pure so the hub, precheck and Worker views agree. */
export function channelEffectiveMode(provider: unknown, settings: Pick<ChannelSettingsRecord, 'execution_mode' | 'risk_ack'>): EffectiveMode {
  if (settings.execution_mode === 'api') return 'owner';
  if (!(DRIVER_PROVIDERS as readonly unknown[]).includes(provider)) return 'owner';
  if (settings.execution_mode === 'browser_assist') return 'assist';
  if ((RISK_ACK_PROVIDERS as readonly unknown[]).includes(provider) && !riskAckCurrent(settings.risk_ack ?? null)) return 'assist';
  return 'auto';
}

type PresenceContext = Context & { presence?: (deviceId: string) => Presence | undefined };
/** §3.2 online rule. Reads the in-memory presence injected by the hub (C14) and falls back to the stored row. */
export function deviceOnline(ctx: Context, device: Row | undefined): boolean {
  if (!device || device.paused === true || device.status !== 'active') return false;
  let presence: Presence | undefined;
  try { presence = (ctx as PresenceContext).presence?.(device.id); } catch { presence = undefined; }
  const seen = time(presence?.last_seen_at ?? device.last_seen_at);
  return Number.isFinite(seen) && time(ctx.now) - seen < 90_000;
}

/** PublishWindow is evaluated in the channel time zone; an end before the start crosses midnight. */
export function inPublishWindow(window: PublishWindow | null | undefined, at: string, zone: string): boolean {
  if (!window) return true;
  return inWindows([{ start: window.start, end: window.end, dow: window.days }], at, zone);
}

/** Posts that count toward daily_cap on the local day of `at`: ready (scheduled or running) or published, excluding one target. */
export function channelDayUsage(ctx: Context, accountId: string, at: string, zone: string, excludeTargetId?: string): number {
  const day = localMinute(at, zone).slice(0, 10);
  const published = new Map<string, Row>();
  for (const post of ctx.list('platform_post')) {
    if (post.social_account_id === accountId && typeof post.publish_target_id === 'string' && ['system_verified', 'manual_confirmed'].includes(String(post.verification))) {
      published.set(post.publish_target_id, post);
    }
  }
  let count = 0;
  for (const row of ctx.list('publish_target')) {
    if (row.id === excludeTargetId || row.social_account_id !== accountId) continue;
    const post = published.get(row.id);
    const done = !!post || row.plan_status === 'closed' && ['published', 'matched_native', 'manual_done'].includes(String(row.close_reason));
    if (!done && row.plan_status !== 'ready') continue;
    const when = done ? post?.published_at ?? row.scheduled_at : row.scheduled_at;
    if (typeof when === 'string' && Number.isFinite(time(when)) && localMinute(when, zone).slice(0, 10) === day) count++;
  }
  return count;
}

/** §4.4 media_kind and §7.2.6 MEDIA_NOT_SUPPORTED. Returns the reason or null when the media fit the platform. */
export function channelMediaRule(provider: unknown, kinds: readonly ('video' | 'image' | 'other')[]): string | null {
  const videos = kinds.filter(kind => kind === 'video').length;
  const images = kinds.filter(kind => kind === 'image').length;
  if (provider === 'x') {
    return videos === 1 && kinds.length === 1 || videos === 0 && images >= 1 && images <= 4 && images === kinds.length ? null
      : 'X takes 1 video or 1–4 images; mixing is not allowed.';
  }
  if (provider === 'tiktok') return videos === 1 && kinds.length === 1 ? null : 'TikTok takes exactly 1 video.';
  return null;
}

/**
 * E44: the video limits of the upload page each phase-1 driver uses, taken from the platforms' own help pages (sources and
 * the date they were read are in docs/restructure/requests/G2-posting.md):
 * - X web upload (help.x.com "How to share and watch videos on X"): without Premium up to 140 s and 512 MB; with Premium
 *   (E7: caption_limit 25,000) shorter than 4 h and 16 GB.
 * - TikTok Studio web upload (support.tiktok.com "Creator tools on TikTok"): up to 30 minutes and less than 10 GB.
 * Sizes are read in binary units and durations get 1 s for container rounding, so only a file certainly over a limit blocks.
 * Rules the pages state less firmly (X aspect ratio, resolution, frame rate; TikTok format and resolution) are not blockers.
 */
export interface ChannelVideoLimits { provider: 'x' | 'tiktok'; tier: 'standard' | 'premium' | 'web'; max_duration_ms: number; max_bytes: number; duration_label: string; size_label: string }
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
export function channelVideoLimits(provider: unknown, settings: Pick<ChannelSettingsRecord, 'caption_limit'>): ChannelVideoLimits | null {
  if (provider === 'x') {
    return settings.caption_limit === 25_000
      ? { provider, tier: 'premium', max_duration_ms: 4 * 3_600_000, max_bytes: 16 * GIB, duration_label: '4 小時', size_label: '16 GB' }
      : { provider, tier: 'standard', max_duration_ms: 141_000, max_bytes: 512 * MIB, duration_label: '2 分 20 秒', size_label: '512 MB' };
  }
  if (provider === 'tiktok') return { provider, tier: 'web', max_duration_ms: 30 * 60_000 + 1_000, max_bytes: 10 * GIB, duration_label: '30 分鐘', size_label: '10 GB' };
  return null;
}
const clock = (ms: number) => {
  const total = Math.round(ms / 1000);
  const [h, m, s] = [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60];
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};
const bytesText = (bytes: number) => bytes >= GIB ? `${(bytes / GIB).toFixed(1)} GB` : `${Math.ceil(bytes / MIB)} MB`;
/** E44/E3 checks for one primary video of a channel post. Returns the media_spec check to add, if any. */
export function channelVideoCheck(provider: unknown, settings: Pick<ChannelSettingsRecord, 'caption_limit'>, input: { duration_ms: unknown; bytes: unknown; width: unknown; height: unknown }):
{ severity: 'blocker' | 'risk'; message: string; detail: Data } | null {
  const limits = channelVideoLimits(provider, settings);
  if (!limits) return null;
  const name = limits.provider === 'x' ? (limits.tier === 'premium' ? 'X Premium' : 'X 非 Premium 帳號') : 'TikTok 網頁上傳';
  const premiumHint = limits.provider === 'x' && limits.tier === 'standard' ? '；若這個帳號有 X Premium，請在帳號頁把文案上限設為 25,000' : '';
  const duration = typeof input.duration_ms === 'number' && Number.isFinite(input.duration_ms) ? input.duration_ms : null;
  const bytes = typeof input.bytes === 'number' && Number.isFinite(input.bytes) && input.bytes > 0 ? input.bytes : null;
  const detail = { limit: limits.tier, max_duration_ms: limits.max_duration_ms, max_bytes: limits.max_bytes, duration_ms: duration, bytes };
  if (duration !== null && duration > limits.max_duration_ms) {
    return { severity: 'blocker', message: `影片長 ${clock(duration)}，超過 ${name}的 ${limits.duration_label}上限，這則發不出去。請剪短後重新上傳${premiumHint}。`, detail: { ...detail, exceeded: 'duration' } };
  }
  if (bytes !== null && bytes > limits.max_bytes) {
    return { severity: 'blocker', message: `影片檔 ${bytesText(bytes)}，超過 ${name}的 ${limits.size_label} 上限，這則發不出去。請壓縮後重新上傳${premiumHint}。`, detail: { ...detail, exceeded: 'size' } };
  }
  // E3: ffprobe could not read the file (or the hub has none), so the duration limit cannot be checked before posting time.
  if (duration === null) return { severity: 'risk', message: '未取得影片長度與尺寸，無法在排程時檢查平台的影片限制', detail: { ...detail, exceeded: null } };
  const ratio = Number(input.width) / Number(input.height);
  if (limits.provider === 'x' && Number.isFinite(ratio) && ratio > 0 && (ratio > 2.39 || ratio < 1 / 2.39)) {
    return { severity: 'risk', message: `影片比例 ${String(input.width)}×${String(input.height)} 不在 X 網頁上傳說明的 1:2.39 到 2.39:1 之間，可能被 X 拒絕`, detail: { ...detail, exceeded: 'aspect_ratio' } };
  }
  return null;
}

/** The TikTok defaults that a person must pick before the Worker may prepare a post (§3.3, §4.4). */
export const TIKTOK_REQUIRED_OPTIONS = ['privacy_level', 'allow_comment', 'allow_duet', 'allow_stitch', 'commercial_disclosure'] as const;

/** §3.8: an owned or brandless asset is usable by any brand in the workspace and its rights are covered. */
export const ownedAsset = (asset: Row | undefined) => !!asset && (asset.brand_id === null || asset.ownership === 'owned');

function mediaKind(asset: Row | undefined, version: Row | undefined): 'video' | 'image' | 'other' {
  if (asset?.kind === 'video' || asset?.kind === 'image') return asset.kind;
  const mime = String(version?.mime_type ?? '');
  return mime.startsWith('video/') ? 'video' : mime.startsWith('image/') ? 'image' : 'other';
}

export function evergreenExpiry(ctx: Context, target: Data): number {
  if (target.origin !== 'evergreen') return Infinity;
  const queue = locate(ctx, 'evergreen_queue', target.evergreen_queue_id);
  const entry = locate(ctx, 'evergreen_queue_item', target.evergreen_queue_item_id);
  return Math.min(...[queue?.expires_at, entry?.expires_at].map(value => value == null ? Infinity : time(value)));
}

type AddCheck = (check_key: string, severity: Check['severity'], message: string, detail?: Data, route?: string) => void;

/** §4.4 Worker-route checks for an account with channel_settings. Replaces capability, connector and session checks. */
function channelChecks(ctx: Context, add: AddCheck, input: {
  account: Row; settings: ChannelSettingsRecord; binding: Row | undefined; target: Data; stage: Stage; at: string; revision: Row | undefined; platform: string;
}): { route: string; effectiveMode: EffectiveMode } {
  const { account, settings, binding, target, stage, at, revision } = input;
  const provider = String(account.provider) as HubProvider;
  const page = `/channels/${account.id}`;
  const mode = channelEffectiveMode(provider, settings);
  if (mode === 'owner') {
    if (!(DRIVER_PROVIDERS as readonly string[]).includes(provider)) {
      add('driver_unavailable', 'risk', '此平台第 3 階段才支援自動發布，到時間會提醒你手動發', { route: 'manual', provider }, page);
    } else {
      add('driver_unavailable', 'risk', '第 1 階段沒有官方 API 發布路徑，到時間會提醒你手動發', { route: 'manual', execution_mode: settings.execution_mode }, page);
    }
    add('automation_mode', 'info', '到時間請你手動發布', { effective_mode: mode });
    return { route: 'manual', effectiveMode: mode };
  }
  const notice = settings.automation_notice_ack;
  if (!notice || notice.version !== AUTOMATION_NOTICE_VERSION) add('automation_notice', 'blocker', '這個帳號尚未確認自動化告知', { version: AUTOMATION_NOTICE_VERSION }, page);
  const device = binding && typeof binding.device_id === 'string' ? locate(ctx, 'connector_device', binding.device_id) : undefined;
  const machine = String(device?.display_name ?? device?.name ?? '');
  if (!binding || !['connector', 'hybrid'].includes(String(binding.mode)) || binding.connector_channel !== 'browser' || !device || device.status !== 'active') {
    add('machine_binding', 'blocker', '這個帳號沒有綁定可用的機器', { device_id: binding?.device_id ?? null, device_status: device?.status ?? null }, page);
  } else {
    if (device.paused === true) add('machine_paused', 'blocker', `${machine} 已暫停，這則不會發出，直到你恢復機器。`, { device_id: device.id }, `/machines/${device.id}`);
    if ((stage === 'schedule' || stage === 'approval') && !deviceOnline(ctx, device)) add('machine_online', 'risk', `${machine} 目前離線`, { device_id: device.id }, `/machines/${device.id}`);
    const session = ctx.list('browser_session').find(row => row.binding_id === binding.id && row.status !== 'revoked');
    if (session && ['login_required', 'identity_mismatch', 'challenge'].includes(String(session.status))) {
      add('login_state', 'risk', `${machine} 上的帳號需要重新登入或驗證`, { status: session.status, session_id: session.id }, page);
    }
  }
  add('automation_mode', 'info', mode === 'assist' ? `到點會停在發布前，請到 ${machine || '綁定的機器'} 按發布` : '到點由 Worker 代按發布', { effective_mode: mode });
  if (provider === 'tiktok') {
    const options = object(object(object(revision?.settings).platform_options).tiktok);
    const missing = TIKTOK_REQUIRED_OPTIONS.filter(key => options[key] == null || options[key] === '');
    if (revision && missing.length) add('channel_defaults', 'blocker', '請先在帳號頁設定 TikTok 的預設選項', { missing }, page);
  }
  const zone = settings.timezone;
  if (typeof target.scheduled_at === 'string') {
    const used = channelDayUsage(ctx, account.id, at, zone, typeof target.id === 'string' ? target.id : undefined);
    if (used >= settings.daily_cap) add('daily_cap', 'blocker', `這個帳號當天已排滿 ${settings.daily_cap} 則`, { used, daily_cap: settings.daily_cap, timezone: zone }, page);
    if (!inPublishWindow(settings.window, at, zone)) add('publish_window', 'blocker', '預定時間不在這個帳號的發布時段內', { window: settings.window, timezone: zone }, page);
  }
  return { route: 'worker', effectiveMode: mode };
}

export function assessTarget(ctx: Context, target: Data, stage: Stage, drainingClaim = false) {
  const checks = new Map<string, Check>();
  const add = (check_key: string, severity: Check['severity'], message: string, detail: Data = {}, route?: string) => {
    const rank = { blocker: 2, risk: 1, info: 0 };
    const previous = checks.get(check_key);
    if (previous && rank[previous.severity] > rank[severity]) return;
    checks.set(check_key, { check_key, severity, result: severity === 'blocker' ? 'fail' : severity === 'risk' ? 'warn' : 'pass', message, detail, ...(route ? { fix_action: { label: 'Review', route } } : {}) });
  };
  const account = locate(ctx, 'social_account', target.social_account_id);
  const variant = locate(ctx, 'content_variant', target.content_variant_id);
  const revision = locate(ctx, 'content_revision', target.variant_revision_id);
  const item = locate(ctx, 'content_item', target.content_item_id);
  const platform = platformKey(account?.platform ?? account?.provider);
  const market = locate(ctx, 'market', variant?.market_id ?? account?.market_id);
  const zone = String(account?.default_timezone ?? target.schedule_tz ?? 'UTC');
  const manualAt = target.schedule_kind === 'manual_date' && typeof target.local_scheduled_at === 'string' ? resolveLocal(`${target.local_scheduled_at}T12:00`, String(target.schedule_tz ?? zone), 'shift_forward').scheduled_at : ctx.now;
  const scheduledAt = String(target.scheduled_at ?? manualAt);
  const at = stage === 'execution' || stage === 'preflight' ? new Date(Math.max(time(ctx.now), time(scheduledAt))).toISOString() : scheduledAt;
  const lateStage = stage === 'execution' || stage === 'preflight';
  let validUntil = time(ctx.now) + 30 * 60_000;
  const freshness = (end: unknown) => { if (time(end) > time(ctx.now)) validUntil = Math.min(validUntil, time(end)); };
  const reuseExpiry = evergreenExpiry(ctx, target);
  if (Math.max(time(at), time(ctx.now)) >= reuseExpiry) add('evergreen_expired', 'blocker', 'The evergreen reuse window has expired');
  else validUntil = Math.min(validUntil, reuseExpiry);
  // A channel with settings takes the Worker rules end to end (§4.4); the connector and API checks below do not apply.
  const settings = account ? channelSettingsFor(ctx, account.id) : undefined;
  if (!account || account.archived_at || (account.status != null && account.status !== 'active')) add(settings ? 'account_status' : 'account_connection', 'blocker', 'Publishing account is unavailable', {}, '/accounts');
  if (!variant || !revision || typeof revision.content_hash !== 'string' || !revision.content_hash || revision.variant_id !== variant.id || variant.content_item_id !== target.content_item_id || (variant.platform !== 'generic' && platformKey(variant.platform) !== platform) || (variant.social_account_id && variant.social_account_id !== account?.id)) {
    add('content_binding', 'blocker', 'The revision does not belong to the requested account and variant', {}, '/content');
  } else if (item?.archived_at || item?.production_stage === 'archived' || (item?.brand_id && item.brand_id !== target.brand_id) || (account?.brand_id && account.brand_id !== target.brand_id) || variant.archived_at || (revision.id !== variant.current_revision_id && locate(ctx, 'content_revision', variant.current_revision_id)?.content_hash !== revision.content_hash) || variant.readiness === 'stale') {
    add('content_binding', 'blocker', 'A current, reviewed variant revision is required', {}, '/content');
  }

  let route: string;
  let capability: Row | undefined;
  let effectiveMode: string | undefined;
  const binding = account && ctx.list('account_execution_binding').find(row => row.social_account_id === account.id);
  if (settings && account) {
    ({ route, effectiveMode } = channelChecks(ctx, add, { account, settings, binding, target, stage, at, revision, platform }));
  } else {
  const capabilities = account ? ctx.list('capability').filter(row => row.social_account_id === account.id && row.operation === (target.operation ?? 'publish')) : [];
  const exact = capabilities.filter(row => row.content_format === target.content_format);
  const matching = exact.length ? exact : capabilities.filter(row => row.content_format === '*');
  const supports = (row: Row, route: string) => row.executor === route || list(row.executors).includes(route);
  const apiChoices = binding?.mode !== 'connector' && binding?.mode !== 'manual' ? matching.filter(row => row.status === 'available' && supports(row, 'api')) : [];
  const connector = binding && ['connector', 'hybrid'].includes(String(binding.mode)) ? matching.find(row => row.status === 'available' && supports(row, 'connector') && (!row.connector_channel || row.connector_channel === binding.connector_channel)) : undefined;
  const manual = matching.find(row => row.status === 'manual_only' || row.status === 'available' && supports(row, 'manual'));
  const accountLinks = ctx.list('social_account_connection');
  function authorizedConnection(cap: Row): Row | undefined {
    const connection = locate(ctx, 'connection', cap.connection_id);
    if (!connection || connection.status !== 'active' || connection.revoked_at || (connection.expires_at != null && !(time(connection.expires_at) > time(ctx.now)))) return;
    if (connection.brand_id && connection.brand_id !== account?.brand_id || connection.provider && platformKey(connection.provider) !== platform || connection.purpose && connection.purpose !== 'social') return;
    const links = accountLinks.filter(link => link.social_account_id === account?.id || link.connection_id === connection.id);
    if (links.length && !links.some(link => link.social_account_id === account?.id && link.connection_id === connection.id && (link.status == null || link.status === 'active') && !link.revoked_at)) return;
    return connection;
  }
  const api = apiChoices.find(cap => authorizedConnection(cap)) ?? apiChoices[0];
  const connection = api && authorizedConnection(api);
  const connected = !!connection;
  route = api && (connected || !connector) ? 'api' : connector ? 'connector' : 'manual';
  capability = (route === 'api' ? api : route === 'connector' ? connector : manual) ?? matching[0];
  if (!capability || matching.every(row => row.status === 'unverified')) add('capability', 'risk', 'Capability is unverified. Only manual preparation is available.', {}, '/accounts');
  else if (route === 'manual' && !manual && !matching.some(row => row.status === 'available')) add('capability', 'blocker', 'Account capability does not permit this operation', { status: capability.status }, '/accounts');
  else if (route === 'manual') add('capability', 'risk', 'The target requires manual publishing', {}, '/accounts');
  if (binding?.paused && !drainingClaim) add('connector_mode', 'blocker', 'Account execution binding is paused', {}, '/accounts');
  if (route === 'api' && !connected) add('account_connection', 'blocker', 'Platform connection requires authorization', {}, '/accounts');
  else if (route === 'api') freshness(connection?.expires_at);
  const accountBlock = ctx.list('account_block').find(row => row.social_account_id === account?.id && !row.resolved_at && !row.released_at && !['resolved', 'closed', 'expired'].includes(String(row.status)) && (row.severity === 'blocking' || ['identity_mismatch', 'session_challenge', 'platform_restricted', 'auth_expired'].includes(String(row.kind))));
  if (accountBlock && route !== 'manual') add('account_connection', 'blocker', 'Account has an unresolved blocker', { account_block_id: accountBlock.id }, '/accounts');

  if (route === 'connector' && binding) {
    const channel = binding.connector_channel === 'mobile' ? 'mobile' : 'browser';
    const device = locate(ctx, 'connector_device', binding.device_id) ?? locate(ctx, 'device', binding.device_id);
    const mobile = locate(ctx, 'mobile_device', binding.mobile_device_id);
    const mobileBinding = ctx.list('mobile_app_binding').find(row => row.mobile_device_id === mobile?.id && row.app === binding.mobile_app);
    const onlineSeverity = lateStage ? 'blocker' : 'risk';
    const recentlySeen = (row: Row | undefined) => !!row && time(ctx.now) - time(row.last_seen_at) < 90_000;
    if (!device || device.online === false || !['online', 'ready', 'active'].includes(String(device.status)) || !recentlySeen(device)) add('device_online', onlineSeverity, 'Connector is offline', {}, '/devices');
    if (channel === 'browser') {
      const session = ctx.list('browser_session').find(row => row.binding_id === binding.id && row.status !== 'revoked');
      if (!session || session.status !== 'verified' || (session.device_id && session.device_id !== binding.device_id) || (session.social_account_id && session.social_account_id !== account?.id)) add('session_identity', 'blocker', 'Browser identity is not verified', {}, '/accounts');
    } else {
      if (!mobile || mobile.device_id !== binding.device_id || mobile.online === false || mobile.status !== 'ready' || mobile.automation_authorized === false || mobile.prerequisites_ready === false || !recentlySeen(mobile)) add('mobile_device_online', onlineSeverity, 'Phone is offline or automation authorization is invalid', {}, '/devices');
      if (!mobileBinding || mobileBinding.social_account_id !== account?.id || mobileBinding.status !== 'verified') add('mobile_app_binding', 'blocker', 'Phone app account binding is not verified', {}, '/devices');
      if (mobile?.platform === 'ios' || mobile?.os === 'ios') {
        const expiry = time(mobile.signing_expires_at);
        freshness(mobile.signing_expires_at);
        if (!Number.isFinite(expiry) || expiry <= time(ctx.now)) add('mobile_signing', 'blocker', 'iPhone signing is expired or unverified', {}, '/devices');
        else if (expiry <= time(at)) add('mobile_signing', lateStage ? 'blocker' : 'risk', 'iPhone signing expires before publication', {}, '/devices');
        else if (expiry - time(ctx.now) <= 7 * 86_400_000) add('mobile_signing', 'info', 'iPhone signing expires within seven days');
      }
    }
    const taskPlatform = platform === 'xiaohongshu' ? 'xhs' : platform;
    const taskKey = binding.task_type ?? (channel === 'mobile' ? `${taskPlatform}.app.publish` : undefined);
    const compat = taskKey ? ctx.list('component_compat').find(row => row.component_key === `task:${taskKey}` && (!binding.task_version || row.component_version === binding.task_version)) : undefined;
    if (compat?.status === 'blocked') add('capability', 'blocker', 'Connector task version is blocked', { component_compat_id: compat.id }, '/devices');
    effectiveMode = binding.connector_mode === 'auto' && target.connector_mode_pref !== 'assist' ? 'auto' : 'assist';
    if (effectiveMode === 'auto' && compat?.supported_modes && !list(compat.supported_modes).includes('auto')) {
      effectiveMode = 'assist';
      add('automation_limits', 'risk', 'The connector task only supports assisted submission', { effective_mode: 'assist' }, '/devices');
    }
    if (effectiveMode === 'auto') {
      const policy = ctx.list('connector_auto_policy')[0];
      const halted = binding.auto_halted || policy?.halted || policy?.halted_by_workspace || list(policy?.ops_halt_rule_ids).length > 0 || ctx.list('job_pause_rule').some(row => row.scope === 'connector_auto' && ['all', ctx.workspaceId].includes(String(row.scope_value)) && !row.released_at && row.enabled !== false && row.active !== false && (row.expires_at == null || time(row.expires_at) > time(ctx.now)));
      if (halted || binding.auto_stop_reason || !binding.auto_ack_by || !binding.auto_ack_at || !binding.auto_ack_terms_version || policy?.terms_version && binding.auto_ack_terms_version !== policy.terms_version) {
        effectiveMode = 'assist';
        add('automation_limits', 'risk', 'Automatic submission is stopped or requires renewed acknowledgement', { effective_mode: 'assist' }, '/accounts');
      } else {
        const day = localMinute(at, zone).slice(0, 10);
        const permits = ctx.list('auto_submit_permit').filter(row => row.social_account_id === account?.id && (row.result === 'granted' || row.status === 'granted' || row.decision === 'granted' || row.granted_at) && (row.local_day === day || localMinute(String(row.granted_at ?? row.created_at), zone).slice(0, 10) === day));
        const peers = ctx.list('publish_target').filter(row => row.id !== target.id && row.social_account_id === account?.id && row.plan_status === 'ready' && row.connector_mode_pref !== 'assist' && row.scheduled_at && localMinute(String(row.scheduled_at), zone).slice(0, 10) === day);
        const cap = Number(binding.daily_cap ?? binding.auto_daily_cap);
        if (!inWindows(binding.allowed_windows ?? binding.auto_allowed_windows, at, zone) || !Number.isInteger(cap) || cap < 1 || (lateStage ? permits.length : permits.length + peers.length) >= cap) {
          if (lateStage) effectiveMode = 'assist';
          add('automation_limits', lateStage ? 'risk' : 'blocker', 'Outside the automatic submission window or daily allowance', { effective_mode: effectiveMode }, '/accounts');
        } else if (peers.some(row => Math.abs(time(row.scheduled_at) - time(at)) < Number(binding.min_interval_seconds ?? binding.auto_min_interval_seconds ?? 0) * 1000) || peers.filter(row => Math.abs(time(row.scheduled_at) - time(at)) < 3_600_000).length >= Number(binding.max_per_hour ?? binding.auto_max_per_hour ?? Infinity)) {
          add('automation_limits', 'risk', 'Automatic submission may be deferred by frequency limits', { effective_mode: 'auto' });
        }
      }
    }
    if (!binding.paused) add('connector_mode', 'info', effectiveMode === 'assist' ? 'A person must submit on the bound device' : 'Automatic mode requires a submission permit', { effective_mode: effectiveMode, connector_channel: channel, mobile_device_id: mobile?.id });
  }
  }

  const refs: Data[] = [];
  const references = (type: string, id: unknown, binding?: unknown) => { if (typeof id === 'string') refs.push({ ref_type: type, ref_id: id, ...(binding ? { binding } : {}) }); };
  const limits = object(capability?.limits);
  const rendered = object(revision?.rendered);
  const caption = typeof rendered.text === 'string' ? rendered.text : '';
  const platformOptions = object(object(object(revision?.settings).platform_options)[platform]);
  // Channel accounts take TikTok options from the revision bound to the target (channel_defaults, §4.4) instead.
  const requiredOptions = settings ? [] : platform === 'tiktok' ? [...TIKTOK_REQUIRED_OPTIONS] : ['douyin', 'xiaohongshu'].includes(platform) ? ['visibility'] : [];
  if (revision && requiredOptions.some(key => platformOptions[key] == null || platformOptions[key] === '')) add('caption_rules', 'blocker', 'A person must select the required platform options on this revision', {}, '/content');
  if (platform === 'tiktok' && platformOptions.privacy_level === 'SELF_ONLY' && ['branded_content', 'both'].includes(String(platformOptions.commercial_disclosure))) add('caption_rules', 'blocker', 'TikTok branded content cannot be posted privately', {}, '/content');
  if (platform === 'tiktok' && Array.isArray(limits.privacy_level_options) && !limits.privacy_level_options.includes(platformOptions.privacy_level)) add('caption_rules', 'blocker', 'TikTok privacy option is unavailable for this account', {}, '/content');
  const defaultCaptionLimits: Record<string, number> = { instagram: 2200, facebook: 63206, tiktok: 2200, youtube: 5000 };
  if (settings && platform === 'x') {
    const limit = settings.caption_limit ?? 280;
    const length = xWeightedLength(caption);
    if (length > limit) add('caption_rules', 'blocker', `文案超過 X 的 ${limit} 加權字元上限（目前 ${length}）`, { limit, length, measure: 'x_weighted' }, '/content');
  } else {
    const captionLimit = settings?.caption_limit ?? limits.max_characters ?? limits.caption_max ?? defaultCaptionLimits[platform];
    if (typeof captionLimit === 'number' && Array.from(caption).length > captionLimit) add('caption_rules', 'blocker', 'Caption exceeds account format limit', settings ? { limit: captionLimit, length: Array.from(caption).length } : {}, '/content');
  }
  if (platform === 'tiktok' && ['comment', 'duet', 'stitch'].some(toggle => platformOptions[`allow_${toggle}`] === true && (limits[`allow_${toggle}`] === false || limits[`${toggle}_disabled`] === true))) {
    add('caption_rules', 'blocker', 'This TikTok account cannot enable one or more interaction settings', {}, '/content');
  }
  for (const rule of ctx.list('knowledge_entry').filter(row => row.brand_id === target.brand_id && row.status === 'active' && row.kind === 'forbidden_phrase' && (row.market_ids == null || list(row.market_ids).includes(variant?.market_id)) && (row.locales == null || list(row.locales).includes(variant?.locale)))) {
    const ruleRevision = locate(ctx, 'knowledge_revision', rule.active_revision_id);
    const structured = object(ruleRevision?.structured);
    if (list(structured.patterns).some(pattern => typeof pattern === 'string' && pattern.length && caption.normalize('NFKC').toLowerCase().includes(pattern.normalize('NFKC').toLowerCase()))) add('caption_rules', structured.severity === 'risk' ? 'risk' : 'blocker', 'Caption matches a restricted brand phrase', { rule_id: rule.id }, '/content');
  }
  const media = entries(revision?.media);
  if (target.content_format === 'text' && !caption.trim()) add('caption_rules', 'blocker', 'Text publishing requires a nonempty caption', {}, '/content');
  const isPrimary = (item: Data) => !item.role || ['primary', 'slide'].includes(String(item.role));
  const primaryCount = media.filter(isPrimary).length;
  if (target.content_format !== 'text' && !primaryCount) add('media_spec', 'blocker', 'This format requires primary media', {}, '/assets');
  if (target.content_format === 'carousel' && primaryCount < 2) add('media_spec', 'blocker', 'A carousel requires at least two media items', {}, '/assets');
  if (typeof limits.max_media === 'number' && primaryCount > limits.max_media) add('media_spec', 'blocker', 'The target exceeds the account media count limit', {}, '/assets');
  if (settings && (DRIVER_PROVIDERS as readonly string[]).includes(String(account?.provider))) {
    const kinds = media.filter(isPrimary).map(item => {
      const version = locate(ctx, 'asset_version', item.asset_version_id);
      return mediaKind(locate(ctx, 'asset', item.asset_id ?? version?.asset_id), version);
    });
    const problem = kinds.length ? channelMediaRule(account?.provider, kinds) : null;
    if (problem) add('media_kind', 'blocker', account?.provider === 'x' ? 'X 只接受 1 支影片，或 1–4 張圖片（不能混用）' : 'TikTok 只接受剛好 1 支影片', { reason: problem, kinds }, '/assets');
  }
  const mediaBindings: Data[] = [];
  for (const item of media) {
    const version = locate(ctx, 'asset_version', item.asset_version_id);
    const asset = locate(ctx, 'asset', item.asset_id ?? version?.asset_id);
    const rendition = locate(ctx, 'asset_rendition', item.rendition_id);
    const captionRendition = locate(ctx, 'asset_rendition', item.caption_rendition_id);
    const renditions = [rendition, captionRendition].filter((row): row is Row => !!row);
    const owned = ownedAsset(asset);
    const foreignBrand = !!asset && !owned && asset.brand_id !== target.brand_id;
    if (!version || !asset || version.asset_id !== asset.id || foreignBrand || asset.status === 'archived' || asset.archived_at ||
      item.rendition_id && (!rendition || rendition.asset_version_id !== version.id) || item.caption_rendition_id && !captionRendition ||
      renditions.some(row => row.status !== 'ready' || row.target_platform && platformKey(row.target_platform) !== platform)) {
      add('media_spec', 'blocker', 'Media version or rendition is missing, mismatched or processing', { media: item }, '/assets');
      continue;
    }
    const meta = { ...object(version.meta), ...object(rendition?.params), ...object(rendition?.metadata), ...object(rendition?.meta) };
    const original = locate(ctx, 'file_object', version.file_object_id);
    const file = rendition ? locate(ctx, 'file_object', rendition.file_object_id) : original;
    const usableFile = (candidate: Row | undefined) => candidate && !candidate.deleted_at && ['clean', 'skipped'].includes(String(candidate.scan_status));
    // §4.4 media_spec: an upload still in flight (declared SHA-256, no file object yet) is a risk until execution.
    const uploading = !!settings && (['uploading', 'processing'].includes(String(asset.status)) || typeof version.sha256 === 'string' && !!version.sha256 && version.file_object_id == null);
    if (settings && asset.status === 'failed') {
      add('media_spec', 'blocker', '影片處理失敗，請重新上傳', { asset_id: asset.id, status: 'failed' }, '/assets');
    } else if (uploading) {
      add('media_spec', lateStage ? 'blocker' : 'risk', '影片還在上傳', { asset_id: asset.id, status: asset.status ?? null }, '/assets');
    } else if (!usableFile(original) || typeof version.sha256 !== 'string' || !version.sha256 || original?.sha256 !== version.sha256 || renditions.some(row => !usableFile(locate(ctx, 'file_object', row.file_object_id)))) {
      add('media_spec', 'blocker', 'The frozen media files are unavailable, unscanned or fail integrity checks', { asset_id: asset.id }, '/assets');
    }
    const expectedMime = target.content_format === 'image' ? 'image/' : ['video', 'short', 'short_video', 'reel'].includes(String(target.content_format)) ? 'video/' : undefined;
    if (isPrimary(item) && expectedMime && !String(file?.mime_type ?? version.mime_type ?? '').startsWith(expectedMime)) add('media_spec', 'blocker', 'Primary media does not match the target format', { asset_id: asset.id }, '/assets');
    const fileBytes = Number(file?.byte_size ?? file?.size_bytes);
    const durationLimit = typeof limits.max_duration_ms === 'number' ? limits.max_duration_ms : Number(limits.max_duration_s) * 1000;
    const sizeLimit = typeof limits.max_bytes === 'number' ? limits.max_bytes : Number(limits.max_file_mb) * 1024 * 1024;
    if (Number(meta.duration_ms) > durationLimit || fileBytes > sizeLimit) add('media_spec', 'blocker', 'Media exceeds account limits', { asset_id: asset.id }, '/assets');
    // E44: a hub channel has no capability row; its platform's certain video limits apply instead (E3 risk when unknown).
    if (settings && isPrimary(item) && !uploading && asset.status !== 'failed' && mediaKind(asset, version) === 'video') {
      const check = channelVideoCheck(account?.provider, settings, { duration_ms: meta.duration_ms, bytes: fileBytes, width: meta.width, height: meta.height });
      if (check) add('media_spec', check.severity, check.message, { asset_id: asset.id, ...check.detail }, '/assets');
    }
    const crop = object(item.crop);
    const ratio = !rendition && Number(crop.w) > 0 && Number(crop.h) > 0 ? Number(meta.width) * Number(crop.w) / (Number(meta.height) * Number(crop.h)) : Number(meta.width) / Number(meta.height);
    const aspects = list(limits.aspect_ratios);
    if (ratio > 0 && Number.isFinite(ratio) && (ratio < Number(limits.min_aspect) || ratio > Number(limits.max_aspect) || aspects.length && !aspects.some(value => {
      const [width, height] = String(value).split(':').map(Number);
      return Math.abs(ratio - width / height) < 0.02;
    }))) add('media_spec', 'blocker', 'Media aspect ratio is unsupported', { asset_id: asset.id }, '/assets');
    const checkRights = (id: string, versionId: string, modified: boolean) => {
      const rights = checkAssetRights(ctx, id, { platform, market: String(market?.country_code ?? market?.region ?? market?.code ?? variant?.market_id ?? ''), usage: 'organic_social', at, asset_version_id: versionId, modified, attribution: caption });
      if (!rights.allowed) add('rights', 'blocker', 'Media usage is not covered at publication time', { asset_id: id, code: rights.code }, '/rights-grants');
      else {
        freshness(rights.valid_until);
        if (rights.restrictions) add('rights', 'risk', 'Review license restrictions before publishing', { asset_id: id }, '/rights-grants');
        references('rights_grant', rights.rights_grant_id, rights.rights_grant_revision_id);
      }
    };
    // §3.8: owned and brandless media count as covered without a rights grant.
    if (!owned) checkRights(asset.id, version.id, !!item.crop || renditions.some(rendition => ['crop', 'subtitle_burned', 'cover'].includes(String(rendition?.kind))));
    for (const rendition of renditions) {
      if (!rendition) continue;
      if (rendition.asset_version_id !== version.id) {
        const subtitle = locate(ctx, 'asset_version', rendition.asset_version_id);
        const subtitleAsset = locate(ctx, 'asset', subtitle?.asset_id);
        if (!subtitle || !subtitleAsset || subtitleAsset.brand_id !== target.brand_id || subtitleAsset.kind !== 'subtitle' || subtitleAsset.status !== 'ready') add('media_spec', 'blocker', 'Caption asset is invalid', {}, '/assets');
        else checkRights(subtitleAsset.id, subtitle.id, false);
      }
      const sha = locate(ctx, 'file_object', rendition.file_object_id)?.sha256;
      if (typeof sha !== 'string' || !sha || rendition.sha256 != null && rendition.sha256 !== sha) {
        add('media_spec', 'blocker', 'The rendition file fails its checksum validation', { rendition_id: rendition.id }, '/assets');
      }
      references('asset_rendition', rendition.id, sha);
    }
    mediaBindings.push({ asset_version_id: version.id, sha256: version.sha256, rendition_ids: renditions.map(row => row?.id) });
  }
  for (const product of entries(revision?.product_refs)) {
    const productId = product.variant_id ?? product.product_variant_id;
    references('product_variant', productId);
    const baseline = locate(ctx, 'listing_snapshot', product.listing_snapshot_id);
    const productVariant = locate(ctx, 'product_variant', productId);
    const catalogProduct = locate(ctx, 'product', productVariant?.product_id);
    const store = locate(ctx, 'store', productVariant?.store_id);
    const unstable = (row: Row | undefined) => row && (row.rolled_back_at || row.archived_at || ['archived', 'inactive', 'discontinued', 'rolled_back'].includes(String(row.status)));
    if (!productVariant || product.listing_snapshot_id && !baseline || unstable(productVariant) || unstable(catalogProduct) || catalogProduct?.brand_id && catalogProduct.brand_id !== target.brand_id) add('product_fact', 'blocker', 'Referenced product or approved snapshot is unavailable', { variant_id: productId }, '/catalog');
    references('listing_snapshot', baseline?.id);
    const productMarket = product.market_id ?? variant?.market_id;
    if (variant?.market_id && productMarket && productMarket !== variant.market_id || baseline && (baseline.variant_id !== productId || productMarket && baseline.market_id !== productMarket)) add('product_fact', 'blocker', 'Product facts do not match the target market', { variant_id: productId }, '/catalog');
    if (product.fact_revision_id) {
      const facts = locate(ctx, 'product_fact_revision', product.fact_revision_id);
      const fact = locate(ctx, 'product_fact', facts?.fact_id);
      if (!fact || fact.status !== 'active' || fact.approved_revision_id !== facts?.id || (fact.product_id && fact.product_id !== productVariant?.product_id) || (fact.variant_id && fact.variant_id !== productId) || (fact.applicable_market_ids != null && !list(fact.applicable_market_ids).includes(productMarket))) {
        add('product_fact', 'blocker', 'Referenced product fact is no longer approved for the target', { fact_revision_id: product.fact_revision_id }, '/catalog');
      }
      references('product_fact_revision', facts?.id);
    }
    const priceClaim = /price|currency/i.test(String(product.field));
    const latest = ctx.list('listing_snapshot').filter(row => row.variant_id === productId && (!productMarket || row.market_id === productMarket) && (!baseline || row.channel === baseline.channel) && row.is_current !== false && !unstable(row)).sort((a, b) => time(b.observed_at) - time(a.observed_at))[0];
    if (!latest) add('product_fact', priceClaim || baseline && lateStage ? 'blocker' : 'risk', 'No current listing snapshot is available', { variant_id: productId }, '/catalog');
    else {
      if (latest.available_for_sale === false || typeof latest.inventory_quantity === 'number' && latest.inventory_quantity <= 0 || latest.inventory_status === 'out_of_stock') add('listing_availability', 'blocker', 'Referenced product is unavailable in the target market', { snapshot_id: latest.id }, '/catalog');
      if (baseline && (baseline.price_amount_minor !== latest.price_amount_minor || baseline.currency !== latest.currency)) add('product_fact', priceClaim ? 'blocker' : 'risk', 'Product price changed after revision', { old_snapshot_id: baseline.id, snapshot_id: latest.id }, '/catalog');
      const config = ctx.list('store_market').find(row => row.store_id === productVariant?.store_id && row.market_id === latest.market_id && row.channel === latest.channel);
      const ttl = Number(config?.snapshot_ttl_minutes ?? 120);
      const observedAt = time(latest.observed_at);
      const pricedAt = time(latest.price_observed_at ?? latest.observed_at);
      const expiry = (priceClaim ? Math.min(observedAt, pricedAt) : observedAt) + ttl * 60_000;
      if (config?.enabled === false || unstable(store)) add('listing_availability', 'blocker', 'Store or market has been disabled', { snapshot_id: latest.id }, '/catalog');
      if (priceClaim && (!baseline || baseline.is_estimate === true || latest.is_estimate === true || latest.price_amount_minor == null || latest.availability && latest.availability !== 'observed' || product.currency && latest.currency !== product.currency)) add('product_fact', 'blocker', 'Current market price is unavailable or estimated', { snapshot_id: latest.id }, '/catalog');
      if (expiry <= time(ctx.now) || !Number.isFinite(expiry)) add('product_fact', lateStage && store?.connection_id && store.status !== 'import_only' ? 'blocker' : 'risk', 'Listing snapshot requires fresh verification', { snapshot_id: latest.id, store_id: store?.id }, '/catalog');
      else validUntil = Math.min(validUntil, expiry);
    }
  }
  for (const id of new Set([...list(target.promotion_ids), ...entries(revision?.product_refs).map(ref => ref.promotion_id).filter(Boolean)])) {
    const promotion = locate(ctx, 'promotion', id);
    const store = locate(ctx, 'store', promotion?.store_id);
    const from = time(promotion?.valid_from ?? promotion?.starts_at);
    const until = time(promotion?.valid_until ?? promotion?.ends_at);
    const state = promotion?.state ?? promotion?.status;
    const marketIds = list(promotion?.market_ids);
    const wrongBrand = (store?.brand_id && store.brand_id !== target.brand_id) || (promotion?.brand_id && promotion.brand_id !== target.brand_id);
    const valid = promotion && ['active', 'scheduled'].includes(String(state)) && !wrongBrand &&
      time(at) >= from && time(at) < until && (!marketIds.length || marketIds.includes(variant?.market_id ?? account?.market_id));
    if (!valid) add('promotion_validity', 'blocker', 'Promotion is outside its valid market or period', { promotion_id: id }, '/promotions');
    else { references('promotion', id, promotion.version); freshness(promotion.valid_until ?? promotion.ends_at); }
  }
  for (const link of entries(revision?.link_refs)) {
    const short = locate(ctx, 'short_link', link.short_link_id);
    if (link.short_link_id && !short) add('link_health', 'blocker', 'Referenced short link is missing', {}, '/short-links');
    if (short) {
      references('short_link', short.id, short.destination_url ?? short.target_url ?? short.version);
      if (Number(short.last_http_status) >= 400 || ['broken', 'disabled', 'expired'].includes(String(short.status))) add('link_health', 'risk', 'Short link needs attention', { short_link_id: short.id }, '/short-links');
    }
  }
  const options = { ...object(revision?.settings), ...object(target.options) };
  delete options.internal_note;
  const payload = { social_account_id: account?.id, platform, variant_revision_id: revision?.id, content_hash: revision?.content_hash, content_format: target.content_format, operation: target.operation, body_doc: revision?.body_doc, rendered, media, media_bindings: mediaBindings, product_refs: revision?.product_refs, link_refs: revision?.link_refs, visibility: target.visibility, options, scheduled_at: target.scheduled_at, refs: [...new Map(refs.map(ref => [digest(ref), ref])).values()].sort((a, b) => digest(a).localeCompare(digest(b))) };
  const day = target.scheduled_at ? localMinute(String(target.scheduled_at), String(target.schedule_tz ?? zone)).slice(0, 10) : String(target.local_scheduled_at ?? '').slice(0, 10);
  const hash = digest({ ...payload, scheduled_at: undefined, schedule_bucket: day, schedule_kind: target.schedule_kind, connector_mode_pref: target.connector_mode_pref });
  if (lateStage && !approvalValid(ctx, target, hash)) add('approval_valid', 'blocker', 'Approval is missing, stale or outside its authorized bounds', {}, '/approvals');
  const pause = activePause(ctx, target);
  // E35 wording for hub channels (the owner reads it on Today and the post page); the release submits such posts again.
  if (pause) add('pause_switch', 'blocker', settings ? '已暫停：恢復前不會發出' : 'Publishing is paused in this scope', { pause_switch_id: pause.id, scope_type: pause.scope_type }, '/settings/publishing');
  if (target.scheduled_at && ctx.list('publish_target').some(row => row.id !== target.id && row.social_account_id === account?.id && row.plan_status === 'ready' && Math.abs(time(row.scheduled_at) - time(target.scheduled_at)) <= 5 * 60_000)) add('time_conflict', 'risk', 'Another target is scheduled within five minutes for this account', {}, '/calendar');
  const items = [...checks.values()];
  const overall = items.some(item => item.severity === 'blocker') ? 'blocked' : items.some(item => item.severity === 'risk') ? 'risk' : 'pass';
  return { overall, items, hash, payload, route, effective_mode: effectiveMode, valid_until: new Date(validUntil).toISOString() };
}

export function assertVersion(row: Row, expectedVersion: number | undefined) {
  if (!Number.isInteger(expectedVersion)) throw new Problem(428, 'VERSION_REQUIRED', 'Provide the expected version');
  if (row.version !== expectedVersion) throw new Problem(409, 'VERSION_CONFLICT', 'The resource has changed', { current_version: row.version });
}
