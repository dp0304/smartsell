import { type Context, type Data, type Row } from '@smartsell/contracts';
import { consentedTouchpoints } from './traffic.ts';
import { array, choice, conflict, currency, date, dto, factDate, inPeriod, invalid, localDay, minor, object, optionalString, period, strings, text } from './validation.ts';

export const models = ['link_session', 'discount_code', 'first_touch', 'last_touch', 'linear', 'platform_reported', 'external_service'] as const;
type Model = typeof models[number];
const reported = (model: Model) => model === 'platform_reported' || model === 'external_service';
const modelFields = ['key', 'revision', 'window_days', 'reconcilable'];
const recordFields = ['order_id', 'store_id', 'model_key', 'revision', 'window_days', 'reconcilable', 'run_id', 'status', 'currency',
  'credited_subject_type', 'credited_subject_id', 'weight', 'credited_amount_minor', 'net_of_refunds_minor', 'evidence'];
export function attributionModels(ctx: Context) {
  const revisions = ctx.list('attribution_model');
  return models.map(key => {
    const row = revisions.filter(row => row.key === key).sort((a, b) => Number(b.revision) - Number(a.revision))[0];
    return row ? dto(row, modelFields) : { key, revision: 1, window_days: 30, reconcilable: !reported(key) };
  });
}
export function reviseModel(ctx: Context, body: Data, id?: string) {
  const key = choice(id ?? body.key, models, 'model');
  if (!minor(body.window_days) || body.window_days < 1 || body.window_days > 365) invalid('Window must be 1–365 days');
  const current = attributionModels(ctx).find(model => model.key === key)!;
  return dto(ctx.create('attribution_model', { key, revision: Number(current.revision) + 1, window_days: body.window_days, reconcilable: !reported(key) }), modelFields);
}

