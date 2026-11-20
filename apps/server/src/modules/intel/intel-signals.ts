import { createHash } from 'node:crypto';
import { type Context, type Data, type Row } from '@smartsell/contracts';
import { ageBuckets, canDisplay, inAgeBucket, observationAgeBounds, subjectKey } from './intel-observations.js';
import { choice, conflict, inPeriod, integer, invalid, number, object, optionalText, period, strings, text, time } from './input.js';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hours = 3600;
const day = 86400;
export function metricValue(row: Row, key: string): Data | undefined {
  const value = (row.metrics as Data | undefined)?.[key] as Data | undefined;
  return value && ['observed', 'available', 'estimated'].includes(String(value.availability)) ? value : undefined;
}
const estimate = (row: Row) => (row.source as Data | undefined)?.estimate === true;
const subjectTimeline = (rows: Row[]) => [...rows].sort((a, b) => String(a.observed_at).localeCompare(String(b.observed_at)) || a.id.localeCompare(b.id));
const interactions = ['likes', 'comments', 'shares', 'views', 'reactions'] as const;
export function compare(ctx: Context, query: Record<string, string>): Data {
  const ids = strings(text(query.watch_target_ids, 'watch_target_ids', 5000).split(','), 'watch_target_ids', 50);
  const metric = choice(query.metric ?? 'likes', [...interactions, 'post_frequency'], 'metric');
  const age = choice(query.age ?? '24h', ['24h', '7d'], 'age');
  const bucket = query.age_bucket === undefined ? null : choice(query.age_bucket, ageBuckets, 'age_bucket');
  const ageRange = bucket ? observationAgeBounds(bucket) : age === '24h' ? [0, day] as const : [6 * day, 7 * day] as const;
  const bounds = period(query);
  const all = ctx.list('observation').filter(row => ['post','video'].includes(String(row.subject_type)) && canDisplay(ctx, row));
  const sample = ids.map(id => {
    const target = ctx.get('watch_target', id);
    const posts = new Set(all.filter(row => row.watch_target_id === id && inPeriod(row.published_at, bounds)).map(subjectKey));
    const observations = new Map<string, Row>();
    for (const row of subjectTimeline(all)) {
      if (row.watch_target_id !== id || !inPeriod(row.observed_at, bounds) || !inAgeBucket(row.age_at_observation, ageRange) ||
        typeof metricValue(row, metric)?.value !== 'number') continue;
      observations.set(subjectKey(row), row);
    }
    const values = [...observations.values()].filter(row => typeof metricValue(row, metric)?.value === 'number');
    const mean = (rows: Row[]) => rows.length ? rows.reduce((sum, row) => sum + Number(metricValue(row, metric)?.value), 0) / rows.length : null;
    const observed = values.filter(row => !estimate(row));
    const estimates = values.filter(estimate);
    return { watch_target_id: id, coverage_note: target.coverage_note, post_count: posts.size, sample_size: metric === 'post_frequency' ? posts.size : values.length, observed_sample_size: observed.length, estimated_sample_size: estimates.length, average: mean(observed), estimate_average: mean(estimates), observation_ids: values.map(row => row.id) };
  });
  return { metric, age, ...(bucket ? { age_bucket: bucket } : {}), age_min_seconds: ageRange[0], age_max_seconds: ageRange[1], as_of: ctx.now, period: bounds, sample, method_version: 'post-age-v1' };
}

