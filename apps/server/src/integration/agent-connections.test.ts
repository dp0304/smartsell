import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Records } from '@smartsell/db';
import { buildApp } from '../app.js';
import { developmentSecret } from '../bootstrap.js';
import { configuration } from '../config.js';
import { makeContext } from '../context.js';
import { MemoryStore } from '../memory.js';
import { PostgresStore } from '../postgres.js';
import type { Store } from '../store.js';
import { registerOperationRoutes } from '../operation-server.js';
import { discoverOperations, runScopedOperation } from '../operations.js';
import { discover } from '../registry.js';
import { operationRecords } from './operation-records.js';

type Json = Record<string, any>;
const accept = 'application/json, text/event-stream';

async function fixture(t: TestContext, store: Store = new MemoryStore()) {
  const config = configuration({ SETUP_TOKEN: 'agent-connection-setup-token' });
  const [{ operations }, discovered] = await Promise.all([discoverOperations(), discover()]);
  const { app } = buildApp({ ...config, ...discovered, store, operationApi: { config, operations, register: registerOperationRoutes } });
  t.after(() => app.close());
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  async function request(path: string, { method = 'GET', body, headers = {}, status = 200 }: { method?: string; body?: unknown; headers?: Json; status?: number } = {}) {
    const response = await fetch(base + path, { method, headers: { ...headers, ...body !== undefined && { 'content-type': 'application/json' } },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path}`);
    return raw ? JSON.parse(raw) : undefined;
  }
  const setup = await fetch(`${base}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-token': config.setupToken! },
    body: JSON.stringify({ email: 'agent-owner@example.test', name: 'Owner', workspaceName: 'Agents', password: 'acceptance-only-1234' }) });
  assert.equal(setup.status, 201);
  const { data: { workspaces: [{ id: wid }] } } = await setup.json();
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  const session = createHash('sha256').update(decodeURIComponent(cookie.split('=')[1]!)).digest('hex');
  const { csrf_token } = await request('/api/v1/session/csrf', { headers: { cookie } });
  const owner = { cookie, 'x-csrf-token': csrf_token };
  const root = `/api/v1/workspaces/${wid}`;
  const rpc = async (token: string, method: string, params: Json = {}, status = 200) => {
    const id = randomUUID();
    const value = await request('/mcp', { method: 'POST', status, body: { jsonrpc: '2.0', id, method, params },
      headers: { authorization: `Bearer ${token}`, accept } });
    if (status === 200) assert.ok(value.result, JSON.stringify(value));
    return value?.result;
  };
  const call = (token: string, name: string, args: Json = {}) => rpc(token, 'tools/call', { name, arguments: args });
  const connect = async (body: Json = { label: 'MacBook Claude', client: 'claude_code' }) =>
    (await request(`${root}/agent-connections`, { method: 'POST', status: 201, body, headers: owner })).data;
  const records = () => store.workspace(session, wid, async ({ context }) => {
    const { records } = await operationRecords(context, true);
    return makeContext(records, context, context.role);
  });
  const requestEnrollment = (path: string, code: string) => fetch(base + path, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
  return { config, store, request, requestEnrollment, rpc, call, connect, records, owner, cookie, root, wid, session };
}

const ok = (result: Json) => {
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
};
const failure = (result: Json) => {
  assert.equal(result.isError, true, JSON.stringify(result));
  return result.structuredContent.error;
};

test('memory sessions accept a bounded TTL and expire independently of the default lifetime', async t => {
  const store = new MemoryStore();
  await store.setup({ email: 'ttl@example.test', name: 'TTL', passwordHash: 'x', workspaceName: 'TTL' }, 'browser');
  const { user } = (await store.session('browser'))!;
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  await store.issueSession(user.id, 'agent', undefined, 30 * 86_400);
  await assert.rejects(store.issueSession(user.id, 'short', undefined, 10), /Invalid session lifetime/);
  t.mock.timers.tick(13 * 3_600_000);
  assert.equal(await store.session('browser'), undefined);
  assert.equal((await store.session('agent'))?.user.id, user.id);
  t.mock.timers.tick(30 * 86_400_000);
  assert.equal(await store.session('agent'), undefined);
});

test('development secrets persist under the owner-only preview key', t => {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-secret-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const secret = developmentSecret(join(dir, 'state.sqlite'));
  assert.match(secret, /^[0-9a-f]{64}$/);
  assert.equal(developmentSecret(join(dir, 'state.sqlite')), secret);
  assert.notEqual(developmentSecret(join(dir, 'other.sqlite')), secret);
  assert.equal(statSync(join(dir, 'state.sqlite.identity-key')).mode & 0o777, 0o600);
});

test('legacy tokens keep their Commands job tools and gain the generic Operation tools', async t => {
  const { request, rpc, owner, root } = await fixture(t);
  const { token } = (await request(`${root}/tokens`, { method: 'POST', status: 201, body: { access: 'write' }, headers: owner })).data;
  const tools = (await rpc(token, 'tools/list')).tools as Json[];
  const claim = tools.find(tool => tool.name === 'agent_jobs_claim')!;
  assert.ok(claim.inputSchema.properties.agent_job_id);
  assert.ok(tools.some(tool => tool.name === 'smartsell_operation_call'));
  const { token: reader } = (await request(`${root}/tokens`, { method: 'POST', status: 201, body: { access: 'read' }, headers: owner })).data;
  const read = (await rpc(reader, 'tools/list')).tools.map((tool: Json) => tool.name);
  assert.ok(read.includes('smartsell_operations_describe') && read.includes('catalog_search'));
  assert.ok(!read.includes('smartsell_operation_call') && !read.includes('workspace_brand_create'));
});

test('Codex can find both Worker social status tools and gets a specific pairing error', async t => {
  const { rpc, call, connect } = await fixture(t);
  const { token } = await connect({ label: 'Codex', client: 'codex' });
  const init = await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'Codex fixture', version: '1' } });
  assert.match(init.instructions, /worker_social_status_request.*recent_posts.*worker_social_status_get/);
  const tools = (await rpc(token, 'tools/list')).tools as Json[];
  for (const name of ['worker_social_status_request', 'worker_social_status_get']) {
    const tool = tools.find(item => item.name === name);
    assert.match(tool?.description, /paired SmartSell Worker.*recent_posts.*local Chrome/);
  }
  const requestTool = tools.find(tool => tool.name === 'worker_social_status_request')!;
  const genericTool = tools.find(tool => tool.name === 'smartsell_operation_call')!;
  const described = ok(await call(token, 'smartsell_operations_describe', { operation: requestTool.name }));
  assert.match(init.instructions, /UUID v4.*network retry.*historical receipts/);
  for (const schema of [requestTool.inputSchema, genericTool.inputSchema, described.data[0].input_schema]) {
    assert.match(schema.properties.idempotency_key.description, /UUID v4.*Never derive.*network retry/);
  }
  const result = await call(token, 'worker_social_status_request', { idempotency_key: 'social-status-fixture' });
  assert.equal(failure(result).code, 'SOCIAL_STATUS_WORKER_UNPAIRED');
});

