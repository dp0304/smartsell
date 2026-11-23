import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [run] = process.argv.slice(2);
assert.ok(run, 'Usage: node verify.mjs runs/<run>');
const text = name => readFile(resolve(run, name), 'utf8');
const json = async name => JSON.parse(await text(name));
const lines = async name => (await text(name)).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
const result = value => value.structuredContent ?? value.content;
const [catalog, discovery, matrix, summary, calls, audit, readbacks, scope] = await Promise.all([
  json('catalog.json'), lines('discovery.jsonl'), json('matrix.json'), json('summary.json'), lines('calls.jsonl'),
  json('audit.json'), lines('readbacks.jsonl'), json('scope.json'),
]);
assert.equal(new URL(scope.origin).hostname, '127.0.0.1');
const indexed = result(discovery[0].response).data;
assert.equal(indexed.reduce((total, module) => total + module.operations, 0), catalog.length);
assert.equal(discovery.length, indexed.length + 1);
for (const { module, operations } of indexed) {
  const response = discovery.find(row => row.args.module === module).response;
  const discovered = result(response).data;
  assert.equal(discovered.length, operations);
  assert.deepEqual(catalog.filter(op => op.module === module).map(op => op.name), discovered.map(op => op.name));
}
assert.equal(new Set(catalog.map(op => op.name)).size, catalog.length);
assert.deepEqual(matrix.map(op => op.name), catalog.map(op => op.name));
assert.equal(summary.discovered, catalog.length);
assert.equal(summary.attempts, calls.length);
assert.equal(summary.uniqueCalled, new Set(calls.map(call => call.operation)).size);
const auditById = new Map(audit.map(({ row }) => [row.id, row]));
assert.equal(auditById.size, audit.length);
const matched = new Set();
const requestIds = new Set(), toolCallIds = new Set();
for (const [index, call] of calls.entries()) {
  assert.equal(call.seq, index + 1);
  assert.equal(call.tool, 'smartsell_operation_call');
  assert.equal(call.args.operation, call.operation);
  assert.ok(Date.parse(call.sentAt) <= Date.parse(call.receivedAt));
  assert.equal(call.requestAudit.status, 'matched');
  const indexed = call.requestAudit.row;
  assert.equal(indexed.request_id, call.requestId);
  assert.equal(indexed.credential_id, scope.credentialId);
  assert.equal(indexed.tool, call.tool);
  assert.equal(indexed.outcome === 'success', !call.isError);
  assert.ok(!requestIds.has(call.requestId) && !toolCallIds.has(indexed.call_id));
  requestIds.add(call.requestId);
  toolCallIds.add(indexed.call_id);
  if (call.isError) assert.equal(indexed.error_code, call.code);
  if (call.status === 'idempotent_replay') assert.equal(indexed.replayed, true);
  if (call.status === 'valid_empty') assert.equal(call.resultCount?.count, 0);
  for (const id of call.audit.ids) {
    const row = auditById.get(id);
    assert.equal(row.action, call.operation);
    assert.equal(row.source, 'mcp');
    assert.equal(row.credential_id, scope.credentialId);
    assert.ok(!matched.has(id));
    matched.add(id);
  }
  if (call.status === 'business_verified') {
    assert.ok(call.response && !call.isError);
    const op = catalog.find(op => op.name === call.operation);
    if (op.method !== 'GET') {
      assert.ok(call.audit.ids.length);
      assert.ok(call.persistedChanges.length);
    }
  }
}
assert.equal(matched.size, audit.length);
assert.equal(summary.auditRequestIdMatches, requestIds.size);
assert.equal(summary.observedNonemptyReadOperations, new Set(calls.filter(call => call.resultCount?.count > 0).map(call => call.operation)).size);
assert.equal(summary.observedZeroReadOperations, new Set(calls.filter(call => call.resultCount?.count === 0).map(call => call.operation)).size);
for (const op of matrix) {
  const attempts = calls.filter(call => call.operation === op.name);
  assert.deepEqual(op.attempts?.map(row => row.seq) ?? [], attempts.map(row => row.seq));
  if (!attempts.length) assert.ok(op.reason && op.reasonCode);
  for (const [index, attempt] of attempts.entries()) {
    assert.equal(op.attempts[index].requestId, attempt.requestId);
    assert.deepEqual(op.attempts[index].resultCount, attempt.resultCount);
  }
}
const verified = matrix.filter(op => op.status === 'business_verified');
assert.equal(summary.observedBusinessSuccesses, verified.length);
assert.equal(summary.discoveredCalled, matrix.filter(op => op.attempts).length);
const checks = new Map(readbacks.map(row => [row.name, row]));
for (const name of ['video_schedule_pending_human', 'video_committed_revision', 'import_confirm', 'local_products',
  'store_has_no_remote_connection', 'source_fields_and_time', 'paired_simulated_device', 'simulated_device_queue', 'owner_download_bytes',
  'plan_committed_to_approval', 'plan_target_cancelled', 'variant_group_history', 'known_mcp_request_id_returns_one',
  'unknown_mcp_request_id_returns_zero', 'no_external_posts']) {
  assert.equal(checks.get(name)?.verified, true, name);
}
const video = checks.get('video_schedule_pending_human').data;
assert.equal(video.plan_status, 'awaiting_approval');
assert.equal(video.platform_post_id, null);
assert.equal(video.execution_status, null);
assert.deepEqual(checks.get('no_external_posts').data, []);
assert.deepEqual(checks.get('unknown_mcp_request_id_returns_zero').data, []);
assert.deepEqual(checks.get('known_mcp_request_id_returns_one').data, [calls[0].requestAudit.row]);
const planTarget = checks.get('plan_committed_to_approval').data;
const cancelled = checks.get('plan_target_cancelled').data;
assert.equal(planTarget.plan_status, 'awaiting_approval');
assert.equal(cancelled.id, planTarget.id);
assert.equal(cancelled.plan_status, 'cancelled');
assert.equal(cancelled.execution_status, null);
assert.equal(cancelled.platform_post_id, null);
if (calls.some(call => call.operation === 'agent_jobs_submit_result')) {
  const comparisons = calls.filter(call => call.operation === 'observations_compare');
  assert.deepEqual(comparisons.map(call => [call.resultCount?.count, call.status]), [[1, 'business_verified'], [0, 'valid_empty']]);
}
assert.ok(calls.some(call => call.operation === 'catalog_list_facts' && call.resultCount?.count === 0));
assert.ok(calls.some(call => call.operation === 'publishing_list_approvals' && call.resultCount?.count > 0));
const batch = checks.get('import_confirm').data;
assert.deepEqual([batch.status, batch.merged_rows, batch.failed_rows], ['merged', 1, 0]);
for (const name of ['file_download', 'publishing_approve']) assert.equal(calls.find(call => call.operation === name)?.code, 'HUMAN_REQUIRED');
const uploaded = calls.find(call => call.operation === 'file_get' && call.status === 'business_verified');
assert.ok(uploaded);
const { createHash } = await import('node:crypto');
const videoBytes = await readFile(resolve(run, 'clip.mp4'));
const videoHash = createHash('sha256').update(videoBytes).digest('hex');
assert.equal(result(uploaded.response).data.sha256, videoHash);
assert.equal(checks.get('owner_download_bytes').data.sha256, videoHash);
assert.equal(checks.get('owner_download_bytes').data.size_bytes, videoBytes.length);
const device = await json('device-fixture.json');
assert.equal(checks.get('simulated_device_queue').data.status, 'queued');
assert.equal(checks.get('simulated_device_queue').data.device_id, device.deviceId);
assert.equal(checks.get('simulated_device_queue').data.id, device.queuedTask);
const captured = await json('collection-source.json');
assert.ok(checks.get('source_fields_and_time').data.items.some(item => item.url === captured.source_url && item.body === JSON.stringify(captured)));
console.log(JSON.stringify({ verified: true, discovered: catalog.length, attempts: calls.length, observedBusinessSuccesses: verified.length,
  indexedToolCalls: requestIds.size, persistedAuditRows: audit.length, targetId: video.id, cancelledPlanTargetId: cancelled.id,
  batchId: batch.id, scheduledAt: video.scheduled_at, deviceId: device.deviceId, deviceTask: device.queuedTask }, null, 2));