export function createTopic(ctx: Context, body: Data): Row {
  const keywords = strings(body.keywords, 'keywords');
  if (!keywords.length) invalid('keywords', 'must contain a keyword');
  const market = optionalText(body.market_id, 'market_id', 200);
  if (market) ctx.get('market', market);
  const watchTargetIds = strings(body.watch_target_ids ?? [], 'watch_target_ids', 50);
  for (const id of watchTargetIds) ctx.get('watch_target', id);
  return ctx.create('topic', { name: text(body.name, 'name', 250), keywords, watch_target_ids: watchTargetIds,
    market_id: market, language: optionalText(body.language, 'language', 50) });
}
export function trend(ctx: Context, topic: Row, body: Data): Data {
  const metric = choice(body.metric ?? 'comments', interactions, 'metric');
  const bounds = period(body, true) as { from: string; to: string };
  const interval = Date.parse(bounds.to) - Date.parse(bounds.from);
  const comparison = body.comparison_from !== undefined || body.comparison_to !== undefined
    ? period({ from: body.comparison_from, to: body.comparison_to }, true) as { from: string; to: string }
    : { from: new Date(Date.parse(bounds.from) - interval).toISOString(), to: bounds.from };
  if (comparison.to > bounds.from) invalid('comparison_to', 'must not follow the current period start');
  const words = (topic.keywords as string[]).map(word => word.toLowerCase());
  const targetIds = new Set(topic.watch_target_ids as string[] | undefined);
  const targets = new Map(ctx.list('watch_target').map(row => [row.id, row]));
  const series = new Map<string, Row[]>();
  for (const row of subjectTimeline(ctx.list('observation'))) {
    const attrs = row.attributes as Data | undefined;
    const target = targets.get(String(row.watch_target_id));
    if (!canDisplay(ctx, row) || !target || (targetIds.size && !targetIds.has(target.id)) ||
        (topic.market_id && !(target.market_ids as string[] | undefined)?.includes(String(topic.market_id))) ||
        (topic.language && attrs?.language !== topic.language)) continue;
    const key = JSON.stringify([subjectKey(row), (row.source as Data | undefined)?.data_source_id ?? null]);
    if (!series.has(key)) series.set(key, []);
    series.get(key)!.push(row);
  }
  function compute(window: { from: string; to: string }) {
    let count = 0, increment = 0, estimatedCount = 0, estimatedIncrement = 0, demand = 0;
    const evidence: string[] = [];
    for (const rows of series.values()) {
      const samples = rows.filter(row => inPeriod(row.observed_at, window) && typeof metricValue(row, metric)?.value === 'number');
      const start = samples[0], end = samples.at(-1);
      if (!start || !end || start.observed_at === end.observed_at) continue;
      const attrs = end.attributes as Data | undefined;
      const searchable = JSON.stringify([attrs?.title, attrs?.description, attrs?.keywords, end.note]).toLowerCase();
      if (!words.some(word => searchable.includes(word))) continue;
      const first = metricValue(start, metric)!;
      const last = metricValue(end, metric)!;
      const firstEstimate = estimate(start) || first.availability === 'estimated';
      const lastEstimate = estimate(end) || last.availability === 'estimated';
      if (firstEstimate !== lastEstimate || Number(last.value) < Number(first.value)) continue;
      const delta = Number(last.value) - Number(first.value);
      if (firstEstimate) { estimatedCount++; estimatedIncrement += delta; }
      else { count++; increment += delta; }
      if (attrs?.demand_signal === 'purchase_intent') demand++;
      evidence.push(start.id, end.id);
    }
    return { sample_size: count + estimatedCount, observed_sample_size: count, observed_increment: count ? increment : null,
      estimated_sample_size: estimatedCount, estimated_increment: estimatedCount ? estimatedIncrement : null,
      purchase_intent_sample_size: demand, evidence_observation_ids: evidence, signal_type: 'discussion' };
  }
  return { topic_id: topic.id, metric, period: bounds, comparison_period: comparison, ...compute(bounds), comparison: compute(comparison), method_version: 'paired-snapshots-v2' };
}

export function ruleValues(ctx: Context, body: Data): Data {
  const ids = strings(body.watch_target_ids, 'watch_target_ids', 50);
  if (!ids.length) invalid('watch_target_ids', 'requires at least one target');
  ids.forEach(id => ctx.get('watch_target', id));
  const incoming = object(body.condition, 'condition');
  const type = choice(incoming.type, ['new_post', 'engagement_increment', 'price_change', 'keyword'], 'condition.type');
  const condition = type === 'engagement_increment' ? { type, metric: choice(incoming.metric, interactions, 'condition.metric'), min_increment: integer(incoming.min_increment, 'condition.min_increment', 1) }
    : type === 'keyword' ? { type, keyword: text(incoming.keyword, 'condition.keyword', 150) } : { type };
  return { name: text(body.name, 'name', 250), watch_target_ids: ids, condition,
    min_freshness: integer(body.min_freshness ?? 24 * hours, 'min_freshness', 1, 365 * day),
    recipients: strings(body.recipients ?? [], 'recipients'), status: choice(body.status ?? 'active', ['active', 'paused'], 'status') };
}

