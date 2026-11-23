import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Client } from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Problem, READ, WRITE } from '@smartsell/contracts';
import { fileStore, postgresStore, type Store } from '@smartsell/db';
import { configuration } from '../src/config.js';
import { digest } from '../src/identity.js';
import { discoverOperations, moduleKeys, type Registered } from '../src/operations.js';
import { runBackground } from '../src/runtime.js';
import { createServer } from '../src/server.js';

const operations: Registered[] = [
  { module: 'fixture', name: 'items_list', path: '/fixtures', method: 'GET', roles: READ, summary: 'List test records', run: ctx => ctx.list('fixture') },
  { module: 'fixture', name: 'items_create', path: '/fixtures', method: 'POST', roles: WRITE, summary: 'Create a test record', run(ctx, { body }) {
    const row = ctx.create('fixture', body);
    ctx.emit('fixture.item.created', { id: row.id, private_note: 'never send via SSE' });
    if (body.fail) throw new Problem(422, 'FIXTURE_FAILED', 'Intentional rollback');
    return row;
  } },
  { module: 'fixture', name: 'items_get', path: '/fixtures/:id', method: 'GET', roles: READ, summary: 'Read one record', run: (ctx, { params }) => ctx.get('fixture', params.id) },
  { module: 'fixture', name: 'items_update', path: '/fixtures/:id', method: 'PATCH', roles: WRITE, versionKind: 'fixture', summary: 'Update one record', run: (ctx, { params, body }) => ctx.update('fixture', params.id, body) },
  { module: 'fixture', name: 'items_bad_read', path: '/read-only-violation', method: 'GET', roles: READ, summary: 'Test readonly guard', run: ctx => ctx.create('fixture', {}) },
];

const setupBody = { email: 'owner@example.test', password: 'fixture-password-123', workspace_name: 'Owner workspace' };
const config = configuration({ PORT: '3401', SETUP_TOKEN: 'kernel-test-setup-token' });
const setupHeaders = { 'x-setup-token': config.setupToken! };
const readHeaders = { accept: 'application/json, text/event-stream' };

async function setup(app: ReturnType<typeof createServer>) {
  const response = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: setupHeaders, payload: setupBody });
  assert.equal(response.statusCode, 201, response.body);
  const user = response.json().data.user.id as string;
  const workspace = response.json().data.workspaces[0].id as string;
  const token = response.json().data.csrf_token as string;
  const raw = String(response.headers['set-cookie']);
  assert.match(raw, /HttpOnly; SameSite=Lax/);
  return { user, workspace, cookie: raw.split(';')[0], token, url: `/api/v1/workspaces/${workspace}` };
}

