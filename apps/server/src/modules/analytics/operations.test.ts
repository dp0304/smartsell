import { generateReport } from './reports.js';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { operations } from './index.js';
import { evidenceOperations, purgeExpiredIngestData, recordMetricEvidence } from '../ingest/evidence.ts';
import { retentionOperations } from '../ops/retention.ts';

const from = '2025-01-01T00:00:00Z';
const to = '2025-01-06T00:00:00Z';
function fixture() {
  const rows = new Map<string, Row[]>();
  let sequence = 0;
  const ctx: Context = {
    workspaceId: 'workspace', tenantId: 'tenant', actorId: 'analyst', role: 'owner', now: '2025-01-06T00:00:00Z',
    list: kind => (rows.get(kind) ?? []).map(row => structuredClone(row)),
    get(kind, id) {
      const row = ctx.list(kind).find(row => row.id === id);
      if (!row) throw new Problem(404, 'missing', 'Missing row');
      return row;
    },
    create(kind, values) {
      const row = { ...structuredClone(values), id: `id${++sequence}`, version: 1, created_at: ctx.now, updated_at: ctx.now };
      rows.set(kind, [...ctx.list(kind), row]);
      return structuredClone(row);
    },
    update(kind, id, values) {
      const row = ctx.get(kind, id);
      const result = { ...row, ...structuredClone(values), version: row.version + 1, updated_at: ctx.now };
      rows.set(kind, ctx.list(kind).map(row => row.id === id ? result : row));
      return structuredClone(result);
    },
    remove(kind, id) { rows.set(kind, ctx.list(kind).filter(row => row.id !== id)); },
    emit() {},
  };
  const run = (name: string, body: Data = {}, id?: string, query: Record<string, string> = {}) => {
    const operation = operations.find(op => op.name === name)!;
    assert(operation.roles.includes(ctx.role));
    return operation.run(ctx, { body, params: id ? { id } : {}, query }) as any;
  };
  return { ctx, run, generate: (id: string) => generateReport(ctx, id, {}) as any };
}
function metricQuery(id?: string) {
  return { metrics: ['views'], subject: { type: 'platform_post', filter: id ? { subject_ids: [id] } : {} }, time: { from, to } };
}
function dayObservation(id: string, value: number | null, availability: string, observed_at = '2025-01-05T00:00:00Z') {
  return { metric_key: 'views', subject_type: 'platform_post', subject_id: id, period_kind: 'day', period_start: '2025-01-04T00:00:00Z',
    period_end: '2025-01-05T00:00:00Z', observed_at, value, availability, source: { method: 'import', batch_id: 'source', buyer_email: 'drop-me' } };
}
test('operations have unique workspace routes and stable names', () => {
  assert.equal(new Set(operations.map(op => `${op.method} ${op.path}`)).size, operations.length);
  assert.equal(new Set(operations.map(op => op.name)).size, operations.length);
  const pinnedExportRoutes = ['/reports/:id/versions/:n/export', '/reports/:id/versions/:n/exports'];
  assert.deepEqual(operations.filter(op => op.path.includes(':n')).map(op => op.path), pinnedExportRoutes);
  for (const op of operations) {
    assert(op.path.startsWith('/'));
    const params = [...op.path.matchAll(/:(\w+)/g)].map(match => match[1]);
    assert.deepEqual(params, pinnedExportRoutes.includes(op.path) ? ['id', 'n'] : params.length ? ['id'] : []);
  }
  assert.equal(operations.find(op => op.name === 'reports_update_narrative')?.versionKind, 'report_version');
});
test('AN07 cohorts use the contiguous native sync history through the requested end', () => {
  const { ctx, run } = fixture();
  ctx.now = '2025-12-01T00:00:00Z';
  const store = ctx.create('store', { provider: 'shopify' });
  const source = ctx.create('data_source', { store_id: store.id });
  const unrelated = ctx.create('data_source', { store_id: 'different-store' });
  const segment = (from: string, to: string, status = 'complete', sourceId = source.id) =>
    ctx.create('coverage_segment', { data_source_id: sourceId, resource: 'orders', from, to, status });
  segment('2025-01-01', '2025-05-01');
  segment('2025-05-01', '2025-06-01', 'failed');
  segment('2025-06-01', '2025-07-01', 'failed');
  segment('2025-06-01', '2025-07-01');
  segment('2025-07-01', '2025-10-01');
  segment('2025-05-01', '2025-11-01', 'complete', unrelated.id);
  for (const [date, expected] of [['2025-07-15', 'low'], ['2025-09-15', 'high']] as const) {
    const buyer = ctx.create('store_customer', { store_id: store.id, identity_verified: true });
    ctx.create('order', { store_id: store.id, total_minor: 100, placed_at: date, financial_status: 'paid',
      store_customer_id: buyer.id, customer_order_index: 1 });
    const [result] = run('cohorts_list', {}, undefined, { from: date, to: '2025-10-01' });
    assert.equal(result.history_coverage_from, '2025-06-01T00:00:00.000Z');
    assert.deepEqual(result.rows.map((row: any) => row.new_customer_reliability), [expected]);
  }
  const [unknown] = run('cohorts_list', {}, undefined, { from: '2025-09-15', to: '2025-11-01' });
  assert.equal(unknown.history_coverage_from, null);
  assert.deepEqual(unknown.rows.map((row: any) => [row.confirmed_new, row.limitations]), [[0, ['HISTORY_START_UNKNOWN']]]);
});

