import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildApp } from '../../apps/server/src/app.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { operations as agentOperations } from '../../apps/server/src/modules/agent/index.ts';
import { operations as contentOperations } from '../../apps/server/src/modules/content/index.ts';
import { catalogOperations } from '../../apps/server/src/modules/commerce/catalog-operations.ts';
import { operations as planningOperations } from '../../apps/server/src/modules/planning/index.ts';
import { createServer } from '../../apps/server/src/server.ts';
import { fileStore } from '../../packages/db/src/index.ts';
import { MemoryStore } from '../../apps/server/src/memory.ts';
import { discover, register } from '../../apps/server/src/registry.ts';

const modules = {
  account: () => import('../../apps/server/src/modules/account/index.ts'),
  analytics: () => import('../../apps/server/src/modules/analytics/index.ts'),
  commerce: () => import('../../apps/server/src/modules/commerce/index.ts'),
  content: () => import('../../apps/server/src/modules/content/index.ts'),
  execution: () => import('../../apps/server/src/modules/execution/index.ts'),
  ingest: () => import('../../apps/server/src/modules/ingest/index.ts'),
  planning: () => import('../../apps/server/src/modules/planning/index.ts'),
  team: () => import('../../apps/server/src/modules/team/index.ts'),
};

const origin = 'http://127.0.0.1:3401';
const setupToken = 'local-acceptance-setup';
const instant = '2026-11-19T12:00:00.000Z';
const due = '2026-11-19T12:05:00.000Z';
const collaboration = () => import('../../apps/server/src/extensions/collaboration.ts');

async function loadModules(names) {
  const registry = new Map();
  for (const name of names) register(registry, name, (await modules[name]()).commands);
  const extensions = new Map();
  if (names.includes('team')) extensions.set('collaboration', await collaboration());
  return { registry, extensions };
}

test.beforeEach(t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(instant) });
  t.mock.method(globalThis, 'fetch', async () => assert.fail('Acceptance fixtures must not make outbound requests'));
});

async function fixture(t, name, ...names) {
  const store = name === 'share' ? await shareStore() : new MemoryStore();
  const modules = await loadModules(names);
  const { app } = buildApp({ ...modules, store, origin, setupToken, secureCookie: false, origins: new Set([origin]), secret: '1a'.repeat(32) });
  t.after(() => app.close());
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { origin, 'x-setup-token': setupToken }, payload: {
    email: `${name}@example.invalid`, name, workspaceName: `${name} workspace`, password: 'acceptance-fixture-only-2026',
  } });
  const { workspaces, user } = response(setup, 200, 201);
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  assert.match(cookie, /^smartsell_session=.+/);
  const sessionHash = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
  const wid = workspaces[0].id;
  const request = (method, url, payload, headers = {}, authenticated = true) => app.inject({ method, url, payload, headers: {
    origin, ...(authenticated ? { cookie } : {}), ...headers,
  } });
  const endpoint = (module, action) => `/api/v1/workspaces/${wid}/commands/${module}/${action}`;
  const command = (module, action, payload) => request('POST', endpoint(module, action), payload, { 'idempotency-key': randomUUID() });
  const run = async (module, action, payload) => response(await command(module, action, payload), 200).data;
  // Seed only prerequisites that would otherwise need a provider or an IAM backend.
  const transact = (action, fn) => store.workspace(sessionHash, wid, unit => unit.command({ module: 'acceptance', action, key: randomUUID(), fingerprint: action }, () => fn(unit.context)));
  const inspect = fn => store.workspace(sessionHash, wid, unit => fn(unit.context));
  return { request, command, run, transact, inspect, wid, user, registry: modules.registry };
}

function response(reply, ...allowed) {
  assert.ok(allowed.includes(reply.statusCode), `Expected ${allowed.join('/')} for request, got ${reply.statusCode}: ${reply.body}`);
  return reply.json();
}

const revision = result => ({ variant_id: result.variant.id, expected_version: result.variant.version, base_revision_id: result.revision.id });
const draft = text => ({ body_doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });

async function content(s, format = 'text', platform = 'facebook') {
  const brand = await s.transact('brand', ctx => ctx.insert('workspace', 'brand', { name: 'Acceptance brand', status: 'active' }));
  const result = await s.run('content', 'content_create_draft', { title: 'Launch draft', brand_id: brand.id,
    variants: [{ platform, format, locale: 'en-US', market_id: 'US', ...draft('Original draft') }] });
  return { variant: result.variants[0], revision: result.revisions[0] };
}

