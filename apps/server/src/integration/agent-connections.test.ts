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
import { registerOperationRoutes } from '../operation-server.js';
import { discoverOperations, runScopedOperation } from '../operations.js';
import { discover } from '../registry.js';
import { operationRecords } from './operation-records.js';

type Json = Record<string, any>;
const accept = 'application/json, text/event-stream';

async function fixture(t: TestContext) {
  const config = configuration({ SETUP_TOKEN: 'agent-connection-setup-token' });
  const store = new MemoryStore();
  const [{ operations }, discovered] = await Promise.all([discoverOperations(), discover()]);
  const { app } = buildApp({ ...config, ...discovered, store, operationApi: { config, operations, register: registerOperationRoutes } });
  t.after(() => app.close());
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  async function request(path: string, { method = 'GET', body, headers = {}, status = 200 }: { method?: string; body?: unknown; headers?: Json; status?: number } = {}) {
    const response = await fetch(base + path, { method, headers: { ...headers, ...body !== undefined && { 'content-type': 'application/json' } },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${raw}`);
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
  return { config, store, request, rpc, call, connect, records, owner, cookie, root, wid, session };
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

test('agent connections issue, list, survive logout, touch last use and revoke', async t => {
  const { request, rpc, connect, owner, cookie, root, records } = await fixture(t);
  await request(`${root}/agent-connections`, { method: 'POST', status: 403, body: { label: 'No CSRF' }, headers: { cookie } });
  await request(`${root}/agent-connections`, { method: 'POST', status: 422, body: { label: 'Bad', expires_days: 400 }, headers: owner });
  await request(`${root}/agent-connections`, { method: 'POST', status: 422, body: { label: 'Bad', client: 'cursor' }, headers: owner });
  const created = await connect({ label: 'MacBook Claude', client: 'claude_code', expires_days: 30 });
  assert.match(created.token, /^ss_command_/);
  assert.equal(created.mcp_url, 'http://127.0.0.1:3401/mcp');
  assert.ok(Math.abs(Date.parse(created.expires_at) - Date.now() - 30 * 86_400_000) < 60_000);
  assert.equal(created.setup.claude_code_command,
    `claude mcp add --transport http smartsell ${created.mcp_url} --scope user --header "Authorization: Bearer ${created.token}"`);
  assert.equal(created.setup.codex_command, `codex mcp add smartsell --url ${created.mcp_url} --bearer-token-env-var SMARTSELL_TOKEN`);
  assert.deepEqual(JSON.parse(created.setup.claude_code_json).mcpServers.smartsell,
    { type: 'http', url: created.mcp_url, headers: { Authorization: 'Bearer ${SMARTSELL_TOKEN}' } });
  assert.match(created.setup.codex_toml, /^\[mcp_servers\.smartsell\]\nurl = "http:\/\/127\.0\.0\.1:3401\/mcp"\nbearer_token_env_var = "SMARTSELL_TOKEN"/);
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
