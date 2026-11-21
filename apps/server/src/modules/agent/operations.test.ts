import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { operations, processAgentEvent, reapJobLeases, type AgentModelServices, type AgentRequestContext, type ModelContext } from './operations.js';

function fixture() {
  let seq = 0;
  const data = new Map<string, Row[]>();
  const ctx: AgentRequestContext & ModelContext = {
    tenantId: 'tenant', workspaceId: 'workspace', actorId: 'owner', role: 'owner', now: '2026-11-19T00:00:00.000Z',
    list: (kind) => data.get(kind) ?? [],
    get(kind, id) {
      const found = ctx.list(kind).find((row) => row.id === id);
      if (!found) throw new Problem(404, 'NOT_FOUND', 'not found');
      return found;
    },
    create(kind, body) {
      const row = { ...body, id: String(++seq), version: 1, created_at: ctx.now, updated_at: ctx.now };
      data.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind, id, patch) {
      const row = ctx.get(kind, id);
      const updated = { ...row, ...patch, version: row.version + 1, updated_at: ctx.now };
      data.set(kind, ctx.list(kind).map((entry) => entry.id === id ? updated : entry));
      return updated;
    },
    remove(kind, id) { data.set(kind, ctx.list(kind).filter((row) => row.id !== id)); },
    emit() {},
  };
  function run<T = Row>(name: string, body: Data = {}, row?: Row, caller: Context = ctx): Promise<T> {
    const operation = operations.find((entry) => entry.name === name)!;
    assert.ok(operation.roles.includes(caller.role));
    return Promise.resolve().then(() => operation.run(caller, { body, query: {}, params: row ? { id: row.id } : {}, expectedVersion: row?.version })) as Promise<T>;
  }
  return { ctx, run };
}

const code = (value: string) => (error: unknown) => error instanceof Problem && error.code === value;

test('only one claim wins, credentials are fenced, and expiry needs review', async () => {
  const { ctx, run } = fixture();
  const open = await run('agent_jobs_create', { title: 'Read weekly report' });
  const client = { ...ctx, agentCredentialId: 'credential-a' };
  const sibling = { ...client, agentCredentialId: 'credential-b' };
  const concurrent = await Promise.allSettled([
    run('agent_jobs_claim', {}, open, client), run('agent_jobs_claim', {}, open, sibling),
  ]);
  const winner = concurrent[0];
  assert.equal(winner?.status, 'fulfilled');
  if (!winner || winner.status !== 'fulfilled') return;
  const claimed = winner.value;
  assert.equal(concurrent[1]?.status, 'rejected');
  assert.equal(claimed.fencing_token, 1);
  assert.equal(claimed.lease_credential_id, undefined);
  await assert.rejects(run('agent_jobs_heartbeat', { fencing_token: 1 }, claimed, sibling), code('LEASE_LOST'));
  ctx.now = '2026-11-19T00:03:00.000Z';
  const expired = reapJobLeases(ctx)[0]!;
  assert.equal(expired.status, 'lease_expired');
  const call = ctx.create('tool_call', { agent_job_id: expired.id, side_effect: true, outcome: 'outcome_unknown' });
  await assert.rejects(run('agent_jobs_reconcile', { verified_no_pending_side_effects: true, note: 'Checked' }, expired), code('INVALID_STATE'));
  ctx.update('tool_call', call.id, { outcome: 'reconciled' });
  const reopened = await run('agent_jobs_reconcile', { verified_no_pending_side_effects: true, note: 'Checked' }, expired);
  const resumed = await run('agent_jobs_claim', {}, reopened);
  assert.equal(resumed.fencing_token, 2);
  assert.equal(ctx.get('work_item', String(resumed.work_item_id)).status, 'in_progress');
});

