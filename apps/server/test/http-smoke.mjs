// Run against a freshly provisioned Operations service.
import assert from 'node:assert/strict';

const base = process.env.SMARTSELL_SMOKE_URL ?? 'http://127.0.0.1:3401';
let cookie;
let csrf;
async function request(path, { method = 'GET', body, headers = {}, status = 200, session = true } = {}) {
  const response = await fetch(`${base}${path}`, {
    method, signal: AbortSignal.timeout(8000),
    headers: {
      ...(session && cookie && { cookie, 'x-csrf-token': csrf }),
      ...(body && { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body && JSON.stringify(body),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: HTTP ${response.status}`);
  return { json: text && JSON.parse(text), headers: response.headers };
}

await request('/healthz');
await request('/readyz');
await request('/api/v1/session', { status: 401 });
const credentials = { email: 'smoke@example.invalid', password: 'fixture-local-password' };
const setup = await request('/api/v1/setup', {
  method: 'POST', status: 201, body: { ...credentials, workspace_name: 'Smoke Workspace' },
  headers: process.env.SETUP_TOKEN ? { 'x-setup-token': process.env.SETUP_TOKEN } : {},
});
const login = await request('/api/v1/login', { method: 'POST', body: credentials });
assert.notEqual(login.headers.get('set-cookie'), setup.headers.get('set-cookie'));
cookie = login.headers.get('set-cookie').split(';')[0];
csrf = login.json.data.csrf_token;
const { json: session } = await request('/api/v1/session');
const workspace = session.data.workspaces[0].id;
const prefix = `/api/v1/workspaces/${workspace}`;
const { json: catalog } = await request(`${prefix}/catalog`);
for (const module of ['workspace', 'account', 'ingest', 'commerce', 'campaign', 'intel', 'content', 'asset', 'planning', 'execution', 'inbox', 'creator', 'traffic', 'ads', 'lifecycle', 'analytics', 'agent', 'team', 'ops']) {
  assert.ok(catalog.data.some(entry => entry.module === module), module);
}
const brand = { method: 'POST', headers: { 'idempotency-key': 'smoke-brand' }, body: { name: 'Smoke Brand', slug: 'smoke-brand' } };
const first = await request(`${prefix}/brands`, brand);
const replay = await request(`${prefix}/brands`, brand);
assert.deepEqual(first.json, replay.json);
assert.equal(first.headers.get('etag'), '"1"');
const { json: listed } = await request(`${prefix}/brands`);
assert.equal(listed.data.length, 1);
assert.equal(listed.next_cursor, null);

const { json: pat } = await request(`${prefix}/tokens`, { method: 'POST', status: 201, body: { tools: ['workspace_get_context'] } });
const bearer = { authorization: `Bearer ${pat.data.token}`, accept: 'application/json, text/event-stream' };
const rpc = async (method, params) => (await request('/mcp', { method: 'POST', session: false, headers: bearer, body: { jsonrpc: '2.0', id: 1, method, params } })).json.result;
assert.equal((await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })).serverInfo.name, 'smartsell');
assert.deepEqual((await rpc('tools/list', {})).tools.map(tool => tool.name), ['workspace_get_context']);
const context = (await rpc('tools/call', { name: 'workspace_get_context', arguments: { workspace_id: workspace } })).structuredContent.data;
assert.equal(context.workspace_id, workspace);
assert.equal(context.brands[0].id, first.json.data.id);
assert.deepEqual(context, (await request(`${prefix}/context`, { headers: bearer, session: false })).json.data);
await request('/api/v1/logout', { method: 'POST', status: 204 });
await request('/api/v1/session', { status: 401 });
console.log(`Operations HTTP smoke passed (${catalog.data.length} catalog entries)`);
