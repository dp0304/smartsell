import assert from 'node:assert/strict';
import test from 'node:test';
import { Problem, type Context, type Data, type Input, type Row } from '@smartsell/contracts';
import { operations as adsOperations } from '../ads/workspace-operations';
import { tradeOperations } from '../commerce/trade-operations';
import { commissionOperations } from '../creator/commission-operations';
import { compareMetrics, metricQueryInput } from '../analytics/metrics';
import { operations as executionOperations } from '../execution/ops';
import { dispatchDueSyncs, operations, recordCatalogPage, recordSyncPage, receiveVerifiedDelivery } from './index';
import { recordStoreTradePage, requestStoreSync } from './sync-operations';

function workspace() {
  const rows = new Map<string, Row[]>();
  let id = 0;
  const events: string[] = [];
  const ctx: Context = {
    workspaceId: 'workspace', tenantId: 'tenant', actorId: 'operator', role: 'owner', now: '2026-11-19T12:00:00.000Z',
    list(kind) { return rows.get(kind) ?? []; },
    get(kind, rowId) {
      const row = ctx.list(kind).find(item => item.id === rowId);
      if (!row) throw new Problem(404, 'NOT_FOUND', 'Record not found');
      return row;
    },
    create(kind, body) {
      const row = { ...body, id: `row-${++id}`, version: 1, created_at: ctx.now, updated_at: ctx.now };
      rows.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind, rowId, body) {
      const previous = ctx.get(kind, rowId);
      const row = { ...previous, ...body, version: previous.version + 1, updated_at: ctx.now };
      rows.set(kind, ctx.list(kind).map(item => item.id === rowId ? row : item));
      return row;
    },
    remove(kind, rowId) { rows.set(kind, ctx.list(kind).filter(item => item.id !== rowId)); },
    emit(type) { events.push(type); },
  };
  const run = <T = Row>(name: string, input: Partial<Input> = {}): T => {
    const operation = operations.find(candidate => candidate.name === name);
    assert.ok(operation, name);
    assert.ok(operation.roles.includes(ctx.role));
    return operation.run(ctx, { params: {}, body: {}, query: {}, ...input }) as T;
  };
  return { ctx, run, events };
}

const shop = { provider: 'shopify', status: 'import_only', sync_scope: {}, default_currency: 'USD', brand_id: 'brand' };

