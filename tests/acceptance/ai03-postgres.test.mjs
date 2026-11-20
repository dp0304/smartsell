import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';
import { postgresStore } from '../../packages/db/src/index.ts';
import { configuration } from '../../apps/server/src/config.ts';

const operationsDatabase = process.env.SMARTSELL_AI03_OPERATIONS_PG_URL;
const commandsDatabase = process.env.SMARTSELL_AI03_COMMANDS_PG_URL;
const password = 'acceptance-only-ai03-password';
const viewerEmail = 'ai03-viewer@example.invalid';
const setupCommand = 'Run bash tests/acceptance/ai03-postgres.sh';
const workspacePath = id => `/api/v1/workspaces/${id}`;
const previewPath = brand => `/brands/${brand.id}/agent-context`;
const searchPath = (q, options) => `/search?${new URLSearchParams({ q, ...options })}`;
const expectedSearch = entry => [[entry.brand.id, entry.id, entry.revision.id, 1, entry.revision.body.slice(0, 300)]];
const searchRows = ({ items }) => items.map(hit => [hit.brand_id, hit.resource_id, hit.revision_id, hit.revision_no, hit.excerpt]);
const toolErrorCode = result => result.structuredContent.error?.code ?? result.structuredContent.data?.code;
const previewRows = ({ items }) => items.map(item => [item.revision_id, item.revision_no, item.body]);

async function fixture(t, database, name, start) {
  const url = new URL(database);
  assert.equal(url.protocol, 'postgresql:');
  assert.equal(url.hostname, '127.0.0.1');
  assert.equal(url.username, 'app_rw');
  assert.equal(url.pathname, `/ai03_${name}`);
  const setupToken = randomBytes(32).toString('hex');
  const config = configuration({ DATABASE_URL: database, HOST: '127.0.0.1', ROLE: 'api,mcp', SETUP_TOKEN: setupToken,
    IDENTITY_ENCRYPTION_KEY: randomBytes(32).toString('hex') });
  const app = await start({ ...config, port: 0 });
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { method = 'GET', body, headers, status = 200 } = {}) {
    const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(10_000),
      headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const raw = await response.text();
    const value = raw ? JSON.parse(raw) : undefined;
    if (status !== null) assert.equal(response.status, status, `${method} ${path} (${value?.error?.code ?? value?.code ?? 'HTTP'})`);
    return { value, status: response.status, headers: response.headers };
  }
  const session = ({ headers, value }) => ({ cookie: headers.get('set-cookie').split(';')[0], 'x-csrf-token': value.data.csrf_token });
  await request('/readyz');
  const setup = await request('/api/v1/setup', { method: 'POST', status: 201, headers: { 'x-setup-token': setupToken },
    body: { email: 'ai03-owner@example.invalid', password, name: 'Owner', workspaceName: 'AI03' } });
  const { user, workspaces: [{ id: workspace }] } = setup.value.data;
  const owner = session(setup);
  const data = async (path, options) => (await request(workspacePath(workspace) + path, { headers: owner, ...options })).value?.data;
  return { request, data, user, workspace, owner, session };
}

const postInWorkspace = (s, workspace) => async (path, body, version) => (await s.request(workspacePath(workspace) + path, { method: 'POST', body,
    headers: { ...s.owner, ...(version === undefined ? {} : { 'if-match': String(version) }) } })).value.data;

async function createKnowledge(s, marker, workspace = s.workspace) {
  const write = postInWorkspace(s, workspace);
  const brand = await write('/brands', { name: `AI03 ${marker}`, slug: `ai03-${marker}` });
  const entry = await write('/knowledge', { brand_id: brand.id, kind: 'tone', title: 'Shared positioning', body: `Approved content ${marker}published` });
  const revision = entry.knowledge_revision;
  const approved = await write(`/knowledge-revisions/${revision.id}/approve`, {}, revision.version);
  await write(`/knowledge/${entry.id}/revisions`, { body: `Proposed content ${marker}draft` }, approved.version);
  const store = await write('/stores', { brand_id: brand.id, provider: 'shopify', name: `AI03 ${marker} store`, default_currency: 'USD', default_locale: 'en-US' });
  const product = await write('/products', { store_id: store.id, title: `AI03 ${marker} product` });
  const fact = await write(`/products/${product.id}/facts`, { category: 'spec', fact_key: 'ai03-material', value: `Approved ${marker} specification` });
  const factRevision = await write(`/fact-revisions/${fact.current_revision_id}/approve`, {});
  const revisedFact = await s.request(workspacePath(workspace) + `/products/${product.id}/facts`, { headers: s.owner });
  const draft = await write(`/facts/${fact.id}/revisions`, { value: `Proposed ${marker} specification` }, revisedFact.value.data[0].version);
  return { id: entry.id, brand, revision, product, factRevision, draftFactId: draft.current_revision_id };
}

