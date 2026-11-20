import { type Context, type Data, type Row } from '@smartsell/contracts';
import {
  array, choice, conflict, digest, email, expires, identifier, invalid, matches, missing, newToken,
  requireHost, resource, shareMetadata, shareStatus, text,
  type Audience, type PortalPrincipal, type ResourceRef, type TeamHost,
} from './model.js';

const audiences = ['client', 'creator'] as const;
const permissions = ['view', 'comment', 'approve', 'download', 'submit'] as const;

export function publicComments(ctx: Context, ref: ResourceRef, audience: Audience, threadIds: unknown, share?: Row) {
  const selected = Array.isArray(threadIds) ? threadIds : [];
  const published = Array.isArray(share?.comment_versions) ? share.comment_versions : [];
  const comments = ctx.list('comment');
  return ctx.list('comment_thread').filter(thread => matches(thread, ref) && thread.audience === audience &&
    (thread.share_id ? thread.share_id === share?.id : selected.includes(thread.id)))
    .map(thread => ({
      id: thread.id,
      status: thread.status === 'resolved' ? 'resolved' : 'open',
      comments: comments.filter(comment => comment.thread_id === thread.id && comment.visibility === audience && !comment.deleted_at &&
        (comment.share_id ? comment.share_id === share?.id : !share || published.includes(`${comment.id}:${comment.version}`)))
        .map(comment => ({ id: comment.id, version: comment.version, text: comment.body_text, at: comment.created_at })),
    }));
}

export function sharedProjection(host: TeamHost, ctx: Context, ref: ResourceRef, audience: Audience,
  accessor: PortalPrincipal | 'staff' | 'link', downloadable: boolean, threadIds: unknown, share?: Row) {
  const projection = requireHost(host.project)(ctx, ref, audience, accessor);
  if (!projection) throw missing();
  const stale = identifier(projection.current_revision_id, 'current_revision_id') !== ref.revision_id;
  return {
    title: text(projection.title, 'title', 500),
    text: typeof projection.text === 'string' && projection.text.length <= 100_000 ? projection.text : '',
    stale,
    attachments: downloadable ? (projection.attachments ?? []).map(file => ({
      id: identifier(file.id, 'file_id'), name: text(file.name, 'file_name', 255),
    })) : [],
    threads: publicComments(ctx, ref, audience, threadIds, share),
  };
}

export function previewShare(host: TeamHost, ctx: Context, input: Data) {
  const ref = resource(input);
  const audience = choice(input.audience, 'audience', audiences);
  const grantee_type = choice(input.grantee_type, 'grantee_type', ['portal_user', 'email', 'link']);
  const grantee_id = grantee_type === 'link' ? undefined : grantee_type === 'email' ? email(input.grantee_id) : identifier(input.grantee_id, 'grantee_id');
  const grants = array(input.permissions, 'permissions', value => choice(value, 'permission', permissions)).sort();
  if (!grants.includes('view') || (grantee_type === 'link' && grants.some(grant => grant !== 'view' && grant !== 'download'))
    || (grants.includes('approve') && audience !== 'client') || (grants.includes('submit') && audience !== 'creator')) throw invalid('permissions');
  if (grantee_id && grantee_type === 'portal_user' && !requireHost(host.checkRecipient)(ctx, audience, grantee_id)) throw missing();
  const thread_ids = array(input.thread_ids ?? [], 'thread_ids', value => identifier(value, 'thread_id')).sort();
  const settings = { ...ref, audience, grantee_type, grantee_id, permissions: grants, thread_ids, expires_at: expires(ctx, input.expires_at, 90) };
  const projection = sharedProjection(host, ctx, ref, audience, 'staff', grants.includes('download'), thread_ids);
  if (projection.threads.length !== thread_ids.length) throw missing();
  if (projection.stale) throw conflict('Preview the current revision');
  return { settings, projection, preview_hash: digest(JSON.stringify([ctx.tenantId, ctx.workspaceId, ctx.actorId, settings, projection])) };
}

export function issueShare(host: TeamHost, ctx: Context, input: Data) {
  const { settings, projection, preview_hash } = previewShare(host, ctx, input);
  if (preview_hash !== input.preview_hash) throw conflict('The preview has changed');
  const token = settings.grantee_type === 'link' ? newToken() : undefined;
  const share = ctx.create('share', {
    ...settings, preview_hash,
    comment_versions: projection.threads.flatMap(thread => thread.comments.map(comment => `${comment.id}:${comment.version}`)),
    content_hash: digest(JSON.stringify([projection.title, projection.text])),
    attachment_ids: projection.attachments.map(file => file.id),
    ...(token ? { link_token_hash: digest(token) } : {}),
    status: 'active', created_by: ctx.actorId,
  });
  ctx.emit('team.share.created', { share_id: share.id, revision_id: share.revision_id });
  return { ...shareMetadata(ctx, share), ...(token ? { href: `/s/${encodeURIComponent(share.id)}#${token}` } : {}) };
}

export function issuePortalInvite(ctx: Context, input: Data) {
  const token = newToken();
  const invitation = ctx.create('portal_invitation', {
    email: email(input.email), audience: choice(input.audience, 'audience', audiences),
    expires_at: expires(ctx, input.expires_at, 14), token_hash: digest(token), status: 'pending',
  });
  ctx.emit('team.portal_invitation.created', { invitation_id: invitation.id });
  return { id: invitation.id, expires_at: invitation.expires_at, href: `/invite/${encodeURIComponent(invitation.id)}#${token}` };
}

export function revokeShare(ctx: Context, share: Row) {
  if (shareStatus(ctx, share) === 'revoked') return shareMetadata(ctx, share);
  const updated = ctx.update('share', share.id, { status: 'revoked', revoked_at: ctx.now });
  ctx.emit('team.share.revoked', { share_id: share.id });
  return shareMetadata(ctx, updated);
}

export function logAccess(ctx: Context, share: Row, accessor: PortalPrincipal | 'link', action: string) {
  ctx.create('share_access_log', { share_id: share.id, accessor: accessor === 'link' ? 'link' : accessor.id, action, at: ctx.now });
  ctx.emit('team.share.accessed', { share_id: share.id, action });
}