test('P1 report imports merge into domain records with row provenance and stable reruns', async () => {
  const { ctx, run } = workspace();
  const store = ctx.create('store', shop);
  const otherStore = ctx.create('store', shop);
  ctx.create('order', { store_id: otherStore.id, external_order_id: 'O1', currency: 'CAD' });
  const order = ctx.create('order', { store_id: store.id, external_order_id: 'O1', currency: 'USD' });
  ctx.create('product_variant', { store_id: otherStore.id, sku: 'SKU1' });
  const variant = ctx.create('product_variant', { store_id: store.id, sku: 'SKU1' });
  const account = ctx.create('ad_account', { provider: 'meta_ads', brand_id: 'brand', timezone: 'America/Los_Angeles', currency: 'USD' });
  const otherAccount = ctx.create('ad_account', { provider: 'meta_ads', brand_id: 'brand', timezone: 'UTC', currency: 'USD' });
  ctx.create('ad_entity', { ad_account_id: otherAccount.id, external_id: 'A1', level: 'ad' });
  const ad = ctx.create('ad_entity', { ad_account_id: account.id, external_id: 'A1', level: 'ad' });
  const adSource = run('data_source_create', { body: { name: 'Ads file source', ad_account_id: account.id } });
  const cases = [
    { template: 'logistics', scope: { store_id: store.id }, kind: 'order_shipment', module: 'commerce', field: 'status', value: 'shipped', changed: 'delivered',
      csv: (value: unknown) => `external_order_id,external_shipment_id,status\nO1,S1,${value}`, expected: { order_id: order.id, external_shipment_id: 'S1' } },
    { template: 'commission', scope: { store_id: store.id }, kind: 'commission_entry', module: 'creator', field: 'commission_minor', value: 750, changed: 850,
      csv: (value: unknown) => `external_order_id,external_commission_id,currency,amount_minor\nO1,C1,USD,${value}`, expected: { order_id: order.id, kind: 'reported', status: 'reported' } },
    { template: 'unit_cost', scope: { store_id: store.id, options: { timezone: 'Asia/Taipei' } }, kind: 'unit_cost_version', module: 'analytics', field: 'cost_minor', value: 42, changed: 55,
      csv: (value: unknown) => `sku,currency,amount_minor,observed_at\nSKU1,USD,${value},2026-11-02`, expected: { product_variant_id: variant.id, valid_from: '2026-11-02T00:00:00.000Z' } },
    { template: 'ad_report', scope: { data_source_id: adSource.id }, kind: 'metric_observation', module: 'analytics', field: 'value', value: 0, changed: 250,
      csv: (value: unknown) => `external_ad_id,report_date,currency,amount_minor\nA1,2026-11-01,USD,${value}`,
      expected: { subject_id: ad.id, native_date: '2026-11-01', metric_key: 'ads.spend', period_start: '2026-11-01T07:00:00.000Z', period_end: '2026-11-02T08:00:00.000Z' } },
  ];
  for (const item of cases) {
    const body = (value: unknown) => ({ template_key: item.template, ...item.scope, csv: item.csv(value) });
    const preview = run('import_create', { body: body(item.value) });
    assert.deepEqual(preview.stats, { rows: 1, valid: 1, invalid: 0, dup_in_file: 0, new: 1, changed: 0, unchanged: 0 }, item.template);
    assert.equal(ctx.list(item.kind).length, 0, 'preview does not write domain rows');
    assert.equal(run('import_confirm', { params: { id: preview.id } }).merged_rows, 1);
    const [record] = ctx.list(item.kind);
    for (const [field, value] of Object.entries(item.expected)) assert.equal(record[field], value);
    assert.equal(record[item.field], item.value);
    const [firstRow] = run<Row[]>('import_rows', { params: { id: preview.id } });
    assert.deepEqual(firstRow.target_ref, { module: item.module, resource_type: item.kind, resource_id: record.id });
    const source = (record.import_source ?? record.source) as Data;
    assert.equal(source.batch_id, preview.id);
    assert.equal(source.row_id, firstRow.id);

    ctx.now = new Date(Date.parse(ctx.now) + 1000).toISOString();
    const rerun = run('import_create', { body: { ...body(item.value), supersedes_batch_id: preview.id } });
    assert.equal((rerun.stats as Data).unchanged, 1);
    assert.equal(run('import_confirm', { params: { id: rerun.id } }).skipped_rows, 1);
    assert.equal(ctx.get(item.kind, record.id).version, 1);

    const correction = run('import_create', { body: { ...body(item.changed), supersedes_batch_id: rerun.id } });
    assert.equal((correction.stats as Data).changed, 1);
    assert.equal(run('import_confirm', { params: { id: correction.id } }).merged_rows, 1);
    assert.equal(run('import_confirm', { params: { id: correction.id } }).merged_rows, 1);
    assert.equal(ctx.list(item.kind).length, 1);
    assert.equal(ctx.get(item.kind, record.id)[item.field], item.changed);
    assert.equal(ctx.get(item.kind, record.id).version, 2);
    assert.equal(run<Row[]>('data_provenance_get', { query: { resource_type: item.kind, resource_id: record.id } }).length, 3);
  }
  assert.equal(ctx.list('import_staged_record').length, 0);
  const detail = await tradeOperations({}).find(op => op.name === 'commerce_order_get')!.run(ctx, { params: { id: order.id }, query: {}, body: {} }) as Data;
  assert.equal((detail.shipments as Row[])[0].status, 'delivered');
  const mature = commissionOperations.find(op => op.name === 'commissions_mature')!;
  assert.deepEqual(await mature.run(ctx, { params: {}, query: {}, body: {} }), { count: 0 });
  assert.equal(ctx.list('commission_entry')[0].status, 'reported');
  const performance = await adsOperations.find(op => op.name === 'ads_query_performance')!.run(ctx, {
    params: {}, body: {}, query: { ad_account_id: account.id, from: '2026-11-01', until: '2026-11-01' },
  }) as Data;
  assert.equal((performance.pacing as Data[])[0].actual_spend_minor, 250);
  ctx.role = 'viewer';
  assert.deepEqual(run('data_provenance_get', { query: { resource_type: 'commission_entry', resource_id: ctx.list('commission_entry')[0].id } }), []);
});