test('AN07 a longer requested history window lowers confidence for the same first order', () => {
  const { ctx, run } = fixture();
  ctx.now = '2025-12-01T00:00:00Z';
  const store = ctx.create('store', { provider: 'shopify', history_coverage_from: '2025-06-01' });
  const buyer = ctx.create('store_customer', { store_id: store.id, identity_verified: true });
  ctx.create('order', { store_id: store.id, total_minor: 100, placed_at: '2025-09-15', financial_status: 'paid',
    store_customer_id: buyer.id, customer_order_index: 1 });
  const query = { from: '2025-09-01', to: '2025-10-01' };
  const [normal] = run('cohorts_list', {}, undefined, query);
  assert.equal(normal.rows[0].confirmed_new, 1);
  const [strict] = run('cohorts_list', {}, undefined, { ...query, history_months: '6' });
  assert.equal(strict.history_months, 6);
  assert.equal(strict.rows[0].confirmed_new, 0);
  assert.equal(strict.rows[0].new_customer_reliability, 'low');
  assert.deepEqual(strict.rows[0].limitations, ['INSUFFICIENT_ORDER_HISTORY']);
});

test('metrics preserve explicit zero, unknown, and source whitelisting', () => {
  const { ctx, run } = fixture();
  ctx.now = from;
  const zero = ctx.create('platform_post', { platform: 'youtube', published_at: from });
  const missing = ctx.create('platform_post', { platform: 'youtube', published_at: from });
  ctx.now = to;
  const observations = [dayObservation(zero.id, 0, 'observed'), dayObservation(missing.id, null, 'no_permission')];
  assert.equal(run('analytics_record_observations', { observations }).inserted_count, 2);
  assert.equal(run('analytics_record_observations', { observations }).inserted_count, 0);
  assert.equal(run('metrics_query', metricQuery(zero.id)).rows[0].values.views.value, 0);
  const result = run('metrics_query', metricQuery(missing.id));
  assert.equal(result.rows[0].values.views.value, null);
  assert.equal(result.rows[0].values.views.availability, 'no_permission');
  assert(result.warnings.includes('LOW_COVERAGE'));
  assert(!JSON.stringify(result).includes('drop-me'));
  assert.throws(() => run('analytics_record_observations', { observations: [dayObservation(missing.id, 0, 'no_permission')] }), Problem);
});
test('DS07 frozen metric value traces to its exact run and raw evidence until purge', () => {
  const { ctx, run, generate } = fixture();
  ctx.now = from;
  const account = ctx.create('social_account', { provider: 'youtube' });
  const post = ctx.create('platform_post', { platform: 'youtube', social_account_id: account.id, published_at: from });
  const source = ctx.create('data_source', { name: 'YouTube evidence fixture', provider: 'youtube', kind: 'social_account', social_account_id: account.id,
    method: 'official_api', resources: ['post_metrics'], status: 'active', allowed_uses: { display: true, cache_days: 2 } });
  const sync = ctx.create('sync_run', { data_source_id: source.id, resource: 'post_metrics', status: 'succeeded', mapping_version: 3 });
  ctx.now = to;
  const observation = recordMetricEvidence(ctx, { sourceId: source.id, runId: sync.id, resource: 'post_metrics', externalId: 'post-fixture',
    payload: { views: 0, email: 'private@example.invalid' }, observation: dayObservation(post.id, 0, 'observed') });
  const definition = run('reports_create', { title: 'DS07 provenance', period: { from, to }, sections: [{ key: 'views', type: 'chart', query: metricQuery(post.id) }] });
  const draft = generate(definition.id);
  const saved = run('reports_finalize', {}, draft.id);
  assert.deepEqual(saved.results[0].data.rows[0].values.views.refs, [observation.id]);
  const provenance = () => run('report_provenance_get', {}, saved.id, { observation_id: observation.id });
  assert.throws(() => run('report_provenance_get', {}, saved.id, { observation_id: 'not-in-snapshot' }), { status: 404 });
  const { data_source_id, sync_run_id, mapping_version, raw_evidence } = provenance();
  assert.deepEqual([data_source_id, sync_run_id, mapping_version, raw_evidence.status], [source.id, sync.id, 3, 'available']);
  const rawGet = evidenceOperations.find(op => op.name === 'raw_record_get')!;
  const rawInput = { params: { id: raw_evidence.raw_record_id }, query: {}, body: {} };
  assert.deepEqual((rawGet.run(ctx, rawInput) as Row).payload, { views: 0 });
  ctx.role = 'viewer';
  assert.deepEqual(provenance().raw_evidence, { status: 'restricted' });
  assert.equal(rawGet.roles.includes(ctx.role), false);
  ctx.role = 'owner';
  ctx.update('data_source', source.id, { allowed_uses: { display: false, cache_days: 2 } });
  assert.throws(provenance, { status: 403 });
  ctx.update('data_source', source.id, { allowed_uses: { display: true, cache_days: 2 } });
  ctx.now = '2025-01-08T00:00:01Z';
  assert.deepEqual(provenance().raw_evidence, { status: 'expired' });
  assert.throws(() => rawGet.run(ctx, rawInput), { status: 410 });
  assert.deepEqual(purgeExpiredIngestData(ctx), { raw_records_removed: 1 });
  assert.deepEqual(provenance().raw_evidence, { status: 'deleted', deleted_at: ctx.now });
  assert.throws(() => rawGet.run(ctx, rawInput), { status: 404 });
  assert.equal(ctx.list('raw_record_tombstone').length, 1);
  assert(!JSON.stringify(ctx.list('raw_record_tombstone')).includes('post-fixture'));
  assert.deepEqual(run('reports_get', {}, saved.id), saved);
});

