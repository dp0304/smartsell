import { createHash } from 'node:crypto';
import type { Context, Fields } from '../types.js';
import { action, add, brandFilter, browse, emit, get, identifier, inBrand, list, listLimit, newest, problems, put, str } from './workbench-core.js';
import { recheckOnboarding } from './workbench-onboarding.js';

const stable = (...values: string[]) => createHash('sha256').update(JSON.stringify(values)).digest('hex');
export async function subscribe(ctx: Context, user: string, type: string, resource: string, reason: string) {
  const id = stable(user, type, resource);
  const existing = await get(ctx, 'subscription', id);
  if (existing) return existing.data.active === false && reason === 'manual' ? put(ctx, existing, { active: true }) : existing;
  return add(ctx, 'subscription', { user_id: user, resource_type: type, resource_id: resource, reason, active: true }, id);
}
export async function notify(ctx: Context, user: string, type: string, title: string, dedupe: string, data: Fields = {}) {
  const id = stable(user, dedupe);
  if (await get(ctx, 'notification', id)) return;
  const row = await add(ctx, 'notification', { ...data, recipient_user_id: user, type, title, dedupe_key: dedupe, read_at: null, archived_at: null }, id);
  const preference = (await list(ctx, 'notification_preference')).find(preference => preference.data.user_id === user);
  const suppressed = preference?.data.in_app === false;
  await add(ctx, 'notification_delivery', { notification_id: row.id, channel: 'in_app', status: suppressed ? 'suppressed' : 'delivered', delivered_at: suppressed ? null : ctx.now }, id);
  await emit(ctx, 'notification.created', { notification_id: id, recipient_user_id: user });
}
export async function notificationList(ctx: Context, input: Fields) {
  const brand = await brandFilter(ctx, input.brand_id);
  const items = (await list(ctx, 'notification')).filter(row => row.data.recipient_user_id === ctx.actorId &&
    inBrand(row, brand) && (input.archived === true || !row.data.archived_at) && (input.unread !== true || !row.data.read_at)).sort(newest);
  return { total: items.length, items: items.slice(0, listLimit(input.limit)) };
}
async function mark(ctx: Context, input: Fields, field: string) {
  if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 100) problems.invalid('Supply 1 to 100 notification ids');
  const rows = [];
  for (const id of new Set<string>((input.ids as unknown[]).map(identifier))) {
    const row = await get(ctx, 'notification', id);
    if (!row || row.data.recipient_user_id !== ctx.actorId) return problems.missing('Notification not found');
    rows.push(row);
  }
  const items = [];
  for (const row of rows) items.push(row.data[field] ? row : await put(ctx, row, { [field]: ctx.now }));
  return { items };
}
export const subscribedKinds: Record<string, string> = { work_item: 'workspace', content_item: 'content', campaign: 'campaign', asset: 'asset', product: 'commerce' };
async function follow(ctx: Context, input: Fields, enabled: boolean) {
  const type = str(input.resource_type, 'resource_type');
  const id = identifier(input.resource_id);
  if (!Object.hasOwn(subscribedKinds, type) || !await ctx.get(subscribedKinds[type]!, type, id)) problems.missing('Resource not found');
  if (enabled) return subscribe(ctx, ctx.actorId, type, id, 'manual');
  const existing = await get(ctx, 'subscription', stable(ctx.actorId, type, id));
  if (!existing || existing.data.active === false) return { active: false };
  return put(ctx, existing, { active: false });
}
export const notificationQueries = { list_notifications: action(browse, notificationList) };
export const notificationCommands = {
  read_notifications: action(browse, (ctx, input) => mark(ctx, input, 'read_at')),
  archive_notifications: action(browse, (ctx, input) => mark(ctx, input, 'archived_at')),
  set_notification_preferences: action(browse, async (ctx, input) => {
    if (typeof input.in_app !== 'boolean') problems.invalid('Invalid in_app');
    const row = await get(ctx, 'notification_preference', ctx.actorId);
    const data = { user_id: ctx.actorId, in_app: input.in_app };
    return row ? put(ctx, row, data) : add(ctx, 'notification_preference', data, ctx.actorId);
  }),
  subscribe: action(browse, (ctx, input) => follow(ctx, input, true)),
  unsubscribe: action(browse, (ctx, input) => follow(ctx, input, false)),
};

