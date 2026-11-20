import { completedReportVersion } from './report-version.mjs';
import { reportGenerationSubscriber } from '../../apps/server/src/modules/analytics/report-generation.ts';
import { workspaceServices } from '../../apps/server/src/integration/workspace-services.ts';
import { makeContext } from '../../apps/server/src/context.ts';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runBackground } from '../../apps/server/src/runtime.ts';
import { fileStore, postgresStore } from '../../packages/db/src/index.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { createSignedWebhookAdapter } from '../../apps/server/src/integration/signed-webhook.ts';
import { createSignedWebhookHost } from '../../apps/server/src/integration/signed-webhook-host.ts';
import { customerEgress } from '../../apps/server/src/integration/customer-egress.ts';
import { discoverOperations } from '../../apps/server/src/operations.ts';
import { createServer } from '../../apps/server/src/server.ts';

const setupToken = 'portal-acceptance-setup';
const assertionKey = randomBytes(32).toString('hex');
const portalOrigin = 'https://portal.example.test';
const account = { email: 'owner@example.test', name: 'Owner', workspaceName: 'Acceptance', password: 'acceptance-only-1234' };

async function http(t, { deferWorker = false, deferScheduler = false, databaseUrl, subscribers = [], customOrigins, opsServices } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-portal-http-'));
  const config = configuration({ SETUP_TOKEN: setupToken, PORTAL_ORIGIN: portalOrigin, PORTAL_ASSERTION_KEY: assertionKey,
    PORTAL_CUSTOM_ORIGINS: customOrigins });
  if (deferWorker) {
    config.roles.delete('worker');
    config.roles.delete('media');
  }
  if (deferScheduler) config.roles.delete('scheduler');
  const store = await (databaseUrl ? postgresStore(databaseUrl) : fileStore(join(directory, 'state.json')));
  const discovered = await discoverOperations();
  discovered.subscribers.push(...subscribers);
  const app = createServer({ config, store, ...discovered, opsServices });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  async function request(path, { method = 'GET', body, headers = {}, status = 200 } = {}) {
    const res = await fetch(`${origin}${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers } });
    const text = await res.text();
    assert.equal(res.status, status, `${method} ${path}: ${text}`);
    return { body: text ? JSON.parse(text) : undefined, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  }
  const setup = await request('/api/v1/setup', { method: 'POST', status: 201, body: account, headers: { 'x-setup-token': setupToken } });
  const { workspaces, csrf_token, user } = setup.body.data;
  const workspace = workspaces[0];
  const headers = { cookie: setup.cookie, 'x-csrf-token': csrf_token };
  const call = async (method, path, body, options = {}) => (await request(`/api/v1/workspaces/${workspace.id}${path}`, {
    ...options, method, body, headers: { ...headers, ...options.headers },
  })).body?.data;
  const generate = async (report, staff = call) => {
    const receipt = await staff('POST', `/reports/${report.id}/versions`, {}, { status: 202 });
    if (deferWorker) {
      // Run the generation job while leaving notification delivery paused for the test.
      await store.transaction({ identityWrite: true }, async tx => {
        const scope = { tenantId: workspace.tenantId, workspaceId: workspace.id, actorId: user.id };
        scope.tenantId ??= tx.identity.get(`workspace/${workspace.id}`).tenantId;
        const ctx = workspaceServices(discovered.operations)(makeContext(await tx.workspace(scope), scope, 'owner'), tx.identity);
        await reportGenerationSubscriber.run(ctx, { data: receipt });
      });
    }
    return completedReportVersion(path => staff('GET', path), receipt);
  };
  return { request, call, generate, workspace, user, headers, store, config, discovered, origin, directory, log: app.log };
}

function assertion(sub, email) {
  const payload = Buffer.from(JSON.stringify({ sub, email, audience: 'client', email_verified: true, origin: portalOrigin,
    jti: randomBytes(32).toString('base64url'), exp: Math.floor(Date.now() / 1_000) + 60 })).toString('base64url');
  return `${payload}.${createHmac('sha256', assertionKey).update(`smartsell:portal-session:v1:${payload}`).digest('base64url')}`;
}

test('Operations HTTP mounts report shares and revalidates recipient claim, link and revocation', async t => {
  const { request, call, generate, headers } = await http(t);
  const report = await call('POST', '/reports', { kind: 'client_monthly', title: 'Client report',
    period: { from: '2026-10-01', to: '2026-11-01' }, sections: [{ key: 'overview', type: 'narrative' }] });
  const draft = await generate(report);
  const revised = await call('PATCH', `/report-versions/${draft.id}/narrative`, { narrative: [{ section_key: 'overview', blocks: [{
    kind: 'fact', text: 'Approved client text', refs: ['overview'],
  }] }] }, { headers: { 'if-match': String(draft.version) } });
  const revision = await call('POST', `/report-versions/${draft.id}/finalize`, {}, { headers: { 'if-match': String(revised.version) } });
  const expires_at = new Date(Date.now() + 60 * 60_000).toISOString();
  const ref = { resource_type: 'report', resource_id: report.id, revision_id: revision.id, audience: 'client', expires_at };
  const share = async (target, permissions) => {
    const payload = { ...ref, ...target, permissions };
    const preview = await call('POST', '/shares/preview', payload);
    return call('POST', '/shares', { ...payload, preview_hash: preview.preview_hash });
  };
  const guest = await share({ grantee_type: 'link' }, ['view']);
  const guestPath = `/api/v1/portal/shares/${guest.id}`;
  const guestHeaders = { Authorization: `Share ${guest.href.split('#')[1]}` };
  assert.equal((await request(guestPath, { headers: guestHeaders })).body.data.text, 'Approved client text');
  await call('DELETE', `/shares/${guest.id}`, undefined, { headers: { 'if-match': String(guest.version) } });
  await request(guestPath, { headers: guestHeaders, status: 404 });
  await request('/api/v1/portal/me', { headers, status: 401 });

  const email = 'client@example.test';
  const named = await share({ grantee_type: 'email', grantee_id: email }, ['view', 'comment']);
  const invitation = await call('POST', '/portal-invitations', { email, audience: 'client', expires_at });
  const namedPath = `/api/v1/portal/shares/${named.id}`;
  const acceptPath = `/api/v1/portal/invitations/${invitation.id}/accept`;
  const token = invitation.href.split('#')[1];
  const exchange = email => request('/api/v1/portal/session', { method: 'POST', body: { assertion: assertion(randomUUID(), email) }, headers: { origin: portalOrigin }, status: 204 });
  const wrong = await exchange('different@example.test');
  await request(acceptPath, { method: 'POST', body: { token }, headers: { origin: portalOrigin, cookie: wrong.cookie }, status: 404 });
  const recipient = await exchange(email);
  const recipientHeaders = { origin: portalOrigin, cookie: recipient.cookie };
  await request(namedPath, { headers: recipientHeaders, status: 404 });
  await request(acceptPath, { method: 'POST', body: { token }, headers: recipientHeaders });
  await request(acceptPath, { method: 'POST', body: { token }, headers: recipientHeaders, status: 404 });
  assert.equal((await request(namedPath, { headers: recipientHeaders })).body.data.title, 'Client report');
  const deliveryPlan = await call('POST', '/delivery-plans', { name: 'Report handoff', period: 'October' });
  const delivery = await call('POST', `/delivery-plans/${deliveryPlan.id}/items`, { ...ref, kind: 'report', title: 'Delivered report', due_at: expires_at });
  const deliveryPath = `/delivery-items/${delivery.id}`;
  const produced = await call('POST', `${deliveryPath}/produce`, { share_id: named.id }, { headers: { 'if-match': String(delivery.version) } });
  await call('POST', `${deliveryPath}/mark-sent`, { receipt_reference: 'staff-recorded' }, { headers: { 'if-match': String(produced.version) } });
  const backfill = await generate(report);
  const corrected = await call('PATCH', `/report-versions/${backfill.id}/narrative`, { narrative: [{ section_key: 'overview', blocks: [{
    kind: 'fact', text: 'New backfilled client text', refs: ['overview'],
  }] }] }, { headers: { 'if-match': String(backfill.version) } });
  await call('POST', `/report-versions/${backfill.id}/finalize`, {}, { headers: { 'if-match': String(corrected.version) } });
  const pinned = (await request(namedPath, { headers: recipientHeaders })).body.data;
  assert.equal(pinned.text, 'Approved client text');
  assert.equal(pinned.status, 'stale');
  assert.equal(pinned.actions.confirm_delivery, true);
  await request(`${namedPath}/confirm-delivery`, { method: 'POST', headers: recipientHeaders, body: {} });
  const [plan] = await call('GET', '/delivery-plans');
  assert.equal(plan.items[0].status, 'confirmed');
  assert.equal(plan.items[0].revision_id, revision.id);
  await request(`${namedPath}/comments`, { method: 'POST', headers: recipientHeaders, body: { text: 'Recipient feedback' } });
  await call('DELETE', `/shares/${named.id}`, undefined, { headers: { 'if-match': String(named.version) } });
  await request(namedPath, { headers: recipientHeaders, status: 404 });
});

test('TE03 portal report listing and detail enforce the client grant across tenants', async t => {
  const { request, call, generate, headers, user, store } = await http(t);
  const tenantId = randomUUID();
  const workspaceId = randomUUID();
  await store.transaction({ identityWrite: true }, ({ identity }) => {
    identity.put(`tenant/${tenantId}`, { id: tenantId, status: 'active' });
    identity.put(`workspace/${workspaceId}`, { id: workspaceId, tenantId, name: 'Other tenant' });
    identity.put(`member/${user.id}/${workspaceId}`, { userId: user.id, workspaceId, role: 'owner' });
  });
  const other = async (method, path, body, options = {}) => (await request(`/api/v1/workspaces/${workspaceId}${path}`, {
    method, body, headers: { ...headers, ...options.headers }, status: options.status,
  })).body?.data;
  const email = 'report-client@example.test';
  const expires_at = new Date(Date.now() + 3600_000).toISOString();
  const createReport = async (staff, title) => {
    const report = await staff('POST', '/reports', { kind: 'client_monthly', title,
      period: { from: '2026-10-01', to: '2026-11-01' }, sections: [{ key: 'overview', type: 'narrative' }] });
    const draft = await generate(report, staff);
    return { report, draft };
  };
  const share = async (staff, title) => {
    const { report, draft } = await createReport(staff, title);
    const revision = await staff('POST', `/report-versions/${draft.id}/finalize`, {}, { headers: { 'if-match': String(draft.version) } });
    const input = { resource_type: 'report', resource_id: report.id, revision_id: revision.id, audience: 'client',
      grantee_type: 'email', grantee_id: email, permissions: ['view'], expires_at };
    const preview = await staff('POST', '/shares/preview', input);
    return staff('POST', '/shares', { ...input, preview_hash: preview.preview_hash });
  };
  const localShare = await share(call, 'Visible client report');
  const foreignShare = await share(other, 'Other tenant report');
  const privateReport = await createReport(call, 'Private draft report');
  const invite = await call('POST', '/portal-invitations', { email, audience: 'client', expires_at });
  const session = await request('/api/v1/portal/session', { method: 'POST', status: 204,
    headers: { origin: portalOrigin }, body: { assertion: assertion(randomUUID(), email) } });
  const client = { cookie: session.cookie, origin: portalOrigin };
  await request(`/api/v1/portal/invitations/${invite.id}/accept`, { method: 'POST', headers: client, body: { token: invite.href.split('#')[1] } });
  const list = async q => (await request(`/api/v1/portal/shares${q ? `?${new URLSearchParams({ q })}` : ''}`, { headers: client })).body.data.map(row => row.id);
  assert.deepEqual(await list(), [localShare.id]);
  assert.deepEqual(await list('  VISIBLE CLIENT  '), [localShare.id]);
  assert.deepEqual(await list('report'), [localShare.id]);
  assert.deepEqual(await list('Other tenant report'), []);
  assert.deepEqual(await list('Private draft report'), []);
  for (const id of [foreignShare.id, privateReport.report.id, privateReport.draft.id]) {
    for (const suffix of ['', '/threads', `/download?file_id=${privateReport.draft.id}`]) {
      await request(`/api/v1/portal/shares/${id}${suffix}`, { headers: client, status: 404 });
    }
  }
  await call('DELETE', `/shares/${localShare.id}`, undefined, { headers: { 'if-match': String(localShare.version) } });
  assert.deepEqual(await list(), []);
});

test('Operations HTTP gates MCP list and call and applies a tenant stop to other workspaces', async t => {
  const { request, call, workspace, user, headers, store } = await http(t);
  const next = randomUUID();
  await store.transaction({ identityWrite: true }, ({ identity }) => {
    const tenantId = identity.get(`workspace/${workspace.id}`).tenantId;
    identity.put(`workspace/${next}`, { id: next, tenantId, name: 'Other workspace' });
    identity.put(`member/${user.id}/${next}`, { userId: user.id, workspaceId: next, role: 'owner' });
  });
  await call('POST', '/admin/connector-auto/emergency-stop', { scope: 'all', confirmed: true, reason: 'Integration check' });
  const status = async () => (await request(`/api/v1/workspaces/${next}/admin/connector-auto`, { headers })).body.data.halted;
  assert.equal(await status(), true);
  await call('POST', '/admin/connector-auto/resume', { scope: 'all', reason: 'Integration check complete' });
  assert.equal(await status(), false);

  const issued = (await request(`/api/v1/workspaces/${workspace.id}/tokens`, { method: 'POST', status: 201, headers,
    body: { access: 'write', tools: ['catalog_search', 'team_members_list', 'automation_rules_list', 'ops_emergency_stop'] } })).body.data;
  const mcp = (method, params) => request('/mcp', { method: 'POST',
    headers: { authorization: `Bearer ${issued.token}`, accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method, params } });
  const listed = await mcp('tools/list');
  assert.deepEqual(listed.body.result.tools.map(tool => tool.name), ['catalog_search']);
  for (const name of ['team_members_list', 'automation_rules_list', 'ops_emergency_stop']) {
    assert.equal((await mcp('tools/call', { name, arguments: { workspace_id: workspace.id } })).body.error.code, -32602);
  }
  assert.ok((await mcp('tools/call', { name: 'catalog_search', arguments: { workspace_id: next } })).body.result.isError);
  await request(`/api/v1/workspaces/${workspace.id}/tokens/${issued.id}`, { method: 'DELETE', headers, status: 204 });
  await request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${issued.token}` }, body: {}, status: 401 });
});

