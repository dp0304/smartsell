import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileStore } from '../../packages/db/src/index.ts';
import { configuration } from '../../apps/server/src/config.ts';
import { discoverOperations } from '../../apps/server/src/operations.ts';
import { createServer } from '../../apps/server/src/server.ts';
import { makeContext } from '../../apps/server/src/context.ts';
import { recordProviderObservation } from '../../apps/server/src/modules/ops/deployment.ts';
import { openBlock } from '../../apps/server/src/modules/account/device-control.ts';
import { upsertObservedPost } from '../../apps/server/src/modules/execution/service.ts';

async function fixture(t, { env = {}, opsServices, schedules, roles, testCommerceTransport, accountConnectorServices, pendingProviders } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-workspace-access-'));
  const store = await fileStore(join(directory, 'state.json'));
  const setupToken = 'workspace-access-setup';
  const config = configuration({ SETUP_TOKEN: setupToken, ...env });
  if (roles) config.roles = new Set(roles);
  const discovered = await discoverOperations();
  const operations = pendingProviders ? discovered.operations.map(op => op.name === 'workspace_get_today' ? {
    ...op, run: (ctx, input) => op.run(Object.assign(ctx, { workspacePendingProviders: pendingProviders }), input),
  } : op) : discovered.operations;
  const app = createServer({ config, store, ...discovered, operations, opsServices, testCommerceTransport, accountConnectorServices,
    schedules: schedules ? schedules(discovered.schedules) : discovered.schedules });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const password = 'acceptance-only-password';
  async function request(path, { method = 'GET', body, headers, status = 200 } = {}) {
    const res = await fetch(base + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { connection: 'close', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers } });
    const raw = await res.text();
    assert.equal(res.status, status, `${method} ${path}: ${raw}`);
    return { json: raw && JSON.parse(raw), headers: res.headers };
  }
  const setup = await request('/api/v1/setup', { method: 'POST', status: 201, headers: { 'x-setup-token': setupToken },
    body: { name: 'Owner', email: 'owner@example.invalid', password, workspaceName: 'Workspace Access' } });
  const { workspaces: [ws], user } = setup.json.data;
  const root = `/api/v1/workspaces/${ws.id}`;
  const session = result => ({ cookie: result.headers.get('set-cookie').split(';')[0], 'x-csrf-token': result.json.data.csrf_token });
  const owner = session(setup);
  const op = async (method, path, body, options = {}) => (await request(root + path, {
    ...options, method, body, headers: { ...owner, ...options.headers },
  })).json?.data;
  const inspect = run => store.transaction({ identityWrite: true }, async tx => {
    const tenantId = tx.identity.get(`workspace/${ws.id}`).tenantId;
    const scope = { actorId: user.id, workspaceId: ws.id, tenantId };
    const records = await tx.workspace(scope);
    return run(makeContext(records, scope, 'owner'), tx.identity, tenantId, scope, records);
  });
  async function member(email, role) {
    const id = randomUUID();
    await inspect((_ctx, identity) => {
      const original = identity.get(`user/${user.id}`);
      identity.put(`user/${id}`, { id, email, name: email, passwordHash: original.passwordHash });
      identity.put(`email/${email}`, id);
      if (role) identity.put(`member/${id}/${ws.id}`, { userId: id, workspaceId: ws.id, role });
    });
    return id;
  }
  async function login(email) {
    return session(await request('/api/v1/login', { method: 'POST', body: { email, password } }));
  }
  const rpc = async (token, method, params) => (await request('/mcp', { method: 'POST',
    headers: { accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: { jsonrpc: '2.0', id: 1, method, params },
  })).json;
  return { base, request, root, ws, user, owner, op, inspect, member, login, rpc,
    startWorker() { return createServer({ config: { ...config, roles: new Set(['worker']) },
      store: { ...store, close: async () => {} }, operations: [] }); },
  };
}

