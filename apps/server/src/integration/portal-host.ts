import { createHmac, timingSafeEqual } from 'node:crypto';
import { ADMIN, Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import type { Records, Store } from '@smartsell/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.js';
import { makeContext } from '../context.js';
import { bodyObject, denied, digest, invalid, membership, missing, nowSeconds, opaque, type Auth, type Workspace } from '../identity.js';
import type { Registered } from '../operations.js';
import { requireMediaFile } from '../extensions/media-files.js';
import type { createMediaHost } from './media-host.js';
import { registerTeamPortal, type PortalHost } from '../modules/team/index.js';
import { publicBranding, setBranding } from '../modules/team/portal.js';
import { hasPermission, resource, shareStatus, type PortalPrincipal, type ResourceRef, type TeamHost } from '../modules/team/model.js';
export type { PortalHost } from '../modules/team/index.js';

const serviceActor = '00000000-0000-0000-0000-000000000001';
const idPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const find = (ctx: Context, kind: string, id: unknown) => ctx.list(kind).find(row => row.id === id);
const portalGrant = (ctx: Context, subject: string, audience: PortalPrincipal['audience']) =>
  ctx.list('portal_grant').find(row => row.subject_id === subject && row.audience === audience && row.active === true);
const domainKey = (origin: string) => `portal-domain/${origin}`;
const workspaceDomainKey = (id: string) => `portal-workspace-domain/${id}`;
const locateKey = (kind: string, id: string) => `portal-locator/${kind}/${id}`;
const grantKey = (principal: PortalPrincipal) => `portal-workspace/${principal.id}/${principal.audience}/`;

export function indexPortalResource(identity: Records, records: Records, ws: Workspace, operation: string, result: unknown) {
  const kind = operation === 'team_share_create' ? 'share' : operation === 'team_portal_invite' ? 'portal_invitation' : undefined;
  const id = (result as { id?: unknown } | undefined)?.id;
  if (kind && typeof id === 'string' && records.get(`row/${kind}/${id}`)) identity.put(locateKey(kind, id), ws.id);
}

function project(ctx: Context, ref: ResourceRef, audience: PortalPrincipal['audience'], allowUnscanned = false) {
  if (ref.resource_type === 'report' && audience === 'client') {
    const report = find(ctx, 'report', ref.resource_id);
    const revision = find(ctx, 'report_version', ref.revision_id);
    const head = ctx.list('report_version').find(row => row.report_id === ref.resource_id && row.status === 'finalized');
    if (!report || report.status !== 'active' || report.kind !== 'client_monthly' || report.sensitive !== false ||
      !head || !revision || revision.report_id !== report.id || !['finalized', 'superseded'].includes(String(revision.status)) || revision.sensitive !== false) return;
    const narrative = Array.isArray(revision.narrative) ? revision.narrative as { blocks: { text: string }[] }[] : [];
    return { current_revision_id: head.id, title: String(report.title), text: narrative.flatMap(section => section.blocks.map(block => block.text)).join('\n') };
  }
  if (ref.resource_type === 'publish_target' && audience === 'client') {
    const target = find(ctx, 'publish_target', ref.resource_id);
    const variant = find(ctx, 'content_variant', target?.content_variant_id);
    const item = find(ctx, 'content_item', variant?.content_item_id);
    const revision = find(ctx, 'content_revision', ref.revision_id);
    if (!target || target.visibility !== 'public' || !['awaiting_approval', 'ready', 'published', 'changes_requested'].includes(String(target.plan_status)) ||
      !variant || variant.archived_at || !item || item.archived_at || !revision || revision.variant_id !== variant.id) return;
    const current = target.variant_revision_id === variant.current_revision_id ? target.variant_revision_id : variant.current_revision_id;
    if (typeof current !== 'string') return;
    const rendered = revision.rendered as Data | undefined;
    return { current_revision_id: current, title: String(item.title), text: String(rendered?.text ?? revision.body ?? '') };
  }
  if (ref.resource_type === 'deliverable' && audience === 'creator') {
    const delivery = find(ctx, 'deliverable', ref.resource_id);
    const collaboration = find(ctx, 'collaboration', delivery?.collaboration_id);
    const terms = find(ctx, 'collaboration_terms', ref.revision_id);
    if (!delivery || !collaboration || !['active', 'delivering'].includes(String(collaboration.status)) ||
      !terms || terms.collaboration_id !== collaboration.id || terms.sign_status !== 'signed' || typeof collaboration.current_terms_revision_id !== 'string') return;
    return { current_revision_id: collaboration.current_terms_revision_id, title: String(delivery.kind),
      text: (Array.isArray(delivery.acceptance_criteria) ? delivery.acceptance_criteria : []).join('\n') };
  }
  if (ref.resource_type === 'file' && audience === 'client' && ref.resource_id === ref.revision_id) {
    const file = find(ctx, 'file_object', ref.resource_id);
    if (!file || file.purpose !== 'asset' || file.deleted_at || (file.scan_status !== 'clean' && !(allowUnscanned && file.scan_status === 'skipped')) || typeof file.original_filename !== 'string') return;
    return { current_revision_id: file.id, title: file.original_filename, text: '', attachments: [{ id: file.id, name: file.original_filename }] };
  }
}

export function portalTeam(operations: readonly Registered[], download?: TeamHost['download'], allowUnscanned = false): TeamHost {
  const run = (name: string, ctx: Context, id: string, body: Data) => {
    const op = operations.find(candidate => candidate.name === name);
    if (!op) throw new Problem(503, 'not_configured', 'The owning business service is unavailable');
    const result = op.run(ctx, { params: { id }, body, query: {} });
    if (result instanceof Promise) throw new Error('Portal actions must use a synchronous owning operation');
    return result as Row;
  };
  return {
    project: (ctx, ref, audience) => project(ctx, ref, audience, allowUnscanned),
    download,
    checkRecipient: (ctx, audience, subject) => !!portalGrant(ctx, subject, audience),
    authorizeComment(ctx, ref) {
      if (!project(ctx, ref, 'client', allowUnscanned) && !project(ctx, ref, 'creator', allowUnscanned)) throw missing();
    },
    acceptPortalInvite(ctx, principal, invitationId) {
      ctx.create('portal_grant', { subject_id: principal.id, audience: principal.audience, invitation_id: invitationId, active: true });
    },
    decide(ctx, ref, principal, decision, reason) {
      if (ref.resource_type !== 'publish_target') throw missing();
      const target = ctx.get('publish_target', ref.resource_id);
      if (target.variant_revision_id !== ref.revision_id) throw missing();
      const approval = ctx.get('approval_request', String(target.approval_request_id));
      const steps = approval.steps as { approvers?: { user_ids?: string[] } }[];
      if (!steps?.[Number(approval.current_step) - 1]?.approvers?.user_ids?.includes(principal.id)) {
        throw new Problem(403, 'approval_assignment_required', 'You are not assigned to this approval step');
      }
      const outcome = run(`publishing_${decision}`, { ...ctx, actorId: principal.id, role: 'reviewer' }, target.id, { comment: reason });
      if (outcome.decision_status === 'blocked' || outcome.decision_status === 'expired') {
        throw new Problem(409, 'decision_blocked', 'The current approval cannot be decided');
      }
    },
    submit(ctx, ref, principal, note) {
      if (ref.resource_type !== 'deliverable') throw missing();
      run('deliverables_submit', { ...ctx, actorId: principal.id }, ref.resource_id, { post_url: note });
    },
  };
}

export function createPortalHost(store: Store, config: Config, operations: readonly Registered[], mediaFiles: ReturnType<typeof createMediaHost>['media']) {
  const origin = config.portalOrigin ?? config.origin;
  const defaultHost = new URL(origin).host;
  const requestOrigin = (req: FastifyRequest) => {
    const authority = req.headers.host?.toLowerCase();
    if (authority === defaultHost) return origin;
    const custom = authority && config.portalCustomOrigins.get(authority);
    if (custom) return custom;
    if (!config.production && config.portalCustomOrigins.size === 0 && authority &&
      /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/.test(authority)) return origin;
    throw missing();
  };
  const cookieName = (target: string) => target.startsWith('https:') ? '__Host-smartsell_portal' : 'smartsell_portal';
  function sessionToken(cookie: string | null | undefined, target: string) {
    const name = cookieName(target);
    const values = cookie?.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
    const token = values?.length === 1 ? values[0].slice(name.length + 1) : '';
    return tokenPattern.test(token) ? digest(token) : undefined;
  }
  function indexBranding(identity: Records, workspaceId: string, profile: Data) {
    const next = profile.portal_origin;
    const previous = identity.get<string>(workspaceDomainKey(workspaceId));
    if (next) {
      if (typeof next !== 'string' || ![...config.portalCustomOrigins.values()].includes(next)) throw invalid('Unconfigured portal_origin');
      const bound = identity.get<string>(domainKey(next));
      if (bound && bound !== workspaceId) throw new Problem(409, 'PORTAL_DOMAIN_IN_USE', 'Portal domain already assigned');
    }
    if (previous === next) return;
    if (previous) {
      identity.delete(domainKey(previous));
      identity.delete(workspaceDomainKey(workspaceId));
    }
    if (typeof next === 'string') {
      identity.put(domainKey(next), workspaceId);
      identity.put(workspaceDomainKey(workspaceId), next);
    }
  }
  function workspaceForOrigin(identity: Records, target: string) {
    if (target === origin) return;
    const id = identity.get<string>(domainKey(target));
    const ws = id && identity.get<Workspace>(`workspace/${id}`);
    if (!ws || identity.get<{ status: string }>(`tenant/${ws.tenantId}`)?.status !== 'active') throw missing();
    return ws.id;
  }
  type Target = { target: string; workspaceId?: string };
  async function resolveTarget(req: FastifyRequest): Promise<Target> {
    const target = requestOrigin(req);
    const workspaceId = target === origin ? undefined : await store.transaction({ readOnly: true }, ({ identity }) => workspaceForOrigin(identity, target));
    return { target, workspaceId };
  }
  function scopedHost({ target, workspaceId }: Target): PortalHost {
    const verifyTarget = (identity: Records) => workspaceForOrigin(identity, target) === workspaceId;
    const session = (identity: Records, key: string | undefined) => {
      const row = key && identity.get<PortalPrincipal & { expires: number; origin?: string; workspaceId?: string }>(`portal-session/${key}`);
      return row && row.expires > nowSeconds() && (row.origin ?? origin) === target && row.workspaceId === workspaceId && verifyTarget(identity) ? row : undefined;
    };
    const team = portalTeam(operations, target.startsWith('https:') ? (ctx, ref, fileId, audience, principal, shareId) => {
      if (ref.resource_type !== 'file' || fileId !== ref.resource_id) throw missing();
      const key = `${shareId}.${fileId}.${nowSeconds() + 120}.${principal === 'link' ? 'link' : principal.id}.${audience}`;
      return `${target}/api/v1/portal/files/${key}.${mac(key, target)}`;
    } : undefined, !config.production);
    const grants = new WeakMap<Context, Records>();
    const bindings = new WeakMap<PortalPrincipal, string>();
    const host: PortalHost = {
      origin: target, team,
      async authenticate(request) {
        const key = sessionToken(request.headers.get('cookie'), target);
        if (!key) return;
        return store.transaction({ readOnly: true }, ({ identity }) => {
          const principal = session(identity, key);
          if (principal) bindings.set(principal, key);
          return principal;
        });
      },
      async workspaceIds(principal) {
        const candidates = await store.transaction({ readOnly: true }, ({ identity }) => session(identity, bindings.get(principal))
          ? identity.list<string>(grantKey(principal)).filter(id => !workspaceId || id === workspaceId) : []);
        const checked = await Promise.all(candidates.map(id => host.transact({ kind: 'workspace', id }, ctx =>
          host.canAccessWorkspace(ctx, principal) ? id : undefined, principal).catch(error => {
          if (error instanceof Problem && error.status === 404) return undefined;
          throw error;
        })));
        return checked.filter((id): id is string => id !== undefined);
      },
      canAccessWorkspace(ctx, principal) {
        const identity = grants.get(ctx);
        return !!identity && !!session(identity, bindings.get(principal)) && !!portalGrant(ctx, principal.id, principal.audience);
      },
      async transact(selector, run, principal) {
        return store.transaction({ identityWrite: true }, async tx => {
          if (!verifyTarget(tx.identity) || !idPattern.test(selector.id) || (principal && !session(tx.identity, bindings.get(principal)))) throw missing();
          const id = selector.kind === 'workspace' ? selector.id : tx.identity.get<string>(locateKey(selector.kind, selector.id));
          const ws = id && tx.identity.get<Workspace>(`workspace/${id}`);
          if (!ws || (workspaceId && workspaceId !== ws.id) || tx.identity.get<{ status: string }>(`tenant/${ws.tenantId}`)?.status !== 'active') throw missing();
          const scope = { tenantId: ws.tenantId, workspaceId: ws.id, actorId: principal?.id ?? serviceActor };
          const records = await tx.workspace(scope);
          const ctx = makeContext(records, scope, 'viewer');
          grants.set(ctx, tx.identity);
          const output = await run(ctx);
          if (selector.kind === 'portal_invitation' && principal && portalGrant(ctx, principal.id, principal.audience)) {
            tx.identity.put(`${grantKey(principal)}${ws.id}`, ws.id);
          }
          return output;
        });
      },
    };
    return host;
  }
  const baseHost = scopedHost({ target: origin });
  const mac = (value: string, target: string) => createHmac('sha256', config.secret)
    .update(target === origin ? `portal-download/${value}` : `portal-download/custom/${target}/${value}`).digest('base64url');
  return {
    ...baseHost,
    requestOrigin,
    index(identity: Records, records: Records, ws: Workspace, operation: string, result: unknown) {
      indexPortalResource(identity, records, ws, operation, result);
      if (operation === 'team_branding_set') {
        const current = records.list<Row>('row/branding_profile/')[0];
        if (current) indexBranding(identity, ws.id, current);
      }
    },
    register(app: FastifyInstance) {
      registerTeamPortal(app, baseHost, async req => scopedHost(await resolveTarget(req)));
      app.get('/api/v1/portal/branding', { exposeHeadRoute: false }, async req => {
        const context = await resolveTarget(req);
        return { data: context.workspaceId ? await scopedHost(context).transact({ kind: 'workspace', id: context.workspaceId }, publicBranding) : null };
      });
      if (config.portalAssertionKey) app.post('/api/v1/portal/session', { bodyLimit: 4096 }, async (req, reply) => {
        const { target: requestTarget, workspaceId } = await resolveTarget(req);
        if (req.headers.origin !== requestTarget) throw new Problem(403, 'forbidden', 'Invalid portal origin');
        const assertion = (req.body as Data | null)?.assertion;
        const match = typeof assertion === 'string' && /^([A-Za-z0-9_-]{1,2048})\.([A-Za-z0-9_-]{43})$/.exec(assertion);
        if (!match) throw missing();
        const expected = createHmac('sha256', config.portalAssertionKey!).update(`smartsell:portal-session:v1:${match[1]}`).digest('base64url');
        if (!timingSafeEqual(Buffer.from(expected), Buffer.from(match[2]))) throw missing();
        let value: Data;
        try { value = JSON.parse(Buffer.from(match[1], 'base64url').toString()); } catch { throw missing(); }
        const { sub, email, audience, exp, jti, origin: target, email_verified: verified } = value ?? {};
        const now = nowSeconds();
        if (typeof sub !== 'string' || !idPattern.test(sub) || typeof email !== 'string' || email.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['client', 'creator'].includes(String(audience)) ||
          target !== requestTarget || verified !== true || typeof exp !== 'number' || !Number.isSafeInteger(exp) || exp <= now || exp > now + 300 ||
          typeof jti !== 'string' || !tokenPattern.test(jti)) throw missing();
        const token = opaque();
        await store.transaction({ identityWrite: true }, ({ identity }) => {
          for (const [id, assertion] of identity.entries<{ expires: number }>('portal-assertion/')) {
            if (assertion.expires <= now) identity.delete(id);
          }
          for (const [id, existing] of identity.entries<{ expires: number }>('portal-session/')) {
            if (existing.expires <= now) identity.delete(id);
          }
          if (workspaceForOrigin(identity, requestTarget) !== workspaceId || identity.get(`portal-assertion/${jti}`)) throw missing();
          identity.put(`portal-assertion/${jti}`, { expires: exp });
          const oldSession = sessionToken(req.headers.cookie, requestTarget);
          const old = oldSession && identity.get<{ origin?: string; workspaceId?: string }>(`portal-session/${oldSession}`);
          if (old && (old.origin ?? origin) === requestTarget && old.workspaceId === workspaceId) identity.delete(`portal-session/${oldSession}`);
          identity.put(`portal-session/${digest(token)}`, { id: sub, verifiedEmail: email.toLowerCase(), audience, origin: requestTarget, workspaceId, expires: now + 8 * 3600 });
        });
        return reply.code(204).header('set-cookie', `${cookieName(requestTarget)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${requestTarget.startsWith('https:') ? '; Secure' : ''}`).send();
      });
      // A signed proof exceeds Fastify's default path parameter length.
      app.get<{ Params: { '*': string } }>('/api/v1/portal/files/*', { exposeHeadRoute: false }, async (req, reply) => {
        const context = await resolveTarget(req);
        const host = scopedHost(context);
        const match = /^([a-f0-9-]{36})\.([a-f0-9-]{36})\.(\d{1,12})\.(link|[a-f0-9-]{36})\.(client|creator)\.([A-Za-z0-9_-]{43})$/.exec(req.params['*']);
        if (!match || Number(match[3]) <= nowSeconds() || !timingSafeEqual(Buffer.from(mac(match.slice(1, 6).join('.'), context.target)), Buffer.from(match[6]))) throw missing();
        const [, shareId, fileId, , subject, audience] = match;
        const principal = subject === 'link' ? undefined : await host.authenticate(new Request(context.target, { headers: { cookie: req.headers.cookie ?? '' } }));
        if (subject !== 'link' && (principal?.id !== subject || principal.audience !== audience)) throw missing();
        const data = await host.transact({ kind: 'share', id: shareId }, async ctx => {
          const share = ctx.get('share', shareId);
          if (shareStatus(ctx, share) !== 'active' || !hasPermission(share, 'view') || !hasPermission(share, 'download') || share.audience !== audience ||
            !Array.isArray(share.attachment_ids) || !share.attachment_ids.includes(fileId) ||
            (principal ? !host.canAccessWorkspace(ctx, principal) || (share.grantee_type === 'portal_user' ? share.grantee_id !== principal.id :
              share.grantee_type !== 'email' || share.grantee_id !== principal.verifiedEmail) : share.grantee_type !== 'link')) throw missing();
          if (!project(ctx, resource(share), audience as PortalPrincipal['audience'], !config.production)?.attachments?.some(file => file.id === fileId)) throw missing();
          requireMediaFile(ctx, fileId, ['asset']);
          const token = new URL(mediaFiles.download(ctx, fileId).url, origin).searchParams.get('token');
          return mediaFiles.read(ctx, fileId, token);
        }, principal);
        return reply.type('application/octet-stream').header('content-disposition', 'attachment')
          .header('content-security-policy', "default-src 'none'; sandbox").header('content-length', data.size).send(data.stream);
      });
    },
  };
}
