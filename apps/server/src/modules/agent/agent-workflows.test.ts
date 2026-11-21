import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore } from '../../memory.js';
import { commands, evaluateAgentRules, reapAgentJobLeases, recordAgentToolCall, type AgentContext } from './index.js';
import { taskCommands as workspace } from '../workspace/workbench-tasks.js';
import type { Entity, Fields } from '../types.js';

async function fixture() {
  const store = new MemoryStore();
  const token = 'test-session';
  await store.setup({ email: 'owner@example.test', name: 'Owner', passwordHash: 'test', workspaceName: 'Workspace' }, token);
  const { workspaces: [ws] } = (await store.session(token))!;
  let serial = 0;
  return <T>(run: (ctx: AgentContext) => Promise<T>) => store.workspace(token, ws!.id, async unit => {
    const key = String(++serial);
    return await unit.command({ module: 'agent', action: 'test', key, fingerprint: key }, () => run({ ...unit.context,
      now: '2026-01-01T00:00:00.000Z' })) as T;
  });
}

const run = <T = Entity>(ctx: AgentContext, action: string, input: Fields = {}) => commands[action]!.run(ctx, input) as Promise<T>;
const hasCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

test('one claimant wins, leases are credential-bound and expired jobs require reconciliation', async () => {
  const tx = await fixture();
  const job = await tx(ctx => run(ctx, 'jobs_create', { title: 'Prepare an outline' }));
  const claim = (agentClientId: string) => tx(ctx => run({ ...ctx, agentClientId }, 'jobs_claim', {
    agent_job_id: job.id, expected_version: job.version,
  }));
  const claims = await Promise.allSettled([claim('credential-1'), claim('credential-2')]);
  assert.deepEqual(claims.map(result => result.status), ['fulfilled', 'rejected']);
  const leased = (claims[0] as PromiseFulfilledResult<Entity>).value;
  const hb = { agent_job_id: job.id, expected_version: leased.version, fencing_token: leased.data.fencing_token };
  await assert.rejects(tx(ctx => run({ ...ctx, agentClientId: 'credential-2' }, 'jobs_heartbeat', hb)), hasCode('lease_lost'));
  const touched = await tx(ctx => run({ ...ctx, agentClientId: 'credential-1' }, 'jobs_heartbeat', hb));
  await assert.rejects(tx(ctx => run({ ...ctx, agentClientId: 'credential-1' }, 'jobs_heartbeat', hb)), hasCode('version_conflict'));
  await tx(async ctx => {
    await recordAgentToolCall(ctx, { tool: 'legacy_intent', inputHash: 'a'.repeat(64), outcome: 'outcome_unknown', elapsedMs: 3,
      agentJobId: job.id, sideEffect: true });
    return reapAgentJobLeases({ ...ctx, now: '2026-01-01T00:03:00.000Z' });
  });
  await assert.rejects(tx(ctx => run(ctx, 'jobs_claim', { agent_job_id: job.id })), hasCode('invalid_state'));
  await assert.rejects(tx(ctx => run(ctx, 'jobs_reconcile', { agent_job_id: job.id, note: 'Checked' })), hasCode('invalid_state'));
  await tx(async ctx => {
    const [call] = (await run<{ items: Entity[] }>(ctx, 'tool_calls_list')).items;
    await run(ctx, 'tool_calls_reconcile', { tool_call_id: call!.id, expected_version: call!.version, note: 'Confirmed outcome' });
    return run(ctx, 'jobs_reconcile', { agent_job_id: job.id, note: 'Checked', effects_verified: true });
  });
  const second = await tx(ctx => run(ctx, 'jobs_claim', { agent_job_id: job.id }));
  assert.equal(second.data.fencing_token, touched.data.fencing_token + 1);
});

test('change set needs a human approval and preserves a newer workspace edit', async () => {
  const tx = await fixture();
  const createTask = (title: string) => tx(ctx => workspace.create_work_item!.run(ctx, { title }) as Promise<Entity>);
  const first = await createTask('First');
  const second = await createTask('Second');
  const { change_set: proposed } = await tx(ctx => run<{ change_set: Entity }>(ctx, 'change_sets_create', {
    title: 'Rename two tasks', rationale: 'Use consistent labels', items: [first, second].map(row => ({
      target: { module: 'workspace', kind: 'work_item', id: row.id }, operation: 'update', expected_version: row.version,
      patch: { title: `Updated ${row.data.title}` },
    })),
  }));
  const args = { change_set_id: proposed.id, expected_version: proposed.version };
  await assert.rejects(tx(ctx => run(ctx, 'change_sets_apply', args)), hasCode('APPROVAL_REQUIRED'));
  await assert.rejects(tx(ctx => run({ ...ctx, agentClientId: 'mcp-client' }, 'change_sets_approve', args)), hasCode('forbidden'));
  const approved = await tx(ctx => run(ctx, 'change_sets_approve', args));
  await tx(ctx => workspace.update_work_item!.run(ctx, { id: second.id, title: 'New human title', expected_version: second.version }));
  const applied = await tx(ctx => run<{ change_set: Entity; items: Entity[] }>(ctx, 'change_sets_apply', { ...args, expected_version: approved.version }));
  assert.equal(applied.change_set.data.status, 'partially_applied');
  assert.deepEqual(applied.items.map(item => item.data.status), ['applied', 'conflict']);
  assert.equal((await tx(ctx => ctx.get('workspace', 'work_item', second.id)))?.data.title, 'New human title');
});

test('automation rules dry-run without mutation and deduplicate durable events', async () => {
  const tx = await fixture();
  const rule = await tx(ctx => run(ctx, 'automation_rules_create', { name: 'New campaign prep', enabled: true,
    trigger: { kind: 'event', name: 'campaign.campaign.created' }, action: { kind: 'create_agent_job', title: 'Prepare brief' } }));
  const sample = { kind: 'event', name: 'campaign.campaign.created' } as const;
  assert.equal((await tx(ctx => run<{ matches: boolean }>(ctx, 'automation_rules_test', { rule_id: rule.id, sample }))).matches, true);
  assert.deepEqual(await tx(ctx => ctx.list('agent', 'agent_job')), []);
  const event = { ...sample, id: 'event-1', data: {} };
  const first = await tx(ctx => evaluateAgentRules(ctx, event));
  assert.equal(first.items[0]?.data.waiting_reason, 'waiting_for_agent_job');
  assert.deepEqual(await tx(ctx => evaluateAgentRules(ctx, event)), { items: [] });
  assert.equal((await tx(ctx => ctx.list('agent', 'agent_job'))).length, 1);
});
