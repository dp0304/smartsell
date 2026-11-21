import { ADMIN, APPROVE, Problem, READ, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { invalid, parseCalendar, text, weeklyMinutes } from './business-hours.js';

const blocked = (message: string): never => { throw new Problem(409, 'INVALID_STATE', message); };
const active = (ctx: Context, kind: string, id: string) => {
  const row = ctx.get(kind, id);
  if (row.archived_at) return blocked('Configuration is archived');
  return row;
};
const repository = (kind: string, path: string, roles = READ): Operation[] => [
  { method: 'GET', path, name: `inbox_list_${path.endsWith('business-hours') ? 'business_hours' : kind === 'sla_policy' ? 'sla_policies' : 'auto_rules'}`,
    roles, summary: `List active ${kind} records`, run: ctx => ctx.list(kind).filter(row => !row.archived_at) },
  { method: 'GET', path: `${path}/:id`, name: `inbox_get_${kind}`, roles, summary: `Read ${kind} configuration`, run: (ctx, { params }) => ctx.get(kind, params.id) },
  { method: 'DELETE', path: `${path}/:id`, name: `inbox_archive_${kind}`, roles: ADMIN, versionKind: kind, summary: `Archive ${kind} configuration`, run(ctx, { params }) {
    const row = active(ctx, kind, params.id);
    if (kind === 'business_hours' && ['sla_policy', 'auto_rule'].some(dependent =>
      ctx.list(dependent).some(item => !item.archived_at && item.business_hours_id === row.id))) return blocked('Calendar is still referenced');
    return ctx.update(kind, row.id, { archived_at: ctx.now, ...(kind === 'auto_rule' && { enabled: false }) });
  } },
];

function calendarFields(ctx: Context, body: Data) {
  const tz = ctx.list('workspace')[0]?.default_timezone;
  return { name: text(body.name, 'name', 120), ...parseCalendar(body, typeof tz === 'string' ? tz : 'UTC') };
}

function ruleFields(ctx: Context, data: Data) {
  const { trigger } = data;
  if (trigger !== 'keyword' && trigger !== 'new_dm' && trigger !== 'business_hours_off') return invalid('trigger');
  if (data.mode !== undefined && data.mode !== 'draft_only') return invalid('mode');
  const account = ctx.get('social_account', text(data.social_account_id, 'social_account_id'));
  const amount = (field: string, max: number) => {
    const value = data[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) return invalid(field);
    return value;
  };
  const calendar = trigger === 'business_hours_off' ? active(ctx, 'business_hours', text(data.business_hours_id, 'business_hours_id')) : undefined;
  return {
    mode: 'draft_only', trigger, social_account_id: account.id, business_hours_id: calendar?.id ?? null,
    keyword: trigger === 'keyword' ? text(data.keyword, 'keyword').toLowerCase() : null,
    body_text: text(data.body_text, 'body_text', 16000), window_minutes: amount('window_minutes', 1440),
    max_per_participant_per_day: amount('max_per_participant_per_day', 20),
  };
}

export function persistApprovedReplyTask(ctx: Context, draft: Row) {
  if (!draft.auto_rule_id) return draft;
  const conversation = ctx.get('conversation', String(draft.conversation_id));
  if (ctx.list('work_item').some(item => item.resource_type === 'reply_draft' && item.source_type === 'automation' &&
    (item.source_ref as Data | undefined)?.message_id === draft.in_reply_to_message_id && item.status !== 'cancelled')) {
    return blocked('An approved task already exists for this message');
  }
  const assignee = conversation.assignee_user_id ?? (ctx.role === 'reviewer' ? null : ctx.actorId);
  const task = ctx.create('work_item', {
    title: 'Review delivery and send approved inbox reply', description: 'Open the approved reply draft and verify that the conversation is current before replying in the platform.',
    type: 'followup', priority: 'normal', status: 'open', source_type: 'automation', brand_id: conversation.brand_id,
    resource_type: 'reply_draft', resource_id: draft.id, assignee_id: assignee, assignee_type: assignee ? 'user' : null, created_by_id: ctx.actorId,
    source_ref: { message_id: draft.in_reply_to_message_id, conversation_id: draft.conversation_id, approved_draft_version: draft.version, content_hash: draft.content_hash },
  });
  ctx.emit('workspace.work_item.created', { work_item_id: task.id });
  ctx.emit('inbox.auto_rule.reply_approved', { rule_id: draft.auto_rule_id, reply_draft_id: draft.id, work_item_id: task.id });
  return { ...draft, work_item_id: task.id };
}

export const settingsOperations: Operation[] = [
  ...repository('business_hours', '/inbox/business-hours'),
  ...repository('sla_policy', '/inbox/sla-policies'),
  ...repository('auto_rule', '/inbox/auto-rules', ADMIN),
  { method: 'POST', path: '/inbox/business-hours', name: 'inbox_create_business_hours', roles: ADMIN, summary: 'Create a business-hours calendar', run(ctx, { body }) {
    return ctx.create('business_hours', calendarFields(ctx, body));
  } },
  { method: 'PATCH', path: '/inbox/business-hours/:id', name: 'inbox_update_business_hours', roles: ADMIN, versionKind: 'business_hours', summary: 'Update a calendar for future service deadlines', run(ctx, { params, body }) {
    const row = active(ctx, 'business_hours', params.id);
    const fields = calendarFields(ctx, { ...row, ...body });
    const max = weeklyMinutes(fields) * 104;
    if (ctx.list('sla_policy').some(policy => !policy.archived_at && policy.business_hours_id === row.id &&
      Math.max(Number(policy.first_response_minutes), Number(policy.resolution_minutes)) > max)) return blocked('Calendar has too few recurring hours for an active service target');
    return ctx.update('business_hours', row.id, fields);
  } },
  { method: 'POST', path: '/inbox/auto-rules', name: 'inbox_create_auto_rule', roles: ADMIN, summary: 'Create a paused draft-only reply rule', run(ctx, { body }) {
    return ctx.create('auto_rule', { ...ruleFields(ctx, body), enabled: false });
  } },
  { method: 'PATCH', path: '/inbox/auto-rules/:id', name: 'inbox_enable_auto_rule', roles: ADMIN, versionKind: 'auto_rule', summary: 'Edit, enable or pause a draft-only reply rule', run(ctx, { params, body }) {
    const row = active(ctx, 'auto_rule', params.id);
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return invalid('enabled');
    return ctx.update('auto_rule', row.id, { ...ruleFields(ctx, { ...row, ...body }), enabled: body.enabled ?? row.enabled });
  } },
  { method: 'GET', path: '/inbox/auto-rules/:id/runs', name: 'inbox_list_auto_rule_runs', roles: ADMIN, summary: 'List rule outcomes and skip reasons', run(ctx, { params }) {
    ctx.get('auto_rule', params.id);
    return ctx.list('auto_rule_run').filter(row => row.rule_id === params.id);
  } },
  { method: 'GET', path: '/inbox/auto-reply-review', name: 'inbox_list_auto_reply_review', roles: APPROVE, summary: 'List rule-generated drafts awaiting approval', run(ctx) {
    return ctx.list('reply_draft').filter(row => row.auto_rule_id && row.status === 'pending_approval');
  } },
  { method: 'POST', path: '/reply-drafts/:id/reject', name: 'inbox_reject_auto_reply', roles: APPROVE, versionKind: 'reply_draft', summary: 'Reject a rule-generated reply awaiting review', run(ctx, { params, body }) {
    const draft = ctx.get('reply_draft', params.id);
    if (!draft.auto_rule_id || draft.status !== 'pending_approval') return blocked('Rule-generated draft must be pending approval');
    const row = ctx.update('reply_draft', draft.id, { status: 'discarded', rejected_by: ctx.actorId, rejected_at: ctx.now, rejection_reason: text(body.reason, 'reason', 2000) });
    ctx.emit('inbox.reply_draft.rejected', { reply_draft_id: row.id, conversation_id: row.conversation_id });
    return row;
  } },
  { method: 'GET', path: '/reply-drafts/:id', name: 'inbox_get_reply_draft', roles: READ, summary: 'Read a reply draft and its review status', run(ctx, { params }) {
    const draft = ctx.get('reply_draft', params.id);
    const task = ctx.list('work_item').find(item => item.resource_type === 'reply_draft' && item.resource_id === draft.id && item.source_type === 'automation');
    return task ? { ...draft, work_item_id: task.id } : draft;
  } },
  { method: 'GET', path: '/conversations/:id/sla', name: 'inbox_get_conversation_sla', roles: READ, summary: 'Read assigned service targets and deadlines', run(ctx, { params }) {
    ctx.get('conversation', params.id);
    return ctx.list('conversation_sla').find(row => row.conversation_id === params.id) ?? null;
  } },
];
