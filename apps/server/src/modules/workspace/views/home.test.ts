import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Problem, type Context, type Data, type Role, type Row } from '@smartsell/contracts';
import { campaignMatrix } from '../../campaign/coordination-operations.js';
import { homeViewOperations, type Kpi } from './home.js';
import type { Point } from './social.js';

interface Home {
  timezone: string; period: { from: string; to: string };
  needs_you: { total: number; items: { kind: string }[] };
  this_week: { scheduled: number; published: number; failed: number; outcome_unknown: number; upcoming: Data[] };
  kpis: (Kpi & Data)[]; live_plans: Data[]; alerts: { kind: string; severity: string }[];
  agent: { connections: number | null; last_seen_at: string | null; recent: { action: string }[] };
}

function fixture() {
  const rows = new Map<string, Row[]>();
  let next = 0;
  const ctx: Context = {
    workspaceId: 'w1', tenantId: 't1', actorId: 'owner', role: 'owner', now: '2026-11-20T04:00:00.000Z',
    list: kind => rows.get(kind) ?? [],
    get(kind, id) {
      const row = ctx.list(kind).find(item => item.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', `${kind}: ${id}`);
      return row;
    },
    create(kind, values) {
      const row = { ...values, id: typeof values.id === 'string' ? values.id : `r${++next}`, version: 1, created_at: ctx.now, updated_at: ctx.now };
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
    emit() {},
  };
  const seed = (kind: string, values: Data) => ctx.create(kind, values);
  seed('workspace', { default_timezone: 'Asia/Taipei' });
  for (const id of ['b1', 'b2']) seed('brand', { id, name: id, status: 'active' });
  seed('social_account', { id: 'a1', brand_id: 'b1', platform: 'instagram', handle: '@one' });
  seed('social_account', { id: 'a2', brand_id: 'b2', platform: 'tiktok', handle: '@two' });
  seed('platform_post', { id: 'p1', social_account_id: 'a1', published_at: '2026-11-19T10:01:00.000Z', verification: 'system_verified', publish_target_id: 't1' });
  seed('platform_post', { id: 'p2', social_account_id: 'a2' });
  const metric = (subject_type: string, subject_id: string, metric_key: string, date: string, value: number | null, availability = 'observed') =>
    seed('metric_observation', { subject_type, subject_id, metric_key, date, value, availability, period_kind: 'day', observed_at: `${date}T03:00:00.000Z` });
  metric('platform_post', 'p1', 'views', '2026-11-18', 100);
  metric('platform_post', 'p1', 'views', '2026-11-19', 50);
  metric('platform_post', 'p1', 'norm.post.views', '2026-11-19', 999);
  metric('social_account', 'a2', 'views', '2026-11-18', 30);
  metric('platform_post', 'p2', 'views', '2026-11-18', 999);
  metric('platform_post', 'p1', 'views', '2026-11-10', 40);
  metric('platform_post', 'p1', 'views', '2026-11-17', null, 'not_collected');
  metric('social_account', 'a1', 'followers', '2026-11-15', 1000);
  metric('social_account', 'a1', 'followers', '2026-11-20', 1010);
  metric('social_account', 'a2', 'followers', '2026-11-19', 500);
  seed('ad_account', { id: 'acc1', brand_id: 'b1', currency: 'TWD', permissions: [] });
  seed('ad_entity', { id: 'e1', ad_account_id: 'acc1' });
  seed('ad_entity', { id: 'e2', ad_account_id: 'acc1', parent_entity_id: 'e1' });
  const spend = (subject_id: string, native_date: string, value: number) => seed('metric_observation', { subject_type: 'ads.ad_entity', subject_id, metric_key: 'ads.spend', native_date, value, currency: 'TWD', availability: 'observed', period_kind: 'day', observed_at: ctx.now });
  spend('e1', '2026-11-18', 5000);
  spend('e2', '2026-11-18', 2000);
  spend('e2', '2026-11-19', 3000);
  seed('store', { id: 's1', brand_id: 'b1' });
  for (const placed_at of ['2026-11-16T02:00:00.000Z', '2026-11-16T05:00:00.000Z', '2026-11-19T03:00:00.000Z']) seed('order', { store_id: 's1', placed_at, currency: 'TWD', total_minor: 1000 });
  seed('content_item', { id: 'c1', title: 'Winter reel', brand_id: 'b1' });
  const target = (id: string, scheduled_at: string, plan_status: string, extra: Data = {}) => seed('publish_target', { id, brand_id: 'b1', social_account_id: 'a1', content_item_id: 'c1', scheduled_at, plan_status, ...extra });
  target('t1', '2026-11-19T10:00:00.000Z', 'closed', { close_reason: 'published' });
  seed('approval_request', { id: 'ar2', status: 'pending' });
  target('t2', '2026-11-21T02:00:00.000Z', 'awaiting_approval', { title: 'Teaser', approval_request_id: 'ar2' });
  target('t3', '2026-11-18T02:00:00.000Z', 'ready');
  target('t4', '2026-11-20T06:00:00.000Z', 'ready');
  target('t5', '2026-11-19T02:00:00.000Z', 'cancelled');
  seed('execution_task', { publish_target_id: 't3', status: 'failed', brand_id: 'b1' });
  seed('execution_task', { publish_target_id: 't4', status: 'outcome_unknown', brand_id: 'b1' });
  seed('campaign', { id: 'cp1', brand_id: 'b1', name: 'Winter', status: 'active', starts_at: '2026-11-01T00:00:00.000Z', ends_at: '2026-11-30T00:00:00.000Z' });
  seed('campaign', { id: 'cp2', brand_id: 'b1', name: 'Spring', status: 'active', starts_at: '2027-03-01T00:00:00.000Z', ends_at: '2027-03-30T00:00:00.000Z' });
  seed('campaign_plan_slot', { campaign_id: 'cp1', platform: 'instagram', planned_count: 4 });
  for (let index = 0; index < 6; index++) {
    const entry = seed('knowledge_entry', { brand_id: 'b1', kind: 'tone', title: `Voice ${index}`, status: 'proposed' });
    const revision = seed('knowledge_revision', { entry_id: entry.id, body: 'Warm', review_status: 'draft', created_by_type: 'agent' });
    ctx.update('knowledge_entry', entry.id, { current_revision_id: revision.id });
  }
  seed('activity_event', { occurred_at: '2026-11-20T03:00:00.000Z', action: 'publishing_create_target', actor_id: 'owner', actor_type: 'agent', credential_id: 'cred-claude', credential_label: 'Claude Code', source: 'mcp', brand_id: 'b1' });
  seed('activity_event', { occurred_at: '2026-11-20T03:30:00.000Z', action: 'publishing_approve', actor_id: 'owner', actor_type: 'human', credential_id: null, source: 'rest', brand_id: 'b1' });
  const home = async (query: Record<string, string> = {}, role: Role = 'owner', extra: Data = {}) => await homeViewOperations[0]!.run({ ...ctx, role, ...extra }, { body: {}, params: {}, query }) as Home;
  return { ctx, home };
}
const kpi = (home: Home, key: string) => home.kpis.find(item => item.key === key)!;
const series = (points: Point[]) => points.map(point => [point.date.slice(5), point.value, point.availability]);

test('home kpis keep a point for every day and never turn missing values into zero', async () => {
  const { home } = fixture();
  const view = await home();
  assert.equal(view.timezone, 'Asia/Taipei');
  assert.deepEqual(view.period, { from: '2026-11-14', to: '2026-11-20' });
  const views = kpi(view, 'views');
  // The only earlier report (11-10) falls on a day the current period has no report for, so the periods are not comparable.
  assert.deepEqual([views.value, views.availability, views.previous_value, views.change_ratio, views.unit, views.currency], [180, 'observed', null, null, 'count', null]);
  assert.deepEqual(series(views.sparkline), [
    ['11-14', null, 'not_collected'], ['11-15', null, 'not_collected'], ['11-16', null, 'not_collected'], ['11-17', null, 'not_collected'],
    ['11-18', 130, 'observed'], ['11-19', 50, 'observed'], ['11-20', null, 'not_collected'],
  ]);
  const engagements = kpi(view, 'engagements');
  assert.deepEqual([engagements.value, engagements.availability, engagements.previous_value, engagements.change_ratio], [null, 'not_collected', null, null]);
  assert.equal(engagements.sparkline.length, 7);
  const followers = kpi(view, 'followers');
  assert.deepEqual([followers.value, followers.availability, followers.previous_value], [1510, 'observed', null]);
  // A total is known only once every reporting account has a count; a skipped day keeps the last count as an estimate.
  assert.deepEqual(series(followers.sparkline), [
    ['11-14', null, 'not_collected'], ['11-15', null, 'not_collected'], ['11-16', null, 'not_collected'], ['11-17', null, 'not_collected'],
    ['11-18', null, 'not_collected'], ['11-19', 1500, 'estimated'], ['11-20', 1510, 'estimated'],
  ]);
  const ads = kpi(view, 'ad_spend');
  assert.deepEqual([ads.value, ads.availability, ads.unit, ads.currency, ads.previous_value], [8000, 'observed', 'currency', 'TWD', null]);
  assert.deepEqual(series(ads.sparkline).slice(4), [['11-18', 5000, 'observed'], ['11-19', 3000, 'observed'], ['11-20', null, 'not_collected']]);
  const orders = kpi(view, 'orders');
  assert.deepEqual([orders.value, orders.availability, orders.previous_value], [3, 'observed', null]);
  assert.deepEqual(series(orders.sparkline), [
    ['11-14', null, 'not_collected'], ['11-15', null, 'not_collected'], ['11-16', 2, 'observed'], ['11-17', 0, 'observed'],
    ['11-18', 0, 'observed'], ['11-19', 1, 'observed'], ['11-20', 0, 'observed'],
  ]);

  const viewer = await home({}, 'viewer');
  for (const key of ['ad_spend', 'orders']) {
    assert.deepEqual([kpi(viewer, key).value, kpi(viewer, key).availability], [null, 'no_permission']);
    assert.ok(kpi(viewer, key).sparkline.every(point => point.value === null && point.availability === 'no_permission'));
  }
  const second = await home({ brand_id: 'b2' });
  assert.deepEqual([kpi(second, 'views').value, kpi(second, 'followers').value, kpi(second, 'ad_spend').availability, kpi(second, 'orders').availability], [30, 500, 'not_collected', 'not_collected']);
  assert.equal(kpi(await home({ brand_id: 'b1' }), 'views').value, 150);
});

test('home summarizes decisions, publications, live plans, agent presence and alerts', async () => {
  const { home } = fixture();
  const view = await home();
  assert.equal(view.needs_you.total, 6);
  assert.equal(view.needs_you.items.length, 5);
  assert.ok(view.needs_you.items.every(item => item.kind === 'knowledge_revision'));
  assert.ok(view.needs_you.items.every(item => (item as { actions?: unknown[] }).actions?.length === 2));
  assert.ok((await home({}, 'owner', { agentCredentialId: 'cred-claude' })).needs_you.items.every(item => (item as { actions?: unknown[] }).actions?.length === 0));
  assert.deepEqual({ ...view.this_week, upcoming: undefined }, { scheduled: 3, published: 1, failed: 1, outcome_unknown: 1, upcoming: undefined });
  assert.deepEqual(view.this_week.upcoming.map(event => [event.id, event.status, event.needs_human, event.platform, event.title]), [
    ['publish:t4', 'outcome_unknown', 'outcome_unknown', 'instagram', 'Winter reel'],
    ['publish:t2', 'awaiting_approval', 'approval', 'instagram', 'Teaser'],
  ]);
  assert.deepEqual(view.live_plans, [{ id: 'cp1', name: 'Winter', status: 'active', starts_at: '2026-11-01T00:00:00.000Z', ends_at: '2026-11-30T00:00:00.000Z',
    days_left: 10, completeness_ratio: 0, published: 0, planned: 4 }]);
  assert.equal(view.agent.connections, 1);
  assert.equal(view.agent.last_seen_at, '2026-11-20T03:00:00.000Z');
  assert.deepEqual(view.agent.recent.map(item => item.action), ['publishing_create_target']);
  assert.deepEqual(view.alerts.map(alert => [alert.kind, alert.severity]), [['outcome_unknown', 'blocker'], ['failed', 'high']]);
  assert.deepEqual((await home({ brand_id: 'b2' })).needs_you.total, 0);
});

test('home validates the period', async () => {
  const { home } = fixture();
  const rejects = (query: Record<string, string>, status: number) => assert.rejects(home(query), (error: unknown) => error instanceof Problem && error.status === status);
  await rejects({ from: '2026-11-20', to: '2026-11-01' }, 422);
  await rejects({ from: '2025-01-01', to: '2026-11-01' }, 422);
  await rejects({ tz: 'Mars/Base' }, 422);
  await rejects({ brand_id: 'missing' }, 404);
  const custom = await home({ from: '2026-11-18', to: '2026-11-19', tz: 'UTC' });
  assert.deepEqual([custom.timezone, kpi(custom, 'views').sparkline.length, kpi(custom, 'views').value, kpi(custom, 'views').previous_value], ['UTC', 2, 180, null]);
});

test('home compares KPIs only over the same days and accounts as the previous period', async () => {
  const { ctx, home } = fixture();
  ctx.create('brand', { id: 'b3', name: 'b3', status: 'active' });
  ctx.create('social_account', { id: 'a3', brand_id: 'b3', platform: 'instagram' });
  ctx.create('social_account', { id: 'a4', brand_id: 'b3', platform: 'tiktok' });
  const metric = (subject_id: string, metric_key: string, day: number, value: number) => {
    const date = `2026-11-${String(day).padStart(2, '0')}`;
    ctx.create('metric_observation', { subject_type: 'social_account', subject_id, metric_key, date, value, availability: 'observed', period_kind: 'day', observed_at: `${date}T03:00:00.000Z` });
  };
  // Views start on the last day of the compare window (11-07..11-13); a3 is flat at 10k followers, a4 reports 50k on alternate days.
  ctx.create('ad_account', { id: 'acc3', brand_id: 'b3', currency: 'TWD', permissions: [] });
  ctx.create('ad_entity', { id: 'e3', ad_account_id: 'acc3' });
  const spend = (day: number) => ctx.create('metric_observation', { subject_type: 'ads.ad_entity', subject_id: 'e3', metric_key: 'ads.spend', native_date: `2026-11-${String(day).padStart(2, '0')}`,
    value: 1000, currency: 'TWD', availability: 'observed', period_kind: 'day', observed_at: ctx.now });
  for (let day = 13; day <= 20; day++) { metric('a3', 'views', day, 1000); spend(day); }
  for (let day = 7; day <= 20; day++) metric('a3', 'followers', day, 10_000);
  for (const day of [16, 18, 20]) metric('a4', 'followers', day, 50_000);
  const values = (view: Home, key: string) => [kpi(view, key).value, kpi(view, key).previous_value, kpi(view, key).change_ratio];
  let view = await home({ brand_id: 'b3' });
  assert.deepEqual(values(view, 'views'), [7000, null, null]);
  assert.deepEqual(values(view, 'followers'), [60_000, null, null]);
  // Spend comes from the ads view as is; this pins that it follows the same rule, as the contract says.
  assert.deepEqual(values(view, 'ad_spend'), [7000, null, null]);
  assert.deepEqual(series(kpi(view, 'followers').sparkline).slice(1, 4), [['11-15', null, 'not_collected'], ['11-16', 60_000, 'observed'], ['11-17', 60_000, 'estimated']]);
  metric('a4', 'followers', 10, 50_000);
  for (let day = 7; day <= 12; day++) { metric('a3', 'views', day, 1000); spend(day); }
  view = await home({ brand_id: 'b3' });
  assert.deepEqual(values(view, 'views'), [7000, 7000, 0]);
  assert.deepEqual(values(view, 'followers'), [60_000, 60_000, 0]);
  assert.deepEqual(values(view, 'ad_spend'), [7000, 7000, 0]);
});

test('home orders compare only the days known in both periods', async () => {
  const { ctx, home } = fixture();
  // The first recorded order is 11-10, so the compare window (11-07..11-13) is known for four of its seven days.
  ctx.create('order', { store_id: 's1', placed_at: '2026-11-10T02:00:00.000Z', currency: 'TWD', total_minor: 1000 });
  const orders = kpi(await home({ brand_id: 'b1' }), 'orders');
  assert.deepEqual([orders.value, orders.previous_value, orders.change_ratio], [3, null, null]);
});

test('home orders compare an unfinished last day with the same hours of its counterpart', async () => {
  const { ctx, home } = fixture();
  ctx.create('brand', { id: 'b3', name: 'b3', status: 'active' });
  ctx.create('store', { id: 's3', brand_id: 'b3' });
  // Flat sales at 08:30 and 10:00 Taipei every day; the last import ran at 09:00 Taipei today, before the 10:00 order arrived.
  const now = ctx.now;
  ctx.now = '2026-11-20T01:00:00.000Z';
  for (let day = 7; day <= 20; day++) for (const time of ['00:30', '02:00']) {
    const placed_at = `2026-11-${String(day).padStart(2, '0')}T${time}:00.000Z`;
    if (placed_at <= ctx.now) ctx.create('order', { store_id: 's3', placed_at, currency: 'TWD', total_minor: 1000 });
  }
  ctx.now = now;
  const orders = kpi(await home({ brand_id: 'b3' }), 'orders');
  // Its counterpart (11-13) counts only the 08:30 order, not the whole day and not up to the current time (12:00).
  assert.deepEqual([orders.value, orders.previous_value, orders.change_ratio], [13, 13, 0]);
  assert.deepEqual(series(orders.sparkline).slice(5), [['11-19', 2, 'observed'], ['11-20', 1, 'observed']]);
});

test('live plans read each campaign from shared indexes and match the whole-workspace plan matrix', async () => {
  const { ctx, home } = fixture();
  const seed = (kind: string, values: Data) => ctx.create(kind, values);
  for (const id of ['cp3', 'cp4']) seed('campaign', { id, brand_id: 'b1', name: id, status: 'active', starts_at: '2026-11-01T00:00:00.000Z', ends_at: '2026-12-15T00:00:00.000Z' });
  seed('campaign_plan_slot', { campaign_id: 'cp3', platform: 'instagram', planned_count: 3 });
  seed('campaign_plan_slot', { campaign_id: 'cp3', platform: 'tiktok', planned_count: 2 });
  seed('campaign_plan_slot', { campaign_id: 'cp4', platform: 'instagram', planned_count: 1 });
  seed('content_item', { id: 'ci3', campaign_id: 'cp3', brand_id: 'b1' });
  seed('content_item', { id: 'ci3x', campaign_id: 'cp3', brand_id: 'b1', production_stage: 'archived' });
  seed('content_item', { id: 'ci4', campaign_id: 'cp4', brand_id: 'b1' });
  seed('content_variant', { id: 'v3a', content_item_id: 'ci3', platform: 'instagram' });
  seed('content_variant', { id: 'v3b', content_item_id: 'ci3', platform: 'tiktok' });
  seed('content_variant', { id: 'v3c', content_item_id: 'ci3', platform: 'instagram' });
  seed('content_variant', { id: 'v3x', content_item_id: 'ci3x', platform: 'instagram' });
  seed('content_variant', { id: 'v4', content_item_id: 'ci4', platform: 'instagram' });
  seed('execution_task', { id: 'et3', status: 'running' });
  seed('execution_task', { id: 'et4', status: 'running' });
  const target = (id: string, campaign_id: string, content_variant_id: string, social_account_id: string, extra: Data = {}) =>
    seed('publish_target', { id, campaign_id, content_variant_id, content_item_id: content_variant_id === 'v4' ? 'ci4' : 'ci3', social_account_id, brand_id: 'b1', plan_status: 'ready', scheduled_at: '2026-11-21T02:00:00.000Z', ...extra });
  target('pt3a', 'cp3', 'v3a', 'a1', { execution_task_id: 'et3' });
  target('pt3b', 'cp3', 'v3b', 'a2');
  target('pt3x', 'cp3', 'v3c', 'a1', { plan_status: 'cancelled' });
  target('pt4', 'cp4', 'v4', 'a1', { execution_task_id: 'et4' });
  // One post matches through the execution task only, one through its publish target only, one belongs to the other plan.
  seed('platform_post', { id: 'pp3a', social_account_id: 'a1', execution_task_id: 'et3' });
  seed('platform_post', { id: 'pp3b', social_account_id: 'a2', publish_target_id: 'pt3b' });
  seed('platform_post', { id: 'pp4', social_account_id: 'a1', publish_target_id: 'pt4' });
  const plans = (await home()).live_plans;
  for (const id of ['cp1', 'cp3', 'cp4']) {
    const { cells } = campaignMatrix(ctx, ctx.get('campaign', id));
    const planned = cells.reduce((sum, cell) => sum + Number(cell.slot.planned_count), 0);
    const filled = cells.reduce((sum, cell) => sum + Math.min(cell.actual.length, Number(cell.slot.planned_count)), 0);
    const plan = plans.find(row => row.id === id)!;
    assert.deepEqual([plan.planned, plan.published, plan.completeness_ratio], [planned, cells.reduce((sum, cell) => sum + cell.counts.published, 0), filled / planned], id);
  }
  assert.deepEqual(plans.map(row => [row.id, row.published, row.planned]), [['cp1', 0, 4], ['cp3', 2, 5], ['cp4', 1, 1]]);
});

test('home reads each table once however many plans are live', async () => {
  const { ctx, home } = fixture();
  for (let index = 0; index < 5; index++) ctx.create('campaign', { brand_id: 'b1', name: `Plan ${index}`, status: 'active', starts_at: '2026-11-01T00:00:00.000Z', ends_at: '2026-12-01T00:00:00.000Z' });
  const reads = new Map<string, number>();
  const list = ctx.list;
  ctx.list = kind => { reads.set(kind, (reads.get(kind) ?? 0) + 1); return list(kind); };
  assert.equal((await home()).live_plans.length, 6);
  assert.deepEqual([...reads].filter(([, count]) => count > 1), []);
});
