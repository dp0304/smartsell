import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../../app.ts';
import { MemoryStore } from '../../memory.ts';
import { register, type Registry } from '../../registry.ts';
import { commands as planning } from '../planning/index.ts';
import type { Context, Data, Row } from '@smartsell/contracts';
import { createPortalHandler, createTeamOperations, registerTeamPortal, schedules, type PortalHost, type PortalPrincipal, type TeamHost } from './index.js';

const origin = 'https://portal.example.test';
const expires_at = '2026-01-02T00:00:00Z';
const ref = { resource_type: 'report', resource_id: 'report1', revision_id: 'revision1' };
const client: PortalPrincipal = { id: 'client1', audience: 'client', verifiedEmail: 'client@example.test' };

function fixture() {
  const tables = new Map<string, Row[]>();
  const events: string[] = [];
  const ctx: Context = {
    workspaceId: 'workspace1', tenantId: 'tenant1', actorId: 'staff1', role: 'owner', now: '2026-01-01T00:00:00Z',
    list(kind) { return tables.get(kind) ?? []; },
    get(kind, id) { const found = this.list(kind).find(row => row.id === id); assert.ok(found); return found; },
    create(kind, values) {
      const item = { ...values, id: `${kind}_${this.list(kind).length + 1}`, version: 1, created_at: this.now, updated_at: this.now };
      tables.set(kind, [...this.list(kind), item]);
      return item;
    },
    update(kind, id, values) {
      const current = this.get(kind, id);
      const next = { ...current, ...values, version: current.version + 1, updated_at: this.now };
      tables.set(kind, this.list(kind).map(row => row.id === id ? next : row));
      return next;
    },
    remove(kind, id) { tables.set(kind, this.list(kind).filter(row => row.id !== id)); },
    emit(type) { events.push(type); },
  };
  const state = { principal: client as PortalPrincipal | undefined, scope: true, current: ref.revision_id, accepts: 0, approvals: 0,
    removalItems: [{ kind: 'work_item', id: 'item_1' }], removed: false };
  const team: TeamHost = {
    project: () => ({ current_revision_id: state.current, title: 'Public report', text: 'Public revision',
      attachments: [{ id: 'file1', name: 'Report.pdf', secret: 'hidden' }], secret: 'hidden' }),
    checkRecipient: (_ctx, audience, id) => audience === 'client' && id === client.id,
    authorizeComment() {},
    decide() { state.approvals++; },
    download: () => 'https://files.example.test/report',
    acceptPortalInvite() { state.accepts++; },
    ambassador: { material: () => ({ title: 'Public report', text: 'Approved copy', rights_until: expires_at }) },
    members: {
      list: () => [{ id: 'm1', user_id: 'staff1', role: 'owner', scopes: [] }, { id: 'm2', user_id: 'staff2', role: 'editor', scopes: ['brand1'] }],
      invite: () => ({ invitation_id: 'invitation1' }), setRole() {},
      previewRemoval: () => state.removalItems,
      remove() { state.removed = true; },
    },
  };
  const ops = createTeamOperations(team);
  const run = async (name: string, body: Data = {}, id = '') => {
    const op = ops.find(op => op.name === name);
    assert.ok(op);
    return await op.run(ctx, { body, params: { id }, query: {} }) as Data;
  };
  const host: PortalHost = { origin, team, authenticate: async () => state.principal,
    workspaceIds: async () => [ctx.workspaceId], canAccessWorkspace: () => state.scope,
    transact: async (_selector, cb) => cb(ctx),
  };
  const handle = createPortalHandler(host);
  const request = (path: string, opts: { body?: Data; token?: string; site?: string } = {}) => handle(new Request(`${origin}/api/v1/portal${path}`, {
    method: opts.body ? 'POST' : 'GET',
    headers: { ...(opts.body ? { 'Content-Type': 'application/json', Origin: opts.site ?? origin } : {}), ...(opts.token ? { Authorization: `Share ${opts.token}` } : {}) },
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  }));
  const shareInput = (patch: Data = {}): Data => ({ ...ref, expires_at, audience: 'client', grantee_type: 'portal_user', grantee_id: 'client1', permissions: ['view'], ...patch });
  async function share(patch: Data = {}) {
    const input = shareInput(patch);
    const preview = await run('team_share_preview', input);
    return run('team_share_create', { ...input, preview_hash: preview.preview_hash });
  }
  return { ctx, state, run, shareInput, share, request, events, host };
}

test('the standalone mount scopes HTTP routes and preserves access headers', async t => {
  const { host, share } = fixture();
  const grant = await share({ grantee_type: 'link' });
  const token = String(grant.href).split('#')[1]!;
  const app = Fastify();
  t.after(() => app.close());
  registerTeamPortal(app, host);
  const detail = await app.inject({ method: 'GET', url: `/api/v1/portal/shares/${grant.id}`, headers: { authorization: `Share ${token}` } });
  assert.equal(detail.statusCode, 200);
  assert.match(detail.headers['cache-control']!, /no-store/);
  assert.equal(detail.json().data.title, 'Public report');
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/workspaces' })).statusCode, 404);
});