function distinct(rows: Row[], key: (row: Row) => string): Row[] {
  const unique = new Map<string, Row>();
  for (const row of rows) {
    const id = key(row), previous = unique.get(id);
    if (!previous || row.updated_at > previous.updated_at || (row.updated_at === previous.updated_at && row.id < previous.id)) unique.set(id, row);
  }
  return [...unique.values()];
}
function sum(values: unknown[]): number | null {
  let total = 0;
  for (const value of values) { if (!minor(value) || !Number.isSafeInteger(total + value)) return null; total += value; }
  return total;
}
export function orders(ctx: Context) {
  return distinct(ctx.list('order'), row => JSON.stringify([row.store_id, row.external_order_id ?? row.id]));
}
function covered(ctx: Context, store: unknown, resource: string, range: { from: string; to: string }): boolean {
  const sourceIds = new Set(ctx.list('data_source').filter(row => row.store_id === store).map(row => row.id));
  const bounds = ctx.list('coverage_segment').filter(row => row.resource === resource && row.active !== false && (row.store_id === store || sourceIds.has(String(row.data_source_id))))
    .map(row => ({ status: row.status, from: factDate(row.window_start ?? row.period_start), to: factDate(row.window_end ?? row.period_end) }))
    .filter((row): row is { status: unknown; from: string; to: string } => !!row.from && !!row.to && row.from < range.to && row.to > range.from)
    .sort((a, b) => a.from.localeCompare(b.from));
  if (bounds.some(row => row.status !== 'complete')) return false;
  let cursor = range.from;
  for (const row of bounds) {
    if (row.from > cursor) break;
    if (row.to > cursor) cursor = row.to;
  }
  return cursor >= range.to;
}
function orderRecordIds(ctx: Context, order: Row) {
  return new Set(ctx.list('order').filter(row => row.id === order.id || (order.external_order_id != null && row.store_id === order.store_id
    && row.external_order_id === order.external_order_id)).map(row => row.id));
}
export function orderRefunds(ctx: Context, order: Row, eligible: (row: Row) => boolean = () => true) {
  const ids = orderRecordIds(ctx, order);
  return distinct(ctx.list('refund').filter(row => ids.has(String(row.order_id)) && eligible(row)), row => String(row.external_refund_id ?? row.id));
}
function orderFacts(ctx: Context, order: Row) {
  const ids = orderRecordIds(ctx, order);
  const refunds = orderRefunds(ctx, order);
  const transactions = distinct([...ctx.list('transaction'), ...ctx.list('payment_transaction')].filter(row => ids.has(String(row.order_id))), row => String(row.external_transaction_id ?? row.id));
  const from = factDate(order.placed_at), to = date(ctx.now);
  const currency_matches = (row: Row) => row.currency === undefined || row.currency === order.currency;
  const refundComplete = !!from && from < to && covered(ctx, order.store_id, 'refunds', { from, to });
  const paymentsComplete = !!from && from < to && (covered(ctx, order.store_id, 'transactions', { from, to }) || covered(ctx, order.store_id, 'payment_transactions', { from, to }));
  const succeeded = sum(refunds.filter(row => row.status === 'succeeded').map(row => currency_matches(row) ? row.amount_minor : null));
  const requested = sum(refunds.filter(row => ['requested', 'pending'].includes(String(row.status))).map(row => currency_matches(row) ? row.amount_minor : null));
  const total = minor(order.total_minor) ? order.total_minor : null;
  const gross = minor(order.subtotal_minor) ? order.subtotal_minor : null;
  const discount = minor(order.discount_minor) ? order.discount_minor : null;
  const merchandise = gross !== null && discount !== null && gross >= discount ? gross - discount : null;
  const cancelled = Boolean(order.cancelled_at) || ['cancelled', 'canceled', 'voided'].includes(String(order.financial_status));
  const reversed = cancelled || (total !== null && total > 0 && succeeded !== null && succeeded >= total);
  const collected = sum(transactions.filter(row => row.status === 'succeeded' && ['sale', 'capture'].includes(String(row.kind)))
    .map(row => currency_matches(row) ? row.amount_minor : null));
  const refundNet = sum(refunds.filter(row => row.status === 'succeeded').map(row => currency_matches(row) ? row.merchandise_amount_minor : null));
  return { ids, order, refunds, reversed, refundComplete, merchandise, gross, discount, total, succeeded: refundComplete ? succeeded : null,
    requested: refundComplete ? requested : null, observedRequested: requested, observedSucceeded: succeeded,
    collected: paymentsComplete ? collected : null, cancelled,
    net: reversed ? 0 : refundComplete && total !== null && succeeded !== null ? Math.max(0, total - succeeded) : null,
    net_sales: reversed ? 0 : refundComplete && merchandise !== null && refundNet !== null ? Math.max(0, merchandise - refundNet) : null };
}
export function revenueDaily(ctx: Context, input: Data, lineage?: (key: string, facts: Row[]) => void) {
  const range = period(input);
  const store = input.store_id === undefined ? undefined : text(input.store_id, 'store_id');
  const code = input.currency === undefined ? undefined : currency(input.currency);
  const days = new Map<string, { day: string; store_id: string; currency: string; facts: ReturnType<typeof orderFacts>[] }>();
  for (const order of orders(ctx)) {
    if (!inPeriod(order.placed_at, range) || (store && order.store_id !== store) || (code && order.currency !== code)) continue;
    const placed = factDate(order.placed_at)!, day = localDay(placed, range.tz);
    const store_id = optionalString(order.store_id), currency = optionalString(order.currency);
    if (!store_id || !currency || !/^[A-Z]{3}$/.test(currency)) continue;
    const key = JSON.stringify([day, store_id, currency]);
    if (!days.has(key)) days.set(key, { day, store_id, currency, facts: [] });
    days.get(key)!.facts.push(orderFacts(ctx, order));
  }
  const rows = [...days.values()].map(({ day, store_id, currency, facts }) => {
    lineage?.(`${day} · ${store_id} · ${currency}`, facts.flatMap(fact => [fact.order, ...fact.refunds]));
    // Verify the selected order interval before publishing additive totals.
    const complete = covered(ctx, store_id, 'orders', range);
    const aggregate = (amount: (fact: typeof facts[number]) => unknown) => complete ? sum(facts.map(amount)) : null;
    const refundCoverage = facts.filter(fact => fact.refundComplete).length / facts.length;
    return { day, store_id, currency, orders_observed: facts.length, gross_sales_minor: aggregate(row => row.gross),
      order_total_minor: aggregate(row => row.total), discounts_minor: aggregate(row => row.discount), net_sales_minor: aggregate(row => row.net_sales),
      refunds_requested_minor: aggregate(row => row.requested), refunds_succeeded_minor: aggregate(row => row.succeeded),
      observed_refunds_requested_minor: sum(facts.map(row => row.observedRequested)),
      observed_refunds_succeeded_minor: sum(facts.map(row => row.observedSucceeded)),
      cancellations_minor: aggregate(row => row.cancelled ? row.total : 0), collected_minor: aggregate(row => row.collected),
      coverage: complete ? refundCoverage : 0, warnings: [...(!complete ? ['ORDER_COVERAGE_INCOMPLETE'] : []), ...(refundCoverage < 1 ? ['REFUND_COVERAGE_INCOMPLETE'] : [])] };
  });
  return { rows, as_of: date(ctx.now), timezone: range.tz, warnings: rows.length ? [] : ['NO_ORDER_OBSERVATIONS'] };
}

