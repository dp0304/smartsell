import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Problem, type Data, type Row } from '@smartsell/contracts';
import { testWorkspace } from '../../lifecycle/workspace-test-context.js';
import { socialViewOperations, type Metric, type Point } from './social.js';

type Account = { social_account_id: string; platform: string; followers: Metric & { delta: number | null }; metrics: Record<string, Metric>; posts_published: number; last_observed_at: string | null };
type View = {
  period: Data; compare_period: Data; accounts: Account[]; totals: Record<string, Metric>;
  series: { metric: string; total: Point[]; by_account: { social_account_id: string; label: string; points: Point[] }[] };
  top_posts: { platform_post_id: string; metrics: Record<string, Metric> }[]; unranked_count: number; warnings: string[]; as_of: string;
};
const status = (code: number) => (error: unknown) => error instanceof Problem && error.status === code;
const week = { from: '2026-11-13', to: '2026-11-19' };

function fixture() {
  const workspace = testWorkspace(socialViewOperations);
  const { ctx } = workspace;
  const brand = ctx.create('brand', { name: 'Brand', slug: 'brand', status: 'active' });
  const ig = ctx.create('social_account', { provider: 'meta_instagram', display_name: 'Brand IG', handle: 'brand.ig', brand_id: brand.id, status: 'active' });
  const tiktok = ctx.create('social_account', { provider: 'tiktok', display_name: 'Brand TikTok', brand_id: brand.id, status: 'active' });
  const post = (account: Row, published_at: string, values: Data = {}) => ctx.create('platform_post', { social_account_id: account.id, provider: account.provider, published_at, ...values });
  const subject_type = (subject: Row) => subject.social_account_id ? 'platform_post' : 'social_account';
  const daily = (subject: Row, metric_key: string, date: string, value: number | null, values: Data = {}) => ctx.create('metric_observation', {
    subject_type: subject_type(subject), subject_id: subject.id, metric_key, value, availability: value === null ? 'not_collected' : 'observed',
    period_kind: 'day', period_start: `${date}T00:00:00.000Z`, period_end: new Date(Date.parse(date) + 86_400_000).toISOString(),
    date, observed_at: '2026-11-19T10:00:00.000Z', source: { method: 'import' }, ...values });
  const snapshot = (subject: Row, metric_key: string, observed_at: string, value: number) => ctx.create('metric_observation', {
    subject_type: subject_type(subject), subject_id: subject.id, metric_key, value, availability: 'observed', period_kind: 'lifetime', observed_at });
  const view = (query: Record<string, string> = {}, range: Record<string, string> = week) => workspace.call<View>('views_social', {}, undefined, { ...range, ...query });
  const account = (result: View, row: Row) => result.accounts.find(item => item.social_account_id === row.id)!;
  const points = (result: View, row: Row) => result.series.by_account.find(item => item.social_account_id === row.id)!.points;
  return { ...workspace, brand, ig, tiktok, post, daily, snapshot, view, account, points };
}

test('every date has a point and unknown days stay null instead of becoming zero', () => {
  const { view, ig, daily, account, points } = fixture();
  daily(ig, 'views', '2026-11-13', 100);
  daily(ig, 'views', '2026-11-14', 0);
  daily(ig, 'views', '2026-11-16', null, { availability: 'no_permission' });
  const result = view();
  assert.deepEqual(result.period, { from: '2026-11-13', to: '2026-11-19', tz: 'UTC' });
  assert.deepEqual(result.compare_period, { from: '2026-11-06', to: '2026-11-12' });
  assert.deepEqual(points(result, ig), [
    { date: '2026-11-13', value: 100, availability: 'observed' }, { date: '2026-11-14', value: 0, availability: 'observed' },
    { date: '2026-11-15', value: null, availability: 'not_collected' }, { date: '2026-11-16', value: null, availability: 'no_permission' },
    { date: '2026-11-17', value: null, availability: 'not_collected' }, { date: '2026-11-18', value: null, availability: 'not_collected' },
    { date: '2026-11-19', value: null, availability: 'not_collected' },
  ]);
  assert.deepEqual(result.series.total.map(point => point.value), [100, 0, null, null, null, null, null]);
  assert.equal(result.series.total.length, 7);
  assert.deepEqual(account(result, ig).metrics.views, { value: 100, availability: 'observed', previous_value: null, change_ratio: null, coverage: { observed: 2, expected: 7 } });
  const quiet = account(view({ from: '2026-11-17', to: '2026-11-19' }), ig);
  assert.deepEqual([quiet.metrics.views.value, quiet.metrics.views.availability, quiet.followers.value, quiet.metrics.engagement_rate.value], [null, 'not_collected', null, null]);
  assert.ok(result.warnings.includes('PARTIAL_COVERAGE'));
});