async function approveTarget(s, current, route) {
  let account_id = 'offline-provider-account';
  if (route === 'official') {
    const { createAccountModule } = await modules.account();
    const account = createAccountModule();
    const externalAccountIds = ['fixture-page'];
    const grant = await s.transact('provider_grant', ctx => account.internal.recordGrant(ctx, {
      provider: 'meta_facebook', principalId: 'fixture-page', scopes: ['pages_manage_posts'],
      expiresAt: '2026-11-20T12:00:00Z', externalAccountIds,
    }));
    const social = await s.run('account', 'register_account', {
      provider: 'meta_facebook', external_account_id: 'fixture-page', name: 'Fixture page',
      brand_id: current.variant.data.brand_id, default_timezone: 'UTC', owned_account_confirmed: true, connection_id: grant.id,
    });
    account_id = social.id;
  }
  await s.run('planning', 'set_publishing_profile', {
    account_id, platform: 'facebook', timezone: 'UTC', account_identity: 'fixture-page', formats: ['text'],
    official_capability: route === 'official', manual_capability: true, adapter_key: 'offline', quota_limit: 1,
  });
  const target = await s.run('planning', 'create_target', { account_id, content_variant_id: current.variant.id,
    revision_id: current.revision.id, route, scheduled_at: due, visibility: 'public' });
  const submitted = await s.run('planning', 'submit', { target_id: target.id, expected_version: target.version });
  const approval = { target_id: target.id, expected_version: submitted.version, frozen_hash: submitted.data.frozen_hash };
  assert.equal((await s.command('planning', 'approve', approval)).statusCode, 403, 'Submitter cannot approve');
  // The in-memory setup creates one owner. Use a fixture reviewer only for the approval step.
  const approve = s.registry.get('planning').get('approve');
  return s.transact('reviewer_approval', ctx => approve.run({ ...ctx, actorId: randomUUID(), role: 'reviewer' }, approval));
}

test('A01 draft handoff rejects stale writes and a restored revision cannot reuse approval', async t => {
  const s = await fixture(t, 'draft', 'content', 'planning', 'execution');
  const first = await content(s);
  const current = await s.run('content', 'content_commit_revision', { ...revision(first), ...draft('Human revision') });
  const stale = await s.command('content', 'content_update_variant', { ...revision(first), ...draft('Stale edit') });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.notEqual(first.revision.id, current.revision.id);
  const target = await approveTarget(s, current, 'manual');
  const restored = await s.run('content', 'content_restore_revision', { ...revision(current), revision_id: first.revision.id });
  assert.notEqual(restored.revision.id, first.revision.id);
  assert.equal(restored.revision.data.restored_from_revision_id, first.revision.id);
  const history = await s.run('content', 'content_list_revisions', { variant_id: first.variant.id });
  assert.deepEqual(new Set(history.map(row => row.id)), new Set([first.revision.id, current.revision.id, restored.revision.id]));

  const persistedTarget = await s.inspect(ctx => ctx.get('planning', 'publish_target', target.id));
  assert.equal(persistedTarget.data.approval_id, null);
  assert.equal(persistedTarget.data.status, 'draft');
  assert.equal(persistedTarget.data.frozen_hash, null);
  assert.equal(persistedTarget.data.revision_id, null);
  assert.equal(persistedTarget.data.approval_invalidated_reason, 'content_revision_changed');
  const approval = await s.inspect(ctx => ctx.get('planning', 'approval', target.data.approval_id));
  assert.equal(approval.data.status, 'invalidated');
  assert.equal(approval.data.invalidated_reason, 'content_revision_changed');
  const enqueue = await s.command('execution', 'enqueue', { target_id: target.id });
  assert.equal(enqueue.statusCode, 409, enqueue.body);
});

