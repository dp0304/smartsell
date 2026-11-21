import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { activeShare, opaqueId, portalShare, recordMemberRemoval } from '../modules/team/commands.ts';
import { releaseMemberOccupancy } from '../modules/inbox/index.ts';
import { submitPortalDeliverable } from '../modules/creator/portal-submit.ts';
import { resolveShortLink, submitLandingPage, viewLandingPage } from '../modules/traffic/index.ts';
import { readLeadContact } from '../modules/traffic/landing.ts';
import { unsubscribe } from '../modules/lifecycle/index.ts';
import { DomainError } from '../modules/types.ts';
import type { Context, Fields, Role } from '../modules/types.ts';

export type PublicLocator = 'team.share' | 'traffic.landing_page' | 'traffic.short_link' | 'lifecycle.unsubscribe_link';

const privateRecords = new Set([
  'traffic.lead', 'traffic.lead_contact', 'lifecycle.customer_identity', 'lifecycle.consent_record',
  'lifecycle.unsubscribe_link', 'team.internal_note', 'inbox.internal_note',
]);

/** Use on generic record reads in addition to workspace membership checks. */
export function canReadCollaborationRecord(module: string, kind: string, role: Role) {
  return !privateRecords.has(`${module}.${kind}`) || role === 'owner' || role === 'admin';
}
type TokenPurpose = 'share' | 'unsubscribe' | 'creator_submit';
type MembershipChange = { memberId: string } & ({ action: 'set_role'; role: Role } | { action: 'remove' });

export interface CollaborationServices {
  signingKey: Uint8Array;
  /** Authenticate the local cookie and reload membership inside the workspace transaction. */
  workspace<T>(request: FastifyRequest, workspaceId: string, run: (ctx: Context) => Promise<T>): Promise<T>;
  /** Use only this fixed kind and exact opaque ID to derive scope, then run under a service actor in one transaction. */
  publicWork<T>(locator: PublicLocator, id: string, run: (ctx: Context) => Promise<T>): Promise<T | undefined>;
  /** Within workspace(), update authoritative IAM. Enforce owner/admin hierarchy, protect the last owner,
   * revoke credentials on removal, and reject a target who is not a member of the supplied workspace. */
  changeMembership?(ctx: Context, change: MembershipChange): Promise<void>;
}

const publicId = /^[a-zA-Z0-9_-]{32}$/;
const internalId = /^[a-zA-Z0-9_-]{1,128}$/;
const shareActions = ['view', 'comment', 'approve', 'request_changes'] as const;
const roles = ['owner', 'admin', 'editor', 'reviewer', 'viewer'] as const;
const unavailable = () => new DomainError('not_found', 'Link unavailable', 404);
const invalid = () => new DomainError('invalid_input', 'Invalid request');
const denied = () => new DomainError('forbidden', 'Access denied', 403);

export function collaborationTokens(key: Uint8Array) {
  if (key.byteLength < 32) throw new Error('Collaboration signing key must be at least 32 bytes');
  const secret = Buffer.from(key);
  const sign = (body: string) => createHmac('sha256', secret).update(`smartsell:collaboration:v1:${body}`).digest();
  return {
    mint(purpose: TokenPurpose, id: string, expiresAt: number, now: number) {
      if (!publicId.test(id)) throw unavailable();
      const deadline = Math.floor(Math.min(expiresAt, now + 15 * 60_000) / 1000);
      if (!(deadline * 1000 > now)) throw unavailable();
      const body = `${purpose}.${id}.${deadline}`;
      return `${body}.${sign(body).toString('base64url')}`;
    },
    verify(purpose: TokenPurpose, token: unknown, now: number) {
      if (typeof token !== 'string' || token.length > 128) throw unavailable();
      const [actualPurpose, id, deadline, signature, extra] = token.split('.');
      if (extra !== undefined || actualPurpose !== purpose || !publicId.test(id) || !/^\d{1,12}$/.test(deadline) ||
        !/^[a-zA-Z0-9_-]{43}$/.test(signature) || Number(deadline) * 1000 <= now) throw unavailable();
      const expected = sign(`${purpose}.${id}.${deadline}`).toString('base64url');
      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw unavailable();
      return id;
    },
  };
}

