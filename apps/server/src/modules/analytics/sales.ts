import { admins, DomainError, text, writers, type Commands, type Context, type Entity, type Fields } from '../types.js';
import { addDays, choice, convertMinor, currency, cutoff, dayStart, inPeriod, instant, integer, invalid, localDay, moduleKey, period, ratesAt, ref, revenueRoles, safeNumber, strings, visibleAt, type Period } from './shared.js';

const paid = new Set(['paid', 'partially_paid', 'partially_refunded', 'refunded']);
const cancelled = new Set(['cancelled', 'voided']);
const attributionNote = 'Attribution assigns credit under a model and does not establish causation. Compare models independently.';
const modelKeys = ['link_session', 'discount_code', 'first_touch', 'last_touch', 'linear', 'platform_reported'] as const;
type ModelKey = typeof modelKeys[number];
type Model = { key: ModelKey; revision: number; window_days: number; reconcilable: boolean };
const subjectTypes = ['platform_post', 'short_link', 'campaign', 'creator', 'ad', 'landing_page'] as const;
const evidenceKinds = ['link_session', 'discount_code', 'touchpoint', 'platform_reported'] as const;
const byId = (a: Entity, b: Entity) => a.id.localeCompare(b.id);
function currentRow(row: Entity, asOf: string) {
  if (!visibleAt(row, asOf)) return false;
  if (row.data.rolled_back === true && (!row.data.rolled_back_at || instant(row.data.rolled_back_at, 'rolled_back_at') <= asOf)) return false;
  return instant(row.updated_at, 'updated_at') <= asOf || row.data.rolled_back === true;
}
function optionalIds(value: unknown, field: string) { return value === undefined ? undefined : strings(value, field); }
export function parseSalesQuery(input: Fields) {
  return { period: period(input.period), store_ids: optionalIds(input.store_ids, 'store_ids'), report_currency: input.report_currency === undefined ? undefined : currency(input.report_currency) };
}
export function parseAttributionQuery(input: Fields) {
  const models = strings(input.model_keys ?? ['link_session'], 'model_keys', modelKeys.length).map(key => choice(key, modelKeys, 'model_key'));
  if (!models.length) invalid('Provide at least one model');
  return { ...parseSalesQuery(input), model_keys: models, subject_ids: optionalIds(input.subject_ids, 'subject_ids') };
}
export function canonicalOrders(orders: Entity[]) {
  const identity = (order: Entity) => JSON.stringify([order.data.store_id, order.data.external_order_id ?? order.id]);
  const canonical = new Map<string, Entity>();
  for (const row of [...orders].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || byId(a, b))) {
    if (!canonical.has(identity(row))) canonical.set(identity(row), row);
  }
  return { orders: [...canonical.values()], orderAliases: new Map(orders.map(row => [row.id, canonical.get(identity(row))!.id])) };
}

export function canonicalOrderFacts(facts: Entity[], orderAliases: Map<string, string>, externalKey: string) {
  const unique = new Map<string, Entity>();
  for (const row of [...facts].sort((a, b) => b.updated_at.localeCompare(a.updated_at) || byId(a, b))) {
    const order_id = orderAliases.get(row.data.order_id);
    if (!order_id) continue;
    const key = JSON.stringify([order_id, row.data[externalKey] ?? row.id]);
    if (!unique.has(key)) unique.set(key, { ...row, data: { ...row.data, order_id } });
  }
  return [...unique.values()];
}

