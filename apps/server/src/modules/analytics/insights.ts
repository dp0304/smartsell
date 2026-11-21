import type { Context, Data } from '@smartsell/contracts';
import { orderRefunds, orders } from './commerce.ts';
import { addCalendarMonths, attestedHistoryStart, cohortHistory, cohortLimitations, firstPurchase } from './cohort-history.ts';
import { compareMetrics, metricQueryInput } from './metrics.ts';
import { array, choice, conflict, currency, date, dto, factDate, finite, inPeriod, invalid, localDay, minor, object, optionalString, period, strings, text, timezone } from './validation.ts';

const experimentFields = ['hypothesis', 'type', 'primary_metric', 'success_criteria', 'period', 'stop_conditions', 'variants', 'minimum_sample_size', 'status', 'limitations', 'decision', 'started_at', 'stopped_at', 'concluded_at'];
const resultFields = ['experiment_id', 'source', 'source_ref', 'as_of', 'variants', 'limitations'];
export const experiments = (ctx: Context) => ctx.list('experiment').map(row => dto(row, experimentFields));
export function getExperiment(ctx: Context, id: string) {
  const experiment = ctx.get('experiment', id);
  const pageId = experiment.type === 'page' ? ctx.list('experiment_assignment').find(row => row.experiment_id === id)?.landing_page_id : undefined;
  return { ...dto(experiment, experimentFields), ...(pageId ? { landing_page_id: pageId } : {}), result_snapshots: ctx.list('experiment_result_snapshot')
    .filter(row => row.experiment_id === id).map(row => dto(row, resultFields)) };
}
export function saveExperiment(ctx: Context, body: Data, id?: string) {
  const prior = id ? ctx.get('experiment', id) : undefined;
  if (prior && prior.status !== 'draft') conflict('Experiment design is frozen');
  const input = { ...prior, ...body };
  const type = choice(input.type, ['content', 'page', 'ad'], 'experiment type');
  const ref_type = { content: 'content_variant', page: 'landing_page_version', ad: 'ad_creative' }[type];
  const variants = array(input.variants, 'variants', 30).map(raw => {
    const variant = object(raw), ref_id = text(variant.ref_id, 'ref_id');
    if (!finite(variant.allocation) || variant.allocation <= 0 || variant.allocation > 100) invalid('Allocations must be percentages');
    ctx.get(ref_type, ref_id);
    return { ref_type, ref_id, allocation: variant.allocation };
  });
  if (variants.length < 2 || new Set(variants.map(row => row.ref_id)).size !== variants.length ||
    Math.abs(variants.reduce((sum, row) => sum + row.allocation, 0) - 100) > 1e-8) invalid('At least two distinct variants must allocate 100%');
  const minimum_sample_size = input.minimum_sample_size;
  if (minimum_sample_size != null && (!minor(minimum_sample_size) || minimum_sample_size === 0)) invalid('Minimum sample size must be a positive integer');
  const values = { hypothesis: text(input.hypothesis, 'hypothesis'), type, primary_metric: text(input.primary_metric, 'primary_metric'),
    ...(minimum_sample_size != null ? { minimum_sample_size } : {}),
    success_criteria: text(input.success_criteria, 'success_criteria'), period: period(input.period), stop_conditions: strings(input.stop_conditions ?? [], 'stop_conditions'),
    variants, status: 'draft' };
  return dto(id ? ctx.update('experiment', id, values) : ctx.create('experiment', values), experimentFields);
}
export function experimentAction(ctx: Context, id: string, action: 'start' | 'stop' | 'conclude' | 'archive', body: Data) {
  const row = ctx.get('experiment', id), now = date(ctx.now), bounds = period(row.period);
  const states = { start: 'running', stop: 'stopped', conclude: 'concluded', archive: 'archived' } as const;
  const status = states[action];
  const changes: Data = { status };
  if (action === 'start') {
    if (row.status !== 'draft' || now >= bounds.to) conflict('Experiment must be a draft with remaining observation time');
    changes.started_at = now;
  } else if (action === 'stop') {
    if (row.status !== 'running') conflict('Only a running experiment can stop');
    changes.stopped_at = now;
  } else if (action === 'conclude') {
    if (row.status !== 'stopped' && (row.status !== 'running' || now < bounds.to)) conflict('Stop experiment or wait for the observation period to end');
    changes.limitations = strings(body.limitations, 'limitations');
    if (!(changes.limitations as string[]).length) invalid('Conclusion requires limitations');
    changes.decision = text(body.decision, 'decision');
    changes.concluded_at = now;
  } else if (row.status !== 'concluded') conflict('Only a concluded experiment can be archived');
  const saved = ctx.update('experiment', id, changes);
  ctx.emit('analytics.experiment.state_changed', { experiment_id: id, from: row.status, status });
  return dto(saved, experimentFields);
}
export function recordExperimentResult(ctx: Context, id: string, body: Data) {
  const row = ctx.get('experiment', id);
  if (!['running', 'stopped', 'concluded'].includes(String(row.status))) conflict('Experiment must have started');
  const source = choice(body.source, ['manual', 'page', 'ad', 'incrementality_service'], 'source');
  if ((source === 'page' || source === 'ad') && source !== row.type) invalid('Result source must match experiment type');
  const source_ref = text(body.source_ref, 'source_ref');
  const as_of = date(body.as_of);
  if (as_of > date(ctx.now) || (row.started_at && as_of < String(row.started_at))) invalid('Result cutoff is outside the elapsed experiment');
  const refs = new Set((row.variants as { ref_id: string }[]).map(variant => variant.ref_id));
  const variants = array(body.variants, 'variants', 30).map(raw => {
    const entry = object(raw), ref_id = text(entry.ref_id, 'ref_id');
    if (!refs.delete(ref_id) || !minor(entry.sample_size) || (entry.value !== null && !finite(entry.value)) || (entry.sample_size === 0 && entry.value !== null)) {
      invalid('Invalid result variance, sample, or value');
    }
    return { ref_id, sample_size: entry.sample_size, value: entry.value };
  });
  if (refs.size) invalid('Result must contain all variants');
  const limitations = strings(body.limitations, 'limitations');
  if (!limitations.length) invalid('Provide result limitations');
  const prior = ctx.list('experiment_result_snapshot').find(snapshot => snapshot.experiment_id === id && snapshot.source === source && snapshot.source_ref === source_ref);
  if (prior) conflict('Result evidence has already been recorded');
  return dto(ctx.create('experiment_result_snapshot', { experiment_id: id, source, source_ref, as_of, variants, limitations }), resultFields);
}

