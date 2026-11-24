import {
  OWNER_RESUME_BLOCKERS, Problem, possiblySent,
  type ChannelPause, type Context, type Data, type HubProvider, type JobDetailView, type JobSummary, type OwnerAction, type PostAction, type PostDetailView,
  type PostStatus, type PostSummary, type Row, type WorkerJobRecord,
} from '@smartsell/contracts';
import { activePause, locate, object, time } from '../../../../../../packages/domain/src/publishing/index.js';
import { approvalDeadline, channelSettingsOrDefault } from '../../account/channel-settings.js';
import {
  JOB, TARGET, addMinutes, allJobs, blockerOf, canForceRelease, caption, channelDevice, channelLabelOf, effectiveModeOf, excerpt, handleOf, isHubProvider,
  invalidQuery, latestJob, localDay, localText, machineName, machineOnline, missedReason, platformPostFor, postStatus, remoteUrl,
  routeKindOf, str, strictQuery, targetZone, workspaceZone, isLive,
} from './hub-model.js';
import { mediaUploadProgress } from '../../../integration/agent-uploads.js';
import { webUrl } from './links.js';
import { jobTimeline } from './timeline.js';

/**
 * Post read models (phase1-design §9.5, §9.7): postSummary, postDetail, listPosts, jobDetail. The web and the Agent tools
 * (S4, E15) read these, so every page and every MCP result shows the same status, route and numbers.
 */

type Job = WorkerJobRecord & Row;
export type Approval = PostSummary['approval'];

export function approvalOf(ctx: Context, target: Row): { approval: Approval; request: Row | undefined; deadline: string | null } {
  const request = locate(ctx, 'approval_request', target.approval_request_id);
  const plan = String(target.plan_status);
  if (plan === 'awaiting_approval') {
    // WV-2 (E34): the request's own deadline, also after it passed or the scan expired it, so the page never shows a later
    // deadline the hub would refuse; without a request, the post's deadline (scheduled_at + lateness_limit_min).
    const deadline = request && str(request.due_at) ? String(request.due_at) : approvalDeadline(ctx, target);
    return { approval: 'awaiting_owner', request, deadline };
  }
  if (plan === 'changes_requested' || request?.status === 'rejected') return { approval: 'rejected', request, deadline: null };
  if (request?.status === 'approved' && plan !== 'draft') {
    return { approval: request.approved_via === 'channel_policy' ? 'approved_by_channel_policy' : 'approved', request, deadline: null };
  }
  return { approval: 'not_submitted', request, deadline: null };
}

/** WV-2 (E34): 核准／駁回 are offered only while the target's request is pending and its due_at is still ahead. */
export function approvalOpen(ctx: Context, target: Row): boolean {
  const request = locate(ctx, 'approval_request', target.approval_request_id);
  return target.plan_status === 'awaiting_approval' && request?.status === 'pending' && time(request.due_at) > time(ctx.now);
}

// ---------- Pauses (E35) ----------

/**
 * E35 (additive to PostSummary): what holds a post that would otherwise go out: an active publishing pause (pause_switch) whose
 * scope covers it, or its paused machine. `pause_id` is the pause_switch row (null for a machine pause).
 */
export type PostPause = Omit<ChannelPause, 'scope'> & { scope: ChannelPause['scope'] | 'campaign' | 'machine'; pause_id: string | null };
export type HubPostSummary = PostSummary & { pause?: PostPause };
/** Statuses a pause holds back; a post already being posted, final or waiting for the owner on the machine is not. */
export const HOLDABLE_STATUSES: readonly PostStatus[] = ['draft', 'blocked', 'awaiting_approval', 'scheduled', 'ready'];

