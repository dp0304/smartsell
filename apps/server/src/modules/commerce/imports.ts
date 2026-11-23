import { ADMIN, type Context, type Data, type Row, Problem } from '@smartsell/contracts';
import { bool, conflict, currency, enumValue, identifier, integer, invalid, object, objects, one, optional, requirePhase, requirePlatformPhase, rowChanged, stringMap, strings, text, timestamp, upsert } from './domain.js';
import { change, currentListing, listingChanged, prepareListing, writeListing } from './listings.js';
import { markSourceChanges } from './revisions.js';
import { observeShopifyCoupons } from './promotion-usage.js';

export type ImportTemplate = 'product_list' | 'inventory_list' | 'order_list' | 'refund_list';
export interface ImportMetadata { batchId?: string; mode?: 'file' | 'api'; }
export type PreparedImport = (() => Row) & {
  status: 'new' | 'changed' | 'unchanged';
  resourceType: 'product' | 'product_variant' | 'order' | 'refund' | 'order_shipment';
};
const prepared = (resourceType: PreparedImport['resourceType'], status: PreparedImport['status'], apply: () => Row): PreparedImport => Object.assign(apply, { status, resourceType });
const productStatuses = ['active', 'draft', 'archived', 'removed_at_source'] as const;
const variantStatuses = ['active', 'archived', 'removed_at_source'] as const;
const refundStatuses = ['requested', 'pending', 'succeeded', 'failed'] as const;
const nullableAmount = (value: unknown, field: string) => value == null || value === '' ? null : integer(value, field);
const variantOptions = (input: unknown) => Array.isArray(input) ? Object.fromEntries(input.map((value, index) => [`option${index + 1}`, text(value, 'options')])) : stringMap(input, 'options');
const byStore = (ctx: Context, kind: string, store: Row) => ctx.list(kind).filter(row => row.store_id === store.id);

export function prepareImport(ctx: Context, template: ImportTemplate, storeId: string, row: Data, metadata: ImportMetadata = {}): PreparedImport {
  const store = ctx.get('store', storeId);
  requirePlatformPhase(ctx, store.provider);
  if (store.status === 'disabled') conflict('store_disabled', 'Store is disabled');
  const mode = metadata.mode ?? 'file';
  if (mode === 'api') {
    if (!['shopify', 'tiktok_shop', 'amazon_sp', 'shopee', 'lazada'].includes(String(store.provider))) invalid('API store provider');
    requirePhase(ctx, store.provider === 'shopify' || store.provider === 'tiktok_shop' ? 'p0b' : 'p1');
    if (!store.connection_id || !['connecting', 'active', 'degraded'].includes(String(store.status))) conflict('store_not_connected', 'Store has no active authorization');
    const connection = ctx.get('connection', String(store.connection_id));
    if (!['active', 'authorized'].includes(String(connection.status)) || (connection.expires_at && Date.parse(String(connection.expires_at)) <= Date.parse(ctx.now))) conflict('store_not_connected', 'Store authorization expired');
    const resource = { product_list: 'products', inventory_list: 'inventory', order_list: 'orders', refund_list: 'refunds' }[template];
    if ((store.sync_scope as Data | undefined)?.[resource] === false) conflict('sync_scope_disabled', 'Resource is outside the configured store sync scope');
  }
  const source: Data = { kind: mode === 'api' ? 'store_sync' : 'file_import', provider: store.provider, store_id: store.id };
  if (metadata.batchId) source.batch_id = text(metadata.batchId, 'batchId');
  if (template === 'product_list') return prepareProduct(ctx, store, { ...row, inventory_quantity: row.inventory_quantity ?? row.available }, source, mode);
  if (template === 'inventory_list') {
    if (store.provider !== 'shopify' || mode !== 'file') invalid('inventory_list');
    if (store.status === 'active' && (store.sync_scope as Data | undefined)?.inventory === true && (store.sync_scope as Data | undefined)?.inventory_source !== 'inventory_list') conflict('inventory_source_active', 'API inventory is enabled');
    return prepareInventory(ctx, store, row, source);
  }
  requirePhase(ctx, 'p1');
  if (mode === 'file' && !ADMIN.includes(ctx.role)) throw new Problem(403, 'forbidden', 'Order and refund imports require store administration');
  if (template === 'order_list') return prepareOrder(ctx, store, row, source);
  if (template === 'refund_list') return prepareRefund(ctx, store, row, source);
  return invalid('template');
}

