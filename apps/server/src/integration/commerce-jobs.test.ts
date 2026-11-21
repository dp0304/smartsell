import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as httpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { fileStore } from '@smartsell/db';
import type { Context } from '@smartsell/contracts';
import type { Transport } from '../../../../packages/adapters/src/adapter-types.ts';
import { configuration } from '../config.js';
import { makeContext } from '../context.js';
import { jobOperations } from '../modules/agent/jobs.js';
import { connectShopifyMerchant } from '../modules/account/oauth.js';
import { discoverOperations } from '../operations.js';
import { createServer } from '../server.js';
import { createCommerceProviders, commerceRequestScope } from './commerce-providers.js';
import { commerceDrain } from './commerce-jobs.js';
import { dispatchDueSyncs, qualityOperations, scanCollectionQuality, syncOperations } from '../modules/ingest/sync-operations.js';
import type { Data } from '@smartsell/contracts';

async function eventually(run: () => Promise<void>) {
  const deadline = Date.now() + 18_000;
  for (;;) {
    try { await run(); return; }
    catch (error) { if (Date.now() > deadline) throw error; }
    await setTimeout(50);
  }
}

test('formal scheduler and worker sync authorized Shopify pages over local HTTP and resume the durable cursor', { timeout: 25_000 }, async t => {
  const scope = { tenantId: randomUUID(), workspaceId: randomUUID(), actorId: randomUUID() };
  const shopDomain = 'fixture.myshopify.com';
  const previous = process.env.SMARTSELL_SHOPIFY_APPS;
  t.after(() => {
    if (previous === undefined) delete process.env.SMARTSELL_SHOPIFY_APPS;
    else process.env.SMARTSELL_SHOPIFY_APPS = previous;
  });
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-commerce-jobs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: (string | null)[] = [];
  const queries: string[] = [];
  let grantScopes = 'read_products';
  const remote = httpServer(async (req, reply) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    reply.setHeader('content-type', 'application/json');
    if (req.url === '/admin/oauth/access_token') {
      reply.end(JSON.stringify({ access_token: 'authorized-token', scope: grantScopes, expires_in: 3600 }));
      return;
    }
    const { query, variables } = JSON.parse(raw) as { query: string; variables: { after: string | null } };
    queries.push(query);
    if (query.includes('ProbeShop')) {
      reply.end(JSON.stringify({ data: { shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: shopDomain } } }));
      return;
    }
    if (req.headers['x-shopify-access-token'] !== 'authorized-token') {
      reply.statusCode = 401;
      reply.end('{}');
      return;
    }
    if (query.includes('TradeOrders')) {
      const timestamp = new Date(Date.now() - 20 * 60_000).toISOString();
      const amount = { shopMoney: { amount: '10.00', currencyCode: 'USD' } };
      const order = { id: 'gid://shopify/Order/123', createdAt: timestamp, updatedAt: timestamp, displayFinancialStatus: 'PAID',
        totalPriceSet: amount, refunds: [{ id: 'gid://shopify/Refund/1', createdAt: timestamp, updatedAt: timestamp, totalRefundedSet: amount,
          transactions: { nodes: [{ id: 'gid://shopify/OrderTransaction/1', kind: 'REFUND', status: 'SUCCESS', amountSet: amount }], pageInfo: { hasNextPage: false } } }] };
      reply.end(JSON.stringify({ data: { orders: { nodes: [order], pageInfo: { hasNextPage: false } } } }));
      return;
    }
    const after = variables.after;
    calls.push(after);
    if (after && calls.length === 2) {
      reply.statusCode = 429;
      reply.setHeader('retry-after', '1');
      reply.end('{}');
      return;
    }
    const id = after ? '2' : '1';
    reply.end(JSON.stringify({ data: { shop: { currencyCode: 'USD' }, products: { nodes: [{
      id: `gid://shopify/Product/${id}`, title: `Fixture ${id}`, variants: { nodes: [{ id: `gid://shopify/ProductVariant/${id}`, sku: `sku-${id}`, price: '10.00', inventoryQuantity: 12 }], pageInfo: { hasNextPage: false, endCursor: null } },
    }], pageInfo: { hasNextPage: !after, endCursor: after ? null : 'cursor-1' } } } }));
  });
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => remote.close(error => error ? reject(error) : resolve())));
  const address = remote.address();
  assert.ok(address && typeof address !== 'string');
  const transport: Transport = async request => {
    const url = new URL(request.url);
    assert.equal(url.hostname, shopDomain);
    const response = await fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, {
      method: request.method, headers: request.headers, body: typeof request.body === 'string' ? request.body : undefined,
      signal: commerceRequestScope.getStore()?.signal,
    });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() };
  };
  const config = { ...configuration({}), roles: new Set(['scheduler', 'worker', 'ingress'] as const) };
  const dbPath = join(dir, 'state.json');
  let store = await fileStore(dbPath);
  const transact = <T>(readOnly: boolean, run: (ctx: Context) => T | Promise<T>) => store.transaction({ readOnly }, async tx =>
    run(makeContext(await tx.workspace(scope), scope, 'owner')));
  await store.transaction({ identityWrite: true }, ({ identity }) => {
    identity.put(`tenant/${scope.tenantId}`, { id: scope.tenantId, status: 'active' });
    identity.put(`workspace/${scope.workspaceId}`, { id: scope.workspaceId, tenantId: scope.tenantId });
    identity.put(`member/${scope.actorId}/${scope.workspaceId}`, { userId: scope.actorId, workspaceId: scope.workspaceId, role: 'owner' });
  });
  const { shopId, sourceId, campaignId, brandId, appId } = await transact(false, async ctx => {
    const brand = ctx.create('brand', { name: 'Fixture' });
    const { id: appId } = ctx.create('platform_app', { provider: 'shopify', status: 'active', distribution: 'merchant_custom', shop_domain: shopDomain });
    process.env.SMARTSELL_SHOPIFY_APPS = JSON.stringify([{ ...scope, appId, shopDomain, egressVerified: true,
      oauthScopes: ['read_products', 'read_orders'], clientId: 'fixture', clientSecret: 'fixture-secret' }]);
    const { account } = createCommerceProviders(config, transport);
    const grant = await connectShopifyMerchant(ctx, appId, brand.id, account);
    const shop = ctx.create('store', { brand_id: brand.id, provider: 'shopify', status: 'connecting', external_store_id: 'gid://shopify/Shop/1',
      connection_id: grant.id, default_currency: 'USD', default_locale: 'en', sync_scope: { products: true, orders: true, refunds: true } });
    const source = ctx.create('data_source', { provider: 'shopify', kind: 'store', status: 'active', store_id: shop.id, connection_id: grant.id, resources: ['products', 'orders', 'refunds'] });
    ctx.create('sync_schedule', { data_source_id: source.id, resource: 'products', mode: 'interval', interval_seconds: 60, next_due_at: '2020-01-01T00:00:00Z' });
    const scanContext = { ...ctx, now: new Date(Date.parse(ctx.now) + 121_000).toISOString() };
    assert.equal(scanCollectionQuality(scanContext).opened, 1);
    assert.equal(scanCollectionQuality(scanContext).opened, 0);
    const campaign = ctx.create('campaign', { status: 'active', ends_at: '2020-01-01T00:00:00Z' });
    return { shopId: shop.id, sourceId: source.id, campaignId: campaign.id, brandId: brand.id, appId };
  });
  const discovery = await discoverOperations();
  assert.deepEqual(discovery.missingModules, []);
  let server = createServer({ store, config, ...discovery, testCommerceTransport: transport });
  try {
    await eventually(() => transact(true, ctx => {
      const run = ctx.list('sync_run').find(row => row.resource === 'products');
      assert.equal(run?.status, 'rate_limited');
      assert.equal(run?.cursor_after, 'cursor-1');
      assert.equal(ctx.list('product').length, 1);
    }));
    await server.close();
    store = await fileStore(dbPath);
    server = createServer({ store, config, ...discovery, testCommerceTransport: transport });
    await eventually(() => transact(true, ctx => {
      const run = ctx.list('sync_run').find(row => row.resource === 'products');
      assert.equal(run?.status, 'succeeded');
      assert.equal(run?.request_count, 3);
      assert.equal(run?.cursor_after, null);
      assert.equal(ctx.list('product').length, 2);
      assert.ok(ctx.list('sync_cursor').some(row => row.resource === 'products' && row.high_watermark === run?.window_to));
      assert.equal(ctx.get('campaign', campaignId).status, 'wrapping');
      const tasks = ctx.list('work_item').filter(row => row.resource_type === 'quality_issue');
      assert.equal(tasks.length, 1);
      assert.equal(tasks[0].assignee_id, scope.actorId);
    }));
    const unauthorized = await transact(false, ctx => {
      assert.equal(ctx.get('store', shopId).connection_id, ctx.get('data_source', sourceId).connection_id);
      return ctx.create('sync_run', { data_source_id: sourceId, resource: 'orders', run_type: 'refresh', status: 'queued', attempt: 1,
        checkpoint_index: 0, window_from: new Date(Date.now() - 3600_000).toISOString(), window_to: ctx.now });
    });
    await eventually(() => transact(true, ctx => {
      const run = ctx.get('sync_run', unauthorized.id);
      assert.equal(run.status, 'failed');
      assert.equal(run.error_reason, 'authorization_required');
      assert.equal(run.fallback, 'file_import');
      assert.equal(run.request_count, 0);
    }));
    grantScopes = 'read_products,read_orders';
    const authorized = await transact(false, async ctx => {
      const { account } = createCommerceProviders(config, transport);
      await connectShopifyMerchant(ctx, appId, brandId, account);
      return ctx.create('sync_run', { data_source_id: sourceId, resource: 'refunds', run_type: 'refresh', status: 'queued', attempt: 1,
        checkpoint_index: 0, window_from: new Date(Date.now() - 3600_000).toISOString(), window_to: ctx.now });
    });
    await eventually(() => transact(true, ctx => {
      assert.equal(ctx.get('sync_run', authorized.id).status, 'succeeded');
      assert.equal(ctx.list('order')[0]?.external_order_id, 'gid://shopify/Order/123');
      assert.equal(ctx.list('refund')[0]?.status, 'succeeded');
      assert.equal(ctx.list('refund')[0]?.amount_minor, 1000);
    }));
    assert.deepEqual(calls, [null, 'cursor-1', 'cursor-1']);
    assert.ok(queries.every(query => !query.includes('inventoryQuantity')));
    const raw = '{"id":1}';
    const headers = { 'content-type': 'application/json', 'x-shopify-shop-domain': shopDomain, 'x-shopify-topic': 'products/update',
      'x-shopify-event-id': 'fixture-webhook', 'x-shopify-hmac-sha256': createHmac('sha256', 'fixture-secret').update(raw).digest('base64') };
    const url = `/api/v1/webhooks/commerce/shopify/${appId}`;
    assert.equal((await server.inject({ method: 'POST', url, headers, payload: '{"id":2}' })).statusCode, 401);
    assert.deepEqual((await server.inject({ method: 'POST', url, headers, payload: raw })).json(), { accepted: 1 });
    assert.deepEqual((await server.inject({ method: 'POST', url, headers, payload: raw })).json(), { duplicate: true });
    await eventually(() => transact(true, ctx => {
      const hinted = ctx.list('sync_run').filter(row => row.run_type === 'webhook_triggered');
      assert.equal(hinted.length, 1);
      assert.equal(hinted[0].status, 'succeeded');
    }));
  } finally { await server.close(); }
});

