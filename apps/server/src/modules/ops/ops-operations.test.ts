import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { Problem, type Data, type Row } from '@smartsell/contracts';
import { operations, opsMcpNames } from './index.js';
import { assertEmergencyNotStopped, evaluateEgress, isEmergencyStopped, isJobPaused } from './controls.js';
import { recordHeartbeat, recordProviderObservation } from './deployment.js';
import { assertLicenseAllowed, assertUsageAllowed, getUsage, recordUsage } from './metering.js';
import type { OpsContext, Store } from './support.js';
import { deliverWebhook } from './webhooks.js';

function fixture() {
  let sequence = 0;
  const events: { type: string; data: Data }[] = [];
  function makeStore(): Store {
    const rows = new Map<string, Map<string, Row>>();
    const table = (kind: string) => {
      let found = rows.get(kind);
      if (!found) { found = new Map(); rows.set(kind, found); }
      return found;
    };
    const get = (kind: string, id: string) => {
      const row = table(kind).get(id);
      if (!row) throw new Problem(404, 'not_found', 'Record not found');
      return row;
    };
    return {
      list: kind => [...table(kind).values()], get,
      create(kind, values) {
        const row = { ...values, id: String(++sequence), version: 1, created_at: ctx.now, updated_at: ctx.now };
        table(kind).set(row.id, row);
        return row;
      },
      update(kind, id, values) {
        const prior = get(kind, id);
        const row = { ...prior, ...values, id, version: prior.version + 1, updated_at: ctx.now };
        table(kind).set(id, row);
        return row;
      },
      remove(kind, id) { table(kind).delete(id); },
    };
  }
  const ctx: OpsContext = { ...makeStore(), tenantScope: makeStore(), workspaceId: 'workspace-a', tenantId: 'tenant',
    actorId: 'operator', role: 'owner', tenantRole: 'owner', now: '2026-11-19T12:00:00.000Z', emit: (type, data) => events.push({ type, data }) };
  const sibling: OpsContext = { ...ctx, ...makeStore(), workspaceId: 'workspace-b' };
  const run = <T = Row>(name: string, body: Data = {}, params: Record<string, string> = {}, context = ctx) => {
    const operation = operations.find(item => item.name === name);
    assert.ok(operation);
    return operation.run(context, { body, params, query: {} }) as T;
  };
  return { ctx, sibling, run, events };
}
const problem = (code: string) => (error: unknown) => error instanceof Problem && error.code === code;

test('tenant and workspace emergency stops are independent and preserve Account state', () => {
  const { ctx, sibling, run, events } = fixture();
  const binding = ctx.create('account_execution_binding', { connector_mode: 'auto' });
  ctx.create('connector_auto_policy', { halted_by_workspace: true });
  assert.throws(() => run('ops_emergency_stop', { scope: 'all', reason: 'Incident' }), problem('invalid_input'));
  assert.throws(() => run('ops_emergency_stop', { scope: 'all', reason: 'Incident', confirmed: true }, {}, { ...ctx, role: 'agent' }), problem('forbidden'));
  run('ops_emergency_stop', { scope: ctx.workspaceId, reason: 'Workspace incident', confirmed: true });
  const global = run('ops_emergency_stop', { scope: 'all', reason: 'Tenant incident', confirmed: true });
  assert.equal(run('ops_emergency_stop', { scope: 'all', reason: 'Retry', confirmed: true }).id, global.id);
  assert.throws(() => assertEmergencyNotStopped(sibling), problem('emergency_halt'));
  assert.equal(isJobPaused(ctx, { queue: 'publish' }), false);
  run('ops_resume_connector_auto', { scope: 'all', reason: 'Tenant restored' });
  assert.equal(isEmergencyStopped(sibling), false);
  assert.equal(isEmergencyStopped(ctx), true);
  run('ops_resume_connector_auto', { scope: ctx.workspaceId, reason: 'Workspace restored' });
  assert.equal(isEmergencyStopped(ctx), true);
  assert.equal(ctx.get('account_execution_binding', binding.id).connector_mode, 'auto');
  assert.deepEqual([...opsMcpNames], ['ops_get_health', 'audit_query']);
  assert.equal(events.filter(event => event.type === 'ops.connector_auto.stopped').length, 2);
});

