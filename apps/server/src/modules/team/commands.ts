import { randomBytes } from 'node:crypto';
import { admins, DomainError, readers, required, text, writers } from '../types.ts';
import type { Commands, Context, Fields, Role } from '../types.ts';

const module = 'team';
const permissions = ['view', 'comment', 'approve'] as const;
const statuses = ['open', 'in_progress', 'blocked', 'done'] as const;
export const opaqueId = () => randomBytes(24).toString('base64url');

function command(roles: readonly Role[], run: Commands[string]['run']) {
  return { roles, async run(ctx: Context, body: Fields) {
    if (!roles.includes(ctx.role)) throw new DomainError('forbidden', 'Access denied', 403);
    return run(ctx, body);
  } };
}
function revision(body: Fields) {
  if (!Number.isSafeInteger(body.version) || body.version < 1) throw new DomainError('invalid_input', 'Invalid version');
  return body.version;
}
function choice<T extends string>(value: unknown, options: readonly T[], field: string): T {
  const found = options.find(option => option === value);
  if (!found) throw new DomainError('invalid_input', `Invalid ${field}`);
  return found;
}
function date(body: Fields, field: string) {
  const value = text(body, field, 40);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new DomainError('invalid_input', `Invalid ${field}`);
  }
  return new Date(value).toISOString();
}
function assignment(body: Fields) {
  const patch: Fields = {};
  if (body.assigneeId !== undefined) patch.assigneeId = body.assigneeId === null ? null : text(body, 'assigneeId', 128);
  if (body.dueAt !== undefined) patch.dueAt = body.dueAt === null ? null : date(body, 'dueAt');
  return patch;
}
const unavailable = () => new DomainError('not_found', 'Link unavailable', 404);
const find = (ctx: Context, kind: string, body: Fields) => required(ctx, module, kind, text(body, 'id', 128));

async function preview(ctx: Context, deliveryId: string) {
  const row = await required(ctx, module, 'delivery', deliveryId);
  if (row.data.status !== 'published') throw new DomainError('delivery_not_published', 'Publish the delivery first', 409);
  const items = (row.data.items as { title: string; status: string }[]).map(({ title, status }) => ({ title, status }));
  return { deliveryId, previewVersion: row.version, title: row.data.title as string, description: row.data.description as string, items };
}

export async function activeShare(ctx: Context, id: string) {
  const share = await ctx.get(module, 'share', id);
  if (!share || share.data.purpose !== 'delivery' || share.data.status !== 'active' ||
    !(Date.parse(share.data.expiresAt) > Date.parse(ctx.now))) throw unavailable();
  const row = await ctx.get(module, 'delivery', share.data.deliveryId);
  if (!row || row.data.status !== 'published' || share.data.deliveryVersion !== row.version) throw unavailable();
  return share;
}

export async function portalShare(ctx: Context, id: string, action: 'view' | 'comment' | 'approve' | 'request_changes', message?: unknown) {
  const share = await activeShare(ctx, id);
  const granted = share.data.permissions as (typeof permissions[number])[];
  if (!granted.includes(action === 'request_changes' ? 'approve' : action)) throw new DomainError('forbidden', 'This link does not grant that action', 403);
  let decision = share.data.decision ?? null;
  if (action === 'comment') {
    await ctx.insert(module, 'portal_comment', { shareId: id, text: text({ message }, 'message', 4000), at: ctx.now });
  } else if (action !== 'view') {
    if (decision && decision.action !== action) throw new DomainError('already_decided', 'A decision was already recorded', 409);
    if (!decision) {
      decision = { action, at: ctx.now };
      await ctx.update(module, 'share', id, { decision }, share.version);
    }
  }
  await ctx.emit('team.share.accessed', { shareId: id, action });
  const comments = (await ctx.list(module, 'portal_comment')).filter(row => row.data.shareId === id)
    .map(row => ({ text: row.data.text as string, at: row.data.at as string }));
  const { title, description, items } = await preview(ctx, share.data.deliveryId);
  return { title, description, items, permissions: granted, comments, decision };
}

