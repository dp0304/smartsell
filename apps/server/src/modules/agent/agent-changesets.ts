import { DomainError, readers, required, reviewers, text, writers, type Commands, type Context, type Entity, type Fields } from '../types.js';
import { taskCommands as workspace } from '../workspace/workbench-tasks.js';
import { requireAgentLease, type AgentContext } from './agent-jobs.js';
import { agentModule, array, command, conflict, id, integer, invalid, object } from './agent-validation.js';

const setKind = 'change_set';
const itemKind = 'change_set_item';
const targets = [
  { module: 'workspace', kind: 'work_item', operations: workspace, action: 'update_work_item' },
] as const;

function targetOf(input: unknown) {
  const inputTarget = object(input, 'target');
  const target = targets.find(entry => entry.module === inputTarget.module && entry.kind === inputTarget.kind);
  if (!target) invalid('target');
  return { target, targetId: id(inputTarget.id) };
}

function reviewAuthority(ctx: AgentContext) {
  if (ctx.agentClientId) throw new DomainError('forbidden', 'Review requires an interactive member', 403);
}

async function setFor(ctx: Context, input: Fields) {
  return required(ctx, agentModule, setKind, id(input.change_set_id));
}

async function itemsFor(ctx: Context, set: Entity) {
  return (await ctx.list(agentModule, itemKind)).filter(item => item.data.change_set_id === set.id)
    .sort((first, second) => first.data.seq - second.data.seq);
}

async function changeStatus(ctx: Context, set: Entity, patch: Fields, event: string) {
  const updated = await ctx.update(agentModule, setKind, set.id, patch, set.version);
  await ctx.emit(`agent.change_set.${event}`, { change_set_id: set.id, status: updated.data.status, actor_id: ctx.actorId });
  return updated;
}