interface Evidence {
  evidence_kind: string; source_id: string; occurred_at: string;
  credited_subject_type: string; credited_subject_id: string;
}
function linkCredit(link: Row): Pick<Evidence, 'credited_subject_type' | 'credited_subject_id'> {
  return { credited_subject_type: 'short_link', credited_subject_id: link.id };
}
function orderEvidence(ctx: Context, order: Row, facts: ReturnType<typeof orderFacts>, model: Model, window: number): Evidence[] {
  const placed = factDate(order.placed_at);
  if (!placed) return [];
  const links = new Map(ctx.list('short_link').map(link => [link.id, link]));
  const after = new Date(Date.parse(placed) - window * 86400000).toISOString();
  const session = optionalString(order.session_ref);
  const within = (when: string | undefined): when is string => !!when && when >= after && when <= placed;
  const touches: Evidence[] = [];
  if (session && order.session_verified === true) for (const point of consentedTouchpoints(ctx, date(ctx.now))) {
    const link = links.get(String(point.short_link_id)), time = factDate(point.occurred_at);
    if (point.session_ref === session && link && within(time)) touches.push({ ...linkCredit(link), evidence_kind: 'touchpoint', source_id: point.id, occurred_at: time });
  }
  touches.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.source_id.localeCompare(b.source_id));
  if (model === 'first_touch') return touches.slice(0, 1);
  if (model === 'last_touch') return touches.slice(-1);
  if (model === 'linear') return touches;
  if (model === 'link_session') {
    const direct = links.get(String(order.short_link_id));
    if (direct && direct.created_at <= placed) return [{ ...linkCredit(direct), evidence_kind: 'order_short_link', source_id: order.id, occurred_at: placed }];
    const utm = order.utm && typeof order.utm === 'object' && !Array.isArray(order.utm) ? order.utm as Data : {};
    const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];
    const value = (key: string) => utm[key] ?? utm[key.slice(4)];
    const provided = keys.filter(key => typeof value(key) === 'string' && value(key));
    if (provided.includes('utm_campaign') && (provided.includes('utm_content') || provided.includes('utm_id'))) {
      const matches = ctx.list('short_link_revision').filter(row => row.created_at <= placed && links.has(String(row.short_link_id)) && row.utm_params
        && provided.every(key => (row.utm_params as Data)[key] === value(key)));
      const unique = new Set(matches.map(row => row.short_link_id));
      if (unique.size === 1) return [{ ...linkCredit(links.get(String(matches[0].short_link_id))!), evidence_kind: 'order_utm',
        source_id: matches[0].id, occurred_at: placed }];
    }
    return touches.slice(-1);
  }
  if (model === 'discount_code') {
    const candidates: Evidence[] = [];
    for (const usage of ctx.list('discount_usage').filter(row => facts.ids.has(String(row.order_id)))) {
      const promotion = ctx.list('promotion').find(row => row.id === usage.promotion_id);
      if (!promotion || (promotion.store_id && promotion.store_id !== order.store_id)) continue;
      const from = factDate(promotion.valid_from), to = factDate(promotion.valid_until);
      if ((from && placed < from) || (to && placed >= to)) continue;
      const codes = ctx.list('promotion_code').filter(row => row.promotion_id === promotion.id && row.code === usage.code);
      if (codes.length > 1) continue;
      const assigned = codes[0]?.assigned_to as Data | undefined;
      const creator = assigned?.type === 'creator' ? optionalString(assigned.id) : undefined;
      const campaign = optionalString(promotion.campaign_id);
      if (creator || campaign) candidates.push({ credited_subject_type: creator ? 'creator' : 'campaign', credited_subject_id: (creator ?? campaign)!,
        evidence_kind: 'discount_usage', source_id: usage.id, occurred_at: placed });
    }
    const choices = new Set(candidates.map(row => JSON.stringify([row.credited_subject_type, row.credited_subject_id])));
    return choices.size === 1 ? candidates : [];
  }
  return [];
}
function distribute(total: number | null, count: number, index: number) {
  return total === null ? null : Math.floor(total / count) + (index < total % count ? 1 : 0);
}
export function runAttribution(ctx: Context, input: Data) {
  const key = choice(input.model_key, models, 'model_key');
  if (reported(key)) invalid('Use the authorized attribution observation sink for externally reported credit');
  const range = period(input);
  const config = attributionModels(ctx).find(row => row.key === key)!;
  const revision = Number(config.revision), window_days = Number(config.window_days);
  const store = input.store_id === undefined ? undefined : text(input.store_id, 'store_id');
  const selected = orders(ctx).filter(row => inPeriod(row.placed_at, range) && (!store || row.store_id === store));
  const run = ctx.create('attribution_run', { model_key: key, revision, window_days, period: range, store_id: store, status: 'completed' });
  const prior = ctx.list('attribution_record').filter(row => row.model_key === key && row.status === 'active');
  for (const order of selected) {
    const facts = orderFacts(ctx, order);
    const evidence = orderEvidence(ctx, order, facts, key, window_days);
    for (const row of prior.filter(row => facts.ids.has(String(row.order_id)))) {
      ctx.update('attribution_record', row.id, { status: facts.reversed ? 'reversed' : 'superseded' });
    }
    const credited = new Map<string, Data & { evidence: Evidence[]; weight: number; credited_amount_minor: number | null; net_of_refunds_minor: number | null }>();
    const shares = key === 'linear' ? evidence.length : evidence.length ? 1 : 0;
    evidence.forEach((item, index) => {
      const identity = JSON.stringify([item.credited_subject_type, item.credited_subject_id]);
      const row = credited.get(identity) ?? { credited_subject_type: item.credited_subject_type, credited_subject_id: item.credited_subject_id,
        evidence: [], weight: 0, credited_amount_minor: facts.total === null ? null : 0, net_of_refunds_minor: facts.net === null ? null : 0 };
      row.evidence.push(item);
      if (index < shares) {
        row.weight += 1 / shares;
        if (row.credited_amount_minor !== null) row.credited_amount_minor += distribute(facts.total, shares, index)!;
        if (row.net_of_refunds_minor !== null) row.net_of_refunds_minor += distribute(facts.net, shares, index)!;
      }
      credited.set(identity, row);
    });
    // Persist an explicit unknown record so an evaluated order can be distinguished from an order never evaluated.
    if (!credited.size) credited.set('unknown', { credited_subject_type: null, credited_subject_id: null, evidence: [], weight: 0,
      credited_amount_minor: null, net_of_refunds_minor: null });
    for (const value of credited.values()) {
      const record = ctx.create('attribution_record', { ...value, order_id: order.id, store_id: order.store_id, currency: order.currency,
        model_key: key, revision, window_days, order_net_minor: facts.net, reconcilable: true, run_id: run.id, status: facts.reversed ? 'reversed' : 'active' });
      for (const item of value.evidence) ctx.create('attribution_touch', { ...item, record_id: record.id });
    }
  }
  ctx.emit('analytics.attribution_run.completed', { run_id: run.id, model_key: key, orders: selected.length });
  return dto(ctx.update('attribution_run', run.id, { orders: selected.length }), ['model_key', 'revision', 'window_days', 'period', 'store_id', 'status', 'orders']);
}

