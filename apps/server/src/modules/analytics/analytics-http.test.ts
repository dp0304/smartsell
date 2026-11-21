import { reportGenerationSubscriber } from './report-generation.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../../app.js';
import { makeContext } from '../../context.js';
import { commandBackgroundStore } from '../../integration/command-background.js';
import { localStore } from '../../local.js';
import { MemoryStore } from '../../memory.js';
import { PostgresStore } from '../../postgres.js';
import { register, type Registry } from '../../registry.js';
import type { Context } from '../types.js';
import { commands as commerce } from '../commerce/index.js';
import { purgeExpiredIngestData } from '../ingest/evidence.js';
import { commands as analytics } from './index.js';

const now = '2026-11-20T12:00:00.000Z';
const period = { from: '2026-07-01', to: '2026-11-20', tz: 'UTC' };

async function fixture(t: TestContext, { persistent = false } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  const database = process.env.SMARTSELL_DATA_COMMAND_PG_URL;
  const directory = persistent ? await mkdtemp(join(tmpdir(), 'smartsell-ds07-commands-')) : undefined;
  const store = directory ? localStore(join(directory, 'state.sqlite')) : database ? new PostgresStore(database) : new MemoryStore();
  let close = () => store.close();
  t.after(async () => {
    await close();
    if (directory) await rm(directory, { recursive: true, force: true });
  });
  assert.equal(await store.setup({ email: `${randomUUID()}@example.invalid`, name: 'Owner', workspaceName: 'Analytics test', passwordHash: 'unused' }, hash), true,
    'Each PostgreSQL test requires a fresh migrated database (bootstrap is one-time)');
  const session = await store.session(hash);
  assert.ok(session);
  const wid = session.workspaces[0].id;
  const registry: Registry = new Map();
  register(registry, 'analytics', analytics);
  register(registry, 'commerce', commerce);
  const { app } = buildApp({ store, registry, secureCookie: false, origins: new Set() });
  close = () => app.close();
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const request = async (module: string, action: string, payload: object, authenticated = true) => {
    const response = await fetch(`${base}/api/v1/workspaces/${wid}/commands/${module}/${action}`, { method: 'POST',
      body: JSON.stringify(payload), headers: { 'content-type': 'application/json',
        ...(authenticated ? { cookie: `smartsell_session=${token}` } : {}), 'idempotency-key': randomUUID() } });
    const body = await response.text();
    return { statusCode: response.status, body, json: () => JSON.parse(body) };
  };
  const run = async (module: string, action: string, payload: object) => {
    const reply = await request(module, action, payload);
    assert.equal(reply.statusCode, 200, reply.body);
    return reply.json().data;
  };
  const seed = (fn: (ctx: Context) => Promise<unknown>) =>
    store.workspace(hash, wid, unit => unit.command({ module: 'analytics', action: 'fixture', key: randomUUID(), fingerprint: 'fixture' }, () => fn(unit.context)));
  const createStore = (provider: string) => run('commerce', 'create_store', { provider, name: provider, default_currency: 'USD', default_locale: 'en-US' });
  const importOrders = async (store_id: string, rows: string[]) => {
    const preview = await run('commerce', 'preview_import', { store_id, template_key: 'order_list',
      csv: ['external_order_id,placed_at,currency,total_minor,financial_status', ...rows].join('\n') });
    await run('commerce', 'commit_import', { batch_id: preview.batch_id, expected_version: preview.version });
  };
  const background = commandBackgroundStore(store);
  const operationFixture = async <T>(run: (ctx: ReturnType<typeof makeContext>) => T | Promise<T>) => {
    const [workspace] = await background.workspaces();
    assert.ok(workspace);
    return background.transact(workspace, false, (records, scope, identity) => Promise.resolve(run(Object.assign(makeContext(records, scope, 'owner'), {
      workspaceMemberRole: (id: string) => identity?.get<{ role: Context['role'] }>(`member/${id}/${workspace.id}`)?.role,
    }))));
  };
  return { request, run, seed, createStore, importOrders, operationFixture };
}

