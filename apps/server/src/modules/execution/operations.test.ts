import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context, Data, Input, Row } from '@smartsell/contracts';
import { assessTarget } from '../../../../../packages/domain/src/publishing/index.js';
import { frozenRevisionHash } from '../../../../../packages/connector-tasks/src/tasks.js';
import { authorizeConnectorAttempt } from './connector.js';
import { createAdapter } from '../../../../../packages/adapters/src/official.js';
import { startOAuth, completeOAuth, type AccountServices } from '../account/oauth.js';
import { createOperations as createAccountOperations } from '../account/index.js';
import { runPostMaintenance } from './post-maintenance.js';
import { operations } from './ops.js';
import { ensureTask, openAttempt, upsertObservedPost } from './service.js';
import { createExecutionWorker, holdRestoredExecution, releaseExecutionHold, scanExecution, scanWorkspaceExecution } from './worker.js';

function fixture(api = false, manualDate = false, setup?: (ctx: Context, revision: Row, account: Row) => Data) {
  const tables = new Map<string, Row[]>();
  let nextId = 0;
  const ctx: Context = {
    workspaceId: 'workspace', tenantId: 'tenant', actorId: 'operator', role: 'owner', now: '2026-01-01T00:00:00.000Z',
    list: kind => [...(tables.get(kind) ?? [])],
    get(kind, id) {
      const row = ctx.list(kind).find(value => value.id === id);
      if (!row) throw new Error(`${kind} ${id} missing`);
      return row;
    },
    create(kind, values) {
      const row = { ...structuredClone(values), id: `row-${++nextId}`, version: 1, created_at: ctx.now, updated_at: ctx.now };
      tables.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind, id, values) {
      const existing = ctx.get(kind, id);
      const row = { ...existing, ...structuredClone(values), version: existing.version + 1, updated_at: ctx.now };
      tables.set(kind, ctx.list(kind).map(value => value.id === id ? row : value));
      return row;
    },
    remove(kind, id) { tables.set(kind, ctx.list(kind).filter(row => row.id !== id)); },
    emit() {},
  };
  const account = ctx.create('social_account', { provider: 'instagram', status: 'active' });
  const variant = ctx.create('content_variant', { platform: 'instagram', content_item_id: 'item' });
  const revision = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'revision-hash', rendered: { text: 'Approved text' } });
  ctx.update('content_variant', variant.id, { current_revision_id: revision.id });
  if (api) {
    const connection = ctx.create('connection', { status: 'active' });
    ctx.create('capability', { social_account_id: account.id, connection_id: connection.id, operation: 'publish', content_format: 'text', status: 'available', executors: ['api'] });
  }
  const extra = setup?.(ctx, revision, account);
  let target = ctx.create('publish_target', { social_account_id: account.id, content_item_id: 'item', content_variant_id: variant.id, variant_revision_id: revision.id,
    content_format: 'text', operation: 'publish', plan_status: 'ready', scheduled_at: manualDate ? null : ctx.now,
    schedule_kind: manualDate ? 'manual_date' : 'exact', local_scheduled_at: manualDate ? '2026-01-01' : null, schedule_tz: 'UTC', snapshot_generation: 1, ...extra });
  const { hash } = assessTarget(ctx, target, 'approval');
  const approval = ctx.create('approval_request', { resource_type: 'planning.publish_target', resource_id: target.id, resource_hash: hash, status: 'approved' });
  target = ctx.update('publish_target', target.id, { frozen_hash: hash, approval_request_id: approval.id });
  const task = ensureTask(ctx, target);
  const invoke = (name: string, id = task.id, body: Data = {}) => {
    const op = operations.find(operation => operation.name === name);
    assert.ok(op, name);
    const input: Input = { body, params: { id }, query: {} };
    return op.run(ctx, input);
  };
  const transact = async <T>(run: (transaction: Context) => T) => run(ctx);
  return { ctx, task, target, approval, invoke, transact };
}

test('an owner bearer credential cannot backfill manual evidence or hand work over in a batch', () => {
  const { ctx, invoke, task, target } = fixture();
  Object.assign(ctx, { agentCredentialId: 'pat' });
  assert.throws(() => invoke('publishing_manual_complete'), { code: 'PERMISSION_DENIED' });
  assert.throws(() => invoke('posts_register_manual', task.id, { publish_target_id: target.id, permalink: 'https://www.instagram.com/p/agent/' }), { code: 'HUMAN_REQUIRED' });
  assert.throws(() => invoke('publishing_preview_execution_batch', task.id, { action: 'handover', reason: 'handoff', task_ids: [task.id] }), { code: 'PERMISSION_DENIED' });
  assert.equal(ctx.list('execution_batch').length, 0);
});

test('the preview owner needs a human session to replay an applied handover batch', () => {
  const { ctx, invoke, task } = fixture();
  const preview = invoke('publishing_preview_execution_batch', task.id, { action: 'handover', reason: 'handoff', task_ids: [task.id] }) as Row;
  const applied = invoke('publishing_apply_execution_batch', preview.id) as Row;
  assert.ok(applied.operation_id);
  assert.deepEqual(invoke('publishing_apply_execution_batch', preview.id), applied);
  Object.assign(ctx, { agentCredentialId: 'pat' });
  assert.throws(() => invoke('publishing_apply_execution_batch', preview.id), { code: 'PERMISSION_DENIED' });
  assert.equal(ctx.list('operation').length, 1);
});

test('the workspace scheduler sends due work to manual when no executor is configured', () => {
  const { ctx, task } = fixture(true);
  scanWorkspaceExecution(ctx);
  assert.equal(ctx.get('execution_task', task.id).status, 'manual');
  assert.equal(ctx.get('execution_task', task.id).status_reason, 'no_configured_executor');
  assert.equal(ctx.list('execution_attempt').length, 0);
  assert.equal(ctx.list('platform_post').length, 0);
});

