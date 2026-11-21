import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admins, type Commands } from '../types.js';
import { commands } from './commands.js';
import { testWorkspace } from './test-context.js';

const report = { name: 'Authorized report', provider: 'file_import', kind: 'file_import', method: 'report_import', resources: ['post_metrics'],
  timezone: 'America/New_York', authorized: true, allowed_uses: { display: true } };
const window = { from: '2026-11-01T04:00:00Z', to: '2026-11-02T05:00:00Z' };
const zero = { subject_id: 'post-1', metric_key: 'views', date: '2026-11-01', value: 0 };

const runSetup = async (workspace = testWorkspace()) => {
  const source = await workspace.run(commands, 'create_source', report);
  const selection = { data_source_id: source.id, resource: 'post_metrics', ...window };
  const run = await workspace.run(commands, 'sync_refresh', selection, { role: 'editor' });
  const lease = await workspace.run(commands, 'claim_run', { sync_run_id: run.id }, { role: 'editor' });
  return { workspace, source, selection, run, lease: { sync_run_id: run.id, fencing_token: lease.data.fencing_token } };
};

test('partial report preserves page cursor, retry fences the prior holder, and only completion confirms coverage', async () => {
  const { workspace, source, selection, run, lease } = await runSetup();
  await assert.rejects(workspace.run(commands, 'finish_run', { ...lease, status: 'succeeded' }), { code: 'incomplete_run' });
  await workspace.run(commands, 'record_metric_page', { ...lease, records: [zero], last_page: false });
  await workspace.run(commands, 'finish_run', { ...lease, status: 'partially_succeeded' });
  assert.equal(workspace.list('ingest', 'sync_cursor').length, 0);
  assert.equal(workspace.list('ingest', 'data_gap')[0].data.status, 'open');

  const retry = await workspace.run(commands, 'retry_run', { sync_run_id: run.id });
  assert.equal(retry.data.attempt, 2);
  assert.deepEqual(retry.data.cursor_out, { next_page: 2 });
  const next = await workspace.run(commands, 'claim_run', { sync_run_id: run.id }, { actorId: 'new-owner' });
  const unknown = { ...zero, metric_key: 'likes', value: null, availability: 'source_not_provided' };
  await assert.rejects(workspace.run(commands, 'record_metric_page', { ...lease, records: [unknown], last_page: true }), { code: 'lease_lost' });
  const second = { sync_run_id: run.id, fencing_token: next.data.fencing_token };
  await workspace.run(commands, 'record_metric_page', { ...second, page_index: 2, records: [zero, unknown], last_page: true }, { actorId: 'new-owner' });
  await workspace.run(commands, 'finish_run', { ...second, status: 'succeeded' }, { actorId: 'new-owner' });
  assert.equal(workspace.list('ingest', 'sync_cursor')[0].data.high_watermark, '2026-11-02T05:00:00.000Z');
  assert.equal(workspace.list('ingest', 'data_gap')[0].data.status, 'resolved');
  const coverage = await workspace.run(commands, 'get_coverage', selection, { role: 'viewer' });
  assert.equal(coverage.coverage_ratio, 1);
  assert.equal(coverage.segments.length, 1);
  const facts = workspace.list('analytics', 'metric_observation');
  assert.deepEqual(facts.map(row => [row.data.availability, row.data.value]), [['observed', 0], ['source_not_provided', null]]);
  assert.equal(Date.parse(facts[0].data.period_end) - Date.parse(facts[0].data.period_start), 25 * 3_600_000);
  assert.equal(workspace.list('ops', 'usage_event').length, 2);
  const provenance = await workspace.run(commands, 'get_provenance', { observation_id: facts[0].id }, { role: 'viewer' });
  assert.equal(provenance.run_status, 'succeeded');
  assert.equal(provenance.raw_record_status, 'not_retained');
  assert.equal(provenance.data_source_id, source.id);
  assert.ok(workspace.events().some(event => event.event === 'ingest.data_gap.resolved'));
});

