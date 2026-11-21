import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import { test } from 'vitest';
import { createAdapter, type Adapter, type SyncCtx, type Transport } from '../src/official.ts';

const window = { from: '2026-11-15T00:00:00.000Z', to: '2026-11-16T00:00:00.000Z' };
const now = () => Date.parse('2026-11-20T00:00:00Z');
const base = { window, accessToken: 'test-token', externalAccountId: 'seller' };
const credentials = { clientId: 'test-client', clientSecret: 'test-secret' };
const privateFields = { buyer: { email: 'private@example.invalid' }, recipient: { deliveryAddress: { postalCode: 'PRIVATE ZIP' } } };

async function localHttp(handler: (url: URL, body: any, request: IncomingMessage) => unknown, run: (transport: Transport) => Promise<void>) {
  let failure: unknown;
  const server = createServer(async (request, response) => {
    try {
      const buffers = [];
      for await (const chunk of request) buffers.push(chunk);
      const source = Buffer.concat(buffers).toString();
      const result = handler(new URL(request.url ?? '/', 'http://localhost'), source ? JSON.parse(source) : undefined, request);
      response.writeHead(200, { 'content-type': 'application/json', 'x-shopify-api-version': '2026-10' });
      response.end(JSON.stringify(result));
    } catch (error) {
      failure = error;
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert(address && typeof address !== 'string');
    await run(async request => {
      const url = new URL(request.url);
      const response = await fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, {
        method: request.method, headers: request.headers, body: typeof request.body === 'string' ? request.body : undefined,
      });
      if (failure) throw failure;
      return { status: response.status, body: await response.json(), headers: Object.fromEntries(response.headers) };
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}
async function pages(adapter: Adapter, resource: string, ctx: SyncCtx, cursor: string | null = null) {
  const result = [];
  for await (const page of adapter.sync(resource, cursor, ctx)) result.push(page);
  return result;
}
const graph = (nodes: unknown[], endCursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } });
const shopMoney = (amount: string) => ({ shopMoney: { amount, currencyCode: 'USD' } });
const shopOrder = { id: 'gid://shopify/Order/1', createdAt: window.from, updatedAt: window.from, displayFinancialStatus: 'PAID', totalPriceSet: shopMoney('10.14'), ...privateFields };

test('Shopify GraphQL bounds and pagination, settled refund amount, and nested transaction pagination', async () => {
  const refund = { id: 'gid://shopify/Refund/2', createdAt: window.from, updatedAt: window.from, totalRefundedSet: shopMoney('10.14') };
  const tx = (id: string, status: string, amount: string) => ({ id, kind: 'REFUND', status, amountSet: shopMoney(amount) });
  let refundMode = false;
  await localHttp((url, body, request) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['x-shopify-access-token'], base.accessToken);
    assert.equal(url.pathname, '/admin/api/2026-10/graphql.json');
    assert.doesNotMatch(body.query, /customer|buyer|address/i);
    if (body.query.includes('query RefundTransactions')) {
      assert.deepEqual(body.variables, { id: refund.id, after: 'tx-next' });
      return { data: { refund: { id: refund.id, transactions: graph([tx('confirmed', 'SUCCESS', '3.14'), tx('declined', 'FAILURE', '6')]) } } };
    }
    assert.match(body.variables.filter, /updated_at:>/);
    assert.match(body.variables.filter, /updated_at:</);
    if (refundMode) {
      return { data: { orders: graph([{ ...shopOrder, refunds: [{ ...refund, transactions: graph([tx('awaiting', 'PENDING', '1')], 'tx-next') }] }]) } };
    }
    return { data: { orders: body.variables.after === 'orders-next' ? graph([]) : graph([shopOrder], 'orders-next') } };
  }, async transport => {
    const adapter = createAdapter('shopify', { credentials, transport, now, phase: 'P1' });
    const ctx = { ...base, shopDomain: 'recorded-shop.myshopify.com', scopes: ['read_orders'] };
    const orders = await pages(adapter, 'orders', ctx);
    assert.deepEqual(orders.map(page => page.nextCursor), ['orders-next', null]);
    assert.equal(orders[0].items[0].total_minor, 1014);
    refundMode = true;
    const [{ items: [fact] }] = await pages(adapter, 'refund_read', ctx);
    assert.equal(fact.amount_minor, 314);
    assert.equal(fact.status, 'succeeded');
    assert.doesNotMatch(JSON.stringify(fact), /private|postalCode/i);
  });
});