test('configured connector dispatch binds the signed claim to the approved task and fencing slot', async () => {
  const sha256 = 'a'.repeat(64);
  const { ctx, task, target, approval, transact } = fixture(false, false, (ctx, revision, account) => {
    ctx.update('social_account', account.id, { provider: 'meta_instagram', external_account_id: 'owned' });
    const device = ctx.create('connector_device', { status: 'active', last_seen_at: ctx.now });
    const phone = ctx.create('mobile_device', { device_id: device.id, platform: 'android', status: 'ready', last_seen_at: ctx.now });
    ctx.create('mobile_app_binding', { device_id: device.id, mobile_device_id: phone.id, social_account_id: account.id, app: 'instagram', status: 'verified' });
    ctx.create('account_execution_binding', { social_account_id: account.id, device_id: device.id, mode: 'connector',
      connector_mode: 'assist', connector_channel: 'mobile', mobile_device_id: phone.id, mobile_app: 'instagram' });
    ctx.create('capability', { social_account_id: account.id, operation: 'publish', content_format: 'image', status: 'available', executor: 'connector' });
    const asset = ctx.create('asset', { status: 'ready' });
    const file = ctx.create('file_object', { sha256, mime_type: 'image/jpeg', scan_status: 'clean' });
    const version = ctx.create('asset_version', { asset_id: asset.id, file_object_id: file.id, sha256 });
    const grant = ctx.create('rights_grant', { status: 'active' });
    const terms = ctx.create('rights_grant_revision', { rights_grant_id: grant.id, usages: ['organic_social'], valid_from: ctx.now });
    ctx.update('rights_grant', grant.id, { active_revision_id: terms.id });
    ctx.create('rights_grant_asset', { rights_grant_id: grant.id, asset_id: asset.id, version_scope: 'all_versions' });
    ctx.update('content_revision', revision.id, { media: [{ asset_version_id: version.id }] });
    return { content_format: 'image' };
  });
  let memberActive = true;
  Object.assign(ctx, { isActiveWorkspaceMember: (id: string) => id === ctx.actorId && memberActive });
  const grant = ctx.create('standing_grant', { status: 'active', grantee_id: ctx.actorId, grantee_type: 'user',
    actions: ['planning.target.approve'], valid_from: ctx.now });
  ctx.update('approval_request', approval.id, { standing_grant_id: grant.id,
    context: { submitted_by: ctx.actorId, submitted_by_type: 'user' } });
  const worker = createExecutionWorker(transact, [], {
    services: { connectorConfigured: () => true },
    encode(ctx, execution, binding) {
      const media = ctx.list('asset_version').map(row => ({ id: row.id, sha256 }));
      const revision = { id: String(target.variant_revision_id), title: '', body: 'Approved text', tags: [], visibility: 'public' as const, media };
      const frozen_hash = frozenRevisionHash(revision);
      return { schema_version: 1, workspace_id: ctx.workspaceId, connector_device_id: String(binding.device_id), account_id: String(execution.social_account_id),
        binding_id: binding.id, platform_identity: 'owned', kind: 'instagram.app.publish',
        target: { channel: 'mobile', app: 'instagram', mobile_device_id: String(binding.mobile_device_id) },
        payload: { revision, approval: { id: String(target.approval_request_id), resource_hash: frozen_hash }, frozen_hash } };
    },
  });
  await worker.dispatch(task.id);
  const [claim] = ctx.list('connector_task');
  assert.ok(claim);
  const wire = claim.task as Parameters<typeof authorizeConnectorAttempt>[1];
  const fence = Number(claim.fencing_token), slot = Number(claim.write_slot_token);
  assert.equal(authorizeConnectorAttempt(ctx, wire, fence, slot), true);
  assert.equal(authorizeConnectorAttempt(ctx, { ...wire, platform_identity: 'different' }, fence, slot), false);
  assert.equal(authorizeConnectorAttempt(ctx, wire, fence, slot + 1), false);
  memberActive = false;
  assert.equal(authorizeConnectorAttempt(ctx, wire, fence, slot), false);
  memberActive = true;
  ctx.update('approval_request', String(target.approval_request_id), { status: 'invalidated' });
  assert.equal(authorizeConnectorAttempt(ctx, wire, fence, slot), false);
  assert.equal(ctx.list('platform_post').length, 0);
});

test('a claimed connector cannot be replaced and its accepted report still requires read-back', async () => {
  const { ctx, task, invoke, transact } = fixture(true);
  const opened = openAttempt(ctx, task, 'connector', 'fixture-device');
  const binding = ctx.create('account_execution_binding', { social_account_id: task.social_account_id });
  const connector = ctx.create('connector_task', { attempt_id: opened.attempt.id, binding_id: binding.id,
    social_account_id: task.social_account_id, status: 'claimed' });
  assert.throws(() => invoke('publishing_handover'), { code: 'OUTCOME_UNKNOWN' });
  ctx.update('connector_task', connector.id, { status: 'outcome_unknown', result: { kind: 'accepted', submitted_by: 'human', platform_post_id: 'remote' } });
  scanWorkspaceExecution(ctx);
  assert.equal(ctx.get('execution_task', task.id).status, 'accepted');
  assert.equal(ctx.list('platform_post').length, 0);
  const worker = createExecutionWorker(transact, [{ provider: 'instagram', async submit() { throw new Error('must never resubmit'); },
    async observe() { throw new Error('must use connector read-back'); },
    async observeConnector(_request, candidate) {
      assert.equal(candidate?.platform_post_id, 'remote');
      return { status: 'published', external_post_id: 'remote' };
    },
  }]);
  await worker.reconcile(task.id);
  assert.equal(ctx.get('execution_task', task.id).status, 'published');
  assert.equal(ctx.get('connector_task', connector.id).verification_result, 'verified');
  assert.equal(ctx.list('platform_post')[0].submitted_by, 'human');
  assert.equal(ctx.list('execution_attempt').length, 1);
});

test('platform read-back deduplicates native posts and tracks removal without closing a plan', () => {
  const { ctx, task, target, invoke } = fixture(true);
  const observed_at = ctx.now;
  const first = upsertObservedPost(ctx, String(task.social_account_id), { external_post_id: 'native-post', permalink: 'https://www.instagram.com/p/native/' });
  const watch = invoke('posts_set_watch', first.id, { watch_until: '2026-01-02T00:00:00Z' }) as Row;
  ctx.now = '2026-01-01T00:01:00.000Z';
  const removed = upsertObservedPost(ctx, String(task.social_account_id), { external_post_id: 'native-post', post_status: 'removed_by_platform' });
  const stale = upsertObservedPost(ctx, String(task.social_account_id), { external_post_id: 'native-post', post_status: 'live', observed_at });
  assert.equal(removed.id, first.id);
  assert.equal(removed.origin, 'native');
  assert.equal(stale.post_status, 'removed_by_platform');
  assert.equal(ctx.get('post_watch', watch.id).status, 'completed');
  assert.equal(ctx.get('publish_target', target.id).plan_status, 'ready');
});

test('unconfigured execution stays manual and evidence is linked to the original attempt', async () => {
  const { ctx, task, target, invoke, transact } = fixture(true);
  await createExecutionWorker(transact).dispatch(task.id);
  assert.equal(ctx.get('execution_task', task.id).status, 'manual');
  assert.equal(ctx.list('execution_attempt').length, 0);
  await invoke('publishing_manual_start');
  const bundle = await invoke('publishing_get_manual_bundle') as Data;
  const evidence = ctx.create('file_object', { purpose: 'evidence', scan_status: 'clean' });
  await invoke('publishing_manual_complete', task.id, { permalink: 'https://www.instagram.com/p/record/', evidence_file_ids: [evidence.id] });
  assert.equal(ctx.get('publish_target', target.id).plan_status, 'closed');
  assert.equal(ctx.get('execution_task', task.id).status, 'published');
  assert.equal(ctx.list('execution_attempt')[0].id, bundle.attempt_id);
  assert.equal(ctx.list('platform_post')[0].verification, 'manual_confirmed');
  assert.equal(ctx.list('evidence')[0].file_object_id, evidence.id);
});

