import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from '../../apps/server/src/config.ts';
import { commerceRequestScope } from '../../apps/server/src/integration/commerce-providers.ts';
import { discoverOperations } from '../../apps/server/src/operations.ts';
import { createServer } from '../../apps/server/src/server.ts';
import { fileStore } from '../../packages/db/src/index.ts';

async function until(check) {
  const deadline = Date.now() + 8_000;
  for (;;) {
    try { return await check(); }
    catch (error) { if (Date.now() >= deadline) throw error; }
    await delay(50);
  }
}

test('PC01 TikTok Shop completes an authorized paginated snapshot without retiring unseen products', { timeout: 40_000 }, async t => {
  const provider = 'tiktok_shop';
  const key = 'SMARTSELL_COMMERCE_PROVIDER_CREDENTIALS';
  const previous = process.env[key];
  process.env[key] = JSON.stringify({ [provider]: { clientId: 'fixture-key', clientSecret: 'fixture-secret',
    tiktokShopAuthorizationUrl: 'https://services.tiktokshop.com/open/authorize?service_id=fixture' } });
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-pc01-tiktok-'));
  const store = await fileStore(join(dir, 'state.json'));
  const calls = [];
  const wrongBindings = [];
  const secondPage = 'page+2/=';
  let mode = 'detail-failure';
  let releasePage;
  let releaseDetail;
  const remote = createHttpServer(async (request, reply) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (data, status = 200) => reply.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ code: 0, data }));
    if (url.pathname === '/api/v2/token/get') {
      const code = url.searchParams.get('auth_code');
      return send({ access_token: code, expires_in: 3600, scope: code === 'no-products' ? 'seller.order.info' : 'seller.product.info' });
    }
    const token = request.headers['x-tts-access-token'];
    if (url.pathname === '/authorization/202309/shops') {
      return send({ shops: [{ id: 'other-shop', cipher: 'other-cipher' }, { id: 'same-shop', cipher: `cipher-${token}` }] });
    }
    if (!['original', 'rebound', 'rotated'].includes(token) || url.searchParams.get('shop_cipher') !== `cipher-${token}` || !url.searchParams.get('sign')) {
      wrongBindings.push(url.pathname);
      return send({}, 403);
    }
    if (url.pathname.endsWith('/search')) {
      const cursor = url.searchParams.get('page_token');
      const scenario = mode;
      calls.push({ token, cursor });
      if (cursor && scenario === 'late') {
        await new Promise(resolve => { releasePage = resolve; });
        return send({ products: [{ id: 'late' }], next_page_token: '' });
      }
      if (scenario === 'empty-first') return send({ products: [], next_page_token: '' });
      if (scenario === 'confirmed-empty') return send({ products: [], next_page_token: '', total_count: 0 });
      if (cursor && scenario === 'empty-tail') return send({ products: [], next_page_token: '', total_count: 1 });
      if (cursor && scenario === 'changed-total') return send({ products: [{ id: 'unexpected' }], next_page_token: '', total_count: 2 });
      const single = scenario === 'single' || scenario === 'products-only';
      const id = scenario === 'products-only' ? 'p3' : cursor ? 'p2' : 'p1';
      return send({ products: [{ id }], next_page_token: cursor || single ? '' : secondPage,
        ...(!cursor && scenario !== 'empty-tail' && { total_count: single ? 1 : scenario === 'changed-total' ? 3 : 2 }) });
    }
    const id = url.pathname.split('/').at(-1);
    if (id === 'p2' && mode === 'detail-failure') {
      await new Promise(resolve => { releaseDetail = resolve; });
      return send({}, 400);
    }
    return send({ id, title: `Observed ${id}`, skus: mode === 'partial' && id === 'p1' ? [] : [{ id: `sku-${id}`, seller_sku: `SKU-${id}`,
      price: { sale_price: id === 'p1' ? '12.00' : '20.00', currency: 'USD' }, inventory: [{ quantity: 2 }, { quantity: 5 }] }] });
  });
  remote.listen(0, '127.0.0.1');
  await once(remote, 'listening');
  const transport = async request => {
    const url = new URL(request.url);
    assert.ok(['auth.tiktok-shops.com', 'open-api.tiktokglobalshop.com'].includes(url.hostname));
    const response = await fetch(`http://127.0.0.1:${remote.address().port}${url.pathname}${url.search}`, {
      method: request.method, body: request.body, headers: request.headers, redirect: 'error', signal: commerceRequestScope.getStore()?.signal,
    });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() };
  };
  const config = configuration({ SETUP_TOKEN: 'pc01-local-setup', PUBLIC_ORIGIN: 'https://smartsell.localhost' });
  const app = createServer({ config, store, ...await discoverOperations(), testCommerceTransport: transport });
  t.after(async () => {
    releasePage?.();
    releaseDetail?.();
    await app.close();
    await new Promise(resolve => remote.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  async function request(method, path, body, status = 200, headers = {}) {
    const response = await fetch(origin + path, { method, body: body === undefined ? undefined : JSON.stringify(body),
      headers: { Origin: config.origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, redirect: 'error' });
    const raw = await response.text();
    assert.equal(response.status, status, `${method} ${path.split('?')[0]}: ${raw}`);
    return { data: JSON.parse(raw).data, headers: response.headers };
  }
  const setup = await request('POST', '/api/v1/setup', { name: 'Owner', workspaceName: 'PC01 TikTok Shop',
    email: 'pc01-tiktok@example.invalid', password: 'acceptance-only-password' }, 201, { 'x-setup-token': config.setupToken });
  const prefix = `/api/v1/workspaces/${setup.data.workspaces[0].id}`;
  const call = async (method, path, body, status, headers) => (await request(method, prefix + path, body, status, {
    cookie: setup.headers.get('set-cookie').split(';')[0], 'x-csrf-token': setup.data.csrf_token,
    'idempotency-key': randomUUID(), ...headers,
  })).data;
  const get = path => call('GET', path);
  const post = (path, body, status) => call('POST', path, body, status);
  const brand = await post('/brands', { name: 'PC01', slug: 'pc01-tiktok' });
  const platformApp = await post('/platform-apps', { provider, scope_version: '202309' });
  await call('PATCH', `/platform-apps/${platformApp.id}`, { status: 'active', scope_version: '202309' }, 200, { 'if-match': String(platformApp.version) });
  const shop = await post('/stores', { brand_id: brand.id, provider, name: 'Same shop', external_store_id: 'same-shop',
    default_currency: 'USD', default_locale: 'en-US', sync_scope: { products: true, inventory: true } });
  const shopPath = `/stores/${shop.id}`;
  const market = await post(`/brands/${brand.id}/markets`, { name: 'US', locale: 'en-US', currency: 'USD', timezone: 'UTC',
    country_code: 'US', primary_language: 'en' });
  const marketKey = { market_id: market.id, channel: 'tiktok_shop' };
  await call('PUT', `${shopPath}/markets`, { ...marketKey, price_source: 'store_base_price' });
  const batch = await post(`${shopPath}/imports`, { csv: 'external_product_id,external_variant_id,title,sku\np1,sku-p1,Imported cup,SKU-p1\nmissing,sku-missing,Imported only,SKU-missing' });
  await post(`/imports/${batch.id}/confirm`, {});
  const products = () => get(`/products?store_id=${shop.id}`);
  const original = (await products()).find(row => row.external_product_id === 'p1');
  const { variants: [sku] } = await get(`/products/${original.id}`);
  const listing = await post(`/variants/${sku.id}/listings`, { ...marketKey, price_amount_minor: 1000, currency: 'USD' });
  const { variants: [copy] } = await post('/content-items', { brand_id: brand.id, title: 'PC01 original content', variants: [{
    platform: 'facebook', format: 'text', locale: 'en', body: 'The original cup costs $10.00.', product_refs: [{
      variant_id: sku.id, listing_snapshot_id: listing.id, market_id: market.id, currency: 'USD', field: 'price', inserted_text: '$10.00',
    }],
  }] });
  const { revision } = await post(`/content-variants/${copy.id}/revisions`, { expected_version: copy.version, base_revision_id: null });
  const oldRevision = await get(`/content-revisions/${revision.id}`);
  const usagePath = `/products/${original.id}/usage`;
  const oldUsage = (await get(usagePath)).references;
  assert.ok(oldUsage.some(ref => ref.revision_id === revision.id));

  const grant = { provider, brand_id: brand.id, platform_app_id: platformApp.id, scopes: ['seller.product.info'] };
  async function finishGrant(authorizeUrl, code) {
    const state = new URL(authorizeUrl).searchParams.get('state');
    const { data } = await request('GET', `/api/v1/oauth/callback/${provider}?${new URLSearchParams({ state, code })}`);
    assert.equal(data.status, 'authorized');
  }
  async function authorize(code) {
    const { authorize_url } = await post('/connections/oauth/start', grant);
    await finishGrant(authorize_url, code);
    const [connection] = (await get('/connections')).filter(row => !knownConnections.has(row.id));
    assert.deepEqual(connection.scopes, [code === 'no-products' ? 'seller.order.info' : 'seller.product.info']);
    knownConnections.add(connection.id);
    await post(`${shopPath}/connect`, { connection_id: connection.id, external_store_id: 'same-shop' });
    return post('/data-sources', { kind: 'store', name: `Fixture ${code}`, provider, store_id: shop.id, connection_id: connection.id, resources: ['products'] });
  }
  const knownConnections = new Set();
  const source = await authorize('original');
  const start = () => post(`${shopPath}/sync`, { mode: 'full', resource: 'products' }, 202);
  const run = id => get(`/sync-runs/${id}`);
  const setInventory = async inventory => {
    const current = await get(shopPath);
    await call('PATCH', shopPath, { sync_scope: { inventory } }, 200, { 'if-match': String(current.version) });
  };
  const waitFor = (id, status) => until(async () => {
    const row = await run(id);
    assert.equal(row.status, status);
    return row;
  });
  const pending = async () => {
    const state = await get(shopPath);
    assert.equal(state.initial_snapshot_pending, true);
    assert.equal(state.last_snapshot_at, null);
  };

  const first = await start();
  await until(() => assert.equal(typeof releaseDetail, 'function'));
  const collecting = await run(first.sync_run_id);
  assert.equal(collecting.cursor_after, secondPage);
  assert.equal(collecting.status, 'running');
  await pending();
  releaseDetail();
  const failed = await waitFor(first.sync_run_id, 'failed');
  assert.equal(failed.error_reason, 'provider_request_failed');
  assert.equal(failed.cursor_after, secondPage);
  assert.equal((await get(`/operations/${first.operation_id}`)).status, 'failed');
  await pending();
  mode = 'good';
  await post(`/sync-runs/${first.sync_run_id}/retry`, {});
  const completed = await waitFor(first.sync_run_id, 'succeeded');
  assert.equal(completed.attempt, 2);
  assert.equal(completed.cursor_after, null);
  assert.deepEqual(calls.map(call => call.cursor), [null, secondPage, secondPage]);
  assert.equal((await get(`/operations/${first.operation_id}`)).status, 'succeeded');
  const active = await get(shopPath);
  assert.equal(active.status, 'active');
  assert.equal(active.initial_snapshot_pending, false);
  assert.ok(active.last_snapshot_at);
  const upgraded = await get(`/products/${original.id}`);
  assert.equal(upgraded.title, 'Observed p1');
  assert.equal(upgraded.variants[0].id, sku.id);
  assert.equal(upgraded.listings[0].inventory_quantity, 7);
  assert.equal(upgraded.listings[0].price_amount_minor, 1200);
  assert.ok((await get(`/variants/${sku.id}/listings`)).some(row => row.id === listing.id));
  const secondProduct = (await products()).find(row => row.external_product_id === 'p2');
  assert.equal((await get(`/products/${secondProduct.id}`)).listings[0].inventory_quantity, 7);

  mode = 'late';
  const late = await start();
  await until(() => assert.equal(typeof releasePage, 'function'));
  const newSource = await authorize('rebound');
  assert.notEqual(newSource.id, source.id);
  assert.equal((await get(shopPath)).data_source.id, newSource.id);
  await pending();
  releasePage();
  await waitFor(late.sync_run_id, 'failed');
  await post(`/sync-runs/${late.sync_run_id}/retry`, {}, 409);
  assert.ok(!(await products()).some(row => row.external_product_id === 'late'));
  await pending();

  // Returning to the original scope still invalidates a request issued before the edit.
  mode = 'late';
  releasePage = undefined;
  const staleScope = await start();
  await until(() => assert.equal(typeof releasePage, 'function'));
  const gapsBeforeScopeChange = await get(`/data-gaps?data_source_id=${newSource.id}`);
  for (const inventory of [false, true]) await setInventory(inventory);
  assert.equal((await get(shopPath)).catalog_snapshot_run_id, null);
  assert.equal((await get('/stores')).find(row => row.id === shop.id).catalog_snapshot_run_id, null);
  releasePage();
  await waitFor(staleScope.sync_run_id, 'failed');
  await post(`/sync-runs/${staleScope.sync_run_id}/retry`, {}, 409);
  assert.deepEqual(await get(`/data-gaps?data_source_id=${newSource.id}`), gapsBeforeScopeChange);
  assert.ok(!(await products()).some(row => row.external_product_id === 'late'));
  await pending();

  mode = 'empty-first';
  const empty = await start();
  assert.equal((await waitFor(empty.sync_run_id, 'failed')).error_reason, 'provider_page_rejected');
  await pending();
  mode = 'empty-tail';
  const tail = await start();
  assert.equal((await waitFor(tail.sync_run_id, 'failed')).cursor_after, secondPage);
  await pending();
  await post(`/sync-runs/${empty.sync_run_id}/retry`, {}, 409);
  mode = 'changed-total';
  const inconsistent = await start();
  assert.equal((await waitFor(inconsistent.sync_run_id, 'failed')).error_reason, 'provider_page_rejected');
  assert.ok(!(await products()).some(row => row.external_product_id === 'unexpected'));
  await pending();
  mode = 'partial';
  const partial = await start();
  await waitFor(partial.sync_run_id, 'partially_succeeded');
  await pending();
  mode = 'single';
  const retry = await post(`/sync-runs/${partial.sync_run_id}/retry`, {});
  assert.equal(retry.cursor_after, null);
  assert.equal(retry.checkpoint_index, 0);
  await waitFor(partial.sync_run_id, 'succeeded');
  await post(`/sync-runs/${tail.sync_run_id}/retry`, {}, 409);
  assert.equal((await get(shopPath)).initial_snapshot_pending, false);
  assert.equal((await get(shopPath)).catalog_snapshot_run_id, partial.sync_run_id);

  mode = 'confirmed-empty';
  const confirmedEmpty = await start();
  await waitFor(confirmedEmpty.sync_run_id, 'succeeded');
  assert.deepEqual((await products()).map(row => [row.external_product_id, row.status]).sort(), [['missing', 'active'], ['p1', 'active'], ['p2', 'active']]);
  assert.equal((await get(`/products/${original.id}`)).listings[0].inventory_quantity, 7);
  assert.deepEqual(await get(`/content-revisions/${revision.id}`), oldRevision);
  assert.deepEqual((await get(usagePath)).references, oldUsage);

  // Reauthorizing the existing connection changes the grant without changing the store or source ID.
  const connectionId = (await get(shopPath)).connection_id;
  mode = 'late';
  releasePage = undefined;
  const oldGrant = await start();
  await until(() => assert.equal(typeof releasePage, 'function'));
  assert.equal((await run(oldGrant.sync_run_id)).cursor_after, secondPage);
  const reconnect = await post('/connections/oauth/start', { ...grant, reconnect_connection_id: connectionId });
  await finishGrant(reconnect.authorize_url, 'rotated');
  assert.equal((await get(shopPath)).connection_id, connectionId);
  await pending();
  const listedShop = (await get('/stores')).find(row => row.id === shop.id);
  assert.equal(listedShop.status, 'connecting');
  assert.equal(listedShop.last_snapshot_at, null);
  assert.equal(listedShop.catalog_snapshot_run_id, null);
  assert.equal((await get(shopPath)).data_source.id, newSource.id);
  mode = 'good';
  const latest = await start();
  releasePage();
  await waitFor(oldGrant.sync_run_id, 'failed');
  await post(`/sync-runs/${oldGrant.sync_run_id}/retry`, {}, 409);
  await waitFor(latest.sync_run_id, 'succeeded');
  assert.deepEqual(calls.slice(-2), [{ token: 'rotated', cursor: null }, { token: 'rotated', cursor: secondPage }]);
  assert.ok(!(await products()).some(row => row.external_product_id === 'late'));
  assert.equal((await get(shopPath)).initial_snapshot_pending, false);

  const pendingGrant = await post(`${shopPath}/connect`, { platform_app_id: platformApp.id, scopes: grant.scopes });
  await pending();
  const callsBeforeCallback = calls.length;
  const beforeCallback = await start();
  assert.equal((await waitFor(beforeCallback.sync_run_id, 'failed')).error_reason, 'source_unavailable');
  assert.equal(calls.length, callsBeforeCallback);
  await finishGrant(pendingGrant.authorize_url, 'rebound');
  assert.equal((await get(shopPath)).connection_id, connectionId);
  const afterCallback = await start();
  await waitFor(afterCallback.sync_run_id, 'succeeded');
  assert.equal((await get(shopPath)).initial_snapshot_pending, false);
  assert.deepEqual(await get(`/content-revisions/${revision.id}`), oldRevision);
  assert.deepEqual((await get(usagePath)).references, oldUsage);

  await setInventory(false);
  mode = 'products-only';
  const productsOnly = await start();
  await waitFor(productsOnly.sync_run_id, 'succeeded');
  assert.equal((await get(shopPath)).initial_snapshot_pending, false);
  const thirdProduct = (await products()).find(row => row.external_product_id === 'p3');
  assert.ok(thirdProduct);
  const { listings: [thirdListing] } = await get(`/products/${thirdProduct.id}`);
  assert.equal(thirdListing.price_amount_minor, 2000);
  assert.equal(thirdListing.inventory_quantity, null);
  assert.equal(thirdListing.inventory_status, 'unknown');

  await authorize('no-products');
  const callsBeforeDenied = calls.length;
  for (const inventory of [false, true]) {
    if (inventory) await setInventory(true);
    const denied = await start();
    assert.equal((await waitFor(denied.sync_run_id, 'failed')).error_reason, 'authorization_required');
    assert.equal(calls.length, callsBeforeDenied);
    await pending();
  }
  assert.deepEqual(wrongBindings, []);
});
