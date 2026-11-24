import { type ChannelSummary, type Context, type Row } from '@smartsell/contracts';
import { locate } from '../../../../../packages/domain/src/publishing/index.js';
import { activeMachines, channelDevice, hubChannels, localText, workspaceZone } from '../workspace/views/hub-model.js';
import { channelSummaries } from '../workspace/views/channels.js';
import { machineSummaries, machineWarnings } from '../workspace/views/machines.js';
import { jobDetail, postSummaryOf } from '../workspace/views/posts.js';
import { buildOverview, type HubAttentionItem } from '../workspace/views/today.js';
import { mcpProvider } from './model.js';

/**
 * Agent read models for smartsell_overview, machines_list, channels_list and task_get (§7.2.1–§7.2.3, §7.2.10). E15: each one
 * compacts S7's view builder (buildOverview, machineSummaries, channelSummaries, jobDetail), so the Agent and the web compute
 * status, counts, readiness and warnings with the same code. Machine warnings use the English wording for the model.
 */

export { hubChannels };
export const machines = (ctx: Context): Row[] => activeMachines(ctx);

const atHandle = (handle: string | null) => handle ? `@${handle}` : null;
const warningsEn = (ctx: Context, machineId: string) => {
  const device = locate(ctx, 'connector_device', machineId);
  return device ? machineWarnings(ctx, device, 'en') : [];
};

/** Readiness items that stop scheduling (§7.2.3 blockers, §9.4), from S7's channel summary. */
export function channelBlockers(ctx: Context, account: Row) {
  return channelSummaries(ctx).find(row => row.channel_id === account.id)?.blockers ?? [];
}

const pauseCompact = (pause: ChannelSummary['pause']) => pause
  ? { scope: pause.scope === 'social_account' ? 'channel' : pause.scope, reason: pause.reason, at: pause.at } : null;

function channelCompact(channel: ChannelSummary) {
  return {
    channel_id: channel.channel_id, provider: mcpProvider(channel.provider), handle: atHandle(channel.handle),
    machine: channel.machine?.name ?? null, login: channel.login.state, mode: channel.effective_mode, approval: channel.approval_mode,
    can_schedule: channel.can_schedule, ...(channel.blockers.length && { blockers: channel.blockers }),
    // E35 (additive, like channels_list): an active pause. Posts can still be scheduled; they go out only after the owner resumes.
    ...(channel.pause && { pause: pauseCompact(channel.pause) }),
  };
}

function attentionCompact(ctx: Context, item: HubAttentionItem) {
  const zone = workspaceZone(ctx);
  const post = item.post ? postSummaryOf(ctx, ctx.get('publish_target', item.post.id)) : undefined;
  return {
    kind: item.kind, severity: item.severity, post_id: item.post?.id ?? null, channel_id: item.channel?.id ?? null, channel: item.channel?.label ?? null,
    machine: item.machine?.label ?? null, local_time: post?.local_time ?? null,
    ...(post?.approval_deadline_local && { deadline_local: post.approval_deadline_local }),
    ...(item.due_at && !post?.approval_deadline_local && { due_local: localText(item.due_at, zone) }),
    // E30 (additive): true only for a channel's blockers, the same ones that make channels[].can_schedule false.
    blocks_scheduling: item.blocks_scheduling,
    title: item.title, message: item.detail, web_url: item.web_url,
  };
}

export function overview(ctx: Context) {
  const view = buildOverview(ctx);
  const now = Date.parse(ctx.now);
  const upcoming = machineSummaries(ctx).length || view.channels.length ? upcomingPosts(ctx, now) : [];
  return {
    workspace: view.workspace,
    machines: view.machines.map(machine => ({
      machine_id: machine.machine_id, name: machine.name, online: machine.online, channels: machine.channels.length,
      next_job_local: machine.next_job?.local_time ?? null, warnings: warningsEn(ctx, machine.machine_id),
    })),
    channels: view.channels.map(channelCompact),
    today: view.today,
    upcoming,
    needs_owner: view.needs_owner.slice(0, 20).map(item => attentionCompact(ctx, item)),
    alerts: view.alerts,
    web_url: view.web_url,
  };
}