test('an unknown adapter outcome permits read-back only until complete absence is verified', async () => {
  const { ctx, task, invoke, transact } = fixture(true);
  let sends = 0, complete = false;
  const worker = createExecutionWorker(transact, [{ provider: 'instagram', async submit() { sends++; throw new Error('connection lost'); },
    async observe() { return { status: 'absent', complete_window: complete, delay_elapsed: true }; } }]);
  await worker.dispatch(task.id);
  assert.equal(ctx.get('execution_task', task.id).status, 'outcome_unknown');
  assert.throws(() => invoke('publishing_retry'), { code: 'OUTCOME_UNKNOWN' });
  assert.throws(() => invoke('publishing_handover', task.id, { reason: 'replace' }), { code: 'OUTCOME_UNKNOWN' });
  await worker.dispatch(task.id);
  await worker.reconcile(task.id);
  assert.equal(ctx.get('execution_task', task.id).status, 'outcome_unknown');
  assert.equal(sends, 1);
  complete = true;
  await worker.reconcile(task.id);
  assert.equal(ctx.list('execution_attempt')[0].status, 'verified_absent');
  await invoke('publishing_retry');
  assert.equal(ctx.get('execution_task', task.id).status, 'queued');
  assert.equal(sends, 1);
});

test('cancellation after acceptance stays pending until evidence establishes the live post', async () => {
  const { ctx, task, target, invoke, transact } = fixture(true);
  let sends = 0;
  const worker = createExecutionWorker(transact, [{
    provider: 'instagram',
    async submit() { sends++; return { status: 'accepted', reference: 'receipt-1' }; },
    async observe(_request, receipt) {
      assert.equal(receipt, 'receipt-1');
      return { status: 'published', external_post_id: 'post-1' };
    },
  }]);
  await worker.dispatch(task.id);
  assert.equal(ctx.get('execution_task', task.id).status, 'accepted');
  await invoke('publishing_cancel');
  assert.equal(ctx.get('publish_target', target.id).plan_status, 'cancel_requested');
  assert.equal(ctx.get('execution_task', task.id).status, 'cancel_pending');
  await worker.dispatch(task.id);
  await worker.reconcile(task.id);
  assert.equal(ctx.get('execution_task', task.id).status, 'published');
  assert.equal(ctx.list('platform_post')[0].verification, 'system_verified');
  assert.equal(ctx.list('evidence')[0].kind, 'api_response');
  assert.equal(sends, 1);
});

test('cancelling from preparation fences the adapter before submission', async () => {
  const { ctx, task, invoke, transact } = fixture(true);
  let sends = 0;
  const worker = createExecutionWorker(transact, [{ provider: 'instagram',
    async prepare() { await invoke('publishing_cancel'); },
    async submit() { sends++; return { status: 'accepted', reference: 'receipt-1' }; },
    async observe() { return { status: 'inconclusive' }; },
  }]);
  await worker.dispatch(task.id);
  assert.equal(sends, 0);
  assert.equal(ctx.get('execution_task', task.id).status, 'cancelled');
  assert.equal(ctx.list('execution_attempt')[0].status, 'abandoned');
});

test('manual-date scheduling remains manual even with an API adapter configured', async () => {
  const { ctx, task, invoke, transact } = fixture(true, true);
  const worker = createExecutionWorker(transact, [{ provider: 'instagram',
    async submit() { throw new Error('manual date must never submit'); },
    async observe() { return { status: 'inconclusive' }; },
  }]);
  await worker.dispatch(task.id);
  assert.equal(ctx.list('execution_attempt').length, 0);
  assert.equal(ctx.get('execution_task', task.id).status, 'queued');
  invoke('publishing_run_now');
  assert.equal(ctx.get('execution_task', task.id).status, 'manual');
});

test('applying a batch rechecks approval and invalidates other previews of the changed task', () => {
  const { ctx, task, approval, invoke } = fixture();
  const preview = () => invoke('publishing_preview_execution_batch', task.id, { action: 'run_now', task_ids: [task.id] }) as Row;
  const first = preview(), second = preview();
  ctx.update('approval_request', approval.id, { status: 'invalidated' });
  const applied = invoke('publishing_apply_execution_batch', first.id) as Row;
  const blocked = ctx.get('execution_task', task.id);
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(applied.results, [{ task_id: task.id, task_version: blocked.version, status: 'blocked', status_reason: 'approval_invalid' }]);
  assert.equal(ctx.list('execution_attempt').length, 0);
  assert.throws(() => invoke('publishing_apply_execution_batch', second.id), { code: 'BATCH_STALE' });
});


test('run now uses the configured adapter before the scheduled time and waits for read-back', async () => {
  const { ctx, task, invoke, transact } = fixture(true);
  ctx.now = '2025-12-31T23:59:59.000Z';
  let sends = 0;
  const worker = createExecutionWorker(transact, [{ provider: 'instagram',
    async submit() { sends++; return { status: 'accepted', reference: 'receipt', processing: 'awaiting_creator_action' }; },
    async observe() { return { status: 'published', external_post_id: 'confirmed' }; },
  }]);
  invoke('publishing_run_now');
  assert.equal(ctx.get('execution_task', task.id).status, 'queued');
  assert.deepEqual(await worker.tick(), { processed: 1, failures: [] });
  assert.equal(ctx.get('execution_task', task.id).sub_status, 'awaiting_creator_action');
  assert.deepEqual(await worker.tick(), { processed: 0, failures: [] });
  invoke('publishing_reconcile');
  assert.deepEqual(await worker.tick(), { processed: 1, failures: [] });
  assert.equal(ctx.get('execution_task', task.id).status, 'published');
  assert.equal(sends, 1);
});

test('an expired post-submit lease stays isolated and retains a late adapter receipt for verification', async () => {
  const { ctx, task, invoke, transact } = fixture(true);
  const worker = createExecutionWorker(transact, [{ provider: 'instagram',
    async submit() {
      ctx.now = '2026-01-01T00:11:00.000Z';
      scanExecution(ctx);
      return { status: 'accepted', reference: 'late-receipt' };
    },
    async observe(_request, receipt) {
      assert.equal(receipt, 'late-receipt');
      return { status: 'published', external_post_id: 'verified' };
    },
  }]);
  await worker.dispatch(task.id);
  assert.equal(ctx.get('execution_task', task.id).status, 'outcome_unknown');
  assert.throws(() => invoke('publishing_retry'), { code: 'OUTCOME_UNKNOWN' });
  await worker.reconcile(task.id);
  assert.equal(ctx.get('execution_task', task.id).status, 'published');
});