/** Import authorized provider results using normalized, idempotent external evidence references. */
export function recordReportedAttribution(ctx: Context, body: Data) {
  const key = choice(body.model_key, ['platform_reported', 'external_service'], 'model_key');
  const current = attributionModels(ctx).find(row => row.key === key)!;
  const provider = text(body.provider, 'provider');
  const existing = ctx.list('attribution_record');
  const run = ctx.create('attribution_run', { model_key: key, revision: current.revision, provider, status: 'completed' });
  let inserted = 0;
  for (const raw of array(body.rows, 'rows')) {
    const input = object(raw);
    const order = ctx.get('order', text(input.order_id, 'order_id'));
    const external_id = text(input.external_id, 'external_id');
    const credited_subject_type = choice(input.credited_subject_type, ['short_link', 'platform_post', 'campaign', 'creator', 'ad'], 'credited_subject_type');
    const credited_subject_id = text(input.credited_subject_id, 'credited_subject_id');
    ctx.get(credited_subject_type, credited_subject_id);
    if (!minor(input.credited_amount_minor) || input.currency !== order.currency) invalid('Invalid attribution amount or currency');
    const occurred_at = date(input.occurred_at);
    if (occurred_at > date(ctx.now)) invalid('Reported attribution is in the future');
    const previous = existing.find(row => row.model_key === key && row.provider === provider && row.external_id === external_id && row.store_id === order.store_id);
    if (previous) {
      if (previous.credited_amount_minor !== input.credited_amount_minor || previous.order_id !== order.id || previous.credited_subject_id !== credited_subject_id
        || previous.credited_subject_type !== credited_subject_type) conflict('External credit reference already has a different result');
      continue;
    }
    const row = ctx.create('attribution_record', { model_key: key, provider, external_id, order_id: order.id, store_id: order.store_id,
      revision: current.revision, window_days: current.window_days, reconcilable: false, run_id: run.id, status: 'active',
      credited_subject_type, credited_subject_id, currency: order.currency, credited_amount_minor: input.credited_amount_minor,
      net_of_refunds_minor: null, evidence: [{ evidence_kind: key, source_id: external_id, provider, occurred_at }] });
    existing.push(row);
    inserted++;
  }
  ctx.emit('analytics.attribution_run.completed', { run_id: run.id, model_key: key, inserted });
  return { run_id: run.id, inserted };
}

