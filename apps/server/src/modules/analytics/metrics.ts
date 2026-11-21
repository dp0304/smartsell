import { Problem, type Context as FlatContext, type Data, type Row } from '@smartsell/contracts';
import { date as isoDate, dto, object as plainObject, optionalString } from './validation.ts';
import { DomainError, readers, text, type Commands, type Context, type Entity, type Fields } from '../types.js';
import { buildRegistry, prepareObservations, prepareRevision, availabilityTypes, definitionFor, definitionsAt, subjectTypes, type Definition } from './registry.js';
import { addDays, choice, convertMinor, currency, cutoff, dayStart, inPeriod, instant, invalid, localDay, moduleKey, object, period, ratesAt, ref, revenueRoles, safeNumber, strings, visibleAt, type Period } from './shared.js';

const buckets = { '1h': 3600, '6h': 21600, '24h': 86400, '72h': 259200, '7d': 604800, '28d': 2419200, '90d': 7776000 };
const dimensions = ['platform', 'subject_id', 'social_account', 'campaign', 'content_type', 'market'] as const;
const platformName = (value: string) => value === 'meta_instagram' ? 'instagram' : value === 'meta_facebook' ? 'facebook' : value;
const filterDimensions = { brand_ids: 'brand_id', social_account_ids: 'social_account', platforms: 'platform', campaign_ids: 'campaign', content_types: 'content_type', market_ids: 'market', subject_ids: 'subject_id' } as const;
const known = (availability: string) => availability === 'observed' || availability === 'estimated';
type Evidence = ReturnType<typeof ref>;
type Sample = { id: string; key: string; revision: number; platform: string; subject: string; dims: Fields; signature: string; currency?: string; value: number | null; availability: string; at: string; publication?: string; age?: number; start?: string; end?: string; nativeDay?: string; periodKind: string; source: Fields; evidence: Evidence[] };
type Point = Sample & { day?: string; method?: string; deviation_seconds?: number; coverage?: number };

