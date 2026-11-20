import assert from 'node:assert/strict';
import test from 'node:test';
import { testWorkspace } from '../ingest/test-context.js';
import { type Commands } from '../types.js';
import { commands, handleWorkspaceEvent } from './index.js';

const fixture: Commands = {
  seed: { roles: ['owner'], run: (ctx, input) => ctx.insert(input.module, input.kind, input.data, input.id) },
  event: { roles: ['owner'], run: (ctx, input) => handleWorkspaceEvent(ctx, input.type, input.data) },
};

test('work items enforce versions, transitions, assignment roles and prerequisites', async () => {
  const ws = testWorkspace();
  const task = await ws.run(commands, 'create_work_item', { title: 'Draft Japanese campaign' });
  const prerequisite = await ws.run(commands, 'create_work_item', { title: 'Confirm brief' });
  const linked = await ws.run(commands, 'set_work_item_dependencies', { id: task.id, expected_version: task.version, depends_on_ids: [prerequisite.id] });
  await assert.rejects(ws.run(commands, 'update_work_item', { id: task.id, expected_version: task.version, title: 'Changed' }), { code: 'version_conflict' });
  await assert.rejects(ws.run(commands, 'update_work_item', { id: task.id, expected_version: linked.work_item.version, status: 'in_progress' }), { code: 'invalid_state' });
  await assert.rejects(ws.run(commands, 'create_work_item', { title: 'Assign someone else', assignee_id: 'other' }, { role: 'viewer' }), { status: 403 });
  const started = await ws.run(commands, 'update_work_item', { id: prerequisite.id, expected_version: prerequisite.version, status: 'in_progress' });
  await ws.run(commands, 'complete_work_item', { id: started.id, expected_version: started.version });
  const preview = await ws.run(commands, 'batch_work_items', { items: [{ id: task.id, expected_version: linked.work_item.version, patch: { title: 'Preview' } }] });
  assert.equal(preview.dry_run, true);
  assert.equal((await ws.run(commands, 'get_work_item', { id: task.id })).data.title, 'Draft Japanese campaign');
  assert.ok(ws.events().some(e => e.event === 'workspace.work_item.completed'));
});

test('approval notification reads are independent of deduplicated event work items', async () => {
  const ws = testWorkspace();
  const input = { type: 'core.approval_request.created', data: { request_id: 'approval-1', approver_id: 'reviewer-1' } };
  await ws.run(fixture, 'event', input);
  await ws.run(fixture, 'event', input);
  const myRole = { role: 'reviewer', actorId: 'reviewer-1' } as const;
  const notices = await ws.run(commands, 'list_notifications', {}, myRole);
  assert.equal(notices.total, 1);
  await assert.rejects(ws.run(commands, 'read_notifications', { ids: [notices.items[0].id] }), { status: 404 });
  await ws.run(commands, 'read_notifications', { ids: [notices.items[0].id] }, myRole);
  assert.equal((await ws.run(commands, 'me_inbox', {}, myRole)).items[0].row.data.status, 'open');
  await ws.run(fixture, 'event', { type: 'core.approval_request.approved', data: { request_id: 'approval-1' } });
  assert.equal((await ws.run(commands, 'me_inbox', {}, myRole)).total, 0);
  assert.equal(ws.list('workspace', 'work_item')[0]!.data.completed_by_type, 'system');
});

test('terms expiry creates one administrative task and re-enablement resolves it', async () => {
  const ws = testWorkspace();
  await ws.run(fixture, 'seed', { module: 'ops', kind: 'auto_terms', id: 'v2', data: { status: 'published', terms_version: 'v2' } });
  const stop = { type: 'account.binding.auto_stopped', data: { binding_id: 'binding', reason: 'terms_outdated' } };
  await ws.run(fixture, 'event', stop);
  await ws.run(fixture, 'event', stop);
  const [work] = ws.list('workspace', 'work_item');
  assert.equal(work?.data.dedupe_key, 'terms:binding:v2');
  assert.equal(work?.data.assignee_id, 'owner-1');
  assert.equal(ws.list('workspace', 'work_item').length, 1);
  await ws.run(fixture, 'event', { type: 'account.binding.auto_enabled', data: { binding_id: 'binding' } });
  assert.equal(ws.list('workspace', 'work_item')[0]?.data.completed_by_type, 'system');
});