test('Shopee worker binds operator grants and checkpoints a non-authoritative catalog', async t => {
  const name = 'SMARTSELL_SHOPEE_CATALOG_GRANTS';
  const previous = process.env[name];
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  const scope = { tenantId: randomUUID(), workspaceId: randomUUID(), actorId: randomUUID() };
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-shopee-jobs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = await fileStore(join(dir, 'state.json'));
  const transact = <T>(run: (ctx: Context) => T | Promise<T>) => db.transaction({}, async tx =>
    run(makeContext(await tx.workspace(scope), scope, 'owner')));
  const shopId = '123456';
  const { connectionId, storeId, sourceId, unseenId } = await transact(ctx => {
    const brand = ctx.create('brand', { name: 'Fixture' });
    const connection = ctx.create('connection', { provider: 'shopee', purpose: 'store', brand_id: brand.id,
      status: 'active', discovered_accounts: [{ externalAccountId: shopId }] });
    const store = ctx.create('store', { provider: 'shopee', brand_id: brand.id, status: 'connecting', connection_id: connection.id,
      external_store_id: shopId, default_currency: 'SGD', default_locale: 'en', sync_scope: { products: true, orders: true, refunds: true } });
    const source = ctx.create('data_source', { provider: 'shopee', kind: 'store', status: 'active', store_id: store.id,
      connection_id: connection.id, resources: ['products', 'orders', 'refunds'] });
    const unseen = ctx.create('product', { store_id: store.id, external_product_id: '999', status: 'active', source: { kind: 'store_sync' } });
    return { connectionId: connection.id, storeId: store.id, sourceId: source.id, unseenId: unseen.id };
  });
  const { tenantId, workspaceId } = scope;
  const grant = { tenantId, workspaceId, connectionId, storeId, sourceId, shopId, partnerId: '24', region: 'SG',
    partnerKey: 'fixture-partner-key', accessToken: 'fixture-shop-token', expiresAt: '2099-01-01T00:00:00Z' };
  const queue = (resource = 'products', type = 'catalog_snapshot') => transact(ctx => ctx.create('sync_run', {
    data_source_id: sourceId, resource, run_type: type, status: 'queued', attempt: 1, checkpoint_index: 0,
    window_from: new Date(Date.now() - 3600_000).toISOString(), window_to: ctx.now,
  }));
  const calls: string[] = [];
  let rejectToken = false;
  t.mock.method(globalThis, 'fetch', async (input: URL, init?: RequestInit) => {
    calls.push(input.pathname);
    assert.equal(input.origin, 'https://partner.shopeemobile.com');
    assert.equal(init?.method, 'GET');
    assert.equal(init?.redirect, 'manual');
    assert.equal(input.searchParams.get('shop_id'), shopId);
    assert.equal(input.searchParams.get('access_token'), grant.accessToken);
    const signature = createHmac('sha256', grant.partnerKey).update(grant.partnerId + input.pathname +
      input.searchParams.get('timestamp') + grant.accessToken + shopId).digest('hex');
    assert.equal(input.searchParams.get('sign'), signature);
    if (rejectToken) return Response.json({ error: 'error_auth', message: grant.accessToken });
    if (input.pathname.endsWith('/get_item_list')) {
      const first = input.searchParams.get('offset') === '0';
      assert.equal(input.searchParams.get('offset'), first ? '0' : '20');
      return Response.json({ response: { has_next_page: first, next_offset: 20, item: [{ item_id: first ? 1 : 2 }] } });
    }
    const item_id = Number(input.searchParams.get('item_id_list'));
    return Response.json({ response: { item_list: [{ item_id, item_name: `Item ${item_id}`, has_model: false,
      price_info: [{ current_price: 12, currency: 'SGD' }], stock_info_v2: { summary_info: { total_available_stock: 5 } } }] } });
  });

  const expectFallback = async (drain: ReturnType<typeof commerceDrain>, id: string, reason: string, requests = 0) => {
    await drain(transact);
    const run = await transact(ctx => ctx.get('sync_run', id));
    assert.equal(run.status, 'failed');
    assert.equal(run.error_reason, reason);
    assert.equal(run.fallback, 'file_import');
    assert.equal(run.request_count, requests);
    assert.doesNotMatch(JSON.stringify(run), /fixture-shop-token|fixture-partner-key/);
  };
  for (const entries of [[], ...[
    { tenantId: randomUUID() }, { workspaceId: randomUUID() }, { connectionId: randomUUID() }, { storeId: randomUUID() },
    { sourceId: randomUUID() }, { shopId: '999' }, { expiresAt: '2000-01-01T00:00:00Z' },
  ].map(override => [{ ...grant, ...override }])]) {
    process.env[name] = JSON.stringify(entries);
    await expectFallback(commerceDrain({}), (await queue()).id, 'authorization_required');
  }
  process.env[name] = JSON.stringify([{ ...grant, url: 'https://example.invalid' }]);
  assert.throws(() => commerceDrain({}), { message: `Invalid ${name} entry` });
  process.env[name] = JSON.stringify([grant]);
  const drain = commerceDrain({});
  for (const resource of ['orders', 'refunds']) await expectFallback(drain, (await queue(resource, 'refresh')).id, 'manual_import_available');
  assert.deepEqual(calls, []);

  const snapshot = await queue();
  await drain(transact);
  assert.equal(await transact(ctx => ctx.get('sync_run', snapshot.id).cursor_after), '20');
  await commerceDrain({})(transact);
  await transact(ctx => {
    const run = ctx.get('sync_run', snapshot.id);
    assert.equal(run.status, 'partially_succeeded');
    assert.equal(run.request_count, 4);
    assert.equal(ctx.get('product', unseenId).status, 'active');
    assert.equal(ctx.list('product_variant').length, 2);
    assert.ok(ctx.list('product_variant').every(row => row.inventory_quantity == null));
  });
  rejectToken = true;
  await expectFallback(drain, (await queue()).id, 'authorization_required', 1);
});

