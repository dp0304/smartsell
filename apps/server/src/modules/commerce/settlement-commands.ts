import { admins, DomainError, type Commands, type Context, type Fields } from '../types';
import { normalizeSettlementRow } from './csv-import';
import { plan } from './csv-planner';
import { active, bad, guard, hash, id, instant, list, obj, one, store } from './model';

/** Local sink for normalized provider facts. Caller supplies projected DTOs. */
export async function applySettlementRows(ctx: Context, input: Fields) {
  const storeId = id(input.store_id, 'store_id');
  const key = one(input.template_key, 'template_key', ['order_list', 'refund_list']);
  if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 1000) return bad('rows');
  await guard(ctx, storeId);
  const s = await store(ctx, storeId);
  if (s.data.provider === 'file_import') throw new DomainError('provider_unavailable', 'Settlement synchronization requires a supported platform store');
  const rows = input.rows.map((input: unknown, index: number) => normalizeSettlementRow(obj(input, 'row'), key, s.data.provider, s.data.default_currency, index + 1));
  const result = await plan(ctx, s, hash(rows), key, rows, [], 'store_sync');
  if (result.counts.invalid) return { status: 'invalid', counts: result.counts, issues: result.issues };
  await result.view.persist();
  return { status: 'applied', counts: result.counts, issues: result.issues };
}

export const settlementCommands: Commands = {
  apply_settlement_rows: { roles: admins, run: applySettlementRows },
  orders_summary: { roles: admins, async run(ctx, input) {
    const storeId = input.store_id == null ? undefined : id(input.store_id, 'store_id');
    if (storeId) await store(ctx, storeId, false);
    const since = input.since === undefined ? undefined : instant(input.since, 'since');
    const until = input.until === undefined ? undefined : instant(input.until, 'until');
    if (since && until && since >= until) return bad('until');
    const dateMatches = (value: string) => (!since || value >= since) && (!until || value < until);
    const settled = new Set(['paid', 'partially_refunded', 'refunded']);
    const currencies = new Map<string, { currency: string; recorded_orders: number; paid_order_total_minor: number; succeeded_refund_minor: number }>();
    function bucket(code: string) {
      const value = currencies.get(code) ?? { currency: code, recorded_orders: 0, paid_order_total_minor: 0, succeeded_refund_minor: 0 };
      currencies.set(code, value);
      return value;
    }
    const eligible = (await list(ctx, 'order')).filter(row => active(row) && (!storeId || row.data.store_id === storeId));
    const authorizedOrders = new Set(eligible.map(order => order.id));
    for (const order of eligible.filter(row => dateMatches(row.data.placed_at))) {
      const values = bucket(order.data.currency);
      values.recorded_orders++;
      if (settled.has(order.data.financial_status)) values.paid_order_total_minor += order.data.total_minor;
    }
    for (const refund of await list(ctx, 'refund')) {
      if (active(refund) && refund.data.status === 'succeeded' && authorizedOrders.has(refund.data.order_id) && dateMatches(refund.data.created_at)) {
        bucket(refund.data.currency).succeeded_refund_minor += refund.data.amount_minor;
      }
    }
    return { as_of: ctx.now, coverage: 'recorded_only', currencies: [...currencies.values()].map(total => {
      if (![total.paid_order_total_minor, total.succeeded_refund_minor].every(Number.isSafeInteger)) return bad('summary amount');
      return { ...total, paid_total_less_refund_minor: total.paid_order_total_minor - total.succeeded_refund_minor };
    }) };
  } },
};
