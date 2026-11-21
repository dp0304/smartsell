import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { conflict, digest, forbidden, hasPermission, hasToken, identifier, invalid, missing, requireHost, resource, row, shareStatus, text,
  type Permission, type PortalPrincipal, type TeamHost } from './model.js';
import { logAccess, sharedProjection } from './sharing.js';

export interface PortalHost {
  origin: string;
  team: TeamHost;
  /** Authenticate the isolated portal session and resolve a verified address, if present. */
  authenticate(request: Request): Promise<PortalPrincipal | undefined>;
  /** Current workspace grants for the authenticated portal subject. */
  workspaceIds(principal: PortalPrincipal): Promise<readonly string[]>;
  /** Recheck the grant inside the scoped transaction before reading or writing. */
  canAccessWorkspace(ctx: Context, principal: PortalPrincipal): boolean;
  /** Supply only the scoped transaction, including rollback and serialization for writes.
   * Resolve globally unique share/invitation IDs using trusted storage. This is a locator,
   * not an authorization decision. Never expose these transactions to generic operation dispatch.
   */
  transact<T>(selector: { kind: 'share' | 'portal_invitation' | 'workspace'; id: string }, run: (ctx: Context) => T | Promise<T>, principal?: PortalPrincipal): Promise<T>;
}

const sessionRequired = () => new Problem(401, 'session_required', 'A portal session is required');
const response = (data: unknown, status = 200) => Response.json(data, {
  status,
  headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' },
});

function allowed(ctx: Context, share: Row, accessor: PortalPrincipal | 'link', token?: string): boolean {
  if (shareStatus(ctx, share) !== 'active' || !hasPermission(share, 'view')) return false;
  if (accessor === 'link') return share.grantee_type === 'link' && hasToken(share.link_token_hash, token);
  if (accessor.audience !== share.audience) return false;
  if (share.grantee_type === 'portal_user') return accessor.id === share.grantee_id;
  return share.grantee_type === 'email' && accessor.verifiedEmail?.toLowerCase() === share.grantee_id;
}

function logoDataUrl(value: unknown) {
  const prefix = 'data:image/png;base64,';
  if (typeof value !== 'string' || value.length > 32_768 || !value.startsWith(prefix)) return;
  const input = value.slice(prefix.length);
  const png = Buffer.from(input, 'base64');
  if (png.length >= 33 && png.toString('base64') === input && png.subarray(0, 16).toString('hex') === '89504e470d0a1a0a0000000d49484452' &&
    [png.readUInt32BE(16), png.readUInt32BE(20)].every(size => size > 0 && size <= 1024)) return value;
}

export function publicBranding(ctx: Context) {
  const brand = ctx.list('branding_profile')[0];
  if (!brand || typeof brand.label !== 'string' || typeof brand.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(brand.accent)) return null;
  const logo = logoDataUrl(brand.logo_data_url);
  return { label: brand.label, accent: brand.accent, ...(logo && { logo_data_url: logo }) };
}

