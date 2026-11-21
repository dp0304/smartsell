import { admins, DomainError, readers, required, text, writers } from '../types.ts';
import type { Context, Entity, Fields } from '../types.ts';
import { checkUse } from '../ingest/model.ts';
import { authorization } from '../ingest/sources.ts';
import {
  active, blocked, boolean, choice, command, conflict, create, fail, get, language, list,
  money, number, object, optional, selected, strings, timestamp, update, url,
} from './validation.ts';

const modes = ['manual', 'import', 'vendor', 'official_api'] as const;
const types = ['competitor_account', 'keyword', 'hashtag', 'category', 'product_url', 'store', 'creator_account'] as const;
const subjects = ['post', 'account', 'product', 'video', 'live'] as const;
const statuses = ['active', 'paused', 'archived'] as const;
const targetFields = ['brand_id', 'target_type', 'platform', 'name', 'query', 'data_mode', 'data_source_id', 'market_ids', 'refresh_frequency', 'owner_user_id', 'tags', 'coverage_note'];

function query(value: unknown): Fields {
  const input = object(value, ['handle', 'url', 'keywords', 'exclude', 'language'], 'query');
  return {
    ...selected(input, ['handle']),
    ...(input.url !== undefined ? { url: url(input) } : {}),
    ...(input.keywords !== undefined ? { keywords: strings(input, 'keywords') } : {}),
    ...(input.exclude !== undefined ? { exclude: strings(input, 'exclude') } : {}),
    ...(input.language !== undefined ? { language: language(input) } : {}),
  };
}
function targetPatch(input: Fields): Fields {
  return {
    ...selected(input, ['brand_id', 'platform', 'name', 'owner_user_id', 'coverage_note']),
    ...(Object.hasOwn(input, 'data_source_id') ? { data_source_id: input.data_source_id === null ? null : text(input, 'data_source_id') } : {}),
    ...(input.target_type !== undefined ? { target_type: choice(input, 'target_type', types) } : {}),
    ...(input.data_mode !== undefined ? { data_mode: choice(input, 'data_mode', modes) } : {}),
    ...(input.query !== undefined ? { query: query(input.query) } : {}),
    ...(input.market_ids !== undefined ? { market_ids: strings(input, 'market_ids') } : {}),
    ...(input.tags !== undefined ? { tags: strings(input, 'tags') } : {}),
    ...(input.refresh_frequency !== undefined ? { refresh_frequency: choice(input, 'refresh_frequency', ['manual', 'daily', 'weekly']) } : {}),
  };
}
async function sourceFor(ctx: Context, target: Fields): Promise<Entity | undefined> {
  const mode = target.data_mode;
  if (!target.data_source_id) {
    if (mode === 'official_api' || mode === 'vendor') blocked('An authorized ingest source is required');
    return;
  }
  const source = await required(ctx, 'ingest', 'data_source', target.data_source_id);
  const { data } = source;
  if (data.status !== 'active') blocked('Ingest source must be active');
  if (!((mode === 'vendor' && data.kind === 'vendor' && data.contract_ref) ||
        (mode === 'official_api' && data.method === 'official_api' && data.kind !== 'vendor' && data.connection_id) ||
        (mode === 'import' && data.method === 'report_import' && data.kind !== 'vendor'))) {
    blocked('Data source does not authorize this acquisition mode');
  }
  if (data.brand_id && data.brand_id !== target.brand_id) blocked('Data source is scoped to another brand');
  if (mode !== 'vendor' && await authorization(ctx, data)) blocked('Data source lacks current authorization');
  await authorizeUses(ctx, [source.id], 'display', 'team_share');
  return source;
}
async function validateTarget(ctx: Context, target: Fields) {
  const { target_type: type, query: filters } = target;
  if ((type === 'product_url' && !filters.url) ||
      (['competitor_account', 'creator_account', 'store'].includes(type) && !(filters.handle || filters.url)) ||
      (['keyword', 'hashtag', 'category'].includes(type) && !filters.keywords?.length)) {
    fail('Query does not define the selected watch target');
  }
  await sourceFor(ctx, target);
}
export async function authorizeUses(ctx: Context, sourceIds: string[], ...uses: Parameters<typeof checkUse>[2][]) {
  const unique = [...new Set(sourceIds)];
  if (unique.length) for (const use of uses) await checkUse(ctx, unique, use);
}
export function sourceIds(rows: Entity[]): string[] {
  return rows.map(row => row.data.source?.data_source_id).filter(Boolean);
}