export const resumeWebUrl = (ctx: Context) => `${webUrl(ctx, 'today').replace(/\/$/, '')}/settings#st-pause`;
/** A pause_switch row as the owner reads it: scope, reason, who paused it (Agent or person) and when. */
export function pauseView(ctx: Context, row: Row): PostPause {
  const scope = (['workspace', 'brand', 'campaign', 'social_account'] as const).find(value => value === row.scope_type) ?? 'workspace';
  // Who paused it: the Operation runner stamps created_via ('agent' for an Agent credential); the page words it.
  const by = row.created_via === 'agent' ? 'agent' : row.activated_by || row.created_via === 'human' ? 'person' : null;
  return { scope, reason: String(row.reason ?? ''), by, at: String(row.activated_at ?? row.created_at), resume_web_url: resumeWebUrl(ctx), pause_id: row.id };
}
/** Whether an active pause_switch covers this target (the planning module's own scope rule). */
export function pauseCovers(ctx: Context, row: Row, target: Data, account?: Row): boolean {
  if (row.released_at) return false;
  const scopes: Data = { workspace: ctx.workspaceId, brand: target.brand_id ?? account?.brand_id, campaign: target.campaign_id, social_account: target.social_account_id };
  return typeof row.scope_id === 'string' && row.scope_id === scopes[String(row.scope_type)];
}
function postPause(ctx: Context, target: Row, account: Row, device: Row | undefined, status: PostStatus): PostPause | undefined {
  if (!HOLDABLE_STATUSES.includes(status)) return undefined;
  const own = target.plan_status === 'paused' ? locate(ctx, 'pause_switch', target.paused_by_switch_id) : undefined;
  const row = own && !own.released_at ? own : activePause(ctx, { ...target, brand_id: target.brand_id ?? account.brand_id }) as Row | undefined;
  if (row) return pauseView(ctx, row);
  if (device?.paused !== true) return undefined;
  const by = String(device.paused_by ?? '');
  return { scope: 'machine', reason: String(device.paused_reason ?? ''), by: by.startsWith('agent:') ? 'agent' : by ? 'person' : null,
    at: String(device.paused_at ?? ''), resume_web_url: webUrl(ctx, 'machine', device.id), pause_id: null };
}

/** Machine and route of a post: the live job's machine, else the channel's bound machine (§3.4 routeOf). */
export function routeOf(ctx: Context, target: Row, job?: Row) {
  const account = ctx.get('social_account', String(target.social_account_id));
  const mode = effectiveModeOf(ctx, account);
  const device = (job && isLive(job as Job) ? locate(ctx, 'connector_device', job.device_id) : undefined) ?? channelDevice(ctx, account.id)
    ?? (job ? locate(ctx, 'connector_device', job.device_id) : undefined);
  return { account, mode, device, kind: routeKindOf(account, mode, device) };
}

const machineRef = (ctx: Context, device: Row | undefined) => device
  ? { id: device.id, name: machineName(device), online: machineOnline(ctx, device), web_url: webUrl(ctx, 'machine', device.id) } : null;

const FINAL_FOR_OWNER_ACTION: PostStatus[] = ['published', 'cancelled', 'cancelling', 'failed', 'missed', 'unknown', 'rejected'];

/**
 * One post as every view reads it. Local times are in `zone`: the post's own zone by default (the Agent appends it, the post
 * page labels it); Today passes the page's zone (WV-6) so a row's clock and its 今天／明天 use one zone.
 */