test('A02 transport loss after submit holds the target until observation, with no resubmission', async t => {
  const s = await fixture(t, 'unknown', 'account', 'content', 'planning', 'execution');
  const { createOfficialWorker } = await import('../../apps/server/src/modules/execution/index.ts');
  const current = await content(s);
  const target = await approveTarget(s, current, 'official');
  const task = await s.run('execution', 'enqueue', { target_id: target.id });
  t.mock.timers.setTime(Date.parse(due));
  const prepared = await s.run('execution', 'prepare_official', { task_id: task.id });
  const { fencing_token } = prepared.attempt.data;
  const submits = [];
  const observations = [];
  const worker = createOfficialWorker({ run: callback => s.transact('official_worker', callback) }, new Map([['offline', {
    async submit(request) {
      submits.push(request.client_request_id);
      throw new Error('Fixture lost the response after submit');
    },
    async observe(request) {
      observations.push(request.client_request_id);
      if (observations.length === 1) return { status: 'unknown', code: 'visibility_pending' };
      return { status: 'published', external_post_id: 'offline-post', evidence: 'Fixture matched the original submission' };
    },
  }]]));
  assert.equal((await worker.dispatch(task.id, fencing_token)).task.data.status, 'outcome_unknown');
  const { markers } = await s.run('planning', 'calendar', { view: 'day' });
  assert.equal(markers.find(row => row.target_id === target.id && row.kind === 'publish_target')?.status, 'outcome_unknown');
  assert.equal(markers.some(row => row.target_id === target.id && row.kind === 'platform_post'), false);
  assert.equal((await worker.verify(task.id)).task.data.status, 'outcome_unknown');
  const handover = await s.command('execution', 'handover_manual', { task_id: task.id, assignee_id: s.user.id, reason: 'Unknown result' });
  assert.equal(response(handover, 409).error.code, 'verification_required');
  await worker.dispatch(task.id, fencing_token);
  const reconciled = await worker.verify(task.id);
  assert.equal(reconciled.task.data.status, 'published');
  assert.equal(reconciled.post.data.external_post_id, 'offline-post');
  assert.equal(reconciled.post.data.target_id, target.id);
  assert.equal(submits.length, 1);
  assert.deepEqual(observations, [submits[0], submits[0]]);
});

test('A03 unavailable metrics preserve their causes, true zero and coverage', async t => {
  const s = await fixture(t, 'metrics', 'ingest', 'analytics');
  const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const next = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
  const source = await s.run('ingest', 'create_source', {
    name: 'Offline report', provider: 'file_import', kind: 'file_import', method: 'report_import',
    resources: ['post_metrics'], timezone: 'UTC', authorized: true, allowed_uses: { display: true },
  });
  const refresh = await s.run('ingest', 'sync_refresh', { data_source_id: source.id, resource: 'post_metrics', from: `${day}T00:00:00Z`, to: `${next}T00:00:00Z` });
  const sync_run_id = refresh.id ?? refresh.sync_run_id;
  const lease = await s.run('ingest', 'claim_run', { sync_run_id });
  const fencing = { sync_run_id, fencing_token: lease.fencing_token ?? lease.data.fencing_token };
  const points = { zero: [0, 'observed'], unavailable: [null, 'no_permission'], omitted: [null, 'source_not_provided'], pending: [null, 'not_collected'] };
  await s.run('ingest', 'record_metric_page', { ...fencing, last_page: true,
    records: Object.entries(points).map(([subject_id, [value, availability]]) => ({ subject_id, value, availability, metric_key: 'views', date: day })),
  });
  await s.run('ingest', 'finish_run', { ...fencing, status: 'succeeded' });
  for (const [subject_id, expected] of Object.entries(points)) {
    const result = await s.run('analytics', 'metrics_query', {
      metrics: ['views'], subject: { type: 'platform_post', filter: { subject_ids: [subject_id] } },
      time: { from: day, to: next, tz: 'UTC', basis: 'period' },
    });
    const { value, availability } = result.rows[0].values.views;
    assert.deepEqual([value, availability], expected, subject_id);
    assert.equal(result.coverage.subjects_total, 1);
    assert.equal(result.coverage.subjects_observed, subject_id === 'zero' ? 1 : 0);
  }
});

