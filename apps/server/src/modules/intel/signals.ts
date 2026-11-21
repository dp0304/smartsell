import { createHash } from 'node:crypto';
import { readers, required, text, writers } from '../types.ts';
import type { Context, Entity, Fields } from '../types.ts';
import { countMetrics, enforceRecorder, provenance, provenanceKeys, readable, requireReadable, subjectKey } from './observations.ts';
import { evidence, isEvidence } from './research.ts';
import { active, assertVersion, blocked, choice, command, conflict, create, fail, get, language, list, number, object, optional, period, selected, strings, timestamp, update } from './validation.ts';

const countChangeMetrics = countMetrics.filter(metric => metric !== 'followers');
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const valueAvailable = (value: Fields | undefined) => value && ['observed', 'estimated'].includes(value.availability);
const windowContains = (at: string, window: { from: string; to: string }) => at >= window.from && at < window.to;
async function targets(ctx: Context, fields: Fields) {
  const ids = strings(fields, 'watch_target_ids', 30);
  if (!ids.length) fail('At least one watch target is required');
  return Promise.all(ids.map(id => get(ctx, 'watch_target', id)));
}
function condition(value: unknown): Fields {
  const keys = ['type', 'metric', 'minimum_delta', 'keyword'];
  const input = object(value, keys, 'condition');
  const type = choice(input, 'type', ['new_post', 'engagement_increase', 'price_change', 'keyword_match']);
  if (type === 'engagement_increase') {
    object(value, ['type', 'metric', 'minimum_delta'], 'condition');
    return { type, metric: choice(input, 'metric', ['likes', 'comments', 'views', 'shares']),
      minimum_delta: number(input, 'minimum_delta', 1, Number.MAX_SAFE_INTEGER, true) };
  }
  if (type === 'keyword_match') {
    object(value, ['type', 'keyword'], 'condition');
    return { type, keyword: text(input, 'keyword', 120).toLocaleLowerCase() };
  }
  if (type === 'price_change') {
    object(value, ['type', 'minimum_delta'], 'condition');
    return { type, minimum_delta: number(input, 'minimum_delta', 1, Number.MAX_SAFE_INTEGER, true) };
  }
  object(value, ['type'], 'condition');
  return { type };
}
const alertFields = ['name', 'watch_target_ids', 'condition', 'min_freshness', 'recipients'];
async function alertPatch(ctx: Context, input: Fields) {
  return {
    ...selected(input, ['name']),
    ...(input.watch_target_ids !== undefined ? { watch_target_ids: (await targets(ctx, input)).map(row => row.id) } : {}),
    ...(input.condition !== undefined ? { condition: condition(input.condition) } : {}),
    ...(input.min_freshness !== undefined ? { min_freshness: number(input, 'min_freshness', 1, 2592000, true) } : {}),
    ...(input.recipients !== undefined ? { recipients: strings(input, 'recipients', 30) } : {}),
  };
}
async function saveAlert(ctx: Context, rule: Entity, target: Entity, fingerprint: string, data: Fields) {
  const existing = await ctx.get('intel', 'alert', fingerprint);
  if (existing) return existing;
  const row = await ctx.insert('intel', 'alert', {
    rule_id: rule.id, rule_version: rule.version, condition: rule.data.condition, min_freshness: rule.data.min_freshness,
    recipients: rule.data.recipients, watch_target_id: target.id, fingerprint, status: 'open', assignee: null, ...data,
  }, fingerprint);
  await ctx.emit('intel.alert.raised', { id: row.id, rule_id: rule.id, watch_target_id: target.id, alert_type: row.data.alert_type,
    recipients: row.data.recipients, evidence_observation_ids: row.data.evidence_observation_ids });
  return row;
}
function matches(rule: Fields, current: Entity, previous?: Entity): boolean {
  const { type, metric, minimum_delta, keyword } = rule;
  if (type === 'new_post') return !previous && ['post', 'video'].includes(current.data.subject_type);
  if (type === 'keyword_match') return [current.data.attributes?.title, current.data.attributes?.description]
    .some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(keyword));
  if (!previous) return false;
  const field = type === 'price_change' ? 'price' : metric;
  const before = previous.data.metrics[field], after = current.data.metrics[field];
  if (!valueAvailable(before) || !valueAvailable(after) || before.availability !== after.availability) return false;
  return field === 'price' ? before.currency === after.currency && Math.abs(after.amount_minor - before.amount_minor) >= minimum_delta
    : after.value - before.value >= minimum_delta;
}
async function staleDetails(ctx: Context, target: Entity, rule: Entity, gaps: Entity[], issues: Entity[]) {
  const id = target.data.data_source_id;
  if (!id) return;
  const source = await required(ctx, 'ingest', 'data_source', id);
  const gap = [...gaps, ...issues].find(row => row.data.data_source_id === id && ['open', 'backfill_scheduled'].includes(row.data.status) &&
    (row.kind === 'data_gap' ? ['source_outage', 'sync_failed', 'no_permission', 'missing_window', 'ip_not_allowed', 'freshness'].includes(row.data.gap_type) :
      [row.data.check_type, row.data.rule_key, row.data.issue_type].includes('freshness')));
  const last = source.data.last_success_at;
  if (gap || source.data.status !== 'active' || !last || Date.parse(ctx.now) - Date.parse(last) > rule.data.min_freshness * 1000) {
    return { data_source_id: id, gap_id: gap?.id ?? null, last_success_at: last ?? null, source_status: source.data.status };
  }
}

