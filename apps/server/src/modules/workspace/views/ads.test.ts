import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Problem, type Data, type Row } from '@smartsell/contracts';
import { testWorkspace } from '../../lifecycle/workspace-test-context.js';
import { adsViewOperations, type Pacing } from './ads.js';
import type { Metric, Point } from './social.js';

type View = {
  period: Data; compare_period: Data; accounts: Data[]; pacing: Pacing[]; budget_availability: Pacing['budget_availability']; metrics: Record<string, Metric & { currency?: string | null; by_currency?: Data[] }>;
  series: { spend: Point[]; currency: string | null; by_currency?: { currency: string; points: Point[] }[] }; proposals: Data[]; adjustments_proposed: number; warnings: string[]; as_of: string;
};
const status = (code: number) => (error: unknown) => error instanceof Problem && error.status === code;
const week = { from: '2026-11-13', to: '2026-11-19' };

function fixture() {
  const workspace = testWorkspace(adsViewOperations);
  const { ctx } = workspace;
  const brand = ctx.create('brand', { name: 'Brand', slug: 'brand', status: 'active' });
  const account = ctx.create('ad_account', { provider: 'meta_ads', brand_id: brand.id, external_account_id: 'act_1', currency: 'USD', timezone: 'UTC' });
  const campaign = ctx.create('campaign', { brand_id: brand.id, name: 'Launch', status: 'active' });
  ctx.create('budget_line', { campaign_id: campaign.id, category: 'ads', currency: 'USD', amount_minor: 1000 });
  ctx.create('budget_line', { campaign_id: campaign.id, category: 'production', currency: 'USD', amount_minor: 99 });
  const entity = (level: string, values: Data = {}) => ctx.create('ad_entity', { ad_account_id: account.id, level, name: level, ...values });
  const top = entity('campaign', { campaign_id: campaign.id });
  const group = entity('ad_group', { campaign_id: campaign.id, parent_entity_id: top.id });
  const ad = entity('ad', { campaign_id: campaign.id, parent_entity_id: group.id });
  const report = (subject: Row, metric: string, date: string, value: number | null, values: Data = {}) => ctx.create('metric_observation', {
    subject_type: 'ads.ad_entity', subject_id: subject.id, ad_account_id: subject.ad_account_id, metric_key: `ads.${metric}`, period_kind: 'day', native_date: date,
    value, availability: value === null ? 'source_not_provided' : 'observed', currency: metric === 'spend' ? 'USD' : undefined, observed_at: '2026-11-19T10:00:00.000Z', ...values });
  const view = (query: Record<string, string> = {}) => workspace.call<View>('views_ads', {}, undefined, { ...week, ...query });
  return { ...workspace, brand, account, campaign, top, group, ad, entity, report, view };
}

test('daily spend has a point for every day and unknown spend is never zero', () => {
  const { view, top, ad, report } = fixture();
  report(top, 'spend', '2026-11-13', 100);
  report(top, 'spend', '2026-11-14', 0);
  report(top, 'spend', '2026-11-15', null);
  report(ad, 'spend', '2026-11-13', 60);
  report(ad, 'spend', '2026-11-16', 25);
  report(top, 'spend', '2026-11-10', 50);
  report(top, 'impressions', '2026-11-13', 1000);
  report(ad, 'impressions', '2026-11-13', 600);
  const result = view();
  assert.deepEqual(result.series.spend, [
    { date: '2026-11-13', value: 100, availability: 'observed' }, { date: '2026-11-14', value: 0, availability: 'observed' },
    { date: '2026-11-15', value: null, availability: 'source_not_provided' }, { date: '2026-11-16', value: 25, availability: 'observed' },
    { date: '2026-11-17', value: null, availability: 'not_collected' }, { date: '2026-11-18', value: null, availability: 'not_collected' },
    { date: '2026-11-19', value: null, availability: 'not_collected' },
  ]);
  assert.equal(result.series.currency, 'USD');
  // 11-10 lines up with 11-17, which has no report now, while the days reported now have none before: not comparable.
  assert.deepEqual(result.metrics.spend, { value: 125, availability: 'observed', previous_value: null, change_ratio: null, currency: 'USD' });
  assert.deepEqual(result.metrics.impressions, { value: 1000, availability: 'observed', previous_value: null, change_ratio: null }, 'A reported parent total already includes its ads');
  assert.deepEqual(result.metrics.clicks, { value: null, availability: 'not_collected', previous_value: null, change_ratio: null });
  assert.deepEqual([result.period, result.compare_period], [week, { from: '2026-11-06', to: '2026-11-12' }]);
  assert.deepEqual(result.accounts, [{ id: result.accounts[0]!.id, provider: 'meta_ads', name: 'act_1', currency: 'USD', timezone: 'UTC', read_capability: 'unavailable', last_import_at: '2026-11-19T10:00:00.000Z' }]);
});