async function commerceFacts(ctx: Context, query: ReturnType<typeof parseSalesQuery>, asOf: string) {
  const [allOrders, allRefunds, allTransactions, segments, batches, ingestSegments] = await Promise.all([
    ctx.list('commerce', 'order'), ctx.list('commerce', 'refund'), ctx.list('commerce', 'payment_transaction'), ctx.list('commerce', 'coverage_segment'), ctx.list('commerce', 'import_batch'), ctx.list('ingest', 'coverage_segment'),
  ]);
  const isSelected = (row: Entity) => !query.store_ids || query.store_ids.includes(row.data.store_id);
  const orders = allOrders.filter(row => isSelected(row) && row.data.placed_at && inPeriod(instant(row.data.placed_at, 'placed_at'), query.period));
  const eligible = orders.filter(row => currentRow(row, asOf) && instant(row.data.placed_at, 'placed_at') <= asOf);
  const { orders: selected, orderAliases } = canonicalOrders(eligible);
  const orderIds = new Set(orderAliases.keys());
  const refunds = allRefunds.filter(row => orderIds.has(row.data.order_id) && currentRow(row, asOf) && row.data.created_at && instant(row.data.created_at, 'refund.created_at') <= asOf);
  const transactions = allTransactions.filter(row => orderIds.has(row.data.order_id) && currentRow(row, asOf));
  const changedAfterCutoff = [...orders, ...allRefunds.filter(row => orderIds.has(row.data.order_id)), ...allTransactions.filter(row => orderIds.has(row.data.order_id))]
    .some(row => visibleAt(row, asOf) && !row.data.rolled_back && instant(row.updated_at, 'updated_at') > asOf);
  if (changedAfterCutoff) throw new DomainError('historical_revision_unavailable', 'Commerce records changed after the cutoff. Use an existing frozen report or a newer cutoff.', 409);
  const rolledBack = new Set(batches.filter(row => (row.data.status === 'rolled_back' || row.data.rolled_back === true) && (!row.data.rolled_back_at || instant(row.data.rolled_back_at, 'rolled_back_at') <= asOf)).map(row => row.id));
  const coverage = [...segments, ...ingestSegments].filter(row => visibleAt(row, asOf) && (row.data.active !== false || row.data.superseded_at && instant(row.data.superseded_at, 'superseded_at') > asOf) && !rolledBack.has(row.data.import_batch_id));
  return { orders: selected, refunds: canonicalOrderFacts(refunds, orderAliases, 'external_refund_id'),
    transactions: canonicalOrderFacts(transactions, orderAliases, 'external_transaction_id'), coverage, orderAliases };
}
function refundFacts(order: Entity, all: Entity[]) {
  const refunds = all.filter(row => row.data.order_id === order.id);
  const matching = refunds.filter(row => row.data.currency === order.data.currency);
  const amount = (statuses: string[]) => safeNumber(matching.filter(row => statuses.includes(row.data.status)).reduce((sum, row) => sum + BigInt(row.data.amount_minor), 0n));
  return { refunds, mismatch: refunds.length !== matching.length, requested: amount(['requested', 'pending']), succeeded: amount(['succeeded']) };
}
function netAmount(order: Entity, succeeded: number) {
  if (order.data.cancelled_at || cancelled.has(order.data.financial_status)) return 0;
  if (!paid.has(order.data.financial_status)) return 0;
  return Math.max(0, order.data.total_minor - succeeded);
}
function coverageFor(segments: Entity[], store: string, resource: string, day: string, tz: string, asOf: string, range: Period) {
  const start = Math.max(dayStart(day, tz), Date.parse(range.from));
  const end = Math.min(dayStart(addDays(day, 1), tz), Date.parse(range.to));
  const intervals = segments.filter(row => row.data.store_id === store && row.data.resource === resource && ['complete', 'partial'].includes(row.data.status) && row.data.window_start && row.data.window_end)
    .map(row => ({ start: Math.max(start, Date.parse(instant(row.data.window_start, 'window_start'))), end: Math.min(end, Date.parse(instant(row.data.window_end, 'window_end'))), row,
      attested: instant(row.data.as_of ?? row.created_at, 'coverage.as_of') }))
    .filter(entry => entry.start < entry.end)
    .sort((a, b) => b.attested.localeCompare(a.attested) || Number(b.row.data.status === 'partial') - Number(a.row.data.status === 'partial') || b.row.created_at.localeCompare(a.row.created_at));
  const boundaries = [...new Set([start, end, ...intervals.flatMap(entry => [entry.start, entry.end])])].sort((a, b) => a - b);
  let covered = 0;
  const selected = new Map<string, ReturnType<typeof ref>>();
  for (let i = 1; i < boundaries.length; i++) {
    const from = boundaries[i - 1]!, to = boundaries[i]!;
    const controlling = intervals.find(entry => entry.start <= from && entry.end >= to);
    if (!controlling) continue;
    selected.set(controlling.row.id, ref(controlling.row));
    if (controlling.row.data.status === 'complete' && (resource !== 'refunds' || controlling.attested >= asOf)) covered += to - from;
  }
  return { fraction: end > start ? covered / (end - start) : 0, evidence: [...selected.values()] };
}
export async function revenueQuery(ctx: Context, query: ReturnType<typeof parseSalesQuery>, asOf: string) {
  const { orders, refunds, transactions, coverage } = await commerceFacts(ctx, query, asOf);
  const rates = query.report_currency ? await ratesAt(ctx, asOf) : [];
  const warnings = new Set<string>();
  const groups = new Map<string, Entity[]>();
  for (const order of orders) {
    const day = localDay(order.data.placed_at, query.period.tz);
    const key = JSON.stringify([day, order.data.store_id, order.data.currency]);
    groups.set(key, [...(groups.get(key) ?? []), order]);
  }
  const rows = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, group]) => {
    const [day, store_id, currency] = JSON.parse(key) as [string, string, string];
    const refundCoverage = coverageFor(coverage, store_id, 'refunds', day, query.period.tz, asOf, query.period);
    const orderCoverage = coverageFor(coverage, store_id, 'orders', day, query.period.tz, asOf, query.period);
    const txCoverage = coverageFor(coverage, store_id, 'transactions', day, query.period.tz, asOf, query.period);
    let gross = 0n, discounts = 0n, refundRequested = 0n, refundSucceeded = 0n, cancellations = 0n, net = 0n, collected = 0n, discountsKnown = true, hasMismatch = false, refundsConsistent = true;
    const evidence = [...refundCoverage.evidence, ...orderCoverage.evidence, ...txCoverage.evidence];
    for (const order of group.sort(byId)) {
      const facts = refundFacts(order, refunds);
      hasMismatch ||= facts.mismatch;
      if (order.data.financial_status === 'refunded' && facts.succeeded < order.data.total_minor && !order.data.cancelled_at) refundsConsistent = false;
      const total = BigInt(order.data.total_minor);
      gross += total + BigInt(order.data.discount_minor ?? 0);
      if (Number.isSafeInteger(order.data.discount_minor)) discounts += BigInt(order.data.discount_minor); else discountsKnown = false;
      refundRequested += BigInt(facts.requested);
      refundSucceeded += BigInt(facts.succeeded);
      if (order.data.cancelled_at || cancelled.has(order.data.financial_status)) cancellations += total;
      net += BigInt(netAmount(order, facts.succeeded));
      evidence.push(ref(order), ...facts.refunds.map(ref));
      for (const tx of transactions.filter(row => row.data.order_id === order.id && (row.data.currency ?? order.data.currency) === currency && row.data.status === 'succeeded' && (!row.data.processed_at || instant(row.data.processed_at, 'processed_at') <= asOf))) {
        if (!['capture', 'sale', 'payment'].includes(tx.data.kind ?? tx.data.type)) continue;
        collected += BigInt(tx.data.amount_minor);
        evidence.push(ref(tx));
      }
    }
    const complete = refundCoverage.fraction === 1 && !hasMismatch && refundsConsistent;
    if (!complete) warnings.add('REFUND_COVERAGE_INCOMPLETE');
    if (hasMismatch) warnings.add('REFUND_CURRENCY_MISMATCH');
    if (!refundsConsistent) warnings.add('REFUND_ORDER_TOTAL_MISMATCH');
    if (orderCoverage.fraction < 1) warnings.add('ORDER_COVERAGE_INCOMPLETE');
    const amounts = { gross_sales_minor: discountsKnown ? safeNumber(gross) : null, discounts_minor: discountsKnown ? safeNumber(discounts) : null,
      observed_order_total_minor: safeNumber(gross - discounts), refunds_requested_minor: complete ? safeNumber(refundRequested) : null,
      observed_refunds_requested_minor: safeNumber(refundRequested), refunds_succeeded_minor: complete ? safeNumber(refundSucceeded) : null,
      observed_refunds_succeeded_minor: safeNumber(refundSucceeded), cancellations_minor: safeNumber(cancellations), net_sales_minor: complete ? safeNumber(net) : null,
      observed_net_sales_minor: safeNumber(net), collected_minor: txCoverage.fraction === 1 ? safeNumber(collected) : null, observed_collected_minor: safeNumber(collected) };
    let conversion = null;
    if (query.report_currency) {
      const sample = convertMinor(0, currency, query.report_currency, day, rates);
      if (sample.amount_minor === null) warnings.add('MISSING_FX_RATE');
      conversion = { currency: query.report_currency, fx_rate: sample.fx, status: sample.amount_minor === null ? 'missing_fx' : 'converted',
        amounts_minor: Object.fromEntries(Object.entries(amounts).map(([name, amount]) => [name, amount === null ? null : convertMinor(amount, currency, query.report_currency!, day, rates).amount_minor])) };
      if (sample.fx) evidence.push(sample.fx);
    }
    return { day, store_id, currency, order_count: group.length, ...amounts, coverage: { refunds: complete ? 1 : hasMismatch || !refundsConsistent ? 0 : refundCoverage.fraction, orders: orderCoverage.fraction, transactions: txCoverage.fraction }, conversion, evidence };
  });
  if (!rows.length) warnings.add('NO_ORDER_DATA');
  return { rows, as_of: asOf, warnings: [...warnings], calculation: 'Order-date cohorts. Succeeded refunds reduce order total once. Requested and pending refunds are reported separately. Tax and shipping remain in commerce order totals.' };
}
async function modelsAt(ctx: Context, asOf: string) {
  const models = new Map<ModelKey, Model>(modelKeys.map(key => [key, { key, revision: 1, window_days: 30, reconcilable: key !== 'platform_reported' }]));
  for (const row of await ctx.list(moduleKey, 'attribution_model')) {
    if (!visibleAt(row, asOf)) continue;
    const version = row.data as Model;
    if (version.revision > (models.get(version.key)?.revision ?? 0)) models.set(version.key, version);
  }
  return models;
}
function evidenceFromEntity(entity: Entity, kind: typeof evidenceKinds[number], fallback: string) {
  const d = entity.data;
  const subjectType = d.subject_type ?? (d.short_link_id ? 'short_link' : d.campaign_id ? 'campaign' : undefined);
  const subjectId = d.subject_id ?? d.short_link_id ?? d.campaign_id;
  if (!subjectType || !subjectId) return [];
  return [{ evidence_kind: kind, subject_type: subjectType, subject_id: subjectId, occurred_at: instant(d.occurred_at ?? fallback, 'occurred_at'),
    ref: ref(entity), reported_amount_minor: d.reported_amount_minor, currency: d.currency }];
}
function orderCandidates(order: Entity, links: Entity[], revisions: Entity[], usages: Entity[], promotions: Map<string, Entity>, touches: Entity[], supplied: Entity[], aliases: Map<string, string>) {
  const d = order.data;
  const date = instant(d.placed_at, 'placed_at');
  const belongs = (row: Entity) => aliases.get(row.data.order_id) === order.id;
  const direct = links.filter(row => row.id === d.short_link_id && visibleAt(row, date));
  if (!direct.length && d.utm && typeof d.utm === 'object') {
    const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];
    const value = (key: string) => d.utm[key] ?? d.utm[key.slice(4)];
    const provided = keys.filter(key => typeof value(key) === 'string' && value(key));
    if (provided.includes('utm_campaign') && (provided.includes('utm_content') || provided.includes('utm_id'))) {
      const linkIds = new Set(links.map(row => row.id));
      const match = new Set(revisions.filter(row => linkIds.has(row.data.short_link_id) && visibleAt(row, date)
        && provided.every(key => row.data.utm_params?.[key] === value(key))).map(row => row.data.short_link_id));
      if (match.size === 1) direct.push(links.find(row => match.has(row.id))!);
    }
  }
  const directEvidence = direct.map(row => ({ evidence_kind: 'link_session', subject_type: 'short_link', subject_id: row.id, occurred_at: date, ref: ref(row), reported_amount_minor: undefined, currency: undefined }));
  const usageEvidence = usages.filter(belongs).flatMap(row => {
    const promotion = promotions.get(row.data.promotion_id);
    if (!promotion || promotion.data.store_id && promotion.data.store_id !== d.store_id) return [];
    if (promotion.data.valid_from && instant(promotion.data.valid_from, 'valid_from') > date ||
      promotion.data.valid_until && instant(promotion.data.valid_until, 'valid_until') <= date) return [];
    const campaign_id = promotion.data.campaign_id;
    return evidenceFromEntity({ ...row, data: { ...row.data, campaign_id } }, 'discount_code', date);
  });
  const touchEvidence = touches.filter(row => belongs(row) || typeof d.session_id === 'string' && d.session_id.length > 0 && row.data.session_id === d.session_id && row.data.consent === true)
    .flatMap(row => evidenceFromEntity(row, 'touchpoint', date));
  const verified = supplied.filter(belongs).flatMap(row => evidenceFromEntity(row, row.data.evidence_kind, date));
  const candidates = [...directEvidence, ...usageEvidence, ...touchEvidence, ...verified];
  return [...new Map(candidates.map(row => [JSON.stringify([row.evidence_kind, row.ref.id]), row])).values()];
}
async function calculateAttribution(ctx: Context, query: ReturnType<typeof parseAttributionQuery>, asOf: string) {
  const [{ orders, refunds, coverage, orderAliases }, models, links, revisions, usages, promotions, touches, supplied, rates] = await Promise.all([
    commerceFacts(ctx, query, asOf), modelsAt(ctx, asOf), ctx.list('traffic', 'short_link'), ctx.list('traffic', 'short_link_revision'), ctx.list('commerce', 'discount_usage'), ctx.list('commerce', 'promotion'),
    ctx.list('traffic', 'touchpoint_event'), ctx.list(moduleKey, 'attribution_evidence'), query.report_currency ? ratesAt(ctx, asOf) : Promise.resolve([]),
  ]);
  const active = (rows: Entity[]) => rows.filter(row => currentRow(row, asOf));
  const rows = [];
  const warnings = new Set<string>();
  const model_versions: Record<string, number> = {};
  const activePromotions = new Map(active(promotions).map(row => [row.id, row]));
  const activeLinks = active(links), activeRevisions = active(revisions), activeUsages = active(usages), activeTouches = active(touches), activeSupplied = active(supplied);
  for (const key of query.model_keys) {
    const model = models.get(key)!;
    model_versions[key] = model.revision;
    for (const order of orders.sort(byId)) {
      const facts = refundFacts(order, refunds);
      if (facts.mismatch) warnings.add('REFUND_CURRENCY_MISMATCH');
      const originalCurrency = order.data.currency as string;
      const date = instant(order.data.placed_at, 'placed_at');
      const observedNet = netAmount(order, facts.succeeded);
      const reversed = observedNet === 0 && (facts.succeeded > 0 || order.data.cancelled_at || cancelled.has(order.data.financial_status) || order.data.financial_status === 'refunded');
      const eligible = !reversed && paid.has(order.data.financial_status);
      const net = eligible ? observedNet : 0;
      const candidates = orderCandidates(order, activeLinks, activeRevisions, activeUsages, activePromotions, activeTouches, activeSupplied, orderAliases).filter(touch => touch.occurred_at <= date && Date.parse(touch.occurred_at) >= Date.parse(date) - model.window_days * 86_400_000)
        .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.ref.id.localeCompare(b.ref.id));
      let chosen = candidates.filter(touch => touch.evidence_kind === (['first_touch', 'last_touch', 'linear'].includes(key) ? 'touchpoint' : key));
      if (key === 'link_session' && !chosen.length && order.data.session_id) chosen = candidates.filter(touch => touch.evidence_kind === 'touchpoint');
      if (['link_session', 'discount_code', 'last_touch'].includes(key)) chosen = chosen.slice(-1);
      if (key === 'first_touch') chosen = chosen.slice(0, 1);
      if (key === 'platform_reported') {
        if (chosen.some(touch => touch.currency !== originalCurrency)) warnings.add('PLATFORM_REPORTED_CURRENCY_MISMATCH');
        chosen = chosen.filter(touch => touch.currency === originalCurrency && Number.isSafeInteger(touch.reported_amount_minor));
      }
      const credits = new Map<string, { credited_subject_type: string; credited_subject_id: string; weight: number | null; credited_amount_minor: number; net_of_refunds_minor: number; touches: typeof chosen }>();
      const count = chosen.length;
      const allocate = (amount: number, index: number) => Math.floor(amount / count) + (index < amount % count ? 1 : 0);
      for (const [index, touch] of chosen.entries()) {
        const id = JSON.stringify([touch.subject_type, touch.subject_id]);
        const record = credits.get(id) ?? { credited_subject_type: touch.subject_type, credited_subject_id: touch.subject_id, weight: model.reconcilable ? 0 : null, credited_amount_minor: 0, net_of_refunds_minor: 0, touches: [] as typeof chosen };
        if (record.weight !== null) record.weight += 1 / count;
        record.credited_amount_minor = safeNumber(BigInt(record.credited_amount_minor) + BigInt(model.reconcilable ? allocate(order.data.total_minor, index) : touch.reported_amount_minor));
        record.net_of_refunds_minor = safeNumber(BigInt(record.net_of_refunds_minor) + BigInt(model.reconcilable ? allocate(net, index) : eligible ? touch.reported_amount_minor : 0));
        record.touches.push(touch);
        credits.set(id, record);
      }
      const allCredits = [...credits.values()];
      const total = safeNumber(allCredits.reduce((sum, credit) => sum + BigInt(credit.net_of_refunds_minor), 0n));
      const dateLocal = localDay(date, query.period.tz);
      const refundCoverage = coverageFor(coverage, order.data.store_id, 'refunds', dateLocal, query.period.tz, asOf, query.period);
      if (eligible && (refundCoverage.fraction < 1 || facts.mismatch)) warnings.add('REFUND_COVERAGE_INCOMPLETE');
      const conversion = query.report_currency ? convertMinor(net, originalCurrency, query.report_currency, dateLocal, rates) : undefined;
      if (conversion?.amount_minor === null) warnings.add('MISSING_FX_RATE');
      rows.push({ order_id: order.id, store_id: order.data.store_id, model_key: key, model_revision: model.revision, window_days: model.window_days, reconcilable: model.reconcilable,
        currency: originalCurrency, order_net_minor: net, order_total_minor: order.data.total_minor, succeeded_refunds_minor: facts.succeeded,
        unallocated_minor: model.reconcilable ? net - total : null, unallocated_ratio: model.reconcilable && net > 0 ? (net - total) / net : null,
        status: reversed ? 'reversed' : eligible ? 'active' : 'ineligible', possible_double_credit: !model.reconcilable, report_currency: query.report_currency,
        converted_order_net_minor: conversion?.amount_minor, fx_rate: conversion?.fx,
        refund_coverage: facts.mismatch ? 0 : refundCoverage.fraction,
        credits: allCredits.filter(credit => !query.subject_ids || query.subject_ids.includes(credit.credited_subject_id)).map(credit => ({ ...credit,
          ...(query.report_currency ? { converted_net_minor: convertMinor(credit.net_of_refunds_minor, originalCurrency, query.report_currency, dateLocal, rates).amount_minor } : {}) })),
        evidence: [ref(order), ...facts.refunds.map(ref), ...refundCoverage.evidence, ...allCredits.flatMap(credit => credit.touches.map(touch => touch.ref))] });
    }
  }
  if (query.model_keys.includes('platform_reported')) warnings.add('POSSIBLE_DOUBLE_CREDIT');
  return { rows, model_versions, warnings: [...warnings], as_of: asOf, attribution_notice: attributionNote, orderAliases };
}
function attributionComparison(result: Awaited<ReturnType<typeof calculateAttribution>>, keys: ModelKey[], orderId?: string) {
  const { orderAliases, rows: allRows, ...metadata } = result;
  const rows = orderId === undefined ? allRows : allRows.filter(row => row.order_id === orderAliases.get(orderId));
  const columns = keys.map(key => ({ model_key: key, model_revision: result.model_versions[key], rows: rows.filter(row => row.model_key === key) }));
  const totals = new Map<string, { orders: number; net_order_minor: bigint }>();
  for (const row of columns[0]?.rows ?? []) {
    const total = totals.get(row.currency) ?? { orders: 0, net_order_minor: 0n };
    total.orders++;
    total.net_order_minor += BigInt(row.order_net_minor);
    totals.set(row.currency, total);
  }
  const transaction_totals = [...totals].map(([currency, total]) => ({ currency, orders: total.orders, net_order_minor: safeNumber(total.net_order_minor) }));
  return { ...metadata, rows, columns, transaction_totals };
}
export async function attributionQuery(ctx: Context, query: ReturnType<typeof parseAttributionQuery>, asOf: string) {
  return attributionComparison(await calculateAttribution(ctx, query, asOf), query.model_keys);
}