test('P1 report previews reject stale or out-of-scope data safely', () => {
  const { ctx, run } = workspace();
  const store = ctx.create('store', shop);
  const order = ctx.create('order', { store_id: store.id, external_order_id: 'O1', currency: 'USD' });
  const preview = (template_key: string, csv: string, scope: Data = { store_id: store.id }) => run('import_create', { body: { template_key, csv, ...scope } });
  const confirm = (batch: Row) => run('import_confirm', { params: { id: batch.id } });
  const logistics = (status: string, when: string, id = 'O1') => preview('logistics',
    `external_order_id,external_shipment_id,status,observed_at\n${id},S1,${status},${when}`);
  confirm(logistics('delivered', '2026-11-18T00:00:00Z'));
  const stale = logistics('shipped', '2026-11-17T00:00:00Z');
  assert.equal((stale.stats as Data).unchanged, 1);
  confirm(stale);
  assert.equal(ctx.list('order_shipment')[0].status, 'delivered');
  assert.equal(ctx.get('order', order.id).version, 1);
  assert.equal((logistics('shipped', '2026-11-18T00:00:00Z', 'unknown').stats as Data).invalid, 1);
  assert.equal((preview('commission', 'external_order_id,external_commission_id,currency,amount_minor\nO1,C1,EUR,50').stats as Data).invalid, 1);

  ctx.create('product_variant', { store_id: store.id, sku: 'SHARED' });
  ctx.create('product_variant', { store_id: store.id, sku: 'SHARED' });
  assert.equal((preview('unit_cost', 'sku,currency,amount_minor,observed_at\nSHARED,USD,50,2026-11-01T00:00:00Z').stats as Data).invalid, 1);
  const adAccount = ctx.create('ad_account', { provider: 'meta_ads', timezone: 'UTC', currency: 'USD' });
  assert.equal((preview('ad_report', 'external_ad_id,report_date,currency,amount_minor\nunknown,2026-11-01,USD,50', { ad_account_id: adAccount.id }).stats as Data).invalid, 1);
});

test('commerce CSV maps multiline rows, resumes a partial merge, dedupes reruns and exports row errors', () => {
  const { ctx, run } = workspace();
  const store = ctx.create('store', shop);
  const csv = '﻿Handle,Heading,Variant SKU,Variant Price,Currency\r\nshirt,"Summer\r\nshirt",SKU1,12.30,USD\r\nshirt,Duplicate,SKU1,15,USD\r\nhat,Hat,SKU2,wrong,USD';
  const input = { template_key: 'product_list', store_id: store.id, csv };
  let batch = run('import_create', { body: input });
  assert.equal(ctx.list('product').length, 0);
  batch = run('import_preview', { params: { id: batch.id }, body: { mapping: { ...batch.mapping as Data, Heading: 'title' } } });
  assert.deepEqual(batch.stats, { rows: 3, valid: 1, invalid: 1, dup_in_file: 1, new: 1, changed: 0, unchanged: 0 });
  const id = batch.id;
  batch = run('import_confirm', { params: { id }, body: { limit: 1 } });
  assert.equal(batch.status, 'merging');
  assert.equal(batch.checkpoint_row, 2);
  batch = run('import_confirm', { params: { id } });
  assert.equal(batch.status, 'partially_merged');
  assert.equal(batch.merged_rows, 1);
  assert.equal(ctx.list('product')[0].title, 'Summer\nshirt');
  const errors = run<{ csv: string }>('import_error_file', { params: { id } });
  assert.match(errors.csv, /DUP_IN_FILE/);
  assert.match(errors.csv, /wrong/);
  const rerun = run('import_create', { body: { ...input, supersedes_batch_id: id, mapping: batch.mapping } });
  assert.equal((rerun.stats as Data).unchanged, 1);
  run('import_confirm', { params: { id: rerun.id } });
  assert.equal(ctx.list('product').length, 1);
  assert.equal(run<Row[]>('data_provenance_get', { query: { resource_type: 'product', resource_id: ctx.list('product')[0].id } }).length, 2);
});