type Spec = { family: string; type: string; resource: string; id: readonly string[]; title: string; notificationOnly?: boolean };
const specs: Record<string, Spec> = {};
function register(events: string[], family: string, type: string, resource: string, id: string[], title: string, notificationOnly = false) {
  for (const event of events) specs[event] = { family, type, resource, id, title, notificationOnly };
}
register(['core.approval_request.created', 'planning.approval.created', 'planning.approval.requested', 'planning.target.submitted'], 'approval', 'review_task', 'approval', ['approval_id', 'approval_request_id', 'request_id', 'id'], 'Approval requested');
register(['account.connection.expired'], 'connection', 'fix_task', 'connection', ['connection_id'], 'Renew the expired connection');
register(['account.device.offline'], 'device', 'fix_task', 'device', ['device_id'], 'Check the offline connector');
register(['account.mobile_device.offline'], 'mobile', 'fix_task', 'mobile_device', ['mobile_device_id', 'device_id'], 'Check the offline phone');
register(['account.mobile_app_binding.identity_mismatch'], 'identity', 'fix_task', 'mobile_app_binding', ['mobile_app_binding_id', 'binding_id'], 'Verify the signed-in app account');
register(['ingest.sync_run.failed'], 'sync', 'fix_task', 'sync_run', ['sync_run_id', 'run_id'], 'Investigate the failed sync');
register(['execution.attempt.outcome_unknown'], 'outcome', 'fix_task', 'execution_task', ['task_id', 'execution_task_id'], 'Verify the publishing outcome');
register(['execution.task.manual_required', 'execution.task.manual'], 'manual', 'fix_task', 'execution_task', ['task_id', 'execution_task_id'], 'Complete publishing manually');
register(['execution.attempt.mode_downgraded'], 'downgraded', 'fix_task', 'execution_task', ['task_id', 'execution_task_id'], 'Confirm publishing before the deadline', true);
register(['inbox.conversation.assigned'], 'conversation', 'followup', 'conversation', ['conversation_id'], 'Conversation assigned');
register(['team.comment.mentioned'], 'mention', 'followup', 'comment', ['comment_id', 'id'], 'You were mentioned', true);
register(['planning.precheck.completed'], 'precheck', 'fix_task', 'publish_target', ['target_id', 'publish_target_id'], 'Resolve publishing precheck errors');
const resolved: Record<string, [family: string, ids: string[]][]> = {};
function resolve(events: string[], family: string, ...ids: string[]) {
  for (const event of events) (resolved[event] ??= []).push([family, ids]);
}
resolve(['approved', 'rejected', 'invalidated', 'changes_requested'].flatMap(state => [`core.approval_request.${state}`, `planning.approval.${state}`]), 'approval', 'approval_id', 'approval_request_id', 'request_id', 'id');
resolve(['planning.target.approval_invalidated'], 'approval', 'approval_id');
resolve(['account.connection.refreshed', 'account.connection.authorized'], 'connection', 'connection_id');
resolve(['account.device.online'], 'device', 'device_id');
resolve(['account.mobile_device.online'], 'mobile', 'mobile_device_id', 'device_id');
resolve(['account.mobile_app_binding.verified'], 'identity', 'mobile_app_binding_id', 'binding_id');
resolve(['account.binding.auto_enabled'], 'terms', 'binding_id');
resolve(['execution.attempt.reconciled', 'execution.task.succeeded', 'execution.task.published', 'execution.task.cancelled'], 'outcome', 'task_id', 'execution_task_id');
resolve(['execution.task.manual_completed', 'execution.task.published', 'execution.task.cancelled'], 'manual', 'task_id', 'execution_task_id');

const value = (data: Fields, keys: readonly string[]) => keys.map(key => data[key]).find(item => typeof item === 'string' && item.length) as string | undefined;
async function closeEventTasks(ctx: Context, family: string, resource: string) {
  for (const row of await list(ctx, 'work_item')) {
    if (row.data.source_type !== 'event' || row.data.event_family !== family || row.data.resource_id !== resource || ['done', 'cancelled'].includes(row.data.status)) continue;
    await put(ctx, row, { status: 'done', completed_at: ctx.now, completed_by_type: 'system', completed_by_id: null });
    await add(ctx, 'work_item_event', { work_item_id: row.id, kind: 'status_changed', from_value: row.data.status, to_value: 'done', actor_type: 'system' });
    await emit(ctx, 'work_item.status_changed', { work_item_id: row.id, status: 'done' });
    await emit(ctx, 'work_item.completed', { work_item_id: row.id, completed_by_type: 'system' });
  }
}
async function eventTask(ctx: Context, event: string, spec: Spec, resource: string, recipient: string | undefined, payload: Fields, dedupe: string) {
  const data = { resource_type: spec.resource, resource_id: resource, brand_id: payload.brand_id ?? null };
  const id = stable('event-task', dedupe);
  let work = await get(ctx, 'work_item', id);
  if (!spec.notificationOnly) {
    if (!work) {
      work = await add(ctx, 'work_item', { ...data, title: spec.title, type: spec.type, status: 'open', priority: 'high',
        assignee_id: recipient ?? null, assignee_type: recipient ? 'user' : null, source_type: 'event', event_family: spec.family,
        source_ref: { event_id: payload.event_id ?? null, type: event }, source_updated_at: payload.source_updated_at ?? ctx.now, dedupe_key: dedupe }, id);
      await emit(ctx, 'work_item.created', { work_item_id: id });
    } else if (work.data.status !== 'done' && typeof payload.source_updated_at === 'string' && payload.source_updated_at > work.data.source_updated_at) {
      await put(ctx, work, { source_updated_at: payload.source_updated_at });
    }
  }
  if (recipient) {
    if (work) await subscribe(ctx, recipient, 'work_item', id, spec.family === 'approval' ? 'approver' : 'assigned');
    await notify(ctx, recipient, spec.family === 'terms' ? 'auto_stopped' : spec.family === 'approval' ? 'approval_requested' : spec.family === 'mention' ? 'mentioned' : event.split('.').at(-1)!, spec.title, dedupe, { ...data, work_item_id: work?.id ?? null });
  }
}
async function managers(ctx: Context): Promise<string[]> {
  const records = await ctx.list('team', 'member');
  const ids = records.filter(row => ['owner', 'admin'].includes(row.data.role) && !['removed', 'revoked', 'inactive', 'invited'].includes(row.data.status))
    .map(row => value(row.data, ['user_id', 'userId', 'member_id'])).filter((id): id is string => !!id);
  if (['owner', 'admin'].includes(ctx.role)) ids.push(ctx.actorId);
  return [...new Set(ids)].sort();
}

