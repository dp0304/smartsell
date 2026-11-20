import { type Context, type Data, type Input, type Row } from '@smartsell/contracts';
import { activeBrand, bool, brandScope, conflict, denied, id, inBrand, instant, invalid, isManager, limit, missing, nullable, obj, one, open, own, pick, resourcePair, stamp, str, strings, timestamp } from './shared.js';
import { follow, notify } from './notifications.js';

const types = ['todo', 'production_task', 'milestone', 'review_task', 'fix_task', 'followup'] as const;
const statuses = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
const priorities = ['urgent', 'high', 'normal', 'low'] as const;
const assigneeTypes = ['user', 'agent_client', 'team_queue'] as const;
const fields = {
  type: (v: unknown) => one(v, 'type', types), title: (v: unknown) => str(v, 'title'),
  description: nullable((v: unknown) => typeof v === 'string' ? str(v, 'description', 4096) : obj(v, 'description')),
  priority: (v: unknown) => one(v, 'priority', priorities), due_at: nullable(stamp),
  assignee_type: nullable((v: unknown) => one(v, 'assignee_type', assigneeTypes)), assignee_id: nullable(id),
  board_key: nullable(id), stage_key: nullable(id), sort_rank: nullable(id),
  brand_id: nullable(id), campaign_id: nullable(id), resource_type: nullable(id), resource_id: nullable(id), parent_id: nullable(id),
  blocked_reason: nullable((v: unknown) => str(v, 'blocked_reason', 1000)),
  completion_criteria: nullable((v: unknown) => obj(v, 'completion_criteria')),
};
export function canReadTask(ctx: Context, row: Row) {
  return ctx.role !== 'agent' || row.created_by_id === ctx.actorId || row.assignee_id === ctx.actorId;
}
export function getTask(ctx: Context, taskId: string) {
  const row = ctx.get('work_item', taskId);
  return canReadTask(ctx, row) ? row : missing('Work item');
}
export function listTasks(ctx: Context, { query }: Input) {
  const brand = brandScope(ctx, query.brand_id);
  const before = query.due_before === undefined ? Infinity : timestamp(instant(query.due_before, 'due_before'));
  const after = query.due_after === undefined ? -Infinity : timestamp(instant(query.due_after, 'due_after'));
  if (before < after) invalid('Invalid due range');
  const keys = ['type', 'status', 'resource_type', 'resource_id', 'campaign_id', 'priority'] as const;
  const assignee = query.assignee_id === 'me' ? ctx.actorId : query.assignee_id;
  const rows = ctx.list('work_item').filter(row => canReadTask(ctx, row) && inBrand(row, brand) &&
    (assignee === undefined || row.assignee_id === assignee) && keys.every(key => query[key] === undefined || row[key] === query[key]) &&
    ((before === Infinity && after === -Infinity) || (timestamp(row.due_at) <= before && timestamp(row.due_at) >= after)));
  return { total: rows.length, items: rows.sort((a, b) => (timestamp(a.due_at) || Infinity) - (timestamp(b.due_at) || Infinity) || a.id.localeCompare(b.id)).slice(0, limit(query.limit)) };
}

function validateLinks(ctx: Context, values: Data, taskId?: string) {
  if (typeof values.brand_id === 'string') activeBrand(ctx, values.brand_id);
  if (typeof values.campaign_id === 'string') {
    const campaign = ctx.get('campaign', values.campaign_id);
    if (campaign.brand_id != null && campaign.brand_id !== values.brand_id) missing('Campaign');
  }
  const seen = new Set(taskId ? [taskId] : []);
  let parent = values.parent_id;
  while (typeof parent === 'string') {
    if (seen.has(parent)) conflict('Work item parent cycle');
    seen.add(parent);
    const row = getTask(ctx, parent);
    if ((row.brand_id ?? null) !== (values.brand_id ?? null)) missing('Parent work item');
    parent = row.parent_id;
  }
  resourcePair(values);
  if ((values.assignee_type == null) !== (values.assignee_id == null)) invalid('assignee_type and assignee_id must be supplied together');
}

function history(ctx: Context, row: Row, kind: string, fromValue: unknown, toValue: unknown, note?: string) {
  ctx.create('work_item_event', { work_item_id: row.id, kind, from_value: fromValue ?? null, to_value: toValue ?? null, actor_id: ctx.actorId, ...(note ? { note } : {}) });
}
function assigned(ctx: Context, row: Row, previous?: Row) {
  history(ctx, row, 'assigned', previous?.assignee_id, row.assignee_id);
  ctx.emit('workspace.work_item.assigned', { work_item_id: row.id, assignee_id: row.assignee_id });
  if (row.assignee_type === 'user' && typeof row.assignee_id === 'string') {
    follow(ctx, row.assignee_id, 'work_item', row.id, 'assigned');
    if (row.assignee_id !== ctx.actorId) notify(ctx, row.assignee_id, 'assigned', 'Work item assigned', { resource_type: 'work_item', resource_id: row.id, work_item_id: row.id, dedupe_key: `assigned:${row.id}:${row.version}` });
  }
}

