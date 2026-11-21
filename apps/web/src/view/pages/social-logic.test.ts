import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accountNames, engagementRate, followersTotal, hasAnyData, platformLabel, readSeriesMetric, seriesCoverage, silentAccounts, socialHeadline, sortAccounts,
  type SocialAccount, type SocialData,
} from './social-logic';

const metric = (value: number | null, previous_value: number | null = null, availability = value === null ? 'not_collected' : 'observed') => ({ value, availability, previous_value });
const account = (id: string, values: { followers?: [number | null, number | null]; views?: [number | null, number | null]; engagements?: [number | null, number | null]; rate?: [number | null, number | null]; name?: string; platform?: string } = {}): SocialAccount => ({
  social_account_id: id, platform: values.platform ?? 'instagram', display_name: values.name ?? id,
  followers: { ...metric(...(values.followers ?? [null, null])), delta: values.followers && values.followers[0] !== null && values.followers[1] !== null ? values.followers[0] - values.followers[1] : null },
  metrics: { views: metric(...(values.views ?? [null, null])), engagements: metric(...(values.engagements ?? [null, null])), engagement_rate: metric(...(values.rate ?? [null, null])) },
});

test('followers: unknown stays null, and growth only counts accounts with both periods', () => {
  const none = followersTotal([account('a'), account('b')]);
  assert.deepEqual([none.value, none.availability, none.delta, none.counted, none.total], [null, 'not_collected', null, 0, 2]);
  const restricted = followersTotal([{ ...account('a'), followers: { value: null, availability: 'no_permission' } }]);
  assert.equal(restricted.availability, 'no_permission');
  // b started reporting this period: it adds to the count but not to the growth.
  const mixed = followersTotal([account('a', { followers: [1100, 1000] }), account('b', { followers: [500, null] }), account('c')]);
  assert.deepEqual([mixed.value, mixed.delta, mixed.counted, mixed.total, mixed.previous_value], [1600, 100, 2, 3, null]);
  assert.equal(mixed.change_ratio, 0.1);
  const both = followersTotal([account('a', { followers: [1100, 1000] }), account('b', { followers: [450, 500] })]);
  assert.deepEqual([both.value, both.delta, both.previous_value], [1550, 50, 1500]);
});

test('engagement rate is each account’s own rate weighted by its views', () => {
  assert.deepEqual([engagementRate([account('a')]).value, engagementRate([account('a')]).availability], [null, 'not_collected']);
  const one = engagementRate([account('a', { views: [1000, null], rate: [0.05, null] })]);
  assert.deepEqual([one.value, one.previous_value, one.change_ratio, one.counted], [0.05, null, null, 1]);
  const two = engagementRate([account('a', { views: [1000, 500], rate: [0.05, 0.04] }), account('b', { views: [3000, 500], rate: [0.01, 0.02] }), account('c')]);
  assert.ok(Math.abs(two.value! - 0.02) < 1e-12);
  assert.ok(Math.abs(two.previous_value! - 0.03) < 1e-12);
  assert.deepEqual([two.counted, two.total], [2, 3]);
  // Rates without a view count cannot be weighted and are left out instead of averaged blindly.
  assert.equal(engagementRate([account('a', { rate: [0.5, null] })]).value, null);
  const zero = engagementRate([account('a', { views: [0, null], rate: [0, null] })]);
  assert.deepEqual([zero.value, zero.availability], [0, 'observed']);
});

test('engagement rate compares only accounts known in both periods', () => {
  // a's views are not comparable (it missed a day before), so the change uses b alone and flat rates read as no change.
  const rate = engagementRate([account('a', { views: [7000, null], rate: [0.1, 0.1] }), account('b', { views: [7000, 7000], rate: [0.02, 0.02] })]);
  assert.ok(Math.abs(rate.value! - 0.06) < 1e-12);
  assert.deepEqual([rate.previous_value, rate.change_ratio, rate.counted], [null, 0, 2]);
});

test('accounts: silent detection, busiest first with unknown last, unique names', () => {
  const rows = [account('a', { name: 'Brand' }), account('b', { name: 'Brand', platform: 'tiktok', views: [10, null] }), account('c', { name: 'Shop', views: [50, null] })];
  assert.deepEqual(silentAccounts(rows).map(row => row.social_account_id), ['a']);
  assert.deepEqual(sortAccounts(rows).map(row => row.social_account_id), ['c', 'b', 'a']);
  const names = accountNames(rows, 'zh');
  assert.deepEqual([names.get('a'), names.get('b'), names.get('c')], ['Brand · Instagram', 'Brand · TikTok', 'Shop']);
  assert.equal(platformLabel('xiaohongshu', 'zh'), '小紅書');
  assert.equal(platformLabel('new_network', 'en'), 'new network');
  assert.equal(platformLabel(null, 'zh'), '未知平台');
});

test('series coverage and data presence never treat null as zero', () => {
  assert.deepEqual(seriesCoverage([{ date: '2026-11-01', value: 0 }, { date: '2026-11-02', value: null }, { date: '2026-11-03', value: 4 }]), { known: 2, total: 3 });
  assert.equal(hasAnyData({ accounts: [account('a')], series: { metric: 'views', total: [{ date: '2026-11-01', value: null }], by_account: [] } }), false);
  assert.equal(hasAnyData({ accounts: [account('a', { followers: [0, null] })] }), true);
  assert.equal(readSeriesMetric('engagements'), 'engagements');
  assert.equal(readSeriesMetric('followers'), 'views');
});

test('the headline answers in one sentence and says what was not collected', () => {
  const period = { from: '2026-10-22', to: '2026-11-20', tz: 'UTC' };
  const empty: SocialData = { period, accounts: [account('a')], totals: { views: metric(null), engagements: metric(null) } };
  assert.match(socialHeadline(empty, 'zh'), /還沒有採集到任何社媒數據/);
  const view: SocialData = {
    period, accounts: [account('a', { followers: [1320, 1000], views: [123456, 100000] })],
    totals: { views: { ...metric(123456, 100000), change_ratio: 0.23456 }, engagements: metric(null) },
    top_posts: [{ platform_post_id: 'p', social_account_id: 'a', platform: 'instagram', permalink: null, published_at: null, title: '秋季新品開箱，一次看完全系列八款色號與使用心得分享', campaign_id: null, metrics: { views: metric(9000) } }],
  };
  const zh = socialHeadline(view, 'zh');
  assert.match(zh, /^10\/22–11\/20（30 天）：瀏覽 /);
  assert.match(zh, /較前期 \+23\.5%/);
  assert.match(zh, /互動未採集/);
  assert.match(zh, /粉絲淨增 320/);
  assert.match(zh, /表現最好的是「秋季新品開箱，一次看完全系列八款色號與使用心得分…」（瀏覽 9,000）。$/);
  assert.doesNotMatch(zh, /互動 0/);
  const en = socialHeadline(view, 'en');
  assert.match(en, /engagements not collected/);
  assert.match(en, /\+320 net followers/);
});
