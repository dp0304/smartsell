import { generateCommandReport } from './report-workflows.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { commands as commerce } from '../commerce/commands.js';
import { commands as ingest } from '../ingest/commands.js';
import { testWorkspace } from '../ingest/test-context.js';
import { commands as analytics } from './commands.js';

const period = { from: '2026-10-01', to: '2026-11-01', tz: 'UTC' };

test('Amazon refund CSV reaches analytics and rollback does not rewrite an existing snapshot', async () => {
  const workspace = testWorkspace();
  const store = await workspace.run(commerce, 'create_store', {
    name: 'Amazon US', provider: 'amazon_sp', default_currency: 'USD', default_locale: 'en-US',
  });
  const order = await workspace.run(commerce, 'preview_import', {
    store_id: store.id, template_key: 'order_list',
    csv: 'external_order_id,placed_at,currency,total_minor,financial_status,buyerEmail,postalCode\n'
      + '123-1234567-1234567,2026-10-12T10:00:00Z,USD,1599,paid,buyer@example.invalid,98101',
  });
  await workspace.run(commerce, 'commit_import', { batch_id: order.batch_id, expected_version: order.version });
  const query = { period, store_ids: [store.id] };
  const read = () => workspace.run(analytics, 'revenue_query', query, { role: 'editor' });
  const initial = await read();
  assert.equal(initial.rows[0].observed_net_sales_minor, 1599);
  assert.equal(initial.rows[0].net_sales_minor, null);

  const refund = await workspace.run(commerce, 'preview_import', {
    store_id: store.id, template_key: 'refund_list',
    csv: 'external_order_id,external_refund_id,created_at,currency,amount_minor,status,postalCode\n'
      + '123-1234567-1234567,refund-01,2026-10-13T14:00:00Z,USD,249,succeeded,98101',
  });
  const committed = await workspace.run(commerce, 'commit_import', { batch_id: refund.batch_id, expected_version: refund.version });
  const refunded = await read();
  assert.equal(refunded.rows[0].observed_net_sales_minor, 1350);
  assert.equal(refunded.rows[0].observed_refunds_succeeded_minor, 249);
  assert.equal(refunded.rows[0].refunds_succeeded_minor, null);
  assert.doesNotMatch(JSON.stringify({ order, refund, commits: workspace.list('commerce', 'import_batch'), events: workspace.events(), refunded }), /buyer@example\.invalid|98101/);
  const window = {
    window_start: `${period.from}T00:00:00Z`, window_end: `${period.to}T00:00:00Z`,
    as_of: '2026-11-19T12:00:00Z', status: 'complete',
  };
  await workspace.run(commerce, 'attest_import_coverage', { batch_id: order.batch_id, ...window });
  const coverage = await workspace.run(commerce, 'attest_import_coverage', { batch_id: refund.batch_id, ...window });
  assert.equal(coverage.data.resource, 'refunds');
  const coverageBefore = await workspace.run(commerce, 'import_coverage_list', { store_id: store.id });
  assert.ok(coverageBefore.items.every((row: { data: { effective: boolean } }) => row.data.effective));
  assert.equal((await read()).rows[0].net_sales_minor, 1350);
  const report = await workspace.run(analytics, 'reports_create', {
    title: 'October storefront revenue', kind: 'social_performance', period, scope: {},
    sections: [{ key: 'net_sales', type: 'table', source: 'revenue', query: { store_ids: [store.id], report_currency: 'USD' } }],
  });
  const draft = await workspace.run({ generate: { roles: ['owner'], run: generateCommandReport } }, 'generate', { report_id: report.id });
  const version = await workspace.run(analytics, 'reports_finalize', { version_id: draft.id, expected_version: draft.version });
  assert.equal(version.data.status, 'finalized');
  assert.equal(version.data.results.net_sales.rows[0].net_sales_minor, 1350);
  await workspace.run(commerce, 'rollback_import', { batch_id: refund.batch_id, expected_version: committed.version });
  const coverageAfter = await workspace.run(commerce, 'import_coverage_list', { store_id: store.id });
  assert.equal(coverageAfter.items.find((row: { id: string }) => row.id === coverage.id).data.effective, false);
  const after = await read();
  assert.equal(after.rows[0].observed_net_sales_minor, 1599);
  assert.equal(after.rows[0].net_sales_minor, null);
  const persisted = workspace.list('analytics', 'report_version').find(row => row.id === version.id);
  assert.deepEqual(persisted?.data.results, version.data.results);

  const emptyReport = await workspace.run(commerce, 'preview_import', {
    store_id: store.id, template_key: 'refund_list',
    csv: 'external_order_id,external_refund_id,created_at,currency,amount_minor,status\n',
  });
  await workspace.run(commerce, 'commit_import', { batch_id: emptyReport.batch_id, expected_version: emptyReport.version });
  await workspace.run(commerce, 'attest_import_coverage', { batch_id: emptyReport.batch_id, ...window });
  const confirmedZero = await read();
  assert.equal(confirmedZero.rows[0].refunds_succeeded_minor, 0);
  assert.equal(confirmedZero.rows[0].net_sales_minor, 1599);

  const statement = {
    store_id: store.id, day: '2026-10-12', tz: 'UTC', currency: 'USD',
    source_report_ref: 'statement-2026-10-12', order_count: 1, order_total_minor: 1599, refunds_succeeded_minor: 249,
  };
  const mismatch = await workspace.run(analytics, 'reconcile_revenue_day', statement);
  assert.equal(mismatch.data.status, 'mismatch');
  assert.equal(mismatch.data.delta.refunds_succeeded_minor, -249);
  assert.equal((await workspace.run(analytics, 'reconcile_revenue_day', statement)).id, mismatch.id);
  assert.equal(workspace.list('ingest', 'quality_issue')[0].data.occurrences, 1);
  const matched = await workspace.run(analytics, 'reconcile_revenue_day', {
    ...statement, source_report_ref: 'statement-corrected-2026-10-12', refunds_succeeded_minor: 0,
  });
  assert.equal(matched.data.status, 'matched');
  assert.equal(workspace.list('ingest', 'quality_issue')[0].data.status, 'resolved');
});