export function parseMetricQuery(value: unknown) {
  const input = object(value, 'query');
  const metricKeys = strings(input.metrics, 'metrics', 20);
  if (!metricKeys.length) invalid('Provide at least one metric');
  const subject = object(input.subject, 'subject');
  const type = choice(subject.type, subjectTypes, 'subject.type');
  const filter = Object.fromEntries(Object.entries(object(subject.filter ?? {}, 'subject.filter')).map(([key, val]) => {
    if (!Object.hasOwn(filterDimensions, key)) invalid(`Unknown filter ${key}`);
    const values = strings(val, key);
    return [key, key === 'platforms' ? values.map(platformName) : values];
  }));
  const time = object(input.time, 'time');
  const range = period(time);
  const basis = choice(time.basis ?? 'period', ['published_at', 'period'], 'basis');
  const granularity = choice(input.granularity ?? 'none', ['none', 'day', 'week', 'month'], 'granularity');
  const age_bucket = input.age_bucket === undefined ? undefined : choice(input.age_bucket, Object.keys(buckets) as Array<keyof typeof buckets>, 'age_bucket');
  if (age_bucket && granularity !== 'none') invalid('Age buckets require granularity none');
  const group_by = strings(input.group_by ?? [], 'group_by', dimensions.length).map(item => choice(item, dimensions, 'group_by'));
  const traffic_source = choice(input.traffic_source ?? 'all', ['organic', 'paid', 'all'], 'traffic_source');
  const report_currency = input.report_currency === undefined ? undefined : currency(input.report_currency);
  if (input.include_estimates !== undefined && typeof input.include_estimates !== 'boolean') invalid('Invalid include_estimates');
  const include_estimates = input.include_estimates === true;
  let compare: Period | undefined;
  if (input.compare !== undefined) {
    const raw = object(input.compare, 'compare');
    const type = choice(raw.type, ['previous_period', 'same_period_last_year', 'custom'], 'compare.type');
    if (type === 'custom') compare = period({ ...raw, tz: range.tz });
    else if (type === 'previous_period') compare = { ...range, from: new Date(2 * Date.parse(range.from) - Date.parse(range.to)).toISOString(), to: range.from };
    else {
      const previousYear = (when: string) => {
        const date = new Date(when);
        const month = date.getUTCMonth();
        date.setUTCFullYear(date.getUTCFullYear() - 1);
        if (date.getUTCMonth() !== month) date.setUTCDate(0);
        return date.toISOString();
      };
      compare = { ...range, from: previousYear(range.from), to: previousYear(range.to) };
    }
  }
  return { metrics: metricKeys, subject: { type, filter }, time: { ...range, basis }, granularity, group_by, age_bucket, traffic_source, report_currency, include_estimates, compare };
}
export type Query = ReturnType<typeof parseMetricQuery>;
function dimension(sample: Sample, key: string) {
  if (key === 'platform') return sample.platform;
  if (key === 'subject_id') return sample.subject;
  return sample.dims[key] ?? sample.dims[`${key}_id`];
}
function parseSample(row: Entity, asOf: string): Sample | undefined {
  const d = row.data;
  if (d.rolled_back === true || !visibleAt(row, asOf) || !d.observed_at) return;
  const at = instant(d.observed_at, 'observed_at');
  if (at > asOf) return;
  const rawDims = { ...(d.dimensions ?? {}), ...(d.dims ?? {}) };
  const dims = Object.fromEntries(Object.entries(rawDims).sort(([a], [b]) => a.localeCompare(b)));
  for (const key of ['brand_id', 'social_account_id', 'campaign_id', 'market_id', 'content_type', 'traffic_source']) if (d[key] !== undefined) dims[key] ??= d[key];
  const availability = availabilityTypes.includes(d.availability) ? d.availability : 'source_not_provided';
  return { id: row.id, key: d.metric_key, revision: d.definition_revision ?? 1, platform: platformName(d.platform ?? d.provider ?? 'unknown'), subject: d.subject_id, dims,
    signature: JSON.stringify(Object.entries(dims).sort(([a], [b]) => a.localeCompare(b))), currency: d.currency, at, publication: d.published_at,
    age: d.subject_age_seconds, start: d.period_start ? instant(d.period_start, 'period_start') : undefined, end: d.period_end ? instant(d.period_end, 'period_end') : undefined,
    nativeDay: d.date, periodKind: d.period_kind ?? (d.date ? 'day' : d.period_start ? 'range' : 'lifetime'), availability,
    value: known(availability) && Number.isFinite(d.value) ? d.value : null,
    source: { method: optionalString(d.source?.method), batch_id: optionalString(d.source?.batch_id),
      raw_record_id: optionalString(d.source?.raw_record_id), data_source_id: optionalString(d.data_source_id ?? d.source?.data_source_id) }, evidence: [ref(row)] };
}
function seriesKey(p: Sample) { return JSON.stringify([p.subject, p.platform, p.signature, p.currency]); }
function partition<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const group = groups.get(id);
    if (group) group.push(item); else groups.set(id, [item]);
  }
  return groups;
}
const latest = (items: Sample[]) => [...items].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))[0];
function atAge(series: Sample[], target: number, includeEstimates: boolean): Point {
  const withAge = series.map(s => ({ ...s, age: s.age ?? (s.publication ? (Date.parse(s.at) - Date.parse(s.publication)) / 1000 : undefined) })).filter(s => s.age !== undefined);
  const before = withAge.filter(s => s.age! <= target).sort((a, b) => b.age! - a.age! || b.at.localeCompare(a.at))[0];
  const after = withAge.filter(s => s.age! > target).sort((a, b) => a.age! - b.age! || b.at.localeCompare(a.at))[0];
  if (!before) return { ...latest(series)!, value: null, availability: 'not_collected', method: 'none', evidence: [] };
  if (includeEstimates && after && before.age !== target && target - before.age! <= target * 0.1 && after.age! - target <= target * 0.1 && before.value !== null && after.value !== null && before.revision === after.revision) {
    const value = before.value + (after.value - before.value) * ((target - before.age!) / (after.age! - before.age!));
    return { ...before, value, availability: 'estimated', method: 'interpolated', deviation_seconds: 0, evidence: [...before.evidence, ...after.evidence] };
  }
  return { ...before, method: before.age === target ? 'exact' : 'nearest_before', deviation_seconds: target - before.age! };
}
function dailyPoints(series: Sample[], query: Query, definition: Definition): Point[] {
  const { tz } = query.time;
  const out: Point[] = [];
  const native = new Map<string, Sample>();
  const byPeriod = partition(series.filter(p => p.periodKind !== 'lifetime'), p => JSON.stringify([p.periodKind, p.start ?? p.nativeDay, p.end]));
  for (const samples of byPeriod.values()) {
    const p = latest(samples)!;
    const start = p.start ?? (p.nativeDay ? new Date(dayStart(p.nativeDay, tz)).toISOString() : p.at);
    if (!inPeriod(start, query.time) && !(p.nativeDay && inPeriod(new Date(dayStart(p.nativeDay, tz)).toISOString(), query.time))) continue;
    const day = p.nativeDay ?? localDay(start, tz);
    if (p.periodKind === 'day') native.set(day, p);
    const method = ['backfill', 'backfilled'].includes(p.source.method) || p.source.window_kind === 'backfill' ? 'backfilled' : p.periodKind === 'day' ? 'native_daily' : 'native_period';
    out.push({ ...p, day, method, coverage: p.value === null ? 0 : 1 });
  }
  if (definition.value_kind !== 'cumulative') return out;
  const lifetime = [...partition(series.filter(p => p.periodKind === 'lifetime'), p => p.at).values()].map(samples => latest(samples)!).sort((a, b) => a.at.localeCompare(b.at));
  const derived = new Map<string, Point>();
  for (let i = 1; i < lifetime.length; i++) {
    const a = lifetime[i - 1]!, b = lifetime[i]!;
    const start = Date.parse(a.at), end = Date.parse(b.at);
    const overlapStart = Math.max(start, Date.parse(query.time.from));
    const overlapEnd = Math.min(end, Date.parse(query.time.to));
    if (overlapStart >= overlapEnd) continue;
    const failed = a.value !== null && b.value !== null && (b.value < a.value || a.revision !== b.revision);
    const delta = a.value !== null && b.value !== null && !failed ? b.value - a.value : null;
    const split = localDay(start, tz) !== localDay(end - 1, tz);
    for (let day = localDay(overlapStart, tz); day <= localDay(overlapEnd - 1, tz); day = addDays(day, 1)) {
      if (native.has(day)) continue;
      const from = dayStart(day, tz), to = dayStart(addDays(day, 1), tz);
      const duration = Math.min(overlapEnd, to) - Math.max(overlapStart, from);
      const estimate = split || a.availability === 'estimated' || b.availability === 'estimated';
      const value = delta === null ? null : delta * duration / (end - start);
      const previous = derived.get(day);
      const availability = failed ? 'sync_failed' : value === null ? 'not_collected' : estimate ? 'estimated' : 'observed';
      const coverage = (previous?.coverage ?? 0) + (value === null ? 0 : duration / (to - from));
      const result = previous && (value === null || previous.value === null) ? null : value === null ? null : (previous?.value ?? 0) + value;
      derived.set(day, { ...b, day, value: result, availability: previous?.availability === 'sync_failed' || failed ? 'sync_failed' : result === null ? 'not_collected' : estimate || previous?.availability === 'estimated' ? 'estimated' : availability,
        coverage, method: split || previous?.method === 'interpolated' ? 'interpolated' : 'cumulative_diff', evidence: [...(previous?.evidence ?? []), ...a.evidence, ...b.evidence] });
    }
  }
  return [...out, ...derived.values()];
}
function pointsFor(samples: Sample[], query: Query, definition: Definition): Point[] {
  const result: Point[] = [];
  for (const series of partition(samples, seriesKey).values()) {
    if (query.age_bucket) {
      const lifetime = series.filter(p => p.periodKind === 'lifetime');
      if (lifetime.length) result.push(atAge(lifetime, buckets[query.age_bucket], query.include_estimates));
    } else if (query.granularity !== 'none' || query.time.basis === 'period' && definition.value_kind === 'period_sum') {
      result.push(...dailyPoints(series, query, definition));
    } else {
      const lifetime = series.filter(p => p.periodKind === 'lifetime' && (query.time.basis === 'published_at' || p.at < query.time.to));
      if (lifetime.length && definition.value_kind !== 'period_sum') result.push({ ...latest(lifetime)!, method: 'latest' });
      else result.push(...dailyPoints(series, query, definition));
    }
  }
  return result;
}
function timeGroup(day: string, grain: Query['granularity']) {
  if (grain === 'month') return day.slice(0, 7);
  if (grain === 'week') return addDays(day, -((new Date(day).getUTCDay() + 6) % 7));
  return day;
}
function pointDay(point: Point, query: Query) { return point.day ?? localDay(point.start ?? point.at, query.time.tz); }
const isUsable = (p: Point, query: Query) => p.value !== null && (p.availability === 'observed' || p.availability === 'estimated' && query.include_estimates);
const unknown = (availability = 'not_collected') => ({ value: null, availability, estimate: false });
function unknownAvailability(points: Point[]) {
  const first = points[0]?.availability;
  return first && !known(first) && points.every(p => p.availability === first) ? first : 'not_collected';
}
function aggregate(points: Point[], def: Definition, grain: Query['granularity'], query: Query, rates: Entity[], warnings: Set<string>, inputs?: Point[]) {
  if (def.value_kind === 'gauge' && grain !== 'day') points = [...partition(points, seriesKey).values()].map(group => [...group].sort((a, b) => pointDay(b, query).localeCompare(pointDay(a, query)) || b.at.localeCompare(a.at))[0]!);
  const usable = points.filter(p => isUsable(p, query));
  inputs?.push(...(usable.length ? usable : points));
  if (!usable.length) return unknown(unknownAvailability(points));
  if (usable.length < points.length) warnings.add('PARTIAL_COVERAGE');
  if (def.additivity === 'non_additive' && usable.length > 1) {
    warnings.add('NON_ADDITIVE_METRIC');
    return unknown('not_applicable');
  }
  const estimate = usable.some(p => p.availability === 'estimated');
  const common = { availability: estimate ? 'estimated' : 'observed', estimate };
  if (def.unit !== 'currency') {
    const value = usable.reduce((sum, p) => sum + p.value!, 0);
    return Number.isFinite(value) ? { ...common, value } : unknown('sync_failed');
  }
  const byCurrency: Record<string, number> = {};
  const fx_rates: NonNullable<ReturnType<typeof convertMinor>['fx']>[] = [];
  const missing_fx: Array<{ currency: string; date: string }> = [];
  let total = 0n;
  for (const point of usable) {
    const code = point.currency;
    if (!code || !Number.isSafeInteger(point.value)) { warnings.add('INVALID_CURRENCY_VALUE'); return unknown('sync_failed'); }
    byCurrency[code] = safeNumber(BigInt(byCurrency[code] ?? 0) + BigInt(point.value!));
    if (!query.report_currency) continue;
    const day = pointDay(point, query);
    const converted = convertMinor(point.value!, code, query.report_currency, day, rates);
    if (converted.amount_minor === null) missing_fx.push({ currency: code, date: day });
    else total += BigInt(converted.amount_minor);
    if (converted.fx) fx_rates.push(converted.fx);
  }
  if (missing_fx.length) warnings.add('MISSING_FX_RATE');
  const codes = Object.keys(byCurrency);
  if (!query.report_currency && codes.length > 1) warnings.add('MIXED_CURRENCIES');
  const value = query.report_currency ? (missing_fx.length ? null : safeNumber(total)) : codes.length === 1 ? byCurrency[codes[0]!]! : null;
  return { ...(value === null ? unknown('source_not_provided') : { ...common, value }), currency: query.report_currency ?? (codes.length === 1 ? codes[0] : null), unit: 'minor', original_minor: byCurrency, fx_rates, missing_fx };
}
function ratio(numerators: Point[], denominators: Point[], def: Definition, query: Query, warnings: Set<string>, inputs?: Point[]) {
  const identity = (p: Point) => JSON.stringify([seriesKey(p), p.day ?? p.start ?? 'lifetime', p.end]);
  const numeratorMap = partition(numerators.filter(p => isUsable(p, query)), identity);
  const denominatorMap = partition(denominators.filter(p => isUsable(p, query)), identity);
  let n = 0, d = 0, matched = 0, estimate = false;
  for (const [key, ns] of numeratorMap) {
    const ds = denominatorMap.get(key);
    if (!ds) continue;
    matched++;
    inputs?.push(...ns, ...ds);
    for (const point of ns) { n += point.value!; estimate ||= point.availability === 'estimated'; }
    for (const point of ds) { d += point.value!; estimate ||= point.availability === 'estimated'; }
  }
  if (matched !== numeratorMap.size || matched !== denominatorMap.size) warnings.add('PARTIAL_COVERAGE');
  if (d <= 0) return unknown(d === 0 && matched ? 'not_applicable' : unknownAvailability([...numerators, ...denominators]));
  return { value: n / d * (def.unit === 'percent' ? 100 : 1), availability: estimate ? 'estimated' : 'observed', estimate, numerator: n, denominator: d };
}
function qualityBounds(data: Fields, range: Period) {
  return data.window_start && data.window_end && instant(data.window_start, 'window_start') < range.to && instant(data.window_end, 'window_end') > range.from;
}
function trafficSamples(links: Entity[], redirects: Entity[], query: Query, asOf: string): Sample[] {
  if (query.subject.type !== 'short_link' || !query.metrics.some(key => key.startsWith('link.'))) return [];
  links = links.filter(row => visibleAt(row, asOf));
  redirects = redirects.filter(row => visibleAt(row, asOf));
  return links.flatMap(link => ['link.redirects', 'link.clicks_filtered'].flatMap(key => {
    const start = instant(link.created_at, 'created_at');
    const matching = redirects.filter(event => event.data.short_link_id === link.id && event.data.occurred_at && (key === 'link.redirects' || ['human_likely', 'unknown'].includes(event.data.classification) || event.data.bot === false && event.data.preview !== true));
    const days = new Map<string, Entity[]>();
    const limit = asOf < query.time.to ? asOf : query.time.to;
    if (limit <= query.time.from || limit < start) return [];
    const first = localDay(start > query.time.from ? start : query.time.from, query.time.tz), last = localDay(Date.parse(limit) - 1, query.time.tz);
    for (let day = first; day <= last; day = addDays(day, 1)) {
      if (days.size >= 1000) invalid('Too many periods');
      days.set(day, []);
    }
    for (const event of matching) {
      const at = instant(event.data.occurred_at, 'occurred_at');
      if (at <= asOf && inPeriod(at, query.time)) days.get(localDay(at, query.time.tz))?.push(event);
    }
    return [...days].filter(([day, events]) => events.length > 0 || (key === 'link.clicks_filtered' && redirects.some(event =>
      event.data.short_link_id === link.id && ['bot_preview', 'crawler', 'prefetch'].includes(event.data.classification) &&
      inPeriod(instant(event.data.occurred_at, 'occurred_at'), query.time) && event.data.occurred_at <= asOf && localDay(event.data.occurred_at, query.time.tz) === day))).map(([day, events]): Sample => ({ id: link.id, key, revision: 1, platform: link.data.platform ?? 'owned', subject: link.id,
      dims: { campaign_id: link.data.campaign_id }, signature: '', at: asOf, nativeDay: day, periodKind: 'day', value: events.length, availability: 'observed',
      source: { method: 'redirect_event' }, evidence: [ref(link), ...events.map(ref)] }));
  }));
}
export async function queryMetrics(ctx: Context, query: Query, asOf: string, allowRevenue = revenueRoles.some(role => role === ctx.role), observations?: Entity[]) {
  const registry = await definitionsAt(ctx, asOf);
  const raw = observations ?? await ctx.list(moduleKey, 'metric_observation');
  const publications = query.subject.type === 'platform_post' ? await ctx.list('execution', 'platform_post') : [];
  const rates = query.report_currency ? await ratesAt(ctx, asOf) : [];
  const gaps = await ctx.list('ingest', 'data_gap');
  const traffic = query.subject.type === 'short_link' ? trafficSamples(await ctx.list('traffic', 'short_link'), await ctx.list('traffic', 'click_event'), query, asOf) : [];
  return computeMetrics(query, asOf, allowRevenue, registry, raw, publications, rates, gaps, traffic, await ctx.list('ingest', 'data_source'));
}
function computeMetrics(query: Query, asOf: string, allowRevenue: boolean, registry: ReturnType<typeof buildRegistry>, raw: Entity[], publications: Entity[], rates: Entity[], gapRows: Entity[], traffic: Sample[], sourceRows: Entity[]) {
  const definitions = query.metrics.map(key => definitionFor(registry, key));
  for (const def of definitions) {
    if (!def.subject_types.includes(query.subject.type)) invalid(`Metric ${def.key} is incompatible with subject ${query.subject.type}`);
    if (!allowRevenue && (def.scope === 'commerce' || def.unit === 'currency')) invalid('Monetary metrics require revenue access');
  }
  const relevant = new Set(definitions.flatMap(d => [d.key, ...(d.value_kind === 'ratio' ? [d.numerator_key!, d.denominator_key!] : [])]));
  raw = raw.filter(row => row.data.subject_type === query.subject.type);
  const postMap = new Map(publications.filter(row => visibleAt(row, asOf)).map(row => [row.id, row]));
  const sources = new Map(sourceRows.map(row => [row.id, row]));
  let blocked = false;
  const baseSamples = raw.flatMap(row => {
    const s = parseSample(row, asOf);
    if (!s) return [];
    const sourceId = s.source.data_source_id;
    if (sourceId) {
      const source = sources.get(sourceId);
      if (!source || source.data.status === 'disabled' || source.data.allowed_uses?.display !== true) {
        blocked = true;
        return [];
      }
    }
    const post = postMap.get(s.subject);
    if (post) {
      if (s.platform === 'unknown') s.platform = platformName(post.data.platform ?? post.data.provider ?? 'unknown');
      s.publication ??= post.data.published_at;
      for (const key of ['brand_id', 'social_account_id', 'campaign_id', 'market_id', 'content_type']) s.dims[key] ??= post.data[key];
    }
    if (s.publication) s.publication = instant(s.publication, 'published_at');
    return [s];
  });
  const samples = [...baseSamples, ...traffic].filter(sample =>
    Object.entries(query.subject.filter).every(([key, values]) => values.includes(dimension(sample, filterDimensions[key as keyof typeof filterDimensions]))) &&
    (query.traffic_source === 'all' || sample.dims.traffic_source === query.traffic_source) &&
    (query.time.basis === 'period' || sample.publication !== undefined && inPeriod(sample.publication, query.time)));
  const observed = samples.filter(sample => relevant.has(sample.key));
  const expected = new Set(samples.map(p => p.subject));
  for (const subject of query.subject.filter.subject_ids ?? []) expected.add(subject);
  for (const row of postMap.values()) {
    const sample = { subject: row.id, platform: platformName(row.data.platform ?? row.data.provider ?? 'unknown'), dims: row.data } as Sample;
    if (Object.entries(query.subject.filter).every(([key, values]) => values.includes(dimension(sample, filterDimensions[key as keyof typeof filterDimensions]))) &&
       (!row.data.published_at || query.time.basis !== 'published_at' || inPeriod(instant(row.data.published_at, 'published_at'), query.time))) expected.add(row.id);
  }
  const warnings = new Set<string>();
  if (blocked) warnings.add('SOURCE_USE_RESTRICTED');
  const groupedBy = [...query.group_by];
  if (definitions.some(d => d.additivity !== 'additive') && new Set(observed.map(p => p.platform)).size > 1 && !groupedBy.includes('platform')) {
    groupedBy.push('platform');
    warnings.add('NON_ADDITIVE_ACROSS_PLATFORMS');
  }
  const points = [...relevant].flatMap(key => pointsFor(observed.filter(p => p.key === key), query, definitionFor(registry, key)));
  const definitions_used = [...relevant].map(key => ({ key, revisions: [...new Set([definitionFor(registry, key).revision, ...observed.filter(p => p.key === key).map(p => p.revision)])].sort((a, b) => a - b) }));
  if (definitions_used.some(d => d.revisions.length > 1)) warnings.add('MIXED_DEFINITION_REVISIONS');
  if (points.some(p => p.availability === 'sync_failed' && p.method === 'cumulative_diff')) warnings.add('NEGATIVE_OR_INCOMPATIBLE_CUMULATIVE_DELTA');
  const rowGroup = (p: Point) => ({ ...Object.fromEntries(groupedBy.map(key => [key, String(dimension(p, key) ?? 'unknown')])),
    ...(query.granularity === 'none' ? {} : { period: timeGroup(pointDay(p, query), query.granularity) }) });
  const grouped = partition(points, p => JSON.stringify(rowGroup(p)));
  if (!grouped.size && !groupedBy.length && query.granularity === 'none') grouped.set('{}', []);
  const rows = [...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([group, groupPoints]) => ({ group: JSON.parse(group) as Record<string, string>,
    values: Object.fromEntries(definitions.map(def => {
      const values = groupPoints.filter(p => p.key === def.key);
      const inputs: Point[] = [];
      const cell = def.value_kind === 'ratio' ? ratio(groupPoints.filter(p => p.key === def.numerator_key), groupPoints.filter(p => p.key === def.denominator_key), def, query, warnings, inputs) : aggregate(values, def, query.granularity, query, rates, warnings, inputs);
      const refs = [...new Set(inputs.flatMap(p => p.evidence.filter(e => e.module === moduleKey && e.kind === 'metric_observation').map(e => e.id)))];
      return [def.key, { ...cell, refs }];
    })) }));
  const by_availability: Record<string, number> = {};
  const subjectsObserved = new Set<string>();
  let coveredPairs = 0;
  for (const subject of expected) for (const definition of definitions) {
    const subjectPoints = points.filter(p => p.subject === subject);
    const own = subjectPoints.filter(p => p.key === definition.key);
    const counted = definition.value_kind === 'ratio'
      ? ratio(subjectPoints.filter(p => p.key === definition.numerator_key), subjectPoints.filter(p => p.key === definition.denominator_key), definition, query, new Set())
      : aggregate(own, definition, query.granularity, query, rates, new Set());
    if (counted.value !== null) { coveredPairs++; subjectsObserved.add(subject); }
    by_availability[counted.availability] = (by_availability[counted.availability] ?? 0) + 1;
  }
  if (expected.size === 0 || coveredPairs / (expected.size * definitions.length) < 0.8 || points.some(p => p.coverage !== undefined && p.coverage > 0 && p.coverage < 0.8)) warnings.add('LOW_COVERAGE');
  const sourceIds = new Set(observed.map(p => p.source.data_source_id).filter(Boolean));
  const gaps = gapRows.filter(row => visibleAt(row, asOf) && row.data.status !== 'resolved' && sourceIds.has(row.data.data_source_id) && qualityBounds(row.data, query.time))
    .map(row => ({ data_source_id: row.data.data_source_id, period: `${row.data.window_start}/${row.data.window_end}`, gap_type: row.data.gap_type, evidence: ref(row) }));
  if (gaps.length) warnings.add('INGEST_DATA_GAPS');
  const observationsById = new Map(baseSamples.map(sample => [sample.id, sample]));
  const evidence = points.map(p => {
    const records = [...new Map(p.evidence.map(e => [e.id, e])).values()];
    const observations = records.flatMap(record => {
      const sample = record.module === moduleKey && record.kind === 'metric_observation' ? observationsById.get(record.id) : undefined;
      return sample ? [{ id: sample.id, observed_at: sample.at, value: sample.value, availability: sample.availability,
        definition_revision: sample.revision, currency: sample.currency, source: sample.source,
        age_seconds: sample.age ?? (sample.publication ? (Date.parse(sample.at) - Date.parse(sample.publication)) / 1000 : undefined) }] : [];
    });
    return { metric_key: p.key, subject_id: p.subject, platform: p.platform, observation_ids: records.map(record => record.id), records, observations,
      definition_revision: p.revision, availability: p.availability, value: p.value, currency: p.currency, observed_at: p.at, date: p.day, source: p.source,
      method: p.method, deviation_seconds: p.deviation_seconds, coverage: p.coverage };
  });
  return { rows, definitions, definitions_used, coverage: { subjects_total: expected.size, subjects_observed: subjectsObserved.size, by_availability }, as_of: asOf, gaps, warnings: [...warnings], evidence };
}

