import { ADMIN, READ, type Context, type Data, type Input, type Operation, type Role, type Row } from '@smartsell/contracts';
import { array, choice, conflict, digest, email, forbidden, identifier, invalid, matches, missing, record, requireHost, resource, row,
  shareMetadata, shareStatus, text, timestamp, type TeamHost } from './model.js';
import { issuePortalInvite, issueShare, previewShare, revokeShare } from './sharing.js';
import { ambassadorOperations } from './ambassador.js';
import { workspaceTemplateOperations } from './workspace-templates.js';
import { setBranding } from './portal.js';

export { createPortalHandler, type PortalHost } from './portal.js';
export { registerTeamPortal } from './fastify-portal.js';
export type { TeamHost, PortalPrincipal, Projection, ResourceRef } from './model.js';

const leads = ['owner', 'admin', 'manager'] as const;
const internal = READ.filter(role => role !== 'agent');
const shareRoles = [...leads, 'editor', 'analyst'] as const;
const itemKinds = ['content', 'report', 'asset_pack', 'custom'] as const;
const audiences = ['internal', 'client', 'creator'] as const;
const op = (name: string, method: Operation['method'], path: string, roles: readonly Role[], summary: string,
  run: Operation['run'], versionKind?: string): Operation => ({ name, method, path, roles, summary, run, ...(versionKind ? { versionKind } : {}) });
const scopes = (body: Data) => array(body.scopes ?? [], 'scopes', value => text(value, 'scope', 160));
const target = (ctx: Context, kind: string, input: Input) => row(ctx, kind, identifier(input.params.id, 'id'));
const optionalText = (value: unknown, field: string) => value === undefined ? undefined : text(value, field);
const permittedMember = (actor: Role, targetRole: Role) => targetRole !== 'owner' && (actor === 'owner' || targetRole !== 'admin');

export function workspaceMemberInvite(ctx: Context, body: Data) {
  const role = choice(body.role, 'role', READ);
  if (!permittedMember(ctx.role, role)) throw forbidden();
  return { email: email(body.email), role, scopes: scopes(body) };
}

function remindDelivery(ctx: Context, item: Row) {
  if (String(item.confirmation_reminded_at ?? '').slice(0, 10) === ctx.now.slice(0, 10)) return item;
  const updated = ctx.update('delivery_item', item.id, { confirmation_reminded_at: ctx.now });
  ctx.emit('team.delivery_item.reminder_requested', { delivery_item_id: item.id, share_id: item.share_id });
  return updated;
}

export const schedules = [{ id: 'team.delivery_reminder', intervalMs: 86_400_000, run(ctx: Context) {
  const shares = new Map(ctx.list('share').map(share => [share.id, share]));
  for (const item of ctx.list('delivery_item')) {
    const share = shares.get(String(item.share_id));
    if (item.status === 'sent' && share && shareStatus(ctx, share) === 'active') remindDelivery(ctx, item);
  }
} }];

function checkVisibility(actor: Role, thread: Data, visibility: string) {
  if (visibility !== 'internal' && (thread.audience !== visibility || !shareRoles.some(role => role === actor))) throw forbidden();
}