test('DS07 freezes the imported metric row and mapping without copying raw contents into the version', () => {
  const { ctx, run, generate } = fixture();
  ctx.now = from;
  const post = ctx.create('platform_post', { platform: 'youtube', published_at: from });
  ctx.now = to;
  const batch = ctx.create('import_batch', { template_key: 'post_metrics', status: 'merged', mapping_version: 2, expires_at: '2025-01-07T00:00:00Z' });
  const { ids: [observationId] } = run('analytics_record_observations', { observations: [{ ...dayObservation(post.id, 12, 'observed'),
    source: { method: 'report_import', batch_id: batch.id } }] });
  const imported = ctx.create('import_row', { batch_id: batch.id, row_no: 3, status: 'merged',
    target_ref: { module: 'analytics', resource_type: 'metric_observation', resource_id: observationId }, raw: { views: 12, marker: 'original import' } });
  const definition = run('reports_create', { title: 'Imported metric', kind: 'custom', period: { from, to },
    sections: [{ key: 'views', type: 'table', query: metricQuery(post.id) }] });
  const version = generate(definition.id);
  const provenance = () => run('report_provenance_get', {}, version.id, { observation_id: observationId });
  assert.equal(version.results[0].data.rows[0].values.views.value, 12);
  assert(!JSON.stringify(ctx.get('report_version', version.id)).includes('original import'));
  ctx.update('import_batch', batch.id, { mapping_version: 9 });
  ctx.update('import_row', imported.id, { row_no: 14 });
  assert.deepEqual(provenance().raw_evidence.payload, { views: 12, marker: 'original import' });
  assert.deepEqual([provenance().import_batch_id, provenance().source_row, provenance().mapping_version], [batch.id, 3, 2]);
  ctx.now = '2025-01-07T00:00:00Z';
  purgeExpiredIngestData(ctx);
  assert.equal(ctx.get('import_row', imported.id).raw, null);
  assert.deepEqual(provenance().raw_evidence, { status: 'deleted', deleted_at: ctx.now });
  assert.deepEqual([provenance().import_batch_id, provenance().source_row, provenance().mapping_version], [batch.id, 3, 2]);
});