test('TE06 agency branding batch applies authorized rows and reports rejected rows', { timeout: 30_000 }, async t => {
  const northOrigin = 'https://north-batch.example.test';
  const southOrigin = 'https://south-batch.example.test';
  const { request, call, workspace, user, headers, store, config, origin, directory } = await http(t, {
    databaseUrl: process.env.SMARTSELL_CLIENT_DELIVERY_PG_URL, customOrigins: `${northOrigin},${southOrigin}`,
  });
  config.origins.add(origin);
  const [south, viewer, conflict, foreign] = Array.from({ length: 4 }, () => randomUUID());
  await store.transaction({ identityWrite: true }, ({ identity }) => {
    const tenantId = identity.get(`workspace/${workspace.id}`).tenantId;
    for (const [id, role] of [[south, 'admin'], [viewer, 'viewer'], [conflict, 'admin']]) {
      identity.put(`workspace/${id}`, { id, tenantId, name: role });
      identity.put(`member/${user.id}/${id}`, { userId: user.id, workspaceId: id, role });
    }
    const otherTenantId = randomUUID();
    identity.put(`tenant/${otherTenantId}`, { id: otherTenantId, status: 'active' });
    identity.put(`workspace/${foreign}`, { id: foreign, tenantId: otherTenantId, name: 'Other tenant' });
  });

  const script = fileURLToPath(new URL('../../apps/server/src/modules/team/branding-batch.mjs', import.meta.url));
  const manifest = join(directory, 'branding.json');
  const run = async rows => {
    await writeFile(manifest, JSON.stringify(rows));
    return promisify(execFile)(process.execPath, [script, origin, manifest], {
      env: { ...process.env, SMARTSELL_STAFF_SESSION_COOKIE: headers.cookie },
    });
  };
  const north = { workspace_id: workspace.id, label: 'North agency portal', accent: '#113355', portal_origin: northOrigin };
  const southSettings = { workspace_id: south, label: 'South agency portal', accent: '#663311', portal_origin: southOrigin };
  const status = (workspace_id, value, code) => ({ workspace_id, status: value, ...(code && { code }) });
  await assert.rejects(run([north, north]), { code: 1, stderr: /Invalid or duplicate workspace setting at row 2/ });
  assert.deepEqual(await call('GET', '/branding'), {});

  await assert.rejects(run([
    north,
    { ...north, workspace_id: viewer },
    { ...north, workspace_id: foreign },
    { ...north, workspace_id: conflict },
    southSettings,
  ]), error => {
    assert.equal(error.code, 1);
    assert.deepEqual(JSON.parse(error.stdout), [
      status(workspace.id, 200), status(viewer, 403, 'PERMISSION_DENIED'), status(foreign, 404, 'NOT_FOUND'),
      status(conflict, 409, 'PORTAL_DOMAIN_IN_USE'), status(south, 200),
    ]);
    return true;
  });
  for (const { workspace_id, label, accent, portal_origin } of [north, southSettings]) {
    const profile = (await request(`/api/v1/workspaces/${workspace_id}/branding`, { headers })).body.data;
    assert.deepEqual({ label: profile.label, accent: profile.accent, portal_origin: profile.portal_origin }, { label, accent, portal_origin });
  }
  for (const id of [viewer, conflict]) {
    assert.deepEqual((await request(`/api/v1/workspaces/${id}/branding`, { headers })).body.data, {});
  }

  const { stdout } = await run([{ ...southSettings, label: 'South updated', portal_origin: null }]);
  assert.deepEqual(JSON.parse(stdout), [status(south, 200)]);
  const southAfter = (await request(`/api/v1/workspaces/${south}/branding`, { headers })).body.data;
  assert.equal(southAfter.label, 'South updated');
  assert.equal(southAfter.portal_origin, null);
});