export function postSummaryOf(ctx: Context, target: Row, zone = targetZone(ctx, target)): HubPostSummary {
  const job = latestJob(ctx, target);
  const status = postStatus(ctx, target, job);
  const route = routeOf(ctx, target, job);
  const { account, device, mode } = route;
  const settings = channelSettingsOrDefault(ctx, account.id);
  const scheduledAt = str(target.scheduled_at) && Number.isFinite(time(target.scheduled_at)) ? String(target.scheduled_at) : null;
  const latest = scheduledAt ? addMinutes(scheduledAt, settings.lateness_limit_min) : null;
  const { approval, deadline } = approvalOf(ctx, target);
  const live = job && isLive(job) ? job : undefined;
  const blocker = blockerOf(live ?? (job?.status === 'needs_owner' ? job : undefined));
  const platform = platformPostFor(ctx, target.id);
  const owner_action: OwnerAction | null = route.kind === 'machine' && mode === 'assist' && device && scheduledAt && !FINAL_FOR_OWNER_ACTION.includes(status) ? {
    kind: 'click_post', machine: { id: device.id, name: machineName(device), remote_url: remoteUrl(device) },
    from_local: localText(live?.not_before ?? scheduledAt, zone)!, until_local: localText(live?.not_after ?? latest, zone)!,
  } : null;
  const item = locate(ctx, 'content_item', target.content_item_id);
  const pause = postPause(ctx, target, account, device, status);
  return {
    post_id: target.id, status, scheduled_at: scheduledAt, local_time: localText(scheduledAt, zone), latest_local_time: localText(latest, zone),
    content_item_id: String(target.content_item_id ?? item?.id ?? ''), created_at: String(target.created_at),
    created_by_agent: target.created_via === 'agent' || target.origin === 'agent_tool' || target.origin === 'agent',
    channel: { id: account.id, provider: account.provider as HubProvider, handle: handleOf(account), label: channelLabelOf(account), web_url: webUrl(ctx, 'channel', account.id) },
    machine: machineRef(ctx, device), route_kind: route.kind, mode,
    caption_excerpt: excerpt(caption(ctx, target), 80), media_thumb_url: null,
    url: str(platform?.permalink) ?? str(platform?.url) ?? str(job?.result?.url) ?? null,
    blocker: blocker ? { code: blocker.code, message: blocker.message, resumable_by: blocker.resumable_by } : null,
    task_id: job?.id ?? null,
    approval, approval_deadline: approval === 'awaiting_owner' ? deadline : null,
    approval_deadline_local: approval === 'awaiting_owner' ? localText(deadline, zone) : null,
    owner_action, missed_reason: missedReason(ctx, target, job, status),
    plan_tag: str(target.plan_tag) ?? null, web_url: webUrl(ctx, 'post', target.id),
    ...(pause && { pause }),
  };
}

/** C7 postSummary(ctx, targetId). */
export function postSummary(ctx: Context, targetId: string): HubPostSummary {
  const target = locate(ctx, TARGET, targetId);
  if (!target || !isHubProvider(locate(ctx, 'social_account', target.social_account_id)?.provider)) throw new Problem(404, 'POST_NOT_FOUND', `Unknown post_id ${targetId}`);
  return postSummaryOf(ctx, target);
}

/** Phase 1 posts: publish targets on hub channels (X, TikTok, …), excluding superseded drafts. */
export function hubTargets(ctx: Context): Row[] {
  const accounts = new Set(ctx.list('social_account').filter(row => isHubProvider(row.provider)).map(row => row.id));
  return ctx.list(TARGET).filter(row => accounts.has(String(row.social_account_id)) && row.plan_status !== 'superseded');
}

// ---------- Jobs ----------

export function jobSummaryOf(ctx: Context, job: Row): JobSummary {
  const zone = job.publish_target_id ? targetZone(ctx, locate(ctx, TARGET, job.publish_target_id) ?? {} as Row) : workspaceZone(ctx);
  const result = object(job.result);
  return {
    task_id: job.id, kind: job.kind as JobSummary['kind'], status: job.status as JobSummary['status'], post_id: str(job.publish_target_id) ?? null,
    channel_label: channelLabelOf(locate(ctx, 'social_account', job.social_account_id)), not_before: String(job.not_before),
    local_time: localText(job.not_before, zone) ?? String(job.not_before), blocker: blockerOf(job), url: str(result.url) ?? null,
    dry_run: job.dry_run === true,
    web_url: job.publish_target_id ? webUrl(ctx, 'post', String(job.publish_target_id)) : webUrl(ctx, 'channel', String(job.social_account_id)),
  };
}