test('a pre-submit lease expiry backs off and safely retries with a new fence', async () => {
  const { ctx, task, transact } = fixture(true);
  let sends = 0, prepares = 0;
  const worker = createExecutionWorker(transact, [{ provider: 'instagram',
    async prepare() {
      if (prepares++ === 0) ctx.now = '2026-01-01T00:11:00.000Z';
    },
    async submit() { sends++; return { status: 'accepted', reference: 'first-and-only-send' }; },
    async observe() { return { status: 'inconclusive' }; },
  }]);
  await worker.dispatch(task.id);
  scanExecution(ctx);
  assert.equal(ctx.get('execution_task', task.id).status, 'retryable');
  assert.equal(sends, 0);
  ctx.now = '2026-01-01T00:12:00.000Z';
  await worker.tick();
  const [first, second] = ctx.list('execution_attempt');
  assert.equal(first.status, 'abandoned');
  assert.ok(Number(second.fencing_token) > Number(first.fencing_token));
  assert.notEqual(second.client_request_id, first.client_request_id);
  assert.equal(sends, 1);
});

test('incomplete or malformed read-back cannot clear an unknown result', async () => {
  const { ctx, task, invoke, transact } = fixture(true);
  const worker = createExecutionWorker(transact, [{ provider: 'instagram',
    async submit() { return { status: 'unknown' }; },
    async observe() { return { status: 'published', external_post_id: 'external', permalink: 'http://invalid.test' }; },
  }]);
  await worker.dispatch(task.id);
  await worker.reconcile(task.id);
  assert.equal(ctx.list('execution_verification')[0].outcome, 'inconclusive');
  assert.ok(ctx.list('execution_attempt')[0].next_check_at);
  assert.equal(ctx.list('platform_post').length, 0);
  assert.throws(() => invoke('publishing_retry'), { code: 'OUTCOME_UNKNOWN' });
  const file = ctx.create('file_object', { purpose: 'evidence', scan_status: 'clean' });
  const confirmation = { outcome: 'verified_absent', confirmed_no_pending_submission: true, visibility_window_elapsed: true, evidence_file_ids: [file.id] };
  ctx.role = 'agent';
  assert.throws(() => invoke('publishing_reconcile', task.id, confirmation), { code: 'FORBIDDEN' });
  ctx.role = 'owner';
  assert.throws(() => invoke('publishing_reconcile', task.id, { ...confirmation, visibility_window_elapsed: false }), { code: 'INVALID_INPUT' });
  invoke('publishing_reconcile', task.id, confirmation);
  assert.equal(ctx.list('evidence')[0].linked_resource_id, ctx.list('execution_attempt')[0].id);
  assert.equal(ctx.get('execution_task', task.id).status, 'retryable');
});

test('expired manual writes free the account slot and route the original attempt to verification', () => {
  const { ctx, task, invoke } = fixture();
  invoke('publishing_run_now');
  invoke('publishing_manual_start');
  ctx.now = '2026-01-01T00:31:00.000Z';
  scanExecution(ctx);
  assert.equal(ctx.get('execution_task', task.id).status, 'outcome_unknown');
  assert.equal(ctx.list('account_write_slot')[0].holder_id, null);
  assert.throws(() => invoke('publishing_handover'), { code: 'OUTCOME_UNKNOWN' });
  const evidence = ctx.create('file_object', { purpose: 'evidence', scan_status: 'clean' });
  invoke('publishing_manual_complete', task.id, { permalink: 'https://www.instagram.com/p/late/', evidence_file_ids: [evidence.id] });
  assert.equal(ctx.list('execution_attempt').length, 1);
  assert.equal(ctx.get('execution_task', task.id).status, 'published');
});

test('restore release requires checked evidence because the snapshot may predate the attempt', () => {
  const { ctx, task, invoke } = fixture();
  holdRestoredExecution(ctx);
  assert.throws(() => invoke('publishing_cancel'), { code: 'RESTORE_RECONCILE_REQUIRED' });
  const evidence = ctx.create('file_object', { purpose: 'evidence', scan_status: 'clean' });
  const proof = { reason: 'Platform read-back and queue inspection', confirmed_no_pending_submission: true as const, evidence_file_ids: [evidence.id] };
  assert.throws(() => releaseExecutionHold(ctx, task.id, { ...proof, evidence_file_ids: [] }), { code: 'INVALID_INPUT' });
  releaseExecutionHold(ctx, task.id, proof);
  scanExecution(ctx);
  assert.equal(ctx.get('execution_task', task.id).status, 'queued');
});


test('verification obeys configured cadence and does not resend an accepted submission', async () => {
  const { ctx, task, transact } = fixture(true);
  ctx.update('execution_task', task.id, { verify_schedule_seconds: [5, 10] });
  let reads = 0, sends = 0;
  const worker = createExecutionWorker(transact, [{ provider: 'instagram',
    async submit() { sends++; return { status: 'accepted', reference: 'accepted' }; },
    async observe() { reads++; return { status: 'inconclusive' }; },
  }]);
  await worker.tick();
  await worker.tick();
  assert.equal(reads, 0);
  ctx.now = '2026-01-01T00:00:05.000Z';
  await worker.tick();
  assert.equal(reads, 1);
  ctx.now = '2026-01-01T00:00:14.000Z';
  await worker.tick();
  assert.equal(reads, 1);
  ctx.now = '2026-01-01T00:00:15.000Z';
  await worker.tick();
  assert.equal(reads, 2);
  assert.equal(sends, 1);
});

test('an adapter-certified transient rejection permits bounded retry while an account slot stays exclusive', async () => {
  const { ctx, task, target, transact } = fixture(true);
  let sends = 0;
  const second = ctx.create('publish_target', { ...target });
  const approval = ctx.create('approval_request', { resource_type: 'planning.publish_target', resource_id: second.id,
    resource_hash: target.frozen_hash, status: 'approved' });
  const secondTask = ensureTask(ctx, ctx.update('publish_target', second.id, { approval_request_id: approval.id }));
  const worker = createExecutionWorker(transact, [{ provider: 'instagram',
    async prepare(request) {
      if (request.task_id === task.id) await worker.dispatch(secondTask.id);
    },
    async submit() { sends++; return { status: 'not_submitted', error_class: 'rate_limited', evidence: 'Provider rejected before accepting a publish operation' }; },
    async observe() { throw new Error('Rejection must not require read-back'); },
  }]);
  await worker.dispatch(task.id);
  assert.equal(ctx.get('execution_task', task.id).status, 'retryable');
  assert.equal(ctx.get('execution_task', secondTask.id).status, 'queued');
  assert.equal(ctx.list('execution_attempt').length, 1);
  assert.equal(sends, 1);
  assert.ok(ctx.get('execution_task', secondTask.id).next_retry_at);
});