export const salesCommands: Commands = {
  revenue_query: { roles: revenueRoles, run: (ctx, input) => revenueQuery(ctx, parseSalesQuery(input), cutoff(ctx, input.data_cutoff_at)) },
  revise_attribution_model: { roles: admins, async run(ctx, input) {
    const key = choice(input.model_key, modelKeys, 'model_key');
    const models = await modelsAt(ctx, cutoff(ctx, undefined));
    const old = models.get(key)!;
    if (integer(input.expected_revision, 'expected_revision', 1) !== old.revision) throw new DomainError('version_conflict', 'Model revision changed', 409);
    const window_days = integer(input.window_days, 'window_days', 1);
    if (window_days > 365) invalid('Maximum attribution window is 365 days');
    const revision = old.revision + 1;
    const row = await ctx.insert(moduleKey, 'attribution_model', { ...old, revision, window_days }, `${key}:${revision}`);
    await ctx.emit('analytics.attribution_model.revised', { model_key: key, revision });
    return row;
  } },
  record_attribution_evidence: { roles: revenueRoles, async run(ctx, input) {
    const order_id = text(input, 'order_id', 200);
    const order = await ctx.get('commerce', 'order', order_id);
    if (!order || order.data.rolled_back) throw new DomainError('not_found', 'Commerce order not found', 404);
    const subject_type = choice(input.subject_type, subjectTypes, 'subject_type');
    const subject_id = text(input, 'subject_id', 200);
    const evidence_kind = choice(input.evidence_kind, evidenceKinds, 'evidence_kind');
    const occurred_at = instant(input.occurred_at, 'occurred_at');
    if (occurred_at > instant(order.data.placed_at, 'placed_at')) invalid('Evidence cannot follow the order');
    const source_ref = text(input, 'source_ref', 200);
    if (!/^[\w.:/-]+$/.test(source_ref)) invalid('Provide a source record identifier');
    const monetary = evidence_kind === 'platform_reported' ? { reported_amount_minor: integer(input.reported_amount_minor, 'reported_amount_minor'), currency: currency(input.currency) } : {};
    const existing = (await ctx.list(moduleKey, 'attribution_evidence')).find(row => row.data.order_id === order_id && row.data.evidence_kind === evidence_kind && row.data.source_ref === source_ref);
    if (existing) throw new DomainError('duplicate_evidence', 'The source record is already linked to this order and evidence kind', 409);
    const row = await ctx.insert(moduleKey, 'attribution_evidence', { order_id, subject_type, subject_id, evidence_kind, occurred_at, source_ref, ...monetary });
    await ctx.emit('analytics.attribution_evidence.recorded', { evidence_id: row.id, order_id });
    return row;
  } },
  attribution_query: { roles: revenueRoles, run: (ctx, input) => attributionQuery(ctx, parseAttributionQuery(input), cutoff(ctx, input.data_cutoff_at)) },
  attribution_explain: { roles: revenueRoles, async run(ctx, input) {
    const order_id = text(input, 'order_id', 200);
    const order = await ctx.get('commerce', 'order', order_id);
    const asOf = cutoff(ctx, input.data_cutoff_at);
    if (!order || !visibleAt(order, asOf) || order.data.rolled_back) throw new DomainError('not_found', 'Commerce order not found', 404);
    const from = instant(order.data.placed_at, 'placed_at');
    const to = new Date(Date.parse(from) + 1).toISOString();
    const query = parseAttributionQuery({ ...input, model_keys: input.model_keys ?? modelKeys, period: { from, to, tz: 'UTC' }, store_ids: [order.data.store_id] });
    return attributionComparison(await calculateAttribution(ctx, query, asOf), query.model_keys, order_id);
  } },
  attribution_run: { roles: writers, async run(ctx, input) {
    const query = parseAttributionQuery(input);
    if (query.subject_ids) invalid('Persisted attribution runs must include all credited subjects');
    const result = await calculateAttribution(ctx, query, cutoff(ctx, undefined));
    const previous = await ctx.list(moduleKey, 'attribution_record');
    const runs = [], records = [];
    for (const key of query.model_keys) {
      const rows = result.rows.filter(row => row.model_key === key);
      const selectedOrders = new Map(rows.map(row => [row.order_id, row]));
      const run = await ctx.insert(moduleKey, 'attribution_run', { model_key: key, revision: result.model_versions[key], scope: { store_ids: query.store_ids }, period: query.period,
        as_of: result.as_of, status: 'completed', stats: { orders: rows.length, reversed: rows.filter(row => row.status === 'reversed').length }, warnings: result.warnings });
      runs.push(run);
      for (const old of previous) {
        if (old.data.model_key !== key || old.data.status !== 'active') continue;
        const current = selectedOrders.get(result.orderAliases.get(old.data.order_id) ?? old.data.order_id);
        if (!current) {
          const order = await ctx.get('commerce', 'order', old.data.order_id);
          if (order?.data.rolled_back && inPeriod(instant(order.data.placed_at, 'placed_at'), query.period) && (!query.store_ids || query.store_ids.includes(order.data.store_id)))
            await ctx.update(moduleKey, 'attribution_record', old.id, { status: 'reversed', reversed_by_run_id: run.id }, old.version);
          continue;
        }
        await ctx.update(moduleKey, 'attribution_record', old.id, { status: current.status === 'reversed' ? 'reversed' : 'superseded', superseded_by_run_id: run.id }, old.version);
      }
      for (const row of rows) {
        if (row.status === 'ineligible') continue;
        for (const credit of row.credits) {
          const record = await ctx.insert(moduleKey, 'attribution_record', { ...credit, order_id: row.order_id, model_key: key, model_revision: row.model_revision,
            currency: row.currency, status: row.status, run_id: run.id, window_days: row.window_days, unallocated_minor: row.unallocated_minor, evidence: row.evidence });
          records.push(record);
          for (const touch of credit.touches) await ctx.insert(moduleKey, 'attribution_touch', { record_id: record.id, occurred_at: touch.occurred_at, evidence_kind: touch.evidence_kind, evidence_ref: touch.ref });
        }
      }
      await ctx.emit('analytics.attribution_run.completed', { run_id: run.id, model_key: key, revision: result.model_versions[key], orders: rows.length });
    }
    return { runs, records, warnings: result.warnings, attribution_notice: attributionNote };
  } },
};