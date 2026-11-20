import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'vitest';
import { normalizeCommerceCatalogPage } from '../src/catalog.ts';
import { createAdapter } from '../src/official.ts';
import { createPlatformAdapter } from '../src/index.ts';

const credentials = { clientId: 'key', clientSecret: 'secret' };
const now = () => 1_700_000_000_000;
const token = 'fixture-token';
const shop = { accessToken: token, externalAccountId: 'shop', shopCipher: 'cipher', scopes: ['seller.product.info'] };
const ok = (body: unknown) => ({ status: 200, body });
const success = (data: unknown) => ok({ code: 0, data });
const first = <T>(pages: AsyncIterable<T>) => pages[Symbol.asyncIterator]().next();

test('TikTok Shop signs the transmitted query and JSON body, and suppresses inventory when disabled', async () => {
  const cursor = 'p+1/=';
  const adapter = createAdapter('tiktok_shop', { credentials, now, transport: async req => {
    const url = new URL(req.url);
    assert.equal(url.origin, 'https://open-api.tiktokglobalshop.com');
    assert.equal(req.headers['x-tts-access-token'], token);
    assert.equal(url.searchParams.has('access_token'), false);
    const search = req.method === 'POST';
    const path = search ? '/product/202309/products/search' : '/product/202309/products/7483920000000000088';
    assert.equal(url.pathname, path);
    const searchParams = search ? `page_size20page_token${cursor}` : '';
    const expected = createHmac('sha256', credentials.clientSecret)
      .update(`secret${path}app_keykey${searchParams}shop_cipherciphertimestamp1700000000${search ? '{}' : ''}secret`).digest('hex');
    assert.equal(url.searchParams.get('sign'), expected);
    assert.equal(req.body, search ? '{}' : undefined);
    return search ? success({ products: [{ id: '7483920000000000088' }], next_page_token: '' })
      : success({ id: '7483920000000000088', skus: [{ id: 'sku', inventory: [{ quantity: 5 }] }] });
  } });
  const result = await first(adapter.sync('product_read', cursor, { ...shop, includeInventory: false }));
  assert.deepEqual(result.value, { items: [{ id: '7483920000000000088', skus: [{ id: 'sku' }] }], nextCursor: null });
});

test.each([
  [{ data: { products: [] } }, 'malformed_tiktok_shop_response'],
  [{ code: 0, data: { products: [null] } }, 'malformed_catalog_page'],
  [{ code: 0, data: { products: [], next_page_token: 42 } }, 'malformed_catalog_cursor'],
  [{ code: 0, data: { products: [{ id: 'p' }, { id: 'p' }] } }, 'product_identity_unverified'],
])('TikTok Shop rejects malformed search responses before fetching details (%j)', async (body, reason) => {
  let requests = 0;
  const adapter = createAdapter('tiktok_shop', { credentials, transport: async () => { requests++; return ok(body); } });
  await assert.rejects(first(adapter.sync('product_read', null, shop)), { errorClass: 'transient', reason });
  assert.equal(requests, 1);
});

test('TikTok Shop rejects duplicate SKU IDs and rejects a probe with a mismatched bound shop cipher', async () => {
  const adapter = createAdapter('tiktok_shop', { credentials, transport: async req => {
    const path = new URL(req.url).pathname;
    if (path === '/authorization/202309/shops') return success({ shops: [{ id: 'shop', cipher: 'other' }] });
    if (path.endsWith('/search')) return success({ products: [{ id: 'p' }] });
    return success({ id: 'p', skus: [{ id: 'duplicate' }, { id: 'duplicate' }] });
  } });
  assert.equal((await adapter.probe(shop)).reason, 'account_binding_mismatch');
  await assert.rejects(first(adapter.sync('product_read', null, shop)), { reason: 'variant_identity_unverified' });
});

const amazon = { ...credentials, amazonRegion: 'fe', amazonMarketplaceId: 'A1VC38T7YXB528' } as const;
const seller = { accessToken: token, externalAccountId: 'seller', sellerId: 'seller' };