test('TikTok Shop sends signed read requests and only recognizes a completed return as refunded', async () => {
  const order = { id: '111', status: 'COMPLETED', create_time: 1794700800, update_time: 1794700900, paid_time: 1794700801, payment: { currency: 'JPY', total_amount: '2000' }, ...privateFields };
  const refund = { order_id: '111', return_id: '222', refund_amount: { currency: 'JPY', refund_total: '120' }, create_time: 1794700801, update_time: 1794700900, ...privateFields };
  await localHttp((url, body, request) => {
    assert.equal(request.headers['x-tts-access-token'], base.accessToken);
    assert.equal(url.searchParams.get('shop_cipher'), 'shop-cipher');
    assert.match(url.searchParams.get('sign') ?? '', /^[a-f0-9]{64}$/);
    if (url.pathname === '/order/202309/orders') {
      assert.equal(url.searchParams.get('ids'), '111');
      return { code: 0, data: { orders: [order] } };
    }
    assert.equal(request.method, 'POST');
    assert.equal(body.update_time_ge, Date.parse(window.from) / 1000);
    assert.equal(body.update_time_lt, Date.parse(window.to) / 1000);
    if (url.pathname === '/order/202309/orders/search') return { code: 0, data: { orders: [order] } };
    assert.equal(url.pathname, '/return_refund/202309/returns/search');
    const next = url.searchParams.has('page_token');
    return { code: 0, data: { return_orders: [{ ...refund, return_status: next ? 'RETURN_OR_REFUND_REQUEST_COMPLETE' : 'RETURN_OR_REFUND_REQUEST_SUCCESS' }], next_page_token: next ? '' : 'returns-next' } };
  }, async transport => {
    const adapter = createAdapter('tiktok_shop', { credentials, transport, now, phase: 'P1' });
    const ctx = { ...base, shopCipher: 'shop-cipher' };
    const [orders] = await pages(adapter, 'order_read', ctx);
    assert.equal(orders.items[0].total_minor, 2000);
    const refunds = await pages(adapter, 'refunds', ctx);
    assert.deepEqual(refunds.map(page => [page.items[0].status, page.items[0].amount_minor]), [['pending', 120], ['succeeded', 120]]);
    assert.doesNotMatch(JSON.stringify(refunds), /private|postalCode/i);
  });
});