test('Amazon order report strips PII from preview, errors, and stored order, then applies successful refund', () => {
  const { ctx, run } = workspace();
  const store = ctx.create('store', { ...shop, provider: 'amazon_sp' });
  const order = run('import_create', { body: { template_key: 'order_list', store_id: store.id,
    csv: 'amazon-order-id,purchase-date,currency,total,buyer-email,deliveryAddress.postalCode,unmapped\n123-4567,2026-11-01T10:00:00Z,USD,20.50,buyer@example.test,90210,hidden' } });
  assert.equal((order.stats as Data).new, 1);
  run('import_confirm', { params: { id: order.id } });
  assert.equal(ctx.list('order')[0].total_minor, 2050);
  const refund = run('import_create', { body: { template_key: 'refund_list', store_id: store.id,
    csv: 'amazon-order-id,refund-id,currency,amount,status\n123-4567,R001,USD,5.25,succeeded' } });
  assert.equal((refund.stats as Data).new, 1);
  run('import_confirm', { params: { id: refund.id } });
  assert.equal(ctx.list('refund')[0].amount_minor, 525);
  assert.ok(!/buyer@example|90210|hidden|postalCode/.test(JSON.stringify([...ctx.list('import_row'), ...ctx.list('import_batch'), ...ctx.list('order')])));
  ctx.role = 'analyst';
  assert.throws(() => run('import_rows', { params: { id: order.id } }), { status: 403 });
});

test('reported zero is distinct from missing and unchanged social report rows dedupe', () => {
  const { ctx, run } = workspace();
  const account = ctx.create('social_account', { platform: 'youtube' });
  for (const external of ['v1', 'v2']) ctx.create('platform_post', { external_post_id: external, social_account_id: account.id, platform: 'youtube' });
  const body = { template_key: 'social_post_report', options: { timezone: 'America/Los_Angeles', social_account_id: account.id },
    csv: 'external_post_id,report_date,metric_key,value\nv1,2026-11-01,yt.video.views,0\nv2,2026-11-01,yt.video.views,' };
  const batch = run('import_create', { body });
  assert.equal((batch.stats as Data).new, 2);
  run('import_confirm', { params: { id: batch.id } });
  const [zero, missing] = ctx.list('metric_observation');
  assert.equal(zero.value, 0);
  assert.equal(missing.availability, 'source_not_provided');
  assert.equal(missing.value, null);
  assert.equal(Date.parse(String(zero.period_end)) - Date.parse(String(zero.period_start)), 25 * 3_600_000);
  assert.equal((run('import_create', { body }).stats as Data).unchanged, 2);
});