test('DS07 does not reconstruct an uncaptured or legacy metric link from a later binding', () => {
  const { ctx, run, generate } = fixture();
  ctx.now = from;
  const post = ctx.create('platform_post', { platform: 'youtube', published_at: from });
  ctx.now = to;
  const { ids: [observationId] } = run('analytics_record_observations', { observations: [dayObservation(post.id, 1, 'observed')] });
  const definition = run('reports_create', { title: 'Uncaptured metric', period: { from, to },
    sections: [{ key: 'views', type: 'table', query: metricQuery(post.id) }] });
  const version = generate(definition.id);
  const legacy = ctx.create('report_version', { query_snapshot: version.query_snapshot, results: version.results });
  const source = ctx.create('data_source', { status: 'active', allowed_uses: { display: true } });
  const sync = ctx.create('sync_run', { data_source_id: source.id, status: 'succeeded', mapping_version: 2 });
  ctx.update('metric_observation', observationId, { ingest_evidence: { data_source_id: source.id, sync_run_id: sync.id, mapping_version: 2 } });
  const provenance = (id: string) => run('report_provenance_get', {}, id, { observation_id: observationId });
  const uncaptured = { observation_id: observationId, raw_evidence: { status: 'not_retained' } };
  assert.deepEqual(provenance(version.id), uncaptured);
  assert.deepEqual(provenance(legacy.id), { ...uncaptured, status: 'not_captured' });
  const later = generate(definition.id);
  assert.equal(provenance(later.id).sync_run_id, sync.id);
  assert.deepEqual(provenance(later.id).raw_evidence, { status: 'not_retained' });
});