export const countMetrics = ['likes', 'comments', 'shares', 'views', 'followers', 'impressions', 'reach', 'sales', 'units_sold'] as const;
const moneyMetrics = ['price', 'gmv'] as const;
const metricNames = [...countMetrics, ...moneyMetrics, 'commission_rate'] as const;
const publicMetrics = new Set(['likes', 'comments', 'shares', 'views', 'followers', 'price']);
const availability = ['observed', 'estimated', 'source_not_provided', 'not_collected', 'no_permission', 'not_applicable', 'sync_failed'] as const;
const resources: Record<string, string[]> = {
  post: ['posts', 'post_metrics', 'note_metrics'], account: ['account_profile', 'account_metrics'], product: ['products', 'product_metrics'],
  video: ['videos', 'video_metrics', 'posts', 'post_metrics'], live: ['live', 'live_metrics'], mention: ['mentions', 'comments', 'posts'],
};
function supports(source: Entity, subject: string, field?: string) {
  const data = source.data;
  return resources[subject].some(resource => {
    if (!Array.isArray(data.resources) || !data.resources.includes(resource)) return false;
    const coverage = data.field_coverage?.[resource];
    return coverage && Array.isArray(coverage.fields) && !['no_permission', 'unavailable', 'unsupported'].includes(coverage.status) &&
      (field === undefined || coverage.fields.includes(field));
  });
}
function validateScope(source: Entity | undefined, subject: string, access: string) {
  if (source && !supports(source, subject)) blocked('Ingest source does not cover the selected subject');
  if (access === 'authorized' && !source) blocked('Non-public observations require an authorized ingest source');
}
export function metricValues(value: unknown, subject: string, source?: Entity, access = 'public'): Fields {
  const input = object(value, metricNames, 'metrics');
  const metrics: Fields = {};
  for (const metric of metricNames) {
    const isMoney = moneyMetrics.some(name => name === metric);
    const inputMetric = input[metric];
    if (inputMetric === undefined) {
      if (!publicMetrics.has(metric)) metrics[metric] = { availability: 'source_not_provided' };
      continue;
    }
    const item = object(inputMetric, isMoney ? ['availability', 'amount_minor', 'currency'] : ['availability', 'value'], metric);
    const status = choice(item, 'availability', availability);
    if (status !== 'observed' && status !== 'estimated') {
      if (Object.keys(item).length !== 1) fail(`Unavailable ${metric} cannot have a value`);
      metrics[metric] = { availability: status };
      continue;
    }
    if (!publicMetrics.has(metric) && (access !== 'authorized' || !source)) blocked(`${metric} is not available to this public observation`);
    if (source && !supports(source, subject, metric)) blocked(`Data source does not provide ${metric}`);
    if (status === 'estimated' && source?.data.kind !== 'vendor') blocked('Only a contracted vendor may provide estimates');
    if (source?.data.kind === 'vendor' && ['sales', 'units_sold', 'gmv', 'commission_rate'].includes(metric) && status !== 'estimated') {
      fail(`Vendor ${metric} must be marked estimated`);
    }
    metrics[metric] = isMoney
      ? { availability: status, ...money({ amount_minor: item.amount_minor, currency: item.currency }) }
      : { availability: status, value: number(item, 'value', 0, metric === 'commission_rate' ? 1 : Number.MAX_SAFE_INTEGER, metric !== 'commission_rate') };
  }
  return metrics;
}
function attributes(value: unknown, subject: string, source: Entity | undefined): Fields {
  const input = object(value, ['title', 'format', 'duration_s', 'description', 'language'], 'attributes');
  if (source) for (const field of Object.keys(input)) if (!supports(source, subject, field)) blocked(`Data source does not provide ${field}`);
  return {
    ...selected(input, ['title', 'format', 'description']),
    ...(input.duration_s !== undefined ? { duration_s: number(input, 'duration_s', 0, 604800, true) } : {}),
    ...(input.language !== undefined ? { language: language(input) } : {}),
  };
}
const provenanceKeys = ['observed_at', 'published_at', 'url', 'external_id', 'access', 'collection_authorized'];
export async function provenance(ctx: Context, input: Fields, target: Entity, subject: string) {
  active(target);
  if (!boolean(input, 'collection_authorized')) blocked('Collection requires permission from the source');
  const access = choice(input, 'access', ['public', 'authorized']);
  const ingest = await sourceFor(ctx, target.data);
  validateScope(ingest, subject, access);
  const observed_at = timestamp(input, 'observed_at');
  if (Date.parse(observed_at) > Date.parse(ctx.now)) fail('observed_at is in the future');
  const published_at = optional(input, 'published_at', timestamp);
  if (published_at && published_at > observed_at) fail('published_at is later than observed_at');
  const external_id = optional(input, 'external_id', text);
  const minutesPerDay = 1440;
  const cacheDays = ingest?.data.allowed_uses?.cache_days;
  if (ingest && (!Number.isFinite(cacheDays) || cacheDays <= 0)) blocked('Source does not permit retaining research records');
  const expires_at = ingest ? new Date(Math.min(Date.parse(observed_at) + cacheDays * minutesPerDay * 60_000, 8.64e15)).toISOString() : null;
  if (expires_at && Date.parse(expires_at) <= Date.parse(ctx.now)) blocked('Source retention window has expired');
  const method = target.data.data_mode === 'official_api' ? 'platform_api' : target.data.data_mode;
  return {
    ingest, access, url: url(input), published_at: published_at ?? null, observed_at, external_id: external_id ?? null,
    source: { method, data_source_id: ingest?.id ?? null, provider: ingest?.data.provider ?? target.data.platform ?? null,
      connection_id: ingest?.data.connection_id ?? null, external_id: external_id ?? null, batch_id: null,
      observed_at, access, expires_at, estimate: false, confidence: null, evidence_ids: [] as string[] },
  };
}
export function enforceRecorder(ctx: Context, target: Fields) {
  if ((target.data_source_id || ['official_api', 'vendor'].includes(target.data_mode)) && !admins.includes(ctx.role)) {
    throw new DomainError('forbidden', 'Only an administrator can attest to source-backed records', 403);
  }
}
const observationFields = ['watch_target_id', 'subject_type', ...provenanceKeys, 'metrics', 'attributes', 'note'];
async function prepareObservation(ctx: Context, value: unknown, allowed?: { sourceId: string; batchId: string; resource: string }) {
  const input = object(value, observationFields);
  const watch_target_id = text(input, 'watch_target_id');
  const target = await get(ctx, 'watch_target', watch_target_id);
  if (allowed) {
    if (target.data.data_source_id !== allowed.sourceId) blocked('Batch source does not match the watch target');
  } else {
    enforceRecorder(ctx, target.data);
    if (['official_api', 'vendor'].includes(target.data.data_mode)) blocked('Connector observations require the internal ingest sink');
  }
  const subject_type = choice(input, 'subject_type', subjects);
  if (allowed && !resources[subject_type].includes(allowed.resource)) blocked('Ingest batch does not cover this subject');
  const { ingest, access, source, ...snapshot } = await provenance(ctx, input, target, subject_type);
  const metrics = metricValues(input.metrics, subject_type, ingest, access);
  source.estimate = Object.values(metrics).some(metric => metric.availability === 'estimated');
  const age_at_observation = snapshot.published_at ? (Date.parse(snapshot.observed_at) - Date.parse(snapshot.published_at)) / 1000 : null;
  return { ...snapshot, watch_target_id, subject_type, age_at_observation, metrics, source: { ...source, batch_id: allowed?.batchId ?? null },
    attributes: optional(input, 'attributes', (_fields, key) => attributes(input[key], subject_type, ingest)) ?? {},
    ...selected(input, ['note']), created_by_type: allowed ? 'service_account' : 'user', created_by_id: ctx.actorId };
}
export function subjectKey(row: Entity): string {
  return JSON.stringify([row.data.watch_target_id, row.data.subject_type, row.data.source?.provider,
    row.data.source?.connection_id, row.data.external_id ?? row.data.url]);
}
export function readable(ctx: Context, row: Entity): boolean {
  return !row.data.source?.expires_at || Date.parse(row.data.source.expires_at) > Date.parse(ctx.now);
}
export async function requireReadable(ctx: Context, rows: Entity[], use?: 'team_share' | 'export') {
  if (rows.some(row => !readable(ctx, row))) blocked('Research evidence has expired');
  const ids = sourceIds(rows);
  await authorizeUses(ctx, ids, 'display', 'team_share', ...(use === 'export' ? ['export'] as const : []));
  for (const id of new Set(ids)) {
    const source = await required(ctx, 'ingest', 'data_source', id);
    const cacheDays = source.data.allowed_uses?.cache_days;
    if (!Number.isSafeInteger(cacheDays) || cacheDays <= 0 || rows.some(row => row.data.source?.data_source_id === id &&
      Date.parse(ctx.now) - Date.parse(row.data.source.observed_at) >= cacheDays * 86400000)) blocked('Research evidence exceeds current source retention');
  }
}
/** Internal sink. Only trusted connector workers may invoke this with a completed ingest run. */
export async function recordObservations(ctx: Context, sourceId: string, batchId: string, entries: unknown[]) {
  const batch = await required(ctx, 'ingest', 'sync_run', batchId);
  if (batch.data.data_source_id !== sourceId || batch.data.status !== 'succeeded' || typeof batch.data.resource !== 'string') {
    blocked('A successful ingest batch is required');
  }
  if (!Array.isArray(entries) || !entries.length || entries.length > 200) fail('Invalid observation batch');
  const existing = (await list(ctx, 'observation')).filter(row => row.data.source?.batch_id === batchId);
  if (existing.length) {
    await requireReadable(ctx, existing);
    return existing;
  }
  const validated = await Promise.all(entries.map(entry => prepareObservation(ctx, entry, { sourceId, batchId, resource: batch.data.resource })));
  const rows = [];
  for (const snapshot of validated) rows.push(await ctx.insert('intel', 'observation', snapshot));
  await ctx.emit('intel.observation.recorded', { batch_id: batchId, data_source_id: sourceId, observation_ids: rows.map(row => row.id), count: rows.length });
  return rows;
}