test('account totals fall back to post reports and engagements to their known components', () => {
  const { view, tiktok, post, daily, account, points } = fixture();
  const first = post(tiktok, '2026-11-10T08:00:00.000Z');
  const second = post(tiktok, '2026-11-11T08:00:00.000Z');
  daily(first, 'views', '2026-11-18', 50);
  daily(second, 'norm.post.views', '2026-11-18', 30);
  daily(first, 'likes', '2026-11-18', 5);
  daily(first, 'comments', '2026-11-18', 2);
  daily(second, 'engagements', '2026-11-18', 10);
  daily(second, 'likes', '2026-11-18', 99);
  daily(first, 'likes', '2026-11-17', null);
  daily(first, 'comments', '2026-11-17', null);
  const result = view({ metric: 'engagements' });
  const card = account(result, tiktok);
  assert.deepEqual([card.metrics.views.value, card.metrics.engagements.value], [80, 17]);
  assert.equal(card.metrics.engagement_rate.value, 17 / 80);
  assert.deepEqual(points(result, tiktok).slice(4, 6), [{ date: '2026-11-17', value: null, availability: 'not_collected' }, { date: '2026-11-18', value: 17, availability: 'observed' }]);
  assert.ok(result.warnings.includes('ACCOUNT_METRICS_FROM_POSTS'));
});

test('account-level reports win over post sums and compare with the previous period', () => {
  const { view, ig, post, daily, account } = fixture();
  const item = post(ig, '2026-11-14T08:00:00.000Z');
  daily(ig, 'views', '2026-11-08', 50);
  daily(ig, 'views', '2026-11-15', 100);
  daily(item, 'views', '2026-11-15', 999);
  daily(ig, 'followers', '2026-11-10', 1000);
  daily(ig, 'norm.account.followers', '2026-11-18', 1050);
  daily(ig, 'followers', '2026-11-19', 1040);
  daily(ig, 'reach', '2026-11-15', 70);
  const card = account(view(), ig);
  assert.deepEqual([card.metrics.views.value, card.metrics.views.previous_value, card.metrics.views.change_ratio], [100, 50, 1]);
  assert.deepEqual([card.followers.value, card.followers.previous_value, card.followers.delta, card.followers.change_ratio], [1040, 1000, 40, 0.04]);
  assert.deepEqual([card.metrics.reach.value, card.metrics.reach.availability], [70, 'observed']);
  assert.equal(card.posts_published, 1);
  assert.equal(card.last_observed_at, '2026-11-19T10:00:00.000Z');
  daily(ig, 'reach', '2026-11-16', 80);
  assert.deepEqual(account(view(), ig).metrics.reach, { value: null, availability: 'not_applicable', previous_value: null, change_ratio: null }, 'Reach is never summed across days');
});

test('lifetime snapshots become daily increments only where consecutive days are known', () => {
  const { view, ig, post, snapshot, points } = fixture();
  const item = post(ig, '2026-11-15T02:00:00.000Z');
  snapshot(item, 'norm.post.views', '2026-11-15T20:00:00.000Z', 100);
  snapshot(item, 'norm.post.views', '2026-11-16T08:00:00.000Z', 140);
  snapshot(item, 'norm.post.views', '2026-11-16T20:00:00.000Z', 160);
  snapshot(item, 'norm.post.views', '2026-11-18T20:00:00.000Z', 200);
  snapshot(item, 'norm.post.views', '2026-11-19T08:00:00.000Z', 190);
  assert.deepEqual(points(view(), ig).map(point => [point.value, point.availability]), [
    [null, 'not_collected'], [null, 'not_collected'], [100, 'observed'], [60, 'observed'], [null, 'not_collected'], [null, 'not_collected'], [null, 'sync_failed']]);
});