test('DS07 reports acknowledge approved raw retention runs and do not link numbers without observations', () => {
  const { ctx, run, generate } = fixture();
  ctx.now = from;
  const post = ctx.create('platform_post', { platform: 'youtube', published_at: from });
  const link = ctx.create('short_link', {});
  const click = ctx.create('click_event', { short_link_id: link.id, occurred_at: from, classification: 'human_likely' });
  const source = ctx.create('data_source', { status: 'active', allowed_uses: { display: true } });
  const sync = ctx.create('sync_run', { data_source_id: source.id, status: 'succeeded', mapping_version: 2 });
  const raw = ctx.create('raw_record', { data_source_id: source.id, sync_run_id: sync.id, retention_until: '2025-01-07T00:00:00Z', payload: { views: 7 } });
  ctx.now = to;
  const { ids: [observationId] } = run('analytics_record_observations', { observations: [dayObservation(post.id, 7, 'observed')] });
  ctx.update('metric_observation', observationId, { ingest_evidence: { data_source_id: source.id, sync_run_id: sync.id, raw_record_id: raw.id } });
  const definition = run('reports_create', { title: 'Approved purge', period: { from, to }, sections: [
    { key: 'views', type: 'table', query: metricQuery(post.id) },
    { key: 'clicks', type: 'kpi', query: { metrics: ['link.redirects'], subject: { type: 'short_link' }, time: { from, to } } },
  ] });
  const version = generate(definition.id);
  const metric = version.results[1].data.rows[0].values['link.redirects'];
  assert.equal(metric.value, 1);
  assert.deepEqual(metric.refs, []);
  assert.throws(() => run('report_provenance_get', {}, version.id, { observation_id: click.id }), { status: 404 });
  const provenance = () => run('report_provenance_get', {}, version.id, { observation_id: observationId });
  assert.equal(provenance().raw_evidence.raw_record_id, raw.id);

  ctx.now = '2025-04-08T00:00:00Z';
  const retention = (name: string, body: Data, params: Record<string, string> = {}) =>
    retentionOperations.find(op => op.name === name)!.run(ctx, { body, params, query: {} }) as Row;
  const preview = retention('ops_preview_purge_run', { data_class: 'raw_record' });
  const completed = retention('ops_approve_purge_run', {}, { id: preview.id });
  assert.deepEqual(completed.purged, [raw.id]);
  assert.throws(() => ctx.get('raw_record', raw.id), { status: 404 });
  assert.deepEqual(provenance().raw_evidence, { status: 'deleted', deleted_at: ctx.now });
  assert.equal(provenance().sync_run_id, sync.id);
});

test('DS07 frozen commerce values keep their batch and source row after the real retention purge', () => {
  const { ctx, run, generate } = fixture();
  const batch = ctx.create('import_batch', { template_key: 'order_list', status: 'merged', mapping_version: 2, expires_at: '2025-01-07T00:00:00Z' });
  const order = ctx.create('order', { store_id: 'store', external_order_id: 'order-a', placed_at: from, currency: 'USD',
    financial_status: 'cancelled', total_minor: 900, source: { kind: 'file_import', batch_id: batch.id } });
  const imported = ctx.create('import_row', { batch_id: batch.id, row_no: 2, status: 'merged',
    target_ref: { module: 'commerce', resource_type: 'order', resource_id: order.id }, raw: { external_order_id: 'order-a', total_minor: 900 } });
  const report = run('reports_create', { title: 'Commerce evidence', period: { from, to }, sections: [
    { key: 'sales', source: 'revenue' }, { key: 'credit', source: 'attribution' },
  ] });
  const draft = generate(report.id);
  const saved = run('reports_finalize', {}, draft.id);
  const trace = (section_key: string) => run('report_commerce_provenance_get', {}, saved.id, { section_key }).rows[0].sources[0];
  for (const section of ['sales', 'credit']) {
    assert.deepEqual(trace(section), { fact_id: order.id, kind: 'order', import_batch_id: batch.id, source_row: 2,
      mapping_version: 2, status: 'available', payload: { external_order_id: 'order-a', total_minor: 900 }, retention_until: batch.expires_at });
  }
  ctx.now = '2025-01-07T00:00:00Z';
  for (const section of ['sales', 'credit']) assert.equal(trace(section).status, 'expired');
  purgeExpiredIngestData(ctx);
  assert.equal(ctx.get('import_row', imported.id).raw, null);
  for (const section of ['sales', 'credit']) {
    assert.deepEqual(trace(section), { fact_id: order.id, kind: 'order', import_batch_id: batch.id, source_row: 2,
      mapping_version: 2, status: 'deleted', deleted_at: ctx.now });
  }
  assert.deepEqual(run('reports_get', {}, saved.id), saved);
});

