import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { checkUse as checkIngestUse } from '../ingest/source-policy.js';
import { choice, conflict, flag, inPeriod, integer, invalid, money, number, object, optionalText, period, strings, text, time, url } from './input.js';
import { fromAgent } from '../../agent-actor.js';

export const modes = ['manual', 'import', 'vendor', 'official_api'] as const;
export type Mode = typeof modes[number];
const subjects = ['post', 'account', 'product', 'video', 'live'] as const;
const availability = ['available', 'observed', 'estimated', 'source_not_provided', 'delayed', 'not_applicable', 'no_permission', 'not_collected', 'sync_failed'] as const;
const publicCounts = ['likes', 'comments', 'shares', 'views', 'followers', 'reactions', 'reviews'];
const privateCounts = ['impressions', 'reach', 'sales', 'units_sold', 'orders', 'clicks', 'saves', 'conversions'];
const amounts = ['price', 'gmv', 'revenue'];
const day = 86_400_000;
const metricNames = [...publicCounts, ...privateCounts, ...amounts, 'commission_rate'];
const privateMetrics = [...privateCounts, 'gmv', 'revenue', 'commission_rate'];
const valueAvailable = ['available', 'observed', 'estimated'];
export const ageBuckets = ['0-24h', '1-7d', '7-30d'] as const;
const ageBounds: Record<typeof ageBuckets[number], [number, number]> = {
  '0-24h': [0, 86400], '1-7d': [86400, 604800], '7-30d': [604800, 2592000],
};
export const observationAgeBounds = (bucket: typeof ageBuckets[number]) => ageBounds[bucket];
export function inAgeBucket(age: unknown, bounds: readonly [number, number]) {
  return typeof age === 'number' && age >= bounds[0] && age < bounds[1];
}

export function watchTargetCoverage(ctx: Context, target: Row): Row {
  const source = target.data_source_id ? ctx.list('data_source').find(row => row.id === target.data_source_id) : undefined;
  const policy = source?.allowed_uses as Data | undefined;
  const readable = source?.status === 'active' && policy?.display === true;
  return { ...target, acquisition: { method: target.data_mode, automated: ['vendor', 'official_api'].includes(String(target.data_mode)),
    data_source_id: target.data_source_id ?? null, source_status: source?.status ?? null, coverage_note: target.coverage_note,
    resources: readable ? source.resources : [], field_coverage: readable ? source.field_coverage ?? {} : {},
    allowed_uses: readable ? Object.fromEntries(['display', 'team_share', 'export', 'model_processing', 'cache_days'].map(key => [key, policy?.[key] ?? null])) : null,
  } };
}

export function checkUse(ctx: Context, sourceId: string, use: 'display' | 'team_share' | 'export' | 'model_processing'): Row {
  const source = ctx.list('data_source').find(row => row.id === sourceId);
  if (!source || source.status !== 'active') {
    throw new Problem(403, 'EGRESS_BLOCKED', `Data source does not currently allow ${use}`, { data_source_id: sourceId, use });
  }
  checkIngestUse(ctx, [sourceId], use);
  return source;
}

export function sourceRow(ctx: Context, sourceId: string, mode: Mode, brandId: unknown): Row {
  const source = checkUse(ctx, sourceId, 'display');
  if (source.brand_id && source.brand_id !== brandId) conflict('Data source is scoped to another brand');
  if (mode === 'vendor' && (source.kind !== 'vendor' || typeof source.contract_ref !== 'string' || !source.contract_ref.trim())) conflict('Vendor monitoring requires an active provider with a recorded contract');
  if (mode === 'official_api' && (!['platform_account', 'store'].includes(String(source.kind)) || !source.connection_id)) conflict('Official monitoring requires an active official data source');
  if (mode === 'import' && source.kind !== 'file_import') conflict('Import requires a file import source');
  if (mode === 'manual') invalid('data_source_id', 'does not apply to manual acquisition');
  return source;
}

export function metrics(value: unknown, permitted: readonly string[] = []): Data {
  const result: Data = {};
  for (const [name, entry] of Object.entries(value == null ? {} : object(value, 'metrics'))) {
    if (!metricNames.includes(name)) invalid(`metrics.${name}`, 'is not an allowed metric');
    const m = object(entry, `metrics.${name}`);
    const status = choice(m.availability ?? (amounts.includes(name) && m.amount_minor !== undefined ? 'observed' : undefined), availability, `metrics.${name}.availability`);
    if (!['available', 'observed', 'estimated'].includes(status)) {
      if (m.value != null || m.amount_minor != null) invalid(`metrics.${name}`, 'must omit unavailable values');
      result[name] = { availability: status };
      continue;
    }
    if (![...publicCounts, 'price', ...permitted].includes(name)) invalid(`metrics.${name}`, 'requires explicit source field permission');
    result[name] = amounts.includes(name)
      ? { availability: status, ...money(m.value ?? m, `metrics.${name}`) }
      : { availability: status, value: name === 'commission_rate' ? number(m.value, `metrics.${name}.value`, 0, 1) : integer(m.value, `metrics.${name}.value`) };
  }
  for (const name of privateMetrics) result[name] ??= { availability: 'source_not_provided' };
  return result;
}