test('agent connections issue, list, survive logout, touch last use and revoke', async t => {
  const { request, rpc, connect, owner, cookie, root, records } = await fixture(t);
  await request(`${root}/agent-connections`, { method: 'POST', status: 403, body: { label: 'No CSRF' }, headers: { cookie } });
  await request(`${root}/agent-connections`, { method: 'POST', status: 422, body: { label: 'Bad', expires_days: 400 }, headers: owner });
  await request(`${root}/agent-connections`, { method: 'POST', status: 422, body: { label: 'Bad', client: 'cursor' }, headers: owner });
  const created = await connect({ label: 'MacBook Claude', client: 'claude_code', expires_days: 30 });
  assert.match(created.token, /^ss_command_/);
  assert.equal(created.mcp_url, 'http://127.0.0.1:3401/mcp');
  assert.ok(Math.abs(Date.parse(created.expires_at) - Date.now() - 30 * 86_400_000) < 60_000);
  assert.deepEqual(Object.keys(created.setup), ['agents_md']);
  assert.ok(!JSON.stringify(created.setup).includes(created.token));
  assert.match(created.setup.agents_md, /smartsell_operations_describe/);

  const [listed] = (await request(`${root}/agent-connections`, { headers: { cookie } })).data;
  assert.deepEqual(listed, { id: created.id, label: 'MacBook Claude', client: 'claude_code', created_at: listed.created_at,
    expires_at: created.expires_at, last_used_at: null, revoked: false });
  assert.ok(!JSON.stringify(listed).includes(created.token));

  const initialized = await rpc(created.token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.match(initialized.instructions, /HUMAN_REQUIRED/);
  const names = (await rpc(created.token, 'tools/list')).tools.map((tool: Json) => tool.name);
  for (const name of ['smartsell_operations_describe', 'smartsell_operation_call', 'workspace_brand_create', 'content_commit_revision',
    'publishing_request_approval', 'agent_jobs_claim', 'search_query']) assert.ok(names.includes(name), name);
  assert.ok(!names.includes('publishing_approve'));
  const [touched] = (await request(`${root}/agent-connections`, { headers: { cookie } })).data;
  assert.ok(Date.parse(touched.last_used_at) > Date.now() - 60_000);
  const [mirror] = (await records()).list('agent_connection');
  assert.equal(mirror!.label, 'MacBook Claude');
  assert.equal(mirror!.last_used_at, touched.last_used_at);

  await request('/api/v1/session', { method: 'DELETE', status: 204, headers: { cookie } });
  assert.ok((await rpc(created.token, 'tools/list')).tools.length > 10);
});

async function testEnrollment(t: TestContext, backingStore?: Store) {
  const { request, requestEnrollment, rpc, call, connect, owner, cookie, root, store, session, wid } = await fixture(t, backingStore);
  const old = await connect();
  const path = `${root}/agent-connections`;
  const issue = async () => (await request(`${path}/enroll`, {
    method: 'POST', status: 201, headers: owner, body: { client: 'codex' },
  })).data;
  const redeem = (code: string, status: number, url = `${path}/redeem`) => request(url, { method: 'POST', status, body: { code } });
  const list = async () => (await request(path, { headers: { cookie } })).data as Json[];
  await request(`${path}/enroll`, { method: 'POST', status: 403, headers: { cookie }, body: { client: 'codex' } });
  const first = await issue();
  const next = await issue();
  assert.ok(!('token' in next) && !('setup' in next));
  assert.ok(!(await list()).some(row => row.id === next.id));
  const stored = await store.workspace(session, wid, async ({ context }) => context.get('mcp_runtime', 'codex_enrollment', context.actorId));
  assert.ok(stored?.data.code_hash === createHash('sha256').update(next.code).digest('hex'));
  assert.ok(!JSON.stringify(stored).includes(next.code));
  await redeem(first.code, 401);
  await redeem(next.code, 401, `/api/v1/workspaces/${randomUUID()}/agent-connections/redeem`);
  await redeem(next.code.slice(0, -3), 401);

  const rolledBackHash = createHash('sha256').update(randomUUID()).digest('hex');
  await store.workspace(session, wid, async unit => {
    await assert.rejects(unit.command({ module: 'agent', action: 'rollback_fixture', key: randomUUID(), fingerprint: '' }, async () => {
      await unit.issueAgentSession!(rolledBackHash, 86_400);
      throw new Error('abort enrollment transaction');
    }), /abort enrollment transaction/);
  });
  assert.equal(await store.session(rolledBackHash), undefined);

  const redemption = new URL(next.redeem_url).pathname;
  assert.equal(redemption, `${path}/redeem`);
  const raced = await Promise.all(Array.from({ length: 5 }, () => requestEnrollment(redemption, next.code)));
  assert.deepEqual(raced.map(response => response.status).sort(), [201, 401, 401, 401, 401]);
  const { data: { token } } = await raced.find(response => response.status === 201)!.json();
  assert.ok(/^ss_command_/.test(token));
  const fresh = async () => (await list()).find(row => row.id === next.id)!;
  assert.equal((await fresh()).label, 'Codex');
  assert.equal((await fresh()).last_used_at, null);
  assert.equal((await fresh()).mcp_verified_at, undefined);
  await request('/healthz', { headers: { authorization: `Bearer ${token}` } });
  await rpc(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal((await fresh()).mcp_verified_at, undefined);
  const rejected = await request('/mcp', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: { cursor: 'invalid' } },
    headers: { authorization: `Bearer ${token}`, accept } });
  assert.equal(rejected.error.code, -32602);
  assert.equal((await fresh()).mcp_verified_at, undefined);
  assert.ok((await rpc(token, 'tools/list')).tools.length > 0);
  assert.equal((await fresh()).mcp_client_verified_at, undefined);
  await store.workspace(session, wid, unit => unit.command({ module: 'agent', action: 'verify_agent_connection',
    key: `agent-connection-verify/${next.id}`, fingerprint: '' }, async () => {
    const row = await unit.context.get('mcp_runtime', 'credential', next.id);
    await unit.context.update('mcp_runtime', 'credential', next.id, { mcp_verified_at: unit.context.now }, row!.version);
  }));
  assert.equal((await fresh()).mcp_client_verified_at, undefined);
  assert.equal((await fresh()).mcp_verified_at, undefined);
  assert.ok((await call(token, 'publishing_approve')).isError);
  assert.equal((await fresh()).mcp_client_verified_at, undefined);
  ok(await call(token, 'smartsell_operations_describe'));
  assert.ok((await fresh()).mcp_client_verified_at);
  assert.ok((await list()).some(row => row.id === old.id && !row.revoked && !row.last_used_at));
  assert.ok((await rpc(old.token, 'tools/list')).tools.length > 0);

  const expiring = await issue();
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(expiring.expires_at) + 1 });
  await redeem(expiring.code, 401);
  assert.ok(!(await list()).some(row => row.id === expiring.id));
}

