import type { Context, Entity, Fields } from '../types';
import { bad, bool, currency, hash, instant, integer, one, priceSources, purchaseUrl, stableId, statusBucket } from './model';

export interface MutationView {
  rows(kind: string): Entity[];
  put(kind: string, id: string, patch: Fields): Entity;
  event(event: string, payload: Fields): void;
}
const listingAvailability = ['observed', 'not_collected', 'no_permission', 'source_not_provided', 'sync_failed'] as const;
export const snapshotKey = (row: Entity, variantId: string, marketId: string, channel: string) =>
  row.data.variant_id === variantId && row.data.market_id === marketId && row.data.channel === channel;
export const priceEligible = (source: string, setting: Entity) => source !== 'store_base_price' || setting.data.price_source === 'store_base_price';
export const isStale = (row: Entity, setting: Entity, now: string) =>
  Date.parse(now) - Date.parse(row.data.observed_at) > setting.data.snapshot_ttl_minutes * 60_000;

export function listingInput(input: Fields, setting: Entity, store: Entity): Fields {
  const source = one(input.price_source ?? setting.data.price_source, 'price_source', priceSources);
  if (!priceEligible(source, setting)) return bad('price_source');
  const quantity = input.inventory_quantity == null ? null : integer(input.inventory_quantity, 'inventory_quantity', -1_000_000_000);
  const price = input.price_amount_minor == null ? null : integer(input.price_amount_minor, 'price_amount_minor');
  const compare = input.compare_at_amount_minor == null ? null : integer(input.compare_at_amount_minor, 'compare_at_amount_minor');
  const code = input.currency == null ? null : currency(input.currency);
  if ((price !== null || compare !== null) && code === null) return bad('currency');
  const availability = one(input.availability ?? 'observed', 'availability', listingAvailability);
  if (availability !== 'observed' && [quantity, price, compare, input.available_for_sale].some(value => value != null)) return bad('availability');
  return {
    price_amount_minor: price, compare_at_amount_minor: compare, currency: code, price_source: source,
    fx_rate_id: input.fx_rate_id ?? null, is_estimate: source === 'fx_estimate',
    inventory_quantity: quantity,
    inventory_status: input.inventory_status === 'not_tracked' && quantity === null ? 'not_tracked' : statusBucket(quantity, setting.data.low_stock_threshold ?? null),
    available_for_sale: input.available_for_sale == null ? null : bool(input.available_for_sale, 'available_for_sale'),
    purchase_url: input.purchase_url == null ? null : purchaseUrl(store.data.provider, input.purchase_url),
    source_updated_at: input.source_updated_at == null ? null : instant(input.source_updated_at, 'source_updated_at'), availability,
  };
}

export function writeSnapshot(ctx: Context, view: MutationView, variant: Entity, setting: Entity, data: Fields, identity: string): Entity {
  const { market_id, channel } = setting.data;
  const matching = view.rows('listing_snapshot').filter(row => snapshotKey(row, variant.id, market_id, channel));
  const prior = matching.find(row => row.data.is_current);
  const snapshot = { ...data, store_id: variant.data.store_id, variant_id: variant.id, market_id, channel, observed_at: ctx.now, is_current: true, rolled_back: false };
  if (prior) view.put('listing_snapshot', prior.id, { is_current: false });
  const result = view.put('listing_snapshot', stableId(ctx.workspaceId, 'listing_snapshot', variant.id, market_id, channel, identity), snapshot);
  const baseline = matching.filter(row => row.data.availability === 'observed').sort((a, b) => (b.data.observation_no ?? 0) - (a.data.observation_no ?? 0) || b.data.observed_at.localeCompare(a.data.observed_at))[0];
  view.put('listing_snapshot', result.id, { observation_no: (prior?.data.observation_no ?? 0) + 1 });
  if (baseline && data.availability === 'observed') {
    const changes: [string, string][] = [];
    const from = baseline.data;
    if (from.price_amount_minor != null && data.price_amount_minor != null && (from.price_amount_minor !== data.price_amount_minor || from.currency !== data.currency)) changes.push(['price_changed', 'review']);
    if (from.available_for_sale === true && data.available_for_sale === false) changes.push(['became_unavailable', 'blocking']);
    if (from.available_for_sale === false && data.available_for_sale === true) changes.push(['became_available', 'info']);
    if (['in_stock', 'low'].includes(from.inventory_status) && data.inventory_status === 'out_of_stock') changes.push(['out_of_stock', 'blocking']);
    const threshold = setting.data.low_stock_threshold;
    if (threshold != null && from.inventory_quantity != null && data.inventory_quantity != null && (from.inventory_quantity <= threshold) !== (data.inventory_quantity <= threshold)) changes.push(['stock_low', 'review']);
    const fields = (row: Fields) => Object.fromEntries(['price_amount_minor', 'currency', 'available_for_sale', 'inventory_status', 'inventory_quantity'].map(k => [k, row[k] ?? null]));
    for (const [type, severity] of changes) {
      const payload = { change_type: type, store_id: variant.data.store_id, product_id: variant.data.product_id, variant_id: variant.id, market_id, channel, snapshot_id: result.id, severity };
      recordChange(ctx, view, payload, fields(from), fields(data), result.id);
      view.event('commerce.listing.changed', payload);
    }
  }
  return result;
}

export function recordChange(ctx: Context, view: MutationView, payload: Fields, before: Fields, after: Fields, identity: string) {
  const changeId = stableId(ctx.workspaceId, 'change_event', identity, payload.change_type, hash(payload));
  view.put('change_event', changeId, { ...payload, before, after, detected_at: ctx.now, status: 'open', rolled_back: false });
  view.event('commerce.change_event.created', { change_event_id: changeId, ...payload });
}