export function isExpired(ctx: Context, row: Row): boolean {
  const source = row.source as Data | undefined;
  const record = source?.data_source_id && ctx.list('data_source').find(item => item.id === source.data_source_id);
  const days = record ? ((record as Row).allowed_uses as Data | undefined)?.cache_days : undefined;
  const current = typeof days === 'number' ? Date.parse(row.created_at) + days * day : Infinity;
  const initial = typeof row.retention_until === 'string' ? Date.parse(row.retention_until) : Infinity;
  return Date.parse(ctx.now) >= Math.min(current, initial);
}

export function canDisplay(ctx: Context, row: Row): boolean {
  const source = row.source as Data | undefined;
  if (typeof source?.data_source_id !== 'string') return true;
  try { checkUse(ctx, source.data_source_id, 'display'); } catch (error) {
    if (error instanceof Problem && error.code === 'EGRESS_BLOCKED') return false;
    throw error;
  }
  return !isExpired(ctx, row);
}

export function purgeExpiredObservations(ctx: Context): { removed: number } {
  const expired = ctx.list('observation').filter(row => isExpired(ctx, row));
  for (const row of expired) ctx.remove('observation', row.id);
  return { removed: expired.length };
}

export function subjectKey(row: Data): string {
  return JSON.stringify([row.watch_target_id, row.subject_type, row.external_id ?? row.url]);
}

export function prepareObservation(ctx: Context, body: Data, mode: Mode = 'manual'): (() => Row) & { status: 'create' | 'skip' } {
  const target = ctx.get('watch_target', text(body.watch_target_id, 'watch_target_id', 200));
  if (target.status !== 'active') conflict('Observations require an active watch target');
  const sourceId = optionalText(body.data_source_id, 'data_source_id', 200);
  if (sourceId && target.data_source_id && sourceId !== target.data_source_id) conflict('Data source is not bound to this target');
  if ((mode === 'vendor' || mode === 'official_api') && (target.data_mode !== mode || !sourceId || sourceId !== target.data_source_id)) conflict('Automated observations require the target’s configured data source');
  if (mode === 'manual' && target.data_mode !== 'manual') conflict('This target does not accept manual observations');
  if (mode === 'import' && (['vendor', 'official_api'].includes(String(target.data_mode)) || (target.data_source_id && sourceId !== target.data_source_id))) {
    conflict('Imports must use the target’s configured import source');
  }
  if (body.collection_authorized !== undefined && !flag(body.collection_authorized, 'collection_authorized')) {
    throw new Problem(403, 'EGRESS_BLOCKED', 'Collection requires permission from the source');
  }
  const record = sourceId ? sourceRow(ctx, sourceId, mode, target.brand_id) : undefined;
  const observedAt = time(body.observed_at, 'observed_at');
  const publishedAt = body.published_at == null ? null : time(body.published_at, 'published_at');
  if (Date.parse(observedAt) > Date.parse(ctx.now)) invalid('observed_at', 'cannot be in the future');
  if (publishedAt && publishedAt > observedAt) invalid('published_at', 'cannot follow observed_at');
  const meta = body.source == null ? {} : object(body.source, 'source');
  const externalId = optionalText(body.external_id, 'external_id', 200);
  const visibility = choice(meta.visibility ?? (record ? 'authorized' : 'public'), ['public', 'authorized'], 'source.visibility');
  if (visibility === 'authorized' && !record) invalid('source.visibility', 'requires configured source');
  const subject = choice(body.subject_type, subjects, 'subject_type');
  const resourcesBySubject = {
    post: ['posts', 'post_metrics'], account: ['account_profile', 'account_metrics'], product: ['products', 'product_metrics'],
    video: ['videos', 'video_metrics', 'post_metrics'], live: ['live', 'live_metrics'],
  };
  const configuredResources = Array.isArray(record?.resources) ? record.resources : [];
  const matchingResources = resourcesBySubject[subject].filter(resource => configuredResources.includes(resource));
  if (record && mode !== 'import' && matchingResources.length === 0) conflict('Source does not cover this observation subject');
  const coverage = record?.field_coverage as Record<string, Data> | undefined;
  const fields = visibility === 'authorized' ? matchingResources.flatMap(resource => {
    const scope = coverage?.[resource];
    if (['not_collected', 'no_permission', 'unavailable', 'unsupported'].includes(String(scope?.status))) return [];
    return Array.isArray(scope?.fields) ? scope.fields.filter((field): field is string => typeof field === 'string') : [];
  }) : [];
  const observedMetrics = metrics(body.metrics, fields);
  const estimatedMetrics = Object.values(observedMetrics).some(value => (value as Data).availability === 'estimated');
  const vendorEstimates = mode === 'vendor' && ['sales', 'units_sold', 'gmv', 'commission_rate'].some(key => {
    const m = observedMetrics[key] as Data | undefined;
    return m?.value !== undefined || m?.amount_minor !== undefined;
  });
  const batchId = optionalText(meta.batch_id, 'source.batch_id', 200);
  const suppliedEstimate = meta.estimate === undefined ? false : flag(meta.estimate, 'source.estimate');
  if (mode === 'manual' && batchId) invalid('source.batch_id', 'is assigned by the import workflow');
  if (mode !== 'vendor' && (suppliedEstimate || estimatedMetrics)) invalid('metrics', 'requires an approved vendor for estimates');
  const source = {
    method: mode === 'official_api' ? 'platform_api' : mode, provider: record?.provider ?? null,
    data_source_id: record?.id ?? null, connection_id: record?.connection_id ?? null, external_id: externalId,
    batch_id: batchId, observed_at: observedAt,
    estimate: suppliedEstimate || estimatedMetrics || vendorEstimates,
    confidence: meta.confidence == null ? null : number(meta.confidence, 'source.confidence', 0, 1),
    evidence_ids: strings(meta.evidence_ids ?? [], 'source.evidence_ids'), visibility,
  };
  const minimal = ['douyin', 'xiaohongshu', 'amazon_sp'].includes(String(record?.provider ?? target.platform));
  const attributes: Data = {};
  const raw = body.attributes == null ? {} : object(body.attributes, 'attributes');
  for (const key of minimal ? ['format', 'language'] : ['format', 'language', 'title', 'demand_signal']) {
    if (raw[key] != null) attributes[key] = text(raw[key], `attributes.${key}`, 300);
  }
  if (raw.duration_s != null) attributes.duration_s = integer(raw.duration_s, 'attributes.duration_s');
  if (!minimal && raw.keywords != null) attributes.keywords = strings(raw.keywords, 'attributes.keywords');
  const days = record ? integer((record.allowed_uses as Data | undefined)?.cache_days ?? 90, 'allowed_uses.cache_days', 0, 90) : undefined;
  if (days === 0) throw new Problem(403, 'EGRESS_BLOCKED', 'Data source does not allow caching observations');
  const values: Data = {
    watch_target_id: target.id, subject_type: subject,
    external_id: externalId, url: url(body.url), published_at: publishedAt, observed_at: observedAt,
    age_at_observation: publishedAt ? (Date.parse(observedAt) - Date.parse(publishedAt)) / 1000 : null,
    metrics: observedMetrics, attributes, note: minimal ? null : optionalText(body.note, 'note'), source,
    retention_until: days === undefined ? null : new Date(Date.parse(ctx.now) + Math.min(90, days) * day).toISOString(),
    created_by_type: fromAgent(ctx) ? 'agent' : 'user', created_by_id: ctx.actorId,
  };
  const duplicate = () => ctx.list('observation').find(row => subjectKey(row) === subjectKey(values) && row.observed_at === observedAt && (row.source as Data)?.data_source_id === source.data_source_id);
  return Object.assign(() => {
    const existing = duplicate();
    if (existing) return existing;
    const row = ctx.create('observation', values);
    ctx.emit('intel.observation.recorded', { watch_target_id: target.id, observation_ids: [row.id], batch_id: source.batch_id ?? row.id });
    return row;
  }, { status: duplicate() ? 'skip' as const : 'create' as const });
}

