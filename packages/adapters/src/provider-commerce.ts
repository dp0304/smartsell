import { createHmac } from 'node:crypto';
import type { AdapterOptions, CapabilityReport, ConnectionCtx, ProviderKey, SyncCtx, SyncPage } from './adapter-types.ts';
import { AdapterError, checkShopifyApiVersion, identifier, json, record, requireText, rows, shopHost, shopifyApiVersion, text, url, type Client } from './provider-http.ts';
import { amazonHost } from './provider-oauth.ts';

export const commerceProviders = new Set<ProviderKey>(['shopify', 'tiktok_shop', 'amazon_sp']);
const tiktokShop = 'https://open-api.tiktokglobalshop.com';

const malformed = (reason = 'malformed_catalog_page'): never => { throw new AdapterError('transient', reason); };
function objectRows(value: unknown, reason?: string) {
  const entries = rows(value);
  if (!Array.isArray(value) || entries.length !== value.length) malformed(reason);
  return entries;
}
function uniqueIds<T>(entries: T[], getId: (entry: T) => string | undefined, reason: string): string[] {
  const seen = new Set<string>();
  return entries.map(entry => {
    const id = getId(entry);
    if (!id || seen.has(id)) return malformed(reason);
    seen.add(id);
    return id;
  });
}
function nextToken(value: unknown, emptyIsTerminal = false): string | null {
  if (value == null || (emptyIsTerminal && value === '')) return null;
  return text(value) ?? malformed('malformed_catalog_cursor');
}

type CommerceOptions = Pick<AdapterOptions, 'now'> & { credentials?: Partial<NonNullable<AdapterOptions['credentials']>> };
type ReadRequester = (request: Parameters<Client>[0] & { method: 'GET' | 'POST' }) => ReturnType<Client>;
type ShopifyRequester = (request: Parameters<Client>[0] & { method: 'POST' }) => ReturnType<Client>;

export async function signedShop(options: CommerceOptions, request: ReadRequester, token: string, path: string, params: Record<string, string | undefined> = {}, body?: unknown) {
  const appKey = text(options.credentials?.clientId);
  const secret = text(options.credentials?.clientSecret);
  if (!appKey || !secret) throw new AdapterError('unsupported', 'unconfigured');
  const { access_token: _accessToken, sign: _sign, ...unsigned } = params;
  const query = { ...unsigned, app_key: appKey, timestamp: String(Math.floor((options.now ?? Date.now)() / 1000)) };
  const serialized = body === undefined ? undefined : json(body);
  const ordered = Object.entries(query).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const canonical = path + ordered.map(([key, value]) => key + value).join('') + (serialized?.body ?? '');
  const sign = createHmac('sha256', secret).update(secret + canonical + secret).digest('hex');
  const response = await request({ method: serialized ? 'POST' : 'GET', url: url(tiktokShop + path, { ...query, sign }), body: serialized?.body,
    headers: { 'content-type': 'application/json', 'x-tts-access-token': token } });
  if (identifier(record(response.body).code) !== '0') malformed('malformed_tiktok_shop_response');
  return response;
}
export const shopifyGraphql = async (request: ShopifyRequester, token: string, domain: string | undefined, query: string, variables: Record<string, unknown> = {}) => {
  const body = json({ query, variables });
  const response = await request({ method: 'POST', url: `https://${shopHost(domain)}/admin/api/${shopifyApiVersion}/graphql.json`, headers: { ...body.headers, 'x-shopify-access-token': token }, body: body.body });
  checkShopifyApiVersion(response.headers);
  const errors = record(response.body).errors;
  if (errors !== undefined && (!Array.isArray(errors) || errors.length !== 0)) malformed('malformed_shopify_graphql_response');
  return response;
};
export const amazonRequest = (options: CommerceOptions, request: ReadRequester, token: string, path: string, params?: Record<string, string | undefined>) => {
  const region = options.credentials?.amazonRegion;
  if (!region || !['na', 'eu', 'fe'].includes(region)) throw new AdapterError('unsupported', 'amazon_region_required');
  return request({ method: 'GET', url: url(amazonHost(region) + path, params), headers: { 'x-amz-access-token': token } });
};
function encodedId(value: unknown, reason: string) {
  const id = requireText(value, reason);
  if (id === '.' || id === '..') throw new AdapterError('invalid_input', reason);
  return encodeURIComponent(id);
}

function sellerFor(connection: ConnectionCtx) {
  if (connection.sellerId !== undefined && connection.externalAccountId !== undefined && connection.sellerId !== connection.externalAccountId) {
    throw new AdapterError('permission_denied', 'account_binding_mismatch');
  }
  return text(connection.sellerId ?? connection.externalAccountId);
}

function marketplaceFor(options: CommerceOptions) {
  const marketplace = text(options.credentials?.amazonMarketplaceId);
  if (!marketplace) throw new AdapterError('unsupported', 'amazon_marketplace_required');
  if (!/^[a-z0-9]+$/i.test(marketplace)) throw new AdapterError('invalid_input', 'invalid_marketplace');
  return marketplace;
}