export const commands: Commands = {
  list_board: command(readers, async ctx => {
    const tasks = (await ctx.list(module, 'task')).map(({ id, version, data }) => ({ id, version, data: {
      title: data.title, status: data.status, assigneeId: data.assigneeId, dueAt: data.dueAt,
    } }));
    const deliveries = (await ctx.list(module, 'delivery')).map(({ id, version, data }) => ({ id, version, data: {
      title: data.title, description: data.description, status: data.status, items: data.items,
    } }));
    const shares = (await ctx.list(module, 'share')).filter(row => row.data.purpose === 'delivery').map(({ id, version, data }) => ({ id, version, data: {
      deliveryId: data.deliveryId, status: data.status, expiresAt: data.expiresAt, decision: data.decision,
    } }));
    return { tasks, deliveries, shares };
  }),
  create_task: command(writers, async (ctx, body) => {
    const row = await ctx.insert(module, 'task', {
      title: text(body, 'title', 200), status: 'open', assigneeId: null, dueAt: null, ...assignment(body), createdBy: ctx.actorId,
    });
    await ctx.emit('team.task.created', { taskId: row.id });
    return row;
  }),
  update_task: command(writers, async (ctx, body) => {
    const row = await find(ctx, 'task', body);
    const patch = assignment(body);
    if (body.status !== undefined) patch.status = choice(body.status, statuses, 'status');
    if (!Object.keys(patch).length) throw new DomainError('invalid_input', 'Provide a task change');
    const next = await ctx.update(module, 'task', row.id, patch, revision(body));
    await ctx.emit('team.task.updated', { taskId: row.id, fromAssigneeId: row.data.assigneeId, toAssigneeId: next.data.assigneeId });
    return next;
  }),
  add_internal_note: command(writers, async (ctx, body) => {
    const task = await required(ctx, module, 'task', text(body, 'taskId', 128));
    const note = await ctx.insert(module, 'internal_note', { taskId: task.id, text: text(body, 'text', 4000), authorId: ctx.actorId });
    await ctx.emit('team.comment.created', { taskId: task.id, noteId: note.id, visibility: 'internal' });
    return note;
  }),
  complete_handover: command(admins, async (ctx, body) => {
    const row = await find(ctx, 'handover', body);
    if (row.data.status !== 'pending') throw new DomainError('invalid_state', 'Handover is complete', 409);
    const assigneeId = text(body, 'assigneeId', 128);
    if (assigneeId === row.data.memberId) throw new DomainError('invalid_input', 'Select a different assignee');
    for (const taskId of row.data.taskIds as string[]) {
      const task = await ctx.get(module, 'task', taskId);
      if (!task || task.data.assigneeId !== row.data.memberId || task.data.status === 'done') continue;
      await ctx.update(module, 'task', task.id, { assigneeId }, task.version);
      await ctx.emit('team.task.updated', { taskId, fromAssigneeId: row.data.memberId, toAssigneeId: assigneeId });
    }
    const updated = await ctx.update(module, 'handover', row.id, { status: 'completed', assigneeId, completedAt: ctx.now }, revision(body));
    await ctx.emit('team.handover.completed', { handoverId: row.id });
    return updated;
  }),
  create_delivery: command(writers, async (ctx, body) => {
    if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50) throw new DomainError('invalid_input', 'Specify 1 to 50 delivery items');
    const items = body.items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new DomainError('invalid_input', 'Invalid delivery item');
      return { title: text(item, 'title', 200), status: choice(item.status, ['pending', 'ready'], 'item status') };
    });
    const row = await ctx.insert(module, 'delivery', { title: text(body, 'title', 200), description: text(body, 'description', 4000), items, status: 'draft', createdBy: ctx.actorId });
    await ctx.emit('team.delivery.created', { deliveryId: row.id });
    return row;
  }),
  publish_delivery: command(writers, async (ctx, body) => {
    const row = await find(ctx, 'delivery', body);
    if (row.data.status !== 'draft') throw new DomainError('invalid_state', 'Delivery has already been published', 409);
    const published = await ctx.update(module, 'delivery', row.id, { status: 'published', publishedAt: ctx.now }, revision(body));
    await ctx.emit('team.delivery.published', { deliveryId: row.id });
    return published;
  }),
  preview_share: command(writers, (ctx, body) => preview(ctx, text(body, 'deliveryId', 128))),
  create_share: command(writers, async (ctx, body) => {
    const delivery = await preview(ctx, text(body, 'deliveryId', 128));
    if (delivery.previewVersion !== body.previewVersion) throw new DomainError('stale_preview', 'Preview the current delivery before sharing', 409);
    if (!Array.isArray(body.permissions) || body.permissions.length > permissions.length) throw new DomainError('invalid_input', 'Invalid permissions');
    const granted = [...new Set(body.permissions.map(value => choice(value, permissions, 'permission')))];
    if (!granted.includes('view')) throw new DomainError('invalid_input', 'A share must grant view');
    const expiresAt = date(body, 'expiresAt');
    const duration = Date.parse(expiresAt) - Date.parse(ctx.now);
    if (!(duration > 0 && duration <= 30 * 86400_000)) throw new DomainError('invalid_input', 'Expiry must be within 30 days');
    const row = await ctx.insert(module, 'share', {
      purpose: 'delivery', deliveryId: delivery.deliveryId, deliveryVersion: delivery.previewVersion, status: 'active',
      permissions: granted, expiresAt, createdBy: ctx.actorId, decision: null,
    }, opaqueId());
    await ctx.emit('team.share.created', { shareId: row.id, deliveryId: delivery.deliveryId });
    return row;
  }),
  revoke_share: command(writers, async (ctx, body) => {
    const row = await find(ctx, 'share', body);
    if (!admins.includes(ctx.role) && row.data.createdBy !== ctx.actorId) throw new DomainError('forbidden', 'Access denied', 403);
    const updated = await ctx.update(module, 'share', row.id, { status: 'revoked', revokedAt: ctx.now }, revision(body));
    await ctx.emit('team.share.revoked', { shareId: row.id });
    return updated;
  }),
  revoke_creator_link: command(writers, async (ctx, body) => {
    const row = await find(ctx, 'share', body);
    if (row.data.purpose !== 'creator_submit') throw unavailable();
    if (!admins.includes(ctx.role) && row.data.createdBy !== ctx.actorId) throw new DomainError('forbidden', 'Access denied', 403);
    const updated = await ctx.update(module, 'share', row.id, { status: 'revoked', revokedAt: ctx.now }, revision(body));
    await ctx.emit('team.creator_link.revoked', { linkId: row.id });
    return updated;
  }),
};

export async function recordMemberRemoval(ctx: Context, memberId: string) {
  const taskIds = (await ctx.list(module, 'task')).filter(row => row.data.assigneeId === memberId && row.data.status !== 'done').map(row => row.id);
  const handover = await ctx.insert(module, 'handover', { memberId, status: 'pending', createdBy: ctx.actorId, taskIds });
  for (const link of await ctx.list(module, 'share')) {
    if (link.data.createdBy !== memberId || link.data.status !== 'active') continue;
    await ctx.update(module, 'share', link.id, { status: 'revoked', revokedAt: ctx.now }, link.version);
    await ctx.emit('team.share.revoked', { shareId: link.id });
  }
  await ctx.emit('team.member.removed', { memberId, handoverId: handover.id });
  return handover;
}
