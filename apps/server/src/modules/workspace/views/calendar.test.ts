import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Problem, type Data } from '@smartsell/contracts';
import { testWorkspace } from '../../lifecycle/workspace-test-context.js';
import { calendarViewOperations, type CalendarEvent } from './calendar.js';

type View = { range: Data; events: CalendarEvent[]; sources: { kind: string; availability: string }[]; as_of: string };
const status = (code: number) => (error: unknown) => error instanceof Problem && error.status === code;

function fixture(timezone?: string) {
  const workspace = testWorkspace(calendarViewOperations);
  const { ctx } = workspace;
  if (timezone) ctx.create('workspace', { default_timezone: timezone });
  const brand = ctx.create('brand', { name: 'Brand', slug: 'brand', status: 'active' });
  const other = ctx.create('brand', { name: 'Other', slug: 'other', status: 'active' });
  const account = ctx.create('social_account', { provider: 'meta_instagram', display_name: 'Brand IG', brand_id: brand.id, status: 'active' });
  const campaign = ctx.create('campaign', { brand_id: brand.id, name: 'Launch', status: 'active', starts_at: '2026-11-10T00:00:00.000Z', ends_at: '2026-11-30T00:00:00.000Z' });
  const view = (query: Record<string, string> = {}) => workspace.call<View>('views_calendar', {}, undefined, query);
  return { ...workspace, brand, other, account, campaign, view };
}