test('usage counts signed gauge deltas, UTC monthly sums, and verified seat quota', () => {
  const { ctx, sibling, run } = fixture();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  ctx.opsServices = { deploymentMode: 'private', offlineLicense: { installFingerprint: 'install', publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() } };
  const payload = JSON.stringify({ install_fingerprint: 'install', modules: ['core'], limits: { seats: { limit: 2, basis: 'license' } },
    valid_from: '2026-01-01T00:00:00Z', valid_until: '2026-12-15T00:00:00Z' });
  const signature = sign(null, Buffer.from(payload), privateKey).toString('base64');
  assert.throws(() => run('ops_install_license_file', { payload: payload.replace('install"', 'other"'), signature }), problem('invalid_input'));
  run('ops_install_license_file', { payload, signature });
  const first = recordUsage(ctx, 'seats', 1, 'member-a');
  recordUsage(sibling, 'seats', 1, 'member-b');
  assert.equal(recordUsage(ctx, 'seats', 1, 'member-a').id, first.id);
  assert.throws(() => assertUsageAllowed(ctx, 'seats', 1), problem('LICENSE_LIMIT'));
  recordUsage(ctx, 'seats', -1, 'member-a-disabled');
  assert.doesNotThrow(() => assertUsageAllowed(ctx, 'seats', 1));
  assert.equal(getUsage(ctx, 'seats').quantity, 2);
  assert.equal(getUsage(ctx, 'seats').current, 1);
  recordUsage(ctx, 'model_tokens', 126, 'model-rollup-1');
  ctx.now = '2026-12-01T00:00:00.000Z';
  assert.equal(getUsage(ctx, 'model_tokens').quantity, 0);
  assert.equal(getUsage(ctx, 'seats').quantity, 1);
  ctx.now = '2026-12-29T00:00:00.000Z';
  assert.throws(() => assertLicenseAllowed(ctx, 'new_side_effect'), problem('LICENSE_READ_ONLY'));
  assert.doesNotThrow(() => assertLicenseAllowed(ctx, 'verify'));
  assert.doesNotThrow(() => assertLicenseAllowed(ctx, 'export'));
});

test('retention applies source TTL and rechecks legal holds and schedule references before purge', () => {
  const { ctx, run } = fixture();
  const first = ctx.create('raw_record', { cache_days: 1 });
  const second = ctx.create('raw_record', { cache_days: 1 });
  const third = ctx.create('raw_record', { cache_days: 1 });
  ctx.create('publish_target', { status: 'scheduled', resource_id: third.id });
  ctx.now = '2026-11-21T12:00:00.000Z';
  const preview = run('ops_preview_purge_run', { data_class: 'raw_record' });
  assert.deepEqual((preview.preview as Data).blocked_by, [{ resource_id: third.id, reasons: ['scheduled_target'] }]);
  ctx.update('raw_record', first.id, { legal_hold: true });
  const result = run('ops_approve_purge_run', {}, { id: preview.id });
  assert.deepEqual(result.purged, [second.id]);
  assert.deepEqual(result.skipped, [first.id]);
  assert.deepEqual(ctx.list('raw_record').map(row => row.id), [first.id, third.id]);
  assert.throws(() => run('ops_set_retention_policy', { data_class: 'store_pii_amazon', retain_days: 31 }), problem('invalid_input'));
  assert.throws(() => run('ops_preview_purge_run', { data_class: 'store_pii_amazon' }), problem('invalid_input'));
});

test('deployment distinguishes stale roles, callback polling, and IP-denied file import', () => {
  const { ctx, run } = fixture();
  ctx.opsServices = { deploymentMode: 'private', probeCallback: () => false };
  recordHeartbeat(ctx, 'server', ['all'], '1.0.0');
  assert.equal(run<Data>('ops_get_deployment_health').roles && (run<Data>('ops_get_deployment_health').roles as Data).worker, 'online');
  ctx.now = '2026-11-19T12:00:30.000Z';
  const health = run<Data>('ops_get_deployment_health');
  assert.equal((health.roles as Data).worker, 'offline');
  assert.equal((health.infrastructure as Data).db, 'unknown');
  const endpoint = run('ops_set_callback_endpoint', { provider: 'shopify', path: '/hook/shopify', connection_id: 'shop' });
  assert.equal(run<Data>('ops_probe_callback_endpoint', {}, { id: endpoint.id }).fallback_polling, false);
  recordProviderObservation(ctx, { provider: 'amazon_sp', connection_id: 'aws', callback: 'missing_prerequisite' });
  const checks = run<Data>('ops_get_deployment_health').provider_checks as Data[];
  assert.deepEqual(checks.map(check => check.fallback), ['file_import', 'fallback_polling']);
  assert.throws(() => run('ops_set_callback_endpoint', { provider: 'amazon_sp', path: '/hook/amazon' }), problem('invalid_input'));
});