test('guided enrollment is workspace-bound, expiring, single-use and verified by an authorized tool call, not preflight or old stamps', t => testEnrollment(t));

// Point this at a freshly migrated disposable database using the request role.
const enrollmentPostgres = process.env.SMARTSELL_TEST_AGENT_PG_URL;
test('guided enrollment handles concurrent redemption with the PostgreSQL request role', { skip: !enrollmentPostgres },
  t => testEnrollment(t, new PostgresStore(enrollmentPostgres!)));

test('revoking a connection stops the Agent and returns its Operation job lease', async t => {
  const { request, rpc, call, connect, owner, root, records } = await fixture(t);
  const created = await connect();
  const job = (await request(`${root}/agent-jobs`, { method: 'POST', status: 202, body: { title: 'Write launch captions' },
    headers: { ...owner, 'idempotency-key': randomUUID() } })).data;
  const read = ok(await call(created.token, 'agent_jobs_get', { params: { id: job.id } })).data;
  assert.equal(read.title, 'Write launch captions');
  const claimed = ok(await call(created.token, 'agent_jobs_claim', { params: { id: job.id }, expected_version: job.version,
    idempotency_key: 'claim-1' })).data;
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.assignee_type, 'agent_client');

  await request(`${root}/agent-connections/${created.id}`, { method: 'DELETE', status: 403, headers: { cookie: owner.cookie } });
  await request(`${root}/agent-connections/${created.id}`, { method: 'DELETE', status: 204, headers: owner });
  await request(`${root}/agent-connections/${created.id}`, { method: 'DELETE', status: 204, headers: owner });
  await rpc(created.token, 'tools/list', {}, 401);
  const ctx = await records();
  assert.equal(ctx.get('agent_job', job.id).status, 'lease_expired');
  assert.equal(ctx.list('agent_connection')[0]!.revoked, true);
  assert.deepEqual(ctx.list('activity_event').filter(row => String(row.action).startsWith('agent_connection_')).map(row => row.action).sort(),
    ['agent_connection_create', 'agent_connection_revoke']);
  const [listed] = (await request(`${root}/agent-connections`, { headers: owner })).data;
  assert.equal(listed.revoked, true);
});