test('calendar merges every dated source into events with display status and human decisions', () => {
  const { ctx, view, brand, account, campaign } = fixture();
  const base = { brand_id: brand.id, campaign_id: campaign.id, social_account_id: account.id };
  const item = ctx.create('content_item', { brand_id: brand.id, campaign_id: campaign.id, title: 'Teaser', production_due_at: '2026-11-18T09:00:00.000Z', production_stage: 'drafting' });
  const ready = ctx.create('publish_target', { ...base, content_item_id: item.id, plan_status: 'ready', scheduled_at: '2026-11-20T10:00:00.000Z' });
  ctx.create('execution_task', { publish_target_id: ready.id, status: 'scheduled', operation: 'publish' });
  const request = ctx.create('approval_request', { status: 'pending' });
  const waiting = ctx.create('publish_target', { ...base, title: 'Waiting', plan_status: 'awaiting_approval', approval_request_id: request.id, scheduled_at: '2026-11-21T10:00:00.000Z' });
  const stale = ctx.create('approval_request', { status: 'invalidated' });
  const resubmit = ctx.create('publish_target', { ...base, title: 'Resubmit', plan_status: 'awaiting_approval', approval_request_id: stale.id, scheduled_at: '2026-11-21T11:00:00.000Z' });
  const unknown = ctx.create('publish_target', { ...base, title: 'Unknown', plan_status: 'ready', scheduled_at: '2026-11-19T08:00:00.000Z' });
  const task = ctx.create('execution_task', { publish_target_id: unknown.id, status: 'running', operation: 'publish' });
  ctx.create('execution_attempt', { task_id: task.id, status: 'unknown' });
  const late = ctx.create('publish_target', { ...base, title: 'Late', plan_status: 'ready', scheduled_at: '2026-11-18T08:00:00.000Z' });
  ctx.create('execution_task', { publish_target_id: late.id, status: 'blocked', sub_status: 'late_awaiting_decision', operation: 'publish' });
  const done = ctx.create('publish_target', { ...base, title: 'Done', plan_status: 'closed', close_reason: 'matched_native', scheduled_at: '2026-11-17T10:00:00.000Z' });
  ctx.create('publish_target', { ...base, title: 'Cancelled', plan_status: 'cancelled', scheduled_at: '2026-11-17T12:00:00.000Z' });
  ctx.create('platform_post', { publish_target_id: done.id, social_account_id: account.id, permalink: 'https://example.com/p/1', published_at: '2026-11-17T10:05:00.000Z', verification: 'system_verified' });
  const external = ctx.create('platform_post', { social_account_id: account.id, permalink: 'https://example.com/p/2', published_at: '2026-11-18T08:00:00.000Z', caption: 'Found on the platform' });
  const milestone = ctx.create('work_item', { type: 'milestone', kind: 'campaign_milestone', title: 'Assets locked', due_at: '2026-11-19T00:00:00.000Z', status: 'open', brand_id: brand.id, campaign_id: campaign.id });
  const shoot = ctx.create('work_item', { type: 'production_task', title: 'Shoot', due_at: '2026-11-19T06:00:00.000Z', status: 'open', content_item_id: item.id });
  ctx.create('work_item', { type: 'production_task', title: 'Finished', due_at: '2026-11-19T07:00:00.000Z', status: 'done', brand_id: brand.id });
  const creator = ctx.create('creator', { display_name: 'Amy' });
  const collaboration = ctx.create('collaboration', { creator_id: creator.id, campaign_id: campaign.id, brand_id: brand.id, status: 'active' });
  const deliverable = ctx.create('deliverable', { collaboration_id: collaboration.id, kind: 'short_video', platform: 'tiktok', due_at: '2026-11-20T00:00:00.000Z', status: 'submitted' });
  const live = ctx.create('live_session', { collaboration_id: collaboration.id, campaign_id: campaign.id, platform: 'tiktok', scheduled_at: '2026-11-22T12:00:00.000Z', tz: 'UTC', status: 'scheduled' });
  const adAccount = ctx.create('ad_account', { provider: 'meta_ads', brand_id: brand.id, currency: 'USD', timezone: 'UTC' });
  const revision = ctx.create('ad_proposal_revision', { schedule: { starts_at: '2026-11-15T00:00:00.000Z', ends_at: '2026-11-25T00:00:00.000Z', tz: 'UTC' } });
  const proposal = ctx.create('ad_proposal', { ad_account_id: adAccount.id, brand_id: brand.id, campaign_id: campaign.id, name: 'Boost', status: 'in_review', current_revision_id: revision.id });
  const store = ctx.create('store', { brand_id: brand.id, name: 'Shop' });
  const promotion = ctx.create('promotion', { store_id: store.id, campaign_id: campaign.id, name: '11.11', valid_from: '2026-11-11T00:00:00.000Z', valid_until: '2026-11-18T00:00:00.000Z', state: 'planned' });
  ctx.create('campaign', { brand_id: brand.id, name: 'Later', status: 'planned', starts_at: '2026-12-01T00:00:00.000Z', ends_at: '2026-12-10T00:00:00.000Z' });

  const result = view({ from: '2026-11-16', to: '2026-11-22' });
  assert.deepEqual(result.range, { from: '2026-11-16', to: '2026-11-22', tz: 'UTC' });
  const byId = new Map(result.events.map(event => [event.id, event]));
  assert.deepEqual(result.events.map(event => event.id), [
    `plan:${campaign.id}`, `promotion:${promotion.id}`, `ad_flight:${proposal.id}`, `publish:${done.id}`, `publish:${late.id}`, `post:${external.id}`,
    `production_due:${item.id}`, `milestone:${milestone.id}`, `production_due:${shoot.id}`, `publish:${unknown.id}`, `deliverable_due:${deliverable.id}`,
    `publish:${ready.id}`, `publish:${waiting.id}`, `publish:${resubmit.id}`, `live:${live.id}`,
  ]);
  assert.deepEqual(byId.get(`publish:${ready.id}`), {
    id: `publish:${ready.id}`, kind: 'publish', starts_at: '2026-11-20T10:00:00.000Z', ends_at: null, all_day: false, title: 'Teaser', status: 'scheduled',
    platform: 'instagram', brand_id: brand.id, campaign_id: campaign.id, social_account_id: account.id, resource: { type: 'publish_target', id: ready.id },
    needs_human: null, permalink: null,
  });
  assert.equal(byId.get(`publish:${waiting.id}`)!.needs_human, 'approval');
  assert.equal(byId.get(`publish:${resubmit.id}`)!.needs_human, null, 'An invalidated request is the agent’s to resubmit, not a human decision');
  assert.deepEqual([byId.get(`publish:${unknown.id}`)!.status, byId.get(`publish:${unknown.id}`)!.needs_human], ['outcome_unknown', 'outcome_unknown']);
  assert.equal(byId.get(`publish:${late.id}`)!.needs_human, 'late_decision');
  assert.deepEqual([byId.get(`publish:${done.id}`)!.status, byId.get(`publish:${done.id}`)!.permalink], ['published', 'https://example.com/p/1']);
  assert.equal(byId.get(`post:${external.id}`)!.title, 'Found on the platform');
  assert.deepEqual([byId.get(`plan:${campaign.id}`)!.ends_at, byId.get(`plan:${campaign.id}`)!.all_day], ['2026-11-30T00:00:00.000Z', true]);
  assert.deepEqual([byId.get(`deliverable_due:${deliverable.id}`)!.title, byId.get(`deliverable_due:${deliverable.id}`)!.needs_human], ['Amy · short_video', 'approval']);
  assert.deepEqual([byId.get(`ad_flight:${proposal.id}`)!.needs_human, byId.get(`ad_flight:${proposal.id}`)!.platform], ['approval', 'meta_ads']);
  assert.equal(byId.get(`promotion:${promotion.id}`)!.status, 'expired');
  assert.equal(byId.get(`production_due:${shoot.id}`)!.brand_id, brand.id, 'A production task inherits its content item brand');
  assert.ok(result.sources.every(source => source.availability === 'available'));
  assert.equal(result.sources.length, 9);
});