test('Amazon requires a consistent seller binding before probing or listing and fails closed at the search cap', async () => {
  let requests = 0;
  const adapter = createAdapter('amazon_sp', { credentials: amazon, transport: async req => {
    requests++;
    assert.equal(new URL(req.url).hostname, 'sellingpartnerapi-fe.amazon.com');
    return ok({ items: [{ sku: 'sku' }], numberOfResults: 1000, pagination: { nextToken: 'next' } });
  } });
  const mismatch = { ...seller, sellerId: 'different' };
  assert.equal((await adapter.probe(mismatch)).reason, 'account_binding_mismatch');
  await assert.rejects(first(adapter.sync('product_read', null, mismatch)), { reason: 'account_binding_mismatch' });
  assert.equal(requests, 0);
  await assert.rejects(first(adapter.sync('product_read', null, seller)), { errorClass: 'unsupported', reason: 'amazon_listing_search_limit' });
  assert.equal(requests, 1);
});

test('Amazon normalization retains the matching consumer offer and merchant stock only', async () => {
  const adapter = createAdapter('amazon_sp', { credentials: amazon, transport: async () => ok({ numberOfResults: 1, items: [{
    sku: 'sku', summaries: [{ marketplaceId: 'OTHER', itemName: 'Other' }, { marketplaceId: amazon.amazonMarketplaceId, itemName: 'Listing' }],
    offers: [
      { marketplaceId: 'OTHER', offerType: 'B2C', price: { amount: '100', currencyCode: 'USD' } },
      { marketplaceId: amazon.amazonMarketplaceId, offerType: 'B2B', price: { amount: '900', currencyCode: 'JPY' } },
      { marketplaceId: amazon.amazonMarketplaceId, offerType: 'B2C', price: { amount: '1000', currencyCode: 'JPY' } },
    ],
    fulfillmentAvailability: [{ fulfillmentChannelCode: 'AMAZON_JP', quantity: 20 }, { fulfillmentChannelCode: 'DEFAULT', quantity: 0 }],
  }] }) });
  const result = await first(adapter.sync('product_read', null, seller));
  assert.ok(!result.done);
  assert.deepEqual(normalizeCommerceCatalogPage('amazon_sp', result.value), { nextCursor: null, items: [{ externalId: 'sku', title: 'Listing',
    variants: [{ externalId: 'sku', sku: 'sku', price: '1000', currency: 'JPY', available: 0 }] }] });
});

test('Shopify rejects usable-looking data accompanied by an invalid GraphQL error envelope', async () => {
  const adapter = createAdapter('shopify', { credentials, transport: async () => ok({ errors: [null], data: {
    products: { nodes: [], pageInfo: { hasNextPage: false } },
  } }) });
  await assert.rejects(first(adapter.sync('product_read', null, { ...shop, shopDomain: 'fixture.myshopify.com', scopes: ['read_products'] })),
    { reason: 'malformed_shopify_graphql_response' });
});

test('Shopify rejects duplicate products in a GraphQL page', async () => {
  const product = { id: 'product', variants: { nodes: [], pageInfo: { hasNextPage: false } } };
  const adapter = createAdapter('shopify', { credentials, transport: async () => ok({ data: {
    products: { nodes: [product, product], pageInfo: { hasNextPage: false } },
  } }) });
  await assert.rejects(first(adapter.sync('product_read', null, { ...shop, shopDomain: 'fixture.myshopify.com', scopes: ['read_products'] })),
    { reason: 'product_identity_unverified' });
});

test('Shopee rejects a non-advancing offset before fetching details', async () => {
  let requests = 0;
  const accountId = 'account';
  const adapter = createPlatformAdapter('shopee', async () => {
    requests++;
    return ok({ error: '', response: { item: [{ item_id: 1 }], has_next_page: true, next_offset: '020' } });
  });
  await assert.rejects(first(adapter.sync('catalog', '20', { accountId, phase: 'P1', credential: {
    accountId, accessToken: token, state: 'active', scopes: ['product'], approvals: ['shopee_erp_product_read'],
    configuration: { region: 'SG', partnerId: '100', partnerKey: 'secret', shopId: '200' },
  } })), { reason: 'malformed_catalog_cursor' });
  assert.equal(requests, 1);
});