test('finalized reports preserve the original result after backfills and reject narrative changes', () => {
  const { ctx, run, generate } = fixture();
  ctx.now = from;
  const post = ctx.create('platform_post', { platform: 'youtube', published_at: from });
  ctx.now = to;
  run('analytics_record_observations', { observations: [dayObservation(post.id, 0, 'observed')] });
  const definition = run('reports_create', { title: 'Social performance', period: { from, to },
    sections: [{ key: 'views', query: metricQuery(post.id) }] });
  const draft = generate(definition.id);
  assert.throws(() => run('reports_update_narrative', { narrative: [{ section_key: 'views', blocks: [{ kind: 'fact', text: 'Views', refs: ['unknown'] }] }] }, draft.id), Problem);
  run('reports_update_narrative', { narrative: [{ section_key: 'views', blocks: [{ kind: 'fact', text: 'Views', refs: ['views'] }] }], results: 'ignored' }, draft.id);
  const first = run('reports_finalize', {}, draft.id);
  assert.throws(() => run('reports_update_narrative', { narrative: [] }, draft.id), Problem);
  ctx.now = '2025-01-07T00:00:00Z';
  run('analytics_record_observations', { observations: [dayObservation(post.id, 7, 'observed', ctx.now)] });
  const second = generate(definition.id);
  assert.equal(second.results[0].data.rows[0].values.views.value, 7);
  assert.equal(run('reports_finalize', {}, second.id).supersedes_version_id, first.id);
  const original = run('reports_get', {}, first.id);
  assert.equal(original.status, 'superseded');
  assert.deepEqual(original.results, first.results);
  assert.equal(original.results[0].data.rows[0].values.views.value, 0);
  assert.match(run('reports_export', { format: 'csv' }, first.id).content, /"0","observed"/);
  assert.match(Buffer.from(run('reports_export', { format: 'pdf' }, first.id).content, 'base64').toString(), /^%PDF/);
});
test('redirects and consented touchpoints stay distinct and event retries deduplicate', () => {
  const { ctx, run } = fixture();
  ctx.now = from;
  const link = ctx.create('short_link', { campaign_id: 'campaign' });
  ctx.now = '2025-01-03T00:00:00Z';
  ctx.create('click_event', { short_link_id: link.id, classification: 'bot_preview', occurred_at: ctx.now });
  const point = { short_link_id: link.id, session_ref: 'first-party', event_id: 'event-1', consent_state: 'opted_in', event_type: 'page_view', occurred_at: ctx.now };
  ctx.create('touchpoint_event', point);
  ctx.create('touchpoint_event', point);
  ctx.create('touchpoint_event', { ...point, session_ref: 'second-device' });
  ctx.create('touchpoint_event', { ...point, session_ref: 'denied-device', consent_state: 'denied' });
  ctx.now = to;
  const result = run('links_performance_get', {}, undefined, { from, to }).items[0];
  assert.equal(result.redirects, 1);
  assert.equal(result.clicks_filtered, 0);
  assert.equal(result.stages[0].value, 2);
  assert.equal(result.stages[1].value, null);
  assert.doesNotMatch(JSON.stringify(result), /first-party|second-device|denied-device/);
});
test('linear and direct models use only eligible evidence and reverse after a full refund', () => {
  const { ctx, run } = fixture();
  ctx.now = from;
  const first = ctx.create('short_link', { campaign_id: 'campaign1' });
  const last = ctx.create('short_link', { campaign_id: 'campaign2' });
  ctx.now = '2025-01-02T00:00:00Z';
  ctx.create('touchpoint_event', { event_id: 'first', short_link_id: first.id, consent_state: 'opted_in', session_ref: 'session', occurred_at: ctx.now });
  ctx.now = '2025-01-03T00:00:00Z';
  ctx.create('touchpoint_event', { event_id: 'last', short_link_id: last.id, consent_state: 'opted_in', session_ref: 'session', occurred_at: ctx.now });
  const order = ctx.create('order', { store_id: 'store', external_order_id: '123', placed_at: ctx.now, currency: 'USD', total_minor: 101,
    session_ref: 'session', session_verified: true, buyer_email: 'drop-me' });
  ctx.now = to;
  run('attribution_run', { model_key: 'linear', from, to });
  assert.equal(run('attribution_explain', {}, order.id).models.find((row: any) => row.model_key === 'linear').uncredited_minor, null);
  ctx.create('coverage_segment', { store_id: 'store', resource: 'refunds', status: 'complete', window_start: from, window_end: to });
  run('attribution_run', { model_key: 'linear', from, to });
  run('attribution_run', { model_key: 'link_session', from, to });
  const comparison = run('attribution_query', { from, to, models: ['linear', 'link_session'] });
  assert.deepEqual(comparison.rows.map((row: any) => row.credited_minor), [101, 101]);
  const explanation = run('attribution_explain', {}, order.id);
  assert.deepEqual(explanation.models.find((row: any) => row.model_key === 'linear').records.map((row: any) => row.net_of_refunds_minor), [51, 50]);
  assert(!JSON.stringify(explanation).includes('drop-me'));
  assert(!JSON.stringify(explanation).includes('"session_ref"'));
  ctx.create('refund', { order_id: order.id, external_refund_id: 'refund', amount_minor: 101, status: 'succeeded' });
  run('attribution_run', { model_key: 'linear', from, to });
  const reversed = run('attribution_explain', {}, order.id).models.find((row: any) => row.model_key === 'linear');
  assert.deepEqual(reversed.records, []);
  assert(reversed.history.some((row: any) => row.status === 'reversed'));
});
test('operation attribution counts each transaction once across UTM, promotions and platform reports', () => {
  const { ctx, run } = fixture();
  ctx.now = from;
  const link = ctx.create('short_link', {});
  const campaign = ctx.create('campaign', {});
  ctx.create('short_link_revision', { short_link_id: link.id, utm_params: { utm_campaign: 'launch', utm_content: 'clip' } });
  const promotion = ctx.create('promotion', { store_id: 's', campaign_id: campaign.id });
  ctx.now = '2025-01-03T00:00:00Z';
  const fields = { store_id: 's', currency: 'USD', placed_at: ctx.now, financial_status: 'paid' };
  const order = ctx.create('order', { ...fields, external_order_id: 'order', total_minor: 101, utm: { campaign: 'launch', content: 'clip' } });
  ctx.create('order', { ...fields, external_order_id: 'order', total_minor: 101 });
  ctx.create('order', { ...fields, external_order_id: 'other', total_minor: 49 });
  ctx.create('discount_usage', { order_id: order.id, promotion_id: promotion.id, code: 'SALE' });
  ctx.now = to;
  ctx.create('coverage_segment', { store_id: 's', resource: 'refunds', status: 'complete', window_start: from, window_end: to });
  run('attribution_run', { model_key: 'link_session', from, to });
  run('attribution_run', { model_key: 'discount_code', from, to });
  run('attribution_record_reported', { model_key: 'platform_reported', provider: 'example', rows: [{ order_id: order.id, external_id: 'credit',
    credited_subject_type: 'campaign', credited_subject_id: campaign.id, credited_amount_minor: 123, currency: 'USD', occurred_at: fields.placed_at }] });
  const comparison = run('attribution_query', { from, to, models: ['link_session', 'discount_code', 'platform_reported'] });
  assert.deepEqual(comparison.transaction_totals, [{ currency: 'USD', orders: 2, net_order_minor: 150 }]);
  assert.deepEqual(comparison.rows.map((row: any) => [row.credited_minor, row.uncredited_minor, row.unattributed_orders]), [[101, 49, 1], [101, 49, 1], [123, null, null]]);
});
test('experiment design freezes at start and decisions require limitations', () => {
  const { ctx, run } = fixture();
  const a = ctx.create('landing_page_version', {}), b = ctx.create('landing_page_version', {});
  const draft = run('experiments_create', { type: 'page', hypothesis: 'Test a simpler page', primary_metric: 'clicks', success_criteria: 'More clicks',
    period: { from, to: '2025-01-15T00:00:00Z' }, variants: [{ ref_id: a.id, allocation: 50 }, { ref_id: b.id, allocation: 50 }] });
  run('experiment_start', {}, draft.id);
  assert.throws(() => run('experiment_update', { primary_metric: 'views' }, draft.id), Problem);
  run('experiment_stop', {}, draft.id);
  assert.throws(() => run('experiment_conclude', { decision: 'Retest', limitations: [] }, draft.id), Problem);
  assert.equal(run('experiment_conclude', { decision: 'Retest', limitations: ['Insufficient sample'] }, draft.id).status, 'concluded');
  assert.deepEqual(run('experiment_get', {}, draft.id).limitations, ['Insufficient sample']);
});

