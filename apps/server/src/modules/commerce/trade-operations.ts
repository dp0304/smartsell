import { queueManualExternalWork } from '../../integration/manual-external-work.js';
import { isDeepStrictEqual } from 'node:util';
import { type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';
import { bool, conflict, currency, enumValue, integer, invalid, object, objects, optional, requirePhase, strings, text, timestamp, upsert } from './domain.js';
import { COMMERCE_WRITE, unavailable, type CommerceServices } from './store-operations.js';

const ORDER_READ = ['owner', 'admin', 'manager', 'analyst'] as const;
const state = (row: Row, now: string) => ['draft', 'cancelled'].includes(String(row.state)) ? row.state : now < String(row.valid_from) ? 'scheduled' : now >= String(row.valid_until) ? 'expired' : 'active';
function promotionView(ctx: Context, row: Row): Data {
  const codes = ctx.list('promotion_code').filter(code => code.promotion_id === row.id);
  const usageCount = new Set(ctx.list('discount_usage').filter(usage => usage.promotion_id === row.id).map(usage => usage.order_id)).size;
  const current = state(row, ctx.now);
  return { ...row, state: current, codes, usage_count: usageCount, offer_verified: current === 'active' && row.verified_at != null };
}
function savePromotion(ctx: Context, body: Data, previous?: Row): Data {
  const store = ctx.get('store', previous ? String(previous.store_id) : text(body.store_id, 'store_id'));
  const validFrom = timestamp(body.valid_from ?? previous?.valid_from, 'valid_from');
  const validUntil = timestamp(body.valid_until ?? previous?.valid_until, 'valid_until');
  if (validUntil <= validFrom) invalid('valid_until');
  const campaignId = 'campaign_id' in body ? optional(body.campaign_id, 'campaign_id') : previous?.campaign_id ?? null;
  if (typeof campaignId === 'string') ctx.get('campaign', campaignId);
  const markets = body.market_ids == null ? previous?.market_ids ?? [] : strings(body.market_ids, 'market_ids');
  for (const market of markets as string[]) ctx.get('market', market);
  const rule: Data = { ...object(body.rule ?? previous?.rule, 'rule') };
  if (rule.percent_off != null) {
    const percent = integer(rule.percent_off, 'percent_off', 1);
    if (percent > 100) invalid('percent_off');
    rule.percent_off = percent;
  }
  for (const key of ['amount_off_minor', 'minimum_spend_minor', 'minimum_quantity']) if (rule[key] != null) rule[key] = integer(rule[key], key, 1);
  if (rule.amount_off_minor != null || rule.minimum_spend_minor != null) rule.currency = currency(rule.currency ?? store.default_currency);
  if (rule.product_ids != null) {
    rule.product_ids = strings(rule.product_ids, 'product_ids');
    for (const id of rule.product_ids as string[]) if (ctx.get('product', id).store_id !== store.id) invalid('product_ids');
  }
  if (rule.components != null) {
    requirePhase(ctx, 'p2');
    const parts = objects(rule.components, 'components');
    if (parts.length < 2) invalid('components');
    rule.components = parts.map(part => {
      const percent = part.percent_off == null ? null : integer(part.percent_off, 'percent_off', 1);
      if (percent != null && percent > 100) invalid('percent_off');
      const amount = part.amount_off_minor == null ? null : integer(part.amount_off_minor, 'amount_off_minor', 1);
      if ((percent == null) === (amount == null)) invalid('components');
      return { percent_off: percent, amount_off_minor: amount };
    });
  }
  const externalId = 'external_discount_id' in body ? optional(body.external_discount_id, 'external_discount_id') : previous?.external_discount_id ?? null;
  if (externalId && ctx.list('promotion').some(row => row.store_id === store.id && row.external_discount_id === externalId && row.id !== previous?.id)) conflict('duplicate_promotion', 'External discount already exists for this store');
  const codes = body.codes == null ? undefined : objects(body.codes, 'codes').map(code => ({ code: text(code.code, 'code', 128), external_id: optional(code.external_id, 'external_id'), assigned_to: optional(code.assigned_to, 'assigned_to'), usage_limit: code.usage_limit == null ? null : integer(code.usage_limit, 'usage_limit', 1) }));
  if (codes && new Set(codes.map(code => code.code)).size !== codes.length) invalid('duplicate promotion code');
  const requested = enumValue(body.state ?? previous?.state ?? 'draft', ['draft', 'scheduled', 'active', 'expired', 'cancelled'], 'state');
  const planState = requested === 'draft' || requested === 'cancelled' ? requested : ctx.now < validFrom ? 'scheduled' : ctx.now >= validUntil ? 'expired' : 'active';
  const saved = upsert(ctx, 'promotion', previous, { store_id: store.id, name: text(body.name ?? previous?.name, 'name'), campaign_id: campaignId, market_ids: markets, rule, external_discount_id: externalId, valid_from: validFrom, valid_until: validUntil, state: planState, verified_at: null, verification_status: null });
  if (codes) {
    const current = ctx.list('promotion_code').filter(row => row.promotion_id === saved.id);
    for (const prior of current) if (!codes.some(item => item.code === prior.code)) ctx.remove('promotion_code', prior.id);
    for (const code of codes) upsert(ctx, 'promotion_code', current.find(item => item.code === code.code), { ...code, promotion_id: saved.id });
  }
  ctx.emit(planState === 'expired' ? 'commerce.promotion.expired' : 'commerce.promotion.changed', { promotion_id: saved.id, store_id: store.id, state: planState });
  return promotionView(ctx, saved);
}
const metadataFields = ['id', 'version', 'created_at', 'updated_at'];
function selected(row: Row, fields: string[]): Data {
  return Object.fromEntries([...metadataFields, ...fields].filter(field => row[field] !== undefined).map(field => [field, row[field]]));
}
function refundView(row: Row): Data {
  const view = selected(row, ['store_id', 'order_id', 'external_refund_id', 'currency', 'amount_minor', 'status', 'source_created_at', 'source_updated_at']);
  if (Array.isArray(row.lines)) view.lines = row.lines.map(line => Object.fromEntries(['external_line_id', 'amount_minor', 'quantity'].filter(field => line[field] !== undefined).map(field => [field, line[field]])));
  return view;
}
function orderView(ctx: Context, order: Row, detail = false): Data {
  const refunds = ctx.list('refund').filter(row => row.order_id === order.id);
  const settled = refunds.filter(row => row.status === 'succeeded').reduce((sum, row) => sum + Number(row.amount_minor), 0);
  const store = ctx.get('store', String(order.store_id));
  const view = selected(order, ['store_id', 'external_order_id', 'placed_at', 'currency', 'total_minor', 'subtotal_minor', 'discount_minor', 'tax_minor', 'shipping_minor', 'source_updated_at', 'cancelled_at', 'financial_status', 'fulfillment_status']);
  if (store.provider !== 'amazon_sp' && order.utm && typeof order.utm === 'object') {
    const utm = order.utm as Data;
    view.utm = Object.fromEntries(['source', 'medium', 'campaign', 'term', 'content'].filter(key => typeof utm[key] === 'string').map(key => [key, utm[key]]));
  }
  const related = (kind: string, fields: string[]): Data[] => ctx.list(kind).filter(row => row.order_id === order.id).map(row => selected(row, fields));
  return { ...view, succeeded_refund_minor: settled, recorded_total_less_refund_minor: Number(order.total_minor) - settled,
    ...(detail ? {
      refunds: refunds.map(refundView),
      shipments: related('order_shipment', ['external_shipment_id', 'status', 'observed_at', 'source']),
      lines: related('order_line', ['external_line_id', 'variant_id', 'quantity', 'unit_price_minor', 'discount_minor']),
      transactions: related('payment_transaction', ['external_transaction_id', 'kind', 'status', 'amount_minor', 'processed_at']),
      discounts: store.provider === 'amazon_sp' ? [] : related('discount_usage', ['code', 'promotion_id', 'amount_minor']),
    } : {}) };
}
function orders(ctx: Context, input: Input): Row[] {
  requirePhase(ctx, 'p1');
  const filters = { ...input.body, ...input.query };
  const since = filters.since == null ? null : timestamp(filters.since, 'since');
  const until = filters.until == null ? null : timestamp(filters.until, 'until');
  if (since && until && since >= until) invalid('until');
  return ctx.list('order').filter(row => (!filters.store_id || row.store_id === filters.store_id) && (!since || String(row.placed_at) >= since) && (!until || String(row.placed_at) < until) && (!filters.financial_status || row.financial_status === filters.financial_status));
}
export function tradeOperations(services: CommerceServices): Operation[] {
  return [
    { path: '/promotions', method: 'GET', name: 'commerce_promotion_list', roles: COMMERCE_WRITE, summary: 'List local promotion plans and observed usage', run(ctx, { query }) { requirePhase(ctx, 'p1'); return ctx.list('promotion').filter(row => (!query.store_id || query.store_id === row.store_id) && (!query.campaign_id || query.campaign_id === row.campaign_id)).map(row => promotionView(ctx, row)); } },
    { path: '/promotions', method: 'POST', name: 'commerce_promotion_create', roles: COMMERCE_WRITE, summary: 'Create an internal promotion plan', run(ctx, { body }) { requirePhase(ctx, 'p1'); return savePromotion(ctx, body); } },
    { path: '/promotions/:id', method: 'GET', name: 'promotion_get', roles: COMMERCE_WRITE, summary: 'Read promotion rule, validity, discount codes and usage', run(ctx, { params, body }) {
      requirePhase(ctx, 'p1');
      if (!params.id && body.campaign_id != null && body.promotion_id == null) return ctx.list('promotion').filter(row => row.campaign_id === body.campaign_id).map(row => promotionView(ctx, row));
      return promotionView(ctx, ctx.get('promotion', params.id ?? text(body.promotion_id, 'promotion_id')));
    } },
    { path: '/promotions/:id', method: 'PATCH', name: 'commerce_promotion_update', roles: COMMERCE_WRITE, versionKind: 'promotion', summary: 'Change a local promotion rule', run(ctx, { params, body }) { requirePhase(ctx, 'p1'); return savePromotion(ctx, body, ctx.get('promotion', params.id!)); } },
    { path: '/promotions/:id', method: 'DELETE', name: 'commerce_promotion_cancel', roles: COMMERCE_WRITE, versionKind: 'promotion', summary: 'Cancel a local promotion and preserve usage history', run(ctx, { params }) {
      requirePhase(ctx, 'p1'); const row = ctx.get('promotion', params.id!);
      if (row.state === 'cancelled') return row;
      const saved = ctx.update('promotion', row.id, { state: 'cancelled' });
      ctx.emit('commerce.promotion.changed', { promotion_id: row.id, state: 'cancelled' });
      return saved;
    } },
    { path: '/promotions/:id/verify', method: 'POST', name: 'commerce_promotion_verify', roles: COMMERCE_WRITE, versionKind: 'promotion', external: Boolean(services.readPromotion), summary: 'Verify an offer and check its advertised code and discount', async run(ctx, { params, body }) {
      requirePhase(ctx, 'p1');
      const row = ctx.get('promotion', params.id!);
      if (!row.external_discount_id) conflict('offer_not_linked', 'Link the store offer before verifying');
      const store = ctx.get('store', String(row.store_id));
      if (!['shopify', 'shopee', 'lazada'].includes(String(store.provider)) || !services.readPromotion) return unavailable('Promotion readback adapter is unavailable');
      const claim = body.copy_claim == null ? null : object(body.copy_claim, 'copy_claim');
      const canonicalCode = (code: string) => store.provider === 'shopify' ? code.toUpperCase() : code;
      const claimedCode = claim && canonicalCode(text(claim.code, 'code', 128));
      const claimedPercent = claim && integer(claim.percent_off, 'percent_off', 1);
      if (claimedPercent !== null && claimedPercent > 100) invalid('percent_off');
      const codes = ctx.list('promotion_code').filter(item => item.promotion_id === row.id).map(item => canonicalCode(String(item.code))).sort();
      const observed = await services.readPromotion(ctx, store, String(row.external_discount_id));
      const observedCodes = observed?.codes.map(canonicalCode).sort() ?? [];
      const current = state(row, ctx.now);
      const matches = observed && isDeepStrictEqual(observed.rule, row.rule) && timestamp(observed.valid_from, 'valid_from') === row.valid_from &&
        timestamp(observed.valid_until, 'valid_until') === row.valid_until && isDeepStrictEqual(observedCodes, codes) &&
        (!observed.status || current === 'draft' || current === 'cancelled' || observed.status.toLowerCase() === current);
      const active = matches && current === 'active';
      const verified = ctx.update('promotion', row.id, { verified_at: active ? ctx.now : null, verification_status: matches ? 'verified' : 'mismatch' });
      ctx.emit('commerce.promotion.changed', { promotion_id: row.id, store_id: store.id, verification_status: verified.verification_status });
      const copyConflicts = claim && [
        ...(!active ? ['offer_unverified'] : []),
        ...(observed && !observedCodes.includes(claimedCode!) ? ['code'] : []),
        ...(observed && observed.rule.percent_off !== claimedPercent ? ['percent_off'] : []),
      ];
      return { ...promotionView(ctx, verified), ...(copyConflicts && { copy_conflicts: copyConflicts }) };
    } },
    { path: '/localizations/:id/writeback', method: 'POST', name: 'commerce_localization_writeback', roles: ['owner', 'admin', 'manager', 'reviewer'], external: Boolean(services.writeLocalization), versionKind: 'product_localization', summary: 'Write approved localization and verify the result', async run(ctx, { params }) {
      requirePhase(ctx, 'p1');
      const row = ctx.get('product_localization', params.id!);
      if (row.status !== 'approved') conflict('localization_not_approved', 'Localization must be approved');
      const product = ctx.get('product', String(row.product_id));
      const store = ctx.get('store', String(product.store_id));
      if (!services.writeLocalization) {
        const revision = ctx.get('product_localization_revision', String(row.approved_revision_id));
        const task = queueManualExternalWork(ctx, { key: `localization:${row.id}:${revision.id}`, title: 'Apply approved localization and verify store readback',
          resourceType: 'product_localization', resourceId: row.id, brandId: product.brand_id,
          event: 'commerce.localization.manual_required', references: { product_id: product.id, localization_id: row.id, revision_id: revision.id } });
        return { status: 'manual_required', work_item_id: task.id, revision_id: revision.id };
      }
      if (!['shopify', 'amazon_sp'].includes(String(store.provider))) return unavailable('Localization writeback adapter is unavailable');
      if (!store.connection_id || !product.external_product_id || !['title', 'description'].includes(String(row.field_key))) conflict('writeback_not_supported', 'Approved field lacks a mapped store product');
      const revision = ctx.get('product_localization_revision', String(row.approved_revision_id));
      const observed = await services.writeLocalization(ctx, store, { externalProductId: String(product.external_product_id), field: String(row.field_key), locale: String(row.locale), marketId: row.market_id == null ? null : String(row.market_id), text: String(revision.text), sourceHash: text((row.source_ref as Data).content_hash, 'source_hash') });
      const verified = observed.readbackText === revision.text;
      const result = ctx.create('localization_writeback', { localization_id: row.id, revision_id: revision.id, status: verified ? 'verified' : 'failed', verified_at: verified ? ctx.now : null, error: verified ? null : 'readback_mismatch' });
      ctx.update('product_localization', row.id, { writeback_status: result.status });
      return result;
    } },
    { path: '/localizations/:id/export', method: 'GET', name: 'commerce_localization_export', roles: COMMERCE_WRITE, summary: 'Export the approved localization for manual delivery', run(ctx, { params }) {
      const row = ctx.get('product_localization', params.id!);
      if (row.status !== 'approved' || !row.approved_revision_id) conflict('localization_not_approved', 'Localization must be approved against the current source');
      const revision = ctx.get('product_localization_revision', String(row.approved_revision_id));
      return { product_id: row.product_id, field_key: row.field_key, locale: row.locale, market_id: row.market_id, text: revision.text, revision_id: revision.id };
    } },
    { path: '/orders', method: 'GET', name: 'commerce_order_list', roles: ORDER_READ, summary: 'Read store order facts', run: (ctx, input) => orders(ctx, input).map(row => orderView(ctx, row)) },
    { path: '/orders/:id', method: 'GET', name: 'commerce_order_get', roles: ORDER_READ, summary: 'Read an order and separate settlement facts', run(ctx, { params }) { requirePhase(ctx, 'p1'); return orderView(ctx, ctx.get('order', params.id!), true); } },
    { path: '/refunds', method: 'GET', name: 'commerce_refund_list', roles: ORDER_READ, summary: 'Read refund facts including pending refunds', run(ctx, { query }) {
      requirePhase(ctx, 'p1'); return ctx.list('refund').filter(row => (!query.store_id || query.store_id === row.store_id) && (!query.order_id || query.order_id === row.order_id) && (!query.status || query.status === row.status));
    } },
    { path: '/orders/summary', method: 'GET', name: 'orders_summary', roles: ORDER_READ, summary: 'Aggregate recorded order and succeeded refund amounts by currency', run(ctx, input) {
      const totals = new Map<unknown, { currency: unknown; orders: number; order_total_minor: number; succeeded_refund_minor: number; recorded_total_less_refund_minor: number }>();
      const filters = { ...input.body, ...input.query };
      let allowedOrders: Set<unknown> | undefined;
      if (filters.product_id) {
        const product = ctx.get('product', text(filters.product_id, 'product_id'));
        const ids = new Set(ctx.list('product_variant').filter(row => row.product_id === product.id).map(row => row.id));
        allowedOrders = new Set(ctx.list('order_line').filter(row => ids.has(String(row.variant_id))).map(row => row.order_id));
      }
      if (filters.campaign_id) {
        const campaign = ctx.get('campaign', text(filters.campaign_id, 'campaign_id'));
        const promotionIds = new Set(ctx.list('promotion').filter(row => row.campaign_id === campaign.id).map(row => row.id));
        const attributed = new Set(ctx.list('discount_usage').filter(row => promotionIds.has(String(row.promotion_id))).map(row => row.order_id));
        allowedOrders = allowedOrders ? new Set([...allowedOrders].filter(id => attributed.has(id))) : attributed;
      }
      for (const order of orders(ctx, input)) {
        if (allowedOrders && !allowedOrders.has(order.id)) continue;
        const summary = totals.get(order.currency) ?? { currency: order.currency, orders: 0, order_total_minor: 0, succeeded_refund_minor: 0, recorded_total_less_refund_minor: 0 };
        const view = orderView(ctx, order);
        summary.orders++;
        summary.order_total_minor += Number(order.total_minor);
        summary.succeeded_refund_minor += Number(view.succeeded_refund_minor);
        summary.recorded_total_less_refund_minor += Number(view.recorded_total_less_refund_minor);
        totals.set(order.currency, summary);
      }
      return { as_of: ctx.now, coverage: 'recorded_only', currencies: [...totals.values()] };
    } },
    { path: '/inventory-rules', method: 'GET', name: 'commerce_inventory_rule_list', roles: COMMERCE_WRITE, summary: 'Read configured inventory response rules', run(ctx) { requirePhase(ctx, 'p2'); return ctx.list('inventory_rule'); } },
    { path: '/inventory-rules', method: 'POST', name: 'commerce_inventory_rule_create', roles: COMMERCE_WRITE, summary: 'Configure an inventory notification or pause rule', run(ctx, { body }) {
      requirePhase(ctx, 'p2');
      const variant = ctx.get('product_variant', text(body.variant_id, 'variant_id'));
      const market = ctx.get('market', text(body.market_id, 'market_id'));
      if (!ctx.list('store_market').some(row => row.store_id === variant.store_id && row.market_id === market.id && row.enabled === true)) invalid('store_market');
      const action = enumValue(body.action, ['notify', 'pause_targets'], 'action');
      return ctx.create('inventory_rule', { variant_id: variant.id, market_id: market.id, condition: 'out_of_stock', action, resume_condition: 'became_available', enabled: bool(body.enabled ?? true, 'enabled') });
    } },
  ];
}
