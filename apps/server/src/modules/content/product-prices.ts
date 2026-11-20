import type { Context, Entity, Fields } from '../types.ts';
import { isEstimatedPrice, listingPriceState } from '../commerce/listings.ts';
import { fail, hash, list } from './model.ts';

async function priceScope(ctx: Context, content: Fields, product: Entity) {
  const marketId = content.market_id ?? content.market;
  if (!marketId || product.data.brand_id !== content.brand_id || !product.data.store_id) return;
  const [market, store, settings] = await Promise.all([
    ctx.get('workspace', 'market', marketId), ctx.get('commerce', 'store', product.data.store_id), list(ctx, 'store_market', 'commerce'),
  ]);
  if (!market || market.data.brand_id !== content.brand_id || market.data.status !== 'active' ||
      !store || store.data.brand_id !== content.brand_id || store.data.status === 'disabled' || store.data.rolled_back === true) return;
  let locale = 'en';
  try { [locale = 'en'] = Intl.getCanonicalLocales(content.locale); } catch (error) {
    if (!(error instanceof RangeError)) throw error;
  }
  const configs = new Map(settings.filter(setting => setting.data.store_id === store.id && setting.data.market_id === marketId)
    .map(setting => [setting.data.channel, setting.data]));
  return { marketId, storeId: store.id, locale, configs, now: ctx.now };
}

function pricePin(scope: NonNullable<Awaited<ReturnType<typeof priceScope>>>, snapshot: Entity, sku: Entity, product: Entity) {
  const row = snapshot.data;
  if (row.market_id !== scope.marketId || row.variant_id !== sku.id || sku.data.product_id !== product.id ||
      sku.data.store_id !== scope.storeId || (row.store_id != null && row.store_id !== scope.storeId)) return;
  if (!listingPriceState(row, sku.data, product.data, scope.configs.get(row.channel), scope.now).publishable_price) return;

  const formatter = new Intl.NumberFormat(scope.locale, { style: 'currency', currency: row.currency, currencyDisplay: 'code' });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 2;
  const amount = `${row.price_amount_minor}e-${digits}` as Intl.StringNumericLiteral;
  return { variant_id: sku.id, listing_snapshot_id: snapshot.id, market_id: scope.marketId, currency: row.currency, field: 'price',
    inserted_text: formatter.format(amount) };
}

export async function priceChoices(ctx: Context, variant: Entity, productId: string) {
  const product = await ctx.get('commerce', 'product', productId);
  if (!product || product.data.brand_id !== variant.data.brand_id || product.data.rolled_back === true) fail('not_found', 'Product not found', 404);
  const scope = await priceScope(ctx, variant.data, product);
  if (!scope) return [];
  const skus = new Map((await list(ctx, 'product_variant', 'commerce')).filter(sku => sku.data.product_id === product.id).map(sku => [sku.id, sku]));
  const choices: Fields[] = [];
  for (const snapshot of await list(ctx, 'listing_snapshot', 'commerce')) {
    const sku = skus.get(snapshot.data.variant_id);
    if (!sku) continue;
    const pin = pricePin(scope, snapshot, sku, product);
    if (pin) choices.push({ ...pin, sku: sku.data.sku ?? sku.id, channel: snapshot.data.channel });
  }
  return choices;
}

export async function requirePricePin(ctx: Context, variant: Entity, snapshotId: string) {
  const snapshot = await ctx.get('commerce', 'listing_snapshot', snapshotId);
  const sku = snapshot && await ctx.get('commerce', 'product_variant', snapshot.data.variant_id);
  const product = sku && await ctx.get('commerce', 'product', sku.data.product_id);
  const scope = product && await priceScope(ctx, variant.data, product);
  const pin = scope && snapshot && sku && product && pricePin(scope, snapshot, sku, product);
  if (!pin) fail('invalid_product_reference', 'Listing price is unavailable for this content market');
  return pin;
}

export async function rejectNewEstimatedPrices(ctx: Context, refs: Fields[], prior: Fields[]) {
  const saved = new Set(prior.filter(ref => ref.listing_snapshot_id).map(ref => hash(ref)));
  for (const ref of refs) {
    if (!ref.listing_snapshot_id || saved.has(hash(ref))) continue;
    const snapshot = await ctx.get('commerce', 'listing_snapshot', ref.listing_snapshot_id);
    if (snapshot && isEstimatedPrice(snapshot.data)) fail('invalid_product_reference', 'Exchange-rate estimates cannot be inserted as listing prices');
  }
}
