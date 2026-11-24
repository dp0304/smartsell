import { Problem, type Context, type Data, type Input, type Row } from '@smartsell/contracts';
import { canReadFinancial } from '../analytics/metrics.js';
import { resource, type TeamHost } from '../team/model.js';
import { canFollow } from './search.js';
import { bool, id, invalid, limit, missing, newest, obj, one, open, own, str, strings, timestamp } from './shared.js';

export interface NotificationContext extends Context {
  notificationRecipient?(userId: string, operation: string): Context | undefined;
  authorizeNotificationComment?: TeamHost['authorizeComment'];
}

function canReadMention(ctx: NotificationContext, commentId: unknown) {
  if (!ctx.authorizeNotificationComment || !ctx.list('comment_mention').some(row =>
    row.comment_id === commentId && row.user_id === ctx.actorId && !row.revoked_at)) return false;
  const comment = ctx.list('comment').find(row => row.id === commentId && !row.deleted_at);
  const thread = comment && ctx.list('comment_thread').find(row => row.id === comment.thread_id);
  if (!thread) return false;
  try {
    ctx.authorizeNotificationComment(ctx, resource(thread), 'read');
    return true;
  } catch (error) {
    if (error instanceof Problem && [403, 404].includes(error.status)) return false;
    throw error;
  }
}

export function canReadReportNotice(ctx: Context, reportId: unknown, versionId: unknown) {
  if (typeof reportId !== 'string' || !canFollow(ctx, 'report', reportId)) return false;
  const version = ctx.list('report_version').find(row => row.id === versionId && row.report_id === reportId &&
    ['finalized', 'superseded'].includes(String(row.status)));
  return !!version && (!version.sensitive || canReadFinancial(ctx));
}

export const notificationDigestType = 'notification_digest';
export const notificationDigestEvent = 'workspace.notification_digest.ready';
const digestRequested = 'workspace.notification_digest.requested';
const digestSourceTypes = new Map([['report_finalized', 'reports_get'], ['mentioned', 'comments_list']]);
const maxDigestItems = 100;

function canReadNotification(ctx: NotificationContext, notice: Row) {
  if (notice.type === 'mentioned' && notice.resource_type === 'comment') return canReadMention(ctx, notice.resource_id);
  if (notice.type === 'report_finalized') return canReadReportNotice(ctx, notice.resource_id, notice.report_version_id);
  if (notice.type === 'assigned' && notice.resource_type === 'conversation') {
    return ctx.list('conversation').some(row => row.id === notice.resource_id && row.assignee_user_id === ctx.actorId);
  }
  if (['assigned', 'overdue'].includes(String(notice.type)) && notice.resource_type === 'work_item') {
    return ctx.list('work_item').some(row => row.id === notice.resource_id && row.assignee_type === 'user' && row.assignee_id === ctx.actorId);
  }
  return true;
}

export function follow(ctx: Context, user: string, type: string, resource: string, reason = 'manual') {
  return ctx.list('subscription').find(row => row.user_id === user && row.resource_type === type && row.resource_id === resource)
    ?? ctx.create('subscription', { user_id: user, resource_type: type, resource_id: resource, reason, muted: false });
}

function preference(ctx: Context, userId: string, type: string) {
  return ctx.list('notification_preference').filter(row => row.user_id === userId && typeof row.type_pattern === 'string' &&
    (row.type_pattern === type || (row.type_pattern.endsWith('*') && type.startsWith(row.type_pattern.slice(0, -1)))))
    .sort((a, b) => String(b.type_pattern).replace(/\*$/, '').length - String(a.type_pattern).replace(/\*$/, '').length || Number(b.type_pattern === type) - Number(a.type_pattern === type))[0];
}
/** In-app notification type that mirrors an `owner_alert` into the existing bell feed (phase1-design §5.9 channel 1). */
export const ownerAlertNotificationType = 'owner_alert';