test('TE04 queued report notices recheck the same recipient after a role change', { timeout: 30_000 }, async t => {
  const received = [];
  const signingKey = randomBytes(32);
  const peer = createHttpServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/notifications') return res.writeHead(404).end();
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    received.push(body);
    const signature = `sha256=${createHmac('sha256', signingKey).update(body).digest('hex')}`;
    res.writeHead(req.headers['x-smartsell-signature'] === signature ? 204 : 401).end();
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  t.after(() => new Promise((resolve, reject) => peer.close(error => error ? reject(error) : resolve())));
  const recipientId = randomUUID();
  let adapter;
  // Test-only bridge from the production notice event to the production HTTP transport.
  const peerSubscriber = {
    id: 'acceptance.notification-peer',
    accepts: type => type === 'workspace.notification.created',
    async run(ctx, event) {
      if (event.data.recipient_user_id !== recipientId) return;
      const notice = ctx.get('notification', event.data.notification_id);
      if (notice.type !== 'report_finalized') return;
      const result = await adapter.deliver({ tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, targetId: 'fixture',
        kind: 'report', eventId: event.id, eventType: event.type,
        data: { recipient_user_id: recipientId, resource_id: notice.resource_id, report_version_id: notice.report_version_id } });
      assert.equal(result.status, 'delivered');
    },
  };
  const { request, call, generate, workspace, user, store, config, discovered, log } = await http(t, {
    deferWorker: true, databaseUrl: process.env.SMARTSELL_CLIENT_DELIVERY_PG_URL, subscribers: [peerSubscriber],
  });
  const email = 'queued-notices@example.test';
  const scope = await store.transaction({ identityWrite: true }, ({ identity }) => {
    const { tenantId } = identity.get(`workspace/${workspace.id}`);
    const { passwordHash } = identity.get(`user/${user.id}`);
    identity.put(`user/${recipientId}`, { id: recipientId, email, name: 'Notice recipient', passwordHash });
    identity.put(`email/${email}`, recipientId);
    identity.put(`member/${recipientId}/${workspace.id}`, { userId: recipientId, workspaceId: workspace.id, role: 'analyst' });
    return { tenantId, workspaceId: workspace.id, actorId: user.id };
  });
  adapter = createSignedWebhookAdapter({ allowLoopbackHttp: true, timeoutMs: 2_000, targets: [{ id: 'fixture',
    tenantId: scope.tenantId, workspaceId: scope.workspaceId, kinds: ['report'],
    url: `http://127.0.0.1:${peer.address().port}/notifications`, signingKey }] });
  const login = await request('/api/v1/session', { method: 'POST', body: { email, password: account.password } });
  const recipient = { cookie: login.cookie, 'x-csrf-token': login.body.data.csrf_token };
  const createReport = async (kind, title) => call('POST', '/reports', { kind, title,
    period: { from: '2026-10-01', to: '2026-11-01' }, sections: [{ key: 'overview', type: 'narrative' }] });
  const restricted = await createReport('ecommerce', 'Financial report');
  const allowed = await createReport('client_monthly', 'General report');
  const versions = [];
  for (const report of [restricted, allowed]) {
    await call('GET', `/reports/${report.id}`, undefined, { headers: recipient });
    await call('POST', '/subscriptions', { resource_type: 'report', resource_id: report.id }, { headers: recipient });
    const draft = await generate(report);
    const revision = await call('POST', `/report-versions/${draft.id}/finalize`, {}, { headers: { 'if-match': String(draft.version) } });
    await call('GET', `/report-versions/${revision.id}`, undefined, { headers: recipient });
    versions.push(revision.id);
  }

  const inspect = run => store.transaction({ readOnly: true }, async tx => run(await tx.workspace(scope)));
  const waitFor = async (check, message) => {
    const deadline = Date.now() + 10_000;
    do {
      if (await check()) return;
      await delay(50);
    } while (Date.now() < deadline);
    assert.fail(message);
  };
  const jobIds = await inspect(records => records.list('outbox/')
    .filter(event => event.type === 'analytics.report_version.finalized' && versions.includes(event.payload.version_id))
    .map(event => `analytics.report-subscriptions/${event.id}`));
  assert.equal(jobIds.length, 2);
  await waitFor(() => inspect(records => jobIds.every(id => records.get(`job/${id}`)?.status === 'queued')),
    'Both report subscriber jobs must be queued before the role changes');
  const notices = () => call('GET', '/notifications?type=report_finalized', undefined, { headers: recipient });
  assert.deepEqual((await notices()).items, []);

  await call('PATCH', `/members/${recipientId}/roles`, { role: 'viewer' });
  await call('GET', `/report-versions/${versions[0]}`, undefined, { headers: recipient, status: 403 });
  await call('GET', `/report-versions/${versions[1]}`, undefined, { headers: recipient });
  const stop = runBackground(store, { ...config, roles: new Set(['worker']) }, discovered.subscribers, [], log, discovered.operations);
  try {
    await waitFor(() => inspect(records => jobIds.every(id => records.get(`consumed/${id}`) && !records.get(`job/${id}`))),
      'The production worker must consume both queued jobs');
    const delivered = (await notices()).items;
    assert.deepEqual(delivered.map(row => [row.resource_id, row.report_version_id]), [[allowed.id, versions[1]]]);
    await inspect(records => {
      const written = records.list('row/notification/').filter(row => row.recipient_user_id === recipientId && row.type === 'report_finalized');
      assert.deepEqual(written.map(row => row.id), [delivered[0].id]);
      const deliveries = records.list('row/notification_delivery/').filter(row => row.notification_id === delivered[0].id);
      assert.deepEqual(deliveries.map(row => [row.channel, row.status]), [['in_app', 'delivered']]);
    });
    const eventIds = await inspect(records => records.list('outbox/')
      .filter(event => event.type === 'workspace.notification.created' && event.payload.recipient_user_id === recipientId)
      .map(event => event.id));
    assert.equal(eventIds.length, 1);
    await waitFor(() => inspect(records => records.get(`consumed/${peerSubscriber.id}/${eventIds[0]}`)),
      'The worker must complete the synthetic peer delivery');
    assert.deepEqual(received.map(body => {
      const { id, type, tenant_id, workspace_id, data } = JSON.parse(body);
      return { id, type, tenant_id, workspace_id, data };
    }), [{ id: eventIds[0], type: 'workspace.notification.created', tenant_id: scope.tenantId, workspace_id: workspace.id,
      data: { recipient_user_id: recipientId, resource_id: allowed.id, report_version_id: versions[1] } }]);
  } finally {
    await stop();
  }
});