function comparable(row: Row | undefined, values: Data): boolean {
  if (!row) return true;
  const simplify = (source: unknown) => {
    const stripped = { ...(source as Data | undefined) };
    delete stripped.batch_id;
    return stripped;
  };
  return rowChanged({ ...row, source: simplify(row.source) }, { ...values, source: simplify(values.source) });
}
function write(ctx: Context, kind: string, row: Row | undefined, values: Data): Row {
  return row && !comparable(row, values) ? row : upsert(ctx, kind, row, values);
}
function matching(rows: Row[], field: string, value: string | null): Row[] {
  return value == null ? [] : rows.filter(row => row[field] === value);
}
function isUpgrade(store: Row, mode: string): boolean {
  return mode === 'api' && store.status === 'connecting' && store.upgrading_from_import === true;
}
function addMappingTask(ctx: Context, store: Row, entity: string, externalId: unknown, reason: string): void {
  if (ctx.list('mapping_task').some(row => row.store_id === store.id && row.entity_type === entity && row.external_id === externalId && row.status === 'open')) return;
  ctx.create('mapping_task', { store_id: store.id, entity_type: entity, external_id: externalId, reason, status: 'open' });
}

function prepareProduct(ctx: Context, store: Row, row: Data, source: Data, mode: string): PreparedImport {
  const storeProducts = byStore(ctx, 'product', store);
  const storeVariants = byStore(ctx, 'product_variant', store);
  const upgrade = isUpgrade(store, mode);
  const externalId = identifier(row.external_product_id, 'external_product_id');
  const handle = optional(row.handle, 'handle');
  const variantRows = row.variants != null ? objects(row.variants, 'variants') : ['external_variant_id', 'sku', 'options', 'price_minor', 'price_amount_minor', 'inventory_quantity', 'available_for_sale', 'purchase_url', 'listings'].some(field => row[field] != null && row[field] !== '') ? [row] : [];
  let product: Row | undefined = matching(storeProducts, 'external_product_id', externalId)[0];
  let unresolved: string | null = null;
  if (!product && (upgrade || externalId == null)) {
    let candidates = matching(storeProducts, 'handle', handle);
    if (!candidates.length && upgrade) {
      const variantIds = variantRows.map(item => identifier(item.external_variant_id, 'external_variant_id')).filter(Boolean);
      const skus = variantRows.map(item => optional(item.sku, 'sku')).filter(Boolean);
      let productIds = storeVariants.filter(item => variantIds.includes(String(item.external_variant_id))).map(item => item.product_id);
      if (!productIds.length) productIds = storeVariants.filter(item => skus.includes(String(item.sku))).map(item => item.product_id);
      candidates = storeProducts.filter(item => productIds.includes(item.id));
    }
    if (upgrade) {
      if (candidates.length === 1 && candidates[0]!.external_product_id == null) product = candidates[0];
      else unresolved = candidates.length ? 'ambiguous_or_already_linked' : 'unmatched';
    } else product = one(candidates, 'ambiguous_product', 'Product handle is ambiguous');
  }
  if (mode === 'file' && externalId == null && handle == null) {
    const sku = optional(row.sku, 'sku') ?? invalid('external_product_id, handle or sku');
    const ids = new Set(matching(storeVariants, 'sku', sku).map(item => item.product_id));
    product = one(storeProducts.filter(item => ids.has(item.id)), 'ambiguous_product', 'Store SKU matches multiple products');
  }
  if (mode === 'api' && externalId == null) invalid('external_product_id');
  const productData: Data = {
    store_id: store.id, brand_id: store.brand_id, external_product_id: externalId ?? product?.external_product_id ?? null,
    handle: handle ?? product?.handle ?? null, title: text(row.title ?? product?.title, 'title'),
    status: enumValue(row.status ?? product?.status ?? 'active', productStatuses, 'product status'), source,
  };
  for (const field of ['product_type', 'vendor', 'description']) if (field in row) productData[field] = optional(row[field], field);
  if (row.source_updated_at != null) productData.source_updated_at = timestamp(row.source_updated_at, 'source_updated_at');
  if (product && mode === 'api' && staleSource(product, productData)) return prepared('product', 'unchanged', () => product!);
  const seen = new Set<string>();
  const linked = new Set<string>();
  const variants = variantRows.map(item => {
    const externalVariant = identifier(item.external_variant_id, 'external_variant_id');
    const sku = optional(item.sku, 'sku');
    const options = item.options == null ? undefined : variantOptions(item.options);
    if (mode === 'api' && externalVariant == null) invalid('external_variant_id');
    const siblings = storeVariants.filter(variant => variant.product_id === product?.id);
    let existing = one(matching(storeVariants, 'external_variant_id', externalVariant), 'ambiguous_variant', 'External variant ID is ambiguous');
    if (existing && existing.product_id !== product?.id) conflict('variant_product_mismatch', 'External variant belongs to another product');
    const variantKey = externalVariant ?? (options && Object.keys(options).length ? JSON.stringify(Object.entries(options).sort()) : sku ?? 'default');
    if (seen.has(variantKey)) conflict('duplicate_variant', 'Duplicate variant in input');
    seen.add(variantKey);
    let needsMapping = false;
    if (!existing && (upgrade || externalVariant == null)) {
      let candidates = options && Object.keys(options).length ? siblings.filter(variant => !rowChanged(variant, { options })) : [];
      if (!candidates.length) candidates = matching(upgrade ? storeVariants : siblings, 'sku', sku);
      if (!candidates.length && !upgrade && !sku && !Object.keys(options ?? {}).length) candidates = siblings.filter(variant => !variant.external_variant_id && !variant.sku && !Object.keys((variant.options ?? {}) as Data).length);
      if (upgrade && (candidates.length !== 1 || candidates[0]!.product_id !== product?.id || candidates[0]!.external_variant_id != null)) needsMapping = true;
      else existing = one(candidates, 'ambiguous_variant', 'Variant match is ambiguous');
    }
    if (existing && linked.has(existing.id)) conflict('ambiguous_variant', 'Multiple source rows match the same variant');
    if (existing) linked.add(existing.id);
    const variantData: Data = {
      external_variant_id: externalVariant ?? existing?.external_variant_id ?? null, sku: sku ?? existing?.sku ?? null, options: options ?? existing?.options ?? {},
      barcode: 'barcode' in item ? optional(item.barcode, 'barcode') : existing?.barcode ?? null,
      status: enumValue(item.variant_status ?? (item !== row ? item.status : undefined) ?? existing?.status ?? 'active', variantStatuses, 'variant status'),
      store_id: store.id, source,
    };
    if (item.source_updated_at != null) variantData.source_updated_at = timestamp(item.source_updated_at, 'source_updated_at');
    if (existing && mode === 'api' && staleSource(existing, variantData)) {
      return { existing, variantData, listings: [], needsMapping, externalVariant, stale: true };
    }
    const listingInputs = item.listings == null ? [item] : objects(item.listings, 'listings');
    const listings = listingInputs.flatMap(input => {
      if (!['price_minor', 'price_amount_minor', 'inventory_quantity', 'available_for_sale', 'purchase_url', 'availability', 'inventory_status', 'source_observation'].some(field => input[field] != null && input[field] !== '')) return [];
      const configurations = byStore(ctx, 'store_market', store).filter(config => config.enabled && (input.market_id == null || input.market_id === config.market_id) && (input.channel == null || input.channel === config.channel));
      if (input.market_id != null && !configurations.length) invalid('store_market');
      return configurations.flatMap(config => {
        // Platform base prices are not contextual prices. A file row without a market can also provide an explicit manual price.
        const priceSource = input.price_source ?? (input.market_id != null ? 'store_market_price' : config.price_source === 'manual' && mode === 'file' ? 'manual' : 'store_base_price');
        const listing: Data = { ...input, price_source: priceSource };
        if (priceSource === 'store_base_price' && config.price_source !== 'store_base_price') {
          delete listing.price_source;
          for (const field of ['price_minor', 'price_amount_minor', 'compare_at_amount_minor', 'currency']) delete listing[field];
        }
        const previous = existing && currentListing(ctx, existing.id, config);
        if (listing.purchase_url == null && typeof config.purchase_url_template === 'string') {
          const components: Data = { locale: store.default_locale, handle: productData.handle, variant_id: variantData.external_variant_id, product_id: productData.external_product_id };
          const fields = [...config.purchase_url_template.matchAll(/\{([^}]+)\}/g)].map(match => match[1]!);
          if (fields.every(field => components[field] != null)) listing.purchase_url = config.purchase_url_template.replace(/\{([^}]+)\}/g, (_match, key: string) => encodeURIComponent(String(components[key])));
        }
        // A partial product export can update price without reporting any stock.
        const inventoryFields = ['inventory_quantity', 'inventory_status', 'available_for_sale'];
        const inventoryUnreported = (listing.availability == null || listing.availability === 'observed') &&
          inventoryFields.every(field => listing[field] === undefined);
        if (mode === 'file' && ((store.sync_scope as Data | undefined)?.inventory_source === 'inventory_list' || inventoryUnreported)) {
          for (const field of inventoryFields) listing[field] = previous?.[field] ?? null;
        }
        const listingSource = { ...source };
        if (input.price_basis != null) listingSource.price_basis = enumValue(input.price_basis, ['base', 'includes_promotion', 'contextual', 'unknown'], 'price_basis');
        if ((previous?.source as Data | undefined)?.locations && (store.sync_scope as Data | undefined)?.inventory_source === 'inventory_list') listingSource.locations = (previous?.source as Data).locations;
        const data = prepareListing(ctx, store, config, listing, previous, listingSource, true);
        const observe = mode === 'api' && input.source_observation === true;
        return [{ config, data, observe, changed: observe || listingChanged(previous, data) }];
      });
    });
    return { existing, variantData, listings, needsMapping, externalVariant };
  });
  const changed = comparable(product, productData) || variants.some(variant => !variant.stale && (comparable(variant.existing, variant.variantData) || variant.listings.some(listing => listing.changed)));
  return prepared('product', !product ? 'new' : changed ? 'changed' : 'unchanged', () => {
    const saved = write(ctx, 'product', product, productData);
    if (unresolved) addMappingTask(ctx, store, 'product', externalId, unresolved);
    for (const variant of variants) {
      if (variant.stale) continue;
      const savedVariant = write(ctx, 'product_variant', variant.existing, { ...variant.variantData, product_id: saved.id });
      if (variant.needsMapping) addMappingTask(ctx, store, 'product_variant', variant.externalVariant, 'unmatched_or_ambiguous');
      for (const listing of variant.listings) writeListing(ctx, savedVariant, listing.config, listing.data, listing.observe);
    }
    if (changed) {
      const removed = saved.status === 'removed_at_source' && product?.status !== 'removed_at_source';
      ctx.emit(removed ? 'commerce.product.removed_at_source' : 'commerce.product.upserted', { product_id: saved.id, store_id: store.id });
      if (removed) change(ctx, 'product_removed', 'blocking', { product_id: saved.id }, product?.status, saved.status);
      if (product) markSourceChanges(ctx, saved, product);
    }
    return saved;
  });
}