export function createTeamOperations(host: TeamHost = {}): Operation[] {
  const members = (ctx: Context) => requireHost(host.members).list(ctx);
  const memberAt = (ctx: Context, id: string) => {
    const member = members(ctx).find(item => item.id === id);
    if (!member) throw missing();
    return member;
  };
  const checkReceiver = (ctx: Context, from: string, to: string) => {
    if (from === to || !members(ctx).some(member => member.user_id === to)) throw invalid('to_user_id');
  };
  const createHandover = (ctx: Context, from: string, to: string | undefined, reason: string, note: string | undefined,
    items: readonly { kind: string; id: string }[]) => {
    const handover = ctx.create('handover', { from_user_id: from, to_user_id: to, reason, note, status: to ? 'pending_accept' : 'draft' });
    for (const item of items) ctx.create('handover_item', { handover_id: handover.id, item_kind: item.kind, item_id: item.id, result: 'pending' });
    ctx.emit('team.handover.created', { handover_id: handover.id });
    return handover;
  };
  const handoverItems = (ctx: Context, id: string) => ctx.list('handover_item').filter(item => item.handover_id === id);
  const commentAuth = (ctx: Context, ref: Data, action: 'read' | 'write' | 'external') => requireHost(host.authorizeComment)(ctx, resource(ref), action);

  const clearCollaboration = (ctx: Context, userId: string) => {
    const commentIds = new Set(ctx.list('comment_mention').filter(row => row.user_id === userId).map(row => row.comment_id));
    for (const row of ctx.list('notification').filter(row => row.recipient_user_id === userId && row.resource_type === 'comment' && commentIds.has(row.resource_id))) {
      const deliveries = ctx.list('notification_delivery').filter(delivery => delivery.notification_id === row.id);
      for (const delivery of deliveries.filter(delivery => !['delivered', 'suppressed'].includes(String(delivery.status)))) {
        ctx.update('notification_delivery', delivery.id, { status: 'suppressed', reason: 'team_membership_changed' });
      }
      if (!row.archived_at) ctx.update('notification', row.id, { archived_at: ctx.now });
    }
    for (const row of ctx.list('comment_mention').filter(row => row.user_id === userId && !row.revoked_at)) {
      ctx.update('comment_mention', row.id, { revoked_at: ctx.now });
    }
  };
  return [
    ...ambassadorOperations(host),
    op('team_members_list', 'GET', '/members', internal, 'List workspace members', ctx =>
      members(ctx).map(({ id, user_id, role, scopes }) => ({ id, user_id, role, scopes }))),
    op('team_member_invite', 'POST', '/members/invite', ADMIN, 'Create a workspace invitation via IAM', (ctx, { body }) => {
      const input = workspaceMemberInvite(ctx, body);
      const invitation = requireHost(host.members).invite(ctx, input);
      ctx.emit('team.member.invited', { invitation_id: invitation.invitation_id, role: input.role });
      return { invitation_id: invitation.invitation_id };
    }),
    op('team_member_roles_update', 'PATCH', '/members/:id/roles', ADMIN, 'Update workspace role and resource scope via IAM', async (ctx, { body, params }) => {
      const member = memberAt(ctx, params.id!);
      const role = choice(body.role, 'role', READ);
      if (member.user_id === ctx.actorId || !permittedMember(ctx.role, member.role) || !permittedMember(ctx.role, role)) throw forbidden();
      const nextScopes = scopes(body);
      await requireHost(host.members).setRole(ctx, member, role, nextScopes);
      if (role !== member.role || JSON.stringify([...nextScopes].sort()) !== JSON.stringify([...member.scopes].sort())) clearCollaboration(ctx, member.user_id);
      ctx.emit('team.member.role_changed', { member_id: member.id, role });
      return { id: member.id, role, scopes: nextScopes };
    }),
    op('team_member_remove', 'POST', '/members/:id/remove', ADMIN, 'Preview removal, or confirm it with the preview hash', async (ctx, { body, params }) => {
      const member = memberAt(ctx, params.id!);
      if (member.user_id === ctx.actorId || !permittedMember(ctx.role, member.role)) throw forbidden();
      const iam = requireHost(host.members);
      const items = iam.previewRemoval(ctx, member).map(({ kind, id }) => ({ kind, id }))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
      const affectedShares = ctx.list('share').filter(share =>
        typeof share.content_hash === 'string' && share.created_by === member.user_id && shareStatus(ctx, share) === 'active');
      const share_ids = affectedShares.map(share => share.id).sort();
      const hash = digest(JSON.stringify([ctx.tenantId, ctx.workspaceId, ctx.actorId, member.id, member.role, member.scopes, items, share_ids]));
      if (body.preview_hash === undefined) return { member_id: member.id, items, share_ids, preview_hash: hash };
      if (body.preview_hash !== hash) throw conflict('The removal preview changed');
      const to = body.to_user_id === undefined ? undefined : identifier(body.to_user_id, 'to_user_id');
      if (to) checkReceiver(ctx, member.user_id, to);
      const note = optionalText(body.note, 'note');
      const handover = createHandover(ctx, member.user_id, to, 'member_removed', note, items);
      await iam.remove(ctx, member);
      clearCollaboration(ctx, member.user_id);
      for (const share of affectedShares) revokeShare(ctx, share);
      ctx.emit('team.member.removed', { member_id: member.id, handover_id: handover.id });
      return { member_id: member.id, handover_id: handover.id };
    }),
    op('team_get_workload', 'GET', '/workload', leads, 'Summarize current workload and blockers', (ctx, { query }) => {
      const counts = new Map<string, { assignee_id: string; kind: string; total: number; blocked: number }>();
      const types = query.types?.split(',');
      for (const item of requireHost(host.work).workload(ctx)) {
        if ((query.member_id && query.member_id !== item.assignee_id) || (types && !types.includes(item.kind))) continue;
        const key = JSON.stringify([item.assignee_id, item.kind]);
        const count = counts.get(key) ?? { assignee_id: item.assignee_id, kind: item.kind, total: 0, blocked: 0 };
        count.total++;
        if (item.blocked) count.blocked++;
        counts.set(key, count);
      }
      return [...counts.values()];
    }),
    op('team_handovers_list', 'GET', '/handovers', internal, 'List visible handovers', ctx => ctx.list('handover')
      .filter(item => leads.some(role => role === ctx.role) || item.to_user_id === ctx.actorId || item.from_user_id === ctx.actorId)
      .map(item => ({ ...item, items: handoverItems(ctx, item.id) }))),
    op('team_handover_create', 'POST', '/handovers', leads, 'Prepare handover for acceptance', (ctx, { body }) => {
      const from = identifier(body.from_user_id, 'from_user_id');
      const to = identifier(body.to_user_id, 'to_user_id');
      if (!members(ctx).some(member => member.user_id === from)) throw missing();
      checkReceiver(ctx, from, to);
      const reason = choice(body.reason, 'reason', ['leave', 'reassign']);
      return createHandover(ctx, from, to, reason, optionalText(body.note, 'note'), requireHost(host.work).forHandover(ctx, from));
    }),
    op('team_handover_assign', 'PATCH', '/handovers/:id', leads, 'Assign an unassigned handover draft', (ctx, input) => {
      const item = target(ctx, 'handover', input);
      if (item.status !== 'draft') throw conflict('Only drafts can be assigned');
      const to = identifier(input.body.to_user_id, 'to_user_id');
      checkReceiver(ctx, String(item.from_user_id), to);
      return ctx.update('handover', item.id, { to_user_id: to, status: 'pending_accept' });
    }, 'handover'),
    op('team_handover_accept', 'POST', '/handovers/:id/accept', internal, 'Accept and transfer the recorded work', (ctx, input) => {
      const handover = target(ctx, 'handover', input);
      if (handover.to_user_id !== ctx.actorId) throw forbidden();
      if (handover.status !== 'pending_accept') throw conflict('Handover is not awaiting acceptance');
      const items = handoverItems(ctx, handover.id);
      if (items.length) requireHost(host.work).transfer(ctx, String(handover.from_user_id), ctx.actorId,
        items.map(item => ({ kind: String(item.item_kind), id: String(item.item_id) })));
      for (const item of items) ctx.update('handover_item', item.id, { result: 'transferred' });
      ctx.emit('team.handover.completed', { handover_id: handover.id });
      return ctx.update('handover', handover.id, { status: 'completed', accepted_at: ctx.now, completed_at: ctx.now });
    }, 'handover'),
    op('team_handover_cancel', 'POST', '/handovers/:id/cancel', leads, 'Cancel an outstanding handover', (ctx, input) => {
      const handover = target(ctx, 'handover', input);
      if (handover.status !== 'draft' && handover.status !== 'pending_accept') throw conflict('Handover is already closed');
      return ctx.update('handover', handover.id, { status: 'cancelled' });
    }, 'handover'),
    op('comments_list', 'GET', '/threads', READ, 'List authorized threads and comments for one revision', (ctx, { query }) => {
      const ref = resource(query);
      commentAuth(ctx, query, 'read');
      const comments = ctx.list('comment');
      return ctx.list('comment_thread').filter(thread => matches(thread, ref))
        .map(thread => ({ ...thread, comments: comments.filter(comment => comment.thread_id === thread.id && !comment.deleted_at) }));
    }),
    op('team_thread_create', 'POST', '/threads', internal, 'Open an anchored comment thread', (ctx, { body }) => {
      const audience = choice(body.audience ?? 'internal', 'audience', audiences);
      checkVisibility(ctx.role, { audience }, audience);
      commentAuth(ctx, body, audience === 'internal' ? 'write' : 'external');
      return ctx.create('comment_thread', {
        ...resource(body), audience, status: 'open', anchor_field: optionalText(body.anchor_field, 'anchor_field'),
      });
    }),
    op('comments_add', 'POST', '/threads/:id/comments', READ, 'Add a comment with explicit visibility', (ctx, input) => {
      const thread = target(ctx, 'comment_thread', input);
      if (thread.status !== 'open') throw conflict('Thread is resolved');
      const visibility = choice(input.body.visibility ?? 'internal', 'visibility', audiences);
      checkVisibility(ctx.role, thread, visibility);
      commentAuth(ctx, thread, visibility === 'internal' ? 'write' : 'external');
      const mentions = array(input.body.mentions ?? [], 'mentions', value => identifier(value, 'user_id'));
      if (mentions.some(user => !members(ctx).some(member => member.user_id === user))) throw invalid('mentions');
      const comment = ctx.create('comment', {
        thread_id: thread.id, visibility, body_text: text(input.body.text, 'text'), created_by: ctx.actorId,
        ...(thread.share_id && visibility !== 'internal' ? { share_id: thread.share_id } : {}),
      });
      ctx.emit('team.comment.created', { comment_id: comment.id, thread_id: thread.id });
      for (const user of mentions) {
        ctx.create('comment_mention', { comment_id: comment.id, user_id: user });
        ctx.emit('team.comment.mentioned', { comment_id: comment.id, mentioned_user_id: user, user_id: user });
      }
      return comment;
    }),
    op('team_comment_edit', 'PATCH', '/comments/:id', internal, 'Edit your own comment', (ctx, input) => {
      const comment = target(ctx, 'comment', input);
      if (comment.created_by !== ctx.actorId || comment.deleted_at) throw forbidden();
      const thread = row(ctx, 'comment_thread', String(comment.thread_id));
      commentAuth(ctx, thread, comment.visibility === 'internal' ? 'write' : 'external');
      return ctx.update('comment', comment.id, { body_text: text(input.body.text, 'text'), edited_at: ctx.now });
    }, 'comment'),
    op('team_thread_resolve', 'POST', '/threads/:id/resolve', internal, 'Resolve or reopen a thread', (ctx, input) => {
      const thread = target(ctx, 'comment_thread', input);
      checkVisibility(ctx.role, thread, String(thread.audience));
      commentAuth(ctx, thread, thread.audience === 'internal' ? 'write' : 'external');
      const status = choice(input.body.status ?? 'resolved', 'status', ['resolved', 'open']);
      if (thread.status === status) return thread;
      ctx.emit(status === 'resolved' ? 'team.thread.resolved' : 'team.thread.reopened', { thread_id: thread.id });
      return ctx.update('comment_thread', thread.id, { status, status_changed_by: ctx.actorId, status_changed_at: ctx.now });
    }, 'comment_thread'),
    op('team_share_preview', 'POST', '/shares/preview', shareRoles, 'Preview the exact share scope', (ctx, { body }) => previewShare(host, ctx, body)),
    op('team_shares_list', 'GET', '/shares', shareRoles, 'List share metadata', ctx => ctx.list('share')
      .filter(share => typeof share.content_hash === 'string' && (ADMIN.includes(ctx.role) || share.created_by === ctx.actorId))
      .map(share => shareMetadata(ctx, share))),
    op('team_share_create', 'POST', '/shares', shareRoles, 'Create a revision-pinned share using a verified preview', (ctx, { body }) => issueShare(host, ctx, body)),
    op('team_share_revoke', 'DELETE', '/shares/:id', shareRoles, 'Revoke a share', (ctx, input) => {
      const share = target(ctx, 'share', input);
      if (typeof share.content_hash !== 'string') throw missing();
      if (!ADMIN.includes(ctx.role) && share.created_by !== ctx.actorId) throw forbidden();
      return revokeShare(ctx, share);
    }, 'share'),
    op('team_portal_invite', 'POST', '/portal-invitations', ADMIN, 'Create a verified-address portal invitation', (ctx, { body }) => issuePortalInvite(ctx, body)),
    op('team_portal_invitation_revoke', 'DELETE', '/portal-invitations/:id', ADMIN, 'Revoke a portal invitation and any access granted by it', (ctx, input) => {
      const invite = target(ctx, 'portal_invitation', input);
      if (invite.status === 'revoked') return { id: invite.id, status: 'revoked' };
      for (const grant of ctx.list('portal_grant').filter(row => row.invitation_id === invite.id && row.active === true)) {
        ctx.update('portal_grant', grant.id, { active: false, revoked_at: ctx.now });
      }
      ctx.update('portal_invitation', invite.id, { status: 'revoked', revoked_at: ctx.now });
      ctx.emit('team.portal_invitation.revoked', { invitation_id: invite.id });
      return { id: invite.id, status: 'revoked' };
    }, 'portal_invitation'),
    op('deliveries_list', 'GET', '/delivery-plans', leads, 'List delivery plans and current states', ctx => {
      const items = ctx.list('delivery_item');
      return ctx.list('delivery_plan').map(plan => ({ ...plan, items: items.filter(item => item.plan_id === plan.id)
        .map(item => ({ ...item, overdue: !['confirmed', 'cancelled'].includes(String(item.status)) && Date.parse(String(item.due_at)) <= Date.parse(ctx.now) })) }));
    }),
    op('team_delivery_plan_create', 'POST', '/delivery-plans', leads, 'Create a delivery plan', (ctx, { body }) =>
      ctx.create('delivery_plan', { name: text(body.name, 'name', 150), period: text(body.period, 'period', 80), owner_id: ctx.actorId })),
    op('team_delivery_item_create', 'POST', '/delivery-plans/:id/items', leads, 'Plan a delivery for a specific revision', (ctx, input) => {
      const plan = target(ctx, 'delivery_plan', input);
      const { body } = input;
      return ctx.create('delivery_item', { ...resource(body), plan_id: plan.id, kind: choice(body.kind, 'kind', itemKinds),
        due_at: timestamp(body.due_at, 'due_at'), title: text(body.title, 'title', 150), status: 'planned' });
    }),
    op('team_delivery_item_produce', 'POST', '/delivery-items/:id/produce', leads, 'Link the produced revision to a named client share', (ctx, input) => {
      const item = target(ctx, 'delivery_item', input);
      const share = row(ctx, 'share', identifier(input.body.share_id, 'share_id'));
      if (item.status !== 'planned' || !matches(share, resource(item)) || shareStatus(ctx, share) !== 'active' ||
        share.audience !== 'client' || share.grantee_type === 'link') throw conflict('Delivery requires a matching active client share');
      ctx.emit('team.delivery_item.produced', { delivery_item_id: item.id, share_id: share.id });
      return ctx.update('delivery_item', item.id, { share_id: share.id, status: 'produced', produced_at: ctx.now });
    }, 'delivery_item'),
    op('team_delivery_item_mark_sent', 'POST', '/delivery-items/:id/mark-sent', leads, 'Record a manually sent delivery', (ctx, input) => {
      const item = target(ctx, 'delivery_item', input);
      if (item.status !== 'produced' || shareStatus(ctx, row(ctx, 'share', String(item.share_id))) !== 'active') throw conflict('Delivery must be produced with an active share');
      const receipt = text(input.body.receipt_reference, 'receipt_reference', 150);
      ctx.emit('team.delivery_item.sent', { delivery_item_id: item.id, share_id: item.share_id, source: 'staff_recorded' });
      return ctx.update('delivery_item', item.id, { status: 'sent', sent_at: ctx.now, receipt_reference: receipt });
    }, 'delivery_item'),
    op('team_delivery_item_remind', 'POST', '/delivery-items/:id/remind', leads, 'Show a confirmation reminder in the client portal', (ctx, input) => {
      const item = target(ctx, 'delivery_item', input);
      if (item.status !== 'sent' || shareStatus(ctx, row(ctx, 'share', String(item.share_id))) !== 'active') {
        throw conflict('A sent delivery with an active share is required');
      }
      return remindDelivery(ctx, item);
    }, 'delivery_item'),
    ...workspaceTemplateOperations,
    op('team_capacity_list', 'GET', '/capacity', leads, 'List member capacity profiles', ctx => ctx.list('capacity_profile')),
    op('team_capacity_set', 'PUT', '/capacity/:id', leads, 'Set work hours and skills for a current member', (ctx, input) => {
      const member = memberAt(ctx, input.params.id!);
      const hours = input.body.weekly_hours;
      if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0 || hours > 168) throw invalid('weekly_hours');
      const patch = { member_id: member.id, weekly_hours: hours, skills: array(input.body.skills ?? [], 'skills', value => text(value, 'skill', 50)) };
      const existing = ctx.list('capacity_profile').find(item => item.member_id === member.id);
      return existing ? ctx.update('capacity_profile', existing.id, patch) : ctx.create('capacity_profile', patch);
    }),
    op('team_branding_get', 'GET', '/branding', internal, 'Read workspace presentation settings', ctx => ctx.list('branding_profile')[0] ?? null),
    op('team_branding_set', 'PUT', '/branding', ADMIN, 'Set workspace portal presentation', (ctx, { body }) => setBranding(ctx, body)),
  ].map(operation => ({ ...operation, mcp: false }));
}

export const operations: Operation[] = createTeamOperations();
export { commands, activeShare, portalShare, recordMemberRemoval, opaqueId } from './commands.ts';