/** C7 jobDetail(ctx, jobId): one Worker job with its machine, channel and timeline (views_job_get, task_get). */
export function jobDetail(ctx: Context, jobId: string): JobDetailView {
  const job = allJobs(ctx).find(row => row.id === jobId);
  if (!job) throw new Problem(404, 'TASK_NOT_FOUND', `Unknown task_id ${jobId}. Read task_id from post_schedule, post_get or channel_check.`);
  const device = locate(ctx, 'connector_device', job.device_id);
  const account = locate(ctx, 'social_account', job.social_account_id);
  const target = job.publish_target_id ? locate(ctx, TARGET, job.publish_target_id) : undefined;
  const zone = target ? targetZone(ctx, target) : workspaceZone(ctx);
  return {
    ...jobSummaryOf(ctx, job),
    machine: { id: String(job.device_id), name: machineName(device), online: machineOnline(ctx, device), web_url: webUrl(ctx, 'machine', String(job.device_id)) },
    channel: { id: String(job.social_account_id), provider: (account?.provider ?? 'x') as HubProvider, handle: handleOf(account), web_url: webUrl(ctx, 'channel', String(job.social_account_id)) },
    not_after: String(job.not_after), timeline: jobTimeline(ctx, job, machineName(device), zone), result: job.result ?? null,
  };
}

// ---------- Actions (§5.14 table) ----------

export function postActions(ctx: Context, target: Row, summary: PostSummary, job: Job | undefined): PostAction[] {
  const actions: PostAction[] = [];
  const sent = !!job && possiblySent(job);
  const blocker = blockerOf(job);
  const machineOff = !summary.machine?.online;
  switch (summary.status) {
    case 'draft': case 'blocked': case 'scheduled': case 'ready':
      actions.push('reschedule', 'cancel');
      break;
    case 'awaiting_approval':
      if (approvalOpen(ctx, target)) actions.push('approve', 'reject');
      actions.push('reschedule', 'cancel');
      break;
    case 'rejected':   // E37: only an explicit change (改到…) sends it again; it can also be cancelled.
      actions.push('reschedule', 'cancel');
      break;
    case 'publishing':
      if (!sent || (job?.status === 'running' && !job.submitting_at)) actions.push('cancel');
      break;
    case 'needs_owner':
      if (blocker && OWNER_RESUME_BLOCKERS.includes(blocker.code) && time(job?.not_after) > time(ctx.now)) actions.push('resume');
      if (blocker?.phase === 'prepare' && !job?.started_at) actions.push('retry');
      if (!job?.submitting_at && (!job?.started_at || blocker?.code === 'owner_click_required')) actions.push('cancel');
      break;
    case 'missed': case 'failed':
      actions.push('reschedule');
      break;
    // E36: force release only for a job the hub never saw start (no go, started or submitting), and only while its machine is off.
    case 'unknown':
      actions.push('confirm_result', 'mark_not_published');
      if (canForceRelease(job) && machineOff) actions.push('force_release');
      break;
    case 'cancelling':
      if (canForceRelease(job) && machineOff) actions.push('force_release');
      break;
    default: break;
  }
  return actions;
}

// ---------- Detail ----------