export const metricCommands: Commands = {
  metrics_query: { roles: readers, async run(ctx, input) {
    if (input.workspace_id !== undefined && input.workspace_id !== ctx.workspaceId) invalid('Workspace does not match session');
    const query = parseMetricQuery(input);
    const asOf = cutoff(ctx, input.data_cutoff_at);
    const result = await queryMetrics(ctx, query, asOf);
    if (!query.compare) return result;
    return { ...result, comparison: await queryMetrics(ctx, { ...query, time: { ...query.time, ...query.compare } }, asOf) };
  } },
  posts_performance_get: { roles: readers, async run(ctx, input) {
    const query = parseMetricQuery({ ...input, subject: { type: 'platform_post', filter: input.subject?.filter ?? input.filter } });
    const asOf = cutoff(ctx, input.data_cutoff_at);
    const result = await queryMetrics(ctx, query, asOf);
    const ids = [...new Set([...result.evidence.map(e => e.subject_id), ...(query.subject.filter.subject_ids ?? [])])];
    const items = await Promise.all(ids.map(async subject_id => ({ subject_id, ...(await queryMetrics(ctx, { ...query, subject: { ...query.subject, filter: { ...query.subject.filter, subject_ids: [subject_id] } } }, asOf)) })));
    return { items, as_of: asOf, coverage: result.coverage, warnings: result.warnings };
  } },
  post_history: { roles: readers, async run(ctx, input) {
    const subject_id = text(input, 'subject_id', 200);
    const asOf = cutoff(ctx, input.data_cutoff_at);
    const registry = await definitionsAt(ctx, asOf);
    const canReadRevenue = revenueRoles.some(role => role === ctx.role);
    const allowed = new Set((await ctx.list('ingest', 'data_source')).filter(row => row.data.status !== 'disabled' && row.data.allowed_uses?.display === true).map(row => row.id));
    const all = (await ctx.list(moduleKey, 'metric_observation')).filter(row => row.data.subject_type === 'platform_post' && row.data.subject_id === subject_id)
      .filter(row => { const def = registry.get(row.data.metric_key)?.[0]; return def && (canReadRevenue || def.scope !== 'commerce' && def.unit !== 'currency'); })
      .flatMap(row => {
        const typed = parseSample(row, asOf);
        return typed && (!typed.source.data_source_id || allowed.has(typed.source.data_source_id)) ? [typed] : [];
      })
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    return { items: all, as_of: asOf };
  } },
};