test('WS01 WS03 AI03 share the same live brand scope for REST search and MCP resources', async t => {
  const s = await fixture(t);
  const first = await s.op('POST', '/brands', { name: 'North', slug: 'north' });
  const second = await s.op('POST', '/brands', { name: 'South', slug: 'south' });
  const japan = await s.op('POST', `/brands/${first.id}/markets`, { name: 'Japan', country_code: 'JP', primary_language: 'ja-JP', currency: 'JPY', timezone: 'Asia/Tokyo' });
  const france = await s.op('POST', `/brands/${second.id}/markets`, { name: 'France', country_code: 'FR', primary_language: 'fr-FR', currency: 'EUR', timezone: 'Europe/Paris' });
  const { variants: [variant] } = await s.op('POST', '/content-items', { brand_id: first.id, title: 'Editorial', variants: [
    { platform: 'facebook', format: 'text', market_id: japan.id, locale: 'ja-JP', body_markdown: '春季新品' },
  ] });
  const before = await s.op('GET', `/content-variants/${variant.id}`);
  const settings = await s.op('GET', '/');
  await s.op('PATCH', '/', { default_ui_locale: 'en' }, { headers: { 'if-match': String(settings.version) } });
  const after = await s.op('GET', `/content-variants/${variant.id}`);
  assert.equal(before.variant.locale, 'ja-JP');
  assert.deepEqual(after.variant, before.variant);
  assert.deepEqual(after.current_revision, before.current_revision);
  const viewer = await s.member('viewer@example.invalid', 'viewer');
  const headers = await s.login('viewer@example.invalid');
  const tools = ['asset_get', 'knowledge_get_context', 'catalog_list_facts', 'search_query', 'agent_preview_context'];
  const { token } = await s.op('POST', '/tokens', { access: 'read', tools }, { headers, status: 201 });
  const seeded = await s.inspect(ctx => [first, second].map(brand => {
    const asset = ctx.create('asset', { brand_id: brand.id, title: `春季新品 ${brand.name}`, status: 'ready' });
    const version = ctx.create('asset_version', { asset_id: asset.id, version_no: 1 });
    const entry = ctx.create('knowledge_entry', { brand_id: brand.id, title: brand.name, kind: 'tone', status: 'active', locales: null, market_ids: null });
    const approved = ctx.create('knowledge_revision', { entry_id: entry.id, revision_no: 1, review_status: 'approved', body: brand.name });
    const proposed = ctx.create('knowledge_revision', { entry_id: entry.id, revision_no: 2, review_status: 'draft', body: `draft-${brand.name}` });
    ctx.update('knowledge_entry', entry.id, { active_revision_id: approved.id, current_revision_id: proposed.id });
    const product = ctx.create('product', { brand_id: brand.id, name: brand.name, status: 'active' });
    const fact = ctx.create('product_fact', { product_id: product.id, brand_id: brand.id, category: 'specification', status: 'active' });
    const revision = ctx.create('product_fact_revision', { fact_id: fact.id, review_status: 'approved', value: `fact-${brand.name}` });
    ctx.update('product_fact', fact.id, { approved_revision_id: revision.id });
    return { asset, version, product, approved, revision };
  }));
  const searchPath = `/search?${new URLSearchParams({ q: '新品', types: 'asset' })}`;
  const query = { q: '新品', types: 'asset' };
  const call = (name, input = {}) => s.rpc(token, 'tools/call', { name, arguments: { workspace_id: s.ws.id, ...input } });
  const ids = result => result.items.map(item => item.resource_id);
  const unscoped = await s.op('GET', searchPath, undefined, { headers });
  assert.equal(unscoped.total, 2);
  assert.deepEqual(new Set(ids(unscoped)), new Set(seeded.map(row => row.asset.id)));
  for (let index = 0; index < seeded.length; index++) {
    const brand = [first, second][index];
    const result = await s.op('GET', `${searchPath}&brand_id=${brand.id}`, undefined, { headers });
    assert.deepEqual(ids(result), [seeded[index].asset.id]);
  }
  await s.op('PATCH', `/members/${viewer}/roles`, { role: 'viewer', scopes: [`brand:${first.id}`] });
  const context = await s.op('GET', '/context', undefined, { headers });
  assert.deepEqual(context.brands.map(brand => brand.id), [first.id]);
  assert.equal(context.ui_locale, 'en');
  assert.deepEqual(context.markets.map(market => [market.id, market.primary_language]), [[japan.id, 'ja-JP']]);
  assert.equal((await s.op('GET', `/markets/${japan.id}`, undefined, { headers })).primary_language, 'ja-JP');
  await s.op('GET', `/markets/${france.id}`, undefined, { headers, status: 404 });
  assert.deepEqual((await s.op('GET', '/assets', undefined, { headers })).map(asset => asset.id), [seeded[0].asset.id]);
  const asset = await s.op('GET', `/assets/${seeded[0].asset.id}`, undefined, { headers });
  assert.deepEqual(asset.versions.map(version => version.id), [seeded[0].version.id]);
  assert.deepEqual((await s.op('GET', `/assets/${asset.id}/versions`, undefined, { headers })).map(version => version.id), [seeded[0].version.id]);
  await s.op('GET', `/assets/${seeded[1].asset.id}/versions`, undefined, { headers, status: 404 });
  await s.op('GET', `/assets?brand_id=${second.id}`, undefined, { headers, status: 404 });
  const results = await s.op('GET', searchPath, undefined, { headers });
  assert.equal(results.total, 1);
  assert.deepEqual(ids(results), [seeded[0].asset.id]);
  await s.op('GET', `${searchPath}&brand_id=${second.id}`, undefined, { headers, status: 404 });
  await s.op('GET', `/assets/${seeded[1].asset.id}`, undefined, { headers, status: 404 });
  assert.deepEqual((await s.rpc(token, 'tools/list')).result.tools.map(tool => tool.name).sort(), tools.toSorted());
  assert.deepEqual((await call('search_query', { query })).result.structuredContent.data, results);
  for (const [name, input] of [['search_query', { query: { ...query, brand_id: second.id } }], ['asset_get', { params: { id: seeded[1].asset.id } }]]) {
    const { result } = await call(name, input);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.data.code, 'NOT_FOUND');
  }
  assert.equal((await s.rpc(token, 'resources/templates/list')).result.resourceTemplates.length, 2);
  const read = suffix => s.rpc(token, 'resources/read', { uri: `smartsell://workspaces/${s.ws.id}/${suffix}` });
  const knowledge = await read(`brands/${first.id}/knowledge`);
  assert.deepEqual(JSON.parse(knowledge.result.contents[0].text).data.items.map(item => item.revision_id), [seeded[0].approved.id]);
  assert.equal((await read(`brands/${second.id}/knowledge`)).error.code, -32602);
  const previewPath = brand => `/brands/${brand.id}/agent-context`;
  const preview = (brand, q) => call('agent_preview_context', { params: { brandId: brand.id }, query: { q } });
  const visible = await s.op('GET', `${previewPath(first)}?q=North`, undefined, { headers });
  assert.deepEqual(visible.items.map(item => item.revision_id), [seeded[0].approved.id]);
  assert.deepEqual((await preview(first, 'North')).result.structuredContent.data, visible);
  assert.deepEqual((await preview(first, 'South')).result.structuredContent.data.items, []);
  assert.deepEqual((await preview(first, 'draft-North')).result.structuredContent.data.items, []);
  await s.op('GET', previewPath(second), undefined, { headers, status: 404 });
  const denied = (await preview(second, 'South')).result;
  assert.equal(denied.isError, true);
  assert.equal(denied.structuredContent.data.code, 'NOT_FOUND');
  const facts = await read(`products/${seeded[0].product.id}/facts`);
  assert.deepEqual(JSON.parse(facts.result.contents[0].text).data.map(item => item.approved_revision.id), [seeded[0].revision.id]);
  assert.equal((await read(`products/${seeded[1].product.id}/facts`)).error.code, -32602);
  await s.op('PATCH', `/members/${viewer}/roles`, { role: 'viewer', scopes: [`brand:${second.id}`] });
  assert.equal((await read(`brands/${first.id}/knowledge`)).error.code, -32602);
  assert.ok((await read(`brands/${second.id}/knowledge`)).result.contents.length);
  assert.equal((await preview(first, 'North')).result.structuredContent.data.code, 'NOT_FOUND');
  assert.deepEqual((await preview(second, 'South')).result.structuredContent.data.items.map(item => item.revision_id), [seeded[1].approved.id]);
  const switched = await s.op('GET', searchPath, undefined, { headers });
  assert.equal(switched.total, 1);
  assert.deepEqual(ids(switched), [seeded[1].asset.id]);
  assert.deepEqual((await call('search_query', { query })).result.structuredContent.data, switched);
  await s.op('GET', `/assets/${seeded[0].asset.id}`, undefined, { headers, status: 404 });
  assert.equal((await call('asset_get', { params: { id: seeded[1].asset.id } })).result.structuredContent.data.id, seeded[1].asset.id);
});