function prepareInventory(ctx: Context, store: Row, row: Data, source: Data): PreparedImport {
  const handle = optional(row.handle, 'handle');
  const options = row.options == null ? {} : variantOptions(row.options);
  const sku = optional(row.sku, 'sku');
  const variants = byStore(ctx, 'product_variant', store);
  const products = byStore(ctx, 'product', store);
  const externalId = identifier(row.external_variant_id, 'external_variant_id');
  let candidates = matching(variants, 'external_variant_id', externalId);
  if (!candidates.length && handle != null) candidates = variants.filter(variant => products.some(product => product.id === variant.product_id && product.handle === handle) && !rowChanged(variant, { options }));
  if (!candidates.length) candidates = matching(variants, 'sku', sku);
  const variant = one(candidates, 'ambiguous_variant', 'Inventory row matches multiple variants');
  if (!variant) throw new Problem(422, 'variant_not_found', 'Inventory row does not match a variant');
  const location = text(row.location, 'location');
  const available = integer(row.available, 'available', -Number.MAX_SAFE_INTEGER);
  const existing = ctx.list('inventory_level').find(item => item.variant_id === variant.id && item.location === location);
  const syncScope = object(store.sync_scope ?? {}, 'sync_scope');
  const changed = !existing || existing.available !== available || syncScope.inventory_source !== 'inventory_list';
  const locations = Object.fromEntries(ctx.list('inventory_level').filter(item => item.variant_id === variant.id).map(item => [String(item.location), Number(item.available)]));
  Object.defineProperty(locations, location, { value: available, enumerable: true, configurable: true, writable: true });
  const listings = byStore(ctx, 'store_market', store).filter(config => config.enabled).map(config => {
    const previous = currentListing(ctx, variant.id, config);
    const selected = Array.isArray(config.inventory_locations) ? config.inventory_locations : Object.keys(locations);
    const hasObservations = selected.some(key => Object.hasOwn(locations, String(key)));
    const quantity = hasObservations ? selected.reduce((sum: number, key: unknown) => sum + (Object.hasOwn(locations, String(key)) ? locations[String(key)]! : 0), 0) : null;
    const data = prepareListing(ctx, store, config, { inventory_quantity: quantity, available_for_sale: quantity == null ? null : quantity > 0, purchase_url: previous?.purchase_url }, previous, { ...source, locations }, true);
    return { config, data, previous };
  });
  const listingUpdates = listings.some(item => listingChanged(item.previous, item.data));
  return prepared('product_variant', changed || listingUpdates ? 'changed' : 'unchanged', () => {
    if (!existing || existing.available !== available) upsert(ctx, 'inventory_level', existing, { store_id: store.id, variant_id: variant.id, location, available, source });
    if (syncScope.inventory_source !== 'inventory_list') ctx.update('store', store.id, { sync_scope: { ...syncScope, inventory_source: 'inventory_list' } });
    for (const listing of listings) writeListing(ctx, variant, listing.config, listing.data);
    return variant;
  });
}

