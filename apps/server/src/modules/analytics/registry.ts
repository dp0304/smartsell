import { createHash } from 'node:crypto';
import { admins, DomainError, readers, text, writers, type Commands, type Context, type Fields } from '../types.js';
import { choice, currency, currentTime, instant, integer, invalid, moduleKey, object, strings, visibleAt } from './shared.js';

export const subjectTypes = ['platform_post', 'social_account', 'short_link', 'landing_page', 'campaign', 'store', 'ad'] as const;
export const availabilityTypes = ['observed', 'not_collected', 'no_permission', 'not_applicable', 'sync_failed', 'source_not_provided', 'estimated'] as const;
const scopes = ['platform_native', 'normalized', 'derived', 'traffic', 'commerce'] as const;
const units = ['count', 'seconds', 'ratio', 'percent', 'currency'] as const;
const valueKinds = ['cumulative', 'period_sum', 'gauge', 'ratio'] as const;
const additivities = ['additive', 'additive_within_platform', 'non_additive'] as const;
export type Definition = {
  key: string; revision: number; text: string; display_name: string;
  subject_types: readonly string[]; scope: typeof scopes[number]; platform: string | null; native_name: string | null;
  unit: typeof units[number]; value_kind: typeof valueKinds[number]; additivity: typeof additivities[number];
  numerator_key?: string; denominator_key?: string; effective_from: string; status: 'active' | 'deprecated';
};
function builtin(key: string, native_name: string, subject: string, value_kind: Definition['value_kind'], options: Partial<Definition> = {}): Definition {
  return { key, revision: 1, display_name: native_name, text: `${native_name} under the source's reporting definition.`, subject_types: [subject],
    scope: 'platform_native', unit: 'count', value_kind, additivity: 'additive_within_platform', platform: null, native_name,
    effective_from: '1970-01-01T00:00:00.000Z', status: 'active', ...options };
}
const builtins: Definition[] = [
  builtin('ig.media.reach', 'reach', 'platform_post', 'cumulative', { platform: 'instagram', additivity: 'non_additive' }),
  builtin('yt.video.views', 'views', 'platform_post', 'cumulative', { platform: 'youtube' }),
  builtin('norm.post.views', 'Views', 'platform_post', 'cumulative', { scope: 'normalized' }),
  builtin('norm.post.engagements', 'Engagements', 'platform_post', 'cumulative', { scope: 'normalized' }),
  builtin('norm.post.impressions', 'Impressions', 'platform_post', 'cumulative', { scope: 'normalized' }),
  builtin('norm.post.engagement_rate', 'Engagement rate', 'platform_post', 'ratio', { scope: 'derived', unit: 'ratio', additivity: 'additive_within_platform', numerator_key: 'norm.post.engagements', denominator_key: 'norm.post.impressions', text: 'Engagements divided by positive impressions over matching subjects, dimensions and periods.' }),
  builtin('norm.account.followers', 'Followers', 'social_account', 'gauge', { scope: 'normalized', additivity: 'non_additive' }),
  builtin('link.redirects', 'Redirects', 'short_link', 'period_sum', { scope: 'traffic', additivity: 'additive' }),
  builtin('link.clicks_filtered', 'Filtered clicks', 'short_link', 'period_sum', { scope: 'traffic', additivity: 'additive' }),
];
for (const key of ['impressions', 'reach', 'views', 'video_views', 'likes', 'comments', 'shares', 'saves', 'followers', 'clicks', 'spend', 'conversions', 'watch_time_seconds']) {
  builtins.push(builtin(key, key, 'platform_post', key === 'followers' ? 'gauge' : 'period_sum', {
    scope: 'normalized', subject_types: subjectTypes, additivity: ['followers', 'reach'].includes(key) ? 'non_additive' : 'additive_within_platform',
    unit: key === 'spend' ? 'currency' : key === 'watch_time_seconds' ? 'seconds' : 'count',
    text: `Imported ${key} under the provider's native reporting definition. Compare only within the same platform and reporting scope.`,
  }));
}
export async function definitionsAt(ctx: Context, asOf: string) {
  return buildRegistry(await ctx.list(moduleKey, 'metric_definition_revision'), asOf);
}
export function buildRegistry(rows: Awaited<ReturnType<Context['list']>>, asOf: string) {
  const registry = new Map<string, Definition[]>();
  for (const definition of builtins) registry.set(definition.key, [definition]);
  for (const row of rows) {
    const definition = row.data as Definition;
    if (!visibleAt(row, asOf) || definition.effective_from > asOf) continue;
    const revisions = registry.get(definition.key) ?? [];
    revisions.push(definition);
    revisions.sort((a, b) => b.revision - a.revision);
    registry.set(definition.key, revisions);
  }
  return registry;
}
export type Registry = Awaited<ReturnType<typeof definitionsAt>>;
export function definitionFor(registry: Registry, key: string): Definition {
  const definition = registry.get(key)?.[0];
  if (!definition) throw new DomainError('unknown_metric', `Unknown metric ${key}`, 404);
  return definition;
}
const optionalString = (data: Fields, key: string) => data[key] === undefined ? undefined : text(data, key, 200);
export function prepareObservations(input: Fields, registry: Registry, now: string) {
  if (!Array.isArray(input.observations) || input.observations.length < 1 || input.observations.length > 1000) invalid('Provide 1–1000 observations');
  return input.observations.map(raw => {
    const item = object(raw, 'observation');
    const metric_key = text(item, 'metric_key', 120);
    const current = definitionFor(registry, metric_key);
    const observed_at = instant(item.observed_at ?? now, 'observed_at');
    if (observed_at > now) invalid('observed_at cannot be in the future');
    const definition = item.definition_revision === undefined ? current : registry.get(metric_key)?.find(d => d.revision === item.definition_revision);
    if (!definition || definition.status !== 'active' || current.status !== 'active') invalid(`Inactive or unknown definition revision for ${metric_key}`);
    if (definition.value_kind === 'ratio') invalid('Record the components of ratio metrics');
    const subject_type = choice(item.subject_type, subjectTypes, 'subject_type');
    if (!definition.subject_types.includes(subject_type)) invalid(`Invalid subject for ${metric_key}`);
    const subject_id = text(item, 'subject_id', 200);
    const platform = optionalString(item, 'platform') ?? definition.platform ?? undefined;
    if (definition.platform && platform !== definition.platform) invalid(`Invalid platform for ${metric_key}`);
    const availability = choice(item.availability ?? 'observed', availabilityTypes, 'availability');
    const known = availability === 'observed' || availability === 'estimated';
    if (known ? !Number.isFinite(item.value) : item.value != null) invalid(`Value and availability do not agree for ${metric_key}`);
    const code = definition.unit === 'currency' ? currency(item.currency) : undefined;
    if (known && definition.unit === 'currency' && !Number.isSafeInteger(item.value)) invalid('Currency values must be integer minor units');
    const period_kind = choice(item.period_kind ?? (item.date ? 'day' : definition.value_kind === 'period_sum' ? 'range' : 'lifetime'), ['lifetime', 'day', 'hour', 'range'], 'period_kind');
    const period_start = item.period_start === undefined ? undefined : instant(item.period_start, 'period_start');
    const period_end = item.period_end === undefined ? undefined : instant(item.period_end, 'period_end');
    const nativeDate = item.date === undefined ? undefined : instant(item.date, 'date').slice(0, 10);
    if (period_kind !== 'lifetime' && !period_start && !nativeDate) invalid('Period requires date or period_start');
    if (period_end && (!period_start || period_end <= period_start)) invalid('Invalid period end');
    const published_at = item.published_at === undefined ? undefined : instant(item.published_at, 'published_at');
    if (published_at && published_at > observed_at) invalid('Publication follows observation');
    const subject_age_seconds = item.subject_age_seconds === undefined ? undefined : integer(item.subject_age_seconds, 'subject_age_seconds');
    const dims = object(item.dims ?? item.dimensions ?? {}, 'dims');
    if (Object.keys(dims).length > 30 || Object.entries(dims).some(([key, value]) => !/^[a-zA-Z0-9_]{1,60}$/.test(key) || typeof value !== 'string' || value.length > 200)) invalid('Dimensions must be string-valued');
    const sortedDims = Object.fromEntries(Object.entries(dims).sort(([a], [b]) => a.localeCompare(b)));
    const rawSource = object(item.source, 'source');
    const source = { method: text(rawSource, 'method', 80), batch_id: optionalString(rawSource, 'batch_id'),
      raw_record_id: optionalString(rawSource, 'raw_record_id'), data_source_id: optionalString(rawSource, 'data_source_id'), estimate: availability === 'estimated' };
    const body = { metric_key, definition_revision: definition.revision, subject_type, subject_id, platform, observed_at, availability,
      value: known ? item.value : null, currency: code, period_kind, period_start, period_end, date: nativeDate, published_at, subject_age_seconds,
      dims: sortedDims, source, brand_id: optionalString(item, 'brand_id'), data_source_id: optionalString(item, 'data_source_id') ?? source.data_source_id };
    const id = `obs-${createHash('sha256').update(JSON.stringify([subject_type, subject_id, metric_key, period_kind, period_start ?? nativeDate, sortedDims, observed_at, code])).digest('hex')}`;
    return { id, body };
  });
}
export async function recordObservations(ctx: Context, input: Fields) {
  const now = currentTime(ctx);
  const prepared = prepareObservations(input, await definitionsAt(ctx, now), now);
  const saved = [];
  const inserted = [];
  for (const { id, body } of prepared) {
    const existing = await ctx.get(moduleKey, 'metric_observation', id);
    if (existing) {
      if (existing.data.value !== body.value || existing.data.availability !== body.availability || existing.data.definition_revision !== body.definition_revision) throw new DomainError('observation_conflict', 'A different observation already exists for this identity', 409);
      saved.push(existing);
    } else {
      const row = await ctx.insert(moduleKey, 'metric_observation', body, id);
      saved.push(row);
      inserted.push(row);
    }
  }
  if (inserted.length) await ctx.emit('analytics.observations.recorded', { count: inserted.length, subjects: new Set(inserted.map(row => row.data.subject_id)).size, metric_keys: [...new Set(inserted.map(row => row.data.metric_key))] });
  return { count: saved.length, inserted_count: inserted.length, ids: saved.map(row => row.id) };
}