async function provisionOperationsFixture(database, { user, workspace }) {
  const store = await postgresStore(database);
  const viewer = randomUUID();
  const other = randomUUID();
  try {
    await store.transaction({ identityWrite: true }, async tx => {
      const { identity } = tx;
      const { tenantId } = identity.get(`workspace/${workspace}`);
      const { passwordHash } = identity.get(`user/${user.id}`);
      identity.put(`user/${viewer}`, { id: viewer, email: viewerEmail, name: 'Viewer', passwordHash });
      identity.put(`email/${viewerEmail}`, viewer);
      identity.put(`workspace/${other}`, { id: other, tenantId, name: 'AI03 other workspace' });
      for (const [actor, workspaceId, role] of [[viewer, workspace, 'viewer'], [viewer, other, 'viewer'], [user.id, other, 'owner']]) {
        identity.put(`member/${actor}/${workspaceId}`, { userId: actor, workspaceId, role });
      }
      const records = await tx.workspace({ tenantId, workspaceId: other, actorId: user.id });
      const now = new Date().toISOString();
      records.put(`row/workspace/${other}`, { id: other, name: 'AI03 other workspace', version: 1, created_at: now, updated_at: now });
    });
  } finally {
    await store.close();
  }
  return { viewer, other };
}

test('AI03 Operations PostgreSQL restricts the same PAT across search, resources and preview',
  { skip: !operationsDatabase && setupCommand, timeout: 60_000 }, async t => {
    const { startKernel } = await import('../../apps/server/src/integration/kernel-runtime.ts');
    const s = await fixture(t, operationsDatabase, 'operations', startKernel);
    const a = await createKnowledge(s, 'alpha');
    const b = await createKnowledge(s, 'beta');
    const { viewer, other } = await provisionOperationsFixture(operationsDatabase, s);
    const c = await createKnowledge(s, 'gamma', other);
    const login = await s.request('/api/v1/login', { method: 'POST', body: { email: viewerEmail, password } });
    assert.equal(login.value.data.user.id, viewer);
    const cookie = s.session(login);
    await verifyBrandPat(t, s, { a, b, c, viewer, other, cookie });
  });