function staleSource(existing: Row | undefined, incoming: Data): boolean {
  return typeof existing?.source_updated_at === 'string' && typeof incoming.source_updated_at === 'string' && incoming.source_updated_at < existing.source_updated_at;
}

function prepareOrder(ctx: Context, store: Row, row: Data, source: Data): PreparedImport {
  const externalOrder = identifier(row.external_order_id, 'external_order_id') ?? invalid('external_order_id');
  const existing = one(matching(byStore(ctx, 'order', store), 'external_order_id', externalOrder), 'duplicate_order', 'External order ID is ambiguous');
  // Construct normalized records from an allowlist. Raw payloads and customer fields never reach commerce storage.
  const data: Data = {
    store_id: store.id, external_order_id: externalOrder, placed_at: timestamp(row.placed_at ?? existing?.placed_at, 'placed_at'),
    currency: currency(row.currency ?? existing?.currency ?? store.default_currency), total_minor: integer(row.total_minor ?? existing?.total_minor, 'total_minor'), source,
  };
  for (const field of ['subtotal_minor', 'discount_minor', 'tax_minor', 'shipping_minor']) if (field in row) data[field] = nullableAmount(row[field], field);
  if (row.external_updated_at != null) data.source_updated_at = timestamp(row.external_updated_at, 'external_updated_at');
  if (row.financial_status != null || row.status != null) data.financial_status = optional(row.financial_status ?? row.status, 'financial_status');
  if ('fulfillment_status' in row) data.fulfillment_status = optional(row.fulfillment_status, 'fulfillment_status');
  if ('cancelled_at' in row) data.cancelled_at = row.cancelled_at == null || row.cancelled_at === '' ? null : timestamp(row.cancelled_at, 'cancelled_at');
  if (store.provider !== 'amazon_sp' && row.utm != null) {
    const utm = object(row.utm, 'utm');
    data.utm = Object.fromEntries(['source', 'medium', 'campaign', 'term', 'content'].filter(key => utm[key] != null).map(key => [key, text(utm[key], key, 256)]));
  }
  const lines = row.lines == null ? undefined : objects(row.lines, 'lines').map(item => {
    const variantId = optional(item.variant_id, 'variant_id');
    const externalVariant = identifier(item.external_variant_id, 'external_variant_id');
    const variant = variantId ? ctx.get('product_variant', variantId) : matching(byStore(ctx, 'product_variant', store), 'external_variant_id', externalVariant)[0];
    if (variant && variant.store_id !== store.id) invalid('variant_id');
    return {
      external_line_id: identifier(item.external_line_id, 'external_line_id'), variant_id: variant?.id ?? null,
      quantity: integer(item.quantity, 'quantity', 1), unit_price_minor: integer(item.unit_price_minor, 'unit_price_minor'),
      discount_minor: integer(item.discount_minor ?? 0, 'discount_minor'),
    };
  });
  const transactions = row.transactions == null ? undefined : objects(row.transactions, 'transactions').map(item => ({
    external_transaction_id: identifier(item.external_transaction_id, 'external_transaction_id') ?? invalid('external_transaction_id'),
    kind: enumValue(item.kind, ['sale', 'capture', 'refund', 'void'], 'transaction kind'),
    status: enumValue(item.status, ['pending', 'succeeded', 'failed'], 'transaction status'),
    amount_minor: integer(item.amount_minor, 'amount_minor'), processed_at: timestamp(item.processed_at, 'processed_at'),
  }));
  const providerCodes = store.provider === 'shopify' && source.kind === 'store_sync' && row.observed_discount_codes !== undefined
    ? strings(row.observed_discount_codes, 'observed_discount_codes') : undefined;
  const discounts = providerCodes ? observeShopifyCoupons(ctx, store, String(data.placed_at), providerCodes, existing) :
    store.provider === 'amazon_sp' || row.discounts == null ? undefined : objects(row.discounts, 'discounts').map(item => {
      const promotion = item.promotion_id == null ? null : ctx.get('promotion', text(item.promotion_id, 'promotion_id'));
      if (promotion && promotion.store_id !== store.id) invalid('promotion_id');
      return { code: text(item.code, 'code', 128), amount_minor: integer(item.amount_minor, 'amount_minor'), promotion_id: promotion?.id ?? null };
    });
  const childSets = [['order_line', lines], ['payment_transaction', transactions], ['discount_usage', discounts]] as const;
  const updatedChildren = childSets.flatMap(([kind, next]) => {
    if (!next) return [];
    const current = existing ? ctx.list(kind).filter(item => item.order_id === existing.id) : [];
    if (current.length === next.length && !next.some((item, index) => rowChanged(current[index], item))) return [];
    return [{ kind, current, next }];
  });
  const status = staleSource(existing, data) ? 'unchanged' : !existing ? 'new' : comparable(existing, data) || updatedChildren.length ? 'changed' : 'unchanged';
  return prepared('order', status, () => {
    if (existing && status === 'unchanged') return existing;
    const saved = write(ctx, 'order', existing, data);
    for (const { kind, current, next } of updatedChildren) {
      for (const item of current) ctx.remove(kind, item.id);
      for (const item of next) ctx.create(kind, { ...item, order_id: saved.id });
    }
    if (status !== 'unchanged') ctx.emit('commerce.order.upserted', { order_id: saved.id, store_id: store.id });
    return saved;
  });
}