function amazonListings(body: unknown) {
  const data = record(body);
  const items = objectRows(data.items);
  uniqueIds(items, item => text(item.sku), 'listing_identity_unverified');
  if (data.pagination != null && (typeof data.pagination !== 'object' || Array.isArray(data.pagination))) malformed('malformed_catalog_cursor');
  const nextCursor = nextToken(record(data.pagination).nextToken);
  const total = data.numberOfResults;
  if (total !== undefined && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < items.length)) malformed();
  return { items, nextCursor, total: typeof total === 'number' ? total : undefined };
}

export async function probeCommerce(provider: ProviderKey, options: CommerceOptions, request: Client, connection: ConnectionCtx, token: string): Promise<NonNullable<CapabilityReport['accounts']>> {
  if (provider === 'shopify') {
    const response = await shopifyGraphql(request, token, connection.shopDomain, 'query ProbeShop { shop { id name myshopifyDomain } }');
    const shop = record(record(record(response.body).data).shop);
    const id = identifier(shop.id);
    const domain = text(shop.myshopifyDomain);
    return id && domain === shopHost(connection.shopDomain) ? [{ externalAccountId: id, name: text(shop.name) }] : [];
  }
  if (provider === 'tiktok_shop') {
    const response = await signedShop(options, request, token, '/authorization/202309/shops');
    const shops = objectRows(record(record(response.body).data).shops, 'shop_identity_unverified');
    const ids = uniqueIds(shops, shop => identifier(shop.id), 'shop_identity_unverified');
    const ciphers = uniqueIds(shops, shop => text(shop.cipher), 'shop_identity_unverified');
    const accounts = shops.map((shop, index) => ({ externalAccountId: ids[index], shopCipher: ciphers[index], name: text(shop.name) }));
    if (connection.shopCipher !== undefined) {
      const bound = accounts.find(account => account.shopCipher === connection.shopCipher);
      if (!bound || (connection.externalAccountId !== undefined && bound.externalAccountId !== connection.externalAccountId)) {
        throw new AdapterError('permission_denied', 'account_binding_mismatch');
      }
      return [bound];
    }
    return accounts;
  }
  if (provider !== 'amazon_sp') throw new AdapterError('unsupported', 'catalog_api_unavailable');
  const marketplace = marketplaceFor(options);
  const seller = sellerFor(connection);
  if (!seller) throw new AdapterError('unsupported', 'amazon_marketplace_and_seller_required');
  // Query seller-owned listings to check access to the explicitly bound seller and marketplace.
  const response = await amazonRequest(options, request, token, `/listings/2021-08-01/items/${encodedId(seller, 'seller_required')}`, { marketplaceIds: marketplace, pageSize: '1' });
  amazonListings(response.body);
  return [{ externalAccountId: seller }];
}

const shopifyVariantFields = (includeInventory: boolean) => `nodes { id title sku price selectedOptions { name value } ${includeInventory ? 'inventoryQuantity' : ''} updatedAt } pageInfo { hasNextPage endCursor }`;

export function graphConnection(value: unknown, reason = 'malformed_catalog_page') {
  const connection = record(value);
  const nodes = rows(connection.nodes);
  const page = record(connection.pageInfo);
  const nextCursor = page.hasNextPage ? text(page.endCursor) : null;
  if (!Array.isArray(connection.nodes) || nodes.length !== connection.nodes.length || typeof page.hasNextPage !== 'boolean' || nextCursor === undefined) {
    throw new AdapterError('transient', reason);
  }
  return { nodes, nextCursor, pageInfo: page };
}

export async function shopifyCatalogPage(request: ShopifyRequester, token: string, domain: string | undefined, cursor: string | null, includeInventory = true): Promise<SyncPage> {
  const response = await shopifyGraphql(request, token, domain, `query Products($after: String) {
    products(first: 10, after: $after) {
      nodes { id title handle status updatedAt variants(first: 20) { ${shopifyVariantFields(includeInventory)} } }
      pageInfo { hasNextPage endCursor }
    }
    shop { currencyCode }
  }`, { after: cursor });
  const data = record(record(response.body).data);
  const products = graphConnection(data.products);
  const currency = text(record(data.shop).currencyCode);
  const productIds = uniqueIds(products.nodes, product => identifier(product.id), 'product_identity_unverified');
  const items = [];
  for (const [index, product] of products.nodes.entries()) {
    const productId = productIds[index];
    const variants = [];
    const seenIds = new Set<string>();
    const seenCursors = new Set<string>();
    let page = graphConnection(product.variants);
    while (true) {
      for (const variant of page.nodes) {
        const id = identifier(variant.id);
        if (!id || seenIds.has(id)) throw new AdapterError('transient', 'variant_identity_unverified');
        seenIds.add(id);
        if (includeInventory) variants.push(variant);
        else {
          const { inventoryQuantity: _inventoryQuantity, ...withoutInventory } = variant;
          variants.push(withoutInventory);
        }
      }
      const after = page.nextCursor;
      if (after === null) break;
      if (seenCursors.has(after)) throw new AdapterError('transient', 'variant_cursor_did_not_advance');
      seenCursors.add(after);
      const detail = await shopifyGraphql(request, token, domain, `query ProductVariants($id: ID!, $after: String!) {
        product(id: $id) { id variants(first: 100, after: $after) { ${shopifyVariantFields(includeInventory)} } }
      }`, { id: productId, after });
      const next = record(record(record(detail.body).data).product);
      if (identifier(next.id) !== productId) throw new AdapterError('transient', 'product_identity_mismatch');
      page = graphConnection(next.variants);
    }
    items.push({ ...product, currency, variants: { nodes: variants, pageInfo: page.pageInfo }, variantsComplete: true });
  }
  return { items, nextCursor: products.nextCursor };
}