/**
 * Who "the owner" is for owner alerts: active owners and unscoped admins of the workspace (§5.9).
 * Empty when the context carries no membership list (unit tests, or an unenriched context).
 */
export function ownerRecipients(ctx: Context): string[] {
  const members = (ctx as Context & { activeWorkspaceMembers?: { userId: string; role: string; scopes?: string[] }[] }).activeWorkspaceMembers ?? [];
  return [...new Set(members.filter(member => !member.scopes?.length && ['owner', 'admin'].includes(member.role)).map(member => member.userId))].sort();
}

export function notify(ctx: Context, recipient: string, type: string, title: string, data: Data = {}) {
  if (data.dedupe_key) {
    const existing = ctx.list('notification').find(row => row.recipient_user_id === recipient && row.dedupe_key === data.dedupe_key);
    if (existing) return existing;
  }
  const pref = preference(ctx, recipient, type);
  const channels = Array.isArray(pref?.channels) ? pref.channels : ['in_app'];
  const row = ctx.create('notification', { ...data, recipient_user_id: recipient, type, title, read_at: null, archived_at: null });
  ctx.create('notification_delivery', { notification_id: row.id, channel: 'in_app', status: channels.includes('in_app') ? 'delivered' : 'suppressed', attempts: 0, delivered_at: channels.includes('in_app') ? ctx.now : null });
  ctx.emit('workspace.notification.created', { notification_id: row.id, recipient_user_id: recipient });
  return row;
}
function digestPreference(ctx: Context, userId: string) {
  return ctx.list('notification_preference').find(row => row.user_id === userId && row.type_pattern === notificationDigestType);
}

function hasChannel(pref: Row | undefined, channel: string) {
  return Array.isArray(pref?.channels) && pref.channels.includes(channel);
}

function digestSources(ctx: Context, userId: unknown, ids: unknown, unread = false) {
  if (!Array.isArray(ids)) return [];
  const wanted = new Set(ids);
  return ctx.list('notification').filter(row => wanted.has(row.id) && row.recipient_user_id === userId &&
    digestSourceTypes.has(String(row.type)) && (!unread || (row.read_at == null && row.archived_at == null)))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
}

function digestItems(ctx: NotificationContext, sources: Row[], reader: (operation: string) => Context | undefined) {
  return sources.flatMap<{ sourceId: string; item: Data }>(source => {
    const scoped = reader(digestSourceTypes.get(String(source.type))!);
    if (!scoped || !canReadNotification(scoped, source) || typeof source.resource_id !== 'string') return [];
    if (source.type === 'report_finalized' && source.resource_type === 'report' && typeof source.report_version_id === 'string') {
      if (!ctx.list('subscription').some(row => row.user_id === source.recipient_user_id && row.resource_type === 'report' &&
        row.resource_id === source.resource_id && !row.muted && row.active !== false)) return [];
      const report = scoped.get('report', source.resource_id);
      return [{ sourceId: source.id, item: { type: 'report_finalized', resource_type: 'report', resource_id: report.id,
        report_version_id: source.report_version_id, title: report.title } }];
    }
    if (source.type !== 'mentioned' || source.resource_type !== 'comment') return [];
    return [{ sourceId: source.id, item: { type: 'mentioned', resource_type: 'comment', resource_id: source.resource_id,
      report_version_id: undefined, title: source.title } }];
  });
}

function notificationView(ctx: Context, row: Row) {
  if (row.type !== notificationDigestType) return canReadNotification(ctx, row) ? row : undefined;
  const { digest_source_ids, digest_webhook_subscription_id: _webhook, ...view } = row;
  const items = digestItems(ctx, digestSources(ctx, ctx.actorId, digest_source_ids), () => ctx).map(entry => entry.item);
  return items.length ? { ...view, items } : undefined;
}

