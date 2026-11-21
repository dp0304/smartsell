import type { AdapterOptions, ProviderKey, SyncCtx, SyncPage } from './adapter-types.ts';
import { amazonRequest, graphConnection, shopifyGraphql, signedShop } from './provider-commerce.ts';
import { AdapterError, identifier, record, requireText, rows, text, type Client } from './provider-http.ts';

type Row = Record<string, unknown>;
type Resource = 'order_read' | 'refund_read';
const malformed = (reason: string): never => { throw new AdapterError('transient', reason); };
const id = (value: unknown) => identifier(value) ?? malformed('missing_trade_identifier');
function list(value: unknown): Row[] {
  const entries = rows(value);
  if (!Array.isArray(value) || value.length !== entries.length) malformed('malformed_trade_page');
  return entries;
}
function timestamp(value: unknown): string {
  const ms = typeof value === 'number' && Number.isSafeInteger(value) ? value * 1000 : Date.parse(text(value) ?? '');
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return malformed('invalid_trade_timestamp');
  return new Date(ms).toISOString();
}
function windowOf(ctx: SyncCtx) {
  const from = Date.parse(ctx.window?.from ?? '');
  const to = Date.parse(ctx.window?.to ?? '');
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) throw new AdapterError('invalid_input', 'trade_window_required');
  return { from, to, fromIso: new Date(from).toISOString(), toIso: new Date(to).toISOString() };
}
function money(amount: unknown, code: unknown) {
  const currency = typeof code === 'string' && /^[A-Z]{3}$/.test(code) ? code : malformed('invalid_trade_currency');
  const match = (typeof amount === 'string' || typeof amount === 'number' ? String(amount) : '').match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return malformed('invalid_trade_amount');
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const fraction = (match[3] ?? '').padEnd(digits, '0');
  if (/[1-9]/.test(fraction.slice(digits))) return malformed('invalid_trade_amount_precision');
  const minor = Number(`${match[1]}${match[2]}${fraction.slice(0, digits)}`);
  if (!Number.isSafeInteger(minor)) return malformed('invalid_trade_amount');
  return { minor, currency };
}
const nonnegative = (minor: number) => minor >= 0 ? minor : malformed('negative_order_amount');
const shopMoney = (value: unknown) => {
  const cash = record(record(value).shopMoney);
  return money(cash.amount, cash.currencyCode);
};
const connection = (value: unknown) => graphConnection(value, 'malformed_trade_page');
const orderFields = `id createdAt updatedAt cancelledAt displayFinancialStatus displayFulfillmentStatus
  totalPriceSet { shopMoney { amount currencyCode } } subtotalPriceSet { shopMoney { amount currencyCode } }
  totalDiscountsSet { shopMoney { amount currencyCode } } totalTaxSet { shopMoney { amount currencyCode } }
  totalShippingPriceSet { shopMoney { amount currencyCode } }`;