test('calendar honours workspace time zone, explicit tz and the default seven-day range', () => {
  const { ctx, view, brand, account } = fixture('Asia/Taipei');
  const night = ctx.create('publish_target', { brand_id: brand.id, social_account_id: account.id, title: 'Night', plan_status: 'draft', scheduled_at: '2026-11-19T17:00:00.000Z' });
  const dated = ctx.create('publish_target', { brand_id: brand.id, social_account_id: account.id, title: 'Dated', plan_status: 'draft', schedule_kind: 'manual_date',
    scheduled_at: null, local_scheduled_at: '2026-11-20', schedule_tz: 'Asia/Taipei' });
  const taipei = view({ from: '2026-11-20', to: '2026-11-20', kinds: 'publish' });
  assert.equal(taipei.range.tz, 'Asia/Taipei');
  assert.deepEqual(taipei.events.map(event => [event.id, event.starts_at, event.all_day]), [
    [`publish:${dated.id}`, '2026-11-19T16:00:00.000Z', true], [`publish:${night.id}`, '2026-11-19T17:00:00.000Z', false]]);
  assert.deepEqual(view({ from: '2026-11-20', to: '2026-11-20', tz: 'UTC', kinds: 'publish' }).events.map(event => event.id), []);
  assert.deepEqual(view().range, { from: '2026-11-13', to: '2026-11-19', tz: 'Asia/Taipei' });
  assert.deepEqual(view({ from: '2026-11-01' }).range, { from: '2026-11-01', to: '2026-11-07', tz: 'Asia/Taipei' });
});

test('calendar filters by kind, brand and campaign on the server and validates its query', () => {
  const { ctx, view, brand, other, account, campaign } = fixture();
  const mine = ctx.create('publish_target', { brand_id: brand.id, campaign_id: campaign.id, social_account_id: account.id, title: 'Mine', plan_status: 'draft', scheduled_at: '2026-11-18T10:00:00.000Z' });
  const loose = ctx.create('publish_target', { brand_id: brand.id, social_account_id: account.id, title: 'No campaign', plan_status: 'draft', scheduled_at: '2026-11-18T11:00:00.000Z' });
  const foreign = ctx.create('publish_target', { brand_id: other.id, title: 'Other brand', plan_status: 'draft', scheduled_at: '2026-11-18T12:00:00.000Z' });
  const otherCampaign = ctx.create('campaign', { brand_id: other.id, name: 'Other', status: 'active', starts_at: '2026-11-01T00:00:00.000Z', ends_at: '2026-11-30T00:00:00.000Z' });
  const range = { from: '2026-11-16', to: '2026-11-22' };
  assert.deepEqual(view({ ...range, kinds: 'publish' }).events.map(event => event.id), [`publish:${mine.id}`, `publish:${loose.id}`, `publish:${foreign.id}`]);
  assert.deepEqual(view({ ...range, kinds: 'publish', brand_id: brand.id }).events.map(event => event.id), [`publish:${mine.id}`, `publish:${loose.id}`]);
  assert.deepEqual(view({ ...range, brand_id: brand.id, campaign_id: campaign.id }).events.map(event => event.id), [`plan:${campaign.id}`, `publish:${mine.id}`]);
  const plans = view({ ...range, kinds: 'plan,plan' });
  assert.deepEqual([plans.events.map(event => event.id), plans.sources], [[`plan:${otherCampaign.id}`, `plan:${campaign.id}`], [{ kind: 'plan', availability: 'available' }]]);
  assert.throws(() => view({ ...range, kinds: 'publish,holiday' }), status(422));
  assert.throws(() => view({ from: '2026-11-22', to: '2026-11-16' }), status(422));
  assert.throws(() => view({ from: '2026-01-01', to: '2027-03-01' }), status(422));
  assert.throws(() => view({ from: '2026-02-30' }), status(422));
  assert.throws(() => view({ tz: 'Mars/Olympus' }), status(422));
  assert.throws(() => view({ brand_id: brand.id, campaign_id: otherCampaign.id }), status(422));
  assert.throws(() => view({ brand_id: 'missing' }), status(404));
});

test('calendar marks role-restricted sources instead of silently returning nothing', () => {
  const { ctx, view, brand, campaign } = fixture();
  const adAccount = ctx.create('ad_account', { provider: 'meta_ads', brand_id: brand.id, currency: 'USD', timezone: 'UTC' });
  const revision = ctx.create('ad_proposal_revision', { schedule: { starts_at: '2026-11-17T00:00:00.000Z', ends_at: '2026-11-19T00:00:00.000Z', tz: 'UTC' } });
  const proposal = ctx.create('ad_proposal', { ad_account_id: adAccount.id, brand_id: brand.id, name: 'Flight', status: 'approved', current_revision_id: revision.id });
  const store = ctx.create('store', { brand_id: brand.id });
  ctx.create('promotion', { store_id: store.id, campaign_id: campaign.id, name: 'Sale', valid_from: '2026-11-17T00:00:00.000Z', valid_until: '2026-11-20T00:00:00.000Z', state: 'planned' });
  const query = { from: '2026-11-16', to: '2026-11-22', kinds: 'ad_flight,promotion' };
  assert.equal(view(query).events.length, 2);
  ctx.role = 'viewer';
  const restricted = view(query);
  assert.deepEqual([restricted.events, restricted.sources], [[], [{ kind: 'ad_flight', availability: 'no_permission' }, { kind: 'promotion', availability: 'no_permission' }]]);
  ctx.update('ad_account', adAccount.id, { permissions: [{ actor_id: ctx.actorId, actions: ['read'] }] });
  const granted = view(query);
  assert.deepEqual(granted.events.map(event => event.id), [`ad_flight:${proposal.id}`]);
  assert.deepEqual(granted.sources.map(source => source.availability), ['available', 'no_permission']);
});