test('spend changes compare the same days only, so a report import that started mid-period is not growth', () => {
  const { view, top, report } = fixture();
  // Reported every day this week; last week only from 11-12 on (the matching day of 11-19).
  for (const day of ['13', '14', '15', '16', '17', '18', '19']) report(top, 'spend', `2026-11-${day}`, 100);
  report(top, 'spend', '2026-11-12', 100);
  assert.deepEqual(view().metrics.spend, { value: 700, availability: 'observed', previous_value: null, change_ratio: null, currency: 'USD' });
  // With last week fully reported the change is real; a previous day whose current day is missing is left out.
  for (const day of ['06', '07', '08', '09', '10', '11']) report(top, 'spend', `2026-11-${day}`, 50);
  assert.deepEqual(view().metrics.spend, { value: 700, availability: 'observed', previous_value: 400, change_ratio: 0.75, currency: 'USD' });
  const partial = fixture();
  for (const day of ['13', '14']) partial.report(partial.top, 'spend', `2026-11-${day}`, 100);
  for (const day of ['06', '07', '08', '09']) partial.report(partial.top, 'spend', `2026-11-${day}`, 50);
  assert.deepEqual(partial.view().metrics.spend, { value: 200, availability: 'observed', previous_value: 100, change_ratio: 1, currency: 'USD' });
});

test('spend changes are per ad account and currency: a new account or a currency switch is not growth', () => {
  const days = ['13', '14', '15', '16', '17', '18', '19'], before = ['06', '07', '08', '09', '10', '11', '12'];
  const second = (f: ReturnType<typeof fixture>, currency: string) => {
    const account = f.ctx.create('ad_account', { provider: 'meta_ads', brand_id: f.brand.id, external_account_id: 'act_2', currency, timezone: 'UTC' });
    return f.ctx.create('ad_entity', { ad_account_id: account.id, level: 'campaign', name: 'Second', campaign_id: f.campaign.id });
  };
  // Account 1 reports in both weeks; account 2 only starts this week.
  const started = fixture();
  for (const day of [...days, ...before]) started.report(started.top, 'spend', `2026-11-${day}`, 100);
  const newcomer = second(started, 'USD');
  for (const day of days) started.report(newcomer, 'spend', `2026-11-${day}`, 50);
  assert.deepEqual(started.view().metrics.spend, { value: 1050, availability: 'observed', previous_value: null, change_ratio: null, currency: 'USD' });
  // This week in USD only, last week in GBP only: never compared across currencies.
  const switched = fixture();
  for (const day of days) switched.report(switched.top, 'spend', `2026-11-${day}`, 100);
  const pounds = second(switched, 'GBP');
  for (const day of before) switched.report(pounds, 'spend', `2026-11-${day}`, 80, { currency: 'GBP' });
  assert.deepEqual(switched.view().metrics.spend, { value: 700, availability: 'observed', previous_value: null, change_ratio: null, currency: 'USD' });
});