export function prepareRevision(input: Fields, previous: Definition | undefined, registry: Registry, key: string, expected: number, now: string): Definition {
  const draft = { ...previous, ...input };
  const scope = choice(draft.scope, scopes, 'scope');
  const unit = choice(draft.unit, units, 'unit');
  const value_kind = choice(draft.value_kind, valueKinds, 'value_kind');
  const subject_types = strings(draft.subject_types, 'subject_types', subjectTypes.length).map(subject => choice(subject, subjectTypes, 'subject_type'));
  if (!subject_types.length) invalid('Define at least one subject type');
  const platform = draft.platform == null ? null : text(draft, 'platform', 80);
  const native_name = draft.native_name == null ? null : text(draft, 'native_name', 100);
  if (scope === 'platform_native' && (!platform || !native_name)) invalid('Platform-native definitions require platform and native name');
  if (previous && (previous.unit !== unit || previous.value_kind !== value_kind || previous.scope !== scope)) invalid('Changing scope, unit, or value kind requires a new metric key');
  const definition: Definition = { key, revision: expected + 1, scope, platform, native_name, unit, value_kind, subject_types,
    additivity: choice(draft.additivity, additivities, 'additivity'), text: text(draft, 'text'), display_name: text(draft, 'display_name', 200),
    effective_from: now, status: choice(draft.status ?? 'active', ['active', 'deprecated'], 'status') };
  if (value_kind === 'ratio') {
    if (unit !== 'ratio' && unit !== 'percent') invalid('Ratio metrics require ratio or percent units');
    const numerator = definitionFor(registry, text(draft, 'numerator_key', 120));
    const denominator = definitionFor(registry, text(draft, 'denominator_key', 120));
    if ([numerator, denominator].some(x => x.key === key || x.value_kind === 'ratio' || x.unit === 'currency' || (scope !== 'commerce' && x.scope === 'commerce') || subject_types.some(subject => !x.subject_types.includes(subject)))) invalid('Invalid ratio component definitions');
    definition.numerator_key = numerator.key;
    definition.denominator_key = denominator.key;
  }
  return definition;
}

