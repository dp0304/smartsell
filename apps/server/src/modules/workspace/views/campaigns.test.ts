import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Problem, READ, type Context, type Data, type Input, type Role, type Row } from '@smartsell/contracts';
import { campaignsViewOperations } from './campaigns.js';
import { decisionsViewOperations, type DecisionItem } from './decisions.js';

const now = '2026-11-19T08:00:00.000Z';
const hours = (n: number) => new Date(Date.parse(now) + n * 3_600_000).toISOString();
type Plan = Data & { id: string; goals: Data[]; matrix: Data; budget: Data[] | Data; products: Data[]; needs_decision: number };
type PlanDetail = Plan & { events: Data[]; cells: Data[]; milestones: Data[]; content: Data[]; ads: { proposals: Data[]; spend: Data[] } };

function seed() {
  const rows = new Map<string, Row[]>();
  let seq = 0;
  const ctx: Context = {
    workspaceId: 'w1', tenantId: 't1', actorId: 'me', role: 'owner', now,
    list: kind => rows.get(kind) ?? [],
    get(kind, id) {
      const row = ctx.list(kind).find(item => item.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', 'Missing row');
      return row;
    },
    create(kind, values) {
      const row = { ...values, id: `${kind}-${++seq}`, version: 1, created_at: now, updated_at: now };
      rows.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind, id, patch) {
      const row = { ...ctx.get(kind, id), ...patch, id, updated_at: now };
      rows.set(kind, ctx.list(kind).map(item => item.id === id ? row : item));
      return row;
    },
    remove(kind, id) { rows.set(kind, ctx.list(kind).filter(item => item.id !== id)); },
    emit() {},
  };
  const add = (kind: string, values: Data) => ctx.create(kind, values);
  function run<T = Plan[]>(name: string, input: Partial<Input> = {}, role: Role = 'owner') {
    const op = campaignsViewOperations.find(item => item.name === name)!;
    assert.ok(op.roles.includes(role));
    return op.run({ ...ctx, role }, { body: {}, params: {}, query: {}, ...input }) as T;
  }

  const brand = add('brand', { name: 'Brand', slug: 'brand', status: 'active' });
  const other = add('brand', { name: 'Other', slug: 'other', status: 'active' });
  const launch = add('campaign', { brand_id: brand.id, name: 'Launch', kind: 'launch', status: 'active', timezone: 'Asia/Taipei',
    starts_at: '2026-11-14T16:00:00.000Z', ends_at: '2026-11-28T16:00:00.000Z', created_via: 'agent' });
  const draft = add('campaign', { brand_id: brand.id, name: 'Idea', kind: 'other', status: 'draft', timezone: 'UTC', starts_at: null, ends_at: null });
  const closed = add('campaign', { brand_id: other.id, name: 'Old', kind: 'promotion', status: 'closed', timezone: 'UTC', starts_at: '2026-01-01T00:00:00.000Z', ends_at: '2026-02-01T00:00:00.000Z' });
  add('campaign_goal', { campaign_id: launch.id, metric_key: 'norm.post.views', unit: 'count', currency: null, target_value: 1000, due_at: launch.ends_at, status: 'active' });
  add('campaign_goal', { campaign_id: launch.id, metric_key: 'norm.post.engagements', unit: 'count', currency: null, target_value: 100, due_at: launch.ends_at, status: 'active' });
  add('campaign_goal', { campaign_id: launch.id, metric_key: 'norm.post.views', unit: 'count', target_value: 5, due_at: launch.ends_at, status: 'withdrawn' });
  const slot = add('campaign_plan_slot', { campaign_id: launch.id, stage: 'launch', platform: 'instagram', social_account_id: null, planned_count: 3 });

  const account = add('social_account', { brand_id: brand.id, provider: 'instagram', display_name: 'Brand IG' });
  const item = add('content_item', { brand_id: brand.id, campaign_id: launch.id, title: 'Teaser', production_stage: 'ready', production_due_at: hours(12), created_via: 'agent' });
  const variant = add('content_variant', { content_item_id: item.id, platform: 'instagram', format: 'feed_image' });
  const target = (values: Data) => add('publish_target', { brand_id: brand.id, campaign_id: launch.id, content_item_id: item.id, content_variant_id: variant.id, social_account_id: account.id, ...values });
  const published = target({ plan_status: 'closed', close_reason: 'published', scheduled_at: hours(-48) });
  const request = add('approval_request', { resource_type: 'planning.publish_target', status: 'pending', resource_hash: 'frozen' });
  const awaiting = target({ plan_status: 'awaiting_approval', approval_request_id: request.id, frozen_hash: 'frozen', scheduled_at: hours(48) });
  ctx.update('approval_request', request.id, { resource_id: awaiting.id });
  target({ plan_status: 'cancelled', scheduled_at: hours(24) });
  const post = add('platform_post', { publish_target_id: published.id, social_account_id: account.id, provider: 'instagram', campaign_id: launch.id,
    published_at: hours(-48), permalink: 'https://instagram.com/p/1', verification: 'system_verified' });
  add('metric_observation', { subject_type: 'platform_post', subject_id: post.id, metric_key: 'norm.post.views', value: 500, availability: 'observed', period_kind: 'lifetime', observed_at: hours(-1), platform: 'instagram' });

  const production = add('budget_line', { campaign_id: launch.id, category: 'production', amount_minor: 100000, currency: 'TWD', fx_date: '2026-11-01' });
  add('budget_line', { campaign_id: launch.id, category: 'ads', amount_minor: 50000, currency: 'TWD', fx_date: '2026-11-01' });
  add('cost_entry', { campaign_id: launch.id, budget_line_id: production.id, source: 'manual', amount_minor: 20000, currency: 'TWD', incurred_on: '2026-11-16' });
  const milestone = add('work_item', { campaign_id: launch.id, brand_id: brand.id, kind: 'campaign_milestone', type: 'milestone', title: 'Assets ready', due_at: hours(24), status: 'open' });
  const brief = add('brief', { campaign_id: launch.id, title: 'Brief' });
  ctx.update('brief', brief.id, { current_revision_id: add('brief_revision', { brief_id: brief.id, status: 'in_review' }).id });

  const store = add('store', { brand_id: brand.id, name: 'Shop', provider: 'shopify', status: 'active' });
  const market = add('market', { brand_id: brand.id, name: 'Taiwan', currency: 'TWD' });
  const tee = add('product', { store_id: store.id, brand_id: brand.id, title: 'Tee', status: 'active' });
  for (const [sku, stock, quantity] of [['B', 'in_stock', 5], ['R', 'low', 1]] as const) {
    const row = add('product_variant', { product_id: tee.id, store_id: store.id, sku, status: 'active' });
    add('listing_snapshot', { variant_id: row.id, market_id: market.id, channel: 'online_store', is_current: true, availability: 'observed', inventory_status: stock, inventory_quantity: quantity });
  }
  add('campaign_product', { campaign_id: launch.id, product_id: tee.id, role: 'hero', variant_ids: null, market_ids: null });
  const change = add('change_event', { product_id: tee.id, change_type: 'stock_low', severity: 'review', status: 'open' });

  const adAccount = add('ad_account', { brand_id: brand.id, provider: 'meta', currency: 'TWD', timezone: 'Asia/Taipei', permissions: [] });
  const proposal = add('ad_proposal', { ad_account_id: adAccount.id, brand_id: brand.id, campaign_id: launch.id, name: 'Boost', status: 'in_review' });
  const revision = add('ad_proposal_revision', { proposal_id: proposal.id, schedule: { starts_at: hours(24), ends_at: hours(24 * 7), tz: 'Asia/Taipei' },
    budget: { type: 'daily', amount_minor: 30000, currency: 'TWD', cap_minor: 50000 }, estimates: [{ metric: 'impressions', value: 10000, source: 'provider_estimate', estimate: true }] });
  const adApproval = add('ad_approval_request', { proposal_id: proposal.id, revision_id: revision.id, status: 'pending' });
  ctx.update('ad_proposal', proposal.id, { current_revision_id: revision.id, approval_request_id: adApproval.id });
  return { ctx, run, add, target, brand, other, launch, draft, closed, slot, item, published, awaiting, post, milestone, tee, change, proposal, brief };
}

const status = (code: number) => (reason: unknown) => reason instanceof Problem && reason.status === code;

test('plan cards compose goals, matrix completeness, budget, products and pending decisions', () => {
  const { run, brand, launch, draft, tee, change, awaiting } = seed();
  const cards = run('views_plans_list', { query: { brand_id: brand.id } });
  assert.deepEqual(cards.map(card => card.id), [launch.id, draft.id]);
  const card = cards[0]!;
  assert.deepEqual([card.name, card.kind, card.status, card.timezone, card.day, card.days], ['Launch', 'launch', 'active', 'Asia/Taipei', 5, 14]);
  assert.deepEqual(card.goals.map(goal => [goal.metric_key, goal.target_value, goal.value, goal.progress_percent, goal.coverage_status]),
    [['norm.post.views', 1000, 500, 50, 'observed'], ['norm.post.engagements', 100, null, null, 'not_collected']]);
  assert.deepEqual(card.matrix, { planned: 3, filled: 2, published: 1, scheduled: 1, in_production: 0, failed: 0, gap: 1, completeness_ratio: 2 / 3, outside_plan: 0, unplanned_items: 0 });
  assert.deepEqual(card.budget, [{ currency: 'TWD', budget_minor: 150000, committed_minor: 0, actual_minor: 20000, remaining_minor: 130000, overrun_minor: 0, actual_complete: false }]);
  assert.deepEqual(card.products, [{ product_id: tee.id, title: 'Tee', role: 'hero', stock_status: 'low', risk: { severity: 'review', change_type: 'stock_low', change_event_id: change.id } }]);
  assert.deepEqual(card.next_publication, { publish_target_id: awaiting.id, scheduled_at: awaiting.scheduled_at, title: 'Teaser' });
  // Publish approval, brief revision in review and the ad proposal in review.
  assert.equal(card.needs_decision, 3);
  assert.equal(card.created_via, 'agent');

  const empty = cards[1]!;
  assert.deepEqual([empty.day, empty.days, empty.next_publication, empty.created_via], [null, null, null, null]);
  assert.deepEqual(empty.matrix, { planned: 0, filled: 0, published: 0, scheduled: 0, in_production: 0, failed: 0, gap: 0, completeness_ratio: null, outside_plan: 0, unplanned_items: 0 });
  assert.deepEqual([empty.goals, empty.budget, empty.products, empty.needs_decision], [[], [], [], 0]);
});

test('plan list filters by brand and status on the server and hides sensitive sections by role', () => {
  const { run, other, launch, closed } = seed();
  assert.deepEqual(run('views_plans_list', { query: { brand_id: other.id } }).map(card => card.id), [closed.id]);
  assert.deepEqual(run('views_plans_list', { query: { status: 'active,closed' } }).map(card => card.id), [launch.id, closed.id]);
  assert.throws(() => run('views_plans_list', { query: { status: 'live' } }), status(422));
  assert.throws(() => run('views_plans_list', { query: { brand_id: 'missing' } }), status(404));
  assert.equal(run('views_plans_list', { query: { status: 'closed' } })[0]!.budget instanceof Array, true);
  const reviewer = run('views_plans_list', { query: { status: 'active' } }, 'reviewer')[0]!;
  assert.deepEqual(reviewer.budget, { visible: false });
  // Without an ad-account grant a manager does not see the proposal, so it is not counted either.
  assert.equal(run('views_plans_list', { query: { status: 'active' } }, 'manager')[0]!.needs_decision, 2);
});

test('plan card decision count equals the decisions list it links to for every role', () => {
  const { ctx, run, add, target, brand, launch, brief } = seed();
  const [from, to] = ctx.list('budget_line');
  // Kinds the list shows: a budget reallocation and overrun (lead only), a submitted job, its change set and a late publication.
  const move = add('campaign_budget_reallocation', { campaign_id: launch.id, from_line_id: from!.id, to_line_id: to!.id, amount_minor: 1000, reason: 'Shift to ads', status: 'pending' });
  add('approval_request', { resource_type: 'campaign_budget_reallocation', resource_id: move.id, resource_hash: 'move', status: 'pending', current_step: 1, context: { campaign_id: launch.id } });
  add('approval_request', { resource_type: 'budget_line', resource_id: from!.id, status: 'pending', current_step: 1, context: { campaign_id: launch.id, currency: 'TWD' } });
  const job = add('agent_job', { campaign_id: launch.id, brand_id: brand.id, status: 'submitted', title: 'Captions' });
  const set = add('change_set', { status: 'pending', agent_job_id: job.id, brand_id: brand.id, title: 'Caption edits' });
  add('change_set_item', { change_set_id: set.id, status: 'pending', target_type: 'content_item', target_id: 'missing', preview: {} });
  const overdue = target({ plan_status: 'ready', scheduled_at: hours(-2) });
  add('execution_task', { publish_target_id: overdue.id, status: 'blocked', sub_status: 'late_awaiting_decision', due_at: overdue.scheduled_at });
  // Rows the list leaves out: an expired approval, a superseded brief revision, a job being cancelled and a late task already running.
  const expired = add('approval_request', { resource_type: 'planning.publish_target', status: 'pending', resource_hash: 'old', due_at: hours(-1) });
  ctx.update('approval_request', expired.id, { resource_id: target({ plan_status: 'awaiting_approval', approval_request_id: expired.id, frozen_hash: 'old', scheduled_at: hours(72) }).id });
  add('brief_revision', { brief_id: brief.id, status: 'in_review' });
  add('agent_job', { campaign_id: launch.id, status: 'submitted', cancel_requested_at: hours(-1), title: 'Cancelled' });
  const running = target({ plan_status: 'ready', scheduled_at: hours(-3) });
  add('execution_task', { publish_target_id: running.id, status: 'running', sub_status: 'late_awaiting_decision' });

  const list = (role: Role) => decisionsViewOperations.find(op => op.name === 'views_decisions_list')!
    .run({ ...ctx, role }, { body: {}, params: {}, query: { campaign_id: launch.id } }) as DecisionItem[];
  assert.deepEqual(list('owner').map(item => item.kind).sort(), ['ad_proposal', 'agent_job_review', 'brief_revision', 'budget_approval', 'budget_approval', 'change_set', 'late_decision', 'publish_approval']);
  for (const role of READ) {
    const detail = run<Plan>('views_plan_get', { params: { id: launch.id } }, role);
    const card = run('views_plans_list', { query: { status: 'active' } }, role)[0]!;
    assert.deepEqual([card.needs_decision, detail.needs_decision], [list(role).length, list(role).length], role);
  }
});

test('plan cards count decisions without building previews or reading the activity log', () => {
  const { ctx, add, brand, launch, awaiting } = seed();
  // An agent-requested job and an approval with a rendered revision: the list labels and previews both, the cards need neither.
  add('agent_job', { campaign_id: launch.id, brand_id: brand.id, status: 'submitted', title: 'Captions', assignee_type: 'agent_client', lease_credential_id: 'cred-1' });
  add('activity_event', { occurred_at: now, action: 'agent_jobs_submit_result', actor_type: 'agent', credential_id: 'cred-1', credential_label: 'Claude Code', source: 'mcp' });
  ctx.update('publish_target', awaiting.id, { variant_revision_id: add('content_revision', { rendered: { text: 'Teaser copy' } }).id });
  const reads = new Set<string>();
  const counting: Context = { ...ctx, list: kind => { reads.add(kind); return ctx.list(kind); } };
  const call = <T>(name: string, params: Record<string, string> = {}) => campaignsViewOperations.find(op => op.name === name)!.run(counting, { body: {}, params, query: {} }) as T;
  const card = call<Plan[]>('views_plans_list').find(row => row.id === launch.id)!;
  const detail = call<Plan>('views_plan_get', { id: launch.id });
  assert.deepEqual(['activity_event', 'content_revision', 'approval_decision'].filter(kind => reads.has(kind)), []);
  const list = decisionsViewOperations.find(op => op.name === 'views_decisions_list')!.run(ctx, { body: {}, params: {}, query: { campaign_id: launch.id } }) as DecisionItem[];
  assert.deepEqual([card.needs_decision, detail.needs_decision], [4, 4]);
  assert.equal(list.length, 4);
  assert.deepEqual(list.find(row => row.kind === 'agent_job_review')!.requested_by, { type: 'agent', label: 'Claude Code' });
});

test('plan detail adds calendar events, matrix cells, milestones, content targets and advertising', () => {
  const { run, launch, slot, item, published, awaiting, post, milestone, proposal } = seed();
  const detail = run<PlanDetail>('views_plan_get', { params: { id: launch.id } });
  assert.equal(detail.matrix.completeness_ratio, 2 / 3);
  assert.deepEqual(detail.cells, [{ slot_id: slot.id, stage: 'launch', platform: 'instagram', social_account_id: null, account_name: null, market_id: null,
    planned_count: 3, in_production: 0, scheduled: 1, published: 1, failed: 0, gap: 1 }]);
  assert.deepEqual(detail.milestones, [{ id: milestone.id, title: 'Assets ready', due_at: milestone.due_at, status: 'open', blocked: false }]);
  assert.deepEqual(detail.content, [{ content_item_id: item.id, title: 'Teaser', production_stage: 'ready', production_due_at: item.production_due_at, created_via: 'agent',
    targets: [{ id: published.id, platform: 'instagram', social_account_id: published.social_account_id, scheduled_at: published.scheduled_at, display_status: 'published' },
      { id: awaiting.id, platform: 'instagram', social_account_id: awaiting.social_account_id, scheduled_at: awaiting.scheduled_at, display_status: 'awaiting_approval' }] }]);
  const events = new Map(detail.events.map(event => [event.id, event]));
  assert.deepEqual([...events.keys()].sort(), [`ad_flight:${proposal.id}`, `milestone:${milestone.id}`, `plan:${launch.id}`, `post:${post.id}`, `production_due:${item.id}`, `publish:${awaiting.id}`].sort());
  assert.equal(events.get(`publish:${awaiting.id}`)!.needs_human, 'approval');
  assert.equal(events.get(`post:${post.id}`)!.permalink, 'https://instagram.com/p/1');
  assert.deepEqual([events.get(`plan:${launch.id}`)!.starts_at, events.get(`plan:${launch.id}`)!.ends_at], [launch.starts_at, launch.ends_at]);
  assert.ok(detail.events.every((event, i, all) => i === 0 || String(all[i - 1]!.starts_at) <= String(event.starts_at)));
  assert.deepEqual(detail.ads.proposals.map(row => [row.id, row.status, row.approval_status, row.budget, (row.estimates as Data[]).length]),
    [[proposal.id, 'in_review', 'pending', { type: 'daily', amount_minor: 30000, currency: 'TWD' }, 1]]);
  // No ad spend was reported, so actual spend stays unknown instead of 0.
  assert.deepEqual(detail.ads.spend, [{ campaign_id: launch.id, currency: 'TWD', budget_minor: 50000, actual_spend_minor: null, coverage_ratio: null, delayed: null }]);
  const manager = run<PlanDetail>('views_plan_get', { params: { id: launch.id } }, 'manager');
  assert.deepEqual([manager.ads.proposals, manager.events.some(event => event.kind === 'ad_flight')], [[], false]);
  assert.throws(() => run('views_plan_get', { params: { id: 'missing' } }), status(404));
});