test('WS01 OP10 retains existing brands and frees capacity after archiving', async t => {
  const s = await fixture(t);
  await s.inspect((_ctx, identity, tenantId, scope) => {
    const key = `tenant-data/${tenantId}/`;
    makeContext({ get: name => identity.get(key + name), list: prefix => identity.list(key + prefix),
      put: (name, data) => identity.put(key + name, data), delete: name => identity.delete(key + name) }, scope, 'owner').create('license_entitlement', {
      module_key: 'core', status: 'active', valid_from: '2020-01-01T00:00:00Z', valid_until: null, limits: { brands: { limit: 1 }, seats: { limit: 2 } },
    });
  });
  const first = await s.op('POST', '/brands', { name: 'First', slug: 'first' });
  const second = { name: 'Second', slug: 'second' };
  const denied = await s.request(`${s.root}/brands`, { method: 'POST', body: second, headers: s.owner, status: 402 });
  assert.equal(denied.json.code, 'LICENSE_LIMIT');
  assert.equal((await s.op('GET', `/brands/${first.id}`)).status, 'active');
  await s.op('POST', `/brands/${first.id}/archive`, { dry_run: false }, { headers: { 'if-match': String(first.version) } });
  const replacement = await s.op('POST', '/brands', second);
  const archived = await s.op('GET', `/brands/${first.id}`);
  assert.equal(archived.status, 'archived');
  const version = row => ({ headers: { 'if-match': String(row.version) } });
  const restore = `/brands/${first.id}/restore`;
  const tooMany = await s.request(s.root + restore, { method: 'POST', body: {}, status: 402,
    headers: { ...s.owner, ...version(archived).headers } });
  assert.equal(tooMany.json.code, 'LICENSE_LIMIT');
  await s.op('POST', `/brands/${replacement.id}/archive`, { dry_run: false }, version(replacement));
  const restored = await s.op('POST', restore, {}, version(archived));
  assert.equal(restored.id, first.id);
  assert.equal(restored.status, 'active');
  assert.equal((await s.op('GET', '/admin/usage?meter_key=brands')).current, 1);
  const roundTrip = await s.op('POST', `/brands/${first.id}/archive`, { dry_run: false }, version(restored));
  assert.equal((await s.op('GET', '/admin/usage?meter_key=brands')).current, 0);
  assert.equal((await s.op('POST', restore, {}, version(roundTrip.brand))).status, 'active');
  assert.equal((await s.op('GET', '/admin/usage?meter_key=brands')).current, 1);

  const former = await s.member('former@example.invalid', 'editor');
  await s.member('invitee@example.invalid');
  const formerHeaders = await s.login('former@example.invalid');
  const { token } = await s.op('POST', '/tokens', { access: 'write', tools: ['search_query', 'agent_jobs_claim'] }, { headers: formerHeaders, status: 201 });
  const work = await s.op('POST', '/work-items', { title: 'Review the report' }, { headers: formerHeaders });
  const inProgress = await s.op('PATCH', `/work-items/${work.id}`, { status: 'in_progress' }, { headers: { ...formerHeaders, 'if-match': String(work.version) } });
  const job = await s.op('POST', '/agent-jobs', { title: 'Summarize report inputs' }, { status: 202 });
  await s.op('POST', `/agent-jobs/${job.id}/assign`, { assignee_id: s.user.id }, { headers: { 'if-match': String(job.version) } });
  const workload = await s.op('GET', `/workload?member_id=${s.user.id}&types=agent_task`);
  assert.deepEqual(workload, [{ assignee_id: s.user.id, kind: 'agent_task', total: 1, blocked: 0 }]);
  const inflight = await s.op('POST', '/agent-jobs', { title: 'In-flight member job' }, { headers: formerHeaders, status: 202 });
  const { result: lease } = await s.rpc(token, 'tools/call', { name: 'agent_jobs_claim', arguments: {
    workspace_id: s.ws.id, params: { id: inflight.id }, expected_version: inflight.version,
  } });
  assert.equal(lease.structuredContent.data.status, 'claimed');
  const invite = { email: 'invitee@example.invalid', role: 'editor' };
  const full = await s.request(`${s.root}/members/invite`, { method: 'POST', body: invite, headers: s.owner, status: 402 });
  assert.equal(full.json.code, 'LICENSE_LIMIT');
  const preview = await s.op('POST', `/members/${former}/remove`, {});
  assert.ok(preview.items.some(item => item.id === work.id));
  const removed = await s.op('POST', `/members/${former}/remove`, { preview_hash: preview.preview_hash, to_user_id: s.user.id });
  const handover = (await s.op('GET', '/handovers')).find(row => row.id === removed.handover_id);
  assert.equal((await s.op('POST', `/handovers/${handover.id}/accept`, {}, { headers: { 'if-match': String(handover.version) } })).status, 'completed');
  await s.request('/mcp', { method: 'POST', status: 403,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_query', arguments: { workspace_id: s.ws.id } } } });
  assert.equal((await s.op('GET', `/agent-jobs/${inflight.id}`)).status, 'lease_expired');
  const transferred = await s.op('GET', `/work-items/${work.id}`);
  assert.equal(transferred.created_by_id, former);
  assert.equal(transferred.assignee_id, s.user.id);
  assert.equal(transferred.status, inProgress.status);
  await s.inspect(ctx => {
    const events = ctx.list('work_item_event').filter(row => row.work_item_id === work.id);
    assert.ok(events.some(row => row.kind === 'handed_over' && row.from_value === former && row.to_value === s.user.id));
  });
  assert.ok((await s.op('POST', '/members/invite', invite)).invitation_id);
});

test('OP10 keeps export and original-attempt reconciliation available after the license grace period', async t => {
  const s = await fixture(t);
  const { task, attempt, evidence } = await s.inspect((ctx, identity, tenantId, scope) => {
    const key = `tenant-data/${tenantId}/`;
    makeContext({ get: name => identity.get(key + name), list: prefix => identity.list(key + prefix),
      put: (name, data) => identity.put(key + name, data), delete: name => identity.delete(key + name) }, scope, 'owner').create('license_entitlement', {
      module_key: 'core', status: 'active', valid_from: '2020-01-01T00:00:00Z', valid_until: '2020-02-01T00:00:00Z',
    });
    const target = ctx.create('publish_target', { plan_status: 'ready' });
    const task = ctx.create('execution_task', { status: 'outcome_unknown', publish_target_id: target.id, fencing_token: 1 });
    const attempt = ctx.create('execution_attempt', { task_id: task.id, status: 'unknown', attempt_no: 1, executor: 'official', side_effect_possible: true });
    ctx.create('execution_verification', { task_id: task.id, attempt_id: attempt.id, status: 'requested', available_at: ctx.now });
    const evidence = ctx.create('file_object', { purpose: 'evidence', scan_status: 'clean' });
    return { task, attempt, evidence };
  });
  assert.equal((await s.op('GET', '/admin/license')).status, 'read_only');
  const denied = await s.request(`${s.root}/brands`, { method: 'POST', body: { name: 'Blocked', slug: 'blocked' }, headers: s.owner, status: 402 });
  assert.equal(denied.json.code, 'LICENSE_READ_ONLY');
  const exported = await s.op('POST', '/admin/exports', { selection: 'audit_event' });
  assert.equal(exported.export.status, 'completed');
  assert.ok(Array.isArray(exported.data));
  const reconciled = await s.op('POST', `/execution-tasks/${task.id}/reconcile`, {
    outcome: 'verified_absent', confirmed_no_pending_submission: true, visibility_window_elapsed: true, evidence_file_ids: [evidence.id],
  });
  assert.equal(reconciled.task.status, 'retryable');
  const detail = await s.op('GET', `/execution-tasks/${task.id}`);
  assert.deepEqual(detail.attempts.map(row => [row.id, row.status]), [[attempt.id, 'verified_absent']]);
  assert.equal(detail.verifications[0].outcome, 'verified_absent');
  assert.deepEqual(detail.pending_side_effects, []);
});

test('WS04 creates an approval notification and closes its task only on a business decision', async t => {
  const s = await fixture(t);
  const brand = await s.op('POST', '/brands', { name: 'Approval', slug: 'approval' });
  const { account, variant } = await s.inspect(ctx => {
    const account = ctx.create('social_account', { provider: 'meta_facebook', status: 'active', brand_id: brand.id, default_timezone: 'UTC' });
    const item = ctx.create('content_item', { brand_id: brand.id, title: 'Review draft' });
    const variant = ctx.create('content_variant', { content_item_id: item.id, platform: 'facebook', format: 'text', locale: 'en', readiness: 'ready' });
    const revision = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'v1', rendered: { text: 'Review draft' }, media: [] });
    return { account, variant: ctx.update('content_variant', variant.id, { current_revision_id: revision.id }) };
  });
  const draft = await s.op('POST', '/publish-targets', { social_account_id: account.id, content_variant_id: variant.id,
    scheduled_at: new Date(Date.now() + 86_400_000).toISOString() });
  const version = row => ({ headers: { 'if-match': String(row.version) } });
  const submitted = await s.op('POST', `/publish-targets/${draft.id}/submit`, {}, version(draft));
  assert.equal(submitted.plan_status, 'awaiting_approval');
  async function eventually(read) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await read();
      if (result) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail('Business event did not reach the read model');
  }
  const notice = await eventually(async () => (await s.op('GET', '/notifications')).items.find(row => row.resource_id === submitted.approval_request_id));
  await s.op('POST', '/notifications/read', { ids: [notice.id] });
  assert.equal((await s.op('GET', `/work-items/${notice.work_item_id}`)).status, 'open');
  const approved = await s.op('POST', `/publish-targets/${draft.id}/approve`, {}, version(submitted));
  assert.equal(approved.plan_status, 'ready');
  await eventually(async () => (await s.op('GET', `/work-items/${notice.work_item_id}`)).status === 'done');
  assert.ok(!(await s.op('GET', '/me/inbox')).items.some(item => item.resource.id === notice.work_item_id));
});

