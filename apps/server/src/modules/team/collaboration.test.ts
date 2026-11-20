import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import Fastify from 'fastify';
import { canReadCollaborationRecord, collaborationTokens, registerCollaboration } from '../../extensions/collaboration.ts';
import { DomainError, type Context, type Entity } from '../types.ts';
import { commands as lifecycle } from '../lifecycle/index.ts';
import { commands, portalShare } from './index.ts';

function workspace(workspaceId: string) {
  const rows = new Map<string, Entity>();
  const key = (module: string, kind: string, id: string) => `${module}.${kind}.${id}`;
  const ctx: Context = {
    actorId: 'owner-local', tenantId: 'private-tenant', workspaceId, role: 'owner', now: new Date().toISOString(),
    async get(module, kind, id) { return rows.get(key(module, kind, id)); },
    async list(module, kind) { return [...rows.values()].filter(row => row.module === module && row.kind === kind); },
    async insert(module, kind, data, id = randomUUID()) {
      const row = { id, module, kind, data, version: 1, tenant_id: ctx.tenantId, workspace_id: workspaceId, created_at: ctx.now, updated_at: ctx.now };
      rows.set(key(module, kind, id), row);
      return row;
    },
    async update(module, kind, id, patch, version) {
      const row = await ctx.get(module, kind, id);
      if (!row || row.version !== version) throw new DomainError('version_conflict', 'Conflict', 409);
      const next = { ...row, version: version + 1, data: { ...row.data, ...patch } };
      rows.set(key(module, kind, id), next);
      return next;
    },
    async emit() {},
  };
  return ctx;
}

async function createShare(ctx: Context, permissions: string[]) {
  const draft = await commands.create_delivery.run(ctx, {
    title: 'Client deliverable', description: 'Approved public wording', items: [{ title: 'Report', status: 'ready', email: 'private@example.test' }],
  }) as Entity;
  const { id: deliveryId } = await commands.publish_delivery.run(ctx, { id: draft.id, version: draft.version }) as Entity;
  const preview = await commands.preview_share.run(ctx, { deliveryId }) as { previewVersion: number };
  const expiresAt = new Date(Date.parse(ctx.now) + 60_000).toISOString();
  await assert.rejects(commands.create_share.run(ctx, { deliveryId, previewVersion: 1, permissions, expiresAt }), { code: 'stale_preview' });
  return await commands.create_share.run(ctx, { deliveryId, previewVersion: preview.previewVersion, permissions, expiresAt }) as Entity;
}

const secret = new Uint8Array(32).fill(42);

test('short-lived signatures reject tampering, replay across purposes and expiry', () => {
  const tokens = collaborationTokens(secret);
  const now = 1_700_000_000_000;
  const id = 'a'.repeat(32);
  const token = tokens.mint('share', id, now + 86_400_000, now);
  assert.equal(tokens.verify('share', token, now + 899_000), id);
  assert.throws(() => tokens.verify('share', token, now + 900_000), { status: 404 });
  assert.throws(() => tokens.verify('unsubscribe', token, now), { status: 404 });
  assert.throws(() => tokens.verify('share', token.replace(id, 'b'.repeat(32)), now), { status: 404 });
});

test('share HTTP route checks trusted scope, action grants and live revocation', async t => {
  const ctx = workspace('private-workspace');
  const share = await createShare(ctx, ['view', 'comment']);
  const app = Fastify();
  t.after(() => app.close());
  registerCollaboration(app, {
    signingKey: secret,
    async workspace(request, workspaceId, run) {
      if (request.headers.cookie !== 'local-session=trusted') throw new DomainError('unauthenticated', 'Sign in required', 401);
      if (workspaceId !== ctx.workspaceId) throw new DomainError('not_found', 'Workspace not found', 404);
      return run(ctx);
    },
    async publicWork(locator, id, run) {
      if (locator === 'team.share' && id === share.id) return run(ctx);
    },
  });
  const issue = { workspaceId: ctx.workspaceId, shareId: share.id, role: 'owner', tenantId: 'forged' };
  const post = (url: string, payload: object, cookie?: string) => app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : undefined });
  assert.equal((await post('/api/portal/share-token', issue)).statusCode, 401);
  assert.equal((await post('/api/portal/share-token', { ...issue, workspaceId: 'other-workspace' }, 'local-session=trusted')).statusCode, 404);
  const minted = await post('/api/portal/share-token', issue, 'local-session=trusted');
  assert.equal(minted.statusCode, 200);
  const { token } = minted.json().data;
  const external = await post('/api/portal/share', { token, tenantId: 'other', workspaceId: 'other', role: 'owner' });
  assert.equal(external.statusCode, 200);
  assert.equal(external.headers['cache-control'], 'no-store');
  assert.deepEqual(external.json().data.items, [{ title: 'Report', status: 'ready' }]);
  assert.doesNotMatch(external.body, /private-workspace|private-tenant|private@example|owner-local/);
  assert.equal((await post('/api/portal/share', { token, action: 'approve' })).statusCode, 403);
  assert.equal((await post('/api/public/unsubscribe', { token })).statusCode, 404);
  const comment = await post('/api/portal/share', { token, action: 'comment', text: 'Feedback' });
  assert.deepEqual(comment.json().data.comments, [{ text: 'Feedback', at: ctx.now }]);
  await commands.revoke_share.run(ctx, { id: share.id, version: share.version });
  assert.equal((await post('/api/portal/share', { token })).statusCode, 404);
});