test('TE04 daily digest filters both queues after role changes and preserves another recipient', { timeout: 45_000 }, async t => {
  const [beforeWorker, beforeWebhook] = [randomUUID(), randomUUID()];
  const received = [];
  const signingKey = randomBytes(32).toString('hex');
  const peer = createHttpServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    const signature = `sha256=${createHmac('sha256', signingKey).update(body).digest('hex')}`;
    if (req.method !== 'POST' || req.url !== '/digest' || req.headers['x-smartsell-signature'] !== signature) {
      return res.writeHead(401).end();
    }
    received.push(JSON.parse(body));
    res.writeHead(204).end();
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  t.after(() => new Promise((resolve, reject) => peer.close(error => error ? reject(error) : resolve())));
  const url = `http://127.0.0.1:${peer.address().port}/digest`;
  const eventType = 'workspace.notification_digest.ready';
  const { request, call, generate, workspace, user, store, config, discovered, log } = await http(t, {
    deferWorker: true, deferScheduler: true, databaseUrl: process.env.SMARTSELL_CLIENT_DELIVERY_PG_URL,
    opsServices: { allowLoopbackWebhook: (_ctx, endpoint, secretId) => endpoint === url && secretId === 'digest' },
  });
  const scope = await store.transaction({ identityWrite: true }, tx => {
    const { identity } = tx;
    const { tenantId } = identity.get(`workspace/${workspace.id}`);
    const { passwordHash } = identity.get(`user/${user.id}`);
    for (const id of [beforeWorker, beforeWebhook]) {
      const email = `${id}@example.test`;
      identity.put(`user/${id}`, { id, email, name: 'Digest recipient', passwordHash });
      identity.put(`email/${email}`, id);
      identity.put(`member/${id}/${workspace.id}`, { userId: id, workspaceId: workspace.id, role: 'analyst' });
    }
    return { tenantId, workspaceId: workspace.id, actorId: user.id };
  });
  const { id: target } = await call('POST', '/admin/webhook-subscriptions', {
    url, secret_id: 'digest', event_types: [eventType],
  });
  const egress = customerEgress({ NODE_ENV: 'test', SMARTSELL_WEBHOOK_LOOPBACK: '1', SMARTSELL_EGRESS_SECRET_DIGEST: signingKey,
    SMARTSELL_CUSTOMER_EGRESS: JSON.stringify([{ ...scope, kind: 'webhook', secretId: 'digest',
      secretEnv: 'SMARTSELL_EGRESS_SECRET_DIGEST', url }]) });
  const signed = createSignedWebhookHost(egress, { allowLoopbackHttp: true });
  const subscribers = [...discovered.subscribers, signed.subscriber];
  const schedules = discovered.schedules.filter(schedule => schedule.id === 'workspace.notification-digest');
  assert.equal(schedules.length, 1);
  const inspect = run => store.transaction({ readOnly: true }, async tx => run(await tx.workspace(scope)));
  const stage = async (role, check, message, drain) => {
    const stop = runBackground(store, { ...config, roles: new Set([role]) }, subscribers, schedules, log, discovered.operations, egress, drain);
    try {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if (await inspect(check)) return;
        await delay(50);
      }
      assert.fail(message);
    } finally {
      await stop();
    }
  };
  const headersByUser = new Map();
  for (const id of [beforeWorker, beforeWebhook]) {
    const login = await request('/api/v1/session', { method: 'POST', body: { email: `${id}@example.test`, password: account.password } });
    headersByUser.set(id, { cookie: login.cookie, 'x-csrf-token': login.body.data.csrf_token });
  }
  const recipients = [beforeWorker, beforeWebhook, user.id];
  const as = id => ({ headers: headersByUser.get(id) });
  const notifications = (id, type) => call('GET', `/notifications?type=${type}`, undefined, as(id));
  for (const id of recipients) {
    await call('PUT', '/me/notification-preferences', {
      type_pattern: 'notification_digest', channels: ['in_app', 'chat_webhook'], webhook_subscription_id: target,
    }, as(id));
  }
  await call('PUT', '/admin/egress-policies/workspace', { rules: [{ destination_kind: 'outbound_webhook',
    destination_id: target, data_class: 'internal', effect: 'allow' }] });

  const reports = [];
  for (const [kind, title] of [['ecommerce', 'Financial report'], ['client_monthly', 'General report']]) {
    const report = await call('POST', '/reports', { kind, title, period: { from: '2026-10-01', to: '2026-11-01' },
      sections: [{ key: 'overview', type: 'narrative' }] });
    for (const id of recipients) await call('POST', '/subscriptions', { resource_type: 'report', resource_id: report.id }, as(id));
    const draft = await generate(report);
    const revision = await call('POST', `/report-versions/${draft.id}/finalize`, {}, { headers: { 'if-match': String(draft.version) } });
    for (const id of recipients) await call('GET', `/report-versions/${revision.id}`, undefined, as(id));
    reports.push({ type: 'report_finalized', resource_type: 'report', resource_id: report.id, report_version_id: revision.id, title });
  }
  await stage('worker', records => records.list('row/notification/').filter(row => row.type === 'report_finalized').length === 6,
    'All six individual report notices should be present before the digest schedule runs');
  const sourceIds = await inspect(records => records.list('row/notification/').filter(row => row.type === 'report_finalized')
    .map(row => [row.id, row.resource_id]));
  const reportByNotice = new Map(sourceIds);
  const digestJobs = records => records.list('outbox/').filter(event => event.type === 'workspace.notification_digest.requested');
  await stage('scheduler', records => digestJobs(records).length === 3 && digestJobs(records).every(event =>
    records.get(`job/workspace.notification-digest/${event.id}`)?.status === 'queued'), 'The schedule must queue one digest per recipient');
  await inspect(records => {
    for (const event of digestJobs(records)) {
      assert.deepEqual(event.payload.source_ids.map(id => reportByNotice.get(id)).sort(), reports.map(item => item.resource_id).sort());
    }
  });
  assert.deepEqual((await notifications(beforeWorker, 'notification_digest')).items, []);
  const downgrade = async id => {
    await call('PATCH', `/members/${id}/roles`, { role: 'viewer' });
    await call('GET', `/report-versions/${reports[0].report_version_id}`, undefined, { ...as(id), status: 403 });
    await call('GET', `/report-versions/${reports[1].report_version_id}`, undefined, as(id));
  };
  await downgrade(beforeWorker);
  const deliveries = records => records.list('row/webhook_delivery/').filter(row => row.event_type === eventType);
  await stage('worker', records => deliveries(records).filter(row => row.status === 'queued').length === 3,
    'The signed delivery subscriber must queue all three digests before the transport starts');
  const itemsFor = async id => {
    const { items } = await notifications(id, 'notification_digest');
    assert.equal(items.length, 1);
    assert.equal(Object.hasOwn(items[0], 'digest_source_ids'), false);
    return items[0].items.sort((a, b) => a.title.localeCompare(b.title));
  };
  assert.deepEqual(await itemsFor(beforeWorker), [reports[1]]);
  assert.deepEqual(await itemsFor(beforeWebhook), reports);
  assert.deepEqual(received, []);
  await downgrade(beforeWebhook);
  await stage('worker', records => deliveries(records).filter(row => row.status === 'delivered' && row.response_code === 204).length === 3,
    'The production signed transport must persist all three verified loopback receipts', signed.drain);
  assert.deepEqual(await itemsFor(beforeWebhook), [reports[1]]);
  assert.deepEqual(await itemsFor(user.id), reports);
  const receipts = await call('GET', `/signed-webhook-deliveries?subscription_id=${target}`);
  assert.equal(receipts.length, 3);
  for (const receipt of receipts) {
    assert.equal(receipt.event_type, eventType);
    assert.equal(receipt.status, 'delivered');
    assert.equal(receipt.response_code, 204);
  }
  assert.equal(received.length, 3);
  for (const id of recipients) {
    const envelopes = received.filter(wire => wire.data.recipient_user_id === id);
    assert.equal(envelopes.length, 1);
    assert.equal(envelopes[0].type, eventType);
    assert.equal(envelopes[0].workspace_id, workspace.id);
    assert.equal(envelopes[0].tenant_id, scope.tenantId);
    const byReport = (a, b) => a.resource_id.localeCompare(b.resource_id);
    const expected = (id === user.id ? reports : [reports[1]]).map(({ title, ...reference }) => reference).sort(byReport);
    assert.deepEqual(envelopes[0].data.items.sort(byReport), expected);
  }
});