test('links use a hashed capability, allow only read/download, and stop at revocation or expiry', async () => {
  const { ctx, run, share, request } = fixture();
  await assert.rejects(share({ grantee_type: 'link', permissions: ['view', 'approve'] }), { status: 422 });
  const first = await share({ grantee_type: 'link', permissions: ['view', 'download'] });
  const second = await share({ grantee_type: 'link' });
  const token = String(first.href).split('#')[1]!;
  const path = `/shares/${first.id}`;
  const valid = await request(path, { token });
  assert.equal(valid.status, 200);
  assert.match(valid.headers.get('Cache-Control')!, /no-store/);
  assert.doesNotMatch(await valid.text(), /tenant1|workspace1|revision1|secret|grantee|token/);
  assert.doesNotMatch(JSON.stringify(ctx.list('share')), new RegExp(token));
  assert.equal((await request(`/shares/${second.id}`, { token })).status, 404);
  assert.equal((await request(`${path}/download?file_id=other`, { token })).status, 404);
  assert.equal((await request(`${path}/download?file_id=file1`, { token })).status, 200);
  assert.equal((await request(`${path}/approve`, { token, body: {} })).status, 403);
  ctx.now = expires_at;
  assert.equal((await request(path, { token })).status, 404);
  ctx.now = '2026-01-01T00:00:00Z';
  await run('team_share_revoke', {}, String(first.id));
  assert.equal((await request(path, { token })).status, 404);
});