function mediaOf(ctx: Context, target: Row): PostDetailView['media'] {
  const revision = locate(ctx, 'content_revision', target.variant_revision_id);
  return (Array.isArray(revision?.media) ? revision.media as Data[] : []).map(item => {
    const version = locate(ctx, 'asset_version', item.asset_version_id);
    const asset = locate(ctx, 'asset', version?.asset_id ?? item.asset_id);
    const file = locate(ctx, 'file_object', version?.file_object_id);
    // S5 ledger 15: the latest upload session of this media (bytes received so far).
    const progress = asset ? mediaUploadProgress(ctx, asset.id) : undefined;
    const session = progress ? locate(ctx, 'media_upload_session', progress.upload_id) : undefined;
    const mime = String(file?.mime_type ?? version?.mime_type ?? session?.mime ?? '');
    const kind = asset?.kind === 'image' || mime.startsWith('image/') ? 'image' : 'video';
    const meta = object(version?.meta);
    const raw = String(asset?.status ?? (file ? 'ready' : 'processing'));
    const status = (['ready', 'processing', 'uploading', 'failed'] as const).find(value => value === raw) ?? (file ? 'ready' : 'processing');
    const bytes = Number(file?.size_bytes ?? progress?.bytes ?? 0) || 0;
    const received = typeof progress?.bytes_received === 'number' ? progress.bytes_received : null;
    return {
      media_id: String(asset?.id ?? item.asset_id ?? ''), file_id: str(file?.id) ?? null, kind,
      filename: String(file?.original_filename ?? session?.filename ?? asset?.title ?? ''), bytes,
      sha256: String(file?.sha256 ?? version?.sha256 ?? session?.sha256 ?? ''),
      duration_ms: typeof meta.duration_ms === 'number' ? meta.duration_ms : null, width: typeof meta.width === 'number' ? meta.width : null,
      height: typeof meta.height === 'number' ? meta.height : null, status,
      uploaded_bytes: status === 'ready' ? bytes : received === null ? null : Math.min(received, bytes || received),
      // Media bytes need a short-lived signed link (GET /files/:id/download?inline=true); the page asks for it.
      preview_url: null, thumbnail_url: null,
    };
  });
}

function evidenceOf(ctx: Context, jobs: Row[]): { file_id: string; url: string; label: string }[] {
  const ids = new Set(jobs.map(job => job.id));
  return ctx.list('file_object').filter(row => row.purpose === 'evidence' && ids.has(String(row.worker_job_id)) && !row.deleted_at)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map(row => ({ file_id: row.id, url: `/files/${encodeURIComponent(row.id)}/download?inline=true`, label: String(row.original_filename ?? row.label ?? '截圖') }));
}

/** C7 postDetail(ctx, targetId): PostDetailView (views_post_get; the calendar drawer and the post page render it). */
export function postDetail(ctx: Context, targetId: string): PostDetailView {
  const summary = postSummary(ctx, targetId);
  const target = ctx.get(TARGET, targetId);
  const job = latestJob(ctx, target);
  const zone = targetZone(ctx, target);
  const { approval, request, deadline } = approvalOf(ctx, target);
  const decision = request ? ctx.list('approval_decision').filter(row => row.request_id === request.id)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0] : undefined;
  const revision = locate(ctx, 'content_revision', target.variant_revision_id);
  const variant = locate(ctx, 'content_variant', target.content_variant_id);
  const platform = platformPostFor(ctx, target.id);
  const jobs = allJobs(ctx).filter(row => row.publish_target_id === target.id);
  const result = object(job?.result);
  const attempts = jobs.filter(row => row.kind === 'publish_post' && !row.dry_run && row.started_at).length;
  const creator = target.created_via === 'agent' || target.origin === 'agent_tool' ? 'agent' : 'human';
  return {
    post: { ...summary, timezone: zone, created_by: { type: creator, label: str(target.created_by_label) ?? (creator === 'agent' ? 'Agent' : null) } },
    content: { content_item_id: summary.content_item_id, revision_id: String(target.variant_revision_id ?? ''), caption: caption(ctx, target),
      platform: String(variant?.platform ?? revision?.platform ?? summary.channel.provider) },
    media: mediaOf(ctx, target),
    approval: { status: approval, request_id: request?.id ?? null, decided_at: str(decision?.created_at) ?? str(request?.decided_at) ?? null,
      decided_by: str(decision?.decided_by_user_id) ?? (request?.approved_via === 'channel_policy' ? 'channel_policy' : null),
      resource_hash: str(request?.resource_hash) ?? null, deadline },
    task: job ? { ...jobSummaryOf(ctx, job), attempts, not_after: String(job.not_after), go_source: job.go_source ?? null,
      timeline: jobTimeline(ctx, job, summary.machine?.name ?? machineName(locate(ctx, 'connector_device', job.device_id)), zone) } : null,
    result: platform || (job?.status === 'succeeded' && result.url) ? {
      platform_post_id: str(platform?.id) ?? '', url: str(platform?.permalink) ?? str(platform?.url) ?? str(result.url) ?? null,
      external_post_id: str(platform?.external_post_id) ?? str(result.external_post_id) ?? null,
      published_at: str(platform?.published_at) ?? str(result.published_at) ?? null,
      verification: platform?.verification === 'manual_confirmed' || (job as Row | undefined)?.owner_confirmed === true ? 'manual_confirmed' : 'system_verified',
      late_by_sec: Number(result.late_by_sec) || 0, evidence: evidenceOf(ctx, jobs),
    } : null,
    actions: postActions(ctx, target, summary, job),
    links: { calendar: webUrl(ctx, 'calendar', target.id), machine: summary.machine?.web_url ?? null, channel: summary.channel.web_url },
  };
}