export function importedOrder(ctx: Context, storeId: string, value: unknown): Row {
  const externalId = identifier(value, 'external_order_id') ?? invalid('external_order_id');
  const order = one(ctx.list('order').filter(row => row.store_id === storeId && row.external_order_id === externalId), 'duplicate_order', 'External order ID is ambiguous');
  if (!order) throw new Problem(422, 'order_not_found', 'Report row has no matching store order');
  return order;
}

export function prepareLogistics(ctx: Context, storeId: string, row: Data, source: Data): PreparedImport {
  const order = importedOrder(ctx, storeId, row.external_order_id);
  const external_shipment_id = text(row.external_shipment_id, 'external_shipment_id', 240);
  const status = text(row.status, 'shipment status', 80);
  const previous = one(ctx.list('order_shipment').filter(item => item.order_id === order.id && item.external_shipment_id === external_shipment_id),
    'duplicate_shipment', 'External shipment ID is ambiguous on this order');
  const explicitTime = row.observed_at == null ? null : timestamp(row.observed_at, 'observed_at');
  const observed_at = explicitTime ?? (previous?.status === status ? previous.observed_at : undefined) ?? ctx.now;
  if (explicitTime && explicitTime > ctx.now) invalid('future shipment observation');
  const values = { store_id: storeId, order_id: order.id, external_shipment_id, status, observed_at };
  const stale = typeof previous?.observed_at === 'string' && typeof observed_at === 'string' && observed_at < previous.observed_at;
  return prepared('order_shipment', !previous ? 'new' : stale || !rowChanged(previous, values) ? 'unchanged' : 'changed', () => {
    if (previous && (stale || !rowChanged(previous, values))) return previous;
    const shipment = upsert(ctx, 'order_shipment', previous, { ...values, source });
    ctx.emit('commerce.order_shipment.upserted', { order_shipment_id: shipment.id, order_id: order.id, store_id: storeId, batch_id: source.batch_id });
    return shipment;
  });
}