test('social reports accept an optional period kind and lifetime totals feed post age comparisons', () => {
  const { ctx, run } = workspace();
  const account = ctx.create('social_account', { provider: 'youtube', brand_id: 'brand-a' });
  const register = executionOperations.find(operation => operation.name === 'posts_register_manual')!;
  Object.assign(ctx, { agentCredentialId: 'pat' });
  const post = register.run(ctx, { params: {}, query: {}, body: { social_account_id: account.id, external_post_id: 'v1',
    permalink: 'https://www.youtube.com/watch?v=v1', published_at: '2026-11-01T10:00:00.000Z' } }) as Row;
  Object.assign(ctx, { agentCredentialId: undefined });
  assert.equal(post.verification, 'agent_reported');
  const csv = ['external_post_id,report_date,metric_key,value,period_kind', 'v1,2026-11-01,yt.video.views,120,lifetime',
    'v1,2026-11-02,yt.video.views,150,LIFETIME', 'v1,2026-11-01,yt.video.views,40,', 'v1,2026-11-19,yt.video.views,300,lifetime', 'v1,2026-11-03,yt.video.views,1,weekly'].join('\n');
  const body = { template_key: 'social_post_report', options: { timezone: 'America/Los_Angeles', social_account_id: account.id }, csv };
  const batch = run('import_create', { body });
  assert.deepEqual(batch.stats, { rows: 5, valid: 4, invalid: 1, dup_in_file: 0, new: 4, changed: 0, unchanged: 0 });
  assert.match(JSON.stringify(run<Row[]>('import_rows', { params: { id: batch.id } }).at(-1)?.issues), /period_kind must be day or lifetime/);
  run('import_confirm', { params: { id: batch.id } });
  const observations = ctx.list('metric_observation');
  const daily = observations.filter(row => row.period_kind === 'day');
  assert.deepEqual(daily.map(row => [row.value, row.date]), [[40, '2026-11-01']]);
  const lifetime = observations.filter(row => row.period_kind === 'lifetime');
  assert.deepEqual(lifetime.map(row => [row.value, row.observed_at, row.period_start, row.date, row.brand_id]), [
    [120, '2026-11-02T08:00:00.000Z', undefined, undefined, 'brand-a'],
    [150, '2026-11-03T08:00:00.000Z', undefined, undefined, 'brand-a'],
    [300, batch.created_at, undefined, undefined, 'brand-a'],
  ]);
  assert.equal((run('import_create', { body }).stats as Data).unchanged, 4);
  const age = (bucket: string) => compareMetrics(ctx, metricQueryInput(ctx, { metrics: ['yt.video.views'], age_bucket: bucket,
    subject: { type: 'platform_post', filter: { brand_ids: ['brand-a'] } }, time: { from: '2026-11-01', to: '2026-11-20', tz: 'America/Los_Angeles', basis: 'published_at' } }));
  assert.equal(age('24h').rows[0]?.values['yt.video.views']?.value, 120);
  assert.equal(age('72h').rows[0]?.values['yt.video.views']?.value, 150);
  assert.deepEqual([age('1h').rows[0]?.values['yt.video.views']?.value, age('1h').rows[0]?.values['yt.video.views']?.availability], [null, 'not_collected'],
    'no snapshot that young is unknown, not zero');
});

test('sync advances coverage only after a complete worker run, dedupes event and fences stale attempts', () => {
  const { ctx, run } = workspace();
  const source = run('data_source_create', { body: { name: 'Vendor', kind: 'vendor', provider: 'vendor:verified', contract_ref: 'terms-v1', resources: ['posts'] } });
  const queued = run<{ sync_run_id: string }>('sync_refresh', { params: { id: source.id } });
  assert.equal(ctx.get('sync_run', queued.sync_run_id).status, 'queued');
  assert.equal(ctx.get('data_source', source.id).last_success_at, undefined);
  recordSyncPage(ctx, queued.sync_run_id, { index: 1, attempt: 1, result: 'more', cursor: 'next', requests: 1 });
  recordSyncPage(ctx, queued.sync_run_id, { index: 2, attempt: 1, result: 'partially_succeeded', requests: 1 });
  assert.equal(ctx.list('sync_cursor').length, 0);
  const retried = run('sync_run_retry', { params: { id: queued.sync_run_id } });
  assert.equal(retried.cursor_after, 'next');
  assert.throws(() => recordSyncPage(ctx, queued.sync_run_id, { index: 3, attempt: 1, result: 'succeeded', requests: 1 }), { code: 'STALE_SYNC_ATTEMPT' });
  recordSyncPage(ctx, queued.sync_run_id, { index: 3, attempt: 2, result: 'succeeded', requests: 1 });
  assert.equal(ctx.list('sync_cursor').length, 1);
  assert.equal(ctx.list('data_gap')[0].status, 'resolved');
  const event = { sourceId: source.id, resource: 'posts', eventId: 'event-1', externalId: 'post-1', transport: 'https' as const };
  assert.equal(receiveVerifiedDelivery(ctx, event).duplicate, false);
  assert.equal(receiveVerifiedDelivery(ctx, event).duplicate, true);
  assert.equal(ctx.list('webhook_delivery').length, 1);
});

