import { generateCommandReport } from './report-workflows.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Commands } from '../types.js';
import { testWorkspace } from '../ingest/test-context.js';
import { commands } from './commands.js';

const range = { from: '2026-10-01', to: '2026-10-03', tz: 'UTC' };
const seed: Commands = { put: { roles: ['owner'], async run(ctx, input) {
  return ctx.insert(input.module, input.kind, input.data, input.id);
} } };
const metricQuery = (metrics: string[]) => ({ metrics, subject: { type: 'platform_post' }, time: { ...range, basis: 'period' } });
const dayPoint = (metric_key: string, subject_id: string, value: number | null, options = {}) => ({ metric_key, subject_id, subject_type: 'platform_post', platform: 'youtube', date: '2026-10-01',
  value, availability: value === null ? 'no_permission' : 'observed', source: { method: 'manual' }, ...options });

test('currency queries freeze exact dated rates and report generations preserve older evidence', async () => {
  const ws = testWorkspace();
  const run = (action: string, input: Record<string, unknown>) => ws.run(commands, action, input);
  await run('record_observations', { observations: [dayPoint('spend', 'post-a', 101, { currency: 'JPY' })] });
  const query = { ...metricQuery(['spend']), report_currency: 'USD' };
  const missing = await run('metrics_query', query);
  assert.equal(missing.rows[0].values.spend.value, null);
  assert.deepEqual(missing.rows[0].values.spend.original_minor, { JPY: 101 });
  assert.ok(missing.warnings.includes('MISSING_FX_RATE'));
  const fx = await run('set_fx_rate', { from_currency: 'JPY', to_currency: 'USD', date: '2026-10-01', rate: '0.00655' });
  const report = await run('reports_create', { title: 'Campaign costs', kind: 'campaign', period: range, sections: [{ key: 'spend', type: 'table', query }] });
  const draft = await ws.run({ generate: { roles: ['owner'], run: generateCommandReport } }, 'generate', { report_id: report.id });
  assert.equal(draft.data.results.spend.rows[0].values.spend.value, 66);
  assert.ok(draft.data.evidence.spend.some((record: { id: string }) => record.id === fx.id));
  const edit = (refs: string[]) => run('reports_update_narrative', { version_id: draft.id, expected_version: draft.version, narrative: [{ section_key: 'spend', blocks: [{ kind: 'fact', text: 'Costs were measured.', refs }] }] });
  await assert.rejects(edit(['unknown']), { code: 'invalid_input' });
  const narrated = await edit(['section:spend']);
  const final = await run('reports_finalize', { version_id: draft.id, expected_version: narrated.version });
  await run('set_fx_rate', { from_currency: 'JPY', to_currency: 'USD', date: '2026-10-01', rate: '0.01000' });
  const refreshed = await ws.run({ generate: { roles: ['owner'], run: generateCommandReport } }, 'generate', { report_id: report.id });
  assert.equal(refreshed.data.results.spend.rows[0].values.spend.value, 101);
  await run('reports_finalize', { version_id: refreshed.id, expected_version: refreshed.version });
  const older = await run('reports_get', { version_id: final.id });
  assert.equal(older.data.status, 'superseded');
  assert.deepEqual(older.data.results, final.data.results);
  const csv = await run('reports_export', { version_id: older.id, format: 'csv' });
  const pdf = await run('reports_export', { version_id: older.id, format: 'pdf' });
  assert.match(csv.content, /"66"/);
  assert.match(Buffer.from(pdf.content, 'base64').toString('ascii'), /^%PDF-1\.4/);
});

test('cumulative age, daily corrections and weighted ratios preserve source distinctions', async () => {
  const ws = testWorkspace();
  const run = (action: string, input: Record<string, unknown>) => ws.run(commands, action, input);
  const cumulative = (time: string, value: number) => ({ ...dayPoint('yt.video.views', 'a', value), date: undefined, observed_at: time, published_at: '2026-10-01T00:00:00Z' });
  await run('record_observations', { observations: [cumulative('2026-10-01T22:00:00Z', 100), cumulative('2026-10-02T02:00:00Z', 140), cumulative('2026-10-02T04:00:00Z', 130),
    dayPoint('norm.post.engagements', 'a', 1), dayPoint('norm.post.impressions', 'a', 10), dayPoint('norm.post.engagements', 'b', 90), dayPoint('norm.post.impressions', 'b', 100),
    dayPoint('views', 'a', 10), dayPoint('views', 'b', 5, { platform: 'instagram' }), dayPoint('views', 'c', null)] });
  const age = await run('metrics_query', { ...metricQuery(['yt.video.views']), age_bucket: '24h', include_estimates: true });
  assert.equal(age.rows[0].values['yt.video.views'].value, 120);
  assert.equal(age.evidence[0].method, 'interpolated');
  const daily = await run('metrics_query', { ...metricQuery(['yt.video.views']), granularity: 'day', include_estimates: true });
  assert.equal(daily.rows[0].values['yt.video.views'].value, 20);
  assert.equal(daily.rows[1].values['yt.video.views'].availability, 'sync_failed');
  const rollup = await run('metrics_query', metricQuery(['norm.post.engagement_rate']));
  assert.equal(rollup.rows[0].values['norm.post.engagement_rate'].value, 91 / 110);
  const platform = await run('metrics_query', metricQuery(['views']));
  assert.deepEqual(platform.rows.map((row: { group: { platform: string } }) => row.group.platform), ['instagram', 'youtube']);
  assert.ok(platform.warnings.includes('LOW_COVERAGE'));
});