test('pacing is reported per campaign and currency with coverage of complete reporting days', () => {
  const { ctx, view, brand, campaign, top, ad, entity, report } = fixture();
  report(top, 'spend', '2026-11-13', 100);
  report(top, 'spend', '2026-11-14', 0);
  report(top, 'spend', '2026-11-15', null);
  report(ad, 'spend', '2026-11-16', 25);
  const loose = entity('campaign');
  report(loose, 'spend', '2026-11-15', 10);
  const planned = ctx.create('campaign', { brand_id: brand.id, name: 'Planned', status: 'planned' });
  ctx.create('budget_line', { campaign_id: planned.id, category: 'ads', currency: 'EUR', amount_minor: 500 });
  ctx.create('campaign', { brand_id: brand.id, name: 'No ads', status: 'planned' });
  assert.deepEqual(view().pacing, [
    { campaign_id: campaign.id, currency: 'USD', budget_minor: 1000, budget_availability: 'available', actual_spend_minor: 125, coverage_ratio: 3 / 7, delayed: true },
    { campaign_id: planned.id, currency: 'EUR', budget_minor: 500, budget_availability: 'available', actual_spend_minor: null, coverage_ratio: null, delayed: null },
    { campaign_id: null, currency: 'USD', budget_minor: null, budget_availability: 'available', actual_spend_minor: 10, coverage_ratio: 1 / 7, delayed: true },
  ]);
  const scoped = view({ campaign_id: campaign.id });
  assert.deepEqual([scoped.pacing.map(row => row.campaign_id), scoped.metrics.spend.value], [[campaign.id], 125]);
  for (const day of ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-15']) report(top, 'spend', day, 1, { observed_at: '2026-11-19T11:00:00.000Z', availability: 'observed' });
  const complete = view({ campaign_id: campaign.id }).pacing[0]!;
  assert.deepEqual([complete.coverage_ratio, complete.delayed, complete.actual_spend_minor], [1, false, 129]);
});

test('proposals carry the current revision schedule, budget, estimates and approval state', () => {
  const { ctx, view, account, campaign, ad } = fixture();
  const revision = ctx.create('ad_proposal_revision', { schedule: { starts_at: '2026-11-20T00:00:00.000Z', ends_at: '2026-11-27T00:00:00.000Z', tz: 'UTC' },
    budget: { type: 'daily', amount_minor: 100, currency: 'USD', cap_minor: 150 }, estimates: [{ metric: 'reach', value: 5000, source: 'agent', estimate: true }] });
  const request = ctx.create('ad_approval_request', { status: 'pending' });
  const proposal = ctx.create('ad_proposal', { ad_account_id: account.id, brand_id: account.brand_id, campaign_id: campaign.id, name: 'Boost', status: 'in_review',
    current_revision_id: revision.id, approval_request_id: request.id });
  const bare = ctx.create('ad_proposal', { ad_account_id: account.id, brand_id: account.brand_id, name: 'Draft', status: 'draft' });
  ctx.create('adjustment_suggestion', { ad_account_id: account.id, target_entity_id: ad.id, status: 'proposed' });
  ctx.create('adjustment_suggestion', { ad_account_id: account.id, target_entity_id: ad.id, status: 'accepted' });
  const result = view();
  assert.deepEqual(result.proposals.find(row => row.id === proposal.id), { id: proposal.id, name: 'Boost', status: 'in_review', campaign_id: campaign.id, ad_account_id: account.id,
    schedule: { starts_at: '2026-11-20T00:00:00.000Z', ends_at: '2026-11-27T00:00:00.000Z', tz: 'UTC' }, budget: { type: 'daily', amount_minor: 100, currency: 'USD' },
    estimates: [{ metric: 'reach', value: 5000, source: 'agent' }], approval_status: 'pending' });
  assert.deepEqual(result.proposals.find(row => row.id === bare.id), { id: bare.id, name: 'Draft', status: 'draft', campaign_id: null, ad_account_id: account.id,
    schedule: null, budget: null, estimates: [], approval_status: null });
  assert.equal(result.adjustments_proposed, 1);
  assert.deepEqual(view({ campaign_id: campaign.id }).proposals.map(row => row.id), [proposal.id]);
});

test('accounts without an ads read grant are hidden and reported as no permission', () => {
  const { ctx, view, account, top, report } = fixture();
  report(top, 'spend', '2026-11-13', 100);
  ctx.role = 'viewer';
  const hidden = view();
  assert.deepEqual([hidden.accounts, hidden.pacing, hidden.proposals, hidden.warnings], [[], [], [], ['AD_ACCOUNTS_HIDDEN']]);
  assert.deepEqual(hidden.metrics.spend, { value: null, availability: 'no_permission', previous_value: null, change_ratio: null, currency: null });
  assert.ok(hidden.series.spend.every(point => point.value === null && point.availability === 'no_permission'));
  ctx.update('ad_account', account.id, { permissions: [{ actor_id: ctx.actorId, actions: ['read'] }] });
  const granted = view();
  assert.deepEqual([granted.accounts.length, granted.metrics.spend.value, granted.pacing[0]!.budget_minor, granted.warnings], [1, 100, 1000, []]);
});

test('reviewers see spend pacing but never campaign budgets', () => {
  const { ctx, view, brand, account, campaign, top, report } = fixture();
  report(top, 'spend', '2026-11-13', 100);
  const planned = ctx.create('campaign', { brand_id: brand.id, name: 'Planned', status: 'planned' });
  ctx.create('budget_line', { campaign_id: planned.id, category: 'ads', currency: 'EUR', amount_minor: 500 });
  ctx.update('ad_account', account.id, { permissions: [{ actor_id: ctx.actorId, actions: ['read'] }] });
  ctx.role = 'reviewer';
  assert.deepEqual(view().pacing, [
    { campaign_id: campaign.id, currency: 'USD', budget_minor: null, budget_availability: 'no_permission', actual_spend_minor: 100, coverage_ratio: 1 / 7, delayed: true },
  ], 'A campaign known only from its budget lines is not revealed either');
  ctx.role = 'viewer';
  assert.deepEqual(view().pacing.map(row => [row.campaign_id, row.budget_minor, row.budget_availability]), [[campaign.id, 1000, 'available'], [planned.id, 500, 'available']]);
});

test('an empty pacing list says whether budgets are hidden from the caller rather than absent', () => {
  const workspace = testWorkspace(adsViewOperations);
  const { ctx } = workspace;
  const brand = ctx.create('brand', { name: 'Brand', slug: 'brand', status: 'active' });
  ctx.create('ad_account', { provider: 'meta_ads', brand_id: brand.id, external_account_id: 'act_1', currency: 'USD', timezone: 'UTC',
    permissions: [{ actor_id: ctx.actorId, actions: ['read'] }] });
  const view = () => workspace.call<View>('views_ads', {}, undefined, week);
  ctx.role = 'reviewer';
  const empty = view();
  assert.deepEqual([empty.accounts.length, empty.pacing, empty.budget_availability, empty.warnings], [1, [], 'no_permission', []], 'Nothing reveals whether a budget exists');
  const campaign = ctx.create('campaign', { brand_id: brand.id, name: 'Launch', status: 'planned' });
  ctx.create('budget_line', { campaign_id: campaign.id, category: 'ads', currency: 'USD', amount_minor: 5_000_000 });
  assert.deepEqual(view(), empty, 'A hidden budget leaves the reviewer response unchanged');
  ctx.role = 'owner';
  const owner = view();
  assert.deepEqual([owner.pacing.map(row => [row.campaign_id, row.budget_minor]), owner.budget_availability], [[[campaign.id, 5_000_000]], 'available']);
});

test('pacing leaves out campaigns that run on ad accounts the member may not read', () => {
  const { ctx, view, brand, account, campaign, top, report } = fixture();
  const other = ctx.create('brand', { name: 'Other', slug: 'other', status: 'active' });
  const locked = ctx.create('ad_account', { provider: 'meta_ads', brand_id: other.id, external_account_id: 'act_2', currency: 'USD', timezone: 'UTC' });
  const unit = (values: Data) => ctx.create('ad_entity', { ad_account_id: locked.id, level: 'campaign', name: 'Locked', ...values });
  const elsewhere = ctx.create('campaign', { brand_id: other.id, name: 'Elsewhere', status: 'active' });
  ctx.create('budget_line', { campaign_id: elsewhere.id, category: 'ads', currency: 'USD', amount_minor: 777 });
  report(unit({ campaign_id: elsewhere.id }), 'spend', '2026-11-13', 5);
  const tied = ctx.create('campaign', { brand_id: brand.id, name: 'Tied', status: 'planned' });
  ctx.create('budget_line', { campaign_id: tied.id, category: 'ads', currency: 'USD', amount_minor: 300, ad_account_id: locked.id });
  const mixed = ctx.create('campaign', { brand_id: brand.id, name: 'Mixed', status: 'active' });
  ctx.create('budget_line', { campaign_id: mixed.id, category: 'ads', currency: 'USD', amount_minor: 900 });
  report(ctx.create('ad_entity', { ad_account_id: account.id, level: 'campaign', name: 'Open', campaign_id: mixed.id }), 'spend', '2026-11-13', 40);
  report(unit({ campaign_id: mixed.id }), 'spend', '2026-11-13', 60);
  const planned = ctx.create('campaign', { brand_id: brand.id, name: 'Planned', status: 'planned' });
  ctx.create('budget_line', { campaign_id: planned.id, category: 'ads', currency: 'USD', amount_minor: 50 });
  ctx.create('ad_proposal', { ad_account_id: locked.id, brand_id: other.id, campaign_id: elsewhere.id, name: 'Secret', status: 'in_review' });
  report(top, 'spend', '2026-11-13', 100);
  assert.deepEqual(view().pacing.map(row => [row.campaign_id, row.budget_minor]), [[campaign.id, 1000], [elsewhere.id, 777], [tied.id, 300], [mixed.id, 900], [planned.id, 50]]);

  ctx.role = 'editor';
  ctx.update('ad_account', account.id, { permissions: [{ actor_id: ctx.actorId, actions: ['read'] }] });
  const member = view();
  assert.deepEqual(member.pacing.map(row => [row.campaign_id, row.budget_minor, row.actual_spend_minor]), [[campaign.id, 1000, 100], [planned.id, 50, null]]);
  assert.deepEqual([member.accounts.map(row => row.id), member.proposals, member.metrics.spend.value, member.warnings], [[account.id], [], 140, ['AD_ACCOUNTS_HIDDEN']]);
  assert.deepEqual(view({ campaign_id: mixed.id }).pacing, []);
  assert.deepEqual(view({ brand_id: brand.id }).warnings, ['AD_ACCOUNTS_HIDDEN'], 'A campaign dropped for an account of another brand is still flagged');
});

test('spend in different currencies is never added together', () => {
  const { ctx, view, brand, top, report } = fixture();
  const second = ctx.create('ad_account', { provider: 'tiktok_ads', brand_id: brand.id, external_account_id: 'tt', currency: 'TWD', timezone: 'Asia/Taipei' });
  const unit = ctx.create('ad_entity', { ad_account_id: second.id, level: 'campaign', name: 'TW' });
  report(top, 'spend', '2026-11-13', 100);
  report(unit, 'spend', '2026-11-13', 3000, { currency: 'TWD' });
  const result = view();
  assert.deepEqual(result.metrics.spend, { value: null, availability: 'not_applicable', previous_value: null, change_ratio: null, currency: null,
    by_currency: [{ currency: 'TWD', value: 3000 }, { currency: 'USD', value: 100 }] });
  assert.deepEqual([result.series.spend[0], result.series.currency], [{ date: '2026-11-13', value: null, availability: 'not_applicable' }, null]);
  assert.deepEqual(result.series.by_currency!.map(series => [series.currency, series.points[0]!.value, series.points.length]), [['TWD', 3000, 7], ['USD', 100, 7]]);
  assert.ok(result.warnings.includes('MIXED_CURRENCIES'));
});

test('ads view filters by brand on the server and validates its query', () => {
  const { ctx, view, brand, top, report } = fixture();
  const other = ctx.create('brand', { name: 'Other', slug: 'other', status: 'active' });
  const foreign = ctx.create('ad_account', { provider: 'meta_ads', brand_id: other.id, external_account_id: 'act_2', currency: 'USD', timezone: 'UTC' });
  report(ctx.create('ad_entity', { ad_account_id: foreign.id, level: 'campaign', name: 'X' }), 'spend', '2026-11-13', 7);
  report(top, 'spend', '2026-11-13', 100);
  assert.equal(view().metrics.spend.value, 107);
  const mine = view({ brand_id: brand.id });
  assert.deepEqual([mine.accounts.length, mine.metrics.spend.value], [1, 100]);
  const otherCampaign = ctx.create('campaign', { brand_id: other.id, name: 'Elsewhere', status: 'active' });
  assert.throws(() => view({ brand_id: brand.id, campaign_id: otherCampaign.id }), status(422));
  assert.throws(() => view({ from: '2026-11-19', to: '2026-11-13' }), status(422));
  const defaults = adsViewOperations[0]!.run(ctx, { body: {}, params: {}, query: {} }) as View;
  assert.deepEqual([defaults.period, defaults.series.spend.length], [{ from: '2026-10-21', to: '2026-11-19' }, 30]);
});