test('worker resumes only unfinished backfill windows and blocks requests at the budget page boundary', async t => {
  const scope = { tenantId: randomUUID(), workspaceId: randomUUID(), actorId: randomUUID() };
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-backfill-jobs-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const db = await fileStore(join(dir, 'state.json'));
  const base = Date.now();
  let offset = 0;
  const at = (days: number) => new Date(base + days * 86_400_000).toISOString();
  const transact = <T>(run: (ctx: Context) => T | Promise<T>) => db.transaction({}, async tx => {
    const ctx = makeContext(await tx.workspace(scope), scope, 'owner');
    return run({ ...ctx, now: offset ? new Date(Date.now() + offset).toISOString() : ctx.now });
  });
  const shopDomain = 'fixture.myshopify.com';
  const previous = process.env.SMARTSELL_SHOPIFY_APPS;
  t.after(() => {
    if (previous === undefined) delete process.env.SMARTSELL_SHOPIFY_APPS;
    else process.env.SMARTSELL_SHOPIFY_APPS = previous;
  });
  const filters: { filter: string; after: string | null }[] = [];
  let interrupted = true;
  let onPage: (() => Promise<void>) | undefined;
  const transport: Transport = async request => {
    const reply = (body: unknown, status = 200) => ({ status, headers: {}, body });
    const url = new URL(request.url);
    assert.equal(url.hostname, shopDomain);
    if (url.pathname.endsWith('/access_token')) return reply({ access_token: 'fixture-token', scope: 'read_products,read_orders', expires_in: 3600 });
    const { query, variables } = JSON.parse(String(request.body));
    if (query.includes('ProbeShop')) return reply({ data: { shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: shopDomain } } });
    filters.push(variables);
    await onPage?.();
    if (variables.after && interrupted) return reply({}, 400);
    const next = variables.filter.startsWith(`updated_at:>='${at(-11)}'`) && !variables.after;
    return reply({ data: { orders: { nodes: [], pageInfo: { hasNextPage: next, endCursor: next ? 'durable-page' : null } } } });
  };
  const config = configuration({});
  const source = await transact(async ctx => {
    const brand = ctx.create('brand', { name: 'Fixture' });
    const app = ctx.create('platform_app', { provider: 'shopify', status: 'active', distribution: 'merchant_custom', shop_domain: shopDomain });
    process.env.SMARTSELL_SHOPIFY_APPS = JSON.stringify([{ ...scope, appId: app.id, shopDomain, egressVerified: true,
      oauthScopes: ['read_products', 'read_orders'], clientId: 'fixture', clientSecret: 'fixture-secret' }]);
    const { account } = createCommerceProviders(config, transport);
    const connection = await connectShopifyMerchant(ctx, app.id, brand.id, account);
    const store = ctx.create('store', { provider: 'shopify', status: 'active', brand_id: brand.id, connection_id: connection.id,
      external_store_id: 'gid://shopify/Shop/1', default_currency: 'USD', sync_scope: { orders: true } });
    return ctx.create('data_source', { provider: 'shopify', kind: 'store', status: 'active', store_id: store.id,
      connection_id: connection.id, resources: ['orders'], history_limit: { orders: 'P30D' } });
  });
  const invoke = (name: string, body: Data = {}, params: Record<string, string> = {}) => transact(async ctx => {
    const operation = [...syncOperations, ...qualityOperations].find(row => row.name === name)!;
    return await operation.run(ctx, { body, params, query: {} }) as Data;
  });
  // Pre-existing coverage fixes the start of the first missing shard independently of the moving cutoff.
  await transact(ctx => ctx.create('coverage_segment', { data_source_id: source.id, resource: 'orders', from: at(-29), to: at(-18), status: 'complete' }));
  const batch = await invoke('backfill_plan', { data_source_id: source.id, resources: ['orders'], from: at(-40), to: at(-1) });
  const params = { id: String(batch.id) };
  const drain = commerceDrain(createCommerceProviders(config, transport).account);
  // The small interval between the retention cutoff and -29d is a separate missing range.
  for (let page = 0; page < 5; page++) await drain(transact);
  const before = await invoke('backfill_get', {}, params);
  assert.equal(before.status, 'interrupted', JSON.stringify({ filters, runs: before.runs }));
  const runs = before.runs as Data[];
  const failed = runs.find(row => row.status === 'failed')!;
  assert.equal(failed.window_from, at(-11));
  assert.equal(failed.cursor_after, 'durable-page');
  assert.equal((before.gaps as Data[])[0].status, 'unrecoverable');
  assert.equal(runs.filter(row => row.status === 'succeeded').length, 3);

  const resumed = await invoke('backfill_resume', {}, params);
  assert.equal((resumed.runs as Data[]).find(row => row.id === failed.id)?.attempt, 2);
  assert.ok((resumed.runs as Data[]).filter(row => row.id !== failed.id).every(row => row.attempt === 1));
  await invoke('collection_budget_set', { data_source_id: source.id, cap_units: 1, on_exceed: 'pause' });
  const count = filters.length;
  await drain(transact);
  assert.equal(filters.length, count);
  assert.equal((await invoke('sync_run_get', {}, { id: String(failed.id) })).executor_status, 'budget_paused');

  await invoke('collection_budget_set', { data_source_id: source.id, cap_units: 1, on_exceed: 'reduce_frequency', fallback_interval_seconds: 60 });
  await drain(transact);
  assert.equal(filters.length, count);
  assert.equal((await invoke('sync_run_get', {}, { id: String(failed.id) })).executor_status, 'budget_throttled');
  offset = 61_000;
  interrupted = false;
  await drain(transact);
  assert.deepEqual(filters.slice(count), [filters.slice(0, count).find(row => row.after === 'durable-page')]);
  assert.equal(filters.length, count + 1);
  assert.equal(filters.at(-1)?.after, 'durable-page');
  const after = await invoke('backfill_get', {}, params);
  assert.equal(after.status, 'partial');
  assert.equal((after.progress as Data).complete, 4);
  const sync = await invoke('sync_reconcile', { resource: 'orders', from: at(-2), to: at(-1) }, { id: source.id });
  await invoke('collection_budget_set', { data_source_id: source.id, cap_units: 1_000, on_exceed: 'pause' });
  let started!: () => void;
  let release!: () => void;
  const inFlight = new Promise<void>(resolve => { started = resolve; });
  const response = new Promise<void>(resolve => { release = resolve; });
  onPage = () => { started(); return response; };
  const work = drain(transact);
  const cancellation = jobOperations.find(op => op.name === 'jobs_cancel')!;
  const operationId = String(sync.operation_id);
  try {
    await Promise.race([inFlight, work.then(() => assert.fail('Worker did not start a provider page'))]);
    await transact(async ctx => {
      const op = ctx.get('operation', operationId);
      assert.equal(op.status, 'running');
      const requested = await cancellation.run(ctx, { params: { id: operationId }, body: {}, query: {}, expectedVersion: op.version });
      assert.equal((requested as Data).status, 'cancel_requested');
    });
  } finally {
    release();
    await work;
    onPage = undefined;
  }
  await transact(ctx => {
    assert.equal(ctx.get('operation', operationId).status, 'cancelled');
    assert.equal(ctx.get('sync_run', String(sync.sync_run_id)).checkpoint_index, 0);
  });
  await invoke('collection_budget_set', { data_source_id: source.id, cap_units: 1, on_exceed: 'reduce_frequency', fallback_interval_seconds: 60 });
  await transact(ctx => {
    const schedule = ctx.create('sync_schedule', { data_source_id: source.id, resource: 'orders', mode: 'interval', interval_seconds: 60, next_due_at: at(-1) });
    ctx.update('collection_budget', ctx.list('collection_budget')[0].id, { fallback_interval_seconds: 3600 });
    assert.equal(dispatchDueSyncs(ctx).length, 1);
    assert.equal(ctx.get('sync_schedule', schedule.id).next_due_at, new Date(Date.parse(ctx.now) + 3_600_000).toISOString());
    ctx.update('collection_budget', ctx.list('collection_budget')[0].id, { on_exceed: 'pause' });
    const other = ctx.create('sync_schedule', { data_source_id: source.id, resource: 'orders', mode: 'interval', interval_seconds: 60, next_due_at: at(-1) });
    assert.deepEqual(dispatchDueSyncs(ctx), []);
    assert.equal(ctx.get('sync_schedule', other.id).next_due_at, at(-1));
  });
});