export function attributionExplain(ctx: Context, order: Row, selection: readonly Model[] = models) {
  const facts = orderFacts(ctx, order);
  const records = ctx.list('attribution_record').filter(row => facts.ids.has(String(row.order_id)));
  const latest = attributionModels(ctx);
  return { order_id: order.id, store_id: order.store_id, currency: order.currency, net_order_minor: facts.net,
    caveat: 'Attribution does not establish causality. Model credits are separate and cannot be added.',
    models: selection.map(model_key => {
      const history = records.filter(row => row.model_key === model_key);
      const current = history.filter(row => row.status === 'active');
      const eligible = current.filter(row => row.credited_subject_id);
      const credits = facts.reversed && !reported(model_key) ? [] : eligible;
      const stale = !reported(model_key) && current.some(row => Object.hasOwn(row, 'order_net_minor') && row.order_net_minor !== facts.net);
      const explained = !stale && history.length > 0 && (current.length > 0 || facts.reversed);
      const knownCredit = explained && facts.net !== null ? sum(credits.map(row => row.net_of_refunds_minor)) : null;
      const uncredited = !reported(model_key) && knownCredit !== null && knownCredit <= facts.net! ? facts.net! - knownCredit : null;
      return { model_key, revision: current.length ? Math.max(...current.map(row => Number(row.revision))) : latest.find(row => row.key === model_key)?.revision,
        reconcilable: !reported(model_key), warning: reported(model_key) ? 'POSSIBLE_DOUBLE_CREDIT' : stale ? 'RECOMPUTE_REQUIRED' : undefined,
        uncredited_minor: uncredited, unattributed_ratio: uncredited !== null && facts.net! > 0 ? uncredited / facts.net! : null,
        records: stale ? [] : credits.map(row => dto(row, recordFields)), history: history.map(row => dto(row, recordFields)) };
    }) };
}
export function attributionQuery(ctx: Context, input: Data, lineage?: (key: string, facts: Row[]) => void) {
  const range = period(input);
  const selected = strings(input.models ?? models, 'models').map(key => choice(key, models, 'model'));
  if (!selected.length) invalid('Provide at least one model');
  const subject = input.subject === undefined ? undefined : object(input.subject);
  const type = subject ? choice(subject.type, ['short_link', 'platform_post', 'content_item', 'campaign', 'creator', 'ad'], 'subject.type') : undefined;
  const id = subject ? text(subject.id, 'subject.id') : undefined;
  const store = input.store_id === undefined ? undefined : text(input.store_id, 'store_id');
  const links = new Map(ctx.list('short_link').map(row => [row.id, row]));
  const creatorLinks = new Set(ctx.list('collaboration').filter(row => row.creator_id === id).map(row => row.id));
  const matching = (row: Data) => {
    if (!type) return true;
    if (row.credited_subject_type === type && row.credited_subject_id === id) return true;
    const link = row.credited_subject_type === 'short_link' ? links.get(String(row.credited_subject_id)) : undefined;
    return !!link && (type === 'campaign' && link.campaign_id === id || type === 'content_item' && link.content_item_id === id
      || type === 'creator' && creatorLinks.has(String(link.collaboration_id)));
  };
  const evaluatedOrders = orders(ctx).filter(row => inPeriod(row.placed_at, range) && (!store || row.store_id === store));
  const explanations = evaluatedOrders.map(row => attributionExplain(ctx, row, selected));
  const currencies = [...new Set(explanations.map(row => row.currency).filter(code => typeof code === 'string'))];
  const rows = currencies.flatMap(currency => selected.map(model_key => {
    const entries = explanations.filter(row => row.currency === currency).map(row => row.models.find(model => model.model_key === model_key)!);
    const records = entries.flatMap(model => model.records).filter(matching);
    if (lineage) {
      const creditedOrders = new Set(records.map(record => record.order_id));
      lineage(`${model_key} · ${currency}`, evaluatedOrders.filter(order => order.currency === currency && (!type || creditedOrders.has(order.id)))
        .flatMap(order => [order, ...orderRefunds(ctx, order)]));
    }
    const known = reported(model_key) ? records.length > 0 : entries.every(model => model.history.length > 0 && model.uncredited_minor !== null);
    const credit = known ? sum(records.map(record => reported(model_key) ? record.credited_amount_minor : record.net_of_refunds_minor)) : null;
    const uncredited = type ? null : sum(entries.map(model => model.uncredited_minor));
    const net = sum(explanations.filter(row => row.currency === currency).map(row => row.net_order_minor));
    return { model_key, currency, reconcilable: !reported(model_key), revisions: [...new Set(records.map(row => row.revision))],
      credited_minor: credit, uncredited_minor: uncredited, unattributed_ratio: uncredited !== null && net && net > 0 ? uncredited / net : null,
      orders_evaluated: entries.filter(model => model.history.length).length, orders_total: entries.length,
      unattributed_orders: type || reported(model_key) ? null : entries.filter(model => (model.uncredited_minor ?? 0) > 0 && model.records.length === 0).length,
      warning: reported(model_key) ? 'POSSIBLE_DOUBLE_CREDIT' : undefined };
  }));
  const transaction_totals = currencies.map(currency => {
    const entries = explanations.filter(row => row.currency === currency);
    lineage?.(`transaction_totals · ${currency}`, evaluatedOrders.filter(order => order.currency === currency).flatMap(order => [order, ...orderRefunds(ctx, order)]));
    return { currency, orders: entries.length, net_order_minor: sum(entries.map(row => row.net_order_minor)) };
  });
  return { rows, transaction_totals, caveat: 'Attribution does not establish causality. Model credits are separate and cannot be added.' };
}