test('AI02 keeps connector automatic-mode privileges out of full-access MCP discovery', async t => {
  const s = await fixture(t);
  const { token, id } = await s.op('POST', '/tokens', { access: 'write' }, { status: 201 });
  const { tools } = (await s.rpc(token, 'tools/list')).result;
  assert.ok(tools.some(tool => tool.name === 'jobs_cancel'));
  for (const name of ['account_enable_auto_mode', 'account_update_auto_mode', 'account_release_workspace_auto', 'account_set_execution_binding', 'account_enable_mobile_device']) {
    assert.ok(!tools.some(tool => tool.name === name));
    assert.equal((await s.rpc(token, 'tools/call', { name, arguments: { workspace_id: s.ws.id } })).error.code, -32602);
  }
  await s.request(`${s.root}/tokens/${id}`, { method: 'DELETE', headers: s.owner, status: 204 });
  await s.request('/mcp', { method: 'POST', status: 401,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
});

test('AI07 leaves model purposes disabled on a clean workspace while core work remains available', async t => {
  const s = await fixture(t);
  assert.deepEqual(await s.op('GET', '/ai/status'), { enabled: false, purposes: [] });
  assert.deepEqual((await s.op('GET', '/model-providers')), []);
  const item = await s.op('POST', '/work-items', { title: 'Review without a model' });
  assert.equal((await s.op('GET', `/work-items/${item.id}`)).title, item.title);
});

test('AI08 reviews selected changes and preserves an intervening human edit', async t => {
  const s = await fixture(t);
  const first = await s.op('POST', '/work-items', { title: 'First draft' });
  const second = await s.op('POST', '/work-items', { title: 'Second draft' });
  const third = await s.op('POST', '/work-items', { title: 'Third draft' });
  const { token } = await s.op('POST', '/tokens', { access: 'write', tools: ['change_sets_create', 'change_sets_apply'] }, { status: 201 });
  const args = { workspace_id: s.ws.id, body: { title: 'Suggested edits', rationale: 'Improve draft titles', items: [first, second, third].map(row => ({
    target_type: 'work_item', target_id: row.id, expected_version: row.version, patch: { title: `Suggested ${row.title}` },
  })) } };
  const created = await s.rpc(token, 'tools/call', { name: 'change_sets_create', arguments: args });
  assert.equal(created.result?.isError, undefined, JSON.stringify(created));
  const set = created.result.structuredContent.data;
  const preview = await s.op('GET', `/change-sets/${set.id}`);
  assert.deepEqual(preview.items[0].preview.title, { before: 'First draft', after: 'Suggested First draft' });
  assert.equal((await s.rpc(token, 'tools/call', { name: 'change_sets_apply', arguments: { workspace_id: s.ws.id, params: { id: set.id } } })).error.code, -32602);
  await s.op('PATCH', `/work-items/${second.id}`, { title: 'Human edit' }, { headers: { 'if-match': String(second.version) } });
  const reviewed = await s.op('POST', `/change-sets/${set.id}/apply`, { item_seqs: [1], skip_item_seqs: [3] }, { headers: { 'if-match': String(set.version) } });
  assert.deepEqual(reviewed.items.map(row => row.status), ['applied', 'pending', 'skipped']);
  const rest = await s.op('POST', `/change-sets/${set.id}/apply`, { item_seqs: [2] }, { headers: { 'if-match': String(reviewed.version) } });
  assert.deepEqual(rest.items.map(row => row.status), ['applied', 'conflict', 'skipped']);
  const closed = await s.op('POST', `/change-sets/${set.id}/reject`, { reason: 'Keep the newer draft' }, { headers: { 'if-match': String(rest.version) } });
  assert.deepEqual(closed.items.map(row => row.status), ['applied', 'rejected', 'skipped']);
  assert.equal((await s.op('GET', `/work-items/${second.id}`)).title, 'Human edit');
  assert.equal((await s.op('GET', `/work-items/${third.id}`)).title, third.title);
});


test('OP07 gates recurring publication through restore and expands the occurrence only once after resume', async t => {
  let scans = 0;
  const applied = [];
  let publishedId;
  const s = await fixture(t, {
    schedules: schedules => schedules.filter(row => row.id === 'planning.due').map(row => ({ ...row, intervalMs: 10,
      async run(ctx) { await row.run(ctx); scans++; } })),
    opsServices: {
      createBackup: () => ({ consistent_at: new Date(Date.now() - 3_600_000).toISOString(),
        db_snapshot_ref: 'fixture-db', storage_manifest_ref: 'fixture-media', config_ref: 'fixture-config' }),
      restoreBackup() {},
      restoreCandidates: () => [{ domain: 'publish', resource_type: 'publish_target', resource_id: publishedId, db_state: 'queued' }],
      reconcile: () => ({ state: 'present', evidence_id: 'fixture-receipt' }),
      applyReconciliation: (ctx, item, decision) => {
        applied.push(decision);
        ctx.update('publish_target', item.resource_id, { plan_status: 'closed' });
      },
    },
  });
  const external = () => ({ headers: { 'idempotency-key': randomUUID() } });
  const policy = await s.op('PUT', '/admin/backup-policies', { schedule: '0 3 * * *', retention_days: 7, target: { destination_id: 'fixture' } });
  const backup = await s.op('POST', '/admin/backup-runs', { policy_id: policy.id }, external());
  const run = await s.op('POST', '/admin/restore-runs', { backup_run_id: backup.id });
  const root = `/admin/restore-runs/${run.id}`;
  assert.equal(run.status, 'restoring');
  assert.equal((await s.op('POST', `${root}/execute`, {}, external())).status, 'safe_mode');
  await s.op('POST', `${root}/resume`, {}, { status: 409 });
  const operator = await s.member('workspace-admin@example.invalid', 'admin');
  const headers = await s.login('workspace-admin@example.invalid');
  assert.ok(operator);
  await s.op('GET', '/admin/restore-runs', undefined, { headers, status: 403 });
  await s.op('POST', `${root}/resume`, {}, { headers, status: 403 });
  const brand = await s.op('POST', '/brands', { name: 'Scheduled', slug: 'scheduled' });
  const { account, variant } = await s.inspect(ctx => {
    publishedId = ctx.create('publish_target', { plan_status: 'ready' }).id;
    const account = ctx.create('social_account', { provider: 'meta_facebook', status: 'active', brand_id: brand.id, default_timezone: 'UTC' });
    const item = ctx.create('content_item', { brand_id: brand.id, title: 'Schedule fixture' });
    const variant = ctx.create('content_variant', { content_item_id: item.id, platform: 'facebook', format: 'text', locale: 'en', readiness: 'ready' });
    const revision = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'v1', rendered: { text: 'Schedule fixture' }, media: [] });
    return { account, variant: ctx.update('content_variant', variant.id, { current_revision_id: revision.id }) };
  });
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const rule = await s.op('POST', '/schedule-rules', { rrule: { freq: 'daily', local_time: '12:00' }, tz: 'UTC',
    starts_on: day, ends_on: day, horizon_days: 3, content_source: { social_account_id: account.id, content_variant_id: variant.id } });
  const expand = `/schedule-rules/${rule.id}/expand`;
  assert.equal((await s.op('POST', expand, { dry_run: true })).length, 1);
  await s.op('POST', expand, {}, { status: 409 });
  const waitForScan = async () => {
    const before = scans;
    for (let i = 0; i < 60 && scans === before; i++) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(scans > before, 'Planning scheduler did not tick');
  };
  const occurrences = async () => (await s.op('GET', '/publish-targets')).filter(row => row.schedule_rule_id === rule.id);
  await waitForScan();
  assert.deepEqual(await occurrences(), []);
  assert.equal((await s.op('POST', `${root}/reconcile`, {}, external())).status, 'safe_mode');
  assert.deepEqual((await s.op('GET', `${root}/items`)).map(row => row.decision), ['adopt_external']);
  assert.deepEqual(applied, ['adopt_external']);
  await waitForScan();
  assert.deepEqual(await occurrences(), []);
  assert.equal((await s.op('POST', `${root}/resume`, {})).status, 'resumed');
  await waitForScan();
  let targets = await occurrences();
  if (!targets.length) { await waitForScan(); targets = await occurrences(); }
  assert.equal(targets.length, 1);
  assert.equal((await s.op('POST', expand, {}))[0].target_id, targets[0].id);
  await waitForScan();
  assert.deepEqual((await occurrences()).map(row => row.id), [targets[0].id]);
});