test('manual post operations share the account slot and keep the original publication snapshot', () => {
  const { ctx, task, invoke } = fixture();
  const file = ctx.create('file_object', { purpose: 'evidence', scan_status: 'clean' });
  const account_id = task.social_account_id;
  const permalink = 'https://www.instagram.com/p/native/';
  const post = invoke('posts_register_manual', task.id, { social_account_id: account_id, permalink, evidence_file_ids: [file.id] }) as Row;
  const removal = invoke('posts_request_operation', post.id, { kind: 'delete', reason: 'Remove a stale campaign post' }) as Row;
  invoke('publishing_run_now');
  assert.throws(() => invoke('publishing_manual_start'), { code: 'ACCOUNT_BUSY' });
  invoke('posts_complete_operation', removal.id, { outcome: 'completed', evidence_file_ids: [file.id] });
  assert.equal(ctx.get('platform_post', post.id).post_status, 'deleted');
  assert.equal((ctx.get('post_operation', removal.id).before_snapshot as Row).post_status, 'live');
  invoke('publishing_manual_start');
  assert.equal(ctx.list('execution_attempt')[0].executor, 'manual');
});

test('restore reconciliation can link an already-live post without opening a new write attempt', () => {
  const { ctx, task, target, invoke } = fixture();
  holdRestoredExecution(ctx);
  const file = ctx.create('file_object', { purpose: 'evidence', scan_status: 'clean' });
  const post = invoke('posts_register_manual', task.id, { publish_target_id: target.id,
    permalink: 'https://www.instagram.com/p/already-published/', evidence_file_ids: [file.id] }) as Row;
  assert.equal(post.publish_target_id, target.id);
  assert.equal(ctx.get('execution_task', task.id).status, 'published');
  assert.equal(ctx.get('execution_task', task.id).restore_hold, false);
  assert.equal(ctx.list('account_write_slot').length, 0);
  assert.equal(ctx.list('execution_attempt')[0].purpose, 'backfill');
});


test('native scheduled withdrawal is requested once and only independent proof can confirm cancellation', async () => {
  const { ctx, task, target, invoke, transact } = fixture(true);
  let cancellationRequests = 0, cancelled = false;
  const worker = createExecutionWorker(transact, [{ provider: 'instagram',
    async submit() { return { status: 'accepted', reference: 'scheduled-post', processing: 'scheduled_on_platform' }; },
    async cancelScheduled(_request, receipt) {
      assert.equal(receipt, 'scheduled-post');
      cancellationRequests++;
      throw new Error('Response dropped after sending withdrawal');
    },
    async observe() { return cancelled ? { status: 'cancelled', evidence: 'Platform reports schedule withdrawn' } : { status: 'inconclusive' }; },
  }]);
  await worker.dispatch(task.id);
  invoke('publishing_cancel');
  await worker.tick();
  assert.equal(ctx.get('execution_task', task.id).status, 'cancel_pending');
  assert.equal(ctx.get('publish_target', target.id).plan_status, 'cancel_requested');
  cancelled = true;
  invoke('publishing_reconcile');
  await worker.tick();
  assert.equal(cancellationRequests, 1);
  assert.equal(ctx.get('execution_task', task.id).status, 'cancelled');
  assert.equal(ctx.get('publish_target', target.id).plan_status, 'cancelled');
});


test('rejects an incorrect frozen hash and preserves the original task after a mother draft revision', () => {
  const { ctx, target, task, invoke } = fixture();
  const bad = ctx.create('publish_target', { ...target, frozen_hash: 'wrong', approval_request_id: null });
  assert.throws(() => ensureTask(ctx, bad), { code: 'APPROVAL_INVALID' });
  assert.equal(ctx.list('execution_task').length, 1);
  const variant = ctx.get('content_variant', String(target.content_variant_id));
  const revision = ctx.create('content_revision', { variant_id: variant.id, content_hash: 'new', rendered: { text: 'Unapproved' } });
  ctx.update('content_variant', variant.id, { current_revision_id: revision.id });
  const reread = invoke('publishing_get_execution') as Row;
  assert.deepEqual(reread.frozen, task.frozen);
  assert.equal(reread.frozen_hash, task.frozen_hash);
});

for (const drift of ['price', 'availability']) test(`catalog ${drift} drift after preparation blocks submission and sends the target back for review`, async () => {
  let baseline: Row;
  const { ctx, task, target, approval, transact } = fixture(true, false, (ctx, revision) => {
    const variant = ctx.create('product_variant', { status: 'active' });
    baseline = ctx.create('listing_snapshot', { variant_id: variant.id, market_id: 'TW', channel: 'catalog', currency: 'TWD',
      price_amount_minor: 100, available_for_sale: true, availability: 'observed', is_current: true, observed_at: ctx.now });
    ctx.update('content_revision', revision.id, { product_refs: [{ variant_id: variant.id, market_id: 'TW', listing_snapshot_id: baseline.id, field: 'price', currency: 'TWD' }] });
    return {};
  });
  let sends = 0;
  const worker = createExecutionWorker(transact, [{ provider: 'instagram', async prepare() {
    ctx.update('listing_snapshot', baseline.id, { is_current: false });
    ctx.create('listing_snapshot', { ...baseline, ...(drift === 'price' ? { price_amount_minor: 200 } : { available_for_sale: false }) });
  }, async submit() { sends++; return { status: 'accepted', reference: 'must-not-send' }; }, async observe() { return { status: 'inconclusive' }; } }]);
  await worker.dispatch(task.id);
  assert.equal(sends, 0);
  assert.equal(ctx.get('execution_task', task.id).sub_status, 'precheck_blocked');
  assert.deepEqual(ctx.get('execution_task', task.id).frozen, task.frozen);
  assert.equal(ctx.get('publish_target', target.id).plan_status, 'awaiting_approval');
  assert.equal(ctx.get('approval_request', approval.id).status, 'invalidated');
  assert.equal(ctx.list('execution_attempt')[0].status, 'abandoned');
  assert.equal(ctx.list('account_write_slot')[0].holder_id, null);
});

test('publish queue pause preserves a due task and applies the late policy when resumed', async () => {
  const { ctx, task, transact } = fixture(true, false, () => ({ late_policy: 'skip' }));
  const rule = ctx.create('job_pause_rule', { scope: 'queue', scope_value: 'publish', active: true });
  let sends = 0;
  const worker = createExecutionWorker(transact, [{ provider: 'instagram',
    async submit() { sends++; return { status: 'accepted', reference: 'fixture' }; },
    async observe() { return { status: 'inconclusive' }; },
  }]);
  await worker.tick();
  assert.equal(ctx.get('execution_task', task.id).status, task.status);
  assert.equal(ctx.list('execution_attempt').length, 0);
  ctx.now = '2026-01-01T02:00:00.000Z';
  ctx.update('job_pause_rule', rule.id, { active: false });
  await worker.tick();
  assert.equal(ctx.get('execution_task', task.id).status, 'expired');
  assert.equal(sends, 0);
});