// ---------- List ----------

export interface PostsQuery { from?: string; to?: string; status?: readonly string[]; channel_id?: string; machine_id?: string; limit?: number }
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * C7 listPosts(ctx, query): posts by local date in the workspace zone, newest last. Default today … +7 days; F8: with only
 * `from` the range is from … from + 7 days, with only `to` it is min(today, to − 7 days) … to, and an inverted range is refused.
 */
export function listPosts(ctx: Context, query: PostsQuery = {}) {
  const zone = workspaceZone(ctx);
  const today = localDay(ctx.now, zone);
  const from = query.from ?? (query.to ? [today, addDays(query.to, -7)].sort()[0] : today);
  const to = query.to ?? addDays(from, 7);
  if (from > to) invalidQuery('to', 'to must be on or after from');
  const limit = query.limit ?? 30;
  const statuses = query.status?.length ? new Set(query.status) : undefined;
  const posts = hubTargets(ctx).filter(target => {
    const at = str(target.scheduled_at);
    if (!at || !Number.isFinite(time(at))) return false;
    const day = localDay(at, zone);
    if (day < from || day > to) return false;
    if (query.channel_id && target.social_account_id !== query.channel_id) return false;
    return true;
  }).sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at)) || a.id.localeCompare(b.id))
    .map(target => postSummaryOf(ctx, target))
    .filter(post => (!statuses || statuses.has(post.status)) && (!query.machine_id || post.machine?.id === query.machine_id));
  return { posts: posts.slice(0, limit), total: posts.length, truncated: posts.length > limit, from, to, timezone: zone };
}

const POST_STATUSES: readonly PostStatus[] = ['draft', 'blocked', 'awaiting_approval', 'scheduled', 'ready', 'publishing', 'confirming', 'published',
  'needs_owner', 'missed', 'failed', 'unknown', 'cancelling', 'cancelled', 'rejected'];

/** GET /views/posts query → PostsQuery, strictly (§9.7). */
export function postsQuery(query: Record<string, string | undefined>): PostsQuery {
  strictQuery(query, ['from', 'to', 'status', 'channel_id', 'machine_id', 'limit']);
  const out: PostsQuery = {};
  for (const key of ['from', 'to'] as const) {
    const value = query[key];
    if (value === undefined) continue;
    if (!DATE.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`))) invalidQuery(key, `${key} must be YYYY-MM-DD`);
    out[key] = value;
  }
  if (out.from && out.to && out.from > out.to) invalidQuery('to', 'to must be on or after from');
  if (query.status !== undefined) {
    const values = query.status.split(',').map(value => value.trim()).filter(Boolean);
    const unknown = values.find(value => !POST_STATUSES.includes(value as PostStatus));
    if (unknown) invalidQuery('status', `Unknown status ${unknown}. Allowed: ${POST_STATUSES.join(', ')}`);
    out.status = values;
  }
  if (query.channel_id !== undefined) out.channel_id = query.channel_id;
  if (query.machine_id !== undefined) out.machine_id = query.machine_id;
  if (query.limit !== undefined) {
    const limit = Number(query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) invalidQuery('limit', 'limit must be an integer from 1 to 200');
    out.limit = limit;
  }
  return out;
}

export const isJob = (ctx: Context, id: string) => !!locate(ctx, JOB, id);