test('OP09 SaaS tenant owner and admin cannot publish component compatibility or auto terms', async t => {
  const s = await fixture(t, { env: { SMARTSELL_IDENTITY_DEPLOYMENT: 'saas', PUBLIC_ORIGIN: 'https://smartsell.example.invalid' } });
  const admin = await s.member('tenant-admin@example.invalid', 'admin');
  await s.inspect((_ctx, identity, tenantId) => identity.put(`tenant-member/${tenantId}/${admin}`, { role: 'admin' }));
  const adminHeaders = await s.login('tenant-admin@example.invalid');
  assert.equal((await s.op('GET', '/admin/health')).deployment_mode, 'saas');
  for (const headers of [s.owner, adminHeaders]) {
    assert.deepEqual(await s.op('GET', '/admin/component-compat', undefined, { headers }), []);
    await s.op('PUT', `/admin/component-compat/${randomUUID()}`, { status: 'blocked' }, { headers, status: 403 });
    await s.op('POST', '/admin/auto-terms', { version: 'fixture' }, { headers, status: 403 });
    assert.deepEqual(await s.op('GET', '/admin/auto-terms', undefined, { headers }), []);
  }
});


test('WS06 a second administrator resumes shared setup and the overview reports the skipped step', async t => {
  const s = await fixture(t);
  await s.member('setup-admin@example.invalid', 'admin');
  const headers = await s.login('setup-admin@example.invalid');
  const path = '/onboarding/initial_setup_v1';
  const skipped = await s.op('POST', `${path}/steps/history_sync/skip`, { reason: 'No historical data' });
  const resumed = await s.op('GET', path, undefined, { headers });
  assert.deepEqual(resumed.items.find(row => row.step_key === skipped.step_key), skipped);
  const overview = await s.op('GET', '/overview/today', undefined, { headers });
  assert.deepEqual(overview.skipped_steps, [{ step_key: skipped.step_key, skip_reason: skipped.skip_reason, check_result: skipped.check_result }]);
  await s.op('POST', '/brands', { name: 'Onboarded', slug: 'onboarded' }, { headers });
  assert.equal((await s.op('POST', `${path}/steps/brand/check`, {}, { headers })).status, 'done');
  assert.equal((await s.op('GET', path)).items.find(row => row.step_key === 'brand').status, 'done');
});

