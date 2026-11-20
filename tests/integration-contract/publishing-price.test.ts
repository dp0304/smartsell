import assert from 'node:assert/strict';
import test from 'node:test';
import type { Row } from '../../packages/contracts/src/index.ts';
import { Records } from '../../packages/db/src/index.ts';
import { normalizeCommerceCatalogPage } from '../../packages/adapters/src/catalog.ts';
import { createAdapter } from '../../packages/adapters/src/official.ts';
import { makeContext, type DomainEvent } from '../../apps/server/src/context.ts';
import { discoverOperations } from '../../apps/server/src/operations.ts';
import { recordCatalogPage, requestStoreSync } from '../../apps/server/src/modules/ingest/sync-operations.ts';

// Shopify Admin GraphQL products and ProductVariant fields, with a synthetic authorized store.
// https://shopify.dev/docs/api/admin-graphql/latest/queries/products
// https://shopify.dev/docs/api/admin-graphql/latest/objects/ProductVariant
const domain = 'fixture.myshopify.com';

test('CO04 Shopify price change checkpoints the catalog and invalidates only the current content reference', async () => {
  const records = new Records(new Map(), false);
  const ctx = makeContext(records, { tenantId: 'tenant', workspaceId: 'workspace', actorId: 'operator' }, 'owner');
  const { operations, subscribers } = await discoverOperations();
  const contentSubscriber = subscribers.find(row => row.id === 'content.upstream');
  assert.ok(contentSubscriber);
  const createContent = operations.find(op => op.name === 'content_create_draft');
  assert.ok(createContent);
  const brand = ctx.create('brand', { status: 'active' });
  const market = ctx.create('market', { brand_id: brand.id, currency: 'USD' });
  const connection = ctx.create('connection', { provider: 'shopify', status: 'active' });
  const store = ctx.create('store', { provider: 'shopify', brand_id: brand.id, default_currency: 'USD', default_locale: 'en', status: 'active', connection_id: connection.id });
  ctx.create('data_source', { kind: 'store', provider: 'shopify', resources: ['products'], store_id: store.id, connection_id: connection.id, status: 'active' });
  ctx.create('store_market', { store_id: store.id, market_id: market.id, channel: 'online_store', price_source: 'store_base_price', enabled: true });

  let price = '10.00';
  let requests = 0;
  const adapter = createAdapter('shopify', { credentials: { clientId: 'fixture', clientSecret: 'fixture' }, transport: async request => {
    requests++;
    assert.equal(request.method, 'POST');
    assert.match(request.url, /^https:\/\/fixture\.myshopify\.com\/admin\/api\/[^/]+\/graphql\.json$/);
    assert.equal(request.headers?.['x-shopify-access-token'], 'fixture-store-read-token');
    const payload = JSON.parse(String(request.body));
    assert.deepEqual(payload.variables, { after: null });
    assert.match(payload.query, /variants\(first: 20\).*?price/s);
    return { status: 200, headers: {}, body: { data: { shop: { currencyCode: 'USD' }, products: {
      pageInfo: { hasNextPage: false }, nodes: [{ id: 'gid://shopify/Product/1', title: 'Cup', handle: 'cup', status: 'ACTIVE', variants: {
        pageInfo: { hasNextPage: false }, nodes: [{ id: 'gid://shopify/ProductVariant/2', sku: 'CUP-1', price, inventoryQuantity: 10 }],
      } }],
    } } } };
  } });
  const sync = async (key: string) => {
    const run = requestStoreSync(ctx, store, 'reconcile');
    for await (const page of adapter.sync('product_read', null, { shopDomain: domain, accessToken: 'fixture-store-read-token', externalAccountId: 'gid://shopify/Shop/1', scopes: ['read_products'] })) {
      recordCatalogPage(ctx, run.sync_run_id, { index: 1, attempt: 1, requests: 1, page: normalizeCommerceCatalogPage('shopify', page), authoritative: true });
    }
    assert.equal(ctx.get('sync_run', run.sync_run_id).status, 'succeeded', key);
    return ctx.list('listing_snapshot').find(row => row.is_current)!;
  };
  const before = await sync('initial');
  assert.equal(before.price_amount_minor, 1000);
  const { variants: [variant] } = await createContent.run(ctx, { params: {}, query: {}, body: {
    brand_id: brand.id, title: 'Catalog price content', variants: [{ platform: 'facebook', format: 'text', locale: 'en', body: 'Cup costs $10.00',
      product_refs: [{ variant_id: before.variant_id, listing_snapshot_id: before.id, market_id: market.id, currency: 'USD', field: 'price', inserted_text: '$10.00' }],
    }],
  } }) as { variants: Row[] };
  const revision = ctx.get('content_revision', String(variant!.current_revision_id));
  price = '12.00';
  const after = await sync('refresh');
  assert.equal(after.price_amount_minor, 1200);
  assert.notEqual(after.id, before.id);
  assert.equal(ctx.get('listing_snapshot', before.id).is_current, false);
  assert.equal(requests, 2);
  const [change] = records.list<DomainEvent>('outbox/').filter(event => event.type === 'commerce.listing.changed');
  assert.ok(change && contentSubscriber.accepts(change.type));
  await contentSubscriber.run(ctx, change as unknown as Record<string, unknown>);
  const stale = ctx.get('content_variant', variant!.id);
  assert.equal(stale.readiness, 'stale');
  assert.equal(stale.current_revision_id, revision.id);
  assert.deepEqual(stale.stale_reasons, [{ kind: 'listing_changed', ref_id: before.id }]);
  assert.deepEqual(ctx.get('content_revision', revision.id), revision);
  await contentSubscriber.run(ctx, change as unknown as Record<string, unknown>);
  assert.equal(ctx.get('content_variant', stale.id).version, stale.version);
});