test('revenue coverage distinguishes unknown refunds and explicit zero, and reconciliation requires order coverage', () => {
  const { ctx, run } = fixture();
  const store = ctx.create('store', { provider: 'shopify' });
  ctx.create('order', { store_id: store.id, external_order_id: 'o1', placed_at: '2025-01-02T00:00:00Z', currency: 'USD', subtotal_minor: 100,
    total_minor: 110, discount_minor: 0 });
  const input = { from, to, store_id: store.id, currency: 'USD', source_ref: 'official-batch', source_orders: 1, source_total_minor: 111 };
  assert.equal(run('revenue_reconcile', input).status, 'insufficient_coverage');
  ctx.create('coverage_segment', { store_id: store.id, resource: 'orders', status: 'complete', window_start: from, window_end: to });
  const query = { from, to, store_id: store.id };
  assert.equal(run('revenue_query', {}, undefined, query).rows[0].refunds_succeeded_minor, null);
  ctx.create('coverage_segment', { store_id: store.id, resource: 'refunds', status: 'complete', window_start: from, window_end: to });
  assert.equal(run('revenue_query', {}, undefined, query).rows[0].refunds_succeeded_minor, 0);
  assert.equal(run('revenue_reconcile', input).status, 'discrepancy');
  assert.equal(run('revenue_reconcile', input).amount_difference_minor, -1);
  assert.equal(run('revenue_reconciliation_list', {}, undefined, query).length, 2);
});