async function verifyBrandPat(t, s, { a, b, c, viewer, other, cookie }) {
  const tools = ['knowledge_get_context', 'agent_preview_context', 'search_query', 'catalog_list_facts'];
  const shared = searchPath('Shared positioning', { types: 'knowledge_entry' });
  const unscoped = await s.data(shared, { headers: cookie });
  assert.equal(unscoped.total, 2);
  assert.deepEqual(new Set(unscoped.items.map(hit => hit.revision_id)), new Set([a.revision.id, b.revision.id]));
  const { value: { data: otherResults } } = await s.request(workspacePath(other) + shared, { headers: cookie });
  assert.deepEqual(searchRows(otherResults), expectedSearch(c));

  const setScope = async brand => {
    const scopes = [`brand:${brand.id}`];
    assert.deepEqual((await s.data(`/members/${viewer}/roles`, { method: 'PATCH', body: { role: 'viewer', scopes } })).scopes, scopes);
    assert.deepEqual((await s.data('/members')).find(member => member.user_id === viewer).scopes, scopes);
  };
  await setScope(a.brand);
  const { token } = await s.data('/tokens', { method: 'POST', status: 201, headers: cookie, body: { access: 'read', tools } });
  const bearer = { authorization: `Bearer ${token}` };
  const rpc = async (method, params = {}) => (await s.request('/mcp', { method: 'POST',
    headers: { ...bearer, accept: 'application/json, text/event-stream' }, body: { jsonrpc: '2.0', id: 1, method, params } })).value;
  assert.deepEqual((await rpc('resources/list')).result.resources, []);
  assert.deepEqual((await rpc('resources/templates/list')).result.resourceTemplates.map(template => template.uriTemplate),
    ['smartsell://workspaces/{workspace_id}/brands/{id}/knowledge', 'smartsell://workspaces/{workspace_id}/products/{id}/facts']);
  const readFacts = (product, workspace = s.workspace) => rpc('resources/read', { uri: `smartsell://workspaces/${workspace}/products/${product.id}/facts` });
  const read = (brand, workspace = s.workspace) => rpc('resources/read', { uri: `smartsell://workspaces/${workspace}/brands/${brand.id}/knowledge` });
  const preview = (brand, workspace = s.workspace) => rpc('tools/call', { name: 'agent_preview_context', arguments: {
    workspace_id: workspace, params: { brandId: brand.id }, query: { q: `${brand.slug.slice('ai03-'.length)}published` },
  } });

  for (const headers of [cookie, bearer]) {
    const visible = await s.data(shared, { headers });
    assert.equal(visible.total, 1);
    assert.deepEqual(searchRows(visible), expectedSearch(a));
    assert.deepEqual(searchRows(await s.data(searchPath('alphapublished'), { headers })), expectedSearch(a));
    for (const marker of ['betapublished', 'alphadraft', 'gammapublished']) {
      assert.deepEqual(await s.data(searchPath(marker), { headers }), { items: [], total: 0 });
    }
    await s.request(workspacePath(s.workspace) + searchPath('Shared positioning', { brand_id: b.brand.id }), { headers, status: 404 });
  }
  await s.request(workspacePath(other) + shared, { headers: bearer, status: 404 });
  assert.deepEqual((await rpc('tools/list')).result.tools.map(tool => tool.name).sort(), tools.toSorted());
  const mcpSearch = (q, workspace = s.workspace, brand_id) => rpc('tools/call', { name: 'search_query', arguments: {
    workspace_id: workspace, query: { q, types: 'knowledge_entry', ...(brand_id && { brand_id }) },
  } });
  assert.deepEqual(searchRows((await mcpSearch('Shared positioning')).result.structuredContent.data), expectedSearch(a));
  for (const marker of ['betapublished', 'alphadraft', 'gammapublished']) {
    assert.deepEqual((await mcpSearch(marker)).result.structuredContent.data, { items: [], total: 0 });
  }
  assert.equal(toolErrorCode((await mcpSearch('Shared positioning', s.workspace, b.brand.id)).result), 'NOT_FOUND');
  assert.equal(toolErrorCode((await mcpSearch('Shared positioning', other)).result), 'NOT_FOUND');

  const visible = await s.data(`${previewPath(a.brand)}?q=alphapublished`, { headers: cookie });
  assert.deepEqual(previewRows(visible), [[a.revision.id, 1, a.revision.body]]);
  assert.deepEqual((await s.data(`${previewPath(a.brand)}?q=alphadraft`, { headers: cookie })).items, []);
  assert.deepEqual((await preview(a.brand)).result.structuredContent.data, visible);
  await s.request(workspacePath(s.workspace) + previewPath(b.brand), { headers: cookie, status: 404 });
  await s.request(workspacePath(s.workspace) + previewPath(a.brand), { headers: bearer, status: 403 });
  const knowledge = JSON.parse((await read(a.brand)).result.contents[0].text).data;
  assert.deepEqual(knowledge.items, visible.items);
  const facts = JSON.parse((await readFacts(a.product)).result.contents[0].text);
  assert.deepEqual(facts.data.map(row => row.approved_revision), [a.factRevision]);
  assert.equal(JSON.stringify(facts).includes('Proposed alpha specification'), false);
  assert.equal(JSON.stringify(facts).includes(a.draftFactId), false);
  const mcpFacts = await rpc('tools/call', { name: 'catalog_list_facts', arguments: { workspace_id: s.workspace, params: { id: a.product.id } } });
  assert.deepEqual(mcpFacts.result.structuredContent, facts);
  assert.equal((await readFacts(b.product)).error.code, -32602);
  assert.equal((await readFacts(c.product, other)).error.code, -32602);
  const withProposed = await s.data(`/brands/${a.brand.id}/context?include_proposed=true`, { headers: bearer });
  assert.deepEqual(withProposed.items, visible.items);
  const { value: { data: otherPreview } } = await s.request(workspacePath(other) + previewPath(c.brand), { headers: cookie });
  assert.deepEqual(previewRows(otherPreview), [[c.revision.id, 1, c.revision.body]]);
  for (const [brand, workspace] of [[b.brand, s.workspace], [c.brand, other]]) {
    await s.request(`${workspacePath(workspace)}/brands/${brand.id}/context`, { headers: bearer, status: 404 });
    assert.equal((await read(brand, workspace)).error.code, -32602);
    const refused = (await preview(brand, workspace)).result;
    assert.equal(refused.isError, true);
    assert.equal(toolErrorCode(refused), 'NOT_FOUND');
  }

  await setScope(b.brand);
  assert.deepEqual(searchRows(await s.data(shared, { headers: bearer })), expectedSearch(b));
  assert.deepEqual(searchRows((await mcpSearch('Shared positioning')).result.structuredContent.data), expectedSearch(b));
  assert.equal((await read(a.brand)).error.code, -32602);
  assert.equal((await readFacts(a.product)).error.code, -32602);
  assert.equal(toolErrorCode((await preview(a.brand)).result), 'NOT_FOUND');
  assert.deepEqual(previewRows((await preview(b.brand)).result.structuredContent.data), [[b.revision.id, 1, b.revision.body]]);
  assert.deepEqual(JSON.parse((await readFacts(b.product)).result.contents[0].text).data.map(row => row.approved_revision), [b.factRevision]);
  assert.deepEqual(previewRows(JSON.parse((await read(b.brand)).result.contents[0].text).data), [[b.revision.id, 1, b.revision.body]]);
  t.diagnostic('The same PAT followed the live brand role change from A to B. A session with membership in both workspaces reached the second fixture, while that PAT stayed bound to its issuing workspace.');
}