const refundTransactions = 'nodes { id kind status amountSet { shopMoney { amount currencyCode } } } pageInfo { hasNextPage endCursor }';
const refundFields = `refunds { id createdAt updatedAt totalRefundedSet { shopMoney { amount currencyCode } } transactions(first: 10) { ${refundTransactions} } }`;
function shopifyOrder(node: Row) {
  const total = shopMoney(node.totalPriceSet);
  const status = text(node.displayFinancialStatus)?.toLowerCase();
  const order: Row = {
    external_order_id: id(node.id), placed_at: timestamp(node.createdAt), external_updated_at: timestamp(node.updatedAt),
    total_minor: nonnegative(total.minor), currency: total.currency, financial_status: status,
    fulfillment_status: text(node.displayFulfillmentStatus)?.toLowerCase(), cancelled_at: node.cancelledAt == null ? null : timestamp(node.cancelledAt),
  };
  for (const [field, key] of [['subtotal_minor', 'subtotalPriceSet'], ['discount_minor', 'totalDiscountsSet'], ['tax_minor', 'totalTaxSet'], ['shipping_minor', 'totalShippingPriceSet']]) {
    if (node[key] == null) continue;
    const amount = shopMoney(node[key]);
    if (amount.currency !== total.currency) malformed('mixed_trade_currency');
    order[field] = nonnegative(amount.minor);
  }
  if (node.discountCodes !== undefined) {
    const codes = node.discountCodes;
    if (!Array.isArray(codes) || codes.some(code => typeof code !== 'string' || !code.trim() || code.length > 128)) {
      return malformed('malformed_order_discount_codes');
    }
    order.observed_discount_codes = codes;
  }
  return order;
}
async function shopifyTrade(resource: Resource, options: AdapterOptions, request: Client, ctx: SyncCtx, token: string, cursor: string | null): Promise<SyncPage> {
  const window = windowOf(ctx);
  const fields = resource === 'refund_read' ? `${orderFields} ${refundFields}` : `${orderFields} discountCodes`;
  const call = async (query: string, variables: Row) => record(record((await shopifyGraphql(request, token, ctx.shopDomain, query, variables)).body).data);
  let nodes: Row[], nextCursor: string | null;
  if (ctx.objectId) {
    const sourceId = ctx.objectId.replace(/^gid:\/\/shopify\/Order\//, '');
    if (!/^\d+$/.test(sourceId) || cursor !== null) throw new AdapterError('invalid_input', 'invalid_shopify_order_target');
    const gid = `gid://shopify/Order/${sourceId}`;
    const order = record((await call(`query TradeOrder($id: ID!) { order(id: $id) { ${fields} } }`, { id: gid })).order);
    if (order.id !== gid) malformed('trade_order_identity_mismatch');
    nodes = [order];
    nextCursor = null;
  } else {
    // Shopify's default order grant can silently omit older orders.
    if (window.from < (options.now ?? Date.now)() - 60 * 86400_000 && !ctx.scopes?.includes('read_all_orders')) {
      throw new AdapterError('permission_denied', 'shopify_read_all_orders_required');
    }
    const data = await call(`query TradeOrders($after: String, $filter: String!) {
      orders(first: 15, after: $after, query: $filter, sortKey: UPDATED_AT) { nodes { ${fields} } pageInfo { hasNextPage endCursor } }
    }`, { after: cursor, filter: `updated_at:>='${window.fromIso}' updated_at:<'${window.toIso}'` });
    ({ nodes, nextCursor } = connection(data.orders));
  }
  if (resource === 'order_read') return { items: nodes.map(shopifyOrder), nextCursor };
  const items: Row[] = [];
  for (const node of nodes) {
    const order = shopifyOrder(node);
    for (const refund of list(node.refunds)) {
      const refundId = id(refund.id);
      const transactions: Row[] = [];
      let page = connection(refund.transactions);
      const seen = new Set<string>();
      while (true) {
        transactions.push(...page.nodes);
        if (page.nextCursor === null) break;
        if (seen.has(page.nextCursor)) malformed('refund_cursor_did_not_advance');
        seen.add(page.nextCursor);
        const detail = record((await call(`query RefundTransactions($id: ID!, $after: String!) { refund(id: $id) { id transactions(first: 100, after: $after) { ${refundTransactions} } } }`, { id: refundId, after: page.nextCursor })).refund);
        if (detail.id !== refundId) malformed('trade_refund_identity_mismatch');
        page = connection(detail.transactions);
      }
      const tx = transactions.filter(tx => tx.kind === 'REFUND');
      if (new Set(tx.map(item => id(item.id))).size !== tx.length) malformed('duplicate_refund_transaction');
      const successful = tx.filter(item => item.status === 'SUCCESS');
      const pending = tx.filter(item => !['SUCCESS', 'FAILURE', 'ERROR'].includes(String(item.status)));
      const status = successful.length ? 'succeeded' : pending.length || !tx.length ? 'pending' : 'failed';
      const counted = successful.length ? successful : pending.length ? pending : tx;
      const amounts = counted.length ? counted.map(item => shopMoney(item.amountSet)) : [shopMoney(refund.totalRefundedSet)];
      if (amounts.some(amount => amount.currency !== order.currency)) malformed('mixed_trade_currency');
      const amount = amounts.reduce((sum, value) => sum + Math.abs(value.minor), 0);
      if (!Number.isSafeInteger(amount)) malformed('invalid_trade_amount');
      items.push({ external_order_id: order.external_order_id, external_refund_id: refundId, currency: order.currency,
        created_at: timestamp(refund.createdAt), external_updated_at: [timestamp(refund.updatedAt), String(order.external_updated_at)].sort().at(-1),
        status, amount_minor: amount, order });
    }
  }
  return { items, nextCursor };
}

function tiktokOrder(node: Row) {
  const payment = record(node.payment);
  const total = money(payment.total_amount, payment.currency);
  const status = text(node.status);
  const cancelled = status === 'CANCELLED';
  const order: Row = {
    external_order_id: id(node.id), placed_at: timestamp(node.create_time), external_updated_at: timestamp(node.update_time),
    total_minor: nonnegative(total.minor), currency: total.currency, fulfillment_status: status?.toLowerCase(),
    financial_status: cancelled ? 'cancelled' : typeof node.paid_time === 'number' && node.paid_time > 0 ? 'paid' : 'pending',
    cancelled_at: cancelled && typeof node.cancel_time === 'number' && node.cancel_time > 0 ? timestamp(node.cancel_time) : null,
  };
  for (const [field, key] of [['subtotal_minor', 'original_total_product_price'], ['tax_minor', 'tax'], ['shipping_minor', 'shipping_fee']]) {
    if (payment[key] != null) order[field] = nonnegative(money(payment[key], total.currency).minor);
  }
  if (payment.seller_discount != null) order.discount_minor = nonnegative(money(payment.seller_discount, total.currency).minor);
  return order;
}
async function tiktokTrade(resource: Resource, options: AdapterOptions, request: Client, ctx: SyncCtx, token: string, cursor: string | null): Promise<SyncPage> {
  const window = windowOf(ctx);
  const shopCipher = requireText(ctx.shopCipher, 'shop_binding_required');
  const params = { shop_cipher: shopCipher, page_size: '20', page_token: cursor ?? undefined };
  const call = async (path: string, query: Record<string, string | undefined>, body?: Row) => record(record((await signedShop(options, request, token, path, query, body)).body).data);
  const orders = async (ids: string[]) => {
    if (ids.some(value => !/^\d+$/.test(value))) throw new AdapterError('invalid_input', 'invalid_tiktok_order_target');
    const result = list((await call('/order/202309/orders', { shop_cipher: shopCipher, ids: ids.join(',') })).orders).map(tiktokOrder);
    const byId = new Map(result.map(order => [order.external_order_id, order]));
    if (result.length !== ids.length || ids.some(value => !byId.has(value))) malformed('trade_order_identity_mismatch');
    return byId;
  };
  if (ctx.objectId && resource === 'order_read') return { items: [...(await orders([ctx.objectId])).values()], nextCursor: null };
  const bounds = { update_time_ge: Math.floor(window.from / 1000), update_time_lt: Math.ceil(window.to / 1000) };
  if (resource === 'order_read') {
    const data = await call('/order/202309/orders/search', params, bounds);
    return { items: list(data.orders ?? (data.total_count === 0 ? [] : null)).map(tiktokOrder), nextCursor: text(data.next_page_token) ?? null };
  }
  const data = await call('/return_refund/202309/returns/search', params, ctx.objectId ? { order_ids: [ctx.objectId] } : bounds);
  const items = list(data.return_orders ?? (data.total_count === 0 ? [] : null)).flatMap(item => {
    const state = text(item.return_status);
    const status = state === 'RETURN_OR_REFUND_REQUEST_COMPLETE' ? 'succeeded'
      : state === 'RETURN_OR_REFUND_REQUEST_PENDING' ? 'requested'
      : ['REFUND_OR_RETURN_REQUEST_REJECT', 'REJECT_RECEIVE_PACKAGE', 'RETURN_OR_REFUND_REQUEST_CANCEL'].includes(state ?? '') ? 'failed' : 'pending';
    // Replacement-only records have no refund. Approved refunds still require the completed state.
    if (state?.startsWith('REPLACEMENT_') && item.refund_amount == null) return [];
    const amount = record(item.refund_amount);
    const total = money(amount.refund_total, amount.currency);
    const orderId = id(item.order_id);
    if (ctx.objectId && orderId !== ctx.objectId) malformed('trade_order_identity_mismatch');
    return [{ external_order_id: orderId, external_refund_id: id(item.return_id), currency: total.currency,
      amount_minor: Math.abs(total.minor), status, created_at: timestamp(item.create_time), external_updated_at: timestamp(item.update_time) }];
  });
  const ids = [...new Set(items.map(item => item.external_order_id))];
  const parents = ids.length ? await orders(ids) : new Map();
  return { items: items.map(item => ({ ...item, order: parents.get(item.external_order_id) })), nextCursor: text(data.next_page_token) ?? null };
}

const amazonOrders = '/orders/2026-01-01/orders';
const amazonIncludedData = 'PROCEEDS';
function amazonOrder(node: Row, marketplace: string) {
  const market = record(node.salesChannel).marketplaceId;
  if (market != null && market !== marketplace) malformed('trade_marketplace_mismatch');
  const amount = record(record(node.proceeds).grandTotal);
  const total = money(amount.amount, amount.currencyCode);
  const state = record(node.fulfillment).fulfillmentStatus;
  const supported = ['PENDING_AVAILABILITY', 'PENDING', 'UNSHIPPED', 'PARTIALLY_SHIPPED', 'SHIPPED', 'CANCELLED', 'UNFULFILLABLE'];
  const status = typeof state === 'string' && supported.includes(state) ? state.toLowerCase() : undefined;
  // D19: emit only the scalar facts selected here. Never return an SP-API order object or its nested data.
  return { external_order_id: id(node.orderId), placed_at: timestamp(node.createdTime), external_updated_at: timestamp(node.lastUpdatedTime),
    total_minor: nonnegative(total.minor), currency: total.currency, fulfillment_status: status,
    financial_status: state === 'CANCELLED' ? 'cancelled' : state === 'SHIPPED' || state === 'PARTIALLY_SHIPPED' ? 'paid' : 'pending' };
}
const related = (value: unknown, name: string, key = 'relatedIdentifier') => identifier(rows(value).find(item => item[`${key}Name`] === name)?.[`${key}Value`]);
function amazonRefundAmount(node: Row) {
  const total = record(node.totalAmount);
  // Finance totals can be net of seller fees. Prefer the explicit buyer refund/product charges breakdown.
  const breakdowns = rows(node.breakdowns ?? record(node.breakdowns).breakdowns);
  const deeper = [...breakdowns, ...breakdowns.flatMap(entry => rows(entry.breakdowns))];
  const amount = record(deeper.find(entry => entry.breakdownType === 'Refunds')?.breakdownAmount ?? deeper.find(entry => entry.breakdownType === 'Product Charges')?.breakdownAmount ?? total);
  return money(amount.currencyAmount, amount.currencyCode ?? total.currencyCode);
}
async function amazonTrade(resource: Resource, options: AdapterOptions, request: Client, ctx: SyncCtx, token: string, cursor: string | null): Promise<SyncPage> {
  const window = windowOf(ctx);
  const marketplace = requireText(options.credentials?.amazonMarketplaceId, 'amazon_marketplace_required');
  const call = async (path: string, query: Record<string, string | undefined>) => record((await amazonRequest(options, request, token, path, query)).body);
  const getOrder = async (orderId: string) => {
    const result = amazonOrder(record((await call(`${amazonOrders}/${encodeURIComponent(orderId)}`, { includedData: amazonIncludedData })).order), marketplace);
    if (result.external_order_id !== orderId) malformed('trade_order_identity_mismatch');
    return result;
  };
  if (resource === 'order_read') {
    if (ctx.objectId) return { items: [await getOrder(ctx.objectId)], nextCursor: null };
    const body = await call(amazonOrders, { marketplaceIds: marketplace, includedData: amazonIncludedData,
      lastUpdatedAfter: window.fromIso, lastUpdatedBefore: window.toIso, paginationToken: cursor ?? undefined });
    return { items: list(body.orders).map(node => amazonOrder(node, marketplace)), nextCursor: text(record(body.pagination).nextToken) ?? null };
  }
  if (window.to > (options.now ?? Date.now)() - 48 * 3600_000 || window.to - window.from > 180 * 86400_000) {
    throw new AdapterError('invalid_input', 'amazon_finance_window_unavailable');
  }
  const body = await call('/finances/2024-06-19/transactions', { marketplaceId: marketplace, postedAfter: window.fromIso, postedBefore: window.toIso,
    relatedIdentifierName: ctx.objectId ? 'ORDER_ID' : undefined, relatedIdentifierValue: ctx.objectId, nextToken: cursor ?? undefined });
  if (!body.payload || typeof body.payload !== 'object' || Array.isArray(body.payload)) malformed('malformed_trade_page');
  const data = record(body.payload);
  const items: Row[] = [];
  const parents = new Map<string, Row>();
  // The Finance API can omit the transactions array on an empty page with a continuation token.
  for (const tx of list(data.transactions === undefined ? [] : data.transactions)) {
    if (tx.transactionType === 'Shipment') continue;
    const refundId = related(tx.relatedIdentifiers, 'REFUND_ID');
    const adjusted = rows(tx.items).flatMap(item => {
      const externalId = related(item.relatedIdentifiers, 'ORDER_ADJUSTMENT_ITEM_ID', 'itemRelatedIdentifier');
      return externalId ? [{ id: externalId, item }] : [];
    });
    if (!refundId && (tx.transactionType !== 'Refund' || !adjusted.length)) continue;
    const orderId = related(tx.relatedIdentifiers, 'ORDER_ID') ?? malformed('missing_refund_order');
    if (ctx.objectId && orderId !== ctx.objectId) malformed('trade_order_identity_mismatch');
    const observed = timestamp(tx.postedDate);
    const status = tx.transactionStatus === 'RELEASED' || tx.transactionStatus === 'DEFERRED_RELEASED' ? 'succeeded' : 'pending';
    if (!parents.has(orderId)) parents.set(orderId, await getOrder(orderId));
    for (const value of refundId ? [{ id: refundId, item: tx }] : adjusted) {
      const amount = amazonRefundAmount(value.item);
      if (amount.minor > 0) throw new AdapterError('unsupported', 'amazon_refund_credit_requires_review');
      items.push({ external_order_id: orderId, external_refund_id: value.id, currency: amount.currency,
        amount_minor: Math.abs(amount.minor), status, created_at: observed, external_updated_at: observed, order: parents.get(orderId) });
    }
  }
  return { items, nextCursor: text(data.nextToken) ?? null };
}

export async function tradePage(provider: ProviderKey, resource: Resource, options: AdapterOptions, request: Client, ctx: SyncCtx, token: string, cursor: string | null): Promise<SyncPage> {
  if (provider === 'shopify') return shopifyTrade(resource, options, request, ctx, token, cursor);
  if (provider === 'tiktok_shop') return tiktokTrade(resource, options, request, ctx, token, cursor);
  if (provider === 'amazon_sp') return amazonTrade(resource, options, request, ctx, token, cursor);
  throw new AdapterError('unsupported', 'trade_api_unavailable');
}
