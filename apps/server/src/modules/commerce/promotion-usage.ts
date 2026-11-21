import type { Context, Data, Row } from '@smartsell/contracts';
import { text } from './domain.js';

/** Attribute provider-observed coupon codes only when the same store and order date identify one linked offer. */
export function observeShopifyCoupons(ctx: Context, store: Row, placedAt: string, observedCodes: string[], existing?: Row) {
  const codes = [...new Set(observedCodes.map(code => text(code, 'code', 128).toUpperCase()))].sort();
  if (!codes.length) return [];
  const eligible = new Set(ctx.list('promotion').filter(promotion => promotion.store_id === store.id && promotion.external_discount_id &&
    String(promotion.valid_from) <= placedAt && placedAt < String(promotion.valid_until)).map(row => row.id));
  const linked = ctx.list('promotion_code').filter(code => eligible.has(String(code.promotion_id)));
  const previous = existing && (existing.source as Data | undefined)?.kind === 'store_sync' ? ctx.list('discount_usage')
    .filter(usage => usage.order_id === existing.id && usage.amount_minor === null && typeof usage.promotion_id === 'string') : [];
  return codes.map(code => {
    const pinned = previous.find(usage => usage.code === code);
    const matching = new Set(linked.filter(row => String(row.code).toUpperCase() === code).map(row => String(row.promotion_id)));
    // Preserve a pinned attribution while the provider still reports the code for this order.
    // Order-level discount totals cannot be allocated across coupon codes.
    return { code, amount_minor: null, promotion_id: pinned?.promotion_id ?? (matching.size === 1 ? [...matching][0] : null) };
  });
}
