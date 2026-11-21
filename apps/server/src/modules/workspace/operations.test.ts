import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Problem, type Data, type Input, type Role, type Row } from '@smartsell/contracts';
import { operations, applyWorkspaceEvent, scanWorkspaceDue, type WorkspaceOverviewContext } from './operations.js';

function fixture() {
  const rows = new Map<string, Row[]>();
  let seq = 0;
  const events: { type: string; data: Data }[] = [];
  const ctx: WorkspaceOverviewContext = {
    workspaceId: 'w1', tenantId: 't1', actorId: 'me', role: 'owner', now: '2026-11-19T08:00:00.000Z',
    list: kind => rows.get(kind) ?? [],
    get(kind, id) {
      const row = ctx.list(kind).find(item => item.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', 'Missing row');
      return row;
    },
    create(kind, values) {
      const row = { ...values, id: `r${++seq}`, version: 1, created_at: ctx.now, updated_at: ctx.now };
      rows.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind, id, patch) {
      const previous = ctx.get(kind, id);
      const row = { ...previous, ...patch, id, version: previous.version + 1, updated_at: ctx.now };
      rows.set(kind, ctx.list(kind).map(item => item.id === id ? row : item));
      return row;
    },
    remove(kind, id) { rows.set(kind, ctx.list(kind).filter(item => item.id !== id)); },
    emit(type, data) { events.push({ type, data }); },
  };
  function run<T = Row>(name: string, input: Partial<Input> = {}) {
    const op = operations.find(item => item.name === name)!;
    assert.ok(op.roles.includes(ctx.role));
    return op.run(ctx, { body: {}, params: {}, query: {}, ...input }) as T;
  }
  function actor(id: string, role: Role = 'owner') { ctx.actorId = id; ctx.role = role; }
  return { ctx, run, events, actor };
}

const error = (status: number) => (reason: unknown) => reason instanceof Problem && reason.status === status;

test('brand and market maintain references and UI locale stays independent of content language', () => {
  const { ctx, run } = fixture();
  const brand = run('workspace_brand_create', { body: { name: 'Example', slug: 'example' } });
  assert.throws(() => run('workspace_brand_create', { body: { name: 'Duplicate', slug: 'example' } }), error(409));
  const market = run('workspace_market_create', { params: { id: brand.id }, body: { name: 'Japan', country_code: 'jp', primary_language: 'ja-jp', currency: 'jpy', timezone: 'Asia/Tokyo' } });
  run('workspace_update', { body: { default_ui_locale: 'en' } });
  assert.equal(run('workspace_get_context').ui_locale, 'en');
  assert.equal(ctx.get('market', market.id).primary_language, 'ja-JP');
  const target = ctx.create('publish_target', { brand_id: brand.id, plan_status: 'ready' });
  assert.equal(run<{ impact: { count: number }[] }>('workspace_brand_archive', { params: { id: brand.id } }).impact[0]?.count, 1);
  assert.throws(() => run('workspace_brand_archive', { params: { id: brand.id }, body: { dry_run: false } }), error(409));
  ctx.update('publish_target', target.id, { status: 'cancelled', plan_status: 'cancelled' });
  run('workspace_brand_archive', { params: { id: brand.id }, body: { dry_run: false } });
  assert.equal(ctx.get('brand', brand.id).status, 'archived');
});

test('work items support batch preview, dependency cycles, assignment and versioned transitions', () => {
  const { ctx, run, actor } = fixture();
  const first = run('tasks_create', { body: { title: 'First' } });
  const second = run('tasks_create', { body: { title: 'Second', assignee_id: 'other' } });
  run('tasks_dependencies', { params: { id: second.id }, body: { depends_on_ids: [first.id] } });
  assert.throws(() => run('tasks_dependencies', { params: { id: first.id }, body: { depends_on_ids: [second.id] } }), error(409));
  assert.throws(() => run('tasks_update', { params: { id: second.id }, body: { status: 'in_progress' } }), error(409));
  const preview = run('tasks_batch', { body: { items: [{ id: first.id, expected_version: first.version, patch: { status: 'in_progress' } }] } });
  assert.equal(preview.dry_run, true);
  assert.equal(ctx.get('work_item', first.id).status, 'open');
  run('tasks_update', { params: { id: first.id }, body: { status: 'in_progress' } });
  run('tasks_complete', { params: { id: first.id } });
  actor('other', 'reviewer');
  run('tasks_update', { params: { id: second.id }, body: { status: 'in_progress' } });
  assert.equal(ctx.get('work_item', second.id).status, 'in_progress');
  assert.equal(ctx.list('work_item_event').filter(row => row.kind === 'status_changed').length, 3);
  const aiTask = ctx.create('work_item', { type: 'agent_task', status: 'open', assignee_id: 'other' });
  assert.throws(() => run('tasks_update', { params: { id: aiTask.id }, body: { status: 'in_progress' } }), error(409));
});

test('approval events dedupe and resolve independently of in-app notification reads', () => {
  const { ctx, run, actor } = fixture();
  const approval = ctx.create('approval_request', { status: 'pending', current_step: 1, steps: [{ approvers: { user_ids: ['reviewer'] } }] });
  const create = { id: 'event-1', type: 'core.approval_request.created', payload: { request_id: approval.id } };
  applyWorkspaceEvent(ctx, create);
  applyWorkspaceEvent(ctx, create);
  assert.equal(ctx.list('notification').length, 1);
  assert.equal(ctx.list('work_item').length, 1);
  const notice = ctx.list('notification')[0]!;
  assert.throws(() => run('notifications_read', { body: { ids: [notice.id] } }), error(404));
  actor('reviewer', 'reviewer');
  run('notifications_read', { body: { ids: [notice.id] } });
  assert.equal(ctx.list('work_item')[0]?.status, 'open');
  assert.equal(run<{ items: unknown[] }>('workspace_get_personal_inbox').items.length, 1);
  applyWorkspaceEvent(ctx, { id: 'event-2', type: 'core.approval_request.approved', payload: { request_id: approval.id } });
  assert.equal(ctx.list('work_item')[0]?.completed_by_type, 'system');
});

test('today aggregates live sources and keeps unavailable provider totals unknown', async () => {
  const { ctx, run, events } = fixture();
  const picked = ctx.create('brand', { name: 'Selected' });
  const other = ctx.create('brand', { name: 'Other' });
  const due = run('tasks_create', { body: { title: 'Due today', brand_id: picked.id, due_at: '2026-11-19T07:00:00Z' } });
  ctx.create('publish_target', { brand_id: picked.id, plan_status: 'ready', scheduled_at: '2026-11-19T07:00:00Z' });
  ctx.create('publish_target', { brand_id: other.id, plan_status: 'ready', scheduled_at: '2026-11-19T07:00:00Z' });
  const autoPolicy = ctx.create('connector_auto_policy', { halted_by_workspace: true, ops_halt_rule_ids: ['stop'] });
  ctx.workspacePendingProviders = [{ key: 'ingest.health', list: () => { throw Error('Source offline'); } }];
  const result = await run<Promise<{ items: { kind: string; sources?: string[] }[]; providers: { provider: string; total: number | null; availability: string }[] }>>('workspace_get_today', { query: { brand_id: picked.id } });
  assert.deepEqual(result.items.map(item => item.kind), ['connector_auto_halted', 'work_due', 'missed_publish']);
  assert.deepEqual(result.items[0]?.sources, ['ops', 'workspace']);
  assert.equal(result.providers.find(item => item.provider === 'ingest.health')?.total, null);
  const stops = async () => (await run<Promise<typeof result>>('workspace_get_today', { query: { brand_id: picked.id } })).items.filter(item => item.kind === 'connector_auto_halted');
  ctx.update('connector_auto_policy', autoPolicy.id, { halted_by_workspace: false });
  assert.deepEqual((await stops()).map(item => item.sources), [['ops']]);
  ctx.update('connector_auto_policy', autoPolicy.id, { ops_halt_rule_ids: [] });
  assert.deepEqual(await stops(), []);
  scanWorkspaceDue(ctx);
  scanWorkspaceDue(ctx);
  assert.equal(ctx.list('notification').find(row => row.work_item_id === due.id)?.type, 'overdue');
  assert.equal(events.filter(item => item.type === 'workspace.work_item.overdue').length, 1);
});

test('search filters permission-denied results before count and saved views retain query conditions', () => {
  const { ctx, run, actor } = fixture();
  const brand = ctx.create('brand', { name: 'Example' });
  ctx.create('asset', { brand_id: brand.id, name: '春季新品' });
  ctx.create('asset', { brand_id: brand.id, name: '春季新品私用', restricted: true });
  ctx.canReadWorkspaceResource = (_kind, row) => row.restricted !== true;
  const result = run<{ items: { title: string }[]; total: number }>('search_query', { query: { q: '新品', types: 'asset', brand_id: brand.id } });
  assert.equal(result.total, 1);
  assert.deepEqual(result.items.map(item => item.title), ['春季新品']);
  run('workspace_saved_views_create', { body: { name: 'Personal', resource_type: 'asset', filters: { q: '新品' } } });
  run('workspace_saved_views_create', { body: { name: 'Team', resource_type: 'asset', filters: { q: '新品' }, shared: true } });
  actor('another-user', 'analyst');
  assert.deepEqual(run<Row[]>('workspace_saved_views_list').map(row => row.name), ['Team']);
});

test('onboarding resumes across administrators and rechecks real setup records', async () => {
  const { ctx, run, actor } = fixture();
  const params = { flow: 'initial_setup_v1', step: 'brand' };
  assert.equal((await run<Promise<Row>>('workspace_onboarding_check', { params })).status, 'blocked');
  actor('another-admin', 'admin');
  ctx.create('brand', { status: 'active' });
  assert.equal((await run<Promise<Row>>('workspace_onboarding_check', { params })).status, 'done');
  assert.equal(ctx.list('onboarding_progress').length, 1);
  await run<Promise<Row>>('workspace_onboarding_skip', { params: { ...params, step: 'history_sync' }, body: { reason: 'No historical data to import' } });
  const result = await run<Promise<{ skipped_steps: { step_key: string }[] }>>('workspace_get_today');
  assert.deepEqual(result.skipped_steps.map(row => row.step_key), ['history_sync']);
});

test('connector onboarding requires verified phone identity and leaves automation mode untouched', async () => {
  const { ctx, run } = fixture();
  const device = ctx.create('connector_device', { status: 'active', platform: 'windows', last_seen_at: ctx.now });
  const phone = ctx.create('mobile_device', { status: 'ready', platform: 'android', device_id: device.id, last_seen_at: ctx.now });
  const binding = ctx.create('account_execution_binding', { mode: 'connector', connector_channel: 'mobile', connector_mode: 'assist', device_id: device.id,
    mobile_device_id: phone.id, mobile_app: 'instagram', social_account_id: 'acct' });
  const session = ctx.create('mobile_app_binding', { status: 'identity_mismatch', device_id: device.id, mobile_device_id: phone.id, app: 'instagram', social_account_id: 'acct' });
  const params = { flow: 'initial_setup_v1', step: 'connector_pairing' };
  const blocked = await run<Promise<Row>>('workspace_onboarding_check', { params });
  assert.equal(blocked.status, 'blocked');
  assert.equal((blocked.check_result as Data).reason, 'app_identity_mismatch');
  ctx.update('mobile_app_binding', session.id, { status: 'verified' });
  assert.equal((await run<Promise<Row>>('workspace_onboarding_check', { params })).status, 'done');
  assert.equal(ctx.get('account_execution_binding', binding.id).connector_mode, 'assist');
});

test('summary separates verified publishing performance from missing metric observations', async () => {
  const { ctx, run } = fixture();
  const target = ctx.create('publish_target', { plan_status: 'closed', scheduled_at: '2026-11-19T03:00:00Z' });
  ctx.create('publish_target', { plan_status: 'ready', scheduled_at: '2026-11-19T07:00:00Z' });
  ctx.create('platform_post', { publish_target_id: target.id, published_at: '2026-11-19T02:00:00Z' });
  const result = await run<Promise<{ execution_efficiency: { on_time_rate: Data }; cards: { metrics?: { coverage: { subjects_observed: number } } }[] }>>('workspace_get_summary');
  assert.deepEqual(result.execution_efficiency.on_time_rate, { value: 1, coverage: 0.5, availability: 'partial' });
  assert.equal(result.cards.length, 2);
  assert.equal(result.cards[0]?.metrics?.coverage.subjects_observed, 0);
});