export async function handleWorkspaceEvent(ctx: Context, type: string, data: Fields) {
  if (type.startsWith('workspace.')) return;
  if (/^account\.(?:device|mobile_device|mobile_app_binding|connection)\.|^ingest\.sync_run\./.test(type)) await recheckOnboarding(ctx, type);
  for (const [family, ids] of resolved[type] ?? []) {
    const id = value(data, ids);
    if (id) await closeEventTasks(ctx, family, id);
  }
  if (type === 'account.binding.auto_stopped') {
    const binding = value(data, ['binding_id']);
    if (!binding) return;
    const recipients = await managers(ctx);
    const terms = data.reason === 'terms_outdated';
    const published = terms ? (await ctx.list('ops', 'auto_terms')).filter(term => term.data.status === 'published' || term.data.active === true).sort(newest)[0] : undefined;
    const version = value(data, ['terms_version', 'current_terms_version']) ?? (published && value(published.data, ['terms_version', 'version']));
    const spec: Spec = { family: terms ? 'terms' : 'auto_stop', type: 'fix_task', resource: 'account_execution_binding', id: [],
      title: terms ? 'Review the updated automatic mode terms and re-enable automatic mode' : 'Resolve the account restriction before re-enabling automatic mode', notificationOnly: !terms || typeof version !== 'string' };
    const dedupe = terms && typeof version === 'string' ? `terms:${binding}:${version}` : `auto_stop:${binding}:${data.reason ?? 'unknown'}:${data.block_id ?? data.event_id ?? ''}`;
    await eventTask(ctx, type, spec, binding, recipients[0], data, dedupe);
    for (const user of recipients.slice(1)) await notify(ctx, user, 'auto_stopped', spec.title, dedupe, { resource_type: spec.resource, resource_id: binding });
    return;
  }
  const spec = specs[type];
  if (!spec) return;
  const resource = value(data, spec.id);
  if (!resource) return;
  if (spec.family === 'precheck' && !['blocked', 'failed', 'error'].includes(data.status) && data.ok !== false && data.result !== 'blocked' && !(typeof data.blockers === 'number' && data.blockers > 0)) {
    if (data.ok === true || data.blockers === 0 || ['passed', 'ok', 'succeeded'].includes(data.status)) await closeEventTasks(ctx, 'precheck', resource);
    return;
  }
  const users = new Set<string>();
  const direct = value(data, ['recipient_user_id', 'mentioned_user_id', 'approver_id', 'assignee_user_id', 'assignee_id', 'owner_id', 'user_id', 'assigneeId']);
  if (direct) users.add(direct);
  for (const key of ['approver_ids', 'assignee_ids', 'mentioned_user_ids']) if (Array.isArray(data[key])) for (const id of data[key]) if (typeof id === 'string' && id) users.add(id);
  if (spec.family === 'approval') {
    const approval = await ctx.get('planning', 'approval', resource) ?? await ctx.get('core', 'approval_request', resource);
    const approver = approval && value(approval.data, ['approver_id', 'assignee_id', 'user_id']);
    if (approver) users.add(approver);
    if (Array.isArray(approval?.data.approver_ids)) for (const id of approval.data.approver_ids) if (typeof id === 'string' && id) users.add(id);
    const target = value(data, ['target_id', 'resource_id']) ?? (approval && value(approval.data, ['target_id', 'resource_id']));
    if (target && data.brand_id === undefined) {
      const record = await ctx.get('planning', 'publish_target', target);
      if (record?.data.brand_id) data = { ...data, brand_id: record.data.brand_id };
    }
  }
  if (['device', 'mobile', 'identity', 'connection', 'sync'].includes(spec.family)) for (const user of await managers(ctx)) users.add(user);
  if (!users.size && !spec.notificationOnly) await eventTask(ctx, type, spec, resource, undefined, data, `${spec.family}:${resource}`);
  for (const user of users) await eventTask(ctx, type, spec, resource, user, data, `${spec.family}:${resource}:${user}`);
}
