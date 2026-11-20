import { DomainError, readers, required, text, writers, type Commands, type Context } from '../types.js';
import { parseMetricQuery, queryMetrics } from './metrics.js';
import { definitionFor, definitionsAt } from './registry.js';
import { choice, currentTime, instant, integer, invalid, moduleKey, object, period, state, strings, timeZone } from './shared.js';

const experimentTypes = ['content', 'page', 'ad'] as const;
const referenceTypes = { content: 'content_variant', page: 'landing_page_version', ad: 'ad_creative' } as const;
async function transition(ctx: Context, id: string, version: number, patch: Record<string, unknown>) {
  const row = await ctx.update(moduleKey, 'experiment', id, patch, version);
  await ctx.emit('analytics.experiment.state_changed', { experiment_id: id, status: row.data.status });
  return row;
}
function validVersion(current: number, input: unknown) {
  if (integer(input, 'expected_version', 1) !== current) throw new DomainError('version_conflict', 'Record version is stale', 409);
  return current;
}
export const studyCommands: Commands = {
  experiments_create: { roles: writers, async run(ctx, input) {
    const type = choice(input.type, experimentTypes, 'type');
    const hypothesis = text(input, 'hypothesis', 2000);
    const primary_metric = text(input, 'primary_metric', 120);
    definitionFor(await definitionsAt(ctx, currentTime(ctx)), primary_metric);
    const success_criteria = text(input, 'success_criteria', 1000);
    const range = period(input.period);
    if (!Array.isArray(input.variants) || input.variants.length < 2 || input.variants.length > 10) invalid('Provide 2–10 variants');
    const variants = input.variants.map(raw => {
      const item = object(raw, 'variant');
      return { ref_id: text(item, 'ref_id', 200), ref_type: choice(item.ref_type, [referenceTypes[type]], 'variant.ref_type'), allocation_bps: integer(item.allocation_bps, 'allocation_bps', 1) };
    });
    if (new Set(variants.map(v => v.ref_id)).size !== variants.length || variants.reduce((sum, v) => sum + v.allocation_bps, 0) !== 10000) invalid('Distinct variants must allocate 10,000 basis points');
    const stop_conditions = strings(input.stop_conditions ?? [], 'stop_conditions', 10);
    const row = await ctx.insert(moduleKey, 'experiment', { type, hypothesis, primary_metric, success_criteria, stop_conditions, period: range, variants, status: 'draft' });
    for (const variant of variants) await ctx.insert(moduleKey, 'experiment_variant', { ...variant, experiment_id: row.id });
    await ctx.emit('analytics.experiment.state_changed', { experiment_id: row.id, status: 'draft' });
    return row;
  } },
  experiments_list: { roles: readers, async run(ctx) { return { items: await ctx.list(moduleKey, 'experiment') }; } },
  experiments_transition: { roles: writers, async run(ctx, input) {
    const row = await required(ctx, moduleKey, 'experiment', text(input, 'experiment_id', 200));
    const version = validVersion(row.version, input.expected_version);
    const action = choice(input.action, ['start', 'stop', 'conclude', 'archive'], 'action');
    const now = currentTime(ctx);
    if (action === 'start' && row.data.status === 'draft') {
      if (now >= row.data.period.to) state('Experiment period has ended');
      const metric = definitionFor(await definitionsAt(ctx, now), row.data.primary_metric);
      return transition(ctx, row.id, version, { status: 'running', started_at: now, definition_revision: metric.revision });
    }
    if (action === 'stop' && row.data.status === 'running') return transition(ctx, row.id, version, { status: 'stopped', stopped_at: now, stop_reason: text(input, 'reason', 1000) });
    if (action === 'conclude' && (row.data.status === 'stopped' || row.data.status === 'running' && now >= row.data.period.to)) {
      const limitations = text(input, 'limitations', 2000);
      const decision = choice(input.decision, ['adopt', 'discard', 'retest', 'inconclusive'], 'decision');
      if (!Array.isArray(input.results) || input.results.length !== row.data.variants.length) invalid('Record results for every variant');
      const ids = new Set(row.data.variants.map((v: { ref_id: string }) => v.ref_id));
      const results = input.results.map(raw => {
        const item = object(raw, 'result');
        const ref_id = text(item, 'ref_id', 200);
        if (!ids.delete(ref_id)) invalid('Duplicate or unknown experiment variant');
        const sample_size = integer(item.sample_size, 'sample_size');
        if (item.value !== null && (!Number.isFinite(item.value) || sample_size === 0)) invalid('Metric value requires a non-empty sample or null');
        return { ref_id, sample_size, value: item.value, source_ref: text(item, 'source_ref', 200) };
      });
      const snapshot = await ctx.insert(moduleKey, 'experiment_result_snapshot', { experiment_id: row.id, primary_metric: row.data.primary_metric, definition_revision: row.data.definition_revision, as_of: now, results, method: 'manual_review' });
      return transition(ctx, row.id, version, { status: 'concluded', decision, limitations, concluded_at: now, result_snapshot_id: snapshot.id });
    }
    if (action === 'archive' && row.data.status === 'concluded') return transition(ctx, row.id, version, { status: 'archived', archived_at: now });
    return state(`Cannot ${action} an experiment in ${row.data.status}`);
  } },
  record_audience_insight: { roles: writers, async run(ctx, input) {
    const social_account_id = text(input, 'social_account_id', 200);
    const dimension = choice(input.dimension, ['country', 'age', 'gender', 'active_hour', 'language'], 'dimension');
    const source = choice(input.source, ['platform', 'owned_engagement', 'third_party_estimate'], 'source');
    const observed_at = instant(input.observed_at ?? ctx.now, 'observed_at');
    if (observed_at > currentTime(ctx)) invalid('Observation cannot be in the future');
    const values = object(input.values, 'values');
    const entries = Object.entries(values);
    if (!entries.length || entries.length > 250 || entries.some(([key, value]) => !key.trim() || key.length > 80 || !Number.isFinite(value) || value < 0)) invalid('Provide non-negative audience values');
    const unit = choice(input.unit, ['count', 'percent'], 'unit');
    if (unit === 'percent' && entries.reduce((sum, [, v]) => sum + v, 0) > 100.01) invalid('Percent shares exceed 100');
    const row = await ctx.insert(moduleKey, 'audience_insight_snapshot', { social_account_id, dimension, source, observed_at, unit, values, estimate: source === 'third_party_estimate', source_ref: text(input, 'source_ref', 200) });
    await ctx.emit('analytics.audience_insight.recorded', { snapshot_id: row.id, social_account_id, dimension, source });
    return row;
  } },
  audience_insights: { roles: readers, async run(ctx, input) {
    const id = text(input, 'social_account_id', 200);
    const rows = (await ctx.list(moduleKey, 'audience_insight_snapshot')).filter(row => row.data.social_account_id === id);
    return { items: rows.sort((a, b) => b.data.observed_at.localeCompare(a.data.observed_at)) };
  } },
  posting_time_suggest: { roles: writers, async run(ctx, input) {
    const social_account_id = text(input, 'social_account_id', 200);
    const content_type = text(input, 'content_type', 80);
    const basis_period = period(input.period);
    const tz = timeZone(basis_period.tz);
    const now = currentTime(ctx);
    const query = parseMetricQuery({ metrics: ['norm.post.engagements'], subject: { type: 'platform_post', filter: { social_account_ids: [social_account_id], content_types: [content_type] } },
      time: { ...basis_period, basis: 'published_at' }, age_bucket: '24h', traffic_source: 'organic' });
    const result = await queryMetrics(ctx, query, now);
    const posts = new Map((await ctx.list('execution', 'platform_post')).map(row => [row.id, row.data.published_at]));
    const bySubject = new Map<string, number>();
    for (const sample of result.evidence) {
      if (sample.availability !== 'observed' || sample.value === null || !posts.get(sample.subject_id) || (sample.deviation_seconds ?? Infinity) > 8640) continue;
      if (bySubject.has(sample.subject_id)) continue;
      bySubject.set(sample.subject_id, sample.value);
    }
    if (bySubject.size < 30) return { status: 'insufficient_sample', reason: 'INSUFFICIENT_COMPARABLE_OBSERVATIONS', sample_size: bySubject.size, minimum_sample_size: 30, slots: [], basis_period };
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' });
    const slotsByTime = new Map<string, { weekday: string; hour: number; total: number; sample_size: number }>();
    for (const [id, value] of bySubject) {
      const parts = formatter.formatToParts(new Date(posts.get(id)));
      const weekday = parts.find(p => p.type === 'weekday')!.value, hour = Number(parts.find(p => p.type === 'hour')!.value);
      const key = `${weekday}:${hour}`;
      const slot = slotsByTime.get(key) ?? { weekday, hour, total: 0, sample_size: 0 };
      slot.total += value;
      slot.sample_size++;
      slotsByTime.set(key, slot);
    }
    const slots = [...slotsByTime.values()].filter(slot => slot.sample_size >= 3).map(({ total, ...slot }) => ({ ...slot, score: total / slot.sample_size })).sort((a, b) => b.score - a.score).slice(0, 10);
    if (!slots.length) return { status: 'insufficient_slot_sample', reason: 'INSUFFICIENT_SLOT_SAMPLE', sample_size: bySubject.size, minimum_slot_sample_size: 3, slots: [], basis_period };
    const row = await ctx.insert(moduleKey, 'posting_time_recommendation', { social_account_id, content_type, slots, sample_size: bySubject.size, basis_period, method_version: 1, status: 'proposed',
      limitations: 'Historical organic post engagement at 24 hours. Slot averages are observational.', evidence: result.evidence.filter(sample => bySubject.has(sample.subject_id)).flatMap(sample => sample.records) });
    await ctx.emit('analytics.recommendation.created', { recommendation_id: row.id, social_account_id, sample_size: bySubject.size });
    return row;
  } },
};