async function exerciseStore(store: Store, pg = false) {
  const app = createServer({ store, operations, config });
  try {
    const owner = await setup(app);
    const headers = { cookie: owner.cookie, 'x-csrf-token': owner.token, origin: config.origin };
    const session = await app.inject({ url: '/api/v1/session', headers });
    const expectedUser = { id: owner.user, email: setupBody.email, name: 'owner' };
    assert.deepEqual(session.json().data.user, expectedUser);
    const login = await app.inject({ method: 'POST', url: '/api/v1/session',
      payload: { username: setupBody.email.toUpperCase(), password: setupBody.password } });
    assert.equal(login.statusCode, 200);
    assert.deepEqual(login.json().data.user, expectedUser);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/setup', headers: setupHeaders, payload: setupBody })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: `${owner.url}/fixtures`, headers: { cookie: owner.cookie }, payload: {} })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: `${owner.url}/fixtures`, headers: { ...headers, origin: 'https://invalid.test' }, payload: {} })).statusCode, 403);
    const submit = (key: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: `${owner.url}/fixtures`, headers: { ...headers, 'idempotency-key': key }, payload });
    const [a, b] = await Promise.all([submit('same-key', { one: 1, two: 2 }), submit('same-key', { two: 2, one: 1 })]);
    assert.equal(a.statusCode, 200, a.body);
    assert.equal(b.statusCode, 200, b.body);
    assert.deepEqual(a.json(), b.json());
    assert.equal(a.headers.etag, '"1"');
    assert.equal((await submit('same-key', { three: 3 })).json().code, 'IDEMPOTENCY_MISMATCH');
    assert.equal((await submit('will-rollback', { fail: true })).statusCode, 422);
    assert.equal((await app.inject({ url: `${owner.url}/read-only-violation`, headers })).statusCode, 500);
    const list = await app.inject({ url: `${owner.url}/fixtures`, headers });
    assert.equal(list.json().data.length, 1);
    const id = a.json().data.id as string;
    const patch = (version?: string) => app.inject({ method: 'PATCH', url: `${owner.url}/fixtures/${id}`, headers: { ...headers, ...(version && { 'if-match': version }) }, payload: { new_value: true } });
    assert.equal((await patch()).statusCode, 428);
    const concurrent = await Promise.all([patch('"1"'), patch('1')]);
    assert.deepEqual(concurrent.map(result => result.statusCode).sort(), [200, 409]);
    assert.equal(concurrent.find(result => result.statusCode === 409)?.json().details.current_version, 2);
    assert.equal((await app.inject({ url: `${owner.url}/fixtures/${id}`, headers })).headers.etag, '"2"');
    const second = await submit('second', { second: true });
    assert.equal(second.statusCode, 200);
    const page = await app.inject({ url: `${owner.url}/fixtures?limit=1`, headers });
    assert.equal(page.json().data.length, 1);
    const next = await app.inject({ url: `${owner.url}/fixtures?limit=1&cursor=${page.json().next_cursor}`, headers });
    assert.equal(next.json().data.length, 1);
    assert.equal(next.json().next_cursor, null);
    assert.notEqual(page.json().data[0].id, next.json().data[0].id);

    const foreignWorkspace = randomUUID();
    const foreignTenant = randomUUID();
    const localTenant = await store.transaction({ identityWrite: true }, async tx => {
      const tenant = tx.identity.get<{ tenantId: string }>(`workspace/${owner.workspace}`)!.tenantId;
      tx.identity.put(`workspace/${foreignWorkspace}`, { id: foreignWorkspace, tenantId: foreignTenant, name: 'Other tenant' });
      tx.identity.put(`tenant/${foreignTenant}`, { id: foreignTenant, status: 'active' });
      const scoped = await tx.workspace({ workspaceId: foreignWorkspace, tenantId: foreignTenant, actorId: owner.user });
      scoped.put(`row/fixture/${id}`, { id, value: 'private' });
      return tenant;
    });
    assert.equal((await app.inject({ url: `/api/v1/workspaces/${foreignWorkspace}/fixtures`, headers })).statusCode, 404);
    const snapshots = await store.transaction({ readOnly: true }, async tx => {
      const records = await tx.workspace({ workspaceId: owner.workspace, tenantId: localTenant, actorId: owner.user });
      return { rows: records.list('row/fixture/'), audit: records.list('audit/'), outbox: records.list('outbox/') };
    });
    assert.equal(snapshots.rows.length, 2);
    assert.equal(snapshots.audit.length, 4);
    assert.equal(snapshots.outbox.length, 2);

    const tokenReq = await app.inject({ method: 'POST', url: `${owner.url}/tokens`, headers, payload: { tools: ['items_get', 'items_create'] } });
    assert.equal(tokenReq.statusCode, 201, tokenReq.body);
    const credential = tokenReq.json().data;
    const bearer = { authorization: `Bearer ${credential.token}` };
    const rpc = (method: string, params: Record<string, unknown>) => app.inject({
      method: 'POST', url: '/mcp', headers: { ...readHeaders, ...bearer }, payload: { jsonrpc: '2.0', id: 1, method, params },
    });
    const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Fixture', version: '1' } });
    assert.equal(init.json().result.serverInfo.name, 'smartsell');
    assert.match(init.json().result.instructions, /worker_social_status_request.*recent_posts.*worker_social_status_get/);
    const tasksInit = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: { tasks: {} },
      clientInfo: { name: 'Fixture', version: '1' } });
    assert.match(tasksInit.json().result.instructions, /worker_social_status_request.*recent_posts.*worker_social_status_get/);
    const tools = await rpc('tools/list', {});
    assert.deepEqual(tools.json().result.tools.map((tool: { name: string }) => tool.name), ['items_get']);
    const tool = await rpc('tools/call', { name: 'items_get', arguments: { workspace_id: owner.workspace, params: { id } } });
    assert.equal(tool.json().result.structuredContent.data.version, 2);
    const deniedTool = await rpc('tools/call', { name: 'items_get', arguments: { workspace_id: foreignWorkspace, params: { id } } });
    assert.equal(deniedTool.json().result.structuredContent.data.code, 'NOT_FOUND');
    const catalog = await app.inject({ url: `${owner.url}/catalog`, headers: bearer });
    assert.deepEqual(catalog.json().data.map((entry: { name: string }) => entry.name), ['items_get']);
    assert.equal((await app.inject({ method: 'DELETE', url: `${owner.url}/tokens/${credential.id}`, headers })).statusCode, 204);
    assert.equal((await rpc('tools/list', {})).statusCode, 401);

    const writeToken = await app.inject({ method: 'POST', url: `${owner.url}/tokens`, headers,
      payload: { access: 'write', tools: ['items_create'] } });
    assert.equal(writeToken.statusCode, 201, writeToken.body);
    const writeBearer = { authorization: `Bearer ${writeToken.json().data.token}`, 'idempotency-key': 'same-key' };
    // Idempotency keys belong to one credential: the token's "same-key" is its own write, never a replay of the session's stored response.
    const crossCredentialReplay = await app.inject({ method: 'POST', url: `${owner.url}/fixtures`, headers: writeBearer, payload: { one: 1, two: 2 } });
    assert.equal(crossCredentialReplay.statusCode, 200, crossCredentialReplay.body);
    assert.notEqual(crossCredentialReplay.json().data.id, a.json().data.id);
    assert.equal(crossCredentialReplay.json().data.created_via, 'agent');
    const tokenReplay = await app.inject({ method: 'POST', url: `${owner.url}/fixtures`, headers: writeBearer, payload: { one: 1, two: 2 } });
    assert.deepEqual(tokenReplay.json(), crossCredentialReplay.json());
    const formWrite = await app.inject({ method: 'POST', url: `${owner.url}/fixtures`,
      headers: { ...writeBearer, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'one=1' });
    assert.equal(formWrite.statusCode, 415, formWrite.body);
    let nested: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) nested = { nested };
    assert.equal((await submit('too-deep', nested)).json().code, 'VALIDATION_FAILED');

    if (pg) {
      const { db, verifyRls } = await import('./postgres-rls.js');
      assert.ok(db);
      await verifyRls(localTenant, owner.workspace, owner.user, foreignWorkspace, foreignTenant);
    }

    const registration = await app.inject({ method: 'POST', url: '/oauth/register', payload: { redirect_uris: ['http://127.0.0.1:49391/callback'] } });
    assert.equal(registration.statusCode, 201, registration.body);
    const client_id = registration.json().client_id as string;
    const verifier = 'V'.repeat(50);
    const redirect_uri = 'http://127.0.0.1:49391/callback';
    const authFields = { client_id, redirect_uri, response_type: 'code', code_challenge: digest(verifier), code_challenge_method: 'S256', state: 'client-state', workspace_id: owner.workspace, scope: 'smartsell:read', resource: `${config.origin}/mcp` };
    const consent = await app.inject({ url: `/oauth/authorize?${new URLSearchParams(authFields)}`, headers: { cookie: owner.cookie } });
    assert.equal(consent.statusCode, 200);
    assert.match(consent.body, /Owner workspace/);
    const approval = await app.inject({ method: 'POST', url: '/oauth/authorize', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ ...authFields, csrf_token: owner.token }).toString() });
    assert.equal(approval.statusCode, 303, approval.body);
    const callback = new URL(String(approval.headers.location));
    assert.equal(callback.searchParams.get('state'), 'client-state');
    const exchange = (code_verifier: string) => app.inject({ method: 'POST', url: '/oauth/token', headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ grant_type: 'authorization_code', code: callback.searchParams.get('code')!, code_verifier, client_id, redirect_uri }).toString() });
    assert.equal((await exchange('W'.repeat(50))).json().error, 'invalid_grant');
    const issued = await exchange(verifier);
    assert.equal(issued.statusCode, 200, issued.body);
    assert.equal((await exchange(verifier)).json().error, 'invalid_grant');
    const oauthBearer = { authorization: `Bearer ${issued.json().access_token}` };
    const rest = await app.inject({ url: `${owner.url}/fixtures/${id}`, headers: oauthBearer });
    assert.equal(rest.statusCode, 200, rest.body);
    const mcp = await app.inject({ method: 'POST', url: '/mcp', headers: { ...readHeaders, ...oauthBearer }, payload: {
      jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'items_get', arguments: { workspace_id: owner.workspace, params: { id } } },
    } });
    assert.deepEqual(mcp.json().result.structuredContent, { ...rest.json(), etag: rest.headers.etag });

    await store.transaction({ identityWrite: true }, ({ identity }) => {
      identity.put(`member/${owner.user}/${owner.workspace}`, { userId: owner.user, workspaceId: owner.workspace, role: 'viewer' });
    });
    const viewerCatalog = await app.inject({ url: `${owner.url}/catalog`, headers });
    assert.equal(viewerCatalog.statusCode, 200, viewerCatalog.body);
    const fixtureEntries = viewerCatalog.json().data.filter((entry: { module: string }) => entry.module === 'fixture');
    assert.deepEqual(fixtureEntries.map((entry: { name: string }) => entry.name), ['items_list', 'items_get', 'items_bad_read']);
    assert.equal((await submit('viewer-write', {})).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/logout', headers })).statusCode, 204);
    assert.equal((await app.inject({ url: '/api/v1/session', headers })).statusCode, 401);
  } finally { await app.close(); }
}