for (const duringPreparation of [false, true]) {
  const boundary = duringPreparation ? 'after claim and before submission' : 'before claim';
  test(`OP02 rechecks standing publication authorization ${boundary}`, async () => {
    const { ctx, task, approval, transact } = fixture(true);
    const grant = ctx.create('standing_grant', { status: 'active', grantee_id: ctx.actorId, grantee_type: 'user',
      actions: ['planning.target.approve'], valid_from: ctx.now });
    ctx.update('approval_request', approval.id, { standing_grant_id: grant.id,
      context: { submitted_by: ctx.actorId, submitted_by_type: 'user' } });
    const revoke = () => ctx.update('standing_grant', grant.id, { status: 'revoked', revoked_at: ctx.now });
    assert.equal(task.status, 'queued');
    let preparations = 0;
    let submissions = 0;
    const worker = createExecutionWorker(transact, [{ provider: 'instagram',
      async prepare() { preparations++; if (duringPreparation) revoke(); },
      async submit() { submissions++; return { status: 'accepted', reference: 'fixture' }; },
      async observe() { return { status: 'inconclusive' }; },
    }]);
    if (!duringPreparation) revoke();
    await worker.dispatch(task.id);
    assert.equal(ctx.get('execution_task', task.id).status_reason, 'approval_invalid');
    assert.equal(preparations, Number(duringPreparation));
    assert.equal(submissions, 0);
    const attempts = ctx.list('execution_attempt');
    assert.deepEqual(attempts.map(attempt => attempt.status), duringPreparation ? ['abandoned'] : []);
    assert.ok(attempts.every(attempt => !attempt.submission_started_at && !attempt.side_effect_possible));
    if (duringPreparation) assert.equal(ctx.list('account_write_slot')[0].holder_id, null);
  });
}

test('OP03 revoking a platform connection blocks an already queued task with zero submissions', async () => {
  const { ctx, task, transact } = fixture(true);
  const connection = ctx.list('connection')[0];
  ctx.create('social_account_connection', { social_account_id: task.social_account_id, connection_id: connection.id, status: 'active' });
  assert.equal(task.status, 'queued');
  const revoke = createAccountOperations({ humanSession: () => true })
    .find(operation => operation.name === 'account_revoke_connection');
  assert.ok(revoke);
  await revoke.run(ctx, { params: { id: connection.id }, query: {}, body: {} });
  assert.equal(ctx.get('connection', connection.id).status, 'revoked');
  assert.equal(ctx.get('connection', connection.id).sealed_token, null);
  assert.equal(ctx.get('execution_task', task.id).status_reason, 'connection_revoked');
  let submissions = 0;
  const worker = createExecutionWorker(transact, [{ provider: 'instagram',
    async submit() { submissions++; return { status: 'accepted', reference: 'fixture' }; },
    async observe() { return { status: 'inconclusive' }; },
  }]);
  await worker.tick();
  await worker.dispatch(task.id);
  assert.equal(submissions, 0);
  assert.equal(ctx.list('execution_attempt').length, 0);
  assert.equal(ctx.list('platform_post').length, 0);
});

test('restore starting during publication preparation fences the claim before submission', async () => {
  const { ctx, task, transact } = fixture(true);
  let sends = 0;
  const worker = createExecutionWorker(transact, [{ provider: 'instagram',
    async prepare() { ctx.create('restore_run', { status: 'restoring' }); },
    async submit() { sends++; return { status: 'accepted', reference: 'fixture' }; },
    async observe() { return { status: 'inconclusive' }; },
  }]);
  await worker.dispatch(task.id);
  assert.equal(sends, 0);
  assert.equal(ctx.get('execution_task', task.id).status, 'queued');
  assert.equal(ctx.list('execution_attempt')[0].status, 'abandoned');
  assert.equal(ctx.list('account_write_slot')[0].holder_id, null);
});

for (const policy of ['skip', 'grace_window', 'notify']) test(`two hours of connector downtime follows ${policy} when the device recovers`, async () => {
  let device: Row;
  const { ctx, task, target, invoke, transact } = fixture(false, false, (ctx, _, account) => {
    device = ctx.create('connector_device', { status: 'offline', last_seen_at: ctx.now });
    const binding = ctx.create('account_execution_binding', { social_account_id: account.id, mode: 'connector', connector_channel: 'browser', device_id: device.id });
    ctx.create('browser_session', { binding_id: binding.id, status: 'verified' });
    ctx.create('capability', { social_account_id: account.id, operation: 'publish', content_format: 'text', status: 'available', executors: ['connector'] });
    ctx.create('execution_setting', { scope_type: 'workspace', scope_id: ctx.workspaceId, late_policy: policy, ...(policy === 'skip' ? {} : { grace_minutes: 30 }) });
    return { schedule_tz: 'Asia/Taipei' };
  });
  const worker = createExecutionWorker(transact);
  await worker.tick();
  assert.equal(ctx.get('execution_task', task.id).sub_status, 'device_offline');
  assert.equal(task.schedule_tz, 'Asia/Taipei');
  assert.equal(task.grace_minutes, policy === 'skip' ? 0 : 30);
  ctx.now = '2026-01-01T02:00:00.000Z';
  await worker.tick();
  assert.equal(ctx.get('execution_task', task.id).sub_status, 'device_offline');
  ctx.update('connector_device', device!.id, { status: 'online', last_seen_at: ctx.now });
  await worker.tick();
  const recovered = invoke('publishing_get_execution') as Row;
  assert.equal(recovered.status, policy === 'notify' ? 'blocked' : 'expired');
  assert.equal(recovered.delay_minutes, 120);
  assert.equal(ctx.list('execution_attempt').length, 0);
  if (policy === 'notify') {
    assert.equal(recovered.sub_status, 'late_awaiting_decision');
    assert.deepEqual(recovered.allowed_actions, ['cancel', 'late_decision']);
    assert.throws(() => invoke('publishing_handover'), { code: 'INVALID_STATE' });
    invoke('publishing_late_decision', task.id, { decision: 'reschedule' });
    await worker.tick();
    assert.equal(ctx.get('execution_task', task.id).sub_status, 'reschedule_requested');
  } else assert.equal(ctx.get('publish_target', target.id).close_reason, 'expired_skipped');
});