export const changeSetCommands: Commands = {
  change_sets_create: command(writers, async (ctx, input) => {
    const title = text(input, 'title', 200);
    const rationale = text(input, 'rationale', 4000);
    const job = input.agent_job_id == null ? null : await requireAgentLease(ctx, input.agent_job_id, input.fencing_token);
    const supplied = array(input.items, 'items');
    if (!supplied.length) invalid('items');
    const sources = [];
    for (const source of array(input.sources ?? [], 'sources')) {
      const { target, targetId } = targetOf(source);
      const row = await required(ctx, target.module, target.kind, targetId);
      sources.push({ module: row.module, kind: row.kind, id: row.id, version: row.version });
    }
    const items = [];
    const seen = new Set<string>();
    for (const candidate of supplied) {
      const item = object(candidate, 'item');
      if (item.operation !== 'update') invalid('operation');
      const { target, targetId } = targetOf(item.target);
      const key = JSON.stringify([target.module, target.kind, targetId]);
      if (seen.has(key)) invalid('duplicate target');
      seen.add(key);
      const patch = object(item.patch, 'patch');
      if (Object.keys(patch).length !== 1 || !Object.hasOwn(patch, 'title')) invalid('patch');
      const nextTitle = text(patch, 'title', 200);
      const expectedVersion = integer(item.expected_version, 'expected_version');
      const row = await required(ctx, target.module, target.kind, targetId);
      if (row.data.source_type === 'agent' && row.data.resource_type === 'agent_job') invalid('target');
      if (row.version !== expectedVersion) throw new DomainError('version_conflict', 'Target changed before preview', 409);
      items.push({ seq: items.length + 1, target: { module: target.module, kind: target.kind, id: targetId },
        operation: 'update', expected_version: expectedVersion, patch: { title: nextTitle },
        preview: { title: { before: row.data.title, after: nextTitle } }, status: 'pending' });
    }
    const set = await ctx.insert(agentModule, setKind, { title, rationale, sources, status: 'pending',
      created_by: ctx.actorId, agent_job_id: job?.id ?? null, approved_by: null, approved_at: null });
    const rows = [];
    for (const item of items) rows.push(await ctx.insert(agentModule, itemKind, { ...item, change_set_id: set.id }));
    await ctx.emit('agent.change_set.submitted', { change_set_id: set.id, count: rows.length });
    return { change_set: set, items: rows };
  }),
  change_sets_get: command(readers, async (ctx, input) => {
    const set = await setFor(ctx, input);
    return { change_set: set, items: await itemsFor(ctx, set) };
  }),
  change_sets_approve: command(reviewers, async (ctx, input) => {
    reviewAuthority(ctx);
    const set = await setFor(ctx, input);
    if (set.data.status !== 'pending' || set.data.approved_by) conflict('Change set is not awaiting approval');
    if (integer(input.expected_version, 'expected_version') !== set.version) throw new DomainError('version_conflict', 'Change set changed since review', 409);
    return changeStatus(ctx, set, { approved_by: ctx.actorId, approved_at: ctx.now }, 'approved');
  }),
  change_sets_reject: command(reviewers, async (ctx, input) => {
    reviewAuthority(ctx);
    const set = await setFor(ctx, input);
    if (set.data.status !== 'pending') conflict('Only pending change sets can be rejected');
    if (integer(input.expected_version, 'expected_version') !== set.version) throw new DomainError('version_conflict', 'Change set changed since review', 409);
    const reason = text(input, 'reason', 2000);
    for (const item of await itemsFor(ctx, set)) await ctx.update(agentModule, itemKind, item.id, { status: 'rejected' }, item.version);
    return changeStatus(ctx, set, { status: 'rejected', rejection_reason: reason }, 'rejected');
  }),
  change_sets_apply: command(writers, async (ctx, input) => {
    reviewAuthority(ctx);
    const set = await setFor(ctx, input);
    if (!['pending', 'partially_applied'].includes(set.data.status)) conflict('Change set is no longer actionable');
    if (!set.data.approved_by) throw new DomainError('APPROVAL_REQUIRED', 'Approve the change set before applying', 409);
    if (integer(input.expected_version, 'expected_version') !== set.version) throw new DomainError('version_conflict', 'Change set changed since review', 409);
    const items = await itemsFor(ctx, set);
    const pending = items.filter(item => item.data.status === 'pending');
    const selection = new Set(input.item_seqs === undefined ? pending.map(item => item.data.seq) :
      array(input.item_seqs, 'item_seqs').map(seq => integer(seq, 'item_seq', 1, 50)));
    if (!selection.size || [...selection].some(seq => !pending.some(item => item.data.seq === seq))) invalid('item_seqs');
    const planned = [];
    for (const item of pending.filter(item => selection.has(item.data.seq))) {
      const { target, targetId } = targetOf(item.data.target);
      const operation = target.operations[target.action];
      if (!operation?.roles.includes(ctx.role)) throw new DomainError('forbidden', 'Target command is not available to this role', 403);
      const row = await ctx.get(target.module, target.kind, targetId);
      planned.push({ item, targetId, operation, row });
    }
    const results = new Map<string, Entity>();
    for (const { item, targetId, operation, row } of planned) {
      const expected = item.data.expected_version as number;
      let result: Fields;
      if (!row || row.version !== expected) result = { status: 'conflict', observed_version: row?.version ?? null };
      else {
        // A concurrent write between the preflight and the owner command aborts the whole unit of work.
        await operation.run(ctx, { id: targetId, expected_version: expected, expectedVersion: expected, title: item.data.patch.title });
        result = { status: 'applied', applied_by: ctx.actorId, applied_at: ctx.now };
      }
      results.set(item.id, await ctx.update(agentModule, itemKind, item.id, result, item.version));
    }
    const updated = items.map(item => results.get(item.id) ?? item);
    const applied = updated.filter(item => item.data.status === 'applied').length;
    const hasConflicts = updated.some(item => item.data.status === 'conflict');
    const hasPending = updated.some(item => item.data.status === 'pending');
    const status = applied === updated.length ? 'applied' : applied ? 'partially_applied' : hasConflicts && !hasPending ? 'stale' : 'pending';
    return { change_set: await changeStatus(ctx, set, { status }, status), items: updated };
  }),
};