export function signedNotificationDigest(ctx: NotificationContext, notificationId: unknown, subscriptionId: string) {
  const notice = ctx.list('notification').find(row => row.id === notificationId && row.type === notificationDigestType);
  if (!notice || notice.digest_webhook_subscription_id !== subscriptionId || typeof notice.recipient_user_id !== 'string') return;
  const recipient = notice.recipient_user_id;
  const pref = digestPreference(ctx, recipient);
  if (!hasChannel(pref, 'chat_webhook') || pref?.webhook_subscription_id !== subscriptionId) return;
  const items = digestItems(ctx, digestSources(ctx, recipient, notice.digest_source_ids),
    operation => ctx.notificationRecipient?.(recipient, operation))
    .map(({ item: { title: _title, ...reference } }) => reference);
  if (items.length) return { recipient_user_id: recipient, date: notice.digest_date, items };
}

export function listNotifications(ctx: Context, { query }: Input) {
  const suppressed = new Set(ctx.list('notification_delivery').filter(row => row.channel === 'in_app' && row.status === 'suppressed').map(row => row.notification_id));
  const rows = ctx.list('notification').filter(row => row.recipient_user_id === ctx.actorId && !suppressed.has(row.id) &&
    (query.archived === 'true' ? row.archived_at != null : row.archived_at == null) &&
    (query.unread !== 'true' || row.read_at == null) && (query.type === undefined || row.type === query.type))
    .flatMap(row => notificationView(ctx, row) ?? []);
  return { items: rows.sort(newest).slice(0, limit(query.limit)), total: rows.length };
}
export function markNotifications(ctx: Context, { body }: Input, key: 'read_at' | 'archived_at') {
  const views = strings(body.ids, 'ids').map(value => {
    const row = own(ctx.get('notification', value), 'recipient_user_id', ctx);
    return notificationView(ctx, row) ?? missing('Notification');
  });
  return views.map(view => {
    if (view[key] != null) return view;
    const updated = ctx.update('notification', view.id, { [key]: ctx.now });
    return { ...view, [key]: updated[key], updated_at: updated.updated_at, version: updated.version };
  });
}
export function listPreferences(ctx: Context) {
  return ctx.list('notification_preference').filter(row => row.user_id === ctx.actorId);
}
export function savePreference(ctx: Context, { body }: Input) {
  const pattern = str(body.type_pattern, 'type_pattern', 100);
  if (!/^[a-z0-9_]*\*?$/.test(pattern)) invalid('Invalid type_pattern');
  const channels = strings(body.channels, 'channels').map(value => one(value, 'channel', ['in_app', 'email', 'chat_webhook']));
  let quietHours: Data | null = null;
  if (body.quiet_hours != null) {
    const input = obj(body.quiet_hours, 'quiet_hours');
    const time = (v: unknown) => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : invalid('Invalid quiet hours');
    quietHours = { start: time(input.start), end: time(input.end) };
  }
  const existing = listPreferences(ctx).find(row => row.type_pattern === pattern);
  let webhookSubscriptionId: string | null = null;
  if (pattern === notificationDigestType && channels.includes('chat_webhook')) {
    webhookSubscriptionId = id(body.webhook_subscription_id ?? existing?.webhook_subscription_id);
    const target = ctx.list('webhook_subscription').find(row => row.id === webhookSubscriptionId);
    if (target?.status !== 'active' || !Array.isArray(target.event_types) || !target.event_types.includes(notificationDigestEvent)) {
      invalid('Select an active notification digest webhook subscription');
    }
  }
  const fields = { type_pattern: pattern, channels, quiet_hours: quietHours,
    ...(pattern === notificationDigestType && { webhook_subscription_id: webhookSubscriptionId }) };
  return existing ? ctx.update('notification_preference', existing.id, fields) : ctx.create('notification_preference', { ...fields, user_id: ctx.actorId });
}
export function subscriptions(ctx: Context) {
  return ctx.list('subscription').filter(row => row.user_id === ctx.actorId);
}
export function saveSubscription(ctx: Context, input: Input, canRead: (type: string, resource: string) => boolean) {
  const type = id(input.body.resource_type);
  const resource = id(input.body.resource_id);
  if (!canRead(type, resource)) own({} as Row, 'user_id', ctx);
  const row = follow(ctx, ctx.actorId, type, resource);
  return input.body.muted === undefined ? row : ctx.update('subscription', row.id, { muted: bool(input.body.muted, 'muted') });
}
export function removeSubscription(ctx: Context, { body, params }: Input) {
  const row = params.id ? own(ctx.get('subscription', params.id), 'user_id', ctx)
    : subscriptions(ctx).find(item => item.resource_id === id(body.resource_id) && item.resource_type === id(body.resource_type));
  if (row) ctx.remove('subscription', row.id);
  return { removed: !!row };
}