test('DS07 Commands HTTP freezes provenance for campaign, client monthly and custom versions in SQLite', async t => {
  const { request, run, seed, operationFixture } = await fixture(t, { persistent: true });
  const analytics = (action: string, input: object) => run('analytics', action, input);
  const source = async (name: string, mapping_revision: number, retention_until: string) => {
    const data = { name, provider: 'youtube', method: 'official_api', status: 'active', allowed_uses: { display: true } };
    const { data_source_id, sync_run_id, raw_record_id } = await operationFixture(ctx => {
      const data_source_id = ctx.create('data_source', data).id;
      const sync_run_id = ctx.create('sync_run', { data_source_id, status: 'succeeded' }).id;
      const raw_record_id = ctx.create('raw_record', { data_source_id, sync_run_id, retention_until, payload: { views: 42 } }).id;
      return { data_source_id, sync_run_id, raw_record_id };
    });
    await seed(async ctx => {
      await ctx.insert('ingest', 'data_source', data, data_source_id);
      await ctx.insert('ingest', 'sync_run', { data_source_id, status: 'succeeded' }, sync_run_id);
    });
    return { data_source_id, sync_run_id, batch_id: sync_run_id, raw_record_id, mapping_revision, method: 'official_api' };
  };
  const original = await source('Original collection', 4, '2026-11-20T13:00:00.000Z');
  const observationId = 'observation';
  await seed(ctx => ctx.insert('analytics', 'metric_observation', {
    metric_key: 'norm.post.views', definition_revision: 1, subject_type: 'platform_post', subject_id: 'post', platform: 'youtube',
    observed_at: '2026-10-02T00:00:00.000Z', published_at: '2026-10-01T00:00:00.000Z', period_kind: 'lifetime',
    data_source_id: original.data_source_id, availability: 'observed', value: 42, source: original,
  }, observationId));
  const query = { metrics: ['norm.post.views'], age_bucket: '24h', subject: { type: 'platform_post' }, time: { basis: 'published_at' } };
  const versions: { id: string; results: unknown }[] = [];
  for (const [kind, type] of [['campaign', 'kpi'], ['client_monthly', 'chart'], ['custom', 'table']]) {
    const report = await analytics('reports_create', { title: `DS07 ${kind}`, kind, period, sections: [{ key: 'views', type, query }] });
    const response = await request('analytics', 'reports_generate_version', { report_id: report.id });
    assert.equal(response.statusCode, 202, response.body);
    const { operation_id } = response.json().data;
    const versionId = await operationFixture(async ctx => {
      await reportGenerationSubscriber.run(ctx, { data: { operation_id } });
      return (ctx.get('operation', operation_id).result_ref as { version_id: string }).version_id;
    });
    const draft = await analytics('reports_get', { version_id: versionId });
    const version = await analytics('reports_finalize', { version_id: draft.id, expected_version: draft.version });
    assert.equal(version.data.results.views.rows[0].values['norm.post.views'].value, 42);
    versions.push({ id: version.id, results: version.data.results });
  }
  const replacement = await source('Replacement collection', 9, '2026-11-28T12:00:00.000Z');
  await seed(async ctx => {
    const row = await ctx.get('analytics', 'metric_observation', observationId);
    assert.ok(row);
    await ctx.update('analytics', 'metric_observation', row.id, { data_source_id: replacement.data_source_id, source: replacement }, row.version);
  });
  const provenance = (version: { id: string }) => analytics('report_provenance_get', { version_id: version.id, observation_id: observationId });
  const readBack = async (status: string) => {
    for (const version of versions) {
      const saved = await analytics('reports_get', { version_id: version.id });
      assert.deepEqual(saved.data.results, version.results);
      const trace = await provenance(version);
      assert.equal(trace.data_source_id, original.data_source_id);
      assert.equal(trace.sync_run_id, original.sync_run_id);
      assert.equal(trace.mapping_version, original.mapping_revision);
      assert.equal(trace.raw_record_id, original.raw_record_id);
      assert.equal(trace.raw_evidence.status, status);
      if (status === 'available') assert.equal(trace.raw_evidence.raw_record_id, original.raw_record_id);
      else assert.ok(trace.raw_evidence.deleted_at);
    }
  };
  await readBack('available');
  t.mock.timers.setTime(Date.parse('2026-11-20T14:00:00.000Z'));
  assert.deepEqual(await operationFixture(purgeExpiredIngestData), { raw_records_removed: 1 });
  await readBack('deleted');
  assert.equal((await request('analytics', 'report_provenance_get', { version_id: versions[0].id, observation_id: 'not-in-version' })).statusCode, 404);
});