/** The next posts (48 h, like Today's upcoming list), compact. */
function upcomingPosts(ctx: Context, now: number) {
  return ctx.list('publish_target').filter(target => {
    const at = typeof target.scheduled_at === 'string' ? Date.parse(target.scheduled_at) : NaN;
    return at >= now - 30 * 60_000 && at <= now + 48 * 3_600_000 && !!hubChannels(ctx).find(account => account.id === target.social_account_id);
  }).sort((a, b) => String(a.scheduled_at).localeCompare(String(b.scheduled_at))).slice(0, 10).map(target => {
    const post = postSummaryOf(ctx, target);
    return { post_id: post.post_id, channel_id: post.channel.id, channel: `${mcpProvider(post.channel.provider)} ${atHandle(post.channel.handle) ?? ''}`.trim(),
      machine: post.machine?.name ?? null, local_time: post.local_time, status: post.status, web_url: post.web_url };
  });
}

export function machinesList(ctx: Context, includeOffline: boolean) {
  return {
    machines: machineSummaries(ctx, { includeOffline }).map(machine => ({
      machine_id: machine.machine_id, name: machine.name, os: machine.os, online: machine.online, last_seen_at: machine.last_seen_at, paused: machine.paused,
      warnings: warningsEn(ctx, machine.machine_id),
      channels: machine.channels.map(channel => ({ channel_id: channel.social_account_id, provider: mcpProvider(channel.provider), handle: atHandle(channel.handle), login: channel.login })),
      queue: machine.queue,
      next_job: machine.next_job ? { post_id: machine.next_job.post_id, local_time: machine.next_job.local_time, provider: mcpProvider(machine.next_job.provider) } : null,
      web_url: machine.web_url,
    })),
  };
}

export function channelsList(ctx: Context, filter: { provider?: string; machine_id?: string }) {
  return {
    channels: channelSummaries(ctx, { machine_id: filter.machine_id }).filter(channel => !filter.provider || mcpProvider(channel.provider) === filter.provider).map(channel => ({
      channel_id: channel.channel_id, provider: mcpProvider(channel.provider), handle: atHandle(channel.handle), display_name: channel.display_name,
      machine: channel.machine ? { machine_id: channel.machine.id, name: channel.machine.name, online: channel.machine.online } : null,
      login: { state: channel.login.state, checked_at: channel.login.checked_at },
      mode: channel.effective_mode, approval: channel.approval_mode,
      daily_cap: channel.daily_cap, scheduled_today: channel.scheduled_today, published_today: channel.published_today,
      window: channel.window, timezone: channel.timezone, lateness_limit_min: channel.lateness_limit_min,
      pause: pauseCompact(channel.pause),
      can_schedule: channel.can_schedule, blockers: channel.blockers, web_url: channel.web_url,
    })),
  };
}

export function taskDetail(ctx: Context, taskId: string) {
  const job = jobDetail(ctx, taskId);
  const target = job.post_id ? locate(ctx, 'publish_target', job.post_id) : undefined;
  const zone = target ? (typeof target.schedule_tz === 'string' && target.schedule_tz ? target.schedule_tz : workspaceZone(ctx)) : workspaceZone(ctx);
  return {
    task_id: job.task_id, kind: job.kind, status: job.status, dry_run: job.dry_run,
    machine: { machine_id: job.machine.id, name: job.machine.name, online: job.machine.online },
    channel: { channel_id: job.channel.id, provider: mcpProvider(job.channel.provider), handle: atHandle(job.channel.handle) },
    post_id: job.post_id,
    not_before_local: localText(job.not_before, zone), not_after_local: localText(job.not_after, zone),
    blocker: job.blocker ? { code: job.blocker.code, message: job.blocker.message, resumable_by: job.blocker.resumable_by } : null,
    result: job.result ? { url: job.result.url, external_post_id: job.result.external_post_id } : null,
    timeline: job.timeline.slice(-30).map(row => ({ at_local: row.at_local, event: row.event,
      detail_text: typeof row.detail.text === 'string' ? row.detail.text : typeof row.detail.message === 'string' ? row.detail.message : row.text })),
    web_url: job.web_url,
  };
}

export { channelDevice };