export function recordObservations(ctx: Context, rows: Data[], mode: Exclude<Mode, 'manual'>): Row[] {
  if (!Array.isArray(rows) || rows.length > 1000) invalid('rows', 'must contain at most 1000 observations');
  return rows.map(row => prepareObservation(ctx, object(row, 'observation'), mode)());
}

export function timeline(ctx: Context, watchTargetId: string, query: Record<string, string>): Row[] {
  ctx.get('watch_target', watchTargetId);
  const bounds = period(query);
  const metric = query.metric === undefined ? null : choice(query.metric, metricNames, 'metric');
  const requested = query.availability === undefined ? null : choice(query.availability, availability, 'availability');
  if (requested && !metric) invalid('metric', 'is required when filtering availability');
  const bucket = query.age_bucket === undefined ? null : observationAgeBounds(choice(query.age_bucket, ageBuckets, 'age_bucket'));
  const subject = query.subject_type === undefined ? null : choice(query.subject_type, subjects, 'subject_type');
  const externalId = optionalText(query.external_id, 'external_id', 200);
  return ctx.list('observation')
    .filter(row => row.watch_target_id === watchTargetId && inPeriod(row.observed_at, bounds) && canDisplay(ctx, row))
    .filter(row => (!query.subject || [row.subject_type, row.external_id, row.url].includes(query.subject)) &&
      (!subject || row.subject_type === subject) && (!externalId || row.external_id === externalId) &&
      (!bucket || inAgeBucket(row.age_at_observation, bucket)))
    .map((row): Row & { metrics: Data } => {
      const values = { ...(row.metrics as Data | undefined) };
      for (const name of privateMetrics) values[name] ??= { availability: 'source_not_provided' };
      return { ...row, metrics: values };
    })
    .filter(row => {
      if (!metric) return true;
      const status = ((row.metrics as Data)[metric] as Data | undefined)?.availability ?? 'source_not_provided';
      return requested ? status === requested : valueAvailable.includes(String(status));
    })
    .sort((a, b) => String(b.observed_at).localeCompare(String(a.observed_at)) || a.id.localeCompare(b.id));
}