test('contribution waits for complete costs and deduplicates external settlements', () => {
  const { run } = fixture();
  const query = { from, to, currency: 'USD', scope: 'campaign' };
  const input = (item: string, amount_minor: number, source_ref = item, settlement_id?: string) =>
    ({ item, amount_minor, source_ref, settlement_id, complete: true });
  const initial = [input('net_sales', 500), input('product_cost', 200), input('shipping', 20), input('payment_fees', 10),
    input('ad_spend', 30), input('fixed_collaboration_fees', 15), input('samples_and_production', 5)];
  run('contribution_record_inputs', { ...query, rows: initial });
  const incomplete = run('contribution_query', {}, undefined, query);
  assert.equal(incomplete.value_minor, null);
  assert.deepEqual(incomplete.missing_items, ['commission']);
  run('contribution_record_inputs', { ...query, rows: [input('commission', 20, 'creator', 'settlement-1'), input('commission', 20, 'erp', 'settlement-1')] });
  assert.equal(run('contribution_query', {}, undefined, query).value_minor, 200);
});

test('audience sources remain separate and small posting samples produce no recommendation', () => {
  const { ctx, run } = fixture();
  const account = ctx.create('social_account', { default_timezone: 'Asia/Taipei' });
  for (const source of ['platform', 'third_party_estimate']) run('audience_insights_record', { social_account_id: account.id,
    source, source_ref: source, dimension: 'country', observed_at: ctx.now, values: [{ bucket: 'TW', value: 10, detail: 'private' }] });
  const rows = run('audience_insights_get', {}, undefined, { social_account_id: account.id });
  assert.deepEqual(rows.map((row: Row) => row.source), ['platform', 'third_party_estimate']);
  assert(!JSON.stringify(rows).includes('private'));
  const result = run('posting_time_suggest', { social_account_id: account.id, content_type: 'video', metric_key: 'views', from, to });
  assert.equal(result.recommendation, null);
  assert.equal(result.timezone, 'Asia/Taipei');
});