test('OP05 retention previews recalculate policy and protect a scheduled asset', async t => {
  const s = await fixture(t, { opsServices: { applyRetention: (ctx, kind, row) => ctx.remove(kind, row.id) } });
  const { free, retained } = await s.inspect(ctx => {
    const free = ctx.create('asset_file', {});
    const retained = ctx.create('asset_file', {});
    const target = ctx.create('publish_target', { plan_status: 'ready' });
    ctx.create('publish_target_ref', { publish_target_id: target.id, ref_id: retained.id });
    return { free, retained };
  });
  const data_class = 'asset_file';
  const policy = retain_days => s.op('PUT', '/admin/retention-policies', { data_class, retain_days });
  const preview = () => s.op('POST', '/admin/purge-runs', { data_class });
  await policy(30);
  assert.deepEqual((await preview()).preview.candidates, []);
  await policy(0);
  const eligible = await preview();
  assert.deepEqual(eligible.preview.candidates.map(row => row.resource_id), [free.id]);
  assert.deepEqual(eligible.preview.blocked_by, [{ resource_id: retained.id, reasons: ['scheduled_target'] }]);
  await policy(30);
  const approval = await s.op('POST', `/admin/purge-runs/${eligible.id}/approve`, {});
  assert.deepEqual(approval.purged, []);
  assert.deepEqual(approval.skipped, [free.id]);
  await policy(0);
  const fresh = await preview();
  const applied = await s.op('POST', `/admin/purge-runs/${fresh.id}/approve`, {});
  assert.deepEqual(applied.purged, [free.id]);
  assert.deepEqual(await s.inspect(ctx => ctx.list('asset_file').map(row => row.id)), [retained.id]);
});


test('AI02 an already-open workspace SSE connection closes after its PAT is revoked', async t => {
  const s = await fixture(t);
  const { token, id } = await s.op('POST', '/tokens', { access: 'read' }, { status: 201 });
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(10_000)]);
  t.after(() => abort.abort());
  const response = await fetch(`${s.base}${s.root}/stream`, { headers: { authorization: `Bearer ${token}` }, signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.match(Buffer.from((await reader.read()).value).toString(), /: connected/);
  await s.request(`${s.root}/tokens/${id}`, { method: 'DELETE', headers: s.owner, status: 204 });
  for (;;) {
    if ((await reader.read()).done) break;
  }
  assert.equal((await fetch(`${s.base}${s.root}/stream`, { headers: { authorization: `Bearer ${token}` }, signal })).status, 401);
});


test('OP01 OP08 deployment health distinguishes callback fallback from an IP-denied provider', async t => {
  const s = await fixture(t);
  const health = async () => (await s.op('GET', '/admin/health')).provider_checks;
  await s.inspect(ctx => {
    recordProviderObservation(ctx, { provider: 'shopify', connection_id: 'shop', callback: 'reachable' });
    recordProviderObservation(ctx, { provider: 'amazon_sp', connection_id: 'orders', callback: 'missing_prerequisite' });
  });
  assert.equal((await health()).find(row => row.provider === 'shopify').fallback, 'file_import');
  await s.op('PUT', '/admin/settings/egress_ips', { value: ['192.0.2.1'] });
  await s.inspect(ctx => {
    recordProviderObservation(ctx, { provider: 'shopify', connection_id: 'shop', ip_allowlist_denied: true, callback: 'unreachable' });
    recordProviderObservation(ctx, { provider: 'shopee', connection_id: 'callback', callback: 'unreachable' });
  });
  const providers = Object.fromEntries((await health()).map(row => [row.provider, [row.fallback, row.reason]]));
  assert.deepEqual(providers, { amazon_sp: ['fallback_polling', 'missing_prerequisite'],
    shopify: ['file_import', 'platform_ip_denied'], shopee: ['fallback_polling', 'unreachable'] });
  const alerts = await s.op('GET', '/admin/alert-incidents');
  assert.ok(alerts.some(row => row.signal === 'platform_ip_denied' && row.scope_key === 'shopify:shop'));
});


test('WS02 overview shows expired credentials and retains an unresolved account block', async t => {
  const s = await fixture(t);
  const { expired, neverExpires, block } = await s.inspect(ctx => ({
    expired: ctx.create('connection', { status: 'active', expires_at: new Date(Date.now() - 1000).toISOString() }),
    neverExpires: ctx.create('connection', { status: 'active', expires_at: null }),
    block: ctx.create('account_block', { kind: 'captcha', status: 'open' }),
  }));
  const overview = async () => (await s.op('GET', '/overview/today')).items;
  const get = (items, row) => items.find(item => item.resource.id === row.id);
  const before = await overview();
  assert.equal(get(before, expired).kind, 'expired');
  assert.equal(get(before, neverExpires), undefined);
  assert.equal(get(before, block).kind, 'captcha');
  await s.inspect(ctx => ctx.update('connection', expired.id, { expires_at: new Date(Date.now() + 60_000).toISOString() }));
  const renewed = await overview();
  assert.equal(get(renewed, expired), undefined);
  assert.equal(get(renewed, block).kind, 'captcha');
  await s.inspect(ctx => ctx.update('account_block', block.id, { status: 'resolved', resolved_at: ctx.now }));
  assert.equal(get(await overview(), block), undefined);
});