const costFields = ['product_variant_id', 'cost_minor', 'currency', 'valid_from', 'source', 'source_ref'];

export function prepareReportUnitCost(ctx: Context, storeId: string, input: Data, provenance: Data) {
  const sku = text(input.sku, 'sku');
  const variants = ctx.list('product_variant').filter(row => row.store_id === storeId && row.sku === sku);
  if (variants.length !== 1) invalid('Unit cost requires a unique SKU in the selected store');
  if (!minor(input.amount_minor)) invalid('Expected a nonnegative integer minor-unit cost');
  const value = { product_variant_id: variants[0].id, cost_minor: input.amount_minor, currency: currency(input.currency),
    valid_from: date(input.observed_day ?? input.observed_at) };
  const previous = ctx.list('unit_cost_version').find(row => row.product_variant_id === value.product_variant_id && row.currency === value.currency && row.valid_from === value.valid_from);
  const changed = previous?.cost_minor !== value.cost_minor;
  if (previous && changed && (previous.source !== 'import' || typeof previous.import_source !== 'object' || previous.import_source === null)) {
    conflict('A different cost already exists at the effective date');
  }
  const status = !previous ? 'new' : changed ? 'changed' : 'unchanged';
  return { status, apply: () => {
    if (previous && !changed) return previous;
    const data = { ...value, source: 'import', source_ref: provenance.row_id ?? provenance.batch_id, import_source: provenance };
    const row = previous ? ctx.update('unit_cost_version', previous.id, data) : ctx.create('unit_cost_version', data);
    ctx.emit('analytics.unit_costs.recorded', { count: 1, unit_cost_version_id: row.id, batch_id: provenance.batch_id });
    return row;
  } } as const;
}