const eventRules: Record<string, { type: string; title: string; task?: boolean; resource: string; key: string }> = {
  'core.approval_request.created': { type: 'approval_requested', title: 'Approval requested', task: true, resource: 'approval_request', key: 'approval' },
  'team.comment.mentioned': { type: 'mentioned', title: 'You were mentioned', resource: 'comment', key: 'mention' },
  'planning.precheck.completed': { type: 'precheck_blocked', title: 'Publish precheck blocked', task: true, resource: 'publish_target', key: 'precheck' },
  'execution.attempt.outcome_unknown': { type: 'outcome_unknown', title: 'Publication outcome requires verification', task: true, resource: 'execution_task', key: 'outcome' },
  'execution.task.manual_required': { type: 'manual_required', title: 'Manual publishing is required', task: true, resource: 'execution_task', key: 'manual' },
  'execution.task.late_decision_required': { type: 'late_decision_required', title: 'Overdue publication needs a decision', task: true, resource: 'execution_task', key: 'late' },
  'execution.attempt.mode_downgraded': { type: 'mode_downgraded', title: 'Publishing requires confirmation', resource: 'execution_task', key: 'mode' },
  'account.connection.expired': { type: 'auth_expired', title: 'Connection authorization expired', task: true, resource: 'connection', key: 'auth' },
  'account.device.offline': { type: 'device_offline', title: 'Device offline', task: true, resource: 'device', key: 'device' },
  'account.mobile_device.offline': { type: 'mobile_device_offline', title: 'Paired phone offline', task: true, resource: 'mobile_device', key: 'mobile' },
  'account.mobile_app_binding.identity_mismatch': { type: 'identity_mismatch', title: 'Phone app account identity mismatch', task: true, resource: 'mobile_app_binding', key: 'identity' },
  'account.binding.auto_stopped': { type: 'auto_stopped', title: 'Automatic mode stopped', resource: 'account_execution_binding', key: 'auto' },
  'ingest.quality_issue.opened': { type: 'quality_issue', title: 'Review a data quality issue', task: true, resource: 'quality_issue', key: 'quality' },
  'ingest.sync_run.failed': { type: 'sync_failed', title: 'Data synchronization failed', task: true, resource: 'data_source', key: 'sync' },
  'inbox.conversation.assigned': { type: 'assigned', title: 'Conversation assigned', resource: 'conversation', key: 'assignment' },
  'commerce.listing.changed': { type: 'listing_changed', title: 'Listing changed', resource: 'listing', key: 'listing' },
  'creator.deliverable.overdue': { type: 'deliverable_overdue', title: 'Creator deliverable overdue', task: true, resource: 'deliverable', key: 'deliverable' },
  'creator.deliverable.deadline_changed': { type: 'deliverable_deadline_changed', title: 'Review publication schedule after a creator deadline changed', resource: 'publish_target', key: 'creator_deadline' },
  'campaign.milestone.delayed': { type: 'milestone_delayed', title: 'Campaign milestone delayed', task: true, resource: 'milestone', key: 'milestone' },
};
const resolution: Record<string, string> = {
  'core.approval_request.approved': 'approval', 'core.approval_request.rejected': 'approval', 'core.approval_request.invalidated': 'approval',
  'core.approval_request.expired': 'approval', 'core.approval_request.changes_requested': 'approval',
  'execution.attempt.verified': 'outcome', 'execution.task.completed': 'manual', 'execution.task.published': 'outcome', 'account.connection.restored': 'auth',
  'execution.task.late_decision_recorded': 'late',
  'account.device.online': 'device', 'account.mobile_device.online': 'mobile', 'account.mobile_app_binding.verified': 'identity',
  'account.binding.auto_enabled': 'auto', 'ingest.sync_run.completed': 'sync', 'ingest.quality_issue.resolved': 'quality',
};

