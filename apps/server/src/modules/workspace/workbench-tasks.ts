import type { Context, Entity, Fields } from '../types.js';
import { action, add, brandFilter, browse, choice, emit, expected, fields, identifier, inBrand, instant, iso, isManager, list, listLimit, manage, must, nullable, obj, openTask, problems, put, str } from './workbench-core.js';
import { notify, subscribe } from './workbench-events.js';

const types = ['todo', 'production_task', 'milestone', 'review_task', 'fix_task', 'followup'] as const;
const statuses = ['open', 'in_progress', 'blocked', 'done', 'cancelled'] as const;
const priorities = ['urgent', 'high', 'normal', 'low'] as const;
const assignees = ['user', 'agent_client', 'team_queue'] as const;
const taskFields = {
  title: (v: unknown) => str(v, 'title'), type: (v: unknown) => choice(v, 'type', types),
  description: nullable(v => typeof v === 'string' ? str(v, 'description', 8000) : obj(v, 'description')),
  priority: (v: unknown) => choice(v, 'priority', priorities),
  due_at: nullable(v => iso(v, 'due_at')), assignee_id: nullable(identifier),
  assignee_type: nullable(v => choice(v, 'assignee_type', assignees)),
  brand_id: nullable(identifier), campaign_id: nullable(identifier), resource_id: nullable(identifier), resource_type: nullable(identifier),
  parent_id: nullable(identifier), board_key: nullable(identifier), stage_key: nullable(identifier), sort_rank: nullable(identifier),
  blocked_reason: nullable(v => str(v, 'blocked_reason', 1000)),
  completion_criteria: nullable(v => obj(v, 'completion_criteria')),
};

export async function taskList(ctx: Context, input: Fields) {
  const brand = await brandFilter(ctx, input.brand_id);
  const assignee = input.assignee_id === 'me' ? ctx.actorId : input.assignee_id;
  const from = input.due_after === undefined ? -Infinity : instant(iso(input.due_after, 'due_after'));
  const to = input.due_before === undefined ? Infinity : instant(iso(input.due_before, 'due_before'));
  if (from > to) problems.invalid('Invalid due date range');
  const filters = ['type', 'status', 'priority', 'resource_type', 'resource_id', 'campaign_id'];
  const rows = (await list(ctx, 'work_item')).filter(row => inBrand(row, brand) &&
    (assignee === undefined || row.data.assignee_id === assignee) && filters.every(k => input[k] === undefined || row.data[k] === input[k]) &&
    ((from === -Infinity && to === Infinity) || (instant(row.data.due_at) >= from && instant(row.data.due_at) <= to)));
  rows.sort((a, b) => (a.data.due_at ?? '￿').localeCompare(b.data.due_at ?? '￿') || a.id.localeCompare(b.id));
  return { total: rows.length, items: rows.slice(0, listLimit(input.limit)) };
}

async function links(ctx: Context, values: Fields, taskId?: string) {
  if (values.brand_id && (await must(ctx, 'brand', values.brand_id)).data.status === 'archived') problems.conflict('Brand is archived');
  if (values.campaign_id) {
    const campaign = await ctx.get('campaign', 'campaign', values.campaign_id);
    if (!campaign || (campaign.data.brand_id && campaign.data.brand_id !== values.brand_id)) problems.missing('Campaign not found');
  }
  if ((values.resource_id == null) !== (values.resource_type == null)) problems.invalid('Supply both resource_type and resource_id');
  if ((values.assignee_id == null) !== (values.assignee_type == null)) problems.invalid('Supply both assignee_id and assignee_type');
  const seen = new Set(taskId ? [taskId] : []);
  for (let parent = values.parent_id; parent;) {
    if (seen.has(parent)) problems.conflict('Work item parent cycle');
    const item = await must(ctx, 'work_item', parent);
    if ((item.data.brand_id ?? null) !== (values.brand_id ?? null)) problems.missing('Parent work item not found');
    seen.add(parent);
    parent = item.data.parent_id;
  }
}