function record(body: unknown): Fields {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid();
  return body as Fields;
}

function identifier(value: unknown, format = internalId) {
  if (typeof value !== 'string' || !format.test(value)) throw invalid();
  return value;
}

function handle(operation: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>, publicRoute = false) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    try {
      if (request.method === 'POST' && (request.headers['sec-fetch-site'] === 'cross-site' ||
        request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')) throw denied();
      return await operation(request, reply);
    } catch (error) {
      if (error instanceof DomainError) {
        const message = publicRoute && error.status === 404 ? 'Link unavailable' : error.message;
        return reply.code(error.status).send({ error: { code: error.code, message } });
      }
      // Request payloads and tokens can contain private data. Do not log them here.
      return reply.code(500).send({ error: { code: 'internal_error', message: 'Request failed' } });
    }
  };
}

export function registerCollaboration(app: FastifyInstance, services: CollaborationServices) {
  const tokens = collaborationTokens(services.signingKey);
  const json = { bodyLimit: 16_384 };

  // Keep cleartext contact and bearer tokens out of the host's command response cache.
  async function workspaceValue<T>(request: FastifyRequest, workspaceId: string, run: (ctx: Context) => Promise<T>) {
    let result: { value: T } | undefined;
    await services.workspace(request, workspaceId, async ctx => {
      result = { value: await run(ctx) };
      return null;
    });
    if (!result) throw unavailable();
    return result.value;
  }

  app.get('/api/portal/workspaces/:workspaceId/leads/:id/contact', handle(async request => {
    const params = record(request.params);
    return { data: await workspaceValue(request, identifier(params.workspaceId), ctx => readLeadContact(ctx, identifier(params.id))) };
  }));

  app.post('/api/portal/share-token', json, handle(async request => {
    const body = record(request.body);
    const id = identifier(body.shareId, publicId);
    return { data: await workspaceValue(request, identifier(body.workspaceId), async ctx => {
      if (ctx.role !== 'owner' && ctx.role !== 'admin' && ctx.role !== 'editor') throw denied();
      const share = await activeShare(ctx, id);
      if (ctx.role === 'editor' && share.data.createdBy !== ctx.actorId) throw denied();
      return { token: tokens.mint('share', id, Date.parse(share.data.expiresAt), Date.parse(ctx.now)) };
    }) };
  }));

  app.post('/api/portal/share', json, handle(async request => {
    const body = record(request.body);
    const id = tokens.verify('share', body.token, Date.now());
    const action = shareActions.find(candidate => candidate === (body.action ?? 'view'));
    if (!action) throw invalid();
    const data = await services.publicWork('team.share', id, ctx => portalShare(ctx, id, action, body.text));
    if (!data) throw unavailable();
    return { data };
  }, true));

  app.post('/api/portal/creator-token', json, handle(async request => {
    const body = record(request.body);
    return { data: await workspaceValue(request, identifier(body.workspaceId), async ctx => {
      if (ctx.role !== 'owner' && ctx.role !== 'admin' && ctx.role !== 'editor') throw denied();
      const deliverableId = identifier(body.deliverableId);
      if (!await ctx.get('creator', 'deliverable', deliverableId)) throw unavailable();
      const now = Date.parse(ctx.now);
      const expiresAt = now + 15 * 60_000;
      const link = await ctx.insert('team', 'share', {
        purpose: 'creator_submit', deliverableId, status: 'active', createdBy: ctx.actorId, expiresAt: new Date(expiresAt).toISOString(),
      }, opaqueId());
      await ctx.emit('team.creator_link.created', { linkId: link.id, deliverableId });
      return { linkId: link.id, token: tokens.mint('creator_submit', link.id, expiresAt, now) };
    }) };
  }));

  app.post('/api/portal/creator-submit', json, handle(async request => {
    const body = record(request.body);
    const id = tokens.verify('creator_submit', body.token, Date.now());
    const data = await services.publicWork('team.share', id, async ctx => {
      const link = await ctx.get('team', 'share', id);
      if (!link || link.data.purpose !== 'creator_submit' || link.data.status !== 'active' ||
        !(Date.parse(link.data.expiresAt) > Date.parse(ctx.now))) throw unavailable();
      await submitPortalDeliverable(ctx, link.data.deliverableId, { post_url: body.post_url });
      await ctx.update('team', 'share', id, { status: 'used', usedAt: ctx.now }, link.version);
      await ctx.emit('team.creator_link.used', { linkId: id });
      return { accepted: true };
    });
    if (!data) throw unavailable();
    return { data };
  }, true));

  app.get('/api/public/landing/:key', handle(async request => {
    const id = identifier(record(request.params).key, publicId);
    const data = await services.publicWork('traffic.landing_page', id, ctx => viewLandingPage(ctx, id));
    if (!data) throw unavailable();
    return { data };
  }, true));

  app.post('/api/public/landing/:key', json, handle(async request => {
    const id = identifier(record(request.params).key, publicId);
    const body = record(request.body);
    const data = await services.publicWork('traffic.landing_page', id, ctx => submitLandingPage(ctx, id, {
      version_id: body.version_id, email: body.email, phone: body.phone, name: body.name, message: body.message,
      service_contact: body.service_contact, marketing: body.marketing,
    }));
    if (!data) throw unavailable();
    return { data };
  }, true));

  app.get('/r/:key', { exposeHeadRoute: false }, handle(async (request, reply) => {
    const id = identifier(record(request.params).key, publicId);
    const data = await services.publicWork('traffic.short_link', id, ctx => resolveShortLink(ctx, id, {
      userAgent: request.headers['user-agent'], purpose: String(request.headers['sec-purpose'] ?? request.headers.purpose ?? ''),
    }));
    if (!data) throw unavailable();
    return reply.redirect(data.location, 302);
  }, true));

  app.post('/api/portal/unsubscribe-token', json, handle(async request => {
    const body = record(request.body);
    const id = identifier(body.linkId, publicId);
    return { data: await workspaceValue(request, identifier(body.workspaceId), async ctx => {
      if (ctx.role !== 'owner' && ctx.role !== 'admin') throw denied();
      const link = await ctx.get('lifecycle', 'unsubscribe_link', id);
      if (!link) throw unavailable();
      const now = Date.parse(ctx.now);
      return { token: tokens.mint('unsubscribe', id, now + 15 * 60_000, now) };
    }) };
  }));

  app.post('/api/public/unsubscribe', json, handle(async request => {
    const id = tokens.verify('unsubscribe', record(request.body).token, Date.now());
    const data = await services.publicWork('lifecycle.unsubscribe_link', id, ctx => unsubscribe(ctx, id));
    if (!data) throw unavailable();
    return { data: { accepted: true } };
  }, true));

  app.post('/api/portal/membership', json, handle(async request => {
    const body = record(request.body);
    const memberId = identifier(body.memberId);
    return { data: await workspaceValue(request, identifier(body.workspaceId), async ctx => {
      if ((ctx.role !== 'owner' && ctx.role !== 'admin') || memberId === ctx.actorId) throw denied();
      if (!services.changeMembership) throw new DomainError('not_configured', 'Membership changes are unavailable', 503);
      if (body.action === 'set_role') {
        const role = roles.find(value => value === body.role);
        if (!role) throw invalid();
        if (ctx.role !== 'owner' && (role === 'owner' || role === 'admin')) throw denied();
        await services.changeMembership(ctx, { memberId, action: 'set_role', role });
        await ctx.emit('team.member.role_changed', { memberId, role });
      } else if (body.action === 'remove') {
        await services.changeMembership(ctx, { memberId, action: 'remove' });
        await releaseMemberOccupancy(ctx, memberId);
        await recordMemberRemoval(ctx, memberId);
      } else throw invalid();
      return { accepted: true };
    }) };
  }));
}