async function temporaryFile() {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-kernel-'));
  return { path: join(directory, 'db.json'), dispose: () => rm(directory, { recursive: true, force: true }) };
}

test('file kernel: auth, isolation, version checks, atomic outbox, idempotency, MCP and OAuth', async () => {
  const fixture = await temporaryFile();
  try {
    await exerciseStore(await fileStore(fixture.path));
    const reopened = createServer({ config, store: await fileStore(fixture.path), operations });
    try {
      const login = await reopened.inject({ method: 'POST', url: '/api/v1/login', payload: setupBody });
      assert.equal(login.statusCode, 200, login.body);
      const { id } = login.json().data.workspaces[0];
      const restored = await reopened.inject({ url: `/api/v1/workspaces/${id}/fixtures`, headers: { cookie: String(login.headers['set-cookie']).split(';')[0] } });
      // Two from the session (one replayed) and one from the write token, whose idempotency key is its own.
      assert.equal(restored.json().data.length, 3);
    } finally { await reopened.close(); }
  } finally { await fixture.dispose(); }
});

test('postgres kernel and direct RLS', { skip: !process.env.SMARTSELL_TEST_DATABASE_URL }, async () => {
  await exerciseStore(await postgresStore(process.env.SMARTSELL_TEST_DATABASE_URL!), true);
});

