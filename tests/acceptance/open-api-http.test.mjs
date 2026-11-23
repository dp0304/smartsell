import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileStore } from '../../packages/db/src/index.ts';

// Resolve the package exports from the Web workspace, which declares the SDK dependency.
const sdkEntry = createRequire(new URL('../../apps/web/package.json', import.meta.url)).resolve('@smartsell/sdk');
const { ApiError, callWorkspace, getWorkspaceOpenApi, workspacePath } = await import(pathToFileURL(sdkEntry).href);

const cwd = fileURLToPath(new URL('../../', import.meta.url));
const template = '/api/v1/workspaces/{ws}';
const onError = (status, code) => error => {
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, status);
  if (code) assert.equal(error.problem.code, code);
  return true;
};

async function launch(t, entry) {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-op08-'));
  const state = join(directory, entry === 'command-main' ? 'commands.sqlite' : 'operations.json');
  const other = { workspaceId: randomUUID(), tenantId: randomUUID(), actorId: randomUUID(), brandId: randomUUID() };
  let child;
  let exited;
  async function stop() {
    const running = child;
    if (!running) return;
    child = undefined;
    running.kill('SIGTERM');
    const timer = setTimeout(() => running.kill('SIGKILL'), 3000).unref();
    try { await exited; } finally { clearTimeout(timer); }
  }
  t.after(async () => {
    try { await stop(); } finally { await rm(directory, { recursive: true, force: true }); }
  });
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address();
  await new Promise((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const setupToken = randomUUID();
  async function start() {
    const running = spawn(process.execPath, ['--import', 'tsx', `apps/server/src/${entry}.ts`], {
      cwd, env: { PATH: process.env.PATH, CLAUDECODE: process.env.CLAUDECODE, NODE_ENV: 'test', ROLE: 'all', HOST: '127.0.0.1', PORT: String(port),
        PUBLIC_ORIGIN: origin, SMARTSELL_DATA_FILE: state, SETUP_TOKEN: setupToken },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = running;
    let logs = '';
    for (const stream of [running.stdout, running.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-5000); });
    exited = once(running, 'close');
    const deadline = Date.now() + 15_000;
    while (true) {
      assert.ok(running.exitCode === null && running.signalCode === null && Date.now() < deadline, `${entry} did not become ready\n${logs}`);
      const ready = await fetch(`${origin}/readyz`, { signal: AbortSignal.timeout(1000) }).catch(() => undefined);
      await ready?.body?.cancel();
      if (ready?.ok) break;
      await delay(100);
    }
  }
  await start();
  async function request(path, { method = 'GET', headers, body, status = 200 } = {}) {
    const response = await fetch(`${origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.text();
    assert.equal(response.status, status, `${method} ${path}: ${payload}`);
    return { payload: payload && JSON.parse(payload), headers: response.headers };
  }
  if (entry === 'kernel-main') {
    const uninitialized = { initialized: false, token_required: true, registration_enabled: true, password_min_length: 12 };
    assert.deepEqual((await request('/api/v1/setup/status')).payload.data, uninitialized);
    await request('/oauth/register', { method: 'POST', status: 201,
      body: { redirect_uris: ['http://127.0.0.1:8765/callback'] } });
    assert.deepEqual((await request('/api/v1/setup/status')).payload.data, uninitialized);
  }
  const owner = { email: 'owner@example.invalid', name: 'Owner', workspaceName: 'OP08 fixture' };
  const setupHeaders = { 'x-setup-token': setupToken };
  await request('/api/v1/setup', { method: 'POST', status: 422,
    headers: setupHeaders, body: { ...owner, password: '123456' } });
  const password = 'op08-local-fixture-password';
  const { payload, headers } = await request('/api/v1/setup', { method: 'POST', status: 201,
    headers: setupHeaders, body: { ...owner, password } });
  const ws = payload.data.workspaces[0].id;
  if (entry === 'kernel-main') {
    // Seed the cross-tenant fixture after setup, once the server has released the file store lock.
    await stop();
    const store = await fileStore(state);
    try {
      await store.transaction({ identityWrite: true }, async tx => {
        tx.identity.put(`tenant/${other.tenantId}`, { id: other.tenantId, status: 'active' });
        tx.identity.put(`workspace/${other.workspaceId}`, { id: other.workspaceId, name: 'Other tenant', tenantId: other.tenantId });
        const records = await tx.workspace(other);
        records.put(`row/brand/${other.brandId}`, { id: other.brandId, name: 'Other tenant brand', status: 'active' });
      });
    } finally {
      await store.close();
    }
    await start();
  }
  async function session(headers, data) {
    const cookie = headers.get('set-cookie').split(';')[0];
    const csrf = data?.csrf_token ?? (await request('/api/v1/session/csrf', { headers: { cookie } })).payload.csrf_token;
    assert.ok(csrf);
    return { cookie, csrf };
  }
  const auth = await session(headers, payload.data);
  const root = workspacePath(ws);
  const sessionHeaders = { cookie: auth.cookie, 'x-csrf-token': auth.csrf };
  return { ws, other, root, origin, request, auth, sessionHeaders,
    async viewer(email = 'viewer@example.invalid') {
      const { payload } = await request(`${root}/members/invite`, { method: 'POST', headers: sessionHeaders, body: { email, role: 'viewer' } });
      await request('/api/v1/member-invitations/accept', { method: 'POST', status: 204, body: { token: payload.data.invitation_token, email, name: 'Viewer', password } });
      const login = await request('/api/v1/login', { method: 'POST', body: { email, password } });
      return session(login.headers, login.payload.data);
    },
  };
}

test('OP08 SDK rejects invalid workspace path segments before transport', async () => {
  const options = { fetch: () => assert.fail('Invalid workspace ID reached transport') };
  for (const id of ['.', '..', 'a/b', 'a\\b']) {
    await assert.rejects(getWorkspaceOpenApi(id, options), /invalid_path_parameter/);
    await assert.rejects(callWorkspace('workspace_get_context', id, options), /invalid_path_parameter/);
  }
});

for (const [name, entry] of [['Commands', 'command-main'], ['Operations', 'kernel-main']]) {
  test(`OP08 ${name} serves authorized OpenAPI and executes SDK requests on loopback`, { timeout: 35_000 }, async t => {
    const s = await launch(t, entry);
    const { ws, origin, auth, root, other } = s;
    const options = { origin, auth };
    const doc = await getWorkspaceOpenApi(ws, options);
    await assert.rejects(getWorkspaceOpenApi(ws, { origin }), onError(401));
    await assert.rejects(getWorkspaceOpenApi(other.workspaceId, options), onError(404));
    await assert.rejects(callWorkspace('workspace_brands_list', other.workspaceId, options), onError(404));
    await assert.rejects(callWorkspace('workspace_get_context', other.workspaceId, options), onError(404));
    const brands = doc.paths[`${template}/brands`];
    const brand = doc.paths[`${template}/brands/{id}`];
    const context = doc.paths[`${template}/context`].get;
    assert.equal(doc.openapi, '3.1.0');
    assert.deepEqual(brands.get.parameters.find(p => p.name === 'limit').schema,
      { type: 'integer', minimum: 1, maximum: 200, default: 50 });
    const listSchema = brands.get.responses['200'].content['application/json'].schema;
    assert.deepEqual(listSchema.required, ['data', 'next_cursor']);
    assert.equal(listSchema.properties.data.items.properties.version.type, 'integer');
    assert.deepEqual(brands.post.requestBody.content['application/json'].schema.required, ['name', 'slug']);
    const ifMatch = brand.patch.parameters.find(p => p.name === 'If-Match');
    assert.equal(ifMatch.required, true);
    const versionFormat = new RegExp(ifMatch.schema.pattern);
    assert.match('"1"', versionFormat);
    assert.match('1', versionFormat);
    assert.doesNotMatch('0', versionFormat);
    assert.doesNotMatch('"0"', versionFormat);
    assert.equal(brands.post.parameters.find(p => p.name === 'Idempotency-Key').required, undefined);
    assert.ok(brand.patch.responses['409'].content['application/problem+json']);
    assert.ok(brands.post.responses['422'].content['application/problem+json']);
    assert.ok(brand.patch.responses['428'].content['application/problem+json']);
    assert.equal(context.responses['200'].content['application/json'].schema.properties.data.properties.workspace_id.type, 'string');
    assert.ok(!context.parameters.some(p => p.name === 'cursor'));
    const discovery = await s.request(`${root}/openapi.json`, { headers: s.sessionHeaders });
    assert.equal(discovery.headers.get('cache-control'), 'no-store');
    assert.deepEqual(discovery.payload, doc);
    const catalog = (await s.request(`${root}/catalog`, { headers: s.sessionHeaders })).payload.data;
    const documented = Object.values(doc.paths).flatMap(path => Object.values(path)).filter(operation => !operation['x-smartsell-alias-of']);
    assert.equal(new Set(documented.map(operation => operation.operationId)).size, documented.length);
    assert.deepEqual(new Set(documented.map(operation => operation.operationId)),
      new Set([...catalog.map(operation => operation.name), 'workspace_operation_catalog', 'workspace_openapi_document']));
    for (const { path, method, name } of catalog) {
      const route = path === '/' ? template : `${template}${path.replace(/:([\w]+)/g, '{$1}')}`;
      assert.equal(doc.paths[route][method.toLowerCase()].operationId, name);
    }

    const create = (slug, extra = {}) => callWorkspace('workspace_brand_create', ws, { ...options, body: { name: slug, slug }, ...extra });
    const first = await create('north', { idempotencyKey: 'op08-create' });
    const { payload: { data: south } } = await s.request(`${root}/brands`, {
      method: 'POST', headers: s.sessionHeaders, body: { name: 'south', slug: 'south' },
    });
    assert.equal(first.status, 200);
    assert.equal(first.etag, `"${first.data.version}"`);
    assert.deepEqual(await create('north', { idempotencyKey: 'op08-create' }), first);
    await assert.rejects(create('different', { idempotencyKey: 'op08-create' }), onError(422, 'IDEMPOTENCY_MISMATCH'));

    const list = (query, transport = options) => callWorkspace('workspace_brands_list', ws, { ...transport, query });
    const page = await list({ limit: 1, status: 'active' });
    assert.equal(typeof page.next_cursor, 'string');
    const last = await list({ limit: 1, status: 'active', cursor: page.next_cursor });
    assert.equal(last.next_cursor, null);
    assert.deepEqual(new Set([...page.data, ...last.data].map(row => row.id)), new Set([first.data.id, south.id]));
    await assert.rejects(list({ status: 'archived', cursor: page.next_cursor }), onError(422));
    await assert.rejects(list({ limit: 201 }), onError(422));
    const sameWorkspace = await callWorkspace('workspace_get_context', ws, {
      ...options, query: { brand_id: first.data.id, task_scope: 'campaign & draft/zh' },
    });
    assert.equal(sameWorkspace.data.workspace_id, ws);
    assert.equal(sameWorkspace.data.task_scope, 'campaign & draft/zh');
    assert.deepEqual(sameWorkspace.data.brands.map(row => row.id), [first.data.id]);
    assert.equal(sameWorkspace.next_cursor, undefined);

    const update = extra => callWorkspace('workspace_brand_update', ws, { ...options, params: { id: first.data.id }, body: { name: 'Updated' }, ...extra });
    await assert.rejects(update({}), onError(428, 'VERSION_REQUIRED'));
    await assert.rejects(update({ version: 0 }), onError(422));
    await assert.rejects(update({ version: first.etag, auth: { cookie: auth.cookie } }), onError(403));
    const updated = await update({ version: first.etag, idempotencyKey: 'op08-update' });
    assert.equal(updated.data.version, first.data.version + 1);
    assert.equal(updated.etag, `"${updated.data.version}"`);
    assert.deepEqual(await update({ version: first.etag, idempotencyKey: 'op08-update' }), updated);
    await assert.rejects(update({ version: first.data.version }), error => {
      onError(409, 'VERSION_CONFLICT')(error);
      assert.equal(error.problem.details.current_version, updated.data.version);
      assert.ok(error.problem.request_id);
      return true;
    });
    const conflict = await s.request(`${root}/brands/${first.data.id}`, {
      method: 'PATCH', headers: { ...s.sessionHeaders, 'if-match': first.etag }, body: { name: 'Stale' }, status: 409,
    });
    assert.match(conflict.headers.get('content-type'), /^application\/problem\+json\b/);
    assert.deepEqual(await callWorkspace('workspace_brand_get', ws, { ...options, params: { id: first.data.id } }), updated);

    const contentApi = doc.paths[`${template}/content-items`];
    const contentBody = contentApi.post.requestBody.content['application/json'].schema;
    assert.deepEqual(contentBody.required, ['brand_id', 'title']);
    assert.equal(contentBody.properties.tasks.items.properties.title.type, 'string');
    const content = await callWorkspace('content_create_item', ws, { ...options, body: {
      brand_id: first.data.id, title: 'Local content', production_due_at: null, tasks: [{ title: 'Local task' }],
    } });
    assert.equal(content.data.tasks[0].title, 'Local task');
    const secondContent = await callWorkspace('content_create_item', ws, { ...options, body: {
      brand_id: first.data.id, title: 'Second local content',
    } });
    await callWorkspace('content_create_item', ws, { ...options, body: { brand_id: south.id, title: 'Other brand content' } });
    const contentList = cursor => callWorkspace('content_list', ws, { ...options, query: { brand_id: first.data.id, limit: 1, cursor } });
    const contentPage = await contentList();
    assert.equal(contentPage.data.length, 1);
    assert.equal(typeof contentPage.next_cursor, 'string');
    const lastContentPage = await contentList(contentPage.next_cursor);
    assert.equal(lastContentPage.data.length, 1);
    assert.equal(lastContentPage.next_cursor, null);
    const contentRows = [...contentPage.data, ...lastContentPage.data];
    assert.deepEqual(new Set(contentRows.map(row => row.id)), new Set([content.data.item.id, secondContent.data.item.id]));
    assert.equal(contentRows.find(row => row.id === content.data.item.id)?.production_stage, 'accepted');

    const campaignInput = { brand_id: first.data.id, name: 'Local campaign', kind: 'launch', timezone: 'UTC' };
    const campaignsApi = doc.paths[`${template}/campaigns`].get;
    const campaignPage = campaignsApi.responses['200'].content['application/json'].schema;
    assert.deepEqual(campaignPage.required, ['data', 'next_cursor']);
    assert.equal(campaignPage.properties.data.items.properties.brand_id.type, 'string');
    assert.deepEqual(campaignPage.properties.next_cursor.type, ['string', 'null']);
    assert.deepEqual(campaignsApi.parameters.find(p => p.name === 'limit').schema,
      { type: 'integer', minimum: 1, maximum: 200, default: 50 });
    assert.equal(campaignsApi.parameters.find(p => p.name === 'cursor').in, 'query');
    const left = await callWorkspace('campaign_create_draft', ws, { ...options, body: campaignInput });
    const right = await callWorkspace('campaign_create_draft', ws, { ...options, body: { ...campaignInput, name: 'Second local campaign' } });
    await callWorkspace('campaign_create_draft', ws, { ...options, body: { ...campaignInput, brand_id: south.id } });
    const campaigns = (query, transport = options) => callWorkspace('campaign_list', ws, { ...transport, query: { brand_id: first.data.id, ...query } });
    const current = await campaigns();
    assert.deepEqual(new Set(current.data.map(row => row.id)), new Set([left.data.id, right.data.id]));
    assert.equal(current.next_cursor, null);
    const firstPage = await campaigns({ limit: 1 });
    const cursor = firstPage.next_cursor;
    await t.test('Campaign pagination follows limit and cursor', async () => {
      const unfiltered = await s.request(`${root}/campaigns?limit=1`, { headers: s.sessionHeaders });
      assert.equal(unfiltered.payload.data.length, 1);
      assert.equal(typeof unfiltered.payload.next_cursor, 'string');
      assert.equal(firstPage.data.length, 1);
      assert.equal(typeof cursor, 'string');
      const query = new URLSearchParams({ brand_id: first.data.id, limit: 1 });
      const raw = await s.request(`${root}/campaigns?${query}`, { headers: s.sessionHeaders });
      assert.deepEqual(raw.payload, { data: firstPage.data, next_cursor: cursor });
      const secondPage = await campaigns({ limit: 1, cursor });
      assert.equal(secondPage.data.length, 1);
      assert.equal(secondPage.next_cursor, null);
      assert.deepEqual([...firstPage.data, ...secondPage.data], current.data);
      for (const filters of [{ brand_id: south.id }, { status: left.data.status }, { active_on: '2026-11-20' }]) {
        await assert.rejects(campaigns({ ...filters, cursor }), onError(422, 'VALIDATION_FAILED'));
      }
      await assert.rejects(campaigns({ cursor: `${cursor}x` }), onError(422, 'VALIDATION_FAILED'));
      await assert.rejects(campaigns({ limit: 201 }), onError(422, 'VALIDATION_FAILED'));
      await assert.rejects(callWorkspace('campaign_list', other.workspaceId, { ...options, query: { cursor } }), onError(404));
    });

    if (name === 'Commands') {
      assert.deepEqual(brands.post.security, [{ sessionCookie: [], csrfToken: [] }]);
      assert.equal(doc.components.securitySchemes.accessToken, undefined);
      const listAliasPath = '/commands/campaign/operation_campaign_list';
      const listAlias = doc.paths[`${template}${listAliasPath}`].post;
      const nested = listAlias.responses['200'].content['application/json'].schema;
      assert.deepEqual(nested.required, ['data']);
      assert.deepEqual(nested.properties.data, campaignPage);
      const { payload: legacy } = await s.request(`${root}${listAliasPath}`, { method: 'POST', headers: s.sessionHeaders,
        body: { fields: { brand_id: first.data.id, limit: 1, cursor } } });
      assert.deepEqual(legacy, { data: { data: current.data.slice(1), next_cursor: null } });
      const aliasPath = '/commands/campaign/operation_campaign_create_draft';
      const alias = doc.paths[`${template}${aliasPath}`].post;
      assert.equal(alias['x-smartsell-alias-of'], 'campaign_create_draft');
      assert.equal(alias.parameters.find(p => p.name === 'Idempotency-Key').required, true);
      const aliasSchema = alias.requestBody.content['application/json'].schema;
      assert.equal(aliasSchema.properties.fields.additionalProperties, false);
      assert.ok(aliasSchema.properties.fields.required.includes('brand_id'));
      const aliasBody = { fields: { ...campaignInput, name: 'Local launch' } };
      await s.request(`${root}${aliasPath}`, { method: 'POST', headers: s.sessionHeaders, body: aliasBody, status: 422 });
      const { payload } = await s.request(`${root}${aliasPath}`, { method: 'POST', headers: { ...s.sessionHeaders, 'idempotency-key': 'op08-campaign' },
        body: aliasBody });
      assert.ok((await campaigns()).data.some(campaign => campaign.id === payload.data.id));
      const viewer = { origin, auth: await s.viewer() };
      const viewerDoc = await getWorkspaceOpenApi(ws, viewer);
      assert.ok(viewerDoc.paths[`${template}/brands`].get);
      assert.equal(viewerDoc.paths[`${template}/brands`].post, undefined);
      await assert.rejects(create('denied', viewer), onError(403));
      const viewerPage = await campaigns({ limit: 1 }, viewer);
      const secondViewer = { origin, auth: await s.viewer('second-viewer@example.invalid') };
      await assert.rejects(campaigns({ cursor: viewerPage.next_cursor }, secondViewer), onError(422, 'VALIDATION_FAILED'));
      return;
    }
    assert.equal(doc.components.securitySchemes.accessToken.scheme, 'bearer');
    assert.deepEqual(brands.post.security, [{ sessionCookie: [], csrfToken: [] }, { accessToken: [] }]);
    assert.equal(doc.paths[`${template}/commands/campaign/operation_campaign_create_draft`], undefined);
    async function token(access, tools) {
      const { payload } = await s.request(`${root}/tokens`, { method: 'POST', status: 201, headers: s.sessionHeaders, body: { access, tools } });
      return { origin, auth: { bearer: payload.data.token } };
    }
    const readTools = ['workspace_brands_list', 'workspace_brand_create', 'campaign_list'];
    const limited = await token('read', readTools);
    await assert.rejects(campaigns({ cursor }, limited), onError(422, 'VALIDATION_FAILED'));
    const patPage = await campaigns({ limit: 1 }, limited);
    const secondPat = await token('read', readTools);
    await assert.rejects(campaigns({ cursor: patPage.next_cursor }, secondPat), onError(422, 'VALIDATION_FAILED'));
    const lastPatPage = await campaigns({ limit: 1, cursor: patPage.next_cursor }, limited);
    assert.deepEqual([...patPage.data, ...lastPatPage.data], current.data);
    assert.equal(lastPatPage.next_cursor, null);
    const limitedDoc = await getWorkspaceOpenApi(ws, limited);
    assert.ok(limitedDoc.paths[`${template}/brands`].get);
    assert.equal(limitedDoc.paths[`${template}/brands`].post, undefined);
    assert.equal(limitedDoc.paths[`${template}/context`], undefined);
    await assert.rejects(create('denied', limited), onError(403));
    await assert.rejects(callWorkspace('workspace_get_context', ws, limited), onError(403));
    await assert.rejects(list({ status: 'active', cursor: page.next_cursor }, limited), onError(422));
    const tokenPage = await list({ status: 'active', limit: 1 }, limited);
    assert.equal((await list({ status: 'active', cursor: tokenPage.next_cursor }, limited)).next_cursor, null);
    await assert.rejects(getWorkspaceOpenApi(other.workspaceId, limited), onError(404));
    await assert.rejects(callWorkspace('workspace_brands_list', other.workspaceId, limited), onError(404));
    await assert.rejects(callWorkspace('workspace_brand_get', ws, { ...options, params: { id: other.brandId } }), onError(404));
    await assert.rejects(callWorkspace('workspace_get_context', ws, { ...options, query: { brand_id: other.brandId } }), onError(404));
    const writer = await token('write', ['workspace_brand_create']);
    assert.equal((await create('pat-created', writer)).data.slug, 'pat-created');
    await assert.rejects(list({}, writer), onError(403));
  });
}