async function history(ctx: Context, id: string, kind: string, from: unknown, to: unknown, note?: string) {
  await add(ctx, 'work_item_event', { work_item_id: id, kind, from_value: from ?? null, to_value: to ?? null, actor_id: ctx.actorId, ...(note ? { note } : {}) });
}
async function assignment(ctx: Context, row: Entity, previous?: Entity) {
  await history(ctx, row.id, 'assigned', previous?.data.assignee_id, row.data.assignee_id);
  await emit(ctx, 'work_item.assigned', { work_item_id: row.id, assignee_id: row.data.assignee_id });
  if (row.data.assignee_type === 'user') {
    const user = row.data.assignee_id as string;
    await subscribe(ctx, user, 'work_item', row.id, 'assigned');
    if (user !== ctx.actorId) await notify(ctx, user, 'assigned', 'Work item assigned', `assignment:${row.id}:${row.version}`, { work_item_id: row.id, brand_id: row.data.brand_id ?? null });
  }
}
async function create(ctx: Context, input: Fields) {
  const values: Fields = { type: 'todo', priority: 'normal', assignee_id: ctx.actorId, assignee_type: 'user', ...fields(input, taskFields),
    title: str(input.title, 'title'), status: 'open', created_by_id: ctx.actorId, source_type: 'manual' };
  if (values.assignee_id !== ctx.actorId && !isManager(ctx)) problems.denied();
  if (!isManager(ctx) && values.assignee_type !== 'user') problems.denied();
  await links(ctx, values);
  const row = await add(ctx, 'work_item', values);
  await emit(ctx, 'work_item.created', { work_item_id: row.id });
  await subscribe(ctx, ctx.actorId, 'work_item', row.id, 'created');
  if (row.data.assignee_id) await assignment(ctx, row);
  return row;
}