test('store upgrade waits for the authoritative final catalog page', () => {
  const { ctx, run } = workspace();
  const connection = ctx.create('connection', { provider: 'shopify', status: 'active' });
  const store = ctx.create('store', { ...shop, status: 'connecting', connection_id: connection.id, upgrading_from_import: true });
  run('data_source_create', { body: { kind: 'store', provider: 'shopify', name: 'Shop', store_id: store.id, connection_id: connection.id, resources: ['products'] } });
  const result = requestStoreSync(ctx, store, 'reconcile');
  const item = { externalId: 'shop-product-1', title: 'Product', variantsComplete: true, variants: [{ externalId: 'VAR-1', sku: 'SKU-1' }] };
  recordCatalogPage(ctx, result.sync_run_id, { index: 1, attempt: 1, requests: 1, page: { items: [item], nextCursor: 'page-2' } });
  assert.equal(ctx.get('store', store.id).status, 'connecting');
  assert.equal(ctx.list('product').length, 1);
  recordCatalogPage(ctx, result.sync_run_id, { index: 2, attempt: 1, requests: 1, authoritative: true, page: { items: [], nextCursor: null } });
  assert.equal(ctx.get('store', store.id).status, 'active');
  assert.equal(ctx.get('sync_run', result.sync_run_id).status, 'succeeded');
});

test('trade checkpoint seeds a missing parent and only settles completed refunds', () => {
  const { ctx, run } = workspace();
  const connection = ctx.create('connection', { provider: 'amazon_sp', status: 'active' });
  const store = ctx.create('store', { ...shop, provider: 'amazon_sp', status: 'active', connection_id: connection.id });
  const source = run('data_source_create', { body: { kind: 'store', provider: 'amazon_sp', name: 'Shop', store_id: store.id, connection_id: connection.id, resources: ['products', 'orders', 'refunds'] } });
  assert.throws(() => requestStoreSync(ctx, store, 'reconcile', { resource: 'refunds' }), { status: 422 });
  const queued = requestStoreSync(ctx, store, 'refresh', { resource: 'refunds' });
  assert.equal(ctx.get('sync_run', queued.sync_run_id).window_to, '2026-11-17T11:59:00.000Z');
  const order = { external_order_id: 'A1', placed_at: '2026-11-02T10:00:00Z', currency: 'USD', total_minor: 150, financial_status: 'paid', recipient: { postalCode: 'private' } };
  const refund = { external_order_id: 'A1', external_refund_id: 'R1', currency: 'USD', amount_minor: 150, created_at: '2026-11-17T10:00:00Z', status: 'pending', order };
  recordStoreTradePage(ctx, queued.sync_run_id, { index: 1, attempt: 1, requests: 2, cursor: 'second', rows: [refund] });
  assert.equal(ctx.list('order').length, 1);
  assert.equal(ctx.list('refund')[0].status, 'pending');
  assert(!('recipient' in ctx.list('order')[0]));
  recordStoreTradePage(ctx, queued.sync_run_id, { index: 2, attempt: 1, requests: 2, cursor: null, rows: [{ ...refund, status: 'succeeded' }] });
  assert.equal(ctx.list('refund').length, 1);
  assert.equal(ctx.list('refund')[0].status, 'succeeded');
  assert.equal(ctx.get('sync_run', queued.sync_run_id).status, 'succeeded');
  assert.equal(ctx.list('coverage_segment').find(segment => segment.data_source_id === source.id)?.status, 'complete');
});

test('IP denial blocks new API collection until a successful read-only probe', () => {
  const { ctx, run } = workspace();
  const connection = ctx.create('connection', { provider: 'shopify', status: 'active' });
  const store = ctx.create('store', { ...shop, status: 'active', connection_id: connection.id });
  const source = run('data_source_create', { body: { kind: 'store', provider: 'shopify', name: 'Shop', store_id: store.id, connection_id: connection.id, resources: ['products'] } });
  const queued = requestStoreSync(ctx, store, 'refresh');
  recordSyncPage(ctx, queued.sync_run_id, { index: 1, attempt: 1, requests: 1, result: 'failed', error_class: 'permission_denied', error_reason: 'ip_not_allowed' });
  assert.equal(ctx.get('store', store.id).status, 'degraded');
  assert.throws(() => requestStoreSync(ctx, store, 'refresh'), { code: 'SOURCE_UNAVAILABLE' });
  const { sync_run_id } = run<{ sync_run_id: string }>('data_source_resume', { params: { id: source.id } });
  assert.equal(ctx.get('data_source', source.id).status, 'degraded');
  recordSyncPage(ctx, sync_run_id, { index: 1, attempt: 1, requests: 1, result: 'succeeded' });
  assert.equal(ctx.get('data_source', source.id).status, 'active');
  assert.equal(ctx.list('data_gap')[0].status, 'backfill_scheduled');
});