test('overview combines overlapping emergency stops and keeps independent provider totals', async () => {
  const ws = testWorkspace();
  await ws.run(fixture, 'seed', { module: 'account', kind: 'connector_auto_policy', id: 'connector_auto_policy', data: { halted: true, halted_by_workspace: true } });
  await ws.run(fixture, 'seed', { module: 'ops', kind: 'job_pause_rule', id: 'connector_auto:workspace-1', data: { active: true, scope: 'connector_auto', scope_value: 'workspace-1' } });
  await ws.run(fixture, 'seed', { module: 'execution', kind: 'execution_task', id: 'unknown', data: { status: 'outcome_unknown' } });
  const overview = await ws.run(commands, 'overview_today');
  const stop = overview.items.filter((item: { kind: string }) => item.kind === 'connector_auto_emergency_stop');
  assert.equal(stop.length, 1);
  assert.deepEqual(stop[0].sources, ['workspace', 'ops']);
  assert.equal(overview.providers.find((p: { key: string }) => p.key === 'execution.attention').total, 1);
  assert.equal((await ws.run(commands, 'overview_today', {}, { workspaceId: 'elsewhere' })).total, 0);
});

test('overview summary delegates engagement and traffic to analytics', async () => {
  const ws = testWorkspace();
  const overview = await ws.run(commands, 'overview_summary');
  const byKey = new Map(overview.cards.map((card: { key: string }) => [card.key, card]));
  for (const key of ['engagement', 'traffic']) {
    const card = byKey.get(key) as { availability: string; data: { coverage: unknown; as_of: string } };
    assert.equal(card.availability, 'available');
    assert.ok(card.data.coverage);
    assert.equal(card.data.as_of, overview.as_of);
  }
});

test('overview keeps healthy providers available when another provider fails', async () => {
  const ws = testWorkspace();
  await ws.run(fixture, 'seed', { module: 'execution', kind: 'execution_task', id: 'unknown', data: { status: 'outcome_unknown' } });
  const degraded: Commands = { run: { roles: ['owner'], run(ctx, input) {
    return commands.overview_today!.run({ ...ctx, list(module, kind) {
      if (module === 'ingest') return Promise.reject(new Error('Ingest store unavailable'));
      return ctx.list(module, kind);
    } }, input);
  } } };
  const result = await ws.run(degraded, 'run');
  assert.equal(result.total, 1);
  assert.deepEqual(result.providers.find((p: { key: string }) => p.key === 'ingest.health'), {
    key: 'ingest.health', status: 'unavailable', as_of: result.as_of, total: null,
  });
});

test('onboarding persists shared progress and blocks a mismatched mobile identity', async () => {
  const ws = testWorkspace();
  await ws.run(fixture, 'seed', { module: 'account', kind: 'device', id: 'connector', data: { host_os: 'macos', status: 'online' } });
  await ws.run(fixture, 'seed', { module: 'account', kind: 'account_execution_binding', id: 'binding', data: { mode: 'connector', device_id: 'connector', mobile_app_binding_id: 'app' } });
  await ws.run(fixture, 'seed', { module: 'account', kind: 'mobile_app_binding', id: 'app', data: { status: 'identity_mismatch', mobile_device_id: 'phone' } });
  const result = await ws.run(commands, 'check_onboarding_step', { step_key: 'connector_pairing' });
  assert.equal(result.data.status, 'blocked');
  assert.equal(result.data.check_result.code, 'identity_mismatch');
  await assert.rejects(ws.run(commands, 'skip_onboarding_step', { step_key: 'connector_pairing', skip_reason: 'Later' }), { code: 'invalid_state' });
  const resumed = await ws.run(commands, 'onboarding_status', {}, { actorId: 'admin-2', role: 'admin' });
  assert.equal(resumed.items.find((item: { step_key: string }) => item.step_key === 'connector_pairing').status, 'blocked');
  await ws.run(commands, 'skip_onboarding_step', { step_key: 'history_sync', skip_reason: 'New account' });
  const overview = await ws.run(commands, 'overview_today');
  assert.equal(overview.onboarding.skipped[0].step_key, 'history_sync');
});

test('navigation gates system settings and keeps each AI purpose independent', async () => {
  const ws = testWorkspace();
  await ws.run(fixture, 'seed', { module: 'agent', kind: 'model_provider', id: 'provider-1', data: { enabled: true } });
  await ws.run(fixture, 'seed', { module: 'agent', kind: 'model_route', id: 'draft', data: { purpose: 'draft', enabled: true, provider_id: 'provider-1' } });
  const nav = await ws.run(commands, 'navigation', {}, { role: 'viewer' });
  assert.equal(nav.ai.draft, true);
  assert.equal(nav.ai.translate, false);
  assert.equal(nav.items.some((item: { key: string }) => item.key === 'ops'), false);
});