test('A04 Amazon CSV strips buyer fields from persisted import and accounting records', async t => {
  const s = await fixture(t, 'amazon', 'commerce', 'analytics');
  const store = await s.run('commerce', 'create_store', { name: 'Amazon US', provider: 'amazon_sp', default_currency: 'USD', default_locale: 'en-US' });
  const privateValues = /buyer@example\.invalid|98101|Private_Buyer_Address/;
  const order = await s.run('commerce', 'preview_import', { store_id: store.id, template_key: 'order_list',
    csv: 'external_order_id,placed_at,currency,total_minor,financial_status,buyerEmail,postalCode,shippingAddress\n'
      + '123-1234567-1234567,2026-11-12T10:00:00Z,USD,1599,paid,buyer@example.invalid,98101,Private_Buyer_Address' });
  assert.doesNotMatch(JSON.stringify(order), privateValues);
  const commits = await s.inspect(ctx => ctx.list('commerce', 'import_batch'));
  assert.ok(commits.length > 0);
  assert.doesNotMatch(JSON.stringify(commits), privateValues);
  await s.run('commerce', 'commit_import', { batch_id: order.batch_id, expected_version: order.version });
  const refund = await s.run('commerce', 'preview_import', { store_id: store.id, template_key: 'refund_list',
    csv: 'external_order_id,external_refund_id,created_at,currency,amount_minor,status,postalCode\n'
      + '123-1234567-1234567,refund-01,2026-11-13T14:00:00Z,USD,249,succeeded,98101' });
  await s.run('commerce', 'commit_import', { batch_id: refund.batch_id, expected_version: refund.version });
  const report = await s.run('analytics', 'revenue_query', { period: { from: '2026-11-01', to: '2026-12-01', tz: 'UTC' }, store_ids: [store.id] });
  assert.equal(report.rows[0].observed_net_sales_minor, 1350);
  assert.equal(report.rows[0].observed_refunds_succeeded_minor, 249);
  assert.equal(report.rows[0].refunds_succeeded_minor, null, 'Coverage is incomplete until a source confirms it');
  const records = await s.inspect(ctx => Promise.all([
    ...['import_batch', 'order', 'refund'].map(kind => ctx.list('commerce', kind)),
    ...['raw_record', 'webhook_delivery', 'import_row'].map(kind => ctx.list('ingest', kind)),
  ]));
  assert.ok(records[1].length > 0 && records[2].length > 0, 'Accounting records should be persisted');
  assert.doesNotMatch(JSON.stringify({ records, report, refund }), privateValues);
});

const shareDatabase = process.env.SMARTSELL_ACCEPTANCE_DATABASE_URL;

async function shareStore() {
  const url = new URL(shareDatabase);
  assert.equal(url.protocol, 'postgresql:');
  assert.ok(['127.0.0.1', '[::1]'].includes(url.hostname) && url.pathname === '/smartsell_acceptance', 'Use a dedicated disposable loopback database');
  const { PostgresStore } = await import('../../apps/server/src/postgres.ts');
  return new PostgresStore(shareDatabase);
}

