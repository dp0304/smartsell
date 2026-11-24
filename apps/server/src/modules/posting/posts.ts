import { type Context, type PostSummary, type Row } from '@smartsell/contracts';
import { locate } from '../../../../../packages/domain/src/publishing/index.js';
import { channelDevice, targetZone as viewTargetZone } from '../workspace/views/hub-model.js';
import { machineWarnings } from '../workspace/views/machines.js';
import { listPosts, postDetail as viewPostDetail, postSummaryOf, type PostsQuery as ViewPostsQuery } from '../workspace/views/posts.js';
import { loginSummary, mcpProvider, precheckItems, webUrl } from './model.js';

/**
 * The compact post the Agent reads (§7.2.6 posts[i]; also posts_list, post_update and post_get). E15: built from S7's view
 * builders (postSummary, postDetail, listPosts), so the Agent and the web read one status, route and approval derivation.
 */

export interface PostWarning { code: string; message: string }
export interface PostExtras { checkTaskId?: string | null; warnings?: PostWarning[] }
export type ApprovalState = PostSummary['approval'];

export const targetZone = (ctx: Context, target: Row) => viewTargetZone(ctx, target);
const atHandle = (handle: string | null) => handle ? `@${handle}` : null;

/** Compacts a PostSummary for the Agent (§7.2.6), adding the precheck blockers and warnings the Agent has to relay. */
export function compactPost(ctx: Context, target: Row, summary: PostSummary, extras: PostExtras = {}) {
  const zone = targetZone(ctx, target);
  const items = precheckItems(ctx, target);
  const blocked = summary.status === 'blocked' || target.precheck_summary === 'blocked';
  const blockers = blocked ? items.filter(item => item.severity === 'blocker' && item.result !== 'pass').map(item => ({
    code: String(item.check_key), message: String(item.message ?? ''), web_url: webUrl(ctx, 'channel', summary.channel.id),
  })) : [];
  const risks: PostWarning[] = items.filter(item => item.severity === 'risk' && item.result !== 'pass')
    .map(item => ({ code: String(item.check_key), message: String(item.message ?? '') }));
  const device = summary.machine ? locate(ctx, 'connector_device', summary.machine.id) : channelDevice(ctx, summary.channel.id);
  const warnings = [...(extras.warnings ?? []), ...risks, ...(device ? machineWarnings(ctx, device, 'en') : [])]
    .filter((warning, index, all) => all.findIndex(other => other.code === warning.code) === index);
  const live = summary.task_id ? summary.blocker : null;
  return {
    post_id: summary.post_id, channel_id: summary.channel.id, provider: mcpProvider(summary.channel.provider), handle: atHandle(summary.channel.handle),
    task_id: summary.task_id,
    route: { kind: summary.route_kind, machine_id: summary.machine?.id ?? null, machine_name: summary.machine?.name ?? null, mode: summary.mode },
    status: summary.status, approval: summary.approval, approval_deadline_local: summary.approval_deadline_local,
    owner_action: summary.owner_action ? { kind: summary.owner_action.kind, machine: summary.owner_action.machine.name, from_local: summary.owner_action.from_local,
      until_local: summary.owner_action.until_local, remote_url: summary.owner_action.machine.remote_url } : null,
    login: { ...loginSummary(ctx, summary.channel.id), check_task_id: extras.checkTaskId ?? null },
    scheduled_at: summary.scheduled_at, local_time: summary.local_time ? `${summary.local_time} ${zone}` : null,
    latest_local_time: summary.latest_local_time,
    caption_preview: preview(captionOf(ctx, target)),
    ...(summary.plan_tag && { plan_tag: summary.plan_tag }),
    ...(live && { blocker: live }),
    blockers, warnings,
    web_url: summary.web_url,
  };
}

function captionOf(ctx: Context, target: Row): string {
  const revision = locate(ctx, 'content_revision', target.variant_revision_id);
  const rendered = revision?.rendered && typeof revision.rendered === 'object' ? revision.rendered as Record<string, unknown> : {};
  return typeof rendered.text === 'string' ? rendered.text : typeof revision?.body === 'string' ? revision.body : '';
}
function preview(text: string) {
  return [...text].length > 280 ? `${[...text].slice(0, 279).join('')}…` : text;
}

export function agentPost(ctx: Context, target: Row, extras: PostExtras = {}) {
  return compactPost(ctx, target, postSummaryOf(ctx, target), extras);
}
export type AgentPost = ReturnType<typeof agentPost>;

// ---------- posts_list (§7.2.8) ----------

export interface PostsQuery { from?: string; to?: string; status?: readonly string[]; channel_id?: string; machine_id?: string; limit: number }

export function listAgentPosts(ctx: Context, query: PostsQuery) {
  const list = listPosts(ctx, query satisfies ViewPostsQuery);
  return { ...list, posts: list.posts.map(post => compactPost(ctx, ctx.get('publish_target', post.post_id), post)) };
}

// ---------- post_get (§7.2.9) ----------

export function postDetail(ctx: Context, target: Row) {
  const detail = viewPostDetail(ctx, target.id);
  const post = compactPost(ctx, target, detail.post);
  return {
    post: { post_id: target.id, status: post.status, local_time: post.local_time, latest_local_time: post.latest_local_time, plan_tag: detail.post.plan_tag },
    channel: { channel_id: post.channel_id, provider: post.provider, handle: post.handle },
    route: { kind: post.route.kind, machine_name: post.route.machine_name, mode: post.route.mode },
    approval: post.approval, approval_deadline_local: post.approval_deadline_local, owner_action: post.owner_action,
    media: detail.media.map(item => ({ media_id: item.media_id || null, filename: item.filename, kind: item.kind, bytes: item.bytes || null, status: item.status,
      uploaded_bytes: item.uploaded_bytes })),
    caption: { text: detail.content.caption },
    task: detail.task ? {
      task_id: detail.task.task_id, status: detail.task.status,
      blocker: detail.task.blocker ? { code: detail.task.blocker.code, message: detail.task.blocker.message, resumable_by: detail.task.blocker.resumable_by } : null,
      timeline: detail.task.timeline.slice(-10).map(row => ({ at_local: row.at_local, event: row.event,
        detail_text: typeof row.detail.text === 'string' ? row.detail.text : typeof row.detail.message === 'string' ? row.detail.message : row.text })),
    } : null,
    result: detail.result ? { url: detail.result.url, external_post_id: detail.result.external_post_id, published_at: detail.result.published_at } : null,
    blockers: post.blockers, warnings: post.warnings,
    web_url: post.web_url,
  };
}