export function importUnitCosts(ctx: Context, body: Data) {
  const existing = ctx.list('unit_cost_version');
  const inserted: Data[] = [];
  for (const raw of array(body.rows, 'rows')) {
    const input = object(raw), product_variant_id = text(input.product_variant_id, 'product_variant_id');
    ctx.get('product_variant', product_variant_id);
    if (!minor(input.cost_minor)) invalid('Expected a nonnegative integer minor-unit cost');
    const value = { product_variant_id, cost_minor: input.cost_minor, currency: currency(input.currency), valid_from: date(input.valid_from),
      source: choice(input.source ?? 'manual', ['manual', 'import', 'erp'], 'source'), source_ref: text(input.source_ref, 'source_ref') };
    const previous = existing.find(row => row.product_variant_id === value.product_variant_id && row.currency === value.currency && row.valid_from === value.valid_from);
    if (previous) {
      if (previous.cost_minor !== value.cost_minor) conflict('A different cost already exists at the effective date');
      continue;
    }
    const row = ctx.create('unit_cost_version', value);
    existing.push(row);
    inserted.push(dto(row, costFields));
  }
  return { inserted };
}
const costItems = ['product_cost', 'shipping', 'payment_fees', 'ad_spend', 'fixed_collaboration_fees', 'commission', 'samples_and_production'] as const;
/** Normalized authorized inputs from commerce, campaign, ads, creator or settlement sources. */
export function recordContributionInputs(ctx: Context, input: Data) {
  const scope = text(input.scope, 'scope'), range = period(input), code = currency(input.currency);
  const existing = ctx.list('contribution_input');
  let inserted = 0;
  for (const raw of array(input.rows, 'rows')) {
    const row = object(raw), item = choice(row.item, ['net_sales', ...costItems], 'item');
    const source_ref = text(row.source_ref, 'source_ref');
    const settlement_id = row.settlement_id === undefined ? undefined : text(row.settlement_id, 'settlement_id');
    if (typeof row.complete !== 'boolean' || (row.complete ? !minor(row.amount_minor) : row.amount_minor != null)) {
      invalid('An incomplete contribution input must omit its amount');
    }
    const value = { scope, currency: code, period_start: range.from, period_end: range.to,
      item, amount_minor: row.amount_minor ?? null, source_ref, settlement_id, complete: row.complete };
    const prior = existing.find(entry => entry.scope === scope && entry.currency === code && entry.item === item && entry.source_ref === source_ref
      && entry.period_start === range.from && entry.period_end === range.to);
    if (prior) {
      if (prior.amount_minor !== value.amount_minor || prior.settlement_id !== settlement_id || prior.complete !== value.complete) {
        conflict('Contribution source reference already holds a different result');
      }
      continue;
    }
    existing.push(ctx.create('contribution_input', value));
    inserted++;
  }
  return { inserted };
}