test('A05 previously issued public share stops working as soon as it is revoked',
  { skip: !shareDatabase && 'Run tests/acceptance/with-postgres.sh to exercise the public route' }, async t => {
  const s = await fixture(t, 'share', 'team');
  const delivery = await s.run('team', 'create_delivery', { title: 'For client', description: 'Public summary',
    items: [{ title: 'Report', status: 'ready', email: 'internal@example.invalid' }] });
  await s.run('team', 'publish_delivery', { id: delivery.id, version: delivery.version });
  const preview = await s.run('team', 'preview_share', { deliveryId: delivery.id });
  const share = await s.run('team', 'create_share', { deliveryId: delivery.id, previewVersion: preview.previewVersion,
    permissions: ['view'], expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  const { token } = response(await s.request('POST', '/api/portal/share-token', { workspaceId: s.wid, shareId: share.id }), 200).data;
  const view = () => s.request('POST', '/api/portal/share', { token }, {}, false);
  const visible = await view();
  assert.equal(response(visible, 200).data.title, 'For client');
  assert.equal(visible.headers['cache-control'], 'no-store');
  assert.doesNotMatch(visible.body, /internal@example\.invalid/);
  await s.run('team', 'revoke_share', { id: share.id, version: share.version });
  assert.equal((await view()).statusCode, 404);
});

function rpc(method, params) {
  return { jsonrpc: '2.0', id: 1, method, params };
}

const rpcHeaders = { accept: 'application/json, text/event-stream', 'content-type': 'application/json', 'mcp-protocol-version': '2025-03-26' };
const jobTools = ['agent_jobs_get', 'agent_jobs_list', 'agent_jobs_claim'];

async function operationFixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-acceptance-'));
  const config = configuration({ NODE_ENV: 'test', SETUP_TOKEN: setupToken });
  const operations = [
    ...agentOperations.map(op => ({ ...op, module: 'agent' })),
    ...catalogOperations.map(op => ({ ...op, module: 'commerce' })),
    ...contentOperations.map(op => ({ ...op, module: 'content' })),
    ...planningOperations.map(op => ({ ...op, module: 'planning' })),
  ];
  const store = await fileStore(join(dir, 'state.json'));
  const app = createServer({ config, store, operations });
  t.after(async () => {
    try { await app.close(); } finally { await rm(dir, { recursive: true, force: true }); }
  });
  const account = { email: 'owner-a@example.invalid', name: 'Owner A', workspaceName: 'Tenant A', password: 'acceptance-fixture-only-2026' };
  response(await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { 'x-setup-token': setupToken }, payload: account }), 201);
  const secondEmail = 'owner-b@example.invalid';
  // Bootstrap is single-use. Seed tenant B in the same store; both owners log in over HTTP.
  await store.transaction({ identityWrite: true }, ({ identity }) => {
    const original = identity.get(`user/${identity.get(`email/${account.email}`)}`);
    const actorId = randomUUID();
    const tenantId = randomUUID();
    const workspaceId = randomUUID();
    identity.put(`tenant/${tenantId}`, { id: tenantId, name: 'Tenant B', status: 'active' });
    identity.put(`workspace/${workspaceId}`, { id: workspaceId, tenantId, name: 'Tenant B' });
    identity.put(`user/${actorId}`, { ...original, id: actorId, email: secondEmail, name: 'Owner B' });
    identity.put(`email/${secondEmail}`, actorId);
    identity.put(`member/${actorId}/${workspaceId}`, { userId: actorId, workspaceId, role: 'owner' });
  });
  async function signIn(email) {
    const login = await app.inject({ method: 'POST', url: '/api/v1/login', payload: { email, password: account.password } });
    const { workspaces, csrf_token } = response(login, 200).data;
    const wid = workspaces[0].id;
    const { name: cookieName, value } = login.cookies[0];
    const cookies = { [cookieName]: value };
    const rest = (method, path, payload) => app.inject({ method, url: `/api/v1/workspaces/${wid}${path}`, cookies,
      headers: { 'x-csrf-token': csrf_token, 'idempotency-key': randomUUID() }, payload });
    const issue = async (access, tools) => response(await rest('POST', '/tokens', { access, tools }), 201).data;
    return { wid, rest, issue };
  }
  const rpcRequest = (token, method, params) => app.inject({ method: 'POST', url: '/mcp', payload: rpc(method, params),
    headers: { ...rpcHeaders, ...(token && { authorization: `Bearer ${token}` }) } });
  return { a: await signIn(account.email), b: await signIn(secondEmail), rpcRequest };
}

test('A06 MCP HTTP honors PAT permissions, tenant boundaries and revocation', async t => {
  const { a, b, rpcRequest } = await operationFixture(t);
  const [get, list, claim] = jobTools;
  const foreign = response(await b.rest('POST', '/agent-jobs', { title: 'Private tenant B job' }), 202).data;
  assert.notEqual(a.wid, b.wid);
  const reader = await a.issue('read', [get, list, 'catalog_search']);
  const writer = await a.issue('write', [claim]);
  const unauthorized = await rpcRequest(undefined, 'tools/list', {});
  assert.equal(unauthorized.statusCode, 401);
  assert.match(unauthorized.headers['www-authenticate'], /^Bearer\b/);
  const rpc = async (credential, method, params = {}) => response(await rpcRequest(credential.token, method, params), 200);
  const tools = async credential => (await rpc(credential, 'tools/list')).result.tools.map(tool => tool.name).sort();
  const call = (credential, name, workspace_id, args = {}) => rpc(credential, 'tools/call', { name, arguments: { workspace_id, ...args } });
  assert.deepEqual(await tools(reader), [get, list, 'catalog_search']);
  assert.deepEqual(await tools(writer), [claim]);
  assert.deepEqual((await call(reader, 'catalog_search', a.wid)).result.structuredContent.data, []);
  assert.equal((await call(reader, claim, a.wid, { params: { id: foreign.id }, expected_version: foreign.version })).error?.code, -32602);
  const crossWorkspace = await call(writer, claim, b.wid, { params: { id: foreign.id }, expected_version: foreign.version });
  const crossObject = await call(reader, get, a.wid, { params: { id: foreign.id } });
  for (const denied of [crossWorkspace, crossObject]) {
    assert.equal(denied.result?.isError, true, JSON.stringify(denied));
    assert.equal(denied.result.structuredContent.data.code, 'NOT_FOUND');
    assert.doesNotMatch(JSON.stringify(denied), /Private tenant B job/);
  }
  assert.deepEqual((await call(reader, list, a.wid)).result.structuredContent.data, []);
  const open = response(await a.rest('POST', '/agent-jobs', { title: 'Allowed job' }), 202).data;
  const allowed = await call(writer, claim, a.wid, { params: { id: open.id }, expected_version: open.version });
  const job = allowed.result.structuredContent.data;
  assert.equal(job.status, 'claimed');
  assert.equal((await call(reader, get, a.wid, { params: { id: job.id } })).result.structuredContent.data.title, 'Allowed job');
  assert.deepEqual(response(await b.rest('GET', '/agent-jobs'), 200).data.map(row => row.id), [foreign.id]);
  assert.equal((await a.rest('DELETE', `/tokens/${writer.id}`)).statusCode, 204);
  assert.equal((await rpcRequest(writer.token, 'tools/list', {})).statusCode, 401);
});