test('AI03 default Commands PostgreSQL restricts and refreshes the same PAT across search, resources and preview',
  { skip: !commandsDatabase && setupCommand, timeout: 60_000 }, async t => {
    const { start } = await import('../../apps/server/src/bootstrap.ts');
    const s = await fixture(t, commandsDatabase, 'commands', start);
    const a = await createKnowledge(s, 'alpha');
    const b = await createKnowledge(s, 'beta');
    const login = await s.request('/api/v1/login', { method: 'POST', body: { email: 'ai03-owner@example.invalid', password } });
    const headers = s.session(login);
    const global = await s.data(searchPath('Shared positioning'), { headers });
    assert.equal(global.total, 2);
    assert.deepEqual(new Set(global.items.map(hit => hit.revision_id)), new Set([a.revision.id, b.revision.id]));
    const scoped = await s.data(searchPath('Shared positioning', { types: 'knowledge_entry', brand_id: a.brand.id }), { headers });
    assert.deepEqual(searchRows(scoped), expectedSearch(a));
    assert.deepEqual(await s.data(searchPath('betapublished', { brand_id: a.brand.id }), { headers }), { items: [], total: 0 });
    assert.deepEqual(await s.data(searchPath('alphadraft'), { headers }), { items: [], total: 0 });
    const preview = await s.data(previewPath(a.brand), { headers });
    assert.deepEqual(previewRows(preview), [[a.revision.id, 1, a.revision.body]]);

    const invitation = await s.data('/members/invite', { method: 'POST', body: { email: viewerEmail, role: 'viewer' } });
    await s.request('/api/v1/member-invitations/accept', { method: 'POST', status: 204,
      body: { token: invitation.invitation_token, email: viewerEmail, password, name: 'Viewer' } });
    const viewerLogin = await s.request('/api/v1/login', { method: 'POST', body: { email: viewerEmail, password } });
    const viewer = viewerLogin.value.data.user.id;
    const cookie = s.session(viewerLogin);
    const other = await provisionCommandsWorkspace(s, viewer);
    const c = await createKnowledge(s, 'gamma', other);
    await verifyBrandPat(t, s, { a, b, c, viewer, other, cookie });

    const role = brand => ({ method: 'PATCH', body: { role: 'viewer', scopes: [`brand:${brand.id}`] } });
    await s.data(`/members/${viewer}/roles`, { ...role(c.brand), status: 404 });
    await s.data('/records/asset/knowledge_revision', { headers: cookie, status: 403 });
    await s.data('/knowledge', { headers: cookie, status: 403 });
    const { id, token } = await s.data('/tokens', { method: 'POST', status: 201, headers: cookie, body: { access: 'read', tools: ['search_query'] } });
    const authorization = `Bearer ${token}`;
    await s.data(`/brands/${b.brand.id}/context`, { headers: { authorization }, status: 403 });
    const { value } = await s.request('/mcp', { method: 'POST', headers: { authorization, accept: 'application/json, text/event-stream' },
      body: { jsonrpc: '2.0', id: 1, method: 'resources/templates/list' } });
    assert.deepEqual(value.result.resourceTemplates, []);
    await s.data(`/tokens/${id}`, { method: 'DELETE', headers: cookie, status: 204 });
    await s.data(searchPath('Shared positioning'), { headers: { authorization }, status: 401 });
  });

async function provisionCommandsWorkspace(s, viewer) {
  const database = new URL(process.env.SMARTSELL_AI03_COMMANDS_FIXTURE_URL);
  const request = new URL(commandsDatabase);
  assert.equal(database.origin, request.origin);
  assert.equal(database.host, request.host);
  assert.equal(database.pathname, request.pathname);
  assert.equal(database.username, 'app_owner');
  const { Client } = createRequire(new URL('../../packages/db/package.json', import.meta.url))('pg');
  const db = new Client({ connectionString: database.href });
  await db.connect();
  try {
    const { rows: [{ id }] } = await db.query(`WITH created AS (
      INSERT INTO ss.workspaces (tenant_id, name)
      SELECT tenant_id, 'AI03 other workspace' FROM ss.workspaces WHERE id = $1 RETURNING id
    ), members AS (
      INSERT INTO ss.memberships (workspace_id, user_id, role)
      SELECT id, $2::uuid, 'owner' FROM created UNION ALL SELECT id, $3::uuid, 'viewer' FROM created
    ) SELECT id FROM created`, [s.workspace, s.user.id, viewer]);
    return id;
  } finally {
    await db.end();
  }
}