const mentionFields = ['watch_target_id', 'text_excerpt', 'author_ref', ...provenanceKeys];
const labelValues = { sentiment: ['positive', 'neutral', 'negative', 'uncertain'], intent: ['discussion', 'purchase_intent', 'support', 'complaint', 'uncertain'] };
const topicFields = ['name', 'keywords', 'watch_target_ids', 'market_id', 'language'];

export const signalCommands = {
  list_topics: command(readers, async (ctx, input) => {
    object(input, ['market_id', 'language']);
    const market = optional(input, 'market_id', text);
    const locale = optional(input, 'language', language);
    return { items: (await list(ctx, 'topic')).filter(row => (!market || row.data.market_id === market) && (!locale || row.data.language === locale)) };
  }),
  list_topic_trends: command(readers, async (ctx, input) => {
    object(input, ['topic_id']);
    const topic = await get(ctx, 'topic', text(input, 'topic_id'));
    const items = (await list(ctx, 'topic_trend_point')).filter(row => row.data.topic_id === topic.id);
    for (const row of items) await requireReadable(ctx,
      await Promise.all(row.data.evidence_observation_ids.map((id: string) => get(ctx, 'observation', id))));
    return { items };
  }),
  list_alerts: command(readers, async (ctx, input) => {
    object(input, ['rule_id', 'status']);
    const ruleId = optional(input, 'rule_id', text);
    if (ruleId) await get(ctx, 'alert_rule', ruleId);
    const status = optional(input, 'status', (value, key) => choice(value, key, ['open', 'acknowledged', 'assigned', 'resolved', 'dismissed']));
    const items = (await list(ctx, 'alert')).filter(row => (!ruleId || row.data.rule_id === ruleId) && (!status || row.data.status === status));
    for (const row of items) await requireReadable(ctx,
      await Promise.all(row.data.evidence_observation_ids.map((id: string) => get(ctx, 'observation', id))));
    return { items };
  }),
  mention_labels: command(readers, async (ctx, input) => {
    object(input, ['mention_id']);
    const mention = await get(ctx, 'mention', text(input, 'mention_id'));
    await requireReadable(ctx, [mention]);
    return { mention_id: mention.id, latest_label_ids: mention.data.latest_label_ids,
      items: (await list(ctx, 'mention_label')).filter(row => row.data.mention_id === mention.id) };
  }),
  create_topic: command(writers, async (ctx, input) => {
    object(input, topicFields);
    const keywords = strings(input, 'keywords');
    if (!keywords.length) fail('A topic requires keywords');
    const watch_target_ids = (await targets(ctx, input)).map(row => row.id);
    return create(ctx, 'topic', { name: text(input, 'name', 160), keywords, watch_target_ids,
      ...selected(input, ['market_id']), language: optional(input, 'language', language) ?? null });
  }),
  compute_topic_trend: command(writers, async (ctx, input) => {
    object(input, ['topic_id', 'period', 'comparison_period', 'metric']);
    const topic = await get(ctx, 'topic', text(input, 'topic_id'));
    const current = period(input.period);
    const baseline = period(input.comparison_period, 'comparison_period');
    if (baseline.to > current.from) fail('Comparison period must end before the observation period');
    const metric = choice(input, 'metric', countChangeMetrics);
    const key = hash([topic.id, current, baseline, metric, 'paired_snapshots_v2']);
    const previous = await ctx.get('intel', 'topic_trend_point', key);
    if (previous) {
      await requireReadable(ctx, await Promise.all(previous.data.evidence_observation_ids.map((id: string) => get(ctx, 'observation', id))));
      return previous;
    }
    const before = new Map<string, Entity>();
    const after = new Map<string, Entity>();
    for (const row of await list(ctx, 'observation')) {
      if (!readable(ctx, row) || !topic.data.watch_target_ids.includes(row.data.watch_target_id) || !valueAvailable(row.data.metrics?.[metric])) continue;
      if (topic.data.market_id) {
        const watch = await get(ctx, 'watch_target', row.data.watch_target_id);
        if (!watch.data.market_ids.includes(topic.data.market_id)) continue;
      }
      if (topic.data.language && row.data.attributes?.language !== topic.data.language) continue;
      const content = [row.data.attributes?.title, row.data.attributes?.description, row.data.note].filter(Boolean).join('\n').toLocaleLowerCase();
      if (!topic.data.keywords.some((word: string) => content.includes(word.toLocaleLowerCase()))) continue;
      const at = row.data.observed_at;
      const window = windowContains(at, baseline) ? before : windowContains(at, current) ? after : undefined;
      const sampleKey = JSON.stringify([subjectKey(row), row.data.source?.data_source_id ?? null]);
      const prior = window?.get(sampleKey);
      if (window && (!prior || prior.data.observed_at < at || (prior.data.observed_at === at && prior.id < row.id))) window.set(sampleKey, row);
    }
    const evidence: Entity[] = [];
    let observedSize = 0, observedIncrement = 0;
    let estimatedSize = 0, estimatedIncrement = 0;
    for (const [key, newest] of after) {
      const oldest = before.get(key);
      if (!oldest) continue;
      const a = oldest.data.metrics[metric], b = newest.data.metrics[metric];
      if (a.availability !== b.availability || b.value < a.value) continue;
      evidence.push(oldest, newest);
      const delta = b.value - a.value;
      if (b.availability === 'estimated') { estimatedSize++; estimatedIncrement += delta; }
      else { observedSize++; observedIncrement += delta; }
    }
    await requireReadable(ctx, evidence);
    const sampleSize = observedSize + estimatedSize;
    const row = await ctx.insert('intel', 'topic_trend_point', { topic_id: topic.id, period: current, comparison_period: baseline,
      metric, sample_size: sampleSize, observed_sample_size: observedSize, observed_increment: observedSize ? observedIncrement : null,
      estimated_sample_size: estimatedSize, estimated_increment: estimatedSize ? estimatedIncrement : null, method_version: 'paired_snapshots_v2',
      estimate: estimatedSize > 0, evidence_observation_ids: evidence.map(row => row.id),
      signal_type: 'discussion', as_of: ctx.now }, key);
    await ctx.emit('intel.topic_trend.computed', { id: row.id, topic_id: topic.id, sample_size: sampleSize });
    return row;
  }),
  create_alert_rule: command(writers, async (ctx, input) => {
    object(input, alertFields);
    const patch = await alertPatch(ctx, input);
    if (!patch.watch_target_ids || !patch.condition) fail('Targets and a condition are required');
    return create(ctx, 'alert_rule', { min_freshness: 86400, recipients: [], ...patch, name: text(input, 'name', 160), status: 'active' });
  }),
  update_alert_rule: command(writers, async (ctx, input) => {
    object(input, ['id', 'expected_version', ...alertFields, 'status']);
    const row = await get(ctx, 'alert_rule', text(input, 'id'));
    const patch: Fields = await alertPatch(ctx, input);
    if (input.status !== undefined) patch.status = choice(input, 'status', ['active', 'paused']);
    if (!Object.keys(patch).length) fail('No alert rule changes supplied');
    return update(ctx, 'alert_rule', row, patch, input);
  }),
  evaluate_alert_rule: command(writers, async (ctx, input) => {
    object(input, ['rule_id']);
    const rule = await get(ctx, 'alert_rule', text(input, 'rule_id'));
    active(rule);
    const [observations, gaps, issues] = await Promise.all([list(ctx, 'observation'), ctx.list('ingest', 'data_gap'), ctx.list('ingest', 'quality_issue')]);
    const items: Entity[] = [];
    for (const id of rule.data.watch_target_ids) {
      const target = await get(ctx, 'watch_target', id);
      if (target.data.status !== 'active') continue;
      const stale = await staleDetails(ctx, target, rule, gaps, issues);
      if (stale) {
        items.push(await saveAlert(ctx, rule, target, hash([rule.id, rule.version, id, 'source_stale', stale]),
          { alert_type: 'source_stale', evidence_observation_ids: [], freshness: stale, evaluated_at: ctx.now }));
        continue;
      }
      const rows = observations.filter(row => row.data.watch_target_id === id && readable(ctx, row))
        .sort((a, b) => a.data.observed_at.localeCompare(b.data.observed_at) || a.id.localeCompare(b.id));
      const previous = new Map<string, Entity>();
      for (const row of rows) {
        const key = subjectKey(row);
        const before = previous.get(key);
        previous.set(key, row);
        const age = (Date.parse(ctx.now) - Date.parse(row.data.observed_at)) / 1000;
        if (age > rule.data.min_freshness || !matches(rule.data.condition, row, before)) continue;
        const usesPrevious = ['engagement_increase', 'price_change'].includes(rule.data.condition.type);
        const evidence = usesPrevious && before ? [before, row] : [row];
        await requireReadable(ctx, evidence);
        const keyPart = ['new_post', 'keyword_match'].includes(rule.data.condition.type) ? key : row.data.observed_at;
        const fingerprint = hash([rule.id, rule.version, id, rule.data.condition.type, key, keyPart]);
        items.push(await saveAlert(ctx, rule, target, fingerprint, { alert_type: 'signal', evidence_observation_ids: evidence.map(obs => obs.id),
          freshness: { observation_age_s: age }, evaluated_at: ctx.now }));
      }
    }
    return { items: [...new Map(items.map(item => [item.id, item])).values()] };
  }),
  update_alert: command(writers, async (ctx, input) => {
    object(input, ['id', 'expected_version', 'status', 'assignee', 'reason']);
    const row = await get(ctx, 'alert', text(input, 'id'));
    const status = choice(input, 'status', ['acknowledged', 'assigned', 'resolved', 'dismissed']);
    const allowed: Record<string, string> = { open: 'acknowledged', acknowledged: 'assigned', assigned: 'resolved' };
    if (row.data.status === 'dismissed' || (status !== 'dismissed' && allowed[row.data.status] !== status)) conflict('Invalid alert transition');
    const assignee = optional(input, 'assignee', text);
    const reason = optional(input, 'reason', text);
    if ((status === 'assigned') !== Boolean(assignee)) fail('Assignment requires an assignee');
    if (status === 'dismissed' && !reason) fail('Dismissal requires a reason');
    return update(ctx, 'alert', row, { status, ...(assignee ? { assignee } : {}), ...(reason ? { reason } : {}) }, input, 'alert.transitioned');
  }),
  generate_research_digest: command(writers, async (ctx, input) => {
    object(input, ['title', 'period', 'fact_item_ids', 'recommendation_item_ids']);
    const title = text(input, 'title', 160);
    const window = period(input.period);
    const fact_item_ids = strings(input, 'fact_item_ids', 50);
    const recommendation_item_ids = strings(input, 'recommendation_item_ids', 50);
    if ((!fact_item_ids.length && !recommendation_item_ids.length) || fact_item_ids.some(id => recommendation_item_ids.includes(id))) {
      fail('Select distinct fact and recommendation items');
    }
    const rows = await evidence(ctx, [...fact_item_ids, ...recommendation_item_ids], 'export');
    await requireReadable(ctx, rows, 'team_share');
    const items = new Map(rows.filter(row => row.kind === 'research_item').map(row => [row.id, row]));
    const snapshot = (ids: string[]) => ids.map(id => {
      const item = items.get(id)!;
      return { item_id: id, version: item.version, stance: item.data.stance, title: item.data.title ?? null, body: item.data.body ?? null };
    });
    if (fact_item_ids.some(id => !isEvidence(items.get(id)!))) fail('Facts must be supported evidence items');
    return create(ctx, 'research_digest', { title, period: window, sections: { facts: snapshot(fact_item_ids), recommendations: snapshot(recommendation_item_ids) },
      evidence_refs: rows.map(row => ({ kind: row.kind, id: row.id })), status: 'ready' }, 'research_digest.generated');
  }),
  record_mention: command(writers, async (ctx, input) => {
    object(input, mentionFields);
    const target = await get(ctx, 'watch_target', text(input, 'watch_target_id'));
    enforceRecorder(ctx, target.data);
    if (['official_api', 'vendor'].includes(target.data.data_mode)) blocked('This workspace accepts manual and imported mentions');
    if (input.access !== 'public') blocked('Only public mentions can be recorded in this workflow');
    const { ingest: _ingest, access: _access, ...snapshot } = await provenance(ctx, input, target, 'mention');
    const text_excerpt = text(input, 'text_excerpt', 500);
    if (/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:\+?\d[ .()-]*){8,}\d/.test(text_excerpt)) fail('Omit contact details from the public excerpt');
    return create(ctx, 'mention', { ...snapshot, platform: target.data.platform ?? null, watch_target_id: target.id,
      ...selected(input, ['author_ref']), text_excerpt, latest_label_ids: {}, escalation_id: null }, 'mention.recorded');
  }),
  label_mention: command(writers, async (ctx, input) => {
    object(input, ['mention_id', 'expected_version', 'label_type', 'value', 'confidence']);
    const mention = await get(ctx, 'mention', text(input, 'mention_id'));
    assertVersion(mention, input);
    await requireReadable(ctx, [mention]);
    const label_type = choice(input, 'label_type', ['sentiment', 'intent', 'topic']);
    const value = label_type === 'topic' ? text(input, 'value', 120) : choice(input, 'value', labelValues[label_type]);
    const confidence = optional(input, 'confidence', (fields, key) => number(fields, key, 0, 1));
    const label = await create(ctx, 'mention_label', { mention_id: mention.id, label_type, value, confidence: confidence ?? null,
      labeled_by: 'human', labeled_by_id: ctx.actorId, overrides_label_id: mention.data.latest_label_ids[label_type] ?? null });
    await update(ctx, 'mention', mention, { latest_label_ids: { ...mention.data.latest_label_ids, [label_type]: label.id } }, input, 'mention.labeled');
    return label;
  }),
  escalate_mention: command(writers, async (ctx, input) => {
    object(input, ['id', 'expected_version', 'destination', 'target_id', 'summary']);
    const mention = await get(ctx, 'mention', text(input, 'id'));
    assertVersion(mention, input);
    if (mention.data.escalation_id) conflict('Mention already has an escalation');
    await requireReadable(ctx, [mention], 'team_share');
    const [target_module, target_kind] = choice(input, 'destination', ['inbox.case', 'workspace.work_item']).split('.');
    const target_id = optional(input, 'target_id', text);
    if (target_id) await required(ctx, target_module, target_kind, target_id);
    const handoff = await create(ctx, 'research_handoff', { mention_id: mention.id, target_module, target_kind, target_id: target_id ?? null,
      summary: text(input, 'summary'), status: target_id ? 'linked' : 'pending' });
    await update(ctx, 'mention', mention, { escalation_id: handoff.id }, input, 'mention.escalated',
      { mention_id: mention.id, handoff_id: handoff.id, target_module, target_kind, target_id: target_id ?? null });
    return handoff;
  }),
  compute_share_of_voice: command(writers, async (ctx, input) => {
    const sample = await signalCommands.query_mentions.run(ctx, input) as {
      query_def: Fields; query_def_hash: string; period: { from: string; to: string }; sample_size: number;
      sources: string[]; counts: { watch_target_id: string; count: number }[]; items: { id: string }[];
    };
    const counts = await Promise.all(sample.counts.map(async entry => {
      const watch = await get(ctx, 'watch_target', entry.watch_target_id);
      return { scope_id: watch.data.brand_id ?? watch.id, scope_kind: watch.data.brand_id ? 'brand' : 'watch_target', count: entry.count };
    }));
    const groups = new Map<string, typeof counts[number]>();
    for (const entry of counts) {
      const key = JSON.stringify([entry.scope_kind, entry.scope_id]);
      groups.set(key, { ...entry, count: (groups.get(key)?.count ?? 0) + entry.count });
    }
    const brand_counts = [...groups.values()].map(entry => ({ ...entry, share: sample.sample_size ? entry.count / sample.sample_size : null }));
    return create(ctx, 'share_of_voice_snapshot', { query_def: sample.query_def, query_def_hash: sample.query_def_hash, sources: sample.sources, period: sample.period,
      sample_size: sample.sample_size, brand_counts, evidence_mention_ids: sample.items.map(item => item.id),
      coverage_note: 'Shares describe matching watch-target and mention pairs within this query and source sample.', as_of: ctx.now }, 'share_of_voice.computed');
  }),
  query_mentions: command(readers, async (ctx, input) => {
    object(input, ['watch_target_ids', 'period', 'keyword']);
    const watch = await targets(ctx, input);
    const window = period(input.period);
    const keyword = optional(input, 'keyword', text)?.toLocaleLowerCase();
    const ids = watch.map(target => target.id).sort();
    const rows = (await list(ctx, 'mention')).filter(row => ids.includes(row.data.watch_target_id) && readable(ctx, row) &&
      windowContains(row.data.published_at ?? row.data.observed_at, window) && (!keyword || row.data.text_excerpt.toLocaleLowerCase().includes(keyword)));
    await requireReadable(ctx, rows);
    const unique = new Map<string, Entity>();
    for (const row of rows.sort((a, b) => a.data.observed_at.localeCompare(b.data.observed_at))) unique.set(subjectKey(row), row);
    const sample = [...unique.values()];
    const counts = watch.map(target => ({ watch_target_id: target.id, count: sample.filter(row => row.data.watch_target_id === target.id).length,
      coverage_note: target.data.coverage_note }));
    const query_def = { watch_target_ids: ids, period: window, keyword: keyword ?? null,
      watch_queries: watch.map(target => ({ id: target.id, version: target.version, query: target.data.query })).sort((a, b) => a.id.localeCompare(b.id)) };
    return { query_def, query_def_hash: hash(query_def), period: window, sample_size: sample.length, counts,
      sources: [...new Set(rows.map(row => row.data.source?.data_source_id ?? row.data.source?.method))],
      coverage_note: 'Counts reflect distinct observed mentions per watch target in the selected sample.',
      items: sample.map(row => ({ id: row.id, watch_target_id: row.data.watch_target_id, url: row.data.url, observed_at: row.data.observed_at,
        latest_label_ids: row.data.latest_label_ids, source: row.data.source, untrusted_content: row.data.text_excerpt })) };
  }),
};