export function contribution(ctx: Context, input: Data) {
  const scope = text(input.scope, 'scope'), range = period(input), code = currency(input.currency);
  const rows = ctx.list('contribution_input').filter(row => row.scope === scope && row.currency === code
    && factDate(row.period_start) === range.from && factDate(row.period_end) === range.to);
  const items = ['net_sales', ...costItems].map(item => {
    const selected = rows.filter(row => row.item === item);
    const unique = new Map<string, typeof selected[number]>();
    let complete = selected.length > 0;
    for (const row of selected) {
      const ref = optionalString(row.settlement_id) ?? optionalString(row.source_ref);
      if (!ref || row.complete !== true || !minor(row.amount_minor)) { complete = false; continue; }
      const known = unique.get(ref);
      if (known && known.amount_minor !== row.amount_minor) complete = false;
      unique.set(ref, row);
    }
    const amount = [...unique.values()].reduce((sum, row) => sum + Number(row.amount_minor), 0);
    return { item, value: complete && minor(amount) ? amount : null, sources: [...unique.keys()] };
  });
  const missing_items = items.filter(row => row.value === null).map(row => row.item);
  const costs = items.slice(1).reduce((sum, row) => sum + (row.value ?? 0), 0);
  return { scope, period: range, currency: code, formula_version: 1, items, missing_items,
    value_minor: missing_items.length || !minor(costs) ? null : items[0].value! - costs, interpretation: 'Estimated contribution only. Financial profit and payable commissions require separate accounting.' };
}

export function cohorts(ctx: Context, input: Data, storeId?: string) {
  const range = period(input);
  const selectedStore = storeId ?? (input.store_id === undefined ? undefined : text(input.store_id, 'store_id'));
  const stores = ctx.list('store').filter(store => !selectedStore || store.id === selectedStore);
  const months = Number(input.observation_months ?? 1);
  if (!Number.isSafeInteger(months) || months < 1 || months > 24) invalid('Observation months must be 1–24');
  const history_months = Number(input.history_months ?? 3);
  if (!Number.isSafeInteger(history_months) || history_months < 1 || history_months > 24) invalid('History months must be 1–24');
  const asOf = date(ctx.now);
  const allOrders = orders(ctx).filter(row => (factDate(row.placed_at) ?? '\uffff') <= asOf);
  return stores.map(store => {
    const sourceIds = new Set(ctx.list('data_source').filter(source => source.store_id === store.id).map(source => source.id));
    const windows = ctx.list('coverage_segment').filter(row => row.active !== false && row.resource === 'orders'
      // Synchronization keeps old attempts. A successful read closes the corresponding gap.
      && (row.store_id === store.id || (row.store_id == null && sourceIds.has(String(row.data_source_id)) && row.status === 'complete')))
      .map(row => ({ status: row.status, window_start: row.window_start ?? row.from, window_end: row.window_end ?? row.to }));
    const start = store.history_coverage_from ?? attestedHistoryStart(windows, range.to < asOf ? range.to : asOf);
    const history = cohortHistory(store.provider, start, asOf, history_months);
    const limitations = new Set(cohortLimitations(history, range.from));
    const verified = new Set(ctx.list('store_customer').filter(row => row.store_id === store.id && row.identity_verified === true).map(row => row.id));
    const byCustomer = new Map<string, typeof allOrders>();
    let unidentified = 0;
    for (const order of allOrders.filter(row => row.store_id === store.id && !row.cancelled_at && ['paid', 'partially_paid', 'partially_refunded'].includes(String(row.financial_status)) && minor(row.total_minor))) {
      const succeeded = orderRefunds(ctx, order, row => !row.created_at || (factDate(row.created_at) ?? '\uffff') <= asOf)
        .filter(row => row.status === 'succeeded' && (row.currency === undefined || row.currency === order.currency) && minor(row.amount_minor))
        .reduce((sum, row) => sum + BigInt(row.amount_minor as number), 0n);
      if (succeeded >= BigInt(order.total_minor as number)) continue;
      const customer = String(order.store_customer_id);
      if (history.excluded || !verified.has(customer)) { if (inPeriod(order.placed_at, range)) unidentified++; continue; }
      if (!factDate(order.placed_at)) continue;
      if (!byCustomer.has(customer)) byCustomer.set(customer, []);
      byCustomer.get(customer)!.push(order);
    }
    const byMonth = new Map<string, { first_seen: number; confirmed_new: number; repeat: number; mature: number; limitations: Set<string> }>();
    for (const candidates of byCustomer.values()) {
      candidates.sort((a, b) => factDate(a.placed_at)!.localeCompare(factDate(b.placed_at)!));
      const first = candidates[0];
      if (!inPeriod(first.placed_at, range)) continue;
      const month = localDay(factDate(first.placed_at)!, range.tz).slice(0, 7);
      const when = factDate(first.placed_at)!;
      const evidence = firstPurchase(when, first.customer_order_index, history);
      if (evidence.knownReturning) continue;
      const finish = addCalendarMonths(when, months);
      const mature = finish <= asOf;
      const repeat = mature && candidates.slice(1).some(row => factDate(row.placed_at)! < finish);
      const counts = byMonth.get(month) ?? { first_seen: 0, confirmed_new: 0, repeat: 0, mature: 0, limitations: new Set<string>() };
      counts.first_seen++;
      if (evidence.reason) {
        counts.limitations.add(evidence.reason);
        limitations.add(evidence.reason);
      } else counts.confirmed_new++;
      if (mature) counts.mature++;
      if (repeat) counts.repeat++;
      byMonth.set(month, counts);
    }
    return { store_id: store.id, store_name: store.name, provider: store.provider, ...history, history_months, unidentified_orders: unidentified, observation_months: months, limitations: [...limitations],
      rows: [...byMonth].sort(([a], [b]) => a.localeCompare(b)).map(([month, { limitations, ...data }]) => ({ month, ...data, limitations: [...limitations], new_customer_reliability: data.confirmed_new === data.first_seen ? 'high' : 'low',
        repeat_rate: data.mature === data.first_seen ? data.repeat / data.mature : null })) };
  });
}