for (const deviceState of ['claimed', 'outcome_unknown']) test(`expired connector ${deviceState} stays fenced against API, browser, mobile and manual resend`, async () => {
  const { ctx, task, invoke, transact } = fixture(true);
  const attempt = ctx.create('execution_attempt', { task_id: task.id, executor: 'connector', connector_channel: 'mobile', status: 'claimed', attempt_no: 1 });
  const binding = ctx.create('account_execution_binding', { social_account_id: task.social_account_id });
  ctx.create('connector_task', { attempt_id: attempt.id, status: deviceState, binding_id: binding.id, social_account_id: task.social_account_id });
  ctx.update('execution_task', task.id, { status: 'running', attempt_count: 1, active_attempt_id: attempt.id, lease_expires_at: '2026-01-01T00:01:00Z' });
  ctx.now = '2026-01-01T00:02:00Z';
  let sends = 0;
  const worker = createExecutionWorker(transact, [{ provider: 'instagram', async submit() { sends++; return { status: 'accepted', reference: 'unexpected' }; }, async observe() { return { status: 'inconclusive' }; } }]);
  await worker.tick();
  assert.equal(ctx.get('execution_task', task.id).status, 'outcome_unknown');
  for (const [to_executor, channel] of [['api'], ['connector', 'browser'], ['connector', 'mobile'], ['manual']]) {
    assert.throws(() => invoke('publishing_handover', task.id, { to_executor, channel }), { code: 'OUTCOME_UNKNOWN' });
  }
  assert.throws(() => invoke('publishing_retry'), { code: 'OUTCOME_UNKNOWN' });
  await worker.tick();
  assert.equal(sends, 0);
  assert.equal(ctx.list('execution_attempt').length, 1);
});


test('post maintenance requires a human and preserves the linked publication after verified caption read-back and deletion', () => {
  const { ctx, task, invoke } = fixture();
  const file = ctx.create('file_object', { purpose: 'evidence', scan_status: 'clean' });
  invoke('publishing_run_now');
  invoke('publishing_manual_start');
  invoke('publishing_manual_complete', task.id, { permalink: 'https://www.instagram.com/p/fixture/', evidence_file_ids: [file.id] });
  const beforeTask = invoke('publishing_get_execution') as Row;
  const post = beforeTask.platform_post as Row;
  const body = { kind: 'edit_caption', reason: 'Correct caption', after_payload: { caption: 'Updated caption' } };
  assert.throws(() => invoke('posts_request_operation', post.id, { ...body, expected_version: 0 }), { code: 'VERSION_CONFLICT' });
  Object.assign(ctx, { agentCredentialId: 'pat' });
  assert.throws(() => invoke('posts_request_operation', post.id, body), { code: 'PERMISSION_DENIED' });
  Object.assign(ctx, { agentCredentialId: undefined });
  const edit = invoke('posts_request_operation', post.id, body) as Row;
  const proof = { outcome: 'completed', observed_caption: 'Updated caption', evidence_file_ids: [file.id] };
  ctx.role = 'editor'; ctx.actorId = 'different-operator';
  assert.throws(() => invoke('posts_complete_operation', edit.id, proof), { code: 'FORBIDDEN' });
  ctx.role = 'owner'; ctx.actorId = 'operator';
  assert.throws(() => invoke('posts_complete_operation', edit.id, { ...proof, observed_caption: undefined }), { code: 'INVALID_INPUT' });
  assert.throws(() => invoke('posts_complete_operation', edit.id, { ...proof, observed_caption: 'Different caption' }), { code: 'INVALID_INPUT' });
  const updated = invoke('posts_complete_operation', edit.id, proof) as Row;
  assert.equal(updated.observed_caption, 'Updated caption');
  const deletion = invoke('posts_request_operation', post.id, { kind: 'delete', reason: 'Remove corrected post' }) as Row;
  invoke('posts_complete_operation', deletion.id, { outcome: 'completed', evidence_file_ids: [file.id] });
  const audit = invoke('posts_get', post.id) as Row;
  const publication = audit.publication as Row;
  assert.equal(audit.post_status, 'deleted');
  assert.equal(publication.status, 'published');
  for (const key of ['frozen', 'frozen_hash', 'attempts', 'steps', 'evidence']) assert.deepEqual(publication[key], beforeTask[key]);
  assert.equal((deletion.before_snapshot as Row).caption_snapshot, 'Updated caption');
  assert.equal((audit.post_operations as Row[]).length, 2);
});


test('official YouTube maintenance requires a receipt and independent readback and never retries an unknown delete', async () => {
  const { ctx, invoke, transact } = fixture();
  const scope = 'https://www.googleapis.com/auth/youtube.force-ssl';
  let description = 'Original';
  let present = true;
  let loseDelete = false;
  let writes = 0;
  const adapter = createAdapter('youtube', { phase: 'P1', credentials: { clientId: 'app', clientSecret: 'synthetic' }, async transport(request) {
    const path = new URL(request.url).pathname;
    if (path === '/token') return { status: 200, body: { access_token: 'synthetic', scope, expires_in: 3600 } };
    if (path.endsWith('/channels')) return { status: 200, body: { items: [{ id: 'owned-channel' }] } };
    assert.ok(path.endsWith('/videos'));
    if (request.method === 'GET') return { status: 200, body: { items: present ? [{ id: 'video', snippet: { channelId: 'owned-channel', title: 'Title', categoryId: '22', description } }] : [] } };
    writes++;
    if (request.method === 'PUT') {
      assert.deepEqual(JSON.parse(String(request.body)), { id: 'video', snippet: { title: 'Title', categoryId: '22', description: 'Edited' } });
      return { status: 200, body: { id: 'video' } };
    }
    if (loseDelete) throw new Error('lost receipt');
    return { status: 204 };
  } });
  const services: AccountServices = { adapter: () => adapter, encryptionKey: Buffer.alloc(32, 9), oauthRedirectUri: () => 'https://operator.example/callback' };
  Object.assign(ctx, { postMaintenanceServices: services });
  const brand = ctx.create('brand', { status: 'active' });
  const start = startOAuth(ctx, { brand_id: brand.id, scopes: [scope] }, 'youtube', services);
  const state = new URL(start.authorize_url).searchParams.get('state')!;
  assert.equal((await completeOAuth(ctx, 'youtube', { state, code: 'offline' }, services)).status, 'authorized');
  const account = ctx.create('social_account', { provider: 'youtube', external_account_id: 'owned-channel', status: 'active' });
  const connection = ctx.list('connection')[0];
  const post = ctx.create('platform_post', { social_account_id: account.id, external_post_id: 'video', post_status: 'live', verification: 'system_verified', caption_snapshot: description });
  assert.throws(() => invoke('posts_request_operation', post.id, { kind: 'delete', executor: 'api', reason: 'offline' }), { code: 'CAPABILITY_UNAVAILABLE' });
  ctx.create('social_account_connection', { social_account_id: account.id, connection_id: connection.id, status: 'active' });
  const edit = invoke('posts_request_operation', post.id, { kind: 'edit_caption', executor: 'api', reason: 'offline', after_payload: { caption: 'Edited' } }) as Row;
  await runPostMaintenance(transact, services);
  assert.equal(ctx.get('post_operation', edit.id).status, 'accepted');
  await runPostMaintenance(transact, services);
  assert.equal(ctx.get('platform_post', post.id).caption_snapshot, 'Original');
  description = 'Edited';
  Object.assign(ctx, { now: '2026-01-01T00:01:00.000Z' });
  await runPostMaintenance(transact, services);
  assert.equal(ctx.get('post_operation', edit.id).status, 'verified');
  assert.equal(ctx.get('platform_post', post.id).caption_snapshot, 'Edited');
  const deletion = invoke('posts_request_operation', post.id, { kind: 'delete', executor: 'api', reason: 'offline' }) as Row;
  await runPostMaintenance(transact, services);
  assert.equal(ctx.get('platform_post', post.id).post_status, 'live');
  present = false;
  await runPostMaintenance(transact, services);
  assert.equal(ctx.get('post_operation', deletion.id).status, 'verified');
  assert.equal(ctx.get('platform_post', post.id).post_status, 'deleted');
  assert.equal((ctx.get('post_operation', deletion.id).before_snapshot as Row).post_status, 'live');
  present = true;
  loseDelete = true;
  const another = ctx.create('platform_post', { ...post, id: undefined });
  const uncertain = invoke('posts_request_operation', another.id, { kind: 'delete', executor: 'api', reason: 'offline' }) as Row;
  await runPostMaintenance(transact, services);
  await runPostMaintenance(transact, services);
  assert.equal(ctx.get('post_operation', uncertain.id).status, 'outcome_unknown');
  assert.throws(() => invoke('posts_request_operation', another.id, { kind: 'delete', reason: 'again' }), { code: 'OPERATION_PENDING' });
  assert.equal(writes, 3);
});