test('AC01 two independent verified OAuth grants share one account and rename preserves post history', async t => {
  const origin = 'https://smartsell.example.invalid';
  const scope = 'https://www.googleapis.com/auth/youtube.readonly';
  const externalAccountId = 'fixture-channel';
  const codes = ['owner-consent-one', 'owner-consent-two'];
  const challenges = new Map();
  const exchanges = [];
  const envKey = 'SMARTSELL_COMMERCE_PROVIDER_CREDENTIALS';
  const previous = process.env[envKey];
  process.env[envKey] = JSON.stringify({ youtube: { clientId: 'fixture-client', clientSecret: 'fixture-secret' } });
  t.after(() => {
    if (previous === undefined) delete process.env[envKey];
    else process.env[envKey] = previous;
  });
  const s = await fixture(t, { env: { PUBLIC_ORIGIN: origin }, roles: ['api'], testCommerceTransport: async request => {
    const url = new URL(request.url);
    if (url.href === 'https://oauth2.googleapis.com/token' && request.method === 'POST') {
      const body = new URLSearchParams(request.body);
      const code = body.get('code');
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('redirect_uri'), `${origin}/api/v1/oauth/callback/youtube`);
      assert.ok(challenges.has(code));
      assert.equal(createHash('sha256').update(body.get('code_verifier')).digest('base64url'), challenges.get(code));
      exchanges.push(code);
      return { status: 200, body: { access_token: `fixture-token-${code}`, scope, expires_in: 3600 } };
    }
    assert.equal(`${url.origin}${url.pathname}`, 'https://www.googleapis.com/youtube/v3/channels');
    assert.equal(url.searchParams.get('mine'), 'true');
    assert.equal(request.headers.authorization, `Bearer fixture-token-${exchanges.at(-1)}`);
    return { status: 200, body: { items: [{ id: externalAccountId, snippet: { title: 'Original channel' } }] } };
  } });
  const brand = await s.op('POST', '/brands', { name: 'Account fixture', slug: 'account-fixture' });
  const states = [];
  const connectionIds = [];
  async function authorize(code) {
    const { authorize_url } = await s.op('POST', '/connections/oauth/start', { provider: 'youtube', brand_id: brand.id, scopes: [scope] });
    const authorize = new URL(authorize_url);
    const state = authorize.searchParams.get('state');
    assert.ok(state && !states.includes(state));
    states.push(state);
    const challenge = authorize.searchParams.get('code_challenge');
    assert.match(challenge, /^[\w-]{43}$/);
    assert.ok(![...challenges.values()].includes(challenge));
    challenges.set(code, challenge);
    const callback = '/api/v1/oauth/callback/youtube?' + new URLSearchParams({ state, code });
    assert.deepEqual((await s.request(callback)).json.data, { status: 'authorized' });
    await s.request(callback, { status: 400 });
    const connections = await s.op('GET', '/connections');
    assert.equal(connections.length, connectionIds.length + 1);
    const connection = connections.find(row => !connectionIds.includes(row.id));
    assert.equal(connection.status, 'active');
    connectionIds.push(connection.id);
    const accounts = await s.op('GET', `/connections/${connection.id}/accounts`);
    assert.deepEqual(accounts.map(row => row.external_account_id), [externalAccountId]);
    const [account] = await s.op('POST', `/connections/${connection.id}/accounts/link`, { external_account_ids: [externalAccountId] });
    return account;
  }
  assert.deepEqual(await s.op('GET', '/social-accounts'), []);
  const original = await authorize(codes[0]);
  const history = await s.inspect(ctx => upsertObservedPost(ctx, original.id, { external_post_id: 'fixture-history' }));
  const second = await authorize(codes[1]);
  assert.equal(second.id, original.id);
  assert.deepEqual(exchanges, codes);
  assert.deepEqual((await s.op('GET', '/social-accounts')).map(row => row.id), [original.id]);
  const links = await s.inspect(ctx => ctx.list('social_account_connection'));
  assert.deepEqual(links.map(row => [row.connection_id, row.social_account_id, row.status]).sort(),
    connectionIds.map(id => [id, original.id, 'active']).sort());

  const renamed = await s.op('PATCH', `/social-accounts/${original.id}`, { display_name: 'Renamed channel' }, { headers: { 'if-match': String(second.version) } });
  assert.equal(renamed.display_name, 'Renamed channel');
  assert.equal(renamed.external_account_id, externalAccountId);
  const posts = await s.op('GET', `/platform-posts?social_account_id=${renamed.id}`);
  assert.deepEqual(posts.map(row => [row.id, row.external_post_id, row.social_account_id]), [[history.id, 'fixture-history', original.id]]);
});

async function waitFor(read, matches, message) {
  const deadline = performance.now() + 8_000;
  do {
    const value = await read();
    if (matches(value)) return value;
    await delay(100);
  } while (performance.now() < deadline);
  assert.fail(message);
}

test('WS02 account health expires an authorization on the next scheduled cycle', async t => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const s = await fixture(t, { roles: ['api', 'worker', 'scheduler'] });
  const scheduleKey = 'schedule/account.workspace-health';
  const checkpoint = () => s.inspect((_ctx, _identity, _tenant, _scope, records) => records.get(scheduleKey));
  await waitFor(checkpoint, value => value === start, 'Initial account health cycle did not complete');
  const expires = new Date(start + 1_000).toISOString();
  const { connection, capability } = await s.inspect(ctx => {
    const connection = ctx.create('connection', { provider: 'youtube', status: 'active', expires_at: expires });
    const capability = ctx.create('capability', { connection_id: connection.id, source: 'account_probe', status: 'available' });
    return { connection, capability };
  });
  const item = async () => (await s.op('GET', '/overview/today')).items.find(item => item.resource.id === connection.id);
  assert.equal(await item(), undefined);
  t.mock.timers.setTime(start + 60_000);
  await waitFor(checkpoint, value => value === start + 60_000, 'Next account health cycle did not complete');
  const [updated, changed, expired] = await s.inspect((ctx, _identity, _tenant, _scope, records) => [
    ctx.get('connection', connection.id), ctx.get('capability', capability.id),
    records.list('outbox/').filter(event => event.type === 'account.connection.expired' && event.payload.connection_id === connection.id),
  ]);
  assert.equal(updated.status, 'reauthorization_required');
  assert.equal(changed.status, 'needs_authorization');
  assert.equal(expired.length, 1);
  assert.equal((await item()).kind, 'expired');
});

test('WS02 overview degrades failed and timed-out providers while preserving healthy items', async t => {
  const s = await fixture(t, { pendingProviders: [
    { key: 'ingest.health', list() { throw new Error('Fixture provider failed'); } },
    { key: 'planning.approvals', list() { return new Promise(() => {}); } },
  ] });
  const block = await s.inspect(ctx => ctx.create('account_block', { kind: 'captcha', status: 'open' }));
  const overview = await s.op('GET', '/overview/today');
  for (const provider of ['ingest.health', 'planning.approvals']) {
    assert.deepEqual(overview.providers.find(row => row.provider === provider), { provider, availability: 'unavailable', total: null, as_of: null });
  }
  assert.equal(overview.providers.find(row => row.provider === 'account.health').availability, 'available');
  assert.ok(overview.items.some(item => item.resource.id === block.id));
});

const autoLimits = { max_per_hour: 1, min_interval_seconds: 120, daily_cap: 2, allowed_windows: [{ start: '09:00', end: '17:00' }] };

async function readyAutoBinding(s) {
  const brand = await s.op('POST', '/brands', { name: 'Auto fixture', slug: 'auto-fixture' });
  const account = await s.op('POST', '/social-accounts', { provider: 'douyin', brand_id: brand.id,
    external_account_id: 'fixture-only', display_name: 'Fixture', owned_account_confirmed: true });
  const device = await s.inspect(ctx => ctx.create('connector_device', { status: 'active', last_seen_at: ctx.now }));
  const path = `/social-accounts/${account.id}/execution-binding`;
  const { binding } = await s.op('PUT', path, { mode: 'connector', connector_channel: 'browser', device_id: device.id, owned_account_confirmed: true });
  await s.inspect(ctx => {
    const session = ctx.list('browser_session').find(row => row.binding_id === binding.id);
    ctx.update('browser_session', session.id, { status: 'verified', verified_at: ctx.now, external_account_id: account.external_account_id });
  });
  return { account, binding, path };
}