test('callback fallback accelerates event schedules within source limits and restores daily reconciliation', () => {
  const { ctx, run } = workspace();
  const source = run('data_source_create', { body: { name: 'Vendor', kind: 'vendor', provider: 'vendor:verified',
    contract_ref: 'terms-v1', resources: ['posts'], min_sync_interval_min: 20 } });
  run('sync_schedule_create', { body: { data_source_id: source.id, resource: 'posts', mode: 'on_event' } });
  const endpoint = ctx.create('callback_endpoint', { provider: source.provider, fallback_polling: true, reachable: false });
  assert.equal(run('data_source_get', { params: { id: source.id } }).fallback_polling_reason, 'callback_unreachable');
  const event = { sourceId: source.id, resource: 'posts', eventId: 'fallback', externalId: 'post-1', transport: 'https' as const };
  assert.equal(receiveVerifiedDelivery(ctx, event).delivery.sync_run_id, undefined);
  ctx.now = '2026-11-19T12:19:59.000Z';
  assert.deepEqual(dispatchDueSyncs(ctx), []);
  ctx.now = '2026-11-19T12:20:00.000Z';
  const [poll] = dispatchDueSyncs(ctx);
  assert.ok(poll);
  recordSyncPage(ctx, poll.id, { index: 1, attempt: 1, result: 'succeeded', requests: 1 });
  ctx.update('callback_endpoint', endpoint.id, { fallback_polling: false, reachable: true });
  assert.equal(run('data_source_get', { params: { id: source.id } }).fallback_polling, false);
  assert.ok(receiveVerifiedDelivery(ctx, { ...event, eventId: 'restored' }).delivery.sync_run_id);
  ctx.now = '2026-11-19T12:41:00.000Z';
  assert.deepEqual(dispatchDueSyncs(ctx), []);
  ctx.now = '2026-11-20T12:20:00.000Z';
  assert.equal(dispatchDueSyncs(ctx).length, 1);
});

test('older webhook catalog readback cannot roll back a newer product or listing', () => {
  const { ctx } = workspace();
  const connection = ctx.create('connection', { provider: 'shopify', status: 'active' });
  const store = ctx.create('store', { provider: 'shopify', status: 'active', brand_id: 'brand', connection_id: connection.id, default_currency: 'USD' });
  const market = ctx.create('market', { currency: 'USD' });
  ctx.create('store_market', { store_id: store.id, market_id: market.id, channel: 'online_store', price_source: 'store_base_price', enabled: true });
  const source = ctx.create('data_source', { kind: 'store', provider: 'shopify', status: 'active', store_id: store.id,
    connection_id: connection.id, resources: ['products'] });
  const deliver = (eventId: string, title: string, price: string, sourceUpdatedAt: string) => {
    const { delivery } = receiveVerifiedDelivery(ctx, { sourceId: source.id, resource: 'products', eventId, externalId: 'p1', transport: 'https' });
    recordCatalogPage(ctx, String(delivery.sync_run_id), { index: 1, attempt: 1, requests: 1, page: { nextCursor: null,
      items: [{ externalId: 'p1', title, sourceUpdatedAt, variants: [{ externalId: 'v1', price, currency: 'USD', available: Number(price) }] }] } });
  };
  deliver('newer', 'New title', '12', '2026-11-19T10:00:00Z');
  deliver('older', 'Old title', '8', '2026-11-19T09:00:00Z');
  assert.equal(ctx.list('sync_run').length, 2);
  assert.equal(ctx.list('product')[0].title, 'New title');
  const snapshots = ctx.list('listing_snapshot');
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].price_amount_minor, 1200);
  assert.equal(snapshots[0].inventory_quantity, 12);
});