test('posts inherit brand, campaign and content from the publish target, else the account brand only', () => {
  const { ctx, task, target, invoke } = fixture(false, false, (setupCtx, _revision, account) => {
    setupCtx.update('social_account', account.id, { brand_id: 'brand-a' });
    return { brand_id: 'brand-a', campaign_id: 'campaign-a' };
  });
  const file = ctx.create('file_object', { purpose: 'evidence', scan_status: 'clean' });
  const account = String(task.social_account_id);
  const native = upsertObservedPost(ctx, account, { external_post_id: 'native-1', permalink: 'https://www.instagram.com/p/native-1/', published_at: ctx.now });
  assert.equal(native.brand_id, 'brand-a');
  assert.ok(!('campaign_id' in native) && !('content_item_id' in native), 'unknown attribution stays absent');
  const standalone = invoke('posts_register_manual', task.id, { social_account_id: account, permalink: 'https://www.instagram.com/p/old/', evidence_file_ids: [file.id] }) as Row;
  assert.deepEqual([standalone.brand_id, standalone.campaign_id, standalone.registered_via, standalone.verification], ['brand-a', undefined, 'human', 'manual_confirmed']);
  invoke('publishing_run_now');
  invoke('publishing_manual_start');
  invoke('publishing_manual_complete', task.id, { permalink: 'https://www.instagram.com/p/linked/', evidence_file_ids: [file.id] });
  const linked = ctx.list('platform_post').find(row => row.publish_target_id === target.id)!;
  assert.deepEqual([linked.brand_id, linked.campaign_id, linked.content_item_id, linked.content_type], ['brand-a', 'campaign-a', 'item', 'text']);
  ctx.update('social_account', account, { brand_id: 'brand-b' });
  assert.equal(upsertObservedPost(ctx, account, { external_post_id: 'native-1', post_status: 'live' }).brand_id, 'brand-a', 'a recorded brand is not rewritten by an account move');
  assert.equal(upsertObservedPost(ctx, account, { external_post_id: 'native-2', published_at: ctx.now }).brand_id, 'brand-b');
});

test('an agent can report an existing external post for metrics but cannot complete or downgrade a publication', () => {
  const { ctx, task, target, invoke } = fixture(false, false, (setupCtx, _revision, account) => {
    setupCtx.update('social_account', account.id, { brand_id: 'brand-a' });
    return { brand_id: 'brand-a' };
  });
  const register = operations.find(operation => operation.name === 'posts_register_manual')!;
  assert.ok(register.roles.includes('agent'));
  assert.notEqual((register as { mcp?: boolean }).mcp, false);
  assert.equal((operations.find(operation => operation.name === 'publishing_manual_complete') as { mcp?: boolean }).mcp, false);
  const account = String(task.social_account_id);
  const report = { social_account_id: account, permalink: 'https://www.instagram.com/p/history/', external_post_id: 'history', published_at: '2025-12-01T10:00:00.000Z' };
  Object.assign(ctx, { agentCredentialId: 'pat' });
  assert.throws(() => invoke('posts_register_manual', task.id, { ...report, published_at: undefined }), { code: 'INVALID_INPUT' });
  const reported = invoke('posts_register_manual', task.id, report) as Row;
  assert.deepEqual([reported.verification, reported.registered_via, reported.origin, reported.brand_id, reported.published_at, reported.submitted_by],
    ['agent_reported', 'agent', 'manual_registered', 'brand-a', report.published_at, undefined]);
  assert.deepEqual(reported.evidence_ids, []);
  assert.throws(() => invoke('posts_register_manual', task.id, { publish_target_id: target.id, permalink: 'https://www.instagram.com/p/target/' }), { code: 'HUMAN_REQUIRED' });
  assert.equal(ctx.get('execution_task', task.id).status, task.status);
  Object.assign(ctx, { agentCredentialId: undefined });
  const file = ctx.create('file_object', { purpose: 'evidence', scan_status: 'clean' });
  const confirmed = invoke('posts_register_manual', task.id, { social_account_id: account, permalink: 'https://www.instagram.com/p/confirmed/', evidence_file_ids: [file.id] }) as Row;
  ctx.role = 'agent';
  const again = invoke('posts_register_manual', task.id, { social_account_id: account, permalink: 'https://www.instagram.com/p/confirmed/', external_post_id: 'confirmed', published_at: ctx.now }) as Row;
  assert.equal(again.id, confirmed.id);
  assert.deepEqual([again.verification, again.registered_via, again.external_post_id], ['manual_confirmed', 'human', 'confirmed']);
  ctx.role = 'owner';
  const upgraded = invoke('posts_register_manual', task.id, { ...report, evidence_file_ids: [file.id] }) as Row;
  assert.deepEqual([upgraded.id, upgraded.verification, upgraded.registered_via], [reported.id, 'manual_confirmed', 'human']);
});