test('WS02 account and layered workspace emergency stops release independently and auto-stop persists until block resolution', async t => {
  const terms = { version: 'fixture-v1', text: 'Local synthetic terms' };
  const s = await fixture(t, { accountConnectorServices: { terms: () => terms, connectorConfigured: () => true } });
  const { account, binding, path } = await readyAutoBinding(s);
  await s.op('POST', `${path}/auto-mode`, { ...autoLimits, terms_version: terms.version, risk_acknowledged: true });
  const items = async kind => (await s.op('GET', '/overview/today')).items.filter(item => item.kind === kind);
  const sources = async kind => (await items(kind)).map(item => item.sources);
  await s.op('POST', `${path}/auto-halt`, {});
  assert.deepEqual(await sources('account_emergency_stop'), [['account']]);
  await s.op('POST', '/connector-auto-policy/halt', {});
  for (const scope of [s.ws.id, 'all']) {
    await s.op('POST', '/admin/connector-auto/emergency-stop', { scope, confirmed: true, reason: 'Local fixture' });
    assert.deepEqual(await sources('connector_auto_halted'), [['ops', 'workspace']]);
    await s.op('POST', '/admin/connector-auto/resume', { scope, reason: 'Local fixture cleared' });
    assert.deepEqual(await sources('connector_auto_halted'), [['workspace']]);
  }
  await s.op('POST', '/connector-auto-policy/release', {});
  assert.deepEqual(await sources('connector_auto_halted'), []);
  assert.deepEqual(await sources('account_emergency_stop'), [['account']]);
  await s.op('POST', `${path}/auto-halt/release`, {});
  assert.deepEqual(await sources('account_emergency_stop'), []);
  assert.equal(await s.inspect(ctx => ctx.get('account_execution_binding', binding.id).connector_mode), 'auto');

  for (const reason of ['auto_failure_streak', 'captcha', 'platform_restriction', 'identity_mismatch']) {
    const block = await s.inspect(ctx => {
      const session = ctx.list('browser_session').find(row => row.binding_id === binding.id);
      ctx.update('browser_session', session.id, { verified_at: ctx.now });
      return openBlock(ctx, account.id, reason, ctx.get('account_execution_binding', binding.id));
    });
    assert.equal(await s.inspect(ctx => ctx.get('account_execution_binding', binding.id).connector_mode), 'assist');
    assert.deepEqual((await items(reason)).map(item => item.resource.id), [block.id]);
    await s.op('POST', `/account-blocks/${block.id}/resolve`, {}, { status: 409 });
    assert.deepEqual((await items(reason)).map(item => item.resource.id), [block.id]);
    await s.inspect(ctx => {
      const session = ctx.list('browser_session').find(row => row.binding_id === binding.id);
      ctx.update('browser_session', session.id, { verified_at: new Date(Date.parse(block.opened_at) + 1).toISOString() });
    });
    await s.op('POST', `/account-blocks/${block.id}/resolve`, {});
    assert.deepEqual(await items(reason), []);
    await s.op('POST', `${path}/auto-mode`, { ...autoLimits, terms_version: terms.version, risk_acknowledged: true });
  }
});

test('WS02 administrator receives one nonblocking terms task and notification and re-enabling closes the task', async t => {
  const start = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: start });
  let terms = { version: 'fixture-v1', text: 'Initial local synthetic terms' };
  const s = await fixture(t, { roles: ['api', 'worker', 'scheduler'], accountConnectorServices: { terms: () => terms, connectorConfigured: () => true } });
  const scheduleKey = 'schedule/account.workspace-health';
  const checkpoint = () => s.inspect((_ctx, _identity, _tenant, _scope, records) => records.get(scheduleKey));
  await waitFor(checkpoint, value => value === start, 'Initial account health cycle did not complete');
  const adminId = await s.member('terms-admin@example.invalid', 'admin');
  const admin = await s.login('terms-admin@example.invalid');
  const { account, binding, path } = await readyAutoBinding(s);
  const asAdmin = { headers: admin };
  const enable = () => s.op('POST', `${path}/auto-mode`, { ...autoLimits, terms_version: terms.version, risk_acknowledged: true }, asAdmin);
  await enable();
  const renewal = async () => (await s.op('GET', '/overview/today', undefined, asAdmin)).items.filter(item => item.kind === 'terms_outdated');
  assert.deepEqual(await renewal(), []);
  terms = { version: 'fixture-v2', text: 'Updated local synthetic terms' };
  t.mock.timers.setTime(start + 60_000);
  await waitFor(checkpoint, value => value === start + 60_000, 'Updated terms were not evaluated by the next cycle');
  const [item] = await renewal();
  assert.equal(item.severity, 'high');
  assert.equal(item.terms_renewal.social_account_id, account.id);
  assert.deepEqual(item.terms_renewal.limits, autoLimits);
  assert.deepEqual(await s.op('GET', '/account-blocks', undefined, asAdmin), []);

  const tasks = () => s.inspect(ctx => ctx.list('work_item').filter(row => row.resource_id === binding.id && row.assignee_id === adminId));
  const [task] = await waitFor(tasks, rows => rows.length === 1, 'Administrator did not receive a terms task');
  assert.equal(task.status, 'open');
  assert.match(task.title, /Review the updated automatic mode terms/);
  const duplicate = await s.inspect((ctx, _identity, _tenant, _scope, records) => {
    const type = 'account.binding.auto_stopped';
    const original = records.list('outbox/').find(event => event.type === type && event.payload.binding_id === binding.id);
    ctx.emit(type, original.payload);
    return records.list('outbox/').find(event => event.type === type && event.id !== original.id).id;
  });
  await waitFor(() => s.inspect((_ctx, _identity, _tenant, _scope, records) => records.get(`consumed/workspace/${duplicate}`)),
    Boolean, 'Repeated auto_stopped event did not reach the worker');
  assert.deepEqual((await tasks()).map(row => row.id), [task.id]);
  const { items: notifications } = await s.op('GET', '/notifications', undefined, asAdmin);
  const notices = notifications.filter(row => row.resource_id === binding.id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].work_item_id, task.id);
  assert.match(notices[0].title, /Review the updated automatic mode terms/);
  assert.doesNotMatch(`${task.title} ${notices[0].title}`, /處理阻塞|resolve.*block/i);

  assert.equal((await s.op('GET', '/connector-auto-policy', undefined, asAdmin)).terms.version, terms.version);
  const reenabled = await enable();
  assert.equal(reenabled.auto_ack_by, adminId);
  assert.equal(reenabled.connector_mode, 'auto');
  assert.deepEqual(await renewal(), []);
  const [closed] = await waitFor(tasks, rows => rows.length === 1 && rows[0].status === 'done', 'Terms task was not automatically closed');
  assert.equal(closed.id, task.id);
  assert.equal(closed.completed_by_type, 'system');
});

test('OP01 a running worker reports its role and ages offline when heartbeats stop', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const s = await fixture(t, { roles: ['api'] });
  const worker = s.startWorker();
  let stopped = false;
  t.after(async () => { if (!stopped) await worker.close(); });
  await worker.ready();
  const health = async () => (await s.op('GET', '/admin/health')).roles;
  assert.equal((await health()).worker, 'online');
  t.mock.timers.tick(15_000);
  assert.equal((await health()).worker, 'online');
  await worker.close();
  stopped = true;
  t.mock.timers.tick(29_999);
  assert.equal((await health()).worker, 'online');
  t.mock.timers.tick(1);
  assert.equal((await health()).worker, 'offline');
  assert.equal((await health()).api, 'online');
});