export async function commercePage(provider: ProviderKey, options: CommerceOptions, request: ReadRequester, ctx: SyncCtx, token: string, cursor: string | null): Promise<SyncPage> {
  if (provider === 'shopify') return shopifyCatalogPage(request, token, ctx.shopDomain, cursor, ctx.includeInventory);
  if (provider === 'tiktok_shop') {
    const shopCipher = text(ctx.shopCipher);
    if (!shopCipher || !text(ctx.externalAccountId)) throw new AdapterError('unsupported', 'shop_binding_required');
    const response = await signedShop(options, request, token, '/product/202309/products/search', { page_size: '20', page_token: cursor ?? undefined, shop_cipher: shopCipher }, {});
    const data = record(record(response.body).data);
    const nextCursor = nextToken(data.next_page_token, true);
    const ids = uniqueIds(objectRows(data.products), product => identifier(product.id), 'product_identity_unverified');
    const total = data.total_count;
    if (total !== undefined && (typeof total !== 'number' || !Number.isSafeInteger(total) || total < ids.length)) malformed();
    const items = [];
    for (const id of ids) {
      const detail = await signedShop(options, request, token, `/product/202309/products/${encodedId(id, 'product_required')}`, { shop_cipher: shopCipher });
      const item = record(record(detail.body).data);
      if (identifier(item.id) !== id) malformed('product_identity_mismatch');
      const skus = objectRows(item.skus);
      uniqueIds(skus, sku => identifier(sku.id), 'variant_identity_unverified');
      items.push(ctx.includeInventory === false ? { ...item, skus: skus.map(({ inventory: _inventory, ...sku }) => sku) } : item);
    }
    return { items, nextCursor, ...(typeof total === 'number' && { totalCount: total }) };
  }
  if (provider !== 'amazon_sp') throw new AdapterError('unsupported', 'catalog_api_unavailable');
  const marketplace = marketplaceFor(options);
  const seller = sellerFor(ctx);
  const response = await amazonRequest(options, request, token, `/listings/2021-08-01/items/${encodedId(seller, 'seller_required')}`, {
    marketplaceIds: marketplace, includedData: ctx.includeInventory === false ? 'summaries,offers' : 'summaries,offers,fulfillmentAvailability', pageSize: '20', pageToken: cursor ?? undefined,
  });
  const listings = amazonListings(response.body);
  // Search can page through at most 1,000 SKUs. Do not authorize a full reconciliation at the limit.
  if (listings.total !== undefined) {
    if (listings.total >= 1000) throw new AdapterError('unsupported', 'amazon_listing_search_limit');
    if (cursor === null && listings.nextCursor === null && listings.total !== listings.items.length) malformed();
  }
  const optionalRows = (value: unknown) => value === undefined ? [] : objectRows(value);
  // Keep only listing fields for the requested marketplace, even if the provider returns extra data.
  const items = listings.items.map(item => ({
    sku: item.sku,
    summaries: optionalRows(item.summaries).filter(summary => summary.marketplaceId === marketplace).map(summary => ({ asin: text(summary.asin), marketplaceId: marketplace, title: text(summary.itemName), updatedAt: text(summary.lastUpdatedDate) })),
    offers: optionalRows(item.offers).filter(offer => offer.marketplaceId === marketplace).map(offer => {
      const price = record(offer.price);
      return { marketplaceId: marketplace, offerType: text(offer.offerType), currency: text(price.currencyCode), amount: typeof price.amount === 'number' ? price.amount : text(price.amount) };
    }),
    ...(ctx.includeInventory === false ? {} : {
      fulfillmentAvailability: optionalRows(item.fulfillmentAvailability).map(stock => ({ channel: text(stock.fulfillmentChannelCode), quantity: typeof stock.quantity === 'number' ? stock.quantity : undefined })),
    }),
  }));
  return { items, nextCursor: listings.nextCursor };
}
