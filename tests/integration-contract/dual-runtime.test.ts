import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../../apps/server/src/app.js';
import { configuration } from '../../apps/server/src/config.js';
import { localStore } from '../../apps/server/src/local.js';
import { discoverOperations } from '../../apps/server/src/operations.js';
import { registerOperationRoutes } from '../../apps/server/src/operation-server.js';
import { PostgresStore } from '../../apps/server/src/postgres.js';
import { discover } from '../../apps/server/src/registry.js';
import { createServer } from '../../apps/server/src/server.js';
import type { Store } from '../../apps/server/src/store.js';
import { fileStore } from '../../packages/db/src/index.js';

const config = configuration({ NODE_ENV: 'test', SETUP_TOKEN: 'integration-setup-token' });
const account = { email: 'owner@example.test', name: 'Owner', workspaceName: 'Contract test', password: 'example-password-1234' };
async function discoverBoth() {
  const [commands, operations] = await Promise.all([discover(), discoverOperations()]);
  assert.deepEqual(commands.missing, []);
  assert.deepEqual([...operations.loadFailures], []);
  assert.deepEqual(operations.missingModules, []);
  return { commands, operations };
}

async function exerciseDualRuntime(t: TestContext, openStore: () => Store) {
  const { commands: commandDiscovery, operations: operationDiscovery } = await discoverBoth();
  const operationApi = { config, operations: operationDiscovery.operations, register: registerOperationRoutes };
  const open = async () => {
    const store = openStore();
    try {
      const { app } = buildApp({ ...config, ...commandDiscovery, store, operationApi });
      t.after(() => app.close());
      await store.ready();
      return app;
    } catch (error) {
      await store.close();
      throw error;
    }
  };
  let app = await open();

  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/setup', payload: account })).statusCode, 403);
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { 'x-setup-token': config.setupToken! }, payload: account });
  assert.equal(setup.statusCode, 201, setup.body);
  const setupCookie = setup.cookies[0];
  const login = await app.inject({ method: 'POST', url: '/api/v1/session', cookies: { [setupCookie.name]: setupCookie.value }, payload: {
    email: account.email, password: account.password,
  } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.cookies[0];
  const cookies = { [cookie.name]: cookie.value };
  const wid = login.json().workspaces[0].id as string;
  const base = `/api/v1/workspaces/${wid}`;
  assert.equal((await app.inject(`${base}/catalog`)).statusCode, 401);
  assert.equal((await app.inject({ url: `${base}/catalog`, cookies: { [setupCookie.name]: setupCookie.value } })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/v1/workspaces/00000000-0000-0000-0000-000000000001/catalog', cookies })).statusCode, 404);
  const catalog = await app.inject({ url: `${base}/catalog`, cookies });
  assert.equal(catalog.statusCode, 200, catalog.body);
  assert.ok(catalog.json().data.some((op: { name: string }) => op.name === 'catalog_search'));
  const commands = await app.inject({ url: `${base}/commands`, cookies });
  assert.ok(commands.json().items.some((item: { action: string }) => item.action === 'catalog_search'));
  const command = await app.inject({ method: 'POST', url: `${base}/commands/commerce/catalog_search`, cookies, headers: { 'idempotency-key': 'legacy-search' }, payload: {} });
  assert.equal(command.statusCode, 200, command.body);
  const catalogPaths = new Map(catalog.json().data.map((op: { name: string; path: string }) => [op.name, op.path]));
  assert.equal(catalogPaths.get('template_list'), '/templates');
  assert.equal(catalogPaths.get('team_templates_list'), '/team/templates');
  assert.equal((await app.inject({ url: `${base}/team/templates`, cookies })).statusCode, 200);
  assert.equal(catalogPaths.has('ops_list_member'), false);
  assert.equal((await app.inject({ url: `${base}/admin/members`, cookies })).statusCode, 404);

  const csrf = await app.inject({ url: '/api/v1/session/csrf', cookies });
  assert.equal(csrf.statusCode, 200, csrf.body);
  const token = csrf.json().csrf_token as string;
  const create = async (path: string, payload: object) => {
    const result = await app.inject({ method: 'POST', url: `${base}${path}`, cookies, headers: { 'x-csrf-token': token }, payload });
    assert.equal(result.statusCode, 200, result.body);
    return result.json().data.id as string;
  };
  const brandId = await create('/brands', { name: 'Contract brand', slug: 'contract-brand' });
  const storeId = await create('/stores', { brand_id: brandId, provider: 'file_import', name: 'Contract store', default_locale: 'en', default_currency: 'USD' });
  const request = { method: 'POST' as const, url: `${base}/products`, cookies, payload: { store_id: storeId, title: 'Contract product' } };
  assert.equal((await app.inject(request)).statusCode, 403);
  const headers = { 'x-csrf-token': token, 'idempotency-key': 'operation-create-product' };
  const created = await app.inject({ ...request, headers });
  assert.equal(created.statusCode, 200, created.body);
  await app.close();
  app = await open();
  const replay = await app.inject({ ...request, headers });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().data.id, created.json().data.id);
  const products = await app.inject({ url: `${base}/products`, cookies });
  assert.equal(products.statusCode, 200, products.body);
  assert.deepEqual(products.json().data.map((product: { title: string }) => product.title), ['Contract product']);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/session', cookies })).statusCode, 204);
  assert.equal((await app.inject({ url: `${base}/products`, cookies })).statusCode, 401);
  assert.equal((await app.inject({ url: `${base}/commands`, cookies })).statusCode, 401);
}

test('Commands and Operations use the same session and persist across local store restarts', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-dual-runtime-'));
  try {
    await exerciseDualRuntime(t, () => localStore(join(dir, 'state.json')));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const postgresUrl = process.env.SMARTSELL_DUAL_RUNTIME_PG_URL;
test('Commands and Operations use the same PostgreSQL workspace and session', { skip: !postgresUrl }, async t => {
  await exerciseDualRuntime(t, () => new PostgresStore(postgresUrl!));
});

test('the preserved Operation kernel uses real sessions and scoped MCP bearer tokens', async t => {
  const { operations } = await discoverBoth();
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-integration-'));
  const store = await fileStore(join(dir, 'state.json'));
  const app = createServer({ config, store, ...operations });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { 'x-setup-token': config.setupToken! }, payload: account });
  assert.equal(setup.statusCode, 201, setup.body);
  const login = await app.inject({ method: 'POST', url: '/api/v1/login', payload: { email: account.email, password: account.password } });
  assert.equal(login.statusCode, 200, login.body);
  const cookie = login.cookies[0];
  const { workspaces, csrf_token } = login.json().data;
  const wid = workspaces[0].id;
  const cookies = { [cookie.name]: cookie.value };
  const base = `/api/v1/workspaces/${wid}`;
  const write = async (path: string, payload: object) => {
    const response = await app.inject({ method: 'POST', url: `${base}${path}`, cookies,
      headers: { 'x-csrf-token': csrf_token }, payload });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().data.id as string;
  };
  const brandId = await write('/brands', { name: 'MCP brand', slug: 'mcp-brand' });
  const storeId = await write('/stores', { brand_id: brandId, provider: 'file_import', name: 'MCP store', default_locale: 'en', default_currency: 'USD' });
  const productId = await write('/products', { store_id: storeId, title: 'MCP product' });
  const tokens = await app.inject({ method: 'POST', url: `${base}/tokens`, cookies,
    headers: { 'x-csrf-token': csrf_token }, payload: { access: 'read', tools: ['catalog_search'] },
  });
  assert.equal(tokens.statusCode, 201, tokens.body);
  const mcp = { method: 'POST' as const, url: '/mcp', payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    headers: { accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-03-26' } };
  assert.equal((await app.inject({ ...mcp, cookies })).statusCode, 401);
  const bearer = { ...mcp.headers, authorization: `Bearer ${tokens.json().data.token}` };
  const listed = await app.inject({ ...mcp, headers: bearer });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json().result.tools.map((tool: { name: string }) => tool.name), ['catalog_search']);
  const call = await app.inject({ ...mcp, headers: bearer, payload: { ...mcp.payload, method: 'tools/call', params: {
    name: 'catalog_search', arguments: { workspace_id: wid },
  } } });
  assert.equal(call.statusCode, 200, call.body);
  assert.deepEqual(call.json().result.structuredContent.data.map((product: { id: string }) => product.id), [productId]);
  const otherWorkspace = await app.inject({ ...mcp, headers: bearer, payload: { ...mcp.payload, method: 'tools/call', params: {
    name: 'catalog_search', arguments: { workspace_id: '00000000-0000-0000-0000-000000000001' },
  } } });
  assert.equal(otherWorkspace.json().result.isError, true);
  const revoke = await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${wid}/tokens/${tokens.json().data.id}`,
    cookies, headers: { 'x-csrf-token': csrf_token },
  });
  assert.equal(revoke.statusCode, 204, revoke.body);
  assert.equal((await app.inject({ ...mcp, headers: bearer })).statusCode, 401);
});