test('AN07 HTTP cohorts warn on short or unknown history, exclude masked providers, and wait for maturity', async t => {
  const { request, run, seed, createStore, importOrders } = await fixture(t);
  const shop = await createStore('shopify');
  const unknown = await createStore('tiktok_shop');
  const amazon = await createStore('amazon_sp');
  const shopee = await createStore('shopee');
  await importOrders(amazon.id, ['AMZ,2026-08-10T12:00:00Z,USD,300,paid']);
  await importOrders(shopee.id, ['SHO,2026-08-10T12:00:00Z,USD,300,paid']);
  // Fixture for provider-authorized identity and coverage facts that CSV intentionally does not carry.
  await seed(async ctx => {
    await ctx.insert('commerce', 'coverage_segment', { store_id: shop.id, resource: 'orders', status: 'complete', active: true,
      window_start: '2026-07-01T00:00:00Z', window_end: '2026-11-20T00:00:00Z' });
    await ctx.insert('commerce', 'store', { name: 'Lazada', provider: 'lazada' }, 'lazada');
    await ctx.insert('commerce', 'order', { store_id: 'lazada', total_minor: 300, currency: 'USD', placed_at: '2026-08-10T12:00:00Z', financial_status: 'paid' });
    for (const customer of ['EARLY', 'MATURE', 'IMMATURE', 'RETURNING']) {
      await ctx.insert('commerce', 'store_customer', { store_id: shop.id, identity_verified: true, opaque_provider_id: 'private-fixture-ref' }, customer);
    }
    for (const [order, placed_at, customer, index] of [
      ['EARLY', '2026-07-20', 'EARLY', 1], ['REPEAT', '2026-08-03', 'EARLY', 2], ['MATURE', '2026-10-03', 'MATURE', 1],
      ['MATURE', '2026-10-03', 'MATURE', 1], ['REFUNDED', '2026-10-20', 'MATURE', 2],
      ['IMMATURE', '2026-11-05', 'IMMATURE', 1], ['RETURNING', '2026-10-05', 'RETURNING', 2],
    ] as const) {
      await ctx.insert('commerce', 'order', { external_order_id: order, store_id: shop.id, total_minor: 100, currency: 'USD',
        placed_at: `${placed_at}T00:00:00Z`, financial_status: 'paid', store_customer_id: customer, customer_order_index: index });
    }
    const orders = await ctx.list('commerce', 'order');
    const mature = orders.filter(row => row.data.external_order_id === 'MATURE');
    const refunded = orders.find(row => row.data.external_order_id === 'REFUNDED')!;
    for (const order of mature) await ctx.insert('commerce', 'refund', { order_id: order.id, external_refund_id: 'PARTIAL',
      amount_minor: 60, currency: 'USD', status: 'succeeded', created_at: '2026-10-06T00:00:00Z' });
    await ctx.insert('commerce', 'refund', { order_id: mature[0].id, external_refund_id: 'PENDING',
      amount_minor: 100, currency: 'USD', status: 'pending', created_at: '2026-10-06T00:00:00Z' });
    await ctx.insert('commerce', 'refund', { order_id: refunded.id, external_refund_id: 'FULL',
      amount_minor: 100, currency: 'USD', status: 'succeeded', created_at: '2026-10-21T00:00:00Z' });
  });
  const params = { period, observation_days: 30 };
  assert.equal((await request('analytics', 'cohorts_list', params, false)).statusCode, 401);
  assert.equal((await request('analytics', 'cohorts_list', { ...params, history_months: 25 })).statusCode, 422);
  const result = await run('analytics', 'cohorts_list', params);
  assert.equal(result.history_months, 3);
  assert.equal(result.items.length, 5);
  const shopCohorts = result.items.find((item: any) => item.store_id === shop.id);
  assert.equal(shopCohorts.history_coverage_from, '2026-07-01T00:00:00.000Z');
  assert.equal(shopCohorts.history_reliable_from, '2026-10-01T00:00:00.000Z');
  assert.deepEqual(shopCohorts.limitations, ['INSUFFICIENT_ORDER_HISTORY']);
  assert.deepEqual(shopCohorts.rows.map((row: any) => [row.month, row.count, row.confirmed, row.repeat_rate, row.new_customer_reliability]),
    [['2026-07', 1, 0, 1, 'low'], ['2026-10', 1, 1, 0, 'high'], ['2026-11', 1, 1, null, 'high']]);
  assert.deepEqual(result.items.find((item: any) => item.store_id === unknown.id).limitations, ['HISTORY_START_UNKNOWN']);
  for (const id of [amazon.id, shopee.id, 'lazada']) {
    const item = result.items.find((row: any) => row.store_id === id);
    assert.equal(item.excluded, true);
    assert.equal(item.unidentified_orders, 1);
    assert.deepEqual(item.rows, []);
    assert.deepEqual(item.limitations, ['PROVIDER_IDENTITY_UNAVAILABLE']);
  }
  assert.doesNotMatch(JSON.stringify(result), /private-fixture-ref|opaque_provider_id|store_customer_id/);
  const selected = await run('analytics', 'cohorts_list', { ...params, store_ids: [shop.id], history_months: 1 });
  assert.equal(selected.history_months, 1);
  assert.deepEqual(selected.items.map((row: any) => row.store_id), [shop.id]);
  assert.equal(selected.items[0].history_reliable_from, '2026-08-01T00:00:00.000Z');
  assert.deepEqual(selected.items[0].rows.map((row: any) => row.new_customer_reliability), ['low', 'high', 'high']);
  const longer = await run('analytics', 'cohorts_list', { ...params, store_ids: [shop.id], history_months: 4 });
  assert.equal(longer.items[0].history_reliable_from, '2026-11-01T00:00:00.000Z');
  assert.deepEqual(longer.items[0].rows.map((row: any) => row.new_customer_reliability), ['low', 'low', 'high']);
});