const audienceFields = ['social_account_id', 'dimension', 'values', 'source', 'source_ref', 'observed_at'];
export function audienceInsights(ctx: Context, account?: string) {
  return ctx.list('audience_insight_snapshot').filter(row => !account || row.social_account_id === account).map(row => dto(row, audienceFields));
}
export function recordAudience(ctx: Context, input: Data) {
  const social_account_id = text(input.social_account_id, 'social_account_id');
  ctx.get('social_account', social_account_id);
  const observed_at = date(input.observed_at);
  if (observed_at > date(ctx.now)) invalid('Audience observation is in the future');
  const dimension = choice(input.dimension, ['country', 'age', 'gender', 'active_hour', 'language'], 'dimension');
  const source = choice(input.source, ['platform', 'owned_engagement', 'third_party_estimate'], 'source');
  const source_ref = text(input.source_ref, 'source_ref');
  const values = array(input.values, 'values').map(raw => {
    const item = object(raw);
    if (item.value !== null && (!finite(item.value) || item.value < 0)) invalid('Invalid audience value');
    return { bucket: text(item.bucket, 'bucket'), value: item.value };
  });
  const prior = ctx.list('audience_insight_snapshot').find(row => row.social_account_id === social_account_id && row.dimension === dimension
    && row.source === source && row.source_ref === source_ref && row.observed_at === observed_at);
  if (prior) {
    if (JSON.stringify(prior.values) !== JSON.stringify(values)) conflict('Audience observation already has a different result');
    return dto(prior, audienceFields);
  }
  return dto(ctx.create('audience_insight_snapshot', { social_account_id, observed_at, dimension, source, source_ref, values }), audienceFields);
}
const recommendationFields = ['social_account_id', 'timezone', 'content_type', 'metric_key', 'basis_period', 'sample_size', 'slots', 'method_version', 'limitations', 'status'];
export function postingTimes(ctx: Context, id?: string) {
  return ctx.list('posting_time_recommendation').filter(row => !id || row.social_account_id === id).map(row => dto(row, recommendationFields));
}
export function suggestPostingTime(ctx: Context, input: Data) {
  const social_account_id = text(input.social_account_id, 'social_account_id');
  const account = ctx.get('social_account', social_account_id), tz = timezone(account.default_timezone ?? account.timezone ?? 'UTC');
  const content_type = text(input.content_type, 'content_type'), metric_key = text(input.metric_key, 'metric_key');
  const basis_period = period({ ...input, tz });
  const posts = ctx.list('platform_post').filter(row => row.social_account_id === social_account_id && row.content_type === content_type && inPeriod(row.published_at, basis_period));
  const slots = new Map<string, { weekday: string; hour: number; scores: number[] }>();
  let sample_size = 0;
  const clock = new Intl.DateTimeFormat('en', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
  for (const post of posts) {
    const result = compareMetrics(ctx, metricQueryInput(ctx, { metrics: [metric_key], subject: { type: 'platform_post', filter: { subject_ids: [post.id] } },
      time: { ...basis_period, basis: 'published_at' }, age_bucket: '24h', traffic_source: 'organic' }));
    const point = result.rows[0]?.values[metric_key];
    if (!point || point.value === null || point.estimate || !result.evidence.some(entry => entry.metric_key === metric_key && (entry.deviation_seconds ?? Infinity) <= 8640)) continue;
    const parts = clock.formatToParts(new Date(String(post.published_at)));
    const weekday = parts.find(part => part.type === 'weekday')!.value, hour = Number(parts.find(part => part.type === 'hour')!.value);
    const key = `${weekday}:${hour}`;
    if (!slots.has(key)) slots.set(key, { weekday, hour, scores: [] });
    slots.get(key)!.scores.push(point.value);
    sample_size++;
  }
  const ranked = [...slots.values()].filter(row => row.scores.length >= 3).map(row => ({ weekday: row.weekday, hour: row.hour,
    sample_size: row.scores.length, score: row.scores.reduce((sum, value) => sum + value, 0) / row.scores.length }))
    .sort((a, b) => b.score - a.score).slice(0, 5);
  if (sample_size < 30 || !ranked.length) return { recommendation: null, sample_size, minimum_sample_size: 30, minimum_slot_sample_size: 3,
    reason: sample_size < 30 ? 'INSUFFICIENT_COMPARABLE_OBSERVATIONS' : 'INSUFFICIENT_SLOT_SAMPLE', timezone: tz };
  const row = ctx.create('posting_time_recommendation', { social_account_id, timezone: tz, content_type, metric_key, basis_period, sample_size,
    slots: ranked, method_version: 1, status: 'proposed', limitations: ['Observational comparison using organic engagement at 24 hours.'] });
  ctx.emit('analytics.recommendation.created', { recommendation_id: row.id, social_account_id });
  return dto(row, recommendationFields);
}

export function applyPostingTime(ctx: Context, id: string) {
  const recommendation = ctx.get('posting_time_recommendation', id);
  if (recommendation.status !== 'proposed') conflict('Recommendation has already been acted on');
  const account = ctx.get('social_account', String(recommendation.social_account_id));
  const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const slots = recommendation.slots as { weekday: string; hour: number }[];
  const existing = ctx.list('slot_template');
  const applied = slots.map(slot => {
    const values = { social_account_id: account.id, weekday: weekdays.indexOf(slot.weekday) + 1,
      local_time: `${String(slot.hour).padStart(2, '0')}:00`, tz: recommendation.timezone };
    return existing.find(row => row.social_account_id === values.social_account_id && row.weekday === values.weekday
      && row.local_time === values.local_time && row.tz === values.tz)
      ?? ctx.create('slot_template', { ...values, label: 'Analytics recommendation' });
  });
  ctx.update('posting_time_recommendation', id, { status: 'applied' });
  ctx.emit('analytics.recommendation.applied', { recommendation_id: id, slot_template_ids: applied.map(row => row.id) });
  return { recommendation_id: id, slot_template_ids: applied.map(row => row.id) };
}
