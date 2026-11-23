import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mcpAuditBusinessStatus, mcpCallAuditPage, mcpCallAuditWithCommits, summarizeMcpTarget } from './mcp-call-audit.js';

const occurredAt = '2026-01-01T00:00:00Z';

test('workspace audit filters before stable pagination and projects only permitted fields', () => {
  const credential = randomUUID();
  const rows = Array.from({ length: 102 }, () => ({
    id: randomUUID(), created_at: occurredAt, data: {
      request_id: randomUUID(), credential_id: credential, actor_id: randomUUID(), tool: 'workspace_get_context',
      target: 'GET /context', outcome: 'success', input_hash: 'private-input-hash', token: 'private-token',
      arguments: { body: 'private-body' }, result: { token: 'private-result' }, error_code: 'private-error',
    },
  }));
  const first = mcpCallAuditPage(rows, { credential_id: credential });
  assert.equal(first.data.length, 100);
  const second = mcpCallAuditPage(rows, { credential_id: credential, cursor: first.next_cursor });
  assert.equal(second.data.length, 2);
  assert.equal(second.next_cursor, null);
  const ids = [...first.data, ...second.data].map(row => row.call_id);
  assert.equal(new Set(ids).size, rows.length);
  const row = second.data[1]!;
  const match = mcpCallAuditPage(rows, { request_id: row.request_id, actor_id: row.actor_id, tool: row.tool, outcome: row.outcome });
  for (const filter of [{ actor_id: randomUUID() }, { tool: 'workspace_brand_get' }, { outcome: 'denied' }, { status: 'blocked' }]) {
    assert.deepEqual(mcpCallAuditPage(rows, { request_id: row.request_id, ...filter }).data, []);
  }
  assert.deepEqual(match.data, [second.data[1]]);
  assert.equal(match.data[0]!.error_code, 'TOOL_FAILED');
  assert.doesNotMatch(JSON.stringify(match), /private|input_hash|arguments|result/);
  assert.throws(() => mcpCallAuditPage(rows, { request_id: 'raw-text' }), { status: 422 });
  assert.throws(() => mcpCallAuditPage(rows, { request_id: second.data[1]!.request_id, cursor: first.next_cursor }), { status: 422 });
});

test('an unfinished call only shows a business commit with a unique matching MCP write receipt', async () => {
  const ids = { request_id: randomUUID(), actor_id: randomUUID(), credential_id: randomUUID() };
  const row = { id: randomUUID(), created_at: occurredAt, data: { ...ids, tool: 'smartsell_operation_call',
    operation: 'workspace_brand_create', outcome: 'pending' } };
  const receipt = { ...ids, source: 'mcp', action: 'workspace_brand_create', resource_title: 'private-title' };
  const page = await mcpCallAuditWithCommits([row], { outcome: 'pending' }, () => [receipt]);
  assert.equal(page.data[0]?.outcome, 'pending');
  assert.equal('business_committed' in page.data[0]!, true);
  assert.doesNotMatch(JSON.stringify(page), /private-title|"operation"/);

  const otherCall = { id: randomUUID(), created_at: occurredAt, data: { ...ids, tool: receipt.action, outcome: 'success' } };
  const excluded = [
    await mcpCallAuditWithCommits([row, otherCall], { outcome: 'pending' }, () => [receipt]),
    await mcpCallAuditWithCommits([row], {}, () => [receipt, receipt]),
    await mcpCallAuditWithCommits([row], {}, () => [
      { ...receipt, actor_id: randomUUID() }, { ...receipt, credential_id: randomUUID() },
      { ...receipt, action: 'other_action' }, { ...receipt, source: 'rest' },
    ]),
  ];
  for (const result of excluded) assert.equal('business_committed' in result.data[0]!, false);
  await mcpCallAuditWithCommits([row], { outcome: 'success' }, () => assert.fail('Unneeded read of committed writes'));
});

test('target metadata uses the registered shape and only recognized business associations', () => {
  const workspace = randomUUID();
  const device = randomUUID();
  const task = randomUUID();
  const operation = { name: 'zhihu_stats_create', method: 'POST', path: '/zhihu-stats' };
  const input = { workspace_id: workspace, body: { device_id: device, profile_slug: 'private-profile' } };
  const output = { id: task, device_id: device, profile_slug: 'private-profile' };
  assert.deepEqual(summarizeMcpTarget(operation, input, workspace), { target: 'POST /zhihu-stats' });
  assert.deepEqual(summarizeMcpTarget(operation, input, workspace, output), { target: 'POST /zhihu-stats', task_id: task, device_id: device });
  assert.deepEqual(summarizeMcpTarget(operation, { ...input, workspace_id: randomUUID() }, workspace, output), { target: 'POST /zhihu-stats' });
  assert.equal(mcpAuditBusinessStatus({ submission_status: 'blocked', precheck: 'private' }), 'blocked');
  assert.equal(mcpAuditBusinessStatus({ status: 'arbitrary provider status' }), undefined);
});