function upsertAlert(ctx: Context, rule: Row, target: Row, cause: string, kind: 'signal' | 'source_stale', rows: Row[], extra: Data = {}): Row {
  const fingerprint = digest([rule.id, target.id, kind === 'signal' ? rule.condition : null, cause, kind]);
  const evidence = rows.map(row => row.id);
  const existing = ctx.list('alert').find(row => row.fingerprint === fingerprint);
  if (existing) {
    const previous = (existing.evidence_observation_ids ?? []) as string[];
    return evidence.some(id => !previous.includes(id)) ? ctx.update('alert', existing.id, { evidence_observation_ids: [...new Set([...previous, ...evidence])], last_seen_at: ctx.now }) : existing;
  }
  const row = ctx.create('alert', { rule_id: rule.id, watch_target_id: target.id, brand_id: target.brand_id, alert_type: kind, fingerprint, status: 'open', assignee: null, merged_into_id: null,
    evidence_observation_ids: evidence, condition: rule.condition, recipients: rule.recipients, assessed_at: ctx.now, min_freshness: rule.min_freshness, ...extra });
  ctx.emit('intel.alert.raised', { alert_id: row.id, resource_type: 'alert', resource_id: row.id, brand_id: target.brand_id, watch_target_id: target.id, alert_type: kind });
  return row;
}

export const isIntelSourceGap = (row: Data) => ['open', 'backfill_scheduled'].includes(String(row.status)) &&
  ['freshness', 'source_outage', 'sync_failed', 'no_permission', 'missing_window', 'ip_not_allowed'].includes(String(row.gap_type));
export const isIntelFreshnessIssue = (row: Data) => ['open', 'acknowledged'].includes(String(row.status)) &&
  [row.rule_key, row.check_type, row.issue_type].includes('freshness');

