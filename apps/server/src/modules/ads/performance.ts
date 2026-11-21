import { required, text, type Commands, type Context, type Entity, type Fields } from '../types.js';
import { nativeDay } from '../ingest/model.js';
import { accountAccess, admin, ads, check, cmd, currency, day, eventData, hash, inputRow, integer, localDay, matchingCampaign, optional, read, row, safeSum, same } from './domain.js';

const dayMs = 86400000;
const metrics = ['spend', 'impressions', 'clicks', 'conversions'];
function metricName(key: unknown) {
  if (typeof key !== 'string') return null;
  const name = key.split('.').at(-1)!;
  return metrics.includes(name) ? name : null;
}

async function calculate(ctx: Context, account: Entity, input: Fields) {
  const start_date = day(input.start_date, 'start_date');
  const end_date = day(input.end_date, 'end_date');
  const today = localDay(ctx.now, account.data.timezone);
  const days = Math.round((Date.parse(end_date) - Date.parse(start_date)) / dayMs) + 1;
  check(days >= 1 && days <= 366 && end_date <= today, 'invalid_input', 'Select up to 366 calendar days through today');
  const dates = Array.from({ length: days }, (_, offset) => new Date(Date.parse(start_date) + offset * dayMs).toISOString().slice(0, 10));
  const campaign_id = optional(input, 'campaign_id', 200);
  if (campaign_id) await matchingCampaign(ctx, campaign_id, account.data.brand_id);
  const entity_id = optional(input, 'entity_id', 200);
  if (entity_id) {
    const entity = await row(ctx, 'ad_entity', entity_id);
    same(entity.data.ad_account_id, account.id, 'Report subject');
    if (campaign_id) same(entity.data.campaign_id, campaign_id, 'Report campaign');
  }
  const entities = (await ctx.list(ads, 'ad_entity')).filter(entity => entity.data.ad_account_id === account.id && (!campaign_id || entity.data.campaign_id === campaign_id));
  const entityIds = new Set(entities.map(entity => entity.id));
  const fields = { ad_account_id: account.id, campaign_id, entity_id, start_date, end_date, timezone: account.data.timezone };
  const observations: { row: Entity; date: string | null; metric: string }[] = [];
  for (const item of await ctx.list('analytics', 'metric_observation')) {
    const value = item.data;
    if (value.subject_type !== 'ads.ad_entity' || !entityIds.has(value.subject_id) || (entity_id && value.subject_id !== entity_id) ||
      (value.brand_id && value.brand_id !== account.data.brand_id) || !(Date.parse(value.observed_at) <= Date.parse(ctx.now))) continue;
    const metric = metricName(value.metric_key);
    if (!metric) continue;
    const date = typeof value.date === 'string' ? value.date : value.period_start && Number.isFinite(Date.parse(value.period_start))
      ? localDay(value.period_start, value.timezone ?? account.data.timezone) : null;
    if (!date || date < start_date || date > end_date) continue;
    observations.push({ row: item, date, metric });
  }
  // Spend totals use one aggregate series per subject and accounting day. Segment breakdowns remain visible in raw observations.
  const spend = new Map<string, Entity>();
  for (const { row: item, date, metric } of observations) {
    const data = item.data;
    if (metric !== 'spend' || !date || (data.period_kind !== 'day' && !(data.period_kind == null && data.date)) ||
      Object.keys(data.dims ?? data.dimensions ?? {}).length || (data.timezone && data.timezone !== account.data.timezone)) continue;
    const key = JSON.stringify([data.subject_id, date]);
    const previous = spend.get(key);
    if (!previous || Date.parse(data.observed_at) > Date.parse(previous.data.observed_at) ||
      (Date.parse(data.observed_at) === Date.parse(previous.data.observed_at) && item.id > previous.id)) spend.set(key, item);
  }
  const roots = entity_id ? entities.filter(entity => entity.id === entity_id)
    : entities.filter(entity => !entity.data.parent_entity_id || !entityIds.has(entity.data.parent_entity_id));
  const children = new Map<string, Entity[]>();
  if (!entity_id) for (const entity of entities) {
    const parentId = entity.data.parent_entity_id;
    if (parentId) children.set(parentId, [...(children.get(parentId) ?? []), entity]);
  }
  let total: number | null = null;
  let latest_spend_observed_at: string | null = null;
  const missing_dates: string[] = [];
  function accumulate(node: Entity, date: string): boolean {
    const entry = spend.get(JSON.stringify([node.id, date]));
    if (entry?.data.availability === 'observed' && entry.data.currency === account.data.currency &&
        Number.isSafeInteger(entry.data.value_minor ?? entry.data.value) && (entry.data.value_minor ?? entry.data.value) >= 0) {
      total = safeSum(total ?? 0, entry.data.value_minor ?? entry.data.value);
      const observedAt = new Date(entry.data.observed_at).toISOString();
      if (!latest_spend_observed_at || observedAt > latest_spend_observed_at) latest_spend_observed_at = observedAt;
      return true;
    }
    const descendants = children.get(node.id) ?? [];
    return descendants.length > 0 && descendants.map(child => accumulate(child, date)).every(Boolean);
  }
  for (const date of dates) {
    if (!(roots.length > 0 && roots.map(root => accumulate(root, date)).every(Boolean))) missing_dates.push(date);
  }
  const budgetLines = campaign_id && !entity_id ? (await ctx.list('campaign', 'budget_line')).filter(item =>
    item.data.campaign_id === campaign_id && (item.data.category ?? item.data.kind) === 'ads' &&
    (!item.data.ad_account_id || item.data.ad_account_id === account.id) && item.data.status !== 'archived') : [];
  const budgetTotals = new Map<string, number>();
  for (const line of budgetLines) {
    const code = currency(line.data.currency);
    budgetTotals.set(code, safeSum(budgetTotals.get(code) ?? 0, line.data.amount_minor));
  }
  const budget = budgetTotals.get(account.data.currency) ?? null;
  const pacing_ratio = budget && total !== null ? total / budget : null;
  return { ...fields, provider: account.data.provider, as_of: ctx.now, currency: account.data.currency,
    observations: observations.map(item => item.row),
    totals: { observed_spend_minor: total, latest_spend_observed_at, missing_dates, missing_days: missing_dates.length,
      coverage: (dates.length - missing_dates.length) / dates.length, is_partial: missing_dates.length > 0, pacing_ratio,
      budget_minor: budget, budget_scope: campaign_id && !entity_id ? 'campaign_allocation' : null, budget_by_currency: Object.fromEntries(budgetTotals) },
  };
}