const transitions: Record<string, readonly string[]> = {
  open: ['in_progress', 'blocked', 'cancelled'], in_progress: ['done', 'blocked', 'cancelled'],
  blocked: ['in_progress', 'cancelled'], done: ['open'], cancelled: [],
};
async function prepare(ctx: Context, row: Entity, input: Fields) {
  if (row.data.source_type === 'agent' && row.data.resource_type === 'agent_job') problems.conflict('Use the agent job operation');
  if (!isManager(ctx) && (row.data.assignee_id !== ctx.actorId || ['assignee_id', 'assignee_type', 'due_at', 'brand_id'].some(k => Object.hasOwn(input, k)))) problems.denied();
  const patch = fields(input, taskFields);
  if (row.data.source_type === 'event' && ['resource_id', 'resource_type', 'type'].some(k => Object.hasOwn(patch, k))) problems.conflict('Cannot change an event task source');
  const values = { ...row.data, ...patch };
  await links(ctx, values, row.id);
  if (input.status === undefined || input.status === row.data.status) return patch;
  const next = choice(input.status, 'status', statuses);
  if (!transitions[row.data.status]?.includes(next) || row.data.source_type === 'event') problems.conflict('Invalid work item transition');
  if (next === 'blocked') str(values.blocked_reason, 'blocked_reason');
  else patch.blocked_reason = null;
  if (next === 'done' || next === 'in_progress') {
    const edges = (await list(ctx, 'work_item_dependency')).filter(edge => edge.data.work_item_id === row.id && edge.data.active !== false);
    for (const edge of edges) if ((await must(ctx, 'work_item', edge.data.depends_on_id)).data.status !== 'done') problems.conflict('Work item has unfinished prerequisites');
  }
  if (next === 'done') Object.assign(patch, { completed_at: ctx.now, completed_by_type: 'user', completed_by_id: ctx.actorId });
  if (next === 'open') Object.assign(patch, { completed_at: null, completed_by_type: null, completed_by_id: null });
  return { ...patch, status: next };
}
export async function applyTaskChange(ctx: Context, row: Entity, patch: Fields, note?: string) {
  if (!Object.keys(patch).length) return row;
  const next = await put(ctx, row, patch);
  if (row.data.assignee_id !== next.data.assignee_id || row.data.assignee_type !== next.data.assignee_type) {
    await assignment(ctx, next, row);
    if (note) await history(ctx, row.id, 'handed_over', row.data.assignee_id, next.data.assignee_id, note);
  }
  if (row.data.due_at !== next.data.due_at) await history(ctx, row.id, 'due_changed', row.data.due_at, next.data.due_at);
  if (row.data.status !== next.data.status) {
    await history(ctx, row.id, 'status_changed', row.data.status, next.data.status);
    await emit(ctx, 'work_item.status_changed', { work_item_id: row.id, status: next.data.status });
    if (next.data.status === 'done') await emit(ctx, 'work_item.completed', { work_item_id: row.id, completed_by_type: next.data.completed_by_type });
  }
  return next;
}
async function update(ctx: Context, input: Fields) {
  const row = await must(ctx, 'work_item', identifier(input.id));
  expected(row, input);
  return applyTaskChange(ctx, row, await prepare(ctx, row, input));
}
async function batch(ctx: Context, input: Fields) {
  if (!Array.isArray(input.items) || input.items.length < 1 || input.items.length > 100) problems.invalid('Supply 1 to 100 work items');
  if (input.dry_run !== undefined && typeof input.dry_run !== 'boolean') problems.invalid('Invalid dry_run');
  const changes: { row: Entity; patch: Fields }[] = [];
  const seen = new Set<string>();
  for (const value of input.items as unknown[]) {
    const entry = obj(value, 'item');
    const row = await must(ctx, 'work_item', identifier(entry.id));
    if (seen.has(row.id)) problems.invalid('Duplicate work item');
    seen.add(row.id);
    expected(row, entry);
    const patch = obj(entry.patch, 'patch');
    if (Object.hasOwn(patch, 'parent_id') || Object.hasOwn(patch, 'brand_id') || Object.hasOwn(patch, 'status')) problems.invalid('Change hierarchy, brand, and status through single-item operations');
    changes.push({ row, patch: await prepare(ctx, row, patch) });
  }
  const dry_run = input.dry_run !== false;
  const items = [];
  for (const { row, patch } of changes) items.push(dry_run ? { id: row.id, patch } : await applyTaskChange(ctx, row, patch));
  return { dry_run, items };
}
async function dependencies(ctx: Context, input: Fields) {
  const row = await must(ctx, 'work_item', identifier(input.id));
  expected(row, input);
  if (!['open', 'blocked'].includes(row.data.status)) problems.conflict('Dependencies can only change before work starts');
  if (!Array.isArray(input.depends_on_ids) || input.depends_on_ids.length > 100) problems.invalid('Invalid depends_on_ids');
  const ids = [...new Set<string>((input.depends_on_ids as unknown[]).map(identifier))];
  const edges = await list(ctx, 'work_item_dependency');
  const seen = new Set<string>();
  const pending = [...ids];
  while (pending.length) {
    const id = pending.pop()!;
    if (id === row.id) problems.conflict('Work item dependency cycle');
    if (seen.has(id)) continue;
    seen.add(id);
    const dependency = await must(ctx, 'work_item', id);
    if ((dependency.data.brand_id ?? null) !== (row.data.brand_id ?? null)) problems.missing('Work item not found');
    pending.push(...edges.filter(edge => edge.data.active !== false && edge.data.work_item_id === id).map(edge => edge.data.depends_on_id as string));
  }
  for (const edge of edges.filter(edge => edge.data.work_item_id === row.id)) {
    const active = ids.includes(edge.data.depends_on_id);
    if (active !== (edge.data.active !== false)) await put(ctx, edge, { active });
  }
  for (const id of ids) if (!edges.some(edge => edge.data.work_item_id === row.id && edge.data.depends_on_id === id)) await add(ctx, 'work_item_dependency', { work_item_id: row.id, depends_on_id: id, active: true });
  return { work_item: await put(ctx, row, {}), depends_on_ids: ids };
}

export const taskQueries = {
  list_work_items: action(browse, taskList),
  get_work_item: action(browse, (ctx, input) => must(ctx, 'work_item', identifier(input.id))),
};
export const taskCommands = {
  create_work_item: action(browse, create),
  update_work_item: action(browse, update),
  complete_work_item: action(browse, (ctx, input) => update(ctx, { id: input.id, expected_version: input.expected_version ?? input.version, status: 'done' })),
  reopen_work_item: action(browse, (ctx, input) => update(ctx, { id: input.id, expected_version: input.expected_version ?? input.version, status: 'open' })),
  handover_work_item: action(manage, async (ctx, input) => {
    const row = await must(ctx, 'work_item', identifier(input.id));
    expected(row, input);
    if (!openTask(row)) problems.conflict('Only open work items can be handed over');
    const assignee_id = identifier(input.assignee_id);
    const note = str(input.note, 'note', 1000);
    if (row.data.assignee_id === assignee_id && row.data.assignee_type === 'user') problems.invalid('Select a different assignee');
    return applyTaskChange(ctx, row, await prepare(ctx, row, { assignee_id, assignee_type: 'user' }), note);
  }),
  batch_work_items: action(manage, batch),
  set_work_item_dependencies: action(manage, dependencies),
};