test('unsubscribe requires its signed POST and records one channel withdrawal without exposing the customer', async t => {
  const ctx = workspace('unsubscribe-workspace');
  const customer = await lifecycle.create_customer.run(ctx, {});
  const link = await lifecycle.create_unsubscribe_link.run(ctx, { customer_id: customer.id, channel: 'email' });
  const app = Fastify();
  t.after(() => app.close());
  registerCollaboration(app, {
    signingKey: secret,
    async workspace(_request, _id, run) { return run(ctx); },
    async publicWork(locator, id, run) {
      if (locator === 'lifecycle.unsubscribe_link' && id === link.id) return run(ctx);
    },
  });
  const now = Date.now();
  const token = collaborationTokens(secret).mint('unsubscribe', link.id, now + 60_000, now);
  const url = '/api/public/unsubscribe';
  assert.equal((await app.inject({ method: 'GET', url })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url, payload: { token: `${token}x` } })).statusCode, 404);
  assert.deepEqual(await ctx.list('lifecycle', 'consent_record'), []);
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await app.inject({ method: 'POST', url, payload: { token, channel: 'sms', workspaceId: 'untrusted' } });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { data: { accepted: true } });
  }
  const [withdrawal, duplicate] = await ctx.list('lifecycle', 'consent_record');
  assert.equal(duplicate, undefined);
  assert.equal(withdrawal.data.channel, 'email');
});

test('creator capability submits only its bound deliverable and is consumed on success', async t => {
  const ctx = workspace('creator-workspace');
  const collaboration = await ctx.insert('creator', 'collaboration', { status: 'active' });
  const terms = await ctx.insert('creator', 'collaboration_terms', { collaboration_id: collaboration.id, sign_status: 'signed' });
  await ctx.update('creator', 'collaboration', collaboration.id, { current_terms_revision_id: terms.id }, collaboration.version);
  const deliverable = await ctx.insert('creator', 'deliverable', { collaboration_id: collaboration.id, status: 'requested' });
  const unrelated = await ctx.insert('creator', 'deliverable', { collaboration_id: collaboration.id, status: 'requested' });
  const app = Fastify();
  t.after(() => app.close());
  registerCollaboration(app, {
    signingKey: secret,
    async workspace(request, id, run) {
      if (request.headers.cookie !== 'local-session=trusted' || id !== ctx.workspaceId) throw new DomainError('unauthenticated', 'Sign in required', 401);
      return run(ctx);
    },
    async publicWork(locator, id, run) {
      if (locator === 'team.share' && await ctx.get('team', 'share', id)) return run(ctx);
    },
  });
  const minted = await app.inject({ method: 'POST', url: '/api/portal/creator-token', headers: { cookie: 'local-session=trusted' },
    payload: { workspaceId: ctx.workspaceId, deliverableId: deliverable.id } });
  assert.equal(minted.statusCode, 200);
  const { token } = minted.json().data;
  const payload = { token, deliverableId: unrelated.id, post_url: 'https://creator.example.test/post' };
  const submit = () => app.inject({ method: 'POST', url: '/api/portal/creator-submit', payload });
  assert.deepEqual((await submit()).json(), { data: { accepted: true } });
  assert.equal((await submit()).statusCode, 404);
  const [version, duplicate] = await ctx.list('creator', 'deliverable_version');
  assert.equal(duplicate, undefined);
  assert.equal(version.data.deliverable_id, deliverable.id);
  assert.equal((await ctx.get('creator', 'deliverable', unrelated.id))?.data.status, 'requested');
});

test('share becomes unavailable when its scoped revision or time changes', async () => {
  const ctx = workspace('test-workspace');
  const share = await createShare(ctx, ['view', 'approve']);
  await portalShare(ctx, share.id, 'approve');
  await assert.rejects(portalShare(ctx, share.id, 'request_changes'), { code: 'already_decided' });
  await assert.rejects(portalShare({ ...ctx, now: share.data.expiresAt }, share.id, 'view'), { status: 404 });
  await ctx.update('team', 'delivery', share.data.deliveryId, { description: 'Revised' }, share.data.deliveryVersion);
  await assert.rejects(portalShare(ctx, share.id, 'view'), { status: 404 });
  assert.equal(canReadCollaborationRecord('traffic', 'lead_contact', 'viewer'), false);
});
