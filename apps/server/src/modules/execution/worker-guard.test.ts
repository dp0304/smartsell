import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Context, Problem, Row } from '@smartsell/contracts';
import { hubFixture } from '../worker/fixtures.js';
import { operations as executionOperations } from './ops.js';

const HOUR = 3_600_000;

function call(ctx: Context, name: string, params: Record<string, string>, body: Record<string, unknown> = {}) {
  const operation = executionOperations.find(item => item.name === name);
  if (!operation) throw new Error(`missing ${name}`);
  return operation.run(ctx, { body, params, query: {}, expectedVersion: undefined });
}
const refused = (error: unknown) => {
  assert.equal((error as Problem).code, 'WORKER_ROUTE_TASK');
  assert.equal((error as Problem).status, 409);
  assert.match(String(((error as Problem).details as Row).owner_message), /SmartSell Worker/);
  return true;
};

test('E14: legacy execution actions refuse a Worker-route task and leave the task and its job untouched; cancel still works', async () => {
  const f = hubFixture();
  const target = await f.schedule(2 * HOUR);
  const task = f.task(target.id);
  assert.equal((task.route as Row[])[0]?.executor, 'worker');
  const job = f.jobOf(target.id);
  const before = { task: structuredClone(f.ctx.get('execution_task', task.id)), job: structuredClone(f.job(job.id)) };
  for (const [name, body] of [
    ['publishing_run_now', {}], ['publishing_retry', {}], ['publishing_reconcile', {}], ['publishing_late_decision', { decision: 'run_now' }],
    ['publishing_handover', { reason: 'take over' }], ['publishing_manual_start', {}], ['publishing_manual_abandon', { reason: 'x' }],
    ['publishing_manual_complete', { url: 'https://x.com/lurelab/status/1861234567890123456' }], ['publishing_get_manual_bundle', {}],
  ] as const) {
    assert.throws(() => call(f.ctx, name, { id: task.id }, body), refused, name);
  }
  const register = executionOperations.find(item => item.name === 'posts_register_manual')!;
  assert.throws(() => register.run(f.ctx, { body: { publish_target_id: target.id, permalink: 'https://x.com/lurelab/status/1861234567890123456' }, params: {}, query: {} }), refused);
  assert.deepEqual(f.ctx.get('execution_task', task.id), before.task, 'the task did not move');
  assert.deepEqual(f.job(job.id), before.job, 'the job did not move');
  const detail = call(f.ctx, 'publishing_get_execution', { id: task.id }) as Row;
  assert.deepEqual(detail.allowed_actions, ['cancel'], 'only the Worker-aware cancel is offered');
  // Batches cannot route around the guard.
  const batch = call(f.ctx, 'publishing_preview_execution_batch', {}, { action: 'run_now', task_ids: [task.id] }) as Row;
  assert.equal((batch.items as Row[])[0]?.allowed, false);
  assert.throws(() => call(f.ctx, 'publishing_apply_execution_batch', { id: batch.id }), (error: unknown) => (error as Problem).code === 'BATCH_BLOCKED');
  // Cancel goes through the Worker-aware requestCancellation (§5.10): a queued job is cancelled with the task.
  call(f.ctx, 'publishing_cancel', { id: task.id });
  assert.equal(f.job(job.id).status, 'cancelled');
  assert.equal(f.ctx.get('execution_task', task.id).status, 'cancelled');
});