test('operation tools write through Operations with attribution, activity and detailed errors', async t => {
  const { request, call, connect, owner, root, records } = await fixture(t);
  const { token, id: credentialId } = await connect();
  const brand = ok(await call(token, 'smartsell_operation_call', { operation: 'workspace_brand_create',
    body: { name: 'Agent Brand', slug: 'agent-brand' }, idempotency_key: 'brand-1' })).data;
  assert.equal(brand.created_via, 'agent');
  assert.deepEqual(ok(await call(token, 'smartsell_operation_call', { operation: 'workspace_brand_create',
    body: { name: 'Agent Brand', slug: 'agent-brand' }, idempotency_key: 'brand-1' })).data, brand);
  const listed = (await request(`${root}/brands`, { headers: owner })).data;
  assert.deepEqual(listed.map((row: Json) => [row.id, row.created_via]), [[brand.id, 'agent']]);
  const human = (await request(`${root}/brands`, { method: 'POST', body: { name: 'Human Brand', slug: 'human-brand' }, headers: owner })).data;
  assert.equal(human.created_via, 'human');

  const curated = ok(await call(token, 'workspace_market_create', { params: { id: brand.id }, idempotency_key: 'market-1',
    body: { name: 'Taiwan', country_code: 'tw', primary_language: 'zh-tw', currency: 'twd', timezone: 'Asia/Taipei' } }));
  assert.equal(curated.data.brand_id, brand.id);
  const page = ok(await call(token, 'workspace_brands_list', { query: { limit: 1 } }));
  assert.equal(page.data.length, 1);
  assert.equal(typeof page.next_cursor, 'string');
  const updated = ok(await call(token, 'workspace_brand_update', { params: { id: brand.id }, expected_version: brand.version,
    body: { name: 'Agent Brand TW' }, idempotency_key: 'brand-rename' }));
  assert.equal(updated.etag, `"${brand.version + 1}"`);

  const invalid = failure(await call(token, 'workspace_brand_create', { body: { name: 'No slug' }, idempotency_key: 'brand-2' }));
  assert.equal(invalid.code, 'INVALID_INPUT');
  assert.match(invalid.message, /slug/);
  assert.equal(failure(await call(token, 'workspace_brand_update', { params: { id: brand.id }, expected_version: 1,
    body: { name: 'Stale' } })).code, 'VERSION_CONFLICT');
  assert.match(failure(await call(token, 'workspace_market_create', { body: {} })).message, /missing params\.id/);
  assert.equal(failure(await call(token, 'smartsell_operation_call', { operation: 'no_such_operation' })).code, 'UNKNOWN_OPERATION');

  const activity = (await records()).list('activity_event');
  const agentBrand = activity.find(row => row.action === 'workspace_brand_create' && row.resource_id === brand.id)!;
  assert.deepEqual({ ...agentBrand, id: undefined, created_at: undefined, updated_at: undefined, occurred_at: undefined, request_id: undefined }, {
    id: undefined, version: 1, created_at: undefined, updated_at: undefined, occurred_at: undefined, action: 'workspace_brand_create',
    actor_id: agentBrand.actor_id, actor_type: 'agent', credential_id: credentialId, credential_label: 'MacBook Claude', source: 'mcp',
    request_id: undefined, resource_id: brand.id, resource_type: 'brand', resource_title: 'Agent Brand', brand_id: brand.id,
  });
  assert.equal(activity.filter(row => row.action === 'workspace_brand_create' && row.actor_type === 'agent').length, 1);
  const humanRow = activity.find(row => row.resource_id === human.id)!;
  assert.deepEqual([humanRow.actor_type, humanRow.source, humanRow.credential_id], ['human', 'rest', null]);
  const market = activity.find(row => row.action === 'workspace_market_create')!;
  assert.deepEqual([market.resource_type, market.brand_id], ['market', brand.id]);
});