const reconciliationFields = ['store_id', 'currency', 'period', 'source_ref', 'source_orders', 'source_total_minor',
  'system_orders_observed', 'system_total_minor', 'count_difference', 'amount_difference_minor', 'status'];
export function reconciliationChecks(ctx: Context, storeId?: string) {
  return ctx.list('reconciliation_check').filter(row => !storeId || row.store_id === storeId).map(row => dto(row, reconciliationFields));
}
export function reconcileRevenue(ctx: Context, input: Data) {
  const range = period(input), store_id = text(input.store_id, 'store_id'), code = currency(input.currency);
  ctx.get('store', store_id);
  const source_ref = text(input.source_ref, 'source_ref');
  const source_orders = input.source_orders, source_total_minor = input.source_total_minor;
  if (!minor(source_orders) || !minor(source_total_minor)) invalid('Source totals must be nonnegative integers');
  const { rows } = revenueDaily(ctx, { ...range, store_id, currency: code });
  const orderCoverage = covered(ctx, store_id, 'orders', range);
  const system_orders_observed = rows.reduce((count, row) => count + row.orders_observed, 0);
  const system_total_minor = orderCoverage ? sum(rows.map(row => row.order_total_minor)) : null;
  const count_difference = orderCoverage ? system_orders_observed - source_orders : null;
  const amount_difference_minor = system_total_minor === null ? null : system_total_minor - source_total_minor;
  const status = count_difference === null || amount_difference_minor === null ? 'insufficient_coverage'
    : count_difference || amount_difference_minor ? 'discrepancy' : 'matched';
  const value = { store_id, period: range, currency: code, source_ref, source_orders, source_total_minor, system_orders_observed,
    system_total_minor, count_difference, amount_difference_minor, status };
  const previous = ctx.list('reconciliation_check').find(row => reconciliationFields.every(key =>
    JSON.stringify(row[key]) === JSON.stringify(value[key as keyof typeof value])));
  if (previous) return dto(previous, reconciliationFields);
  const row = ctx.create('reconciliation_check', value);
  ctx.emit(status === 'discrepancy' ? 'analytics.reconciliation.discrepancy_found' : 'analytics.reconciliation.completed',
    { reconciliation_check_id: row.id, store_id, status });
  return dto(row, reconciliationFields);
}
