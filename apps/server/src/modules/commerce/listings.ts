import { type Context, type Data, type Row } from '@smartsell/contracts';
import { availability, bool, currency, enumValue, integer, invalid, priceSources, purchaseUrl, rowChanged, stockStatuses, timestamp } from './domain.js';

export function listingKey(config: Row): Data {
  return { market_id: config.market_id, channel: config.channel };
}
export function currentListing(ctx: Context, variantId: string, config: Row): Row | undefined {
  return ctx.list('listing_snapshot').find(row => row.variant_id === variantId && row.market_id === config.market_id && row.channel === config.channel && row.is_current === true);
}
export function listingView(ctx: Context, row: Row): Data {
  const variant = ctx.get('product_variant', String(row.variant_id));
  const config = ctx.list('store_market').find(item => item.store_id === variant.store_id && item.market_id === row.market_id && item.channel === row.channel);
  const product = ctx.get('product', String(variant.product_id));
  return { ...row, ...listingPriceState(row, variant, product, config, ctx.now) };
}

export function isEstimatedPrice(row: Data) {
  return row.is_estimate === true || row.is_estimated === true || row.estimated === true || row.price_source === 'fx_estimate' || row.source === 'estimated';
}

export function listingPriceState(row: Data, variant: Data, product: Data, config: Data | undefined, now: string) {
  const ttlMs = Number(config?.snapshot_ttl_minutes) * 60_000;
  const expired = (at: unknown) => {
    const age = Date.parse(now) - Date.parse(String(at));
    return !Number.isFinite(age) || !Number.isFinite(ttlMs) || age > ttlMs;
  };
  const stale = config?.enabled !== true || expired(row.observed_at);
  const price_stale = row.price_amount_minor != null && (stale || expired(row.price_observed_at ?? row.observed_at));
  const publishable_price = row.is_current === true && !stale && !price_stale && row.rolled_back !== true && config?.rolled_back !== true &&
    product.status === 'active' && product.rolled_back !== true && variant.status === 'active' && variant.rolled_back !== true &&
    row.is_estimate === false && !isEstimatedPrice(row) && row.availability === 'observed' &&
    (row.price_source !== 'store_base_price' || config?.price_source === 'store_base_price') &&
    Number.isSafeInteger(row.price_amount_minor) && Number(row.price_amount_minor) >= 0 && /^[A-Z]{3}$/.test(String(row.currency));
  return { stale, price_stale, publishable_price };
}
export function change(ctx: Context, type: string, severity: string, keys: Data, before: unknown, after: unknown): Row {
  const row = ctx.create('change_event', { ...keys, change_type: type, severity, before, after, detected_at: ctx.now, status: 'open' });
  ctx.emit('commerce.change_event.created', { change_event_id: row.id, ...keys, change_type: type, severity });
  return row;
}
export function detectListingChanges(ctx: Context, variant: Row, previous: Row | undefined, current: Row, config: Row): void {
  if (!previous || previous.availability !== 'observed' || current.availability !== 'observed') return;
  const events: [string, string, unknown, unknown][] = [];
  if (previous.price_amount_minor != null && current.price_amount_minor != null && (previous.price_amount_minor !== current.price_amount_minor || previous.currency !== current.currency)) {
    events.push(['price_changed', 'review', { price_amount_minor: previous.price_amount_minor, currency: previous.currency }, { price_amount_minor: current.price_amount_minor, currency: current.currency }]);
  }
  if (previous.available_for_sale === true && current.available_for_sale === false) events.push(['became_unavailable', 'blocking', true, false]);
  if (previous.available_for_sale === false && current.available_for_sale === true) events.push(['became_available', 'info', false, true]);
  if (previous.inventory_status !== 'out_of_stock' && current.inventory_status === 'out_of_stock') events.push(['out_of_stock', 'blocking', previous.inventory_status, current.inventory_status]);
  if (typeof config.low_stock_threshold === 'number' && typeof previous.inventory_quantity === 'number' && typeof current.inventory_quantity === 'number' &&
      (previous.inventory_quantity <= config.low_stock_threshold) !== (current.inventory_quantity <= config.low_stock_threshold)) {
    events.push(['stock_low', 'review', previous.inventory_quantity, current.inventory_quantity]);
  }
  const keys = { product_id: variant.product_id, variant_id: variant.id, ...listingKey(config), snapshot_id: current.id };
  for (const [type, severity, before, after] of events) change(ctx, type, severity, keys, before, after);
  if (events.length) ctx.emit('commerce.listing.changed', { ...keys, change_types: events.map(event => event[0]) });
  if (events.some(([type]) => type === 'out_of_stock' || type === 'became_available')) {
    for (const rule of ctx.list('inventory_rule').filter(rule => rule.enabled && rule.variant_id === variant.id && rule.market_id === config.market_id)) {
      const action = events.some(([type]) => type === 'out_of_stock') ? rule.action : rule.action === 'pause_targets' ? 'resume_targets' : 'notify';
      ctx.emit('commerce.inventory_rule.triggered', { ...keys, inventory_rule_id: rule.id, action });
    }
  }
}
export function prepareListing(ctx: Context, store: Row, config: Row, row: Data, previous: Row | undefined, source: Data, trusted: boolean): Data {
  const qtyInput = row.inventory_quantity;
  const quantity = qtyInput == null || qtyInput === '' ? null : integer(qtyInput, 'inventory_quantity', -Number.MAX_SAFE_INTEGER);
  const state = enumValue(row.availability ?? 'observed', availability, 'availability');
  const priceInput = row.price_amount_minor ?? row.price_minor;
  const price = priceInput == null || priceInput === '' ? null : integer(priceInput, 'price_amount_minor');
  const compare = row.compare_at_amount_minor == null ? null : integer(row.compare_at_amount_minor, 'compare_at_amount_minor');
  const priceSource = enumValue(row.price_source ?? (trusted ? config.price_source : 'manual'), priceSources, 'price_source');
  if (!trusted && priceSource !== 'manual' && priceSource !== 'fx_estimate') invalid('price_source');
  if (priceSource === 'store_base_price' && config.price_source !== 'store_base_price') invalid('price_source');
  const rate = row.fx_rate_id == null ? null : ctx.get('fx_rate', String(row.fx_rate_id));
  if (priceSource === 'fx_estimate' && (!rate || price == null)) invalid('fx_rate_id');
  const currencyCode = row.currency == null || row.currency === '' ? (price != null || compare != null ? currency(store.default_currency) : null) : currency(row.currency);
  const market = ctx.get('market', String(config.market_id));
  if (priceSource === 'fx_estimate' && rate && rate.quote_currency && currencyCode !== rate.quote_currency) invalid('currency');
  if (price != null && priceSource === 'store_market_price' && market.currency != null && currencyCode !== market.currency) invalid('currency');
  if (state !== 'observed' && (price != null || compare != null || quantity != null || row.available_for_sale != null || ['in_stock', 'low', 'out_of_stock'].includes(String(row.inventory_status)))) invalid('availability');
  const computedStock = quantity == null ? 'unknown' : quantity <= 0 ? 'out_of_stock' : typeof config.low_stock_threshold === 'number' && quantity <= config.low_stock_threshold ? 'low' : 'in_stock';
  const inventoryStatus = enumValue(row.inventory_status ?? computedStock, stockStatuses, 'inventory_status');
  const candidate: Data = {
    ...listingKey(config), price_amount_minor: price, compare_at_amount_minor: compare, currency: currencyCode,
    price_source: priceSource, is_estimate: priceSource === 'fx_estimate', fx_rate_id: rate?.id ?? null,
    available_for_sale: row.available_for_sale == null || row.available_for_sale === '' ? null : bool(row.available_for_sale, 'available_for_sale'),
    inventory_quantity: quantity, inventory_status: inventoryStatus, availability: state,
    purchase_url: purchaseUrl(row.purchase_url, store.provider),
    source_updated_at: row.source_updated_at == null ? null : timestamp(row.source_updated_at, 'source_updated_at'), source,
  };
  const previousSource = previous?.price_source as typeof priceSources[number];
  if (previous?.availability === 'observed' && state === 'observed' && previous.price_amount_minor != null &&
      (previousSource !== 'store_base_price' || config.price_source === 'store_base_price') &&
      (price == null || priceSources.indexOf(previousSource) < priceSources.indexOf(priceSource))) {
    for (const field of ['price_amount_minor', 'compare_at_amount_minor', 'currency', 'price_source', 'is_estimate', 'fx_rate_id']) candidate[field] = previous[field];
    candidate.source = { ...source, price_provenance: (previous.source as Data | undefined)?.price_provenance ?? previous.source };
    candidate.price_observed_at = previous.price_observed_at ?? previous.observed_at;
  }
  return candidate;
}
export function listingChanged(previous: Row | undefined, data: Data): boolean {
  const withoutBatch = (value: unknown) => Object.fromEntries(Object.entries((value ?? {}) as Data).filter(([key]) => key !== 'batch_id'));
  return rowChanged(previous, { ...data, source: previous?.source }) || rowChanged(previous && { ...previous, source: withoutBatch(previous.source) }, { source: withoutBatch(data.source) });
}
export function writeListing(ctx: Context, variant: Row, config: Row, data: Data, always = false): Row {
  const previous = currentListing(ctx, variant.id, config);
  if (previous && !always && !listingChanged(previous, data)) return previous;
  if (previous) ctx.update('listing_snapshot', previous.id, { is_current: false });
  const current = ctx.create('listing_snapshot', { ...data, price_observed_at: data.price_observed_at ?? (data.price_amount_minor == null ? null : ctx.now), variant_id: variant.id, observed_at: ctx.now, is_current: true });
  detectListingChanges(ctx, variant, previous, current, config);
  return current;
}