test('independent attribution models use commerce refunds and reverse a full refund', async () => {
  const ws = testWorkspace();
  const toCommerce = (kind: string, id: string, data: Record<string, unknown>) => ws.run(seed, 'put', { module: 'commerce', kind, id, data });
  await toCommerce('order', 'order-1', { store_id: 's', placed_at: '2026-10-02T12:00:00Z', currency: 'USD', total_minor: 1001, financial_status: 'paid' });
  for (const [subject, evidence_kind] of [['campaign-a', 'link_session'], ['campaign-a', 'touchpoint'], ['campaign-b', 'touchpoint']]) {
    await ws.run(commands, 'record_attribution_evidence', { order_id: 'order-1', subject_type: 'campaign', subject_id: subject, source_ref: `${subject}:${evidence_kind}`, evidence_kind, occurred_at: '2026-10-01T00:00:00Z' });
  }
  await toCommerce('refund', 'refund-1', { order_id: 'order-1', created_at: '2026-10-04T00:00:00Z', currency: 'USD', amount_minor: 200, status: 'succeeded' });
  await toCommerce('refund', 'pending-1', { order_id: 'order-1', created_at: '2026-10-05T00:00:00Z', currency: 'USD', amount_minor: 300, status: 'pending' });
  const query = { period: range, model_keys: ['link_session', 'linear'] };
  const result = await ws.run(commands, 'attribution_run', query);
  assert.equal(result.records.find((r: any) => r.data.model_key === 'link_session').data.net_of_refunds_minor, 801);
  assert.deepEqual(result.records.filter((r: any) => r.data.model_key === 'linear').map((r: any) => r.data.net_of_refunds_minor).sort(), [400, 401]);
  assert.equal(ws.list('analytics', 'attribution_touch').length, 3);
  await toCommerce('refund', 'refund-2', { order_id: 'order-1', created_at: '2026-10-06T00:00:00Z', currency: 'USD', amount_minor: 801, status: 'succeeded' });
  await ws.run(commands, 'attribution_run', query);
  assert.ok(ws.list('analytics', 'attribution_record').every(row => row.data.status === 'reversed'));
  const explained = await ws.run(commands, 'attribution_explain', { order_id: 'order-1' });
  assert.equal(explained.rows[0].order_net_minor, 0);
  assert.ok(explained.rows[0].evidence.some((record: { id: string }) => record.id === 'refund-2'));
  await assert.rejects(ws.run(commands, 'attribution_explain', { order_id: 'order-1' }, { role: 'viewer' }), { code: 'forbidden' });
});

test('ingest source permissions apply separately to display and frozen report exports', async () => {
  const ws = testWorkspace();
  await ws.run(seed, 'put', { module: 'ingest', kind: 'data_source', id: 'display-only', data: { status: 'active', allowed_uses: { display: true, export: false } } });
  await ws.run(seed, 'put', { module: 'ingest', kind: 'data_source', id: 'disabled', data: { status: 'disabled', allowed_uses: { display: true, export: true } } });
  const input = metricQuery(['views']);
  await ws.run(commands, 'record_observations', { observations: [dayPoint('views', 'shown', 3, { data_source_id: 'display-only' }), dayPoint('views', 'hidden', 500, { data_source_id: 'disabled' })] });
  const report = await ws.run(commands, 'reports_create', { title: 'Source policy', kind: 'social_performance', period: range, sections: [{ key: 'views', type: 'table', query: input }] });
  const draft = await ws.run({ generate: { roles: ['owner'], run: generateCommandReport } }, 'generate', { report_id: report.id });
  assert.equal(draft.data.results.views.rows[0].values.views.value, 3);
  assert.ok(draft.data.results.views.warnings.includes('SOURCE_USE_RESTRICTED'));
  await ws.run(commands, 'reports_finalize', { version_id: draft.id, expected_version: draft.version });
  await assert.rejects(ws.run(commands, 'reports_export', { version_id: draft.id, format: 'csv' }), { code: 'egress_blocked' });
});

test('experiment design stays frozen through stopping and conclusion', async () => {
  const ws = testWorkspace();
  const draft = await ws.run(commands, 'experiments_create', { type: 'content', hypothesis: 'A shorter introduction improves views', primary_metric: 'views', success_criteria: 'At least 10% more qualified views',
    period: { from: '2026-10-01', to: '2026-12-01' }, variants: ['control', 'treatment'].map(ref_id => ({ ref_type: 'content_variant', ref_id, allocation_bps: 5000 })) });
  const transition = (row: { id: string; version: number }, action: string, fields = {}) => ws.run(commands, 'experiments_transition', { experiment_id: row.id, expected_version: row.version, action, ...fields });
  const running = await transition(draft, 'start');
  await assert.rejects(transition(running, 'conclude'), { code: 'invalid_state' });
  const stopped = await transition(running, 'stop', { reason: 'Traffic allocation changed' });
  const outcome = await transition(stopped, 'conclude', { decision: 'inconclusive', primary_metric: 'likes', limitations: 'The treatment group was undersampled.',
    results: [{ ref_id: 'control', value: 11, sample_size: 23, source_ref: 'manual-a' }, { ref_id: 'treatment', value: null, sample_size: 0, source_ref: 'manual-b' }] });
  assert.equal(outcome.data.primary_metric, 'views');
  assert.equal(outcome.data.status, 'concluded');
  assert.equal(ws.list('analytics', 'experiment_result_snapshot')[0]?.data.definition_revision, 1);
});