test('[AS06-DOWNLOAD-PUBLISH] an asset share token grants download without a workspace publish session', async t => {
  const { host, share } = fixture();
  const shared = await share({ resource_type: 'asset', resource_id: 'asset1', grantee_type: 'link', permissions: ['view', 'download'] });
  const token = String(shared.href).split('#')[1]!;
  const store = new MemoryStore();
  await store.setup({ email: 'owner@example.invalid', name: 'Owner', workspaceName: 'Assets', passwordHash: 'unused' }, 'owner-token-hash');
  const wid = (await store.session('owner-token-hash'))!.workspaces[0].id;
  const registry: Registry = new Map();
  register(registry, 'planning', planning);
  const { app } = buildApp({ store, registry, secureCookie: false, origins: new Set([origin]) });
  registerTeamPortal(app, host);
  t.after(() => app.close());
  const headers = { authorization: `Share ${token}` };
  const download = await app.inject({ method: 'GET', url: `/api/v1/portal/shares/${shared.id}/download?file_id=file1`, headers });
  assert.equal(download.statusCode, 200, download.body);
  const publish = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${wid}/commands/planning/submit`,
    headers: { ...headers, 'idempotency-key': randomUUID(), origin }, payload: { target_id: 'target', expected_version: 1 } });
  assert.equal(publish.statusCode, 401, publish.body);
});

test('recipient, workspace, CSRF, exact revision, and per-share comment visibility gate access', async () => {
  const { state, run, share, shareInput, request } = fixture();
  const external = await run('team_thread_create', { ...ref, audience: 'client' });
  const thread = String(external.id);
  await run('comments_add', { visibility: 'internal', text: 'private notes' }, thread);
  const input = shareInput({ thread_ids: [thread] });
  const preview = await run('team_share_preview', input);
  await run('comments_add', { visibility: 'client', text: 'public notes' }, thread);
  await assert.rejects(run('team_share_create', { ...input, preview_hash: preview.preview_hash }), { status: 409 });
  const first = await share({ thread_ids: [thread], permissions: ['view', 'comment', 'approve'] });
  const second = await share({ thread_ids: [thread] });
  const path = `/shares/${first.id}`;
  state.principal = { ...client, id: 'other' };
  assert.equal((await request(path)).status, 404);
  assert.deepEqual((await (await request('/shares')).json()).data, []);
  state.principal = client;
  state.scope = false;
  assert.equal((await request(path)).status, 404);
  state.scope = true;
  assert.equal((await request(`${path}/comments`, { body: { text: 'feedback' }, site: 'https://evil.example.test' })).status, 403);
  assert.equal((await request(`${path}/comments`, { body: { text: 'feedback', thread_id: thread } })).status, 200);
  const firstText = await (await request(path)).text();
  assert.match(firstText, /feedback/);
  assert.match(firstText, /public notes/);
  assert.doesNotMatch(firstText, /private notes|portal_author_id|staff1/);
  assert.doesNotMatch(await (await request(`/shares/${second.id}`)).text(), /feedback/);
  assert.equal((await request(`${path}/approve`, { body: {} })).status, 200);
  state.current = 'revision2';
  assert.match(await (await request(path)).text(), /stale/);
  assert.equal((await request(`${path}/approve`, { body: {} })).status, 409);
  assert.equal(state.approvals, 1);
});

test('portal invites require the verified audience and are single use', async () => {
  const { state, run, request } = fixture();
  const invitation = await run('team_portal_invite', { audience: 'client', email: client.verifiedEmail, expires_at });
  const token = String(invitation.href).split('#')[1]!;
  const path = `/invitations/${invitation.id}/accept`;
  state.principal = { ...client, verifiedEmail: undefined };
  assert.equal((await request(path, { body: { token } })).status, 404);
  state.principal = client;
  assert.equal((await request(path, { body: { token } })).status, 200);
  assert.equal((await request(path, { body: { token } })).status, 404);
  assert.equal(state.accepts, 1);
});

test('membership removal uses authoritative IAM and reconfirms a changed handover', async () => {
  const { ctx, state, run, events } = fixture();
  const invite = await run('team_member_invite', { email: 'New@example.test', role: 'editor', scopes: ['brand1'] });
  assert.deepEqual(invite, { invitation_id: 'invitation1' });
  await assert.rejects(run('team_member_roles_update', { role: 'owner' }, 'm2'), { status: 403 });
  const preview = await run('team_member_remove', {}, 'm2');
  state.removalItems.push({ kind: 'agent_job', id: 'job1' });
  await assert.rejects(run('team_member_remove', { preview_hash: preview.preview_hash }, 'm2'), { status: 409 });
  assert.equal(state.removed, false);
  const fresh = await run('team_member_remove', {}, 'm2');
  await run('team_member_remove', { preview_hash: fresh.preview_hash, to_user_id: 'staff1' }, 'm2');
  assert.equal(state.removed, true);
  assert.equal(ctx.list('handover_item').length, 2);
  assert.ok(events.includes('team.member.removed'));
});

test('delivery records production, manual send, and client confirmation as separate steps', async () => {
  const { ctx, run, share, request } = fixture();
  const grant = await share();
  const plan = await run('team_delivery_plan_create', { name: 'Monthly report', period: 'January' });
  const item = await run('team_delivery_item_create', { ...ref, due_at: expires_at, kind: 'report', title: 'Report' }, String(plan.id));
  await assert.rejects(run('team_delivery_item_mark_sent', { receipt_reference: 'manual-1' }, String(item.id)), { status: 409 });
  await run('team_delivery_item_produce', { share_id: grant.id }, String(item.id));
  ctx.now = '2026-01-01T01:00:00Z';
  await run('team_delivery_item_mark_sent', { receipt_reference: 'manual-1' }, String(item.id));
  ctx.now = '2026-01-01T02:00:00Z';
  assert.equal((await request(`/shares/${grant.id}/confirm-delivery`, { body: {} })).status, 200);
  const [stored] = ctx.list('delivery_item');
  assert.equal(stored?.status, 'confirmed');
  assert.notEqual(stored?.produced_at, stored?.sent_at);
  assert.notEqual(stored?.sent_at, stored?.confirmed_at);
});

test('daily delivery reminders only reach active shares with outstanding confirmations', async () => {
  const { ctx, run, share, request, events } = fixture();
  const grant = await share();
  const revoked = await share();
  const plan = await run('team_delivery_plan_create', { name: 'Monthly report', period: 'January' });
  for (const share of [grant, revoked]) {
    const item = await run('team_delivery_item_create', { ...ref, due_at: expires_at, kind: 'report', title: 'Report' }, String(plan.id));
    await run('team_delivery_item_produce', { share_id: share.id }, String(item.id));
    await run('team_delivery_item_mark_sent', { receipt_reference: 'manual-1' }, String(item.id));
  }
  await run('team_share_revoke', {}, String(revoked.id));
  const [reminder] = schedules;
  assert.ok(reminder);
  reminder.run(ctx);
  reminder.run(ctx);
  assert.equal(events.filter(type => type === 'team.delivery_item.reminder_requested').length, 1);
  const path = `/shares/${grant.id}`;
  assert.equal((await (await request(path)).json()).data.confirmation_reminder, true);
  assert.equal((await request(`/shares/${revoked.id}`)).status, 404);
  await request(`${path}/confirm-delivery`, { body: {} });
  assert.equal((await (await request(path)).json()).data.confirmation_reminder, false);
  ctx.now = '2026-01-02T00:00:00Z';
  reminder.run(ctx);
  assert.equal(events.filter(type => type === 'team.delivery_item.reminder_requested').length, 1);
});

test('ambassador enrollment and claiming do not count as a verified share', async () => {
  const { ctx, run } = fixture();
  const kit = await run('team_ambassador_kit_create', { ...ref, label: 'Launch', expires_at });
  const id = String(kit.id);
  await assert.rejects(run('team_ambassador_claim', {}, id), { status: 403 });
  await run('team_ambassador_enroll', {}, id);
  await run('team_ambassador_claim', {}, id);
  assert.deepEqual(ctx.list('ambassador_share'), []);
  const recorded = await run('team_ambassador_record_share', { url: 'https://posts.example.test/post' }, id);
  assert.equal(recorded.status, 'reported');
  ctx.now = expires_at;
  await assert.rejects(run('team_ambassador_claim', {}, id), { status: 404 });
  assert.deepEqual(await run('team_ambassador_leave', {}, id), { enrolled: false });
});