test('AN10 HTTP rejects a nonzero sample below the recommendation threshold', async t => {
  const { run, seed } = await fixture(t);
  const published_at = '2026-10-01T00:00:00Z';
  await seed(async ctx => {
    await ctx.insert('account', 'social_account', { provider: 'youtube', default_timezone: 'UTC' }, 'channel');
    await ctx.insert('execution', 'platform_post', { social_account_id: 'channel', platform: 'youtube', content_type: 'video', published_at }, 'post');
  });
  await run('analytics', 'record_observations', { observations: [{ metric_key: 'norm.post.engagements', subject_id: 'post',
    subject_type: 'platform_post', platform: 'youtube', published_at, observed_at: '2026-10-02T00:00:00Z',
    value: 7, dims: { traffic_source: 'organic' }, availability: 'observed', source: { method: 'manual' } }] });
  const suggestion = await run('analytics', 'posting_time_suggest', { social_account_id: 'channel', content_type: 'video', period });
  assert.equal(suggestion.status, 'insufficient_sample');
  assert.equal(suggestion.reason, 'INSUFFICIENT_COMPARABLE_OBSERVATIONS');
  assert.equal(suggestion.sample_size, 1);
  assert.equal(suggestion.minimum_sample_size, 30);
  assert.deepEqual(suggestion.slots, []);
});

