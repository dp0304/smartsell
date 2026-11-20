import { DomainError, text, type Commands } from '../types.js';
import { canonicalOrderFacts, canonicalOrders, parseSalesQuery, revenueQuery } from './sales.js';
import { attestedHistoryStart, cohortHistory, cohortLimitations, firstPurchase } from './cohort-history.js';
import { choice, currency, cutoff, date, inPeriod, instant, integer, invalid, localDay, moduleKey, object, period, ref, revenueRoles, safeNumber } from './shared.js';

const costItems = ['product_cost', 'shipping', 'payment_fees', 'ad_spend', 'fixed_collaboration_fees', 'commission', 'samples_and_production'] as const;
const eligibleStatuses = new Set(['paid', 'partially_paid', 'partially_refunded']);
const interpretation = 'Estimated contribution. Financial profit and payable commissions require separate accounting.';

export const commerceInsightCommands: Commands = {
  import_unit_costs: { roles: revenueRoles, async run(ctx, input) {
    if (!Array.isArray(input.rows) || input.rows.length < 1 || input.rows.length > 500) invalid('Provide 1–500 cost rows');
    const asOf = cutoff(ctx, undefined);
    const inserted = [];
    for (const raw of input.rows) {
      const item = object(raw, 'cost row');
      const product_variant_id = text(item, 'product_variant_id', 200);
      const variant = await ctx.get('commerce', 'product_variant', product_variant_id);
      if (!variant || variant.data.rolled_back) throw new DomainError('not_found', 'Commerce variant not found', 404);
      const code = currency(item.currency);
      const valid_from = date(item.valid_from, 'valid_from');
      const cost_minor = integer(item.cost_minor, 'cost_minor');
      const payload = { product_variant_id, currency: code, valid_from, cost_minor, source: choice(item.source ?? 'manual', ['manual', 'import', 'erp'], 'source'), source_ref: text(item, 'source_ref', 200), recorded_at: asOf };
      const id = JSON.stringify([product_variant_id, code, valid_from]);
      const old = await ctx.get(moduleKey, 'unit_cost_version', id);
      if (old) {
        if (old.data.cost_minor !== cost_minor) throw new DomainError('cost_conflict', 'A different cost is already set on this date', 409);
      } else inserted.push(await ctx.insert(moduleKey, 'unit_cost_version', payload, id));
    }
    if (inserted.length) await ctx.emit('analytics.unit_costs.recorded', { count: inserted.length });
    return { items: inserted };
  } },
  record_contribution_cost: { roles: revenueRoles, async run(ctx, input) {
    const scope = text(input, 'scope', 150);
    const item = choice(input.item, costItems, 'item');
    const code = currency(input.currency);
    const window = period(input.period);
    const settlement_id = text(input, 'settlement_id', 200);
    const amount_minor = integer(input.amount_minor, 'amount_minor');
    if (typeof input.complete !== 'boolean') invalid('Confirm whether the cost is complete');
    const id = JSON.stringify([scope, code, window, settlement_id]);
    const old = await ctx.get(moduleKey, 'contribution_input', id);
    if (old) {
      if (old.data.item !== item || old.data.amount_minor !== amount_minor || old.data.complete !== input.complete) throw new DomainError('settlement_conflict', 'The cost settlement is already recorded', 409);
      return old;
    }
    const row = await ctx.insert(moduleKey, 'contribution_input', { scope, item, currency: code, period: window, settlement_id, amount_minor, complete: input.complete }, id);
    await ctx.emit('analytics.contribution_cost.recorded', { cost_id: row.id, item });
    return row;
  } },
  contribution_query: { roles: revenueRoles, async run(ctx, input) {
    const scope = text(input, 'scope', 150);
    const code = currency(input.currency);
    const parsed = parseSalesQuery({ ...input, report_currency: code });
    const asOf = cutoff(ctx, input.data_cutoff_at);
    const sales = await revenueQuery(ctx, parsed, asOf);
    const data = sales.rows;
    const netSales = data.map(row => row.conversion?.amounts_minor.net_sales_minor ?? null);
    const sum = (amounts: number[]) => safeNumber(amounts.reduce((total, item) => total + BigInt(item), 0n));
    const net = data.length && data.every(row => row.coverage.orders === 1) && netSales.every(amount => amount !== null) ? sum(netSales as number[]) : null;
    const inputs = (await ctx.list(moduleKey, 'contribution_input')).filter(row => instant(row.created_at, 'created_at') <= asOf && row.data.scope === scope && row.data.currency === code && row.data.period.from === parsed.period.from && row.data.period.to === parsed.period.to);
    const items = costItems.map(item => {
      const matched = inputs.filter(row => row.data.item === item);
      return { item, amount_minor: matched.length && matched.every(row => row.data.complete) ? sum(matched.map(row => row.data.amount_minor)) : null, evidence: matched.map(ref) };
    });
    const values = [{ item: 'net_sales', amount_minor: net, evidence: data.flatMap(row => row.evidence) }, ...items];
    const missing_items = values.filter(item => item.amount_minor === null).map(item => item.item);
    return { scope, period: parsed.period, currency: code, as_of: asOf, formula_version: 1, items: values, missing_items,
      value_minor: missing_items.length ? null : safeNumber(BigInt(net!) - BigInt(sum(items.map(item => item.amount_minor!)))), warnings: sales.warnings, interpretation };
  } },
  cohorts_list: { roles: revenueRoles, async run(ctx, input) {
    const query = parseSalesQuery(input);
    const observation_days = integer(input.observation_days ?? 90, 'observation_days', 1);
    if (observation_days > 730) invalid('Observation window must be at most 730 days');
    const history_months = integer(input.history_months ?? 3, 'history_months', 1);
    if (history_months > 24) invalid('History window must be at most 24 months');
    const asOf = cutoff(ctx, input.data_cutoff_at);
    const [stores, orders, customers, refunds, coverage] = await Promise.all([ctx.list('commerce', 'store'), ctx.list('commerce', 'order'), ctx.list('commerce', 'store_customer'), ctx.list('commerce', 'refund'), ctx.list('commerce', 'coverage_segment')]);
    const current = <T extends { data: Record<string, any>; updated_at: string }>(row: T) => !row.data.rolled_back && instant(row.updated_at, 'updated_at') <= asOf;
    const { orders: purchases, orderAliases } = canonicalOrders(orders.filter(row => current(row) && row.data.placed_at && instant(row.data.placed_at, 'placed_at') <= asOf));
    const recordedRefunds = canonicalOrderFacts(refunds.filter(row => current(row) && row.data.created_at && instant(row.data.created_at, 'created_at') <= asOf), orderAliases, 'external_refund_id');
    const refunded = new Map<string, bigint>();
    for (const row of recordedRefunds.filter(row => row.data.status === 'succeeded')) {
      const key = JSON.stringify([row.data.order_id, row.data.currency]);
      refunded.set(key, (refunded.get(key) ?? 0n) + BigInt(row.data.amount_minor));
    }
    return { observation_days, history_months, as_of: asOf, items: stores.filter(row => current(row) && (!query.store_ids || query.store_ids.includes(row.id))).map(store => {
      const windows = coverage.filter(row => current(row) && row.data.active !== false && row.data.store_id === store.id && row.data.resource === 'orders').map(row => row.data);
      const through = query.period.to < asOf ? query.period.to : asOf;
      const start = store.data.history_coverage_from ?? attestedHistoryStart(windows, through);
      const history = cohortHistory(store.data.provider, start, asOf, history_months);
      const limitations = new Set(cohortLimitations(history, query.period.from));
      const verified = new Set(customers.filter(row => current(row) && row.data.store_id === store.id && row.data.identity_verified === true).map(row => row.id));
      const groups = new Map<string, { count: number; mature: number; retained: number; confirmed: number; limitations: Set<string> }>();
      const byCustomer = new Map<string, typeof orders>();
      let unidentified_orders = 0;
      for (const order of purchases.filter(row => row.data.store_id === store.id && eligibleStatuses.has(row.data.financial_status) && !row.data.cancelled_at)) {
        const placed = instant(order.data.placed_at, 'placed_at');
        const succeeded = refunded.get(JSON.stringify([order.id, order.data.currency])) ?? 0n;
        if (succeeded >= BigInt(order.data.total_minor)) continue;
        const customer = order.data.store_customer_id;
        if (history.excluded || !verified.has(customer)) { if (inPeriod(placed, query.period)) unidentified_orders++; continue; }
        const entries = byCustomer.get(customer) ?? [];
        entries.push(order);
        byCustomer.set(customer, entries);
      }
      for (const entries of byCustomer.values()) {
        entries.sort((a, b) => instant(a.data.placed_at, 'placed_at').localeCompare(instant(b.data.placed_at, 'placed_at')));
        const first = entries[0]!;
        const when = instant(first.data.placed_at, 'placed_at');
        if (!inPeriod(when, query.period)) continue;
        const key = localDay(when, query.period.tz).slice(0, 7);
        const evidence = firstPurchase(when, first.data.customer_order_index, history);
        if (evidence.knownReturning) continue;
        const counts = groups.get(key) ?? { count: 0, mature: 0, retained: 0, confirmed: 0, limitations: new Set<string>() };
        const end = Date.parse(when) + observation_days * 86400000;
        counts.count++;
        if (evidence.reason) {
          counts.limitations.add(evidence.reason);
          limitations.add(evidence.reason);
        } else counts.confirmed++;
        if (end <= Date.parse(asOf)) {
          counts.mature++;
          if (entries.slice(1).some(row => Date.parse(row.data.placed_at) < end)) counts.retained++;
        }
        groups.set(key, counts);
      }
      return { store_id: store.id, store_name: store.data.name, provider: store.data.provider, ...history, unidentified_orders, limitations: [...limitations],
        rows: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([month, { limitations, ...totals }]) => ({ month, ...totals, limitations: [...limitations],
          new_customer_reliability: totals.confirmed === totals.count ? 'high' : 'low', repeat_rate: totals.mature === totals.count ? totals.retained / totals.mature : null })) };
    }) };
  } },
};
