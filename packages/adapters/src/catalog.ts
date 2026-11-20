import { fail, identifier, list, object, text, urlWith } from './adapter-http.ts';
import type { Requester } from './adapter-http.ts';
import type { SyncCtx, SyncPage as ProviderSyncPage } from './adapter-types.ts';
import { commercePage } from './provider-commerce.ts';
import type { CatalogItem, CatalogVariant, Credential, PlatformProvider, SyncPage } from './types.ts';

function required(config: Credential['configuration'], key: string): string {
  return text(config?.[key]) ?? fail('permission_denied', `missing_${key}`);
}
const amount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? String(value) : text(value);
const stock = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
const nonnegativeStock = (value: unknown) => typeof value === 'number' && value >= 0 ? stock(value) : undefined;
function tiktokStock(value: unknown) {
  const warehouses = list(value);
  if (warehouses.length === 0) return undefined;
  let total = 0;
  for (const warehouse of warehouses) {
    const quantity = nonnegativeStock(object(warehouse).quantity);
    if (quantity === undefined) return undefined;
    total += quantity;
  }
  return stock(total);
}
const requiredId = (value: unknown) => identifier(value) ?? fail('transient', 'catalog_identifier_missing');
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) fail('transient', 'catalog_rows_missing');
  return value;
}
async function hmac(secret: string, message: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function shopifySelectedOptions(value: unknown): CatalogVariant['selectedOptions'] {
  if (!Array.isArray(value) || !value.length) return undefined;
  const options: { name: string; value: string }[] = [];
  const names = new Set<string>();
  for (const raw of value) {
    const option = object(raw);
    const name = text(option.name);
    const value = text(option.value);
    if (!name || !value || names.has(name)) return undefined;
    names.add(name);
    options.push({ name, value });
  }
  return options;
}

export function normalizeCommerceCatalogPage(
  provider: string, page: ProviderSyncPage, includeInventory = true,
): SyncPage {
  const items = page.items.map((item): CatalogItem => {
    if (provider === 'shopify') return {
      externalId: requiredId(item.id), title: text(item.title), handle: text(item.handle), sourceUpdatedAt: text(item.updatedAt), variantsComplete: item.variantsComplete === true,
      variants: rows(object(item.variants).nodes).map(raw => {
        const variant = object(raw);
        return { externalId: requiredId(variant.id), sku: text(variant.sku), selectedOptions: shopifySelectedOptions(variant.selectedOptions),
          price: amount(variant.price), currency: text(item.currency), available: includeInventory ? stock(variant.inventoryQuantity) : undefined,
          sourceUpdatedAt: text(variant.updatedAt) };
      }),
    };
    if (provider === 'tiktok_shop') return {
      externalId: requiredId(item.id), title: text(item.title),
      ...(Array.isArray(item.skus) && item.skus.length === 0 && { variantsComplete: false }),
      variants: rows(item.skus).map(raw => {
        const sku = object(raw);
        const price = object(sku.price);
        return { externalId: requiredId(sku.id), sku: text(sku.seller_sku), price: amount(price.sale_price), currency: text(price.currency),
          available: includeInventory ? tiktokStock(sku.inventory) : undefined };
      }),
    };
    if (provider === 'amazon_sp') {
      const sku = requiredId(item.sku);
      const offers = list(item.offers).map(object).filter(offer => offer.offerType === 'B2C');
      const price = offers.length === 1 ? offers[0] : {};
      const inventory = includeInventory ? list(item.fulfillmentAvailability).map(object).filter(row => row.channel === 'DEFAULT') : [];
      return { externalId: sku, title: text(object(list(item.summaries)[0]).title), variants: [{ externalId: sku, sku,
        price: amount(price.amount), currency: text(price.currency), available: inventory.length === 1 ? nonnegativeStock(inventory[0].quantity) : undefined }] };
    }
    return fail('unsupported', 'catalog_api_unavailable');
  });
  return { items, nextCursor: page.nextCursor };
}

async function readCommerce(provider: 'shopify' | 'tiktok_shop' | 'amazon_sp', cursor: string | null, credential: Credential, request: Requester): Promise<SyncPage> {
  const configuration = credential.configuration;
  const options: Parameters<typeof commercePage>[1] = {};
  const context: SyncCtx = { externalAccountId: credential.accountId };
  if (provider === 'shopify') context.shopDomain = required(configuration, 'shop');
  if (provider === 'tiktok_shop') {
    options.credentials = { clientId: required(configuration, 'appKey'), clientSecret: required(configuration, 'appSecret') };
    context.shopCipher = required(configuration, 'shopCipher');
  }
  if (provider === 'amazon_sp') {
    const region = required(configuration, 'region');
    if (region !== 'NA' && region !== 'EU' && region !== 'FE') fail('invalid_input', 'invalid_amazon_region');
    const marketplace = required(configuration, 'marketplaceId');
    if (!/^[A-Z0-9]+$/.test(marketplace)) fail('invalid_input', 'invalid_marketplace');
    context.externalAccountId = required(configuration, 'sellerId');
    // Listings requests only use the already-authorized LWA access token.
    options.credentials = { amazonMarketplaceId: marketplace, amazonRegion: region === 'NA' ? 'na' : region === 'EU' ? 'eu' : 'fe' };
  }
  const page = await commercePage(provider, options, async req => {
    const { payload, headers } = await request({ ...req, effect: 'read' });
    return { status: 200, body: payload, headers };
  }, context, credential.accessToken, cursor);
  return normalizeCommerceCatalogPage(provider, page);
}

const shopeeHosts = { SG: 'partner.shopeemobile.com', CN: 'partner.shopeemobile.com.cn', BR: 'openplatform.shopee.com.br' };
const shopeeId = (value: unknown) => {
  const id = requiredId(value);
  return /^[1-9]\d*$/.test(id) ? id : fail('transient', 'invalid_shopee_identifier');
};
const shopeeOffset = (value: unknown) => {
  const offset = identifier(value);
  return offset !== undefined && /^\d+$/.test(offset) && Number.isSafeInteger(Number(offset)) ? offset : undefined;
};
async function shopee(cursor: string | null, credential: Credential, request: Requester): Promise<SyncPage> {
  const region = required(credential.configuration, 'region');
  const host = Object.hasOwn(shopeeHosts, region) ? shopeeHosts[region as keyof typeof shopeeHosts] : undefined;
  if (!host) fail('invalid_input', 'invalid_shopee_region');
  const partnerId = required(credential.configuration, 'partnerId');
  const shopId = required(credential.configuration, 'shopId');
  const secret = required(credential.configuration, 'partnerKey');
  if (![partnerId, shopId].every(id => /^[1-9]\d*$/.test(id))) fail('invalid_input', 'invalid_shopee_binding');
  if (cursor !== null && shopeeOffset(cursor) === undefined) fail('invalid_input', 'invalid_catalog_cursor');
  async function call(path: string, params: Record<string, string>) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sign = await hmac(secret, partnerId + path + timestamp + credential.accessToken + shopId);
    const { payload } = await request({ method: 'GET', effect: 'read', url: urlWith(`https://${host}${path}`, {
      ...params, partner_id: partnerId, timestamp, shop_id: shopId, access_token: credential.accessToken, sign,
    }) });
    return object(payload.response);
  }
  const page = await call('/api/v2/product/get_item_list', { offset: cursor ?? '0', page_size: '20', item_status: 'NORMAL' });
  if (typeof page.has_next_page !== 'boolean') fail('transient', 'catalog_pagination_missing');
  const nextCursor = page.has_next_page ? shopeeOffset(page.next_offset) : null;
  if (nextCursor === undefined || (nextCursor !== null && Number(nextCursor) <= Number(cursor ?? '0'))) {
    fail('transient', 'malformed_catalog_cursor');
  }
  const ids = rows(page.item).map(row => shopeeId(object(row).item_id));
  const pendingIds = new Set(ids);
  if (pendingIds.size !== ids.length || ids.length > 50) fail('transient', 'catalog_identifier_mismatch');
  const items: CatalogItem[] = [];
  if (ids.length) {
    const details = await call('/api/v2/product/get_item_base_info', { item_id_list: ids.join(',') });
    for (const raw of rows(details.item_list)) {
      const product = object(raw);
      const id = shopeeId(product.item_id);
      if (!pendingIds.delete(id)) fail('transient', 'catalog_identifier_mismatch');
      const hasModels = product.has_model;
      if (typeof hasModels !== 'boolean') fail('transient', 'catalog_model_flag_missing');
      const entries = hasModels
        ? rows((await call('/api/v2/product/get_model_list', { item_id: id })).model) : [product];
      const modelIds = new Set<string>();
      const variants: CatalogVariant[] = entries.map(rawVariant => {
        const variant = object(rawVariant);
        const externalId = hasModels ? shopeeId(variant.model_id) : id;
        if (modelIds.has(externalId)) fail('transient', 'catalog_identifier_mismatch');
        modelIds.add(externalId);
        const price = object(list(variant.price_info)[0]);
        return { externalId, sku: text(hasModels ? variant.model_sku : variant.item_sku),
          price: amount(price.current_price), currency: text(price.currency),
          available: nonnegativeStock(object(object(variant.stock_info_v2).summary_info).total_available_stock) };
      });
      items.push({ externalId: id, title: text(product.item_name), variants });
    }
    if (pendingIds.size > 0) fail('transient', 'catalog_details_missing');
  }
  return { items, nextCursor };
}

export async function fetchCatalog(provider: PlatformProvider, cursor: string | null, credential: Credential, request: Requester): Promise<SyncPage> {
  switch (provider) {
    case 'shopify':
    case 'tiktok_shop':
    case 'amazon_sp': return readCommerce(provider, cursor, credential, request);
    case 'shopee': return shopee(cursor, credential, request);
    default: fail('unsupported', 'catalog_api_unavailable');
  }
}