export const registryCommands: Commands = {
  metric_definitions_get: { roles: readers, async run(ctx, input) {
    const registry = await definitionsAt(ctx, currentTime(ctx));
    const keys = input.keys === undefined ? [...registry.keys()].sort() : strings(input.keys, 'keys');
    return { items: keys.map(key => ({ ...definitionFor(registry, key), revisions: registry.get(key) })) };
  } },
  revise_metric_definition: { roles: admins, async run(ctx, input) {
    const key = text(input, 'key', 120);
    if (!/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(key)) invalid('Use a namespaced metric key');
    const registry = await definitionsAt(ctx, currentTime(ctx));
    const previous = registry.get(key)?.[0];
    const expected = integer(input.expected_revision ?? 0, 'expected_revision');
    if (expected !== (previous?.revision ?? 0)) throw new DomainError('version_conflict', 'Metric definition revision changed', 409);
    const definition = prepareRevision(input, previous, registry, key, expected, currentTime(ctx));
    const row = await ctx.insert(moduleKey, 'metric_definition_revision', definition, `${key}:${definition.revision}`);
    const index = await ctx.get(moduleKey, 'metric_definition', key);
    if (index) await ctx.update(moduleKey, 'metric_definition', key, { ...definition, current_revision: definition.revision }, index.version);
    else await ctx.insert(moduleKey, 'metric_definition', { ...definition, current_revision: definition.revision }, key);
    await ctx.emit('analytics.metric_definition.revised', { key, revision: definition.revision });
    return row;
  } },
  record_observations: { roles: writers, run: recordObservations },
};