test('review applies only safe patches with current resource versions', async () => {
  const { ctx, run } = fixture();
  const first = ctx.create('work_item', { type: 'todo', title: 'First', status: 'open', priority: 'normal', source_type: 'manual' });
  const second = ctx.create('work_item', { type: 'todo', title: 'Second', status: 'open', priority: 'normal', source_type: 'manual' });
  const item = (row: Row) => ({ target_type: 'work_item', target_id: row.id, expected_version: row.version, patch: { title: 'Agent suggestion' } });
  await assert.rejects(run('change_sets_create', { title: 'Delete', items: [{ ...item(first), operation: 'delete' }] }), code('UNSUPPORTED_CHANGE_OPERATION'));
  const review = await run<Row & { items: Row[] }>('change_sets_create', { title: 'Draft', items: [item(first), item(second)] });
  assert.deepEqual(review.items[0]?.preview, { title: { before: 'First', after: 'Agent suggestion' } });
  ctx.update('work_item', second.id, { title: 'Human edit' });
  const result = await run<Row & { items: Row[] }>('change_sets_apply', {}, review);
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.items.map((entry) => entry.status), ['applied', 'conflict']);
  assert.equal(ctx.get('work_item', first.id).title, 'Agent suggestion');
  assert.equal(ctx.get('work_item', second.id).title, 'Human edit');
});

test('job reads honor brand scope and an Agent credential cannot review', async () => {
  const { ctx, run } = fixture();
  const brand = ctx.create('brand', { name: 'Restricted brand' });
  const job = await run('agent_jobs_create', { title: 'Restricted report', input_scope: { brand_ids: [brand.id] } });
  const restricted: AgentRequestContext = { ...ctx, canReadWorkspaceResource: (kind) => kind !== 'brand' };
  assert.deepEqual(await run('agent_jobs_list', {}, undefined, restricted), []);
  await assert.rejects(run('agent_jobs_get', {}, job, restricted), code('NOT_FOUND'));
  const client: AgentRequestContext = { ...ctx, agentCredentialId: 'client-a' };
  await assert.rejects(run('agent_jobs_accept', {}, job, client), code('HUMAN_REQUIRED'));
});

test('rule preview is read-only and event delivery creates one durable job', async () => {
  const { ctx, run } = fixture();
  const rule = await run('automation_rules_create', { name: 'Prepare brief', trigger: { type: 'event', event_type: 'campaign.created' }, actions: [{ type: 'create_agent_job', title: 'Draft a brief' }] });
  await run('automation_rules_update', { enabled: true }, rule);
  const preview = await run('automation_rules_test', { type: 'campaign.created' }, rule);
  assert.equal(preview.matched, true);
  assert.equal(ctx.list('rule_run').length, 0);
  const event = { id: 'event-1', type: 'campaign.created' };
  assert.equal(processAgentEvent(ctx, event)[0]?.waiting_reason, 'awaiting_agent_claim');
  processAgentEvent(ctx, event);
  assert.equal(ctx.list('agent_job').length, 1);
});

test('models are opt-in, block unconfirmed egress, mask optional input and count real usage', async () => {
  const { ctx, run } = fixture();
  assert.deepEqual(await run('ai_get_status'), { enabled: false, purposes: [] });
  await assert.rejects(run('agent_assist', { page: 'desk', intent: 'Help' }), code('AI_NOT_CONFIGURED'));
  let calls = 0;
  const services: AgentModelServices = {
    ownsSecret: (_ctx, id) => id === 'workspace-model-key',
    countInputTokens: () => 6,
    async invoke(_ctx, dest, request) {
      calls++;
      assert.equal(dest.protocol, 'openai_chat');
      assert.deepEqual(request.fields.map((value) => value.text), ['Brief', '[masked]']);
      return { output: 'Review suggestion', inputTokens: 6, outputTokens: 2 };
    },
    assistFields(_ctx, _page, _refs, intent) {
      return [{ dataClass: 'public', text: intent }, { dataClass: 'pii', text: 'sensitive', required: false }];
    },
  };
  ctx.agentModelServices = services;
  const provider = await run('model_providers_create', { name: 'Customer model', kind: 'openai_compatible', endpoint: 'https://gateway.example', secret_id: 'workspace-model-key', allowed_data_classes: ['public'] });
  assert.equal(provider.secret_id, undefined);
  await assert.rejects(run('model_providers_update', { status: 'active' }, provider), code('EGRESS_DENIED'));
  assert.equal(calls, 0);
  await run('model_providers_update', { status: 'active', confirm_egress: true }, provider);
  await run('model_routes_create', { model: 'customer-selected', purpose: 'draft', provider_id: provider.id, enabled: true, max_output_tokens: 8 });
  const suggestion = await run('agent_assist', { page: 'desk', intent: 'Brief' });
  assert.equal(suggestion.output, 'Review suggestion');
  assert.equal(calls, 1);
  assert.equal(ctx.list('ai_usage')[0]?.output_tokens, 2);
  assert.equal(ctx.list('usage_event')[0]?.quantity, 8);
});