test('source authorization, workspace isolation, and normalized records reject unauthorized input before storage', async () => {
  const { workspace, source, selection, lease } = await runSetup();
  await assert.rejects(workspace.run(commands, 'create_source', { ...report, authorized: false }), { code: 'authorization_required' });
  await assert.rejects(workspace.run(commands, 'create_source', { ...report, provider: 'amazon_sp' }), { code: 'invalid_input' });
  await assert.rejects(workspace.run(commands, 'create_source', { ...report, resources: ['orders'] }), { code: 'invalid_input' });
  await assert.rejects(workspace.run(commands, 'sync_refresh', selection, { role: 'viewer' }), { code: 'forbidden' });
  await assert.rejects(workspace.run(commands, 'sync_refresh', selection, { workspaceId: 'others' }), { code: 'not_found' });
  await assert.rejects(workspace.run(commands, 'check_use', { source_ids: [source.id], use: 'export' }), { code: 'EGRESS_BLOCKED' });
  await assert.rejects(workspace.run(commands, 'record_metric_page', { ...lease, records: [zero, { ...zero, buyer_email: 'person@example.invalid' }], last_page: true }), { code: 'invalid_input' });
  await assert.rejects(workspace.run(commands, 'record_metric_page', { ...lease, records: [{ ...zero, value: '0' }], last_page: true }), { code: 'invalid_input' });
  assert.equal(workspace.list('analytics', 'metric_observation').length, 0);
  await assert.rejects(workspace.run(commands, 'record_metric_page', { ...lease, records: [zero], last_page: true }, { beforeWrite(module, kind) {
    if (module === 'ingest' && kind === 'sync_run') throw new Error('test write rejection');
  } }), /test write rejection/);
  assert.equal(workspace.list('analytics', 'metric_observation').length, 0);
});

test('backfill splits retention and skips completed shards, and accepted gaps remain incomplete', async () => {
  const workspace = testWorkspace();
  const source = await workspace.run(commands, 'create_source', { ...report, timezone: 'UTC', history_days: 14 });
  const selection = { data_source_id: source.id, resources: ['post_metrics'], from: '2026-11-01T12:00:00Z', to: '2026-11-19T12:00:00Z' };
  const backfill = await workspace.run(commands, 'start_backfill', selection);
  assert.equal(backfill.runs.length, 2);
  assert.equal(backfill.unavailable[0].data.status, 'unrecoverable');
  assert.equal(backfill.runs[0].data.window_start, '2026-11-05T12:00:00.000Z');
  for (const run of backfill.runs) {
    const claimed = await workspace.run(commands, 'claim_run', { sync_run_id: run.id });
    const lease = { sync_run_id: run.id, fencing_token: claimed.data.fencing_token };
    await workspace.run(commands, 'record_metric_page', { ...lease, records: [], last_page: true });
    await workspace.run(commands, 'finish_run', { ...lease, status: 'succeeded' });
  }
  const progress = await workspace.run(commands, 'backfill_status', { operation_id: backfill.operation_id });
  assert.equal(progress.status, 'partially_succeeded');
  const repeated = await workspace.run(commands, 'start_backfill', selection);
  assert.equal(repeated.runs.length, 0);
  assert.equal(repeated.unavailable[0].id, backfill.unavailable[0].id);
  assert.equal((await workspace.run(commands, 'backfill_status', { operation_id: repeated.operation_id })).status, 'incomplete');

  const other = await workspace.run(commands, 'create_source', { ...report, name: 'Other report' });
  const period = { ...window, data_source_id: other.id, resource: 'post_metrics' };
  const { gaps: [gap] } = await workspace.run(commands, 'scan_coverage', period);
  await workspace.run(commands, 'accept_gap', { data_gap_id: gap.id, reason: 'Report permanently unavailable' });
  const run = await workspace.run(commands, 'sync_refresh', period);
  const claimed = await workspace.run(commands, 'claim_run', { sync_run_id: run.id });
  const lease = { sync_run_id: run.id, fencing_token: claimed.data.fencing_token };
  await workspace.run(commands, 'record_metric_page', { ...lease, records: [], last_page: true });
  await workspace.run(commands, 'finish_run', { ...lease, status: 'succeeded' });
  assert.equal((await workspace.run(commands, 'get_coverage', period)).coverage_ratio, 0);
  assert.equal(workspace.list('ingest', 'sync_cursor').find(row => row.data.data_source_id === other.id)?.data.high_watermark, null);
});