function prepareRefund(ctx: Context, store: Row, row: Data, source: Data): PreparedImport {
  const externalRefund = identifier(row.external_refund_id, 'external_refund_id') ?? invalid('external_refund_id');
  const order = importedOrder(ctx, store.id, row.external_order_id);
  const existing = one(matching(byStore(ctx, 'refund', store), 'external_refund_id', externalRefund), 'duplicate_refund', 'External refund ID is ambiguous');
  if (existing && existing.order_id !== order.id) conflict('refund_order_mismatch', 'Refund already belongs to another order');
  const observed = row.refunded_at ?? row.created_at;
  const data: Data = {
    store_id: store.id, order_id: order.id, external_refund_id: externalRefund, amount_minor: integer(row.amount_minor, 'amount_minor'), currency: order.currency,
    status: enumValue(row.status, refundStatuses, 'refund status'), source,
  };
  if (row.currency != null && currency(row.currency) !== order.currency) invalid('refund currency');
  if (row.external_updated_at != null) data.source_updated_at = timestamp(row.external_updated_at, 'external_updated_at');
  if (observed != null && observed !== '') data.source_created_at = timestamp(observed, 'source_created_at');
  if (row.lines != null) data.lines = objects(row.lines, 'lines').map(item => ({
    external_line_id: identifier(item.external_line_id, 'external_line_id'), amount_minor: integer(item.amount_minor, 'amount_minor'),
    quantity: item.quantity == null ? null : integer(item.quantity, 'quantity', 1),
  }));
  const status = staleSource(existing, data) || (existing?.status === 'succeeded' && data.status !== 'succeeded') ? 'unchanged' : !existing ? 'new' : comparable(existing, data) ? 'changed' : 'unchanged';
  return prepared('refund', status, () => {
    if (existing && status === 'unchanged') return existing;
    const saved = write(ctx, 'refund', existing, data);
    if (status !== 'unchanged') ctx.emit('commerce.refund.upserted', { refund_id: saved.id, order_id: order.id, store_id: store.id, status: saved.status });
    return saved;
  });
}
