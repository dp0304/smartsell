import type { Context, Entity, Fields } from '../types.ts';
import { APPROVAL, PAUSE, PRECHECK, TARGET, allowed, fail, list, one, targetFor, timestamp } from './model.ts';

const filters = ['from', 'to', 'status', 'account_id', 'social_account_id', 'brand_id', 'campaign_id', 'owner_id'] as const;

function matching(input: Fields, at: string) {
  const from = input.from === undefined ? undefined : timestamp(input.from, 'from');
  const to = input.to === undefined ? undefined : timestamp(input.to, 'to');
  if (from && to && from >= to) fail('invalid_input', 'from must precede to.');
  return (!from || at >= from) && (!to || at < to);
}

function joined(row: Entity, tasks: Entity[], posts: Entity[], pauses: Entity[]) {
  const execution = tasks.find(task => task.data.target_id === row.id) ?? null;
  const platform_post = posts.find(post => post.data.target_id === row.id) ?? null;
  const state = execution?.data.status;
  const paused = row.data.status === 'scheduled' && pauses.some(({ data }) => data.active === true && (
    data.scope === 'workspace' || data.scope === 'account' && data.scope_id === row.data.account_id ||
    data.scope === 'campaign' && data.scope_id === row.data.frozen?.campaign_id || data.scope === 'brand' && data.scope_id === row.data.frozen?.brand_id));
  let display_status = state ?? (platform_post ? 'published' : row.data.status);
  if (['outcome_unknown', 'unknown'].includes(state)) display_status = 'outcome_unknown';
  else if (paused && !platform_post && (!state || ['scheduled', 'queued', 'blocked', 'manual'].includes(state))) display_status = 'paused';
  return { ...row, display_status, execution, platform_post };
}

async function query(ctx: Context, input: Fields) {
  const [targets, tasks, posts, pauses] = await Promise.all([list(ctx, TARGET), ctx.list('execution', 'execution_task'), ctx.list('execution', 'platform_post'), list(ctx, PAUSE)]);
  const accountId = input.account_id ?? input.social_account_id;
  matching(input, ctx.now);
  return targets.map(row => joined(row, tasks, posts, pauses)).filter(row => {
    const d = row.data;
    return matching(input, d.scheduled_at) && (!accountId || d.account_id === accountId) &&
      (!input.status || [d.status, row.display_status].includes(input.status)) && (!input.owner_id || d.owner_id === input.owner_id) &&
      (!input.brand_id || d.frozen?.brand_id === input.brand_id) && (!input.campaign_id || d.frozen?.campaign_id === input.campaign_id);
  }).sort((a, b) => String(a.data.scheduled_at).localeCompare(b.data.scheduled_at) || a.id.localeCompare(b.id));
}

export async function listTargets(ctx: Context, input: Fields) {
  allowed(input, filters);
  return query(ctx, input);
}

export async function getTarget(ctx: Context, input: Fields) {
  allowed(input, ['target_id']);
  const target = await targetFor(ctx, input);
  const [tasks, posts, pauses, checks, approval] = await Promise.all([
    ctx.list('execution', 'execution_task'), ctx.list('execution', 'platform_post'), list(ctx, PAUSE), list(ctx, PRECHECK),
    target.data.approval_id ? ctx.get('planning', APPROVAL, target.data.approval_id) : undefined,
  ]);
  return { ...joined(target, tasks, posts, pauses), approval: approval ?? null, prechecks: checks.filter(check => check.data.target_id === target.id) };
}

export async function calendar(ctx: Context, input: Fields) {
  allowed(input, [...filters, 'view']);
  const view = one(input.view ?? 'list', ['day', 'week', 'month', 'list'], 'view');
  const targets = await query(ctx, input);
  const markers = targets.flatMap(target => [
    { kind: 'publish_target', target_id: target.id, at: target.data.scheduled_at, status: target.display_status },
    ...(target.execution ? [{ kind: 'execution', target_id: target.id, at: target.execution.updated_at, status: target.execution.data.status }] : []),
    ...(target.platform_post ? [{ kind: 'platform_post', target_id: target.id, at: target.platform_post.data.published_at ?? null, verification: target.platform_post.data.verification }] : []),
  ]);
  const content = await ctx.list('content', 'content_item');
  const production = content.filter(({ data }) => typeof data.production_due_at === 'string' && matching(input, data.production_due_at) &&
    (!input.owner_id || data.owner_user_id === input.owner_id) && (!input.brand_id || data.brand_id === input.brand_id) &&
    (!input.campaign_id || data.campaign_id === input.campaign_id) && !input.account_id && !input.social_account_id &&
    (!input.status || data.production_stage === input.status))
    .map(item => ({ kind: 'production_deadline', content_item_id: item.id, at: item.data.production_due_at, status: item.data.production_stage }));
  return { view, targets, markers: [...markers, ...production] };
}