test('human-only decisions are refused for Agent credentials on MCP and in the shared runner', async t => {
  const { request, call, connect, owner, root, config } = await fixture(t);
  const { token } = await connect();
  const approve = failure(await call(token, 'smartsell_operation_call', { operation: 'publishing_approve',
    params: { id: randomUUID() }, expected_version: 1, body: {} }));
  assert.equal(approve.code, 'HUMAN_REQUIRED');
  assert.equal(failure(await call(token, 'smartsell_operation_call', { operation: 'agent_jobs_accept', params: { id: randomUUID() } })).code, 'HUMAN_REQUIRED');
  const described = ok(await call(token, 'smartsell_operations_describe', { q: 'publish-targets' })).data;
  assert.ok(described.some((op: Json) => op.name === 'publishing_create_target'));
  assert.ok(!described.some((op: Json) => op.name === 'publishing_approve'));
  const one = ok(await call(token, 'smartsell_operations_describe', { operation: 'publishing_create_target' })).data;
  assert.equal(one.length, 1);
  assert.ok(one[0].input_schema.properties.body);
  assert.ok(!one[0].input_schema.required.includes('workspace_id'));

  const workload = 'content_production_workload';
  assert.deepEqual(ok(await call(token, 'smartsell_operations_describe', { operation: workload })).data, []);
  assert.equal(failure(await call(token, 'smartsell_operation_call', { operation: workload })).code, 'HUMAN_REQUIRED');
  assert.deepEqual((await request(`${root}/content-items/workload`, { headers: owner })).data, []);

  const catalog = (await request(`${root}/catalog`, { headers: owner })).data;
  const entry = (name: string) => catalog.find((op: Json) => op.name === name);
  assert.deepEqual([entry('publishing_approve').human_only, entry('publishing_approve').mcp], [true, false]);
  assert.deepEqual([entry('publishing_create_target').human_only, entry('publishing_create_target').mcp], [false, true]);

  const { operations } = await discoverOperations();
  const op = operations.find(item => item.name === 'publishing_approve')!;
  const scope = { tenantId: randomUUID(), workspaceId: randomUUID(), actorId: randomUUID() };
  const run = (grantId?: string) => runScopedOperation(new Records(new Map(), false), scope, { actorId: scope.actorId, grantId }, 'owner',
    'request', op, { params: { id: randomUUID() }, query: {}, body: {}, expectedVersion: 1 }, 'rest', config);
  await assert.rejects(run('pat'), (error: Json) => error.code === 'HUMAN_REQUIRED' && error.status === 403);
  await assert.rejects(run(), (error: Json) => error.code === 'NOT_FOUND');
});