export const financialRoles = ['owner', 'admin', 'manager', 'analyst'] as const;
export function canReadFinancial(ctx: FlatContext): boolean { return financialRoles.some(role => role === ctx.role); }
const scopes: Record<string, string> = { platform_post: 'execution', click_event: 'traffic', short_link: 'traffic',
  data_gap: 'ingest', social_account: 'account', store: 'commerce', campaign: 'campaign', landing_page: 'traffic', ad: 'ads' };
function entity(ctx: FlatContext, kind: string, row: Row): Entity {
  const { id, version, created_at, updated_at, ...data } = row;
  return { id, version, created_at, updated_at, data, kind, module: scopes[kind] ?? moduleKey, tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId };
}
const flatList = (ctx: FlatContext, kind: string) => ctx.list(kind).map(row => entity(ctx, kind, row));
const flatRegistry = (ctx: FlatContext, at: string) => buildRegistry(flatList(ctx, 'metric_definition_revision'), at);
function flatErrors<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof DomainError) throw new Problem(error.status, error.code, error.message);
    throw error;
  }
}
export function metricDefinitions(ctx: FlatContext, at = isoDate(ctx.now)) {
  return [...flatRegistry(ctx, at).values()].flat().map(def => ({ ...def }));
}
export function metricQueryInput(ctx: FlatContext, raw: Data) {
  if (raw.workspace_id !== undefined && raw.workspace_id !== ctx.workspaceId) throw new Problem(400, 'invalid_analytics_input', 'Workspace does not match request');
  return flatErrors(() => parseMetricQuery({ ...raw, include_estimates: raw.include_estimates ?? raw.include_estimated }));
}
export function compareMetrics(ctx: FlatContext, query: Query, at = isoDate(ctx.now), observations?: Row[]) {
  return flatErrors(() => {
    const registry = flatRegistry(ctx, at);
    for (const key of query.metrics) {
      const def = definitionFor(registry, key);
      const definitions = [def, ...(def.value_kind === 'ratio' ? [definitionFor(registry, def.numerator_key!), definitionFor(registry, def.denominator_key!)] : [])];
      if (!canReadFinancial(ctx) && definitions.some(row => row.unit === 'currency' || row.scope === 'commerce')) {
        throw new Problem(403, 'analytics_revenue_forbidden', 'Revenue access is required');
      }
    }
    const raw = observations?.map(row => entity(ctx, 'metric_observation', row)) ?? flatList(ctx, 'metric_observation');
    const subjects = flatList(ctx, query.subject.type);
    const rates = query.report_currency ? flatList(ctx, 'fx_rate').filter(row => visibleAt(row, at)) : [];
    const gaps = flatList(ctx, 'data_gap');
    const calculate = (input: Query) => computeMetrics(input, at, canReadFinancial(ctx), registry, raw, subjects, rates, gaps,
      input.subject.type === 'short_link' ? trafficSamples(subjects, flatList(ctx, 'click_event'), input, at) : [], flatList(ctx, 'data_source'));
    const result = calculate(query);
    return { ...result, comparison: query.compare ? calculate({ ...query, time: { ...query.time, ...query.compare } }) : undefined };
  });
}
export function recordObservations(ctx: FlatContext, body: Data) {
  return flatErrors(() => {
    const now = isoDate(ctx.now);
    const input = (Array.isArray(body.observations) ? body.observations : []).map(raw => {
      const item = plainObject(raw), type = choice(item.subject_type, subjectTypes, 'subject_type');
      const subject = ctx.get(type, text(item, 'subject_id', 200));
      const provider = optionalString(subject.platform ?? subject.provider);
      return { ...item, published_at: subject.published_at ?? undefined, platform: provider && platformName(provider), brand_id: subject.brand_id };
    });
    const prepared = prepareObservations({ observations: input }, flatRegistry(ctx, now), now);
    const matches = new Map(ctx.list('metric_observation').map(row => [row.observation_key, row]));
    const ids: string[] = [];
    const inserted: Row[] = [];
    for (const { id, body: value } of prepared) {
      let row = matches.get(id);
      if (row && (row.value !== value.value || row.availability !== value.availability || row.definition_revision !== value.definition_revision || row.period_end !== value.period_end)) {
        throw new Problem(409, 'observation_conflict', 'A different observation already exists for this identity');
      }
      if (!row) {
        row = ctx.create('metric_observation', { ...value, observation_key: id });
        matches.set(id, row);
        inserted.push(row);
      }
      ids.push(row.id);
    }
    if (inserted.length) ctx.emit('analytics.observations.recorded', { count: inserted.length, subjects: new Set(inserted.map(row => row.subject_id)).size,
      metric_keys: [...new Set(inserted.map(row => row.metric_key))] });
    return { count: ids.length, inserted_count: inserted.length, ids };
  });
}
export function postHistory(ctx: FlatContext, id: string) {
  ctx.get('platform_post', id);
  const definitions = new Map(metricDefinitions(ctx).map(def => [def.key, def]));
  return { items: ctx.list('metric_observation').filter(row => row.subject_type === 'platform_post' && row.subject_id === id)
    .filter(row => { const def = definitions.get(String(row.metric_key)); return def && (canReadFinancial(ctx) || (def.scope !== 'commerce' && def.unit !== 'currency')); })
    .sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at))).map(row => ({ ...dto(row, ['metric_key', 'definition_revision', 'subject_id', 'period_kind', 'period_start',
      'period_end', 'observed_at', 'subject_age_seconds', 'value', 'availability', 'currency', 'platform']), source: (() => {
      const source = row.source && typeof row.source === 'object' ? row.source as Data : {};
      return { method: optionalString(source.method), batch_id: optionalString(source.batch_id), raw_record_id: optionalString(source.raw_record_id) };
    })() })) };
}

export function reviseMetricDefinition(ctx: FlatContext, body: Data, id?: string) {
  return flatErrors(() => {
    const key = text({ key: id ?? body.key }, 'key', 120);
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(key)) throw new Problem(422, 'invalid_input', 'Use a namespaced metric key');
    const now = isoDate(ctx.now), registry = flatRegistry(ctx, now), previous = registry.get(key)?.[0];
    const expected = previous?.revision ?? 0;
    if (body.expected_revision !== expected) throw new Problem(409, 'version_conflict', 'Metric definition revision changed');
    const definition = prepareRevision(body, previous, registry, key, expected, now);
    const row = ctx.create('metric_definition_revision', definition);
    const existing = ctx.list('metric_definition').find(item => item.key === key);
    const metadata = { ...definition, current_revision: definition.revision };
    if (existing) ctx.update('metric_definition', existing.id, metadata);
    else ctx.create('metric_definition', metadata);
    ctx.emit('analytics.metric_definition.revised', { key, revision: definition.revision });
    return { id: row.id, ...definition };
  });
}