export function evaluateAlerts(ctx: Context, options: { observations?: string[]; sourceId?: string; ruleId?: string; checkFreshnessOnly?: boolean } = {}): Row[] {
  const all = ctx.list('observation');
  const observations = subjectTimeline(all.filter(row => canDisplay(ctx, row)));
  const affectedTargets = options.observations && new Set(all.filter(row => options.observations!.includes(row.id)).map(row => row.watch_target_id));
  const gaps = ctx.list('data_gap').filter(isIntelSourceGap).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const issues = ctx.list('quality_issue').filter(isIntelFreshnessIssue).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const sources = new Map(ctx.list('data_source').map(row => [row.id, row]));
  const results: Row[] = [];
  const targets = new Map(ctx.list('watch_target').map(row => [row.id, row]));
  for (const rule of ctx.list('alert_rule').filter(row => row.status === 'active' && (!options.ruleId || row.id === options.ruleId))) {
    for (const id of rule.watch_target_ids as string[]) {
      const target = targets.get(id);
      if (!target || target.status !== 'active' || (options.sourceId && target.data_source_id !== options.sourceId) ||
        (affectedTargets && !affectedTargets.has(target.id))) continue;
      const selected = observations.filter(row => row.watch_target_id === target.id &&
        (!target.data_source_id || (row.source as Data | undefined)?.data_source_id === target.data_source_id));
      const gap = gaps.find(row => target.data_source_id && row.data_source_id === target.data_source_id);
      const issue = issues.find(row => target.data_source_id && row.data_source_id === target.data_source_id);
      const source = sources.get(String(target.data_source_id));
      if (target.data_source_id) {
        const episodes = ctx.list('alert').filter(row => row.alert_type === 'source_stale' && row.rule_id === rule.id &&
          row.watch_target_id === id && row.data_source_id === target.data_source_id);
        const current = episodes.find(row => !row.source_recovered_at);
        const lastSuccess = source?.kind === 'file_import'
          ? selected.at(-1)?.observed_at ?? current?.last_success_at
          : source?.last_success_at;
        const sourceAge = typeof lastSuccess === 'string' ? (Date.parse(ctx.now) - Date.parse(lastSuccess)) / 1000 : null;
        const freshnessElapsed = sourceAge !== null && sourceAge > Number(rule.min_freshness);
        if (gap || issue || source?.status !== 'active' || freshnessElapsed) {
          results.push(current ?? upsertAlert(ctx, rule, target, JSON.stringify([target.data_source_id, episodes.length]), 'source_stale', [], {
            data_gap_id: gap?.id ?? null, quality_issue_id: issue?.id ?? null, data_source_id: target.data_source_id,
            source_status: source?.status ?? null, last_success_at: lastSuccess ?? null, source_age_seconds: sourceAge,
          }));
          continue;
        }
        if (current) ctx.update('alert', current.id, { source_recovered_at: ctx.now });
      }
      if (options.checkFreshnessOnly) continue;
      for (const [index, current] of selected.entries()) {
        if (options.observations && !options.observations.includes(current.id)) continue;
        const age = (Date.parse(ctx.now) - Date.parse(String(current.observed_at))) / 1000;
        if (age > Number(rule.min_freshness)) continue;
        const identity = subjectKey(current);
        const previous = selected.slice(0, index).findLast(row => subjectKey(row) === identity && (row.source as Data)?.data_source_id === (current.source as Data)?.data_source_id && row.observed_at !== current.observed_at);
        const condition = rule.condition as Data;
        let match = false;
        let evidence = [current];
        let cause = identity;
        if (condition.type === 'new_post') match = !previous && ['post', 'video'].includes(String(current.subject_type));
        if (condition.type === 'keyword') match = JSON.stringify([current.attributes, current.note]).toLowerCase().includes(String(condition.keyword).toLowerCase());
        if (previous && condition.type === 'engagement_increment') {
          const before = metricValue(previous, String(condition.metric))?.value;
          const after = metricValue(current, String(condition.metric))?.value;
          match = typeof before === 'number' && typeof after === 'number' && after - before >= Number(condition.min_increment);
          evidence = [previous, current]; cause = current.id;
        }
        if (previous && condition.type === 'price_change') {
          const before = metricValue(previous, 'price');
          const after = metricValue(current, 'price');
          match = Boolean(before && after && before.currency === after.currency && before.amount_minor !== after.amount_minor);
          evidence = [previous, current]; cause = current.id;
        }
        if (match) results.push(upsertAlert(ctx, rule, target, cause, 'signal', evidence, { source_age_seconds: age, is_estimate: evidence.some(estimate) }));
      }
    }
  }
  return results;
}

export function alertTransition(ctx: Context, row: Row, body: Data): Row {
  const next = choice(body.status, ['acknowledged', 'assigned', 'resolved', 'dismissed'], 'status');
  const edges: Record<string, string> = { open: 'acknowledged', acknowledged: 'assigned', assigned: 'resolved' };
  if (next !== 'dismissed' && edges[String(row.status)] !== next || row.status === 'dismissed') conflict('Invalid alert status transition');
  return ctx.update('alert', row.id, { status: next, ...(next === 'assigned' ? { assignee: text(body.assignee, 'assignee', 200) } : {}), ...(next === 'dismissed' ? { dismissal_reason: text(body.reason, 'reason') } : {}) });
}

export function listAlerts(ctx: Context, query: Record<string, string>): Row[] {
  const bounds = period(query);
  return ctx.list('alert').filter(row => (!query.rule_id || row.rule_id === query.rule_id) && (!query.status || row.status === query.status) &&
    (!query.alert_type || row.alert_type === query.alert_type) && inPeriod(row.created_at, bounds));
}