export const observationCommands = {
  watch_target_detail: command(readers, async (ctx, input) => {
    object(input, ['id']);
    return get(ctx, 'watch_target', text(input, 'id'));
  }),
  create_watch_target: command(writers, async (ctx, input) => {
    object(input, targetFields);
    const data = {
      market_ids: [], tags: [], refresh_frequency: 'manual', owner_user_id: ctx.actorId,
      coverage_note: 'Public values manually supplied or imported unless a source explicitly grants access.',
      ...targetPatch(input), name: text(input, 'name', 160), target_type: choice(input, 'target_type', types),
      data_mode: choice(input, 'data_mode', modes), query: query(input.query), status: 'active',
    };
    enforceRecorder(ctx, data);
    await validateTarget(ctx, data);
    return create(ctx, 'watch_target', data);
  }),
  update_watch_target: command(writers, async (ctx, input) => {
    object(input, ['id', 'expected_version', 'status', ...targetFields]);
    const row = await get(ctx, 'watch_target', text(input, 'id'));
    if (row.data.status === 'archived') conflict('Archived watch targets are read-only');
    const patch = targetPatch(input);
    if (input.status !== undefined) patch.status = choice(input, 'status', statuses);
    if (!Object.keys(patch).length) fail('No watch target changes supplied');
    const next = { ...row.data, ...patch };
    enforceRecorder(ctx, row.data);
    enforceRecorder(ctx, next);
    if (next.status === 'active') await validateTarget(ctx, next);
    else if (Object.keys(patch).some(key => key !== 'status')) fail('Change a watch target scope while it is active');
    return update(ctx, 'watch_target', row, patch, input);
  }),
  record_observation: command(writers, async (ctx, input) => {
    const snapshot = await prepareObservation(ctx, input);
    return create(ctx, 'observation', snapshot, 'observation.recorded');
  }),
  observation_timeline: command(readers, async (ctx, input) => {
    object(input, ['watch_target_id', 'subject_type', 'from', 'to', 'missing_metric']);
    const target = await get(ctx, 'watch_target', text(input, 'watch_target_id'));
    const subject = optional(input, 'subject_type', (value, key) => choice(value, key, subjects));
    const from = optional(input, 'from', timestamp);
    const to = optional(input, 'to', timestamp);
    if (from && to && from >= to) fail('Invalid time window');
    const missing = optional(input, 'missing_metric', (value, key) => choice(value, key, metricNames));
    const items = (await list(ctx, 'observation')).filter(row => row.data.watch_target_id === target.id && readable(ctx, row) &&
      (!subject || row.data.subject_type === subject) && (!from || row.data.observed_at >= from) && (!to || row.data.observed_at < to) &&
      (!missing || !['observed', 'estimated'].includes(row.data.metrics[missing]?.availability)));
    await requireReadable(ctx, items);
    return { items: items.sort((a, b) => b.data.observed_at.localeCompare(a.data.observed_at)) };
  }),
  compare_observations: command(readers, async (ctx, input) => {
    object(input, ['watch_target_ids', 'metric', 'age_bucket', 'from', 'to']);
    const ids = strings(input, 'watch_target_ids', 20);
    if (!ids.length) fail('Select at least one watch target');
    const metric = choice(input, 'metric', countMetrics);
    const age = choice(input, 'age_bucket', ['0-24h', '1-7d', '7-30d']);
    const [min, max] = ({ '0-24h': [0, 86400], '1-7d': [86400, 604800], '7-30d': [604800, 2592000] })[age];
    const from = timestamp(input, 'from');
    const to = timestamp(input, 'to');
    if (from >= to) fail('Invalid time window');
    for (const id of ids) await get(ctx, 'watch_target', id);
    const items = (await list(ctx, 'observation')).filter(row => ids.includes(row.data.watch_target_id) && readable(ctx, row) &&
      ['post', 'video'].includes(row.data.subject_type) && row.data.published_at >= from && row.data.published_at < to);
    await requireReadable(ctx, items);
    return { as_of: ctx.now, metric, age_bucket: age, period: { from, to }, items: ids.map(id => {
      const rows = items.filter(row => row.data.watch_target_id === id);
      const bucket = new Map<string, Entity>();
      for (const row of rows) {
        const rowAge = row.data.age_at_observation;
        if (rowAge === null || rowAge < min || rowAge >= max || !['observed', 'estimated'].includes(row.data.metrics[metric]?.availability)) continue;
        const previous = bucket.get(subjectKey(row));
        if (!previous || previous.data.age_at_observation < rowAge) bucket.set(subjectKey(row), row);
      }
      const samples = [...bucket.values()];
      return { watch_target_id: id, post_count: new Set(rows.map(subjectKey)).size, sample_size: samples.length,
        average: samples.length ? samples.reduce((sum, row) => sum + row.data.metrics[metric].value / samples.length, 0) : null,
        estimate: samples.some(row => row.data.metrics[metric].availability === 'estimated'), evidence_observation_ids: samples.map(row => row.id) };
    }) };
  }),
};

export { provenanceKeys };
