import { readers, text, writers, type Commands, type Context, type Entity, type Fields } from '../types.js';
import { at, availabilities, checkUse, choice, cumulativeKeys, emit, get, hash, identifier, insert, integer, iso, list, nativeDay, requireThat, roleAllowed, shape, update } from './model.js';
import { assertCollectable, authorization, supportedMetric } from './sources.js';
import { bounds, forResource } from './coverage.js';
import { workingRun } from './runs.js';

const currencyCodes = new Set(Intl.supportedValuesOf('currency'));
const trafficSources = ['organic', 'paid', 'unknown'] as const;
const surfaces = ['feed', 'reel', 'story', 'short', 'video', 'profile', 'search', 'unknown'] as const;
const regions = new Set(('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' '));

function dimensions(value: unknown) {
  if (value === undefined) return {};
  const input = shape(value, ['country', 'traffic_source', 'surface'], 'dimensions');
  const dims: Record<string, string> = {};
  if (input.country !== undefined) {
    requireThat(typeof input.country === 'string' && regions.has(input.country), 'invalid_input', 'Invalid country');
    dims.country = input.country;
  }
  if (input.traffic_source !== undefined) dims.traffic_source = choice(input.traffic_source, trafficSources, 'traffic_source');
  if (input.surface !== undefined) dims.surface = choice(input.surface, surfaces, 'surface');
  return dims;
}

async function normalize(ctx: Context, raw: unknown, run: Entity, source: Entity) {
  const input = shape(raw, ['subject_id', 'metric_key', 'date', 'value', 'availability', 'currency', 'dimensions'], 'metric record');
  const metric_key = supportedMetric(input.metric_key);
  const resource = run.data.resource;
  const coverage = source.data.field_coverage[resource];
  const mapped = coverage.fields.includes(metric_key) || coverage.missing.some((entry: Fields) => entry.field === metric_key);
  requireThat(mapped, 'capability_unavailable', 'Metric is outside this resource mapping', 409);
  const availability = choice(input.availability ?? (input.value === undefined || input.value === null ? 'source_not_provided' : 'observed'), availabilities, 'availability');
  requireThat(coverage.fields.includes(metric_key) || availability === 'no_permission', 'no_permission', 'Metric is outside the authorized fields', 403);
  const value = input.value ?? null;
  if (availability === 'observed') requireThat(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'invalid_input', 'Observed value must be a nonnegative integer');
  else requireThat(value === null, 'invalid_input', 'Unavailable metrics must have a null value');
  const currency = input.currency ?? null;
  requireThat(metric_key === 'spend' ? currency === null ? value === null : typeof currency === 'string' && currencyCodes.has(currency) : currency === null,
    'invalid_input', 'Spend uses currency in ISO 4217 and integer minor units');
  const subject_id = identifier(input, 'subject_id');
  const subject_type = resource === 'account_metrics' ? 'social_account' : resource === 'ad_metrics' ? 'ad' : 'platform_post';
  if (source.data.kind === 'platform_account') {
    if (subject_type === 'social_account') requireThat(subject_id === source.data.social_account_id, 'subject_out_of_scope', 'Subject account does not match the source', 403);
    else {
      const post = await ctx.get('execution', 'platform_post', subject_id);
      requireThat(post?.data.account_id === source.data.social_account_id && post?.data.platform === source.data.provider,
        'subject_out_of_scope', 'Subject post does not belong to the authorized account', 403);
    }
  }
  const date = text(input, 'date', 10);
  const timezone = source.data.timezone;
  const [start, end] = nativeDay(date, timezone);
  const [from, to] = bounds(run);
  requireThat(start >= from && start < to && end <= at(ctx.now), 'invalid_window', 'Metric date must begin in the run window and have finished');
  const dims = dimensions(input.dimensions);
  const dims_hash = hash(dims);
  const observed_at = run.data.started_at;
  const id = hash('observation', source.id, subject_type, subject_id, metric_key, start, dims_hash, observed_at);
  const record = { provider: source.data.provider, platform: source.data.provider, data_source_id: source.id, source_id: source.id,
    resource, subject_id, subject_type, metric_key, date, timezone, period_kind: 'day', period_start: iso(start), period_end: iso(end), observed_at,
    availability, value, currency, dims, dimensions: dims, dims_hash, definition_revision: 1,
    source: { data_source_id: source.id, sync_run_id: run.id, batch_id: run.id, method: source.data.method, mapping_revision: 1 } };
  return { id, record };
}

async function issue(ctx: Context, source: string, resource: string, rule: string, discriminator: string, observed: Fields, subject?: string) {
  const fingerprint = hash(rule, source, resource, discriminator);
  const previous = (await forResource(ctx, 'quality_issue', source, resource)).find(row => row.data.fingerprint === fingerprint && ['open', 'acknowledged', 'investigating'].includes(row.data.status));
  if (previous) return update(ctx, previous, { last_seen_at: ctx.now, observed, occurrences: previous.data.occurrences + 1 });
  const row = await insert(ctx, 'quality_issue', { rule_key: rule, data_source_id: source, resource, fingerprint, subject_ref: subject ? { resource_id: subject } : null,
    observed, status: 'open', severity: 'warning', occurrences: 1, first_seen_at: ctx.now, last_seen_at: ctx.now });
  await emit(ctx, 'quality_issue.opened', { quality_issue_id: row.id, data_source_id: source, resource, rule_key: rule });
  return row;
}

async function inspectChange(ctx: Context, data: Fields, observations: Entity[]) {
  if (data.availability !== 'observed' || !cumulativeKeys.has(data.metric_key)) return;
  const previous = observations.filter(row => {
    const fact = row.data;
    return fact.data_source_id === data.data_source_id && fact.metric_key === data.metric_key && fact.subject_type === data.subject_type &&
      fact.subject_id === data.subject_id && fact.dims_hash === data.dims_hash && fact.period_start === data.period_start &&
      fact.availability === 'observed' && fact.observed_at < data.observed_at;
  }).sort((a, b) => at(b.data.observed_at) - at(a.data.observed_at))[0];
  if (previous && data.value < previous.data.value) await issue(ctx, data.data_source_id, data.resource, 'negative_cumulative_delta',
    `${data.subject_id}:${data.metric_key}:${data.dims_hash}`, { metric_key: data.metric_key, value: data.value, previous: previous.data.value }, data.subject_id);
}

async function health(ctx: Context, source: Entity, resource: string) {
  const [runs, schedules, cursors, gaps, issues] = await Promise.all(['sync_run', 'sync_schedule', 'sync_cursor', 'data_gap', 'quality_issue']
    .map(kind => forResource(ctx, kind, source.id, resource)));
  const schedule = schedules[0];
  const latest = cursors[0];
  const last = latest?.data.last_success_at ?? null;
  const age = last ? Math.max(0, Math.floor((at(ctx.now) - at(last)) / 1_000)) : null;
  const finished = runs.filter(run => ['succeeded', 'partially_succeeded', 'failed'].includes(run.data.status));
  const expected = schedule?.data.interval_seconds ?? 14_400;
  const reason = await authorization(ctx, source.data);
  const freshness = reason || source.data.status !== 'active' ? 'unavailable' : age === null ? 'not_collected' : age > 2 * expected ? 'stale' : 'fresh';
  const threshold_seconds = expected * 2;
  return { data_source_id: source.id, resource, source_status: reason && source.data.status === 'active' ? 'needs_authorization' : source.data.status,
    freshness, last_success_at: last, high_watermark: latest?.data.high_watermark ?? null,
    next_due_at: schedule?.data.next_due_at ?? null, delay_seconds: age, threshold_seconds,
    success_rate: finished.length ? finished.filter(row => row.data.status === 'succeeded').length / finished.length : null,
    open_gaps: gaps.filter(row => ['open', 'backfill_scheduled'].includes(row.data.status)).length,
    open_issues: issues.filter(row => ['open', 'acknowledged', 'investigating'].includes(row.data.status)).length,
    field_coverage: source.data.field_coverage[resource], upstream_freshness_confirmed: false };
}

export const metricCommands: Commands = {
  record_metric_page: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['sync_run_id', 'fencing_token', 'page_index', 'records', 'last_page', 'request_count']);
    const { run, source } = await workingRun(ctx, input);
    await assertCollectable(ctx, source);
    requireThat(!run.data.pages_complete, 'invalid_transition', 'Final page already received', 409);
    const page = integer(input.page_index ?? run.data.page_index + 1, 1, 100_000, 'page_index');
    requireThat(page === run.data.page_index + 1, 'invalid_page', 'Continue with the next page index', 409);
    requireThat(typeof input.last_page === 'boolean', 'invalid_input', 'last_page must be boolean');
    requireThat(Array.isArray(input.records) && input.records.length <= 500 && (input.records.length > 0 || input.last_page), 'invalid_input', 'Provide up to 500 metric records');
    requireThat(source.data.method === 'official_api' || input.request_count === undefined, 'invalid_input', 'Only API collection records provider requests');
    const requests = integer(input.request_count ?? 0, 0, 10_000, 'request_count');
    const normalized = await Promise.all(input.records.map((raw: unknown) => normalize(ctx, raw, run, source)));
    const observations = await ctx.list('analytics', 'metric_observation');
    const seen = new Map(observations.map(row => [row.id, row]));
    let created = 0, unchanged = 0;
    for (const { id, record } of normalized) {
      const previous = seen.get(id);
      if (previous) {
        requireThat(previous.data.value === record.value && previous.data.availability === record.availability && previous.data.currency === record.currency,
          'observation_conflict', 'One observation cannot contain different values', 409);
        unchanged++;
        continue;
      }
      const row = await ctx.insert('analytics', 'metric_observation', record, id);
      seen.set(id, row);
      created++;
      await inspectChange(ctx, record, observations);
    }
    if (unchanged) await issue(ctx, source.id, run.data.resource, 'duplicate', 'page', { rows: unchanged });
    const counts = run.data.counts;
    const row = await update(ctx, run, { page_index: page, cursor_out: { next_page: input.last_page ? null : page + 1 },
      pages_complete: input.last_page, request_count: run.data.request_count + requests,
      counts: { pages: counts.pages + 1, seen: counts.seen + normalized.length, new: counts.new + created, unchanged: counts.unchanged + unchanged } });
    await emit(ctx, 'sync_run.page_recorded', { sync_run_id: run.id, page_index: page, created, unchanged });
    return row;
  } },
  data_health: { roles: readers, async run(ctx, input) {
    roleAllowed(ctx, readers);
    shape(input, ['data_source_id', 'resource']);
    requireThat(input.data_source_id !== undefined || input.resource === undefined, 'invalid_input', 'Select a source before filtering resources');
    const sources = input.data_source_id === undefined ? await list(ctx, 'data_source') : [await get(ctx, 'data_source', identifier(input, 'data_source_id'))];
    if (input.resource !== undefined) requireThat(sources[0]?.data.resources.includes(input.resource), 'capability_unavailable', 'Resource is not enabled for this source', 409);
    return { items: await Promise.all(sources.flatMap(source => (source.data.resources as string[]).filter(key => input.resource === undefined || key === input.resource).map(key => health(ctx, source, key)))) };
  } },
  run_quality_checks: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['data_source_id', 'resource']);
    const source = await get(ctx, 'data_source', identifier(input, 'data_source_id'));
    const resource = text(input, 'resource', 40);
    requireThat(source.data.resources.includes(resource), 'capability_unavailable', 'Resource is not enabled for this source', 409);
    const snapshot = await health(ctx, source, resource);
    const issues = [];
    if (snapshot.freshness === 'stale') issues.push(await issue(ctx, source.id, resource, 'freshness', resource, { delay_seconds: snapshot.delay_seconds, threshold_seconds: snapshot.threshold_seconds }));
    if (snapshot.field_coverage.missing.length) issues.push(await issue(ctx, source.id, resource, 'completeness', resource,
      { missing_fields: snapshot.field_coverage.missing.map((entry: Fields) => entry.field) }));
    return { snapshot, issues };
  } },
  resolve_quality_issue: { roles: writers, async run(ctx, input) {
    roleAllowed(ctx, writers);
    shape(input, ['quality_issue_id', 'status', 'reason']);
    const issue = await get(ctx, 'quality_issue', identifier(input, 'quality_issue_id'));
    const status = choice(input.status, ['acknowledged', 'investigating', 'resolved', 'false_positive'] as const, 'status');
    const transitions: Record<string, readonly string[]> = { open: ['acknowledged', 'investigating', 'resolved', 'false_positive'],
      acknowledged: ['investigating', 'resolved', 'false_positive'], investigating: ['resolved', 'false_positive'] };
    requireThat(transitions[issue.data.status]?.includes(status), 'invalid_transition', 'Invalid quality issue transition', 409);
    const terminal = status === 'resolved' || status === 'false_positive';
    const resolution = terminal ? { resolution_note: text(input, 'reason', 400), resolved_at: ctx.now, resolved_by: ctx.actorId } : {};
    const row = await update(ctx, issue, { ...resolution, status });
    await emit(ctx, terminal ? 'quality_issue.resolved' : 'quality_issue.status_changed', { quality_issue_id: row.id, status });
    return row;
  } },
  get_provenance: { roles: readers, async run(ctx, input) {
    roleAllowed(ctx, readers);
    shape(input, ['observation_id']);
    const observation = await ctx.get('analytics', 'metric_observation', identifier(input, 'observation_id'));
    requireThat(observation?.data.source?.sync_run_id, 'not_found', 'Ingestion observation provenance not found', 404);
    const source = await get(ctx, 'data_source', observation.data.data_source_id);
    await checkUse(ctx, [source.id], 'display');
    const run = await get(ctx, 'sync_run', observation.data.source.sync_run_id);
    return { observation_id: observation.id, data_source_id: source.id, source_name: source.data.name, sync_run_id: run.id, provider: source.data.provider,
      method: source.data.method, native_timezone: observation.data.timezone, mapping_revision: observation.data.source.mapping_revision,
      observed_at: observation.data.observed_at, run_status: run.data.status, raw_record_status: 'not_retained' };
  } },
};