/** Called in the workspace transaction by the event consumer, with authorized recipients resolved by the source module. */
const ruleFamily = (type: string) => Object.hasOwn(eventRules, type) ? eventRules[type]!.key : Object.hasOwn(resolution, type) ? resolution[type] : undefined;
const eventRefKeys: Record<string, string> = {
  approval: 'request_id', mention: 'comment_id', precheck: 'target_id', outcome: 'task_id', manual: 'task_id', mode: 'task_id', late: 'task_id',
  auth: 'connection_id', device: 'device_id', mobile: 'mobile_device_id', identity: 'mobile_app_binding_id', auto: 'binding_id',
  sync: 'data_source_id', quality: 'quality_issue_id', assignment: 'conversation_id', listing: 'listing_id', deliverable: 'deliverable_id', creator_deadline: 'publish_target_id', milestone: 'milestone_id',
};
const stringValue = (value: unknown) => typeof value === 'string' && value ? value : undefined;
export function applyWorkspaceEvent(ctx: NotificationContext, envelope: Data) {
  const type = stringValue(envelope.type);
  const eventId = stringValue(envelope.id);
  if (!type || !eventId) return;
  const payload = envelope.payload === undefined ? envelope : obj(envelope.payload, 'event payload');
  const family = ruleFamily(type);
  if (!family) return;
  const resourceId = stringValue(payload[eventRefKeys[family]!]) ?? stringValue(payload.resource_id);
  if (!resourceId) return;
  const approval = family === 'approval' ? ctx.list('approval_request').find(row => row.id === resourceId) : undefined;
  if (type === 'core.approval_request.created' && approval && approval.status !== 'pending') return;
  const steps = approval?.steps as { approvers?: { user_ids?: unknown; roles?: string[] } }[] | undefined;
  const approvers = steps?.[Number(approval?.current_step) - 1]?.approvers;
  const activeMembers = (ctx as Context & { activeWorkspaceMembers?: { userId: string; role: string; scopes?: string[] }[] }).activeWorkspaceMembers;
  const approvalRecipients = activeMembers?.filter(member => !member.scopes?.length &&
    ['owner', 'admin', 'manager', 'reviewer'].includes(member.role) && (approvers?.roles?.includes(member.role) ||
      (Array.isArray(approvers?.user_ids) && approvers.user_ids.includes(member.userId)))).map(member => member.userId);
  const qualityRecipient = family === 'quality' ? activeMembers?.filter(member => !member.scopes?.length && ['owner', 'admin', 'manager'].includes(member.role))
    .sort((a, b) => ['owner', 'admin', 'manager'].indexOf(a.role) - ['owner', 'admin', 'manager'].indexOf(b.role) || a.userId.localeCompare(b.userId))[0]?.userId : undefined;
  const people = payload.recipients ?? payload.recipient_user_ids ?? payload.mentioned_user_ids ?? approvalRecipients ?? approvers?.user_ids;
  const terms = type === 'account.binding.auto_stopped' && payload.reason === 'terms_outdated';
  const termsManagers = terms ? activeMembers?.filter(member => !member.scopes?.length && ['owner', 'admin'].includes(member.role)).map(member => member.userId) ?? [] : [];
  const recipients = [stringValue(payload.recipient_user_id), stringValue(payload.assignee_user_id), stringValue(payload.mentioned_user_id), qualityRecipient,
    ...termsManagers, ...(Array.isArray(people) ? people.map(stringValue) : [])].filter((value): value is string => value !== undefined);
  const binding = terms ? ctx.list('account_execution_binding').find(row => row.id === resourceId) : undefined;
  const account = binding && ctx.list('social_account').find(row => row.id === binding.social_account_id);
  const event = {
    id: eventId, type, resource_id: resourceId, resource_type: eventRules[type]?.resource,
    recipients, source_updated_at: stringValue(payload.source_updated_at) ?? stringValue(envelope.occurred_at),
    brand_id: stringValue(payload.brand_id ?? account?.brand_id), due_at: stringValue(payload.due_at ?? approval?.due_at),
    terms_version: stringValue(payload.terms_version), blocked: payload.blocked === true || Number(payload.blockers) > 0,
  };
  const sourceUpdatedAt = event.source_updated_at ?? ctx.now;
  const resolved = resolution[event.type];
  if (resolved) {
    const families = type === 'execution.task.published' ? [resolved, 'manual'] : [resolved];
    for (const task of ctx.list('work_item').filter(row => row.source_type === 'event' && families.includes(String(row.event_family)) && row.resource_id === event.resource_id && open(row) && !(timestamp(row.source_updated_at) > timestamp(sourceUpdatedAt)))) {
      ctx.update('work_item', task.id, { status: 'done', completed_at: ctx.now, completed_by_type: 'system', source_updated_at: sourceUpdatedAt });
      ctx.create('work_item_event', { work_item_id: task.id, kind: 'status_changed', from_value: task.status, to_value: 'done', source_event_id: event.id });
      ctx.emit('workspace.work_item.completed', { work_item_id: task.id, source_event_id: event.id });
    }
    return;
  }
  const rule = eventRules[event.type];
  if (!rule || (event.type === 'planning.precheck.completed' && event.blocked !== true)) return;
  const stoppedTermsVersion = stringValue(binding?.auto_stop_terms_version);
  if (terms && (!binding || binding.auto_stop_reason !== 'terms_outdated' ||
    (stoppedTermsVersion && event.terms_version && stoppedTermsVersion !== event.terms_version))) return;
  const resource = event.resource_type ?? rule.resource;
  const title = terms ? 'Review the updated automatic mode terms and re-enable automatic mode' : rule.title;
  for (const recipient of new Set(event.recipients)) {
    if (rule.key === 'mention') {
      const reader = ctx.notificationRecipient?.(recipient, 'comments_list');
      if (!reader || !canReadMention(reader, event.resource_id)) continue;
    }
    if (rule.key === 'assignment') {
      const reader = ctx.notificationRecipient?.(recipient, 'inbox_get_conversation');
      if (!reader || !reader.list('conversation').some(row => row.id === event.resource_id && row.assignee_user_id === recipient)) continue;
    }
    const fields = { resource_type: resource, resource_id: event.resource_id, brand_id: event.brand_id ?? null };
    let task: Row | undefined;
    if (rule.task || terms) {
      const dedupe = JSON.stringify([rule.key, event.resource_id, recipient, terms ? stoppedTermsVersion ?? stringValue(binding?.auto_stopped_at) ?? event.terms_version ?? null : null]);
      task = ctx.list('work_item').find(row => row.dedupe_key === dedupe);
      if (!task) {
        task = ctx.create('work_item', { ...fields, title, status: 'open', type: rule.key === 'approval' ? 'review_task' : 'fix_task', priority: 'high', assignee_type: 'user', assignee_id: recipient, due_at: event.due_at ?? null, source_type: 'event', source_ref: { event_id: event.id }, event_family: rule.key, dedupe_key: dedupe, source_updated_at: sourceUpdatedAt });
        ctx.emit('workspace.work_item.created', { work_item_id: task.id, source_event_id: event.id });
      } else if (timestamp(sourceUpdatedAt) > timestamp(task.source_updated_at)) {
        task = ctx.update('work_item', task.id, { source_updated_at: sourceUpdatedAt,
          ...(rule.key === 'quality' && !open(task) ? { status: 'open', completed_at: null, completed_by_type: null } : {}) });
      }
    }
    if (rule.key === 'mention' || rule.key === 'approval') follow(ctx, recipient, resource, event.resource_id, rule.key === 'mention' ? 'mentioned' : 'approver');
    notify(ctx, recipient, rule.type, title, { ...fields, work_item_id: task?.id ?? null, source_event_id: event.id, dedupe_key: terms && task ? `terms:${task.id}` : `event:${event.id}` });
  }
}