test('initial and revised observations stay intact while quality checks flag drops and stale data', async () => {
  const { workspace, source, selection, lease } = await runSetup();
  await workspace.run(commands, 'record_metric_page', { ...lease, records: [{ ...zero, value: 10 }], last_page: true });
  await workspace.run(commands, 'finish_run', { ...lease, status: 'succeeded' });
  const next = await workspace.run(commands, 'sync_refresh', selection);
  const claimed = await workspace.run(commands, 'claim_run', { sync_run_id: next.id }, { now: '2026-11-19T12:01:00.000Z' });
  const lease2 = { sync_run_id: next.id, fencing_token: claimed.data.fencing_token };
  const now = '2026-11-19T12:02:00.000Z';
  await workspace.run(commands, 'record_metric_page', { ...lease2, records: [zero], last_page: true }, { now });
  await workspace.run(commands, 'finish_run', { ...lease2, status: 'succeeded' }, { now });
  const checks = await workspace.run(commands, 'run_quality_checks', { data_source_id: source.id, resource: 'post_metrics' }, { now: '2026-11-20T00:00:00.000Z' });
  assert.equal(checks.snapshot.freshness, 'stale');
  assert.equal(checks.snapshot.upstream_freshness_confirmed, false);
  assert.deepEqual(workspace.list('ingest', 'quality_issue').map(row => row.data.rule_key), ['negative_cumulative_delta', 'freshness']);
  await workspace.run(commands, 'resolve_quality_issue', { quality_issue_id: checks.issues[0].id, status: 'resolved', reason: 'Compared with source report' });
  assert.deepEqual(workspace.list('analytics', 'metric_observation').map(row => row.data.value), [10, 0]);
});

test('official method requires the current linked grant and read scope at claim and page time', async () => {
  const workspace = testWorkspace();
  const seed: Commands = {
    grant: { roles: admins, async run(ctx, { scopes }) {
      const data = { provider: 'youtube', purpose: 'social', status: 'active', expires_at: '2026-12-19T00:00:00Z', granted_scopes: scopes, external_account_ids: ['channel-1'] };
      const existing = await ctx.get('account', 'connection', 'grant-1');
      if (existing) return ctx.update('account', 'connection', existing.id, data, existing.version);
      await ctx.insert('account', 'social_account', { provider: 'youtube', status: 'active', external_account_id: 'channel-1' }, 'account-1');
      await ctx.insert('account', 'social_account_connection', { social_account_id: 'account-1', connection_id: 'grant-1' });
      return ctx.insert('account', 'connection', data, 'grant-1');
    } },
  };
  const dto = { ...report, kind: 'platform_account', provider: 'youtube', method: 'official_api', resources: ['account_metrics'], social_account_id: 'account-1', connection_id: 'grant-1' };
  await workspace.run(seed, 'grant', { scopes: [] });
  await assert.rejects(workspace.run(commands, 'create_source', dto), { code: 'no_permission' });
  await workspace.run(seed, 'grant', { scopes: ['https://www.googleapis.com/auth/youtube.readonly'] });
  const source = await workspace.run(commands, 'create_source', dto);
  const run = await workspace.run(commands, 'sync_refresh', { ...window, data_source_id: source.id, resource: 'account_metrics' });
  await assert.rejects(workspace.run(commands, 'claim_run', { sync_run_id: run.id }, { role: 'editor' }), { code: 'forbidden' });
  const active = await workspace.run(commands, 'claim_run', { sync_run_id: run.id });
  const lease = { sync_run_id: run.id, fencing_token: active.data.fencing_token };
  await workspace.run(commands, 'defer_run', { ...lease, retry_after_seconds: 60, request_count: 1 });
  await assert.rejects(workspace.run(commands, 'claim_run', { sync_run_id: run.id }), { code: 'run_not_claimable' });
  const resumed = await workspace.run(commands, 'claim_run', { sync_run_id: run.id }, { now: '2026-11-19T12:01:00.000Z' });
  assert.ok(resumed.data.fencing_token > lease.fencing_token);
  await workspace.run(seed, 'grant', { scopes: [] });
  await assert.rejects(workspace.run(commands, 'record_metric_page', { sync_run_id: run.id, fencing_token: resumed.data.fencing_token,
    records: [{ ...zero, subject_id: 'account-1' }], last_page: true }, { now: '2026-11-19T12:01:00.000Z' }), { code: 'no_permission' });
  assert.equal((await workspace.run(commands, 'get_source_capability', { data_source_id: source.id })).reason, 'scope_missing');
});