test('A07 application discovery registers commands for all nineteen design modules', async () => {
  const { missing } = await discover();
  assert.deepEqual(missing, []);
});

test('A08 default Command entry mounts MCP as a bearer-protected endpoint', async t => {
  const s = await fixture(t, 'mcp-mount', 'commerce');
  const result = await s.request('POST', '/mcp', rpc('tools/list', {}), rpcHeaders, false);
  assert.equal(result.statusCode, 401, result.body);
  assert.match(result.headers['www-authenticate'], /^Bearer\b/);
});


test('CO03 MCP credentials cannot make human TikTok selections', async t => {
  const { a, rpcRequest } = await operationFixture(t);
  const created = response(await a.rest('POST', '/content-items', {
    brand_id: 'local-brand', title: 'TikTok review', variants: [{ platform: 'tiktok', format: 'text', locale: 'en', body: 'Local draft' }],
  }), 200, 201).data;
  const [variant] = created.variants;
  const actions = ['content_autosave_variant', 'content_commit_revision', 'content_update_variant'];
  const readTool = 'content_get_variant';
  const pat = await a.issue('write', [readTool, ...actions]);
  const read = response(await rpcRequest(pat.token, 'tools/call', { name: readTool, arguments: {
    workspace_id: a.wid, params: { id: variant.id },
  } }), 200);
  assert.equal(read.result?.structuredContent?.data.variant.id, variant.id, JSON.stringify(read));
  const settings = { platform_options: { tiktok: { privacy_level: 'SELF_ONLY', commercial_disclosure: 'none' } } };
  for (const name of actions) {
    const rpcResult = response(await rpcRequest(pat.token, 'tools/call', { name, arguments: {
      workspace_id: a.wid, params: { id: variant.id }, expected_version: variant.version,
      body: { base_revision_id: null, settings },
    } }), 200);
    assert.equal(rpcResult.result?.isError, true, JSON.stringify(rpcResult));
    assert.equal(rpcResult.result.structuredContent.data.code, 'human_selection_required');
  }
  const { variant: unchanged } = response(await a.rest('GET', `/content-variants/${variant.id}`), 200).data;
  assert.equal(unchanged.version, variant.version);
  assert.equal(unchanged.current_revision_id, null);
  assert.equal(unchanged.draft_doc.settings.platform_options.tiktok.privacy_level, undefined);
  assert.equal(unchanged.draft_doc.settings.platform_options.tiktok.commercial_disclosure, undefined);
});

test('PL05 the authenticated MCP endpoint excludes human approval mutations', async t => {
  const { a, rpcRequest } = await operationFixture(t);
  const decisions = ['publishing_approve', 'publishing_reject', 'publishing_request_changes', 'publishing_batch_approve'];
  const humanCatalog = response(await a.rest('GET', '/catalog'), 200).data;
  for (const name of decisions) assert.ok(humanCatalog.some(operation => operation.name === name), name);
  const readTool = 'publishing_get_target';
  const token = await a.issue('write', [readTool, ...decisions]);
  const tools = response(await rpcRequest(token.token, 'tools/list', {}), 200).result.tools;
  assert.deepEqual(tools.map(tool => tool.name), [readTool]);
  for (const name of decisions) {
    const result = response(await rpcRequest(token.token, 'tools/call', { name, arguments: {
      workspace_id: a.wid, params: { id: randomUUID() }, expected_version: 1, body: { resource_hash: 'a'.repeat(64) },
    } }), 200);
    assert.equal(result.error?.code, -32602, JSON.stringify(result));
  }
});