test('top posts rank only known values and count the rest as unranked', () => {
  const { view, ig, tiktok, post, daily, snapshot } = fixture();
  const lifetime = post(ig, '2026-11-14T08:00:00.000Z', { permalink: 'https://example.com/1', title: 'Launch reel' });
  const dailyOnly = post(tiktok, '2026-11-15T08:00:00.000Z');
  const blank = post(tiktok, '2026-11-16T08:00:00.000Z');
  const old = post(ig, '2026-11-01T08:00:00.000Z');
  snapshot(lifetime, 'views', '2026-11-18T08:00:00.000Z', 400);
  snapshot(lifetime, 'views', '2026-11-19T08:00:00.000Z', 500);
  daily(dailyOnly, 'views', '2026-11-15', 20);
  daily(dailyOnly, 'views', '2026-11-16', 10);
  daily(dailyOnly, 'engagements', '2026-11-16', 9);
  daily(blank, 'views', '2026-11-16', null, { availability: 'no_permission' });
  daily(old, 'views', '2026-11-16', 9999);
  const result = view();
  assert.deepEqual(result.top_posts.map(item => [item.platform_post_id, item.metrics.views.value]), [[lifetime.id, 500], [dailyOnly.id, 30]]);
  assert.equal(result.unranked_count, 1);
  assert.deepEqual(result.top_posts[0], { platform_post_id: lifetime.id, social_account_id: ig.id, platform: 'instagram', permalink: 'https://example.com/1',
    published_at: '2026-11-14T08:00:00.000Z', title: 'Launch reel', campaign_id: null,
    metrics: { views: { value: 500, availability: 'observed' }, engagements: { value: null, availability: 'not_collected' } } });
  const byEngagement = view({ metric: 'engagements' });
  assert.deepEqual([byEngagement.top_posts.map(item => item.platform_post_id), byEngagement.unranked_count], [[dailyOnly.id], 2]);
});

test('totals add known accounts only, report coverage and flag cross-platform sums', () => {
  const { view, ig, tiktok, daily } = fixture();
  daily(ig, 'views', '2026-11-15', 100);
  daily(ig, 'views', '2026-11-08', 40);
  let result = view();
  assert.deepEqual(result.totals.views, { value: 100, availability: 'observed', previous_value: 40, change_ratio: 1.5, coverage: { observed: 1, expected: 2 } });
  assert.deepEqual(result.totals.engagements, { value: null, availability: 'not_collected', previous_value: null, change_ratio: null, coverage: { observed: 0, expected: 2 } });
  assert.ok(result.warnings.includes('PARTIAL_COVERAGE'));
  daily(tiktok, 'views', '2026-11-15', 50);
  result = view();
  assert.deepEqual([result.totals.views.value, result.series.total[2]], [150, { date: '2026-11-15', value: 150, availability: 'observed' }]);
  assert.ok(result.warnings.includes('NON_ADDITIVE_ACROSS_PLATFORMS'));
});

test('restricted sources, filters and agent visibility are applied on the server', () => {
  const { ctx, view, brand, ig, tiktok, daily } = fixture();
  const hidden = ctx.create('data_source', { status: 'active', allowed_uses: { display: false } });
  const shown = ctx.create('data_source', { status: 'active', allowed_uses: { display: true } });
  daily(ig, 'views', '2026-11-15', 100, { data_source_id: shown.id });
  daily(ig, 'views', '2026-11-16', 100, { source: { method: 'import', data_source_id: hidden.id } });
  daily(tiktok, 'views', '2026-11-15', 5);
  const other = ctx.create('brand', { name: 'Other', slug: 'other', status: 'active' });
  ctx.create('social_account', { provider: 'youtube', display_name: 'Other YT', brand_id: other.id, status: 'active' });
  ctx.create('social_account', { provider: 'youtube', display_name: 'Archived', brand_id: brand.id, status: 'archived' });
  const result = view();
  assert.equal(result.accounts.length, 3);
  assert.ok(result.warnings.includes('SOURCE_USE_RESTRICTED'));
  assert.equal(result.accounts.find(item => item.social_account_id === ig.id)!.metrics.views.value, 100);
  assert.deepEqual(view({ brand_id: brand.id }).accounts.map(item => item.social_account_id), [ig.id, tiktok.id]);
  assert.deepEqual(view({ platform: 'meta_instagram,youtube', brand_id: brand.id }).accounts.map(item => item.platform), ['instagram']);
  ctx.role = 'agent';
  assert.deepEqual(view().accounts, []);
  (ctx as typeof ctx & { canReadWorkspaceResource(kind: string, row: Row): boolean }).canReadWorkspaceResource = (_kind, row) => row.id === tiktok.id;
  assert.deepEqual(view().accounts.map(item => item.social_account_id), [tiktok.id]);
});