test('PostgreSQL publishes workspace wakeups only after the transaction commits', { skip: !process.env.SMARTSELL_TEST_DATABASE_URL }, async () => {
  const connectionString = process.env.SMARTSELL_TEST_DATABASE_URL!;
  const store = await postgresStore(connectionString);
  const listener = new Client({ connectionString });
  const rolledBack = { tenantId: randomUUID(), workspaceId: randomUUID(), actorId: randomUUID() };
  const committed = { ...rolledBack, workspaceId: randomUUID() };
  try {
    await listener.connect();
    await listener.query('LISTEN smartsell_workspace_changed');
    const notification = once(listener, 'notification', { signal: AbortSignal.timeout(5000) });
    void notification.catch(() => {});
    await assert.rejects(store.transaction({}, async tx => {
      (await tx.workspace(rolledBack)).put('stream/revision', 1);
      throw new Error('roll back');
    }), /roll back/);
    await store.transaction({}, async tx => { (await tx.workspace(committed)).put('stream/revision', 1); });
    const [message] = await notification;
    assert.equal(message.payload, committed.workspaceId);
  } finally { await listener.end(); await store.close(); }
});

test('scheduler dispatches to durable jobs; subscriber publishes an SSE invalidation', async () => {
  const fixture = await temporaryFile();
  const store = await fileStore(fixture.path);
  const app = createServer({ config, store, operations, subscribers: [{ id: 'fixture', accepts: type => type === 'fixture.item.created', run(ctx, event) {
    ctx.create('handled', { type: event.type });
    ctx.emit('core.fixture.handled', {});
  } }] });
  const stop = new AbortController();
  try {
    const owner = await setup(app);
    const base = await app.listen({ port: 0, host: '127.0.0.1' });
    const response = await fetch(`${base}${owner.url}/stream`, { headers: { cookie: owner.cookie }, signal: stop.signal });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
    await app.inject({ method: 'POST', url: `${owner.url}/fixtures`, headers: { cookie: owner.cookie, 'x-csrf-token': owner.token }, payload: {} });
    const sse = await Promise.race([reader.read(), delay(4000, null, { ref: false })]);
    assert.ok(sse);
    const event = new TextDecoder().decode(sse.value);
    assert.match(event, /event: workspace.changed/);
    assert.doesNotMatch(event, /private_note/);
    for (let i = 0; i < 40; i++) {
      const count = await store.transaction({ readOnly: true }, async tx => {
        const { tenantId } = tx.identity.get<{ tenantId: string }>(`workspace/${owner.workspace}`)!;
        return (await tx.workspace({ workspaceId: owner.workspace, actorId: owner.user, tenantId })).list('consumed/').length;
      });
      if (count > 0) { assert.equal(count, 1); return; }
      await delay(100);
    }
    assert.fail('Worker did not consume the event');
  } finally { stop.abort(); await app.close(); await fixture.dispose(); }
});