test('AN04 HTTP keeps the transaction fact unique when UTM, discount, and reported credit overlap', async t => {
  const { run, seed, request, createStore } = await fixture(t);
  const shop = await createStore('shopify');
  t.mock.timers.setTime(Date.parse('2026-07-01T00:00:00Z'));
  await seed(async ctx => {
    await ctx.insert('traffic', 'short_link', {}, 'link');
    await ctx.insert('traffic', 'short_link_revision', { short_link_id: 'link', utm_params: { utm_campaign: 'launch', utm_content: 'clip' } }, 'revision');
  });
  t.mock.timers.setTime(Date.parse(now));
  const canonicalId = 'canonical';
  const unattributedId = 'unattributed';
  await seed(async ctx => {
    const base = { store_id: shop.id, currency: 'USD', financial_status: 'paid' };
    const order = await ctx.insert('commerce', 'order', { ...base, external_order_id: 'CREDITED', placed_at: '2026-08-10T00:00:00Z', total_minor: 101 }, 'duplicate');
    await ctx.insert('commerce', 'order', { ...base, external_order_id: 'OTHER', placed_at: '2026-08-11T00:00:00Z', total_minor: 49 }, unattributedId);
    await ctx.insert('commerce', 'order', { ...order.data, utm: { campaign: 'launch', content: 'clip' } }, canonicalId);
    await ctx.insert('commerce', 'promotion', { store_id: shop.id, campaign_id: 'promo' }, 'promotion');
    await ctx.insert('commerce', 'discount_usage', { order_id: order.id, promotion_id: 'promotion', code: 'PROMO' }, 'usage');
  });
  const evidence = { order_id: canonicalId, subject_type: 'campaign', subject_id: 'platform', evidence_kind: 'platform_reported',
    source_ref: 'report:1', occurred_at: '2026-08-09T00:00:00Z', reported_amount_minor: 123, currency: 'USD' };
  await run('analytics', 'record_attribution_evidence', evidence);
  assert.equal((await request('analytics', 'record_attribution_evidence', evidence)).statusCode, 409);
  for (const [subject_id, occurred_at] of [['first', '2026-08-08T00:00:00Z'], ['last', '2026-08-09T00:00:00Z']]) {
    await run('analytics', 'record_attribution_evidence', { order_id: canonicalId, subject_type: 'campaign', subject_id,
      evidence_kind: 'touchpoint', source_ref: `touch:${subject_id}`, occurred_at });
  }
  const expectedCredits = {
    link_session: [['link', 101]], discount_code: [['promo', 101]], platform_reported: [['platform', 123]],
    first_touch: [['first', 101]], last_touch: [['last', 101]], linear: [['first', 51], ['last', 50]],
  };
  const model_keys = Object.keys(expectedCredits);
  const query = { period, model_keys };
  const explain = { order_id: 'duplicate', model_keys };
  const result = await run('analytics', 'attribution_query', query);
  const explanation = await run('analytics', 'attribution_explain', explain);
  assert.deepEqual(result.transaction_totals, [{ currency: 'USD', orders: 2, net_order_minor: 150 }]);
  assert.deepEqual(explanation.transaction_totals, [{ currency: 'USD', orders: 1, net_order_minor: 101 }]);
  assert.deepEqual(result.columns.map((column: any) => column.model_key), model_keys);
  assert.deepEqual(explanation.columns.map((column: any) => column.model_key), model_keys);
  for (const [index, [model, credits]] of Object.entries(expectedCredits).entries()) {
    const rows = result.columns[index].rows;
    assert.equal(rows.length, 2);
    const attributed = rows.find((row: any) => row.order_id === canonicalId);
    assert.deepEqual(attributed.credits.map((credit: any) => [credit.credited_subject_id, credit.credited_amount_minor]), credits);
    assert.deepEqual(explanation.columns[index].rows, [attributed]);
    const other = rows.find((row: any) => row.order_id === unattributedId);
    assert.deepEqual(other.credits, []);
    assert.equal(other.unallocated_minor, model === 'platform_reported' ? null : 49);
  }
  assert.ok(result.warnings.includes('POSSIBLE_DOUBLE_CREDIT'));

  // Give both orders the same buyer details while keeping their attribution evidence fixed.
  const buyer = { buyer_name: 'AN04 Fixture Buyer', buyer_email: 'an04-buyer@example.invalid', buyer_phone: '+1-202-555-0147',
    buyer_address: '14 AN04 Fixture Way', postalCode: '99881' };
  const updatedOrders = [canonicalId, unattributedId];
  await seed(async ctx => {
    for (const id of updatedOrders) {
      const original = await ctx.get('commerce', 'order', id);
      assert.ok(original);
      for (const key of Object.keys(buyer)) assert.ok(!Object.hasOwn(original.data, key), key);
      const updated = await ctx.update('commerce', 'order', id, buyer, original.version);
      assert.deepEqual(updated.data, { ...original.data, ...buyer });
    }
  });
  // Only the evidence reference versions for the two edited orders should advance.
  const withUpdatedOrderVersions = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, item) =>
    item?.module === 'commerce' && item.kind === 'order' && updatedOrders.includes(item.id)
      ? { ...item, version: item.version + 1 } : item));
  const updated = await run('analytics', 'attribution_query', query);
  const updatedExplanation = await run('analytics', 'attribution_explain', explain);
  assert.deepEqual(updated, withUpdatedOrderVersions(result));
  assert.deepEqual(updatedExplanation, withUpdatedOrderVersions(explanation));
  const serialized = JSON.stringify([updated, updatedExplanation]);
  for (const [key, value] of Object.entries(buyer)) {
    assert.ok(!serialized.includes(JSON.stringify(key)), `Attribution exposes ${key}`);
    assert.ok(!serialized.includes(value), `Attribution exposes the value of ${key}`);
  }
});

