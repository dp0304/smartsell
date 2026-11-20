import { APPROVE, Problem, READ, WRITE, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { array, checkVersion, conflict, integer, object, text } from './input.js';
import { assertAgentLease, getVisibleJob, getVisibleResource, resourceRef } from './jobs.js';
import { getTask, updateTask } from '../workspace/tasks.js';

function documentText(node: unknown, depth = 0): string {
  if (!node || typeof node !== 'object' || depth > 30) return '';
  const value = node as Data;
  if (value.type === 'text') return typeof value.text === 'string' ? value.text : '';
  if (value.type === 'hardBreak') return '\n';
  if (!Array.isArray(value.content)) return '';
  const blocks = ['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote'];
  return value.content.map((child) => documentText(child, depth + 1)).join(blocks.includes(String(value.type)) ? '\n' : '');
}

/** Host-owned draft operations only. Resolve checks resource visibility using the current actor. */
export interface ChangeTarget {
  read(ctx: Context, id: string): Row;
  validate(ctx: Context, row: Row, patch: Data): Data;
  canApply(ctx: Context, row: Row): boolean;
  apply(ctx: Context, id: string, expectedVersion: number, patch: Data): Row | Promise<Row>;
}
export type ChangeTargets = Readonly<Record<string, ChangeTarget>>;
export interface ChangeContext extends Context { agentChangeTargets?: ChangeTargets }

const kind = 'change_set';

const defaultTargets: ChangeTargets = {
  work_item: {
    read: getTask,
    validate(_ctx, row, patch) {
      if (row.type === 'agent_task') conflict('Agent task changes belong to the Agent job lifecycle');
      if (Object.keys(patch).length !== 1 || !Object.hasOwn(patch, 'title')) throw new Problem(400, 'INVALID_INPUT', 'Only the work item title is editable');
      return { title: text(patch.title, 'title', 300) };
    },
    canApply: (ctx) => ['owner', 'admin', 'manager'].includes(ctx.role),
    apply(ctx, id, expectedVersion, body) {
      checkVersion(getTask(ctx, id), expectedVersion);
      return updateTask(ctx, { params: { id }, expectedVersion, body, query: {} });
    },
  },
};

/** Add supported content drafts only when their owning operations are registered. */
export function createAgentChangeTargets(registered: readonly Operation[]): ChangeTargets {
  const targets = { ...defaultTargets } as Record<string, ChangeTarget>;
  const definitions = [
    { kind: 'content_item', operation: 'content_item_update', field: 'title', max: 250 },
    { kind: 'content_variant', operation: 'content_update_variant', field: 'body_markdown', max: 20_000 },
  ];
  for (const { kind, operation, field, max } of definitions) {
    const owning = registered.find((entry) => entry.name === operation && entry.versionKind === kind);
    if (!owning) continue;
    targets[kind] = {
      read(ctx, id) {
        const row = getVisibleResource(ctx, kind, id);
        if (kind !== 'content_variant') return row;
        getVisibleResource(ctx, 'content_item', String(row.content_item_id));
        return { ...row, body_markdown: documentText((row.draft_doc as Data | undefined)?.body_doc) };
      },
      validate(_ctx, _row, patch) {
        if (Object.keys(patch).length !== 1 || !Object.hasOwn(patch, field)) throw new Problem(400, 'INVALID_INPUT', `Only ${field} is editable`);
        return { [field]: text(patch[field], field, max) };
      },
      canApply: (ctx) => owning.roles.includes(ctx.role),
      async apply(ctx, id, expectedVersion, body) {
        checkVersion(ctx.get(kind, id), expectedVersion);
        return await owning.run(ctx, { params: { id }, expectedVersion, body, query: {} }) as Row;
      },
    };
  }
  return targets;
}

function target(ctx: Context, key: unknown): ChangeTarget {
  const targets = (ctx as ChangeContext).agentChangeTargets ?? defaultTargets;
  if (typeof key !== 'string' || !targets || !Object.hasOwn(targets, key)) {
    throw new Problem(400, 'UNSUPPORTED_CHANGE_TARGET', 'This target is unavailable for reviewed draft updates');
  }
  return targets[key]!;
}

function items(ctx: Context, id: string): Row[] {
  return ctx.list('change_set_item').filter((item) => item.change_set_id === id);
}

function visible(ctx: Context, row: Row, entries = items(ctx, row.id)): Row[] {
  for (const entry of entries) target(ctx, entry.target_type).read(ctx, String(entry.target_id));
  if (row.agent_job_id) getVisibleJob(ctx, String(row.agent_job_id));
  for (const source of array(row.sources ?? [], 'sources')) {
    const { kind: refKind, id } = object(source, 'source');
    getVisibleResource(ctx, String(refKind), String(id));
  }
  return entries;
}

export function createChangeSet(ctx: Context, body: Data): Row & { items: Row[] } {
  const job = body.agent_job_id === undefined ? null : getVisibleJob(ctx, text(body.agent_job_id, 'agent_job_id'));
  if (job) {
    assertAgentLease(ctx, job, body);
    if (job.cancel_requested_at) conflict('The job is being cancelled');
  }
  const seen = new Set<string>();
  const entries = array(body.items, 'items', 25).map((value, index) => {
    const item = object(value, 'item');
    const type = text(item.target_type, 'target_type');
    const id = text(item.target_id, 'target_id');
    if ((item.operation ?? 'update') !== 'update') throw new Problem(400, 'UNSUPPORTED_CHANGE_OPERATION', 'Only reviewed draft updates are supported');
    const key = `${type}:${id}`;
    if (seen.has(key)) throw new Problem(400, 'DUPLICATE_CHANGE_TARGET', 'A target may appear only once in a change set');
    seen.add(key);
    const adapter = target(ctx, type);
    const row = adapter.read(ctx, id);
    const version = integer(item.expected_version, 'expected_version');
    if (job && !array(object(job.input_scope, 'input_scope').resource_refs ?? [], 'resource_refs').some(value => {
      const ref = object(value, 'resource_ref');
      return ref.kind === type && ref.id === id && ref.version === version;
    })) throw new Problem(403, 'FORBIDDEN', 'The change is outside the leased job’s version-pinned scope');
    checkVersion(row, version);
    const patch = adapter.validate(ctx, row, object(item.patch, 'patch'));
    if (!Object.keys(patch).length) throw new Problem(400, 'INVALID_INPUT', 'Change patch cannot be empty');
    return {
      target_type: type, target_id: row.id, expected_version: version, operation: 'update', seq: index + 1,
      patch, preview: Object.fromEntries(Object.entries(patch).map(([field, after]) => [field, { before: row[field] ?? null, after }])), status: 'pending',
    };
  });
  if (!entries.length) throw new Problem(400, 'INVALID_INPUT', 'A change set needs at least one item');
  const set = ctx.create(kind, {
    title: text(body.title, 'title'), rationale: body.rationale === undefined ? null : text(body.rationale, 'rationale', 4000),
    agent_job_id: job?.id ?? null, brand_id: job?.brand_id ?? null, review_mode: 'human', ai_generated: true, status: 'pending', created_by: ctx.actorId,
    sources: array(body.sources ?? [], 'sources').map((value) => resourceRef(ctx, value)),
  });
  const saved = entries.map((entry) => ctx.create('change_set_item', { ...entry, change_set_id: set.id, brand_id: set.brand_id }));
  ctx.emit('agent.change_set.submitted', { change_set_id: set.id });
  return { ...set, items: saved };
}

export const changeOperations: Operation[] = [
  { method: 'POST', path: '/change-sets', name: 'change_sets_create', roles: WRITE, summary: 'Submit a version-pinned draft change set', run: (ctx, { body }) => createChangeSet(ctx, body) },
  { method: 'GET', path: '/change-sets/:id', name: 'change_sets_get', roles: READ, summary: 'Review field-by-field draft differences', run(ctx, { params }) {
    const set = ctx.get(kind, params.id!);
    return { ...set, items: visible(ctx, set) };
  } },
  { method: 'POST', path: '/change-sets/:id/apply', name: 'change_sets_apply', roles: APPROVE, summary: 'Apply selected reviewed changes using owning services', versionKind: kind, async run(ctx, input) {
    const set = ctx.get(kind, input.params.id!);
    checkVersion(set, input.expectedVersion);
    if (!['pending', 'partial', 'stale'].includes(String(set.status))) conflict('The change set is no longer reviewable');
    const all = visible(ctx, set);
    const pending = all.filter((item) => item.status === 'pending');
    function select(value: unknown, field: string) {
      return [...new Set(array(value, field, 25).map((seq) => integer(seq, 'seq', 1, 25)))].map((seq) => {
        const item = pending.find((entry) => entry.seq === seq);
        if (!item) conflict('Selected change is not pending');
        return item;
      });
    }
    const skipped = select(input.body.skip_item_seqs ?? [], 'skip_item_seqs');
    const selection = input.body.item_seqs === undefined ? pending.filter((item) => !skipped.includes(item)) : select(input.body.item_seqs, 'item_seqs');
    if (selection.some(item => skipped.includes(item))) throw new Problem(400, 'INVALID_INPUT', 'A change cannot be applied and skipped');
    if (!selection.length && !skipped.length) conflict('There are no pending selected changes');
    const checked = selection.map((item) => {
      const adapter = target(ctx, item.target_type);
      const row = adapter.read(ctx, String(item.target_id));
      if (!adapter.canApply(ctx, row)) throw new Problem(403, 'APPROVAL_REQUIRED', 'The reviewer lacks permission to update a target');
      return { item, row, adapter, patch: row.version === item.expected_version ? adapter.validate(ctx, row, object(item.patch, 'patch')) : null };
    });
    const outcomes = new Map<string, Row>();
    for (const { item, row, adapter, patch } of checked) {
      if (!patch) {
        outcomes.set(item.id, ctx.update('change_set_item', item.id, { status: 'conflict', result: { current_version: row.version } }));
      } else {
        const applied = await adapter.apply(ctx, row.id, integer(item.expected_version, 'expected_version'), patch);
        outcomes.set(item.id, ctx.update('change_set_item', item.id, { status: 'applied', result: { id: applied.id, version: applied.version } }));
      }
    }
    for (const item of skipped) outcomes.set(item.id, ctx.update('change_set_item', item.id, { status: 'skipped' }));
    const updatedItems = all.map((item) => outcomes.get(item.id) ?? item);
    const hasApplied = updatedItems.some((item) => item.status === 'applied');
    const complete = updatedItems.every((item) => item.status === 'applied' || item.status === 'skipped');
    const status = complete ? (hasApplied ? 'applied' : 'rejected') :
      hasApplied || updatedItems.some((item) => item.status === 'pending') ? 'partial' : 'stale';
    const updated = ctx.update(kind, set.id, { status, reviewed_by_user_id: ctx.actorId, reviewed_at: ctx.now });
    ctx.emit(`agent.change_set.${status === 'partial' ? 'partially_applied' : status}`, { change_set_id: set.id });
    return { ...updated, items: updatedItems };
  } },
  { method: 'POST', path: '/change-sets/:id/reject', name: 'change_sets_reject', roles: APPROVE, summary: 'Reject pending changes with a reason', versionKind: kind, run(ctx, input) {
    const set = ctx.get(kind, input.params.id!);
    checkVersion(set, input.expectedVersion);
    if (!['pending', 'partial', 'stale'].includes(String(set.status))) conflict('The change set is no longer reviewable');
    const reason = text(input.body.reason, 'reason', 4000);
    const rejected = visible(ctx, set).map((item) => ['pending', 'conflict'].includes(String(item.status)) ? ctx.update('change_set_item', item.id, { status: 'rejected' }) : item);
    const updated = ctx.update(kind, set.id, {
      status: rejected.some((item) => item.status === 'applied') ? 'applied' : 'rejected', review_reason: reason, reviewed_by_user_id: ctx.actorId, reviewed_at: ctx.now,
    });
    ctx.emit('agent.change_set.rejected', { change_set_id: set.id });
    return { ...updated, items: rejected };
  } },
];