export function createTask(ctx: Context, { body }: Input) {
  const values = {
    type: 'todo', priority: 'normal', assignee_type: ctx.role === 'agent' ? 'agent_client' : 'user', assignee_id: ctx.actorId,
    ...pick(body, fields), title: str(body.title, 'title'), status: 'open', created_by_id: ctx.actorId,
    source_type: ctx.role === 'agent' ? 'agent' : 'manual',
    ...(ctx.role === 'agent' ? { source_ref: { agent_job_id: id(obj(body.source_ref, 'source_ref').agent_job_id) } } : {}),
  };
  if (!isManager(ctx) && (values.assignee_id !== ctx.actorId || values.assignee_type !== (ctx.role === 'agent' ? 'agent_client' : 'user'))) denied();
  if (ctx.role === 'agent') {
    const job = ctx.get('agent_job', (values.source_ref as { agent_job_id: string }).agent_job_id);
    if (![job.agent_client_id, job.created_by_id, job.assignee_id].includes(ctx.actorId)) missing('Agent job');
  }
  validateLinks(ctx, values);
  const row = ctx.create('work_item', values);
  ctx.emit('workspace.work_item.created', { work_item_id: row.id });
  if (ctx.role !== 'agent') follow(ctx, ctx.actorId, 'work_item', row.id, 'created');
  if (row.assignee_id != null) assigned(ctx, row);
  return row;
}

const transitions: Record<string, readonly string[]> = {
  open: ['in_progress', 'blocked', 'cancelled'], in_progress: ['blocked', 'done', 'cancelled'],
  blocked: ['in_progress', 'cancelled'], done: ['open'], cancelled: [],
};
function transition(previous: Row, values: Data, next: string, patch: Data, ctx: Context) {
  if (next === previous.status) return;
  if (!transitions[String(previous.status)]?.includes(next)) conflict('Invalid work item status transition');
  if (previous.source_type === 'event') conflict('Resolve the source event to change this work item status');
  if (previous.source_type === 'manual_external' && (next === 'done' || previous.status === 'blocked' && next === 'in_progress')) {
    conflict('Record provider readback through the external task receipt');
  }
  if (next === 'blocked') str(values.blocked_reason, 'blocked_reason', 1000);
  else patch.blocked_reason = null;
  if (next === 'done' || next === 'in_progress') {
    const pending = ctx.list('work_item_dependency').filter(row => row.work_item_id === previous.id && ctx.get('work_item', id(row.depends_on_id)).status !== 'done');
    if (pending.length) conflict('Work item has unfinished prerequisites');
  }
  if (next === 'done') Object.assign(patch, { completed_at: ctx.now, completed_by_type: ctx.role === 'agent' ? 'agent_client' : 'user', completed_by_id: ctx.actorId });
  if (next === 'open') Object.assign(patch, { completed_at: null, completed_by_type: null, completed_by_id: null });
  patch.status = next;
}