test('report days follow the requested time zone and date-only reports keep their calendar day', () => {
  const { ctx, view, ig, points } = fixture();
  ctx.create('metric_observation', { subject_type: 'social_account', subject_id: ig.id, metric_key: 'views', value: 7, availability: 'observed', period_kind: 'day',
    period_start: '2026-11-18T16:00:00.000Z', period_end: '2026-11-19T16:00:00.000Z', observed_at: '2026-11-19T10:00:00.000Z' });
  ctx.create('metric_observation', { subject_type: 'social_account', subject_id: ig.id, metric_key: 'views', value: 3, availability: 'observed', period_kind: 'day',
    period_start: '2026-11-15T00:00:00.000Z', period_end: '2026-11-16T00:00:00.000Z', observed_at: '2026-11-19T10:00:00.000Z' });
  const taipei = points(view({ tz: 'Asia/Taipei' }), ig);
  assert.deepEqual([taipei.find(point => point.date === '2026-11-19')!.value, taipei.find(point => point.date === '2026-11-15')!.value], [7, 3]);
  const pacific = points(view({ tz: 'America/Los_Angeles' }), ig);
  assert.deepEqual([pacific.find(point => point.date === '2026-11-18')!.value, pacific.find(point => point.date === '2026-11-15')!.value], [7, 3]);
  const defaults = view({}, {});
  assert.deepEqual([defaults.period, defaults.series.total.length], [{ from: '2026-10-21', to: '2026-11-19', tz: 'UTC' }, 30]);
  assert.throws(() => view({ metric: 'revenue' }), status(422));
  assert.throws(() => view({ limit: '0' }), status(422));
});

test('a change needs the previous period collected on the same days, so a late import is not growth', () => {
  const { view, ig, tiktok, daily, account } = fixture();
  // Collection starts on the last day of the compare window (11-06..11-12) and runs through the period.
  for (let day = 12; day <= 19; day++) daily(ig, 'views', `2026-11-${day}`, 1000);
  let result = view();
  assert.deepEqual(account(result, ig).metrics.views, { value: 7000, availability: 'observed', previous_value: null, change_ratio: null, coverage: { observed: 7, expected: 7 } });
  assert.deepEqual(result.totals.views, { value: 7000, availability: 'observed', previous_value: null, change_ratio: null, coverage: { observed: 1, expected: 2 } });
  for (let day = 6; day <= 11; day++) daily(ig, 'views', `2026-11-${String(day).padStart(2, '0')}`, 1000);
  result = view();
  assert.deepEqual([result.totals.views.value, result.totals.views.previous_value, result.totals.views.change_ratio], [7000, 7000, 0]);
  // A day not collected yet now is left out of the previous side too, so a flat week stays flat.
  const lagging = account(view({}, { from: '2026-11-14', to: '2026-11-20' }), ig).metrics.views;
  assert.deepEqual([lagging.value, lagging.previous_value, lagging.change_ratio, lagging.coverage], [6000, 6000, 0, { observed: 6, expected: 7 }]);
  // An account that only started reporting this period keeps the total from comparing different accounts.
  daily(tiktok, 'views', '2026-11-15', 500);
  result = view();
  assert.deepEqual([account(result, tiktok).metrics.views.previous_value, account(result, ig).metrics.views.change_ratio], [null, 0]);
  assert.deepEqual([result.totals.views.value, result.totals.views.previous_value, result.totals.views.change_ratio], [7500, null, null]);
});

test('the follower total carries each account forward and is unknown until every account has a count', () => {
  const { view, ig, tiktok, daily, account } = fixture();
  for (let day = 6; day <= 19; day++) daily(ig, 'followers', `2026-11-${String(day).padStart(2, '0')}`, 10_000);
  for (const day of ['15', '17', '19']) daily(tiktok, 'followers', `2026-11-${day}`, 50_000);
  const result = view({ metric: 'followers' });
  assert.deepEqual(result.series.total.map(point => [point.date.slice(5), point.value, point.availability]), [
    ['11-13', null, 'not_collected'], ['11-14', null, 'not_collected'], ['11-15', 60_000, 'observed'], ['11-16', 60_000, 'estimated'],
    ['11-17', 60_000, 'observed'], ['11-18', 60_000, 'estimated'], ['11-19', 60_000, 'observed'],
  ]);
  assert.deepEqual([account(result, tiktok).followers.previous_value, account(result, tiktok).followers.delta], [null, null]);
  assert.deepEqual([account(result, ig).followers.change_ratio, account(result, ig).followers.delta], [0, 0]);
  daily(ig, 'followers', '2026-11-25', null, { availability: 'sync_failed' });
  assert.deepEqual(view({ metric: 'followers' }, { from: '2026-11-25', to: '2026-11-25' }).series.total, [{ date: '2026-11-25', value: null, availability: 'sync_failed' }]);
});