test('ingest exposes genuine zero and unknown to the same analytics query', async () => {
  const workspace = testWorkspace();
  const source = await workspace.run(ingest, 'create_source', {
    name: 'Authorized offline report', provider: 'file_import', kind: 'file_import', method: 'report_import',
    resources: ['post_metrics'], timezone: 'UTC', authorized: true, allowed_uses: { display: true },
  });
  const run = await workspace.run(ingest, 'sync_refresh', {
    data_source_id: source.id, resource: 'post_metrics', from: '2026-11-11T00:00:00Z', to: '2026-11-12T00:00:00Z',
  });
  const sync_run_id = run.id ?? run.sync_run_id;
  const lease = await workspace.run(ingest, 'claim_run', { sync_run_id });
  const fencing_token = lease.fencing_token ?? lease.data.fencing_token;
  await workspace.run(ingest, 'record_metric_page', {
    sync_run_id, fencing_token, last_page: true,
    records: [
      { subject_id: 'post_zero', metric_key: 'views', date: '2026-11-11', value: 0 },
      { subject_id: 'post_unknown', metric_key: 'views', date: '2026-11-11', value: null, availability: 'source_not_provided' },
    ],
  });
  await workspace.run(ingest, 'finish_run', { sync_run_id, fencing_token, status: 'succeeded' });
  const query = (subject_id: string) => workspace.run(analytics, 'metrics_query', {
    metrics: ['views'], subject: { type: 'platform_post', filter: { subject_ids: [subject_id] } },
    time: { from: '2026-11-11', to: '2026-11-12', tz: 'UTC', basis: 'period' },
  }, { role: 'viewer' });
  const zero = await query('post_zero');
  const unknown = await query('post_unknown');
  assert.equal(zero.rows[0].values.views.value, 0);
  assert.equal(zero.rows[0].values.views.availability, 'observed');
  assert.equal(unknown.rows[0].values.views.value, null);
  assert.equal(unknown.rows[0].values.views.availability, 'source_not_provided');
});