function prepareTaskPatch(ctx: Context, previous: Row, body: Data, next?: string) {
  if (previous.type === 'agent_task' || previous.resource_type === 'agent_job' && previous.source_type === 'automation') conflict('Agent task changes belong to the agent module');
  if (!isManager(ctx) && (previous.assignee_id !== ctx.actorId || ['assignee_id', 'assignee_type', 'due_at', 'brand_id'].some(key => Object.hasOwn(body, key)))) denied();
  const patch = pick(body, fields);
  if (previous.source_type === 'event' && ['resource_id', 'resource_type', 'type'].some(key => Object.hasOwn(patch, key))) conflict('Event work item source cannot be changed');
  const values = { ...previous, ...patch };
  validateLinks(ctx, values, previous.id);
  if (next !== undefined) transition(previous, values, next, patch, ctx);
  return patch;
}
function applyTaskPatch(ctx: Context, previous: Row, patch: Data, note?: string) {
  if (!Object.keys(patch).length) return previous;
  const row = ctx.update('work_item', previous.id, patch);
  if (previous.assignee_id !== row.assignee_id || previous.assignee_type !== row.assignee_type) {
    assigned(ctx, row, previous);
    if (note) history(ctx, row, 'handed_over', previous.assignee_id, row.assignee_id, note);
  }
  if (previous.due_at !== row.due_at) history(ctx, row, 'due_changed', previous.due_at, row.due_at);
  if (previous.status !== row.status) {
    history(ctx, row, 'status_changed', previous.status, row.status);
    ctx.emit('workspace.work_item.status_changed', { work_item_id: row.id, status: row.status });
    if (row.status === 'done') ctx.emit('workspace.work_item.completed', { work_item_id: row.id });
  }
  return row;
}
export function updateTask(ctx: Context, { body, params }: Input, status?: string) {
  const previous = getTask(ctx, params.id!);
  return applyTaskPatch(ctx, previous, prepareTaskPatch(ctx, previous, body, status ?? (body.status === undefined ? undefined : one(body.status, 'status', statuses))));
}
export function handover(ctx: Context, { body, params }: Input) {
  const previous = getTask(ctx, params.id!);
  if (!open(previous)) conflict('Only open work items can be handed over');
  const updates = { assignee_type: one(body.assignee_type ?? 'user', 'assignee_type', assigneeTypes), assignee_id: id(body.assignee_id) };
  return applyTaskPatch(ctx, previous, prepareTaskPatch(ctx, previous, updates), str(body.note, 'note', 1000));
}
export function handoverCandidates(ctx: Context, userId: string) {
  return ctx.list('work_item').filter(row => row.assignee_id === userId && row.assignee_type === 'user' &&
    open(row) && row.type !== 'agent_task' && row.source_type !== 'event');
}

export function transferAcceptedTasks(ctx: Context, from: string, to: string, items: readonly { kind: string; id: string }[]) {
  if (to !== ctx.actorId) denied();
  const candidates = new Map(handoverCandidates(ctx, from).map(row => [row.id, row]));
  const selected = items.map(item => {
    const row = item.kind === 'work_item' && candidates.get(item.id);
    if (!row) return conflict('The work item changed after the handover was prepared');
    return row;
  });
  for (const row of selected) applyTaskPatch(ctx, row, { assignee_type: 'user', assignee_id: to }, 'Accepted team handover');
}

export function batchTasks(ctx: Context, { body }: Input) {
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) return invalid('items must contain 1 to 100 entries');
  const dryRun = body.dry_run === undefined ? true : bool(body.dry_run, 'dry_run');
  const seen = new Set<string>();
  const changes = body.items.map(value => {
    const entry = obj(value, 'item');
    const row = getTask(ctx, id(entry.id));
    if (seen.has(row.id)) invalid('Duplicate work item');
    seen.add(row.id);
    if (entry.expected_version !== row.version) conflict('Work item version has changed', { id: row.id });
    const patch = obj(entry.patch, 'patch');
    // Parent relationships must be validated against each committed predecessor, not a shared pre-batch graph.
    if (Object.hasOwn(patch, 'parent_id')) invalid('Change parent through the single-item endpoint');
    return { row, patch: prepareTaskPatch(ctx, row, patch, patch.status === undefined ? undefined : one(patch.status, 'status', statuses)) };
  });
  return { dry_run: dryRun, items: changes.map(({ row, patch }) => dryRun ? { id: row.id, patch } : applyTaskPatch(ctx, row, patch)) };
}

export function addDependencies(ctx: Context, { body, params }: Input) {
  const row = getTask(ctx, params.id!);
  prepareTaskPatch(ctx, row, {});
  if (row.status !== 'open' && row.status !== 'blocked') conflict('Dependencies can only be changed before work starts');
  const inputs = strings(body.depends_on_ids, 'depends_on_ids');
  const edges = ctx.list('work_item_dependency');
  const current = edges.filter(edge => edge.work_item_id === row.id);
  const reachable = new Set<string>();
  const stack = [...inputs];
  while (stack.length) {
    const next = stack.pop()!;
    if (next === row.id) conflict('Work item dependency cycle');
    if (reachable.has(next)) continue;
    reachable.add(next);
    const reference = getTask(ctx, next);
    if ((reference.brand_id ?? null) !== (row.brand_id ?? null)) missing('Work item');
    stack.push(...edges.filter(edge => edge.work_item_id === next).map(edge => id(edge.depends_on_id)));
  }
  for (const edge of current) if (!inputs.includes(id(edge.depends_on_id))) ctx.remove('work_item_dependency', edge.id);
  for (const input of inputs) if (!current.some(edge => edge.depends_on_id === input)) ctx.create('work_item_dependency', { work_item_id: row.id, depends_on_id: input, kind: 'finish_to_start' });
  const updated = ctx.update('work_item', row.id, {});
  return { work_item: updated, depends_on_ids: inputs };
}