test('restore commits safe mode, adopts a confirmed published post, and refuses unknown replay', () => {
  const { ctx, sibling, run } = fixture();
  const policy = run('ops_set_backup_policy', { schedule: '0 1 * * *', retention_days: 7, target: { destination_id: 'off-host' } });
  const request = { slot: '2026-11-19', policy_id: policy.id };
  assert.throws(() => run('ops_create_backup_run', request), problem('ops_capability_unavailable'));
  const decisions: string[] = [];
  ctx.opsServices = {
    createBackup: () => ({ consistent_at: '2026-11-19T11:00:00Z', db_snapshot_ref: 'db', storage_manifest_ref: 'objects', config_ref: 'settings' }),
    restoreBackup: () => { assert.equal(isJobPaused(sibling, { queue: 'publish', side_effect: true }), true); },
    restoreCandidates: (_ctx, since) => {
      assert.equal(since, '2026-11-19T10:00:00.000Z');
      return ['confirmed', 'unknown'].map(resource_id => ({ resource_id, resource_type: 'execution_attempt', db_state: 'queued', domain: 'publish' }));
    },
    reconcile: (_ctx, item) => item.resource_id === 'confirmed' ? { state: 'present', evidence_id: 'receipt' } : { state: 'unknown' },
    applyReconciliation: (_ctx, item, decision) => { decisions.push(`${item.resource_id}:${decision}`); },
  };
  const backup = run('ops_create_backup_run', request);
  assert.equal(run('ops_create_backup_run', request).id, backup.id);
  const restore = run('ops_create_restore_run', { backup_run_id: backup.id });
  const params = { id: restore.id };
  assert.equal(isJobPaused(sibling, { queue: 'publish', side_effect: true }), true);
  run('ops_execute_restore_run', {}, params);
  assert.equal(run('ops_reconcile_restore_run', {}, params).status, 'needs_decision');
  assert.deepEqual(decisions, ['confirmed:adopt_external']);
  const pending = run<Row[]>('ops_list_restore_reconciliation_item', {}, params).find(row => row.decision === 'pending')!;
  assert.throws(() => run('ops_resume_restore_run', {}, params), problem('reconciliation_incomplete'));
  assert.throws(() => run('ops_decide_restore_reconciliation_item', { decision: 'requeue', reason: 'Uncertain' }, { ...params, item_id: pending.id }), problem('external_state_unverified'));
  run('ops_decide_restore_reconciliation_item', { decision: 'manual', reason: 'Investigate offline' }, { ...params, item_id: pending.id });
  assert.equal(run('ops_resume_restore_run', {}, params).status, 'resumed');
  assert.equal(isJobPaused(sibling, { queue: 'publish', side_effect: true }), false);
});

test('egress requires an applicable policy and rejects credentials even with provider consent', () => {
  const { ctx, run } = fixture();
  const destination = { kind: 'model_provider', id: 'model-a' };
  assert.equal(evaluateEgress(ctx, destination, ['content']), 'deny');
  run('ops_set_egress_policy', { rules: [{ destination_kind: 'model_provider', data_class: 'content', effect: 'deny' },
    { destination_kind: 'model_provider', destination_id: 'model-a', data_classes: ['content'], effect: 'allow_masked' }] }, { scope: 'workspace' });
  assert.equal(evaluateEgress(ctx, destination, ['content']), 'allow_masked');
  assert.equal(evaluateEgress(ctx, destination, ['content', 'credential']), 'deny');
  assert.equal(evaluateEgress(ctx, { kind: 'model_provider', id: 'other' }, ['content']), 'deny');
});

test('webhooks sign exact payloads, delay retries, and deduplicate successful delivery', async () => {
  const { ctx, run } = fixture();
  let calls = 0;
  ctx.opsServices = { webhookSigningKey: () => 'test-key', sendWebhook: (_ctx, { body, headers }) => {
    assert.equal(headers['X-SmartSell-Signature'], `sha256=${createHmac('sha256', 'test-key').update(body).digest('hex')}`);
    assert.equal(headers['Idempotency-Key'], 'event-1');
    return { status: ++calls === 1 ? 503 : 204 };
  } };
  const subscription = run('ops_create_webhook_subscription', {
    url: 'https://example.com/hooks', secret_id: 'secret-reference', event_types: ['content.published'],
  });
  assert.equal(subscription.secret_id, undefined);
  run('ops_set_egress_policy', { rules: [{ destination_kind: 'outbound_webhook', destination_id: subscription.id,
    data_class: 'content', effect: 'allow' }] }, { scope: 'workspace' });
  const event = { id: 'event-1', type: 'content.published', data: { resource_id: 'post-1' }, data_classes: ['content'] };
  assert.equal((await deliverWebhook(ctx, subscription.id, event))?.status, 'retrying');
  assert.equal((await deliverWebhook(ctx, subscription.id, event))?.attempt, 1);
  ctx.now = '2026-11-19T12:01:00.000Z';
  assert.equal((await deliverWebhook(ctx, subscription.id, event))?.status, 'delivered');
  assert.equal((await deliverWebhook(ctx, subscription.id, event))?.attempt, 2);
  assert.equal(calls, 2);
});