export const performance: Commands = {
  import_ad_report: cmd(admin, async (ctx, input) => {
    const account = await inputRow(ctx, 'ad_account', input, 'ad_account_id');
    accountAccess(ctx, account, 'draft');
    const batch = await required(ctx, 'ingest', 'import_batch', text(input, 'import_batch_id', 200));
    check(batch.data.template_key === 'ad_report' && ['merged', 'partially_merged'].includes(batch.data.status),
      'invalid_state', 'The ad report import batch must be merged', 409);
    if (batch.data.provider !== 'file_import') same(batch.data.provider, account.data.provider, 'Import provider');
    if (batch.data.ad_account_id) same(batch.data.ad_account_id, account.id, 'Import account');
    else check(batch.data.actor_id === ctx.actorId, 'forbidden', 'Only the import owner may bind an unassigned ad report to this account', 403);
    if (batch.data.data_source_id) {
      const source = await required(ctx, 'ingest', 'data_source', batch.data.data_source_id);
      same(source.data.ad_account_id, account.id, 'Import data source account');
    }
    same(batch.data.options?.timezone, account.data.timezone, 'Import timezone');
    const bindingId = hash(['ad_report_binding', batch.id]);
    const binding = await ctx.get(ads, 'ad_report_import', bindingId);
    if (binding) {
      same(binding.data.ad_account_id, account.id, 'Imported report account');
      return binding;
    }
    const targets = new Map((await ctx.list(ads, 'ad_entity')).filter(item => item.data.ad_account_id === account.id && item.data.level === 'ad')
      .map(item => [item.data.external_id, item]));
    const lines = (await ctx.list('ingest', 'import_row')).filter(item => item.data.batch_id === batch.id && ['merged', 'skipped'].includes(item.data.status));
    check(lines.length > 0, 'invalid_state', 'The ad report contains no merged observations', 409);
    const observationIds: string[] = [];
    const observedAt = new Date(batch.data.merged_at ?? batch.updated_at).toISOString();
    for (const line of lines) {
      const ref = line.data.target_ref;
      if (ref?.module === 'analytics' && ref.resource_type === 'metric_observation') {
        const observation = await required(ctx, 'analytics', 'metric_observation', ref.resource_id);
        same(observation.data.ad_account_id, account.id, 'Imported observation account');
        observationIds.push(observation.id);
        continue;
      }
      const values = line.data.normalized;
      const entity = targets.get(values.external_ad_id);
      check(entity, 'unknown_ad_entity', 'Register each imported ad under this account before ingesting its report', 409);
      const code = currency(values.currency);
      check(code === account.data.currency, 'currency_mismatch', 'Report currency must match the ad account');
      const date = day(values.report_day ?? localDay(values.report_date, account.data.timezone), 'report_date');
      const [start, end] = nativeDay(date, account.data.timezone);
      check(start <= Date.parse(observedAt), 'invalid_input', 'Report period must begin by its observation time');
      const value = integer(values.amount_minor, 'amount_minor');
      const id = hash(['ad_report_observation', batch.id, entity.id, date]);
      await ctx.insert('analytics', 'metric_observation', { subject_type: 'ads.ad_entity', subject_id: entity.id, brand_id: account.data.brand_id,
        metric_key: `${account.data.provider}.spend`, definition_revision: 1, value, availability: 'observed', currency: code,
        date, timezone: account.data.timezone, platform: account.data.provider, dims: {}, period_kind: 'day', period_start: new Date(start).toISOString(),
        period_end: new Date(end).toISOString(), observed_at: observedAt, source: { method: 'import', batch_id: batch.id, row_id: line.id } }, id);
      observationIds.push(id);
    }
    const imported = await ctx.insert(ads, 'ad_report_import', { ad_account_id: account.id, import_batch_id: batch.id,
      observation_ids: observationIds, recorded_by: ctx.actorId }, bindingId);
    await ctx.emit('analytics.observations.recorded', { subject_type: 'ads.ad_entity', count: observationIds.length, ad_account_id: account.id, batch_id: batch.id });
    await ctx.emit('ads.report.imported', eventData(ctx, imported, { ad_account_id: account.id, import_batch_id: batch.id }));
    return imported;
  }),
  query_performance: cmd(read, async (ctx, input) => {
    const account = await inputRow(ctx, 'ad_account', input, 'ad_account_id');
    accountAccess(ctx, account, 'read');
    return calculate(ctx, account, input);
  }),
  save_performance_snapshot: cmd(['owner', 'admin', 'editor'], async (ctx, input) => {
    const account = await inputRow(ctx, 'ad_account', input, 'ad_account_id');
    accountAccess(ctx, account, 'read');
    accountAccess(ctx, account, 'export');
    const report = await calculate(ctx, account, input);
    const { observations, ...data } = report;
    const observation_ids = observations.map(item => item.id).sort();
    const observed_count = observations.filter(item => item.data.availability === 'observed' && Number.isFinite(item.data.value)).length;
    const snapshot = await ctx.insert(ads, 'ad_performance_snapshot', { ...data, observation_ids, observed_count, created_by: ctx.actorId });
    if (report.campaign_id && report.totals.pacing_ratio !== null && report.totals.pacing_ratio > 1) {
      const id = hash(['pacing_alert', account.id, report.campaign_id, report.start_date, report.end_date, ctx.now.slice(0, 13)]);
      if (!(await ctx.get(ads, 'ad_pacing_alert', id))) {
        const alert = await ctx.insert(ads, 'ad_pacing_alert', { ad_account_id: account.id, campaign_id: report.campaign_id, snapshot_id: snapshot.id,
          ratio: report.totals.pacing_ratio, status: 'over_budget' }, id);
        await ctx.emit('ads.budget.pacing_alert', eventData(ctx, alert, alert.data));
      }
    }
    return snapshot;
  }),
  get_performance_snapshot: cmd(read, async (ctx, input) => {
    const snapshot = await row(ctx, 'ad_performance_snapshot', text(input, 'id', 200));
    const account = await row(ctx, 'ad_account', snapshot.data.ad_account_id);
    accountAccess(ctx, account, 'read');
    return snapshot;
  }),
};