function queueNotificationDigests(ctx: NotificationContext) {
  const unread = ctx.list('notification').filter(row => row.read_at == null && row.archived_at == null && digestSourceTypes.has(String(row.type)))
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
  for (const pref of ctx.list('notification_preference')) {
    const recipient = pref.user_id;
    if (typeof recipient !== 'string' || pref.type_pattern !== notificationDigestType ||
      (!hasChannel(pref, 'in_app') && !hasChannel(pref, 'chat_webhook'))) continue;
    const sourceIds = digestItems(ctx, unread.filter(row => row.recipient_user_id === recipient),
      operation => ctx.notificationRecipient?.(recipient, operation)).slice(0, maxDigestItems).map(entry => entry.sourceId);
    if (sourceIds.length) ctx.emit(digestRequested, { recipient_user_id: recipient, source_ids: sourceIds, date: ctx.now.slice(0, 10) });
  }
}

export const notificationDigestSchedule = { id: 'workspace.notification-digest', utcDaily: true, run: queueNotificationDigests };
export const notificationDigestSubscriber = {
  id: 'workspace.notification-digest',
  accepts: (type: string) => type === digestRequested,
  run(ctx: NotificationContext, event: Data) {
    const { recipient_user_id: recipient, source_ids: sourceIds, date } = (event.data ?? {}) as Data;
    if (typeof recipient !== 'string' || typeof date !== 'string') return;
    const pref = digestPreference(ctx, recipient);
    const target = hasChannel(pref, 'chat_webhook') ? pref?.webhook_subscription_id : undefined;
    if (!hasChannel(pref, 'in_app') && typeof target !== 'string') return;
    const authorized = digestItems(ctx, digestSources(ctx, recipient, sourceIds, true),
      operation => ctx.notificationRecipient?.(recipient, operation));
    if (!authorized.length) return;
    const notice = notify(ctx, recipient, notificationDigestType, 'Daily notification digest', {
      digest_date: date, digest_source_ids: authorized.map(entry => entry.sourceId),
      digest_webhook_subscription_id: target ?? null, dedupe_key: `notification-digest:${date}`,
    });
    if (typeof target === 'string' && notice.digest_webhook_subscription_id === target) {
      ctx.emit(notificationDigestEvent, { notification_id: notice.id, webhook_subscription_id: target });
    }
  },
};

export function scanWorkspaceDue(ctx: Context) {
  for (const row of ctx.list('work_item').filter(row => open(row) && timestamp(row.due_at) < timestamp(ctx.now) && row.assignee_type === 'user' && typeof row.assignee_id === 'string')) {
    const key = `due:${row.id}:${row.due_at}`;
    if (ctx.list('notification').some(item => item.recipient_user_id === row.assignee_id && item.dedupe_key === key)) continue;
    notify(ctx, id(row.assignee_id), 'overdue', 'Work item overdue', { resource_type: 'work_item', resource_id: row.id, work_item_id: row.id, dedupe_key: key });
    ctx.emit('workspace.work_item.overdue', { work_item_id: row.id, due_at: row.due_at });
  }
}