export function setBranding(ctx: Context, body: Data) {
  const accent = text(body.accent, 'accent', 7);
  if (!/^#[0-9a-f]{6}$/i.test(accent)) throw invalid('accent');
  const patch: Data = { label: text(body.label, 'label', 80), accent };
  if (Object.hasOwn(body, 'logo_data_url')) {
    const logo = body.logo_data_url;
    if (logo !== null && !logoDataUrl(logo)) throw invalid('logo_data_url');
    patch.logo_data_url = logo;
  }
  if (Object.hasOwn(body, 'portal_origin')) {
    if (body.portal_origin !== null && typeof body.portal_origin !== 'string') throw invalid('portal_origin');
    patch.portal_origin = body.portal_origin;
  }
  const existing = ctx.list('branding_profile')[0];
  return existing ? ctx.update('branding_profile', existing.id, patch) : ctx.create('branding_profile', patch);
}

function detail(team: TeamHost, ctx: Context, share: Row, accessor: PortalPrincipal | 'link') {
  const ref = resource(share);
  if (share.audience !== 'client' && share.audience !== 'creator') throw missing();
  const projection = sharedProjection(team, ctx, ref, share.audience, accessor, hasPermission(share, 'download'), share.thread_ids, share);
  if (share.content_hash !== digest(JSON.stringify([projection.title, projection.text]))) throw missing();
  const branding = publicBranding(ctx);
  const pinnedFiles = Array.isArray(share.attachment_ids) ? share.attachment_ids : [];
  const deliveries = accessor !== 'link' && share.audience === 'client'
    ? ctx.list('delivery_item').filter(item => item.share_id === share.id) : [];
  const pendingDeliveries = deliveries.filter(item => item.status === 'sent');
  const confirmed = deliveries.filter(item => item.status === 'confirmed').map(item => ({
    id: item.id, produced_at: item.produced_at, sent_at: item.sent_at, confirmed_at: item.confirmed_at,
  }));
  return {
    branding,
    ...(confirmed.length ? { deliveries: confirmed } : {}),
    confirmation_reminder: pendingDeliveries.some(item => typeof item.confirmation_reminded_at === 'string'),
    id: share.id, kind: ref.resource_type, title: projection.title, text: projection.text,
    status: projection.stale ? 'stale' : 'active', expires_at: share.expires_at,
    attachments: team.download ? projection.attachments.filter(file => pinnedFiles.includes(file.id)) : [],
    threads: projection.threads.map(thread => ({ id: thread.id, status: thread.status,
      comments: thread.comments.map(comment => ({ id: comment.id, text: comment.text, at: comment.at })) })),
    actions: {
      comment: accessor !== 'link' && hasPermission(share, 'comment'),
      approve: accessor !== 'link' && share.audience === 'client' && !projection.stale && !!team.decide && hasPermission(share, 'approve'),
      submit: accessor !== 'link' && share.audience === 'creator' && !projection.stale && !!team.submit && hasPermission(share, 'submit'),
      confirm_delivery: pendingDeliveries.length > 0,
    },
  };
}

async function body(request: Request): Promise<Data> {
  if (request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' || !request.body) throw invalid('body');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let raw = '';
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > 24_000) {
      await reader.cancel();
      throw new Problem(413, 'body_too_large', 'Request body is too large');
    }
    raw += decoder.decode(chunk.value, { stream: true });
  }
  let value: unknown;
  try { value = JSON.parse(raw + decoder.decode()); } catch { throw invalid('body'); }
  if (!value || Array.isArray(value) || typeof value !== 'object') throw invalid('body');
  return value as Data;
}