test('scheduler queues jobs and the worker and media roles consume their own queues', async () => {
  const fixture = await temporaryFile();
  const store = await fileStore(fixture.path);
  const app = createServer({ config: { ...config, roles: new Set(['api']) }, store, operations });
  const subscribers = [
    { id: 'ordinary', accepts: () => true, run() {} },
    { id: 'thumbnail', queue: 'media' as const, accepts: () => true, run() {} },
  ];
  try {
    const owner = await setup(app);
    const response = await app.inject({ method: 'POST', url: `${owner.url}/fixtures`, headers: { cookie: owner.cookie, 'x-csrf-token': owner.token }, payload: {} });
    assert.equal(response.statusCode, 200, response.body);
    const inspect = () => store.transaction({ readOnly: true }, async tx => {
      const { tenantId } = tx.identity.get<{ tenantId: string }>(`workspace/${owner.workspace}`)!;
      const records = await tx.workspace({ tenantId, workspaceId: owner.workspace, actorId: owner.user });
      return { queued: records.entries('job/').map(([key]) => key.split('/')[1]).sort(), consumed: records.entries('consumed/').map(([key]) => key.split('/')[1]).sort() };
    });
    for (const [role, queued, consumed] of [
      ['scheduler', ['ordinary', 'thumbnail'], []],
      ['worker', ['thumbnail'], ['ordinary']],
      ['media', [], ['ordinary', 'thumbnail']],
    ] as const) {
      const stop = runBackground(store, { ...config, roles: new Set([role]) }, subscribers, [], app.log);
      try {
        const expected = { queued, consumed };
        for (let i = 0; i < 30; i++) {
          const actual = await inspect();
          if (JSON.stringify(actual) === JSON.stringify(expected)) break;
          await delay(50);
        }
        assert.deepEqual(await inspect(), expected, role);
      } finally { await stop(); }
    }
  } finally { await app.close(); await fixture.dispose(); }
});

test('discovers every advertised module and mounts the real REST catalog', async () => {
  const discovery = await discoverOperations();
  assert.deepEqual(discovery.missingModules, [], JSON.stringify([...discovery.loadFailures]));
  const fixture = await temporaryFile();
  const store = await fileStore(fixture.path);
  try {
    const app = createServer({ config, store, operations: discovery.operations });
    try {
      const owner = await setup(app);
      const headers = { cookie: owner.cookie, 'x-csrf-token': owner.token };
      const catalog = await app.inject({ url: `${owner.url}/catalog`, headers });
      assert.equal(catalog.statusCode, 200, catalog.body);
      const entries = catalog.json().data as Registered[];
      for (const module of moduleKeys) assert.ok(entries.some(entry => entry.module === module), module);
      const task = await app.inject({ method: 'POST', url: `${owner.url}/work-items`, headers,
        payload: { type: 'todo', title: 'Read a workspace work item through MCP' } });
      assert.equal(task.statusCode, 200, task.body);
      const { id } = task.json().data;
      const token = await app.inject({ method: 'POST', url: `${owner.url}/tokens`, headers,
        payload: { access: 'read', tools: ['tasks_get', 'tasks_update'] } });
      assert.equal(token.statusCode, 201, token.body);
      const rpc = (method: string, params: Record<string, unknown>) => app.inject({ method: 'POST', url: '/mcp',
        headers: { ...readHeaders, authorization: `Bearer ${token.json().data.token}` },
        payload: { jsonrpc: '2.0', id: 1, method, params } });
      assert.deepEqual((await rpc('tools/list', {})).json().result.tools.map((tool: { name: string }) => tool.name), ['tasks_get']);
      const read = await rpc('tools/call', { name: 'tasks_get', arguments: { workspace_id: owner.workspace, params: { id } } });
      assert.equal(read.json().result?.structuredContent?.data.id, id, read.body);
      await store.transaction({ identityWrite: true }, ({ identity }) => {
        identity.put(`member/${owner.user}/${owner.workspace}`, { userId: owner.user, workspaceId: owner.workspace, role: 'viewer' });
      });
      const restricted = await app.inject({ url: `${owner.url}/catalog`, headers });
      assert.ok(restricted.json().data.some((entry: Registered) => entry.name === 'workspace_get'));
      assert.ok(!restricted.json().data.some((entry: Registered) => entry.name === 'workspace_brand_create'));
      assert.equal((await app.inject({ method: 'POST', url: `${owner.url}/brands`, headers, payload: { name: 'Restricted' } })).statusCode, 403);
    } finally { await app.close(); }
  } finally { await store.close(); await fixture.dispose(); }
});

test('production rejects missing or unsafe configuration', () => {
  assert.throws(() => configuration({ NODE_ENV: 'production' }));
  assert.throws(() => configuration({ HOST: '0.0.0.0' }));
});