test('Amazon SP-API uses non-restricted order fields, finance filters, and a recursive boundary whitelist', async () => {
  const order = { orderId: '111-1234567-1234567', createdTime: window.from, lastUpdatedTime: window.from, salesChannel: { marketplaceId: 'MKT' }, proceeds: { grandTotal: { amount: '19.83', currencyCode: 'USD', ...privateFields }, ...privateFields }, fulfillment: { fulfillmentStatus: 'SHIPPED', ...privateFields }, ...privateFields };
  const relatedIdentifiers = [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: order.orderId }, { relatedIdentifierName: 'REFUND_ID', relatedIdentifierValue: 'refund-1' }];
  const refund = { transactionType: 'Refund', relatedIdentifiers, postedDate: window.from, totalAmount: { currencyAmount: -8, currencyCode: 'USD' }, breakdowns: [{ breakdownType: 'Refunds', breakdownAmount: { currencyAmount: -9.83, currencyCode: 'USD' } }], ...privateFields };
  await localHttp((url, _, request) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['x-amz-access-token'], base.accessToken);
    if (url.pathname.startsWith('/orders/')) {
      assert.equal(url.searchParams.get('includedData'), 'PROCEEDS');
      if (url.pathname.endsWith(`/${order.orderId}`)) return { order };
      assert.equal(url.pathname, '/orders/2026-01-01/orders');
      assert.equal(url.searchParams.get('lastUpdatedAfter'), window.from);
      assert.equal(url.searchParams.get('lastUpdatedBefore'), window.to);
      assert.equal(url.searchParams.get('marketplaceIds'), 'MKT');
      return url.searchParams.get('paginationToken') ? { orders: [] } : { orders: [order], pagination: { nextToken: 'orders-next' } };
    }
    assert.equal(url.pathname, '/finances/2024-06-19/transactions');
    assert.equal(url.searchParams.get('postedAfter'), window.from);
    assert.equal(url.searchParams.get('postedBefore'), window.to);
    assert.equal(url.searchParams.get('relatedIdentifierName'), 'ORDER_ID');
    assert.equal(url.searchParams.get('relatedIdentifierValue'), order.orderId);
    assert.equal(url.searchParams.get('marketplaceId'), 'MKT');
    const cursor = url.searchParams.get('nextToken');
    if (cursor === 'refunds-next') return { payload: { nextToken: 'refunds-final' } };
    return { payload: cursor === 'refunds-final'
      ? { transactions: [{ ...refund, transactionStatus: 'DEFERRED_RELEASED' }] }
      : { transactions: [{ ...refund, transactionStatus: 'DEFERRED' }, { transactionType: 'Shipment', ...privateFields }], nextToken: 'refunds-next' } };
  }, async transport => {
    const adapter = createAdapter('amazon_sp', { credentials: { ...credentials, amazonRegion: 'na', amazonMarketplaceId: 'MKT' }, transport, now, phase: 'P1' });
    const orders = await pages(adapter, 'orders', base);
    assert.equal(orders[0].items[0].total_minor, 1983);
    assert.equal(orders[1].nextCursor, null);
    const refunds = await pages(adapter, 'refunds', { ...base, objectId: order.orderId });
    assert.deepEqual(refunds.map(page => page.items.map(item => [item.status, item.amount_minor])), [[['pending', 983]], [], [['succeeded', 983]]]);
    assert.deepEqual(Object.keys(refunds[0].items[0].order as object).sort(), ['currency', 'external_order_id', 'external_updated_at', 'financial_status', 'fulfillment_status', 'placed_at', 'total_minor']);
    assert.doesNotMatch(JSON.stringify({ orders, refunds }), /private|postalCode|recipient/i);
    await assert.rejects(pages(adapter, 'refunds', { ...base, window: { from: window.from, to: '2026-11-19T00:00:00Z' } }), { reason: 'amazon_finance_window_unavailable' });
  });
});

test('official catalog adapters honor disabled inventory even when the fixture sends it', async () => {
  await localHttp((url, body) => {
    if (url.pathname.includes('graphql.json')) {
      assert.doesNotMatch(body.query, /inventoryQuantity/);
      return { data: { shop: { currencyCode: 'USD' }, products: graph([{ id: 'p', variants: graph([{ id: 'v', inventoryQuantity: 10 }]) }]) } };
    }
    if (url.pathname.includes('/listings/')) {
      assert.equal(url.searchParams.get('includedData'), 'summaries,offers');
      return { items: [{ sku: 'S', fulfillmentAvailability: [{ quantity: 10 }] }] };
    }
    if (url.pathname.endsWith('/products/search')) return { code: 0, data: { products: [{ id: 'p' }], next_page_token: '', total_count: 1 } };
    assert.equal(url.pathname, '/product/202309/products/p');
    return { code: 0, data: { id: 'p', skus: [{ id: 'v', inventory: [{ quantity: 10 }] }] } };
  }, async transport => {
    const connections = {
      shopify: { shopDomain: 'recorded-shop.myshopify.com', scopes: ['read_products'] },
      tiktok_shop: { shopCipher: 'shop-cipher', scopes: ['seller.product.info'] },
      amazon_sp: {},
    };
    for (const provider of ['shopify', 'tiktok_shop', 'amazon_sp'] as const) {
      const adapter = createAdapter(provider, { credentials: { ...credentials, amazonRegion: 'na', amazonMarketplaceId: 'MKT' }, transport, now, phase: 'P1' });
      const result = await pages(adapter, 'products', { ...base, ...connections[provider], includeInventory: false });
      assert.equal(result[0].items.length, 1);
      assert.doesNotMatch(JSON.stringify(result), /inventory|fulfillmentAvailability/i);
    }
  });
});

test('Shopee and Lazada trade stays gated without an official transport', async () => {
  for (const provider of ['shopee', 'lazada'] as const) {
    const adapter = createAdapter(provider, { credentials, transport: async () => assert.fail('unexpected provider request'), now, phase: 'P2' });
    await assert.rejects(pages(adapter, 'orders', base), { reason: 'sync_capability_unavailable' });
    await assert.rejects(pages(adapter, 'refunds', base), { reason: 'sync_capability_unavailable' });
  }
});