export function createPortalHandler(host: PortalHost): (request: Request) => Promise<Response> {
  return async request => {
    try {
      const url = new URL(request.url);
      const prefix = '/api/v1/portal';
      if (!url.pathname.startsWith(`${prefix}/`)) throw missing();
      const path = url.pathname.slice(prefix.length);
      const method = request.method;
      if (method !== 'GET' && method !== 'POST') throw missing();
      if (method === 'POST' && request.headers.get('Origin') !== host.origin) throw forbidden();
      const authorization = request.headers.get('Authorization');
      const link = authorization?.match(/^Share ([A-Za-z0-9_-]{43})$/)?.[1];
      if (authorization !== null && !link) throw missing();
      const principal = link ? undefined : await host.authenticate(request);

      if (method === 'GET' && (path === '/me' || path === '/workspaces' || path === '/shares')) {
        if (!principal) throw sessionRequired();
        if (path === '/me') return response({ data: { audience: principal.audience } });
        const workspaceIds = [...new Set(await host.workspaceIds(principal))];
        if (path === '/workspaces') return response({ data: workspaceIds.map(id => ({ id })) });
        const search = url.searchParams.get('q')?.trim().slice(0, 120).toLowerCase();
        const groups = await Promise.all(workspaceIds.map(id => host.transact({ kind: 'workspace', id }, ctx =>
          ctx.list('share').flatMap(share => {
            if (!host.canAccessWorkspace(ctx, principal) || !allowed(ctx, share, principal)) return [];
            try {
              const { id, kind, title, status, expires_at, actions } = detail(host.team, ctx, share, principal);
              if (search && !title.toLowerCase().includes(search)) return [];
              logAccess(ctx, share, principal, search ? 'search' : 'list');
              return [{ id, kind, title, status, expires_at, actions }];
            } catch (error) {
              if (error instanceof Problem && error.status === 404) return [];
              throw error;
            }
          }), principal)));
        return response({ data: groups.flat() });
      }

      const invitation = path.match(/^\/invitations\/([a-zA-Z0-9_-]{1,128})\/accept$/);
      if (method === 'POST' && invitation) {
        if (!principal) throw sessionRequired();
        const input = await body(request);
        const result = await host.transact({ kind: 'portal_invitation', id: invitation[1]! }, ctx => {
          const invite = row(ctx, 'portal_invitation', invitation[1]!);
          if (invite.status !== 'pending' || !(Date.parse(String(invite.expires_at)) > Date.parse(ctx.now)) ||
            invite.email !== principal.verifiedEmail?.toLowerCase() || invite.audience !== principal.audience ||
            !hasToken(invite.token_hash, typeof input.token === 'string' ? input.token : undefined)) throw missing();
          requireHost(host.team.acceptPortalInvite)(ctx, principal, invite.id);
          ctx.update('portal_invitation', invite.id, { status: 'accepted', accepted_at: ctx.now, accepted_user_id: principal.id });
          ctx.emit('team.portal_invitation.accepted', { invitation_id: invite.id });
          return { accepted: true };
        }, principal);
        return response({ data: result });
      }

      const route = path.match(/^\/shares\/([a-zA-Z0-9_-]{1,128})(?:\/(threads|comments|approve|request-changes|download|submit|confirm-delivery))?$/);
      if (!route) throw missing();
      if (!link && !principal) throw sessionRequired();
      const id = route[1]!;
      const action = route[2];
      const isRead = method === 'GET' && (!action || action === 'threads' || action === 'download');
      const isWrite = method === 'POST' && action && ['comments', 'approve', 'request-changes', 'submit', 'confirm-delivery'].includes(action);
      if (!isRead && !isWrite) throw missing();
      const input = isWrite ? await body(request) : {};
      const accessor = principal ?? 'link';
      const result = await host.transact({ kind: 'share', id }, ctx => {
        const share = row(ctx, 'share', id);
        if ((principal && !host.canAccessWorkspace(ctx, principal)) || !allowed(ctx, share, accessor, link)) throw missing();
        const view = detail(host.team, ctx, share, accessor);
        const ref = resource(share);
        const need = (permission: Permission) => { if (!hasPermission(share, permission)) throw forbidden(); };
        if (!action || action === 'threads') {
          logAccess(ctx, share, accessor, 'view');
          return action ? view.threads : view;
        }
        if (action === 'download') {
          need('download');
          const fileId = identifier(url.searchParams.get('file_id'), 'file_id');
          if (!view.attachments.some(file => file.id === fileId)) throw missing();
          const download = new URL(requireHost(host.team.download)(ctx, ref, fileId, share.audience as PortalPrincipal['audience'], accessor, share.id));
          if (download.protocol !== 'https:' || download.username || download.password) throw new Error('Invalid download URL');
          logAccess(ctx, share, accessor, 'download');
          return { url: download.href };
        }
        if (!principal) throw forbidden();
        if (action === 'confirm-delivery') {
          if (!view.actions.confirm_delivery) throw forbidden();
          const items = ctx.list('delivery_item').filter(item => item.share_id === id && item.status === 'sent');
          for (const item of items) {
            ctx.update('delivery_item', item.id, { status: 'confirmed', confirmed_at: ctx.now, confirmed_by: principal.id });
            ctx.emit('team.delivery_item.confirmed', { delivery_item_id: item.id, share_id: id });
          }
          logAccess(ctx, share, principal, action);
          return { recorded: true };
        }
        if (action === 'comments') {
          if (!view.actions.comment) throw forbidden();
          const content = text(input.text, 'text');
          const threadId = input.thread_id === undefined ? undefined : identifier(input.thread_id, 'thread_id');
          const thread = threadId ? view.threads.find(item => item.id === threadId) : undefined;
          if (threadId && !thread) throw missing();
          if (thread?.status === 'resolved') throw conflict('Thread is resolved');
          const target = thread?.id ?? ctx.create('comment_thread', { ...ref, audience: principal.audience, share_id: share.id, status: 'open' }).id;
          const comment = ctx.create('comment', {
            thread_id: target, share_id: share.id, visibility: principal.audience, body_text: content, portal_author_id: principal.id,
          });
          ctx.emit('team.comment.created', { comment_id: comment.id, thread_id: target });
          logAccess(ctx, share, principal, 'comment');
          return { id: comment.id, text: content, at: comment.created_at };
        }
        if (action === 'submit' ? principal.audience !== 'creator' : principal.audience !== 'client') throw forbidden();
        need(action === 'submit' ? 'submit' : 'approve');
        if (view.status === 'stale') throw conflict('A newer revision requires a new share');
        if (action === 'submit') requireHost(host.team.submit)(ctx, ref, principal, text(input.text, 'text'));
        else requireHost(host.team.decide)(ctx, ref, principal, action === 'approve' ? 'approve' : 'request_changes',
          action === 'request-changes' ? text(input.text, 'text') : undefined);
        logAccess(ctx, share, principal, action);
        return { recorded: true };
      }, principal);
      return response({ data: result });
    } catch (error) {
      if (error instanceof Problem) return response({ error: { code: error.code, message: error.message } }, error.status);
      return response({ error: { code: 'internal_error', message: 'The request could not be completed' } }, 500);
    }
  };
}