test('AN05 HTTP reads late refunds against the original order day without deducting cancelled sales twice', async t => {
  const { run, seed, createStore } = await fixture(t);
  const query = { period: { from: '2026-08-10', to: '2026-08-11', tz: 'UTC' } };
  const placed_at = '2026-08-10T12:00:00Z';
  const early = '2026-08-11T12:00:00Z';
  const setups = [];
  t.mock.timers.setTime(Date.parse(early));
  for (const [provider, currency, total_major, refund_major, total, refund] of [
    ['shopify', 'USD', '10.50', '2.05', 1050, 205], ['tiktok_shop', 'USD', '7.20', '1.15', 720, 115],
    ['amazon_sp', 'JPY', '1300', '209', 1300, 209], ['shopee', 'TWD', '15.06', '4.02', 1506, 402],
  ] as const) {
    const store = await createStore(provider);
    const apply = async (template_key: string, rows: object[]) => {
      if (provider === 'amazon_sp' || provider === 'shopee') {
        const fields = Object.keys(rows[0]);
        const csv = [fields.join(','), ...rows.map(row => Object.values(row).join(','))].join('\n');
        const batch = await run('commerce', 'preview_import', { store_id: store.id, template_key, csv });
        await run('commerce', 'commit_import', { batch_id: batch.batch_id, expected_version: batch.version });
      } else {
        const normalized = rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => key === 'total_major'
          ? ['total_minor', total] : key === 'amount_major' ? ['amount_minor', value === total_major ? total : refund] : [key, value])));
        const result = await run('commerce', 'apply_settlement_rows', { store_id: store.id, template_key, rows: normalized });
        assert.equal(result.status, 'applied', JSON.stringify(result));
      }
    };
    await apply('order_list', ['CANCELLED', 'ACTIVE'].map(external_order_id => ({ external_order_id, currency, placed_at, total_major,
      financial_status: external_order_id === 'CANCELLED' ? 'cancelled' : 'paid' })));
    setups.push({ store, currency, total_major, refund_major, total, refund, apply });
  }
  const earlyRead = await run('analytics', 'revenue_query', query);
  assert.equal(earlyRead.rows.length, 4);
  assert.ok(earlyRead.rows.every((row: any) => row.refunds_succeeded_minor === null && row.net_sales_minor === null));
  t.mock.timers.setTime(Date.parse(now));
  for (const { store, currency, total_major, refund_major, apply } of setups) {
    await apply('refund_list', [
      { external_order_id: 'CANCELLED', external_refund_id: 'C', amount_major: total_major, status: 'succeeded' },
      { external_order_id: 'ACTIVE', external_refund_id: 'R', amount_major: refund_major, status: 'succeeded' },
      { external_order_id: 'ACTIVE', external_refund_id: 'P', amount_major: refund_major, status: 'pending' },
    ].map(row => ({ ...row, currency, created_at: '2026-10-15T00:00:00Z' })));
    await seed(async ctx => {
      for (const resource of ['orders', 'refunds']) await ctx.insert('commerce', 'coverage_segment', {
        store_id: store.id, resource, status: 'complete', active: true, window_start: query.period.from,
        window_end: query.period.to, as_of: now,
      });
    });
  }
  const lateRead = await run('analytics', 'revenue_query', query);
  const historic = await run('analytics', 'revenue_query', { ...query, data_cutoff_at: early });
  for (const { store, currency, total, refund } of setups) {
    const row = lateRead.rows.find((row: any) => row.store_id === store.id);
    assert.deepEqual([row.day, row.currency, row.order_count, row.refunds_requested_minor, row.refunds_succeeded_minor,
      row.cancellations_minor, row.net_sales_minor, row.coverage.refunds], ['2026-08-10', currency, 2, refund, total + refund, total, total - refund, 1]);
    assert.equal(historic.rows.find((row: any) => row.store_id === store.id).observed_refunds_succeeded_minor, 0);
  }
});
