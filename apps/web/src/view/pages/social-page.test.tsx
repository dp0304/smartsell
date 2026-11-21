import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import type { ComponentType, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ViewLang } from '@smartsell/ui';
import { viewKey } from '../data/keys';
import type { AdsData } from './ads-logic';
import type { SocialData } from './social-logic';

// Pages import their stylesheet (bundled by Vite); under Node a stylesheet is an empty module.
registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
// The app's i18n module reads browser storage at import time; give it just enough of a browser.
const globals = globalThis as unknown as { localStorage?: unknown; document?: unknown };
globals.localStorage ??= { getItem: () => null, setItem: () => undefined };
globals.document ??= { documentElement: {} };

const ws = 'w1';
async function render(page: 'social' | 'ads', data: unknown, url: string, extra: [string, Record<string, string>, unknown][] = []) {
  const { ViewContext } = await import('../data/use-view');
  const Page: ComponentType = page === 'social' ? (await import('./SocialPage')).SocialPage : (await import('./AdsPage')).AdsPage;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const query = Object.fromEntries(new URL(url, 'http://x').searchParams);
  const params: Record<string, string> = Object.fromEntries(Object.entries(query).filter(([key]) => ['from', 'to', 'platform', 'metric'].includes(key)));
  client.setQueryData(viewKey(ws, `/views/${page}`, params), { data });
  // The plan lookup reads every page of /views/plans.
  for (const [path, key, value] of extra) client.setQueryData(viewKey(ws, path, key, path === '/views/plans'), { data: value });
  const context = { ws, base: '/app/w1', session: {} as never, workspace: {} as never };
  const wrap = (node: ReactNode) => <QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><ViewLang lang="zh">
    <ViewContext.Provider value={context}>{node}</ViewContext.Provider></ViewLang></MemoryRouter></QueryClientProvider>;
  return renderToStaticMarkup(wrap(<Page />));
}

const days = (values: (number | null)[]) => values.map((value, index) => ({ date: `2026-11-${String(index + 1).padStart(2, '0')}`, value, availability: value === null ? 'not_collected' : 'observed' }));
const unknown = { value: null, availability: 'not_collected', previous_value: null, change_ratio: null };
const period = { from: '2026-11-01', to: '2026-11-07', tz: 'UTC' };

test('social page with nothing collected leads with the import prompt and shows unknown, never 0', async () => {
  const data: SocialData = {
    period, accounts: [{ social_account_id: 'a', platform: 'instagram', display_name: '悅數美妝 IG', followers: { ...unknown, delta: null },
      metrics: { views: { ...unknown, coverage: { observed: 0, expected: 7 } }, engagements: unknown, reach: unknown, engagement_rate: unknown }, posts_published: 0, last_observed_at: null }],
    totals: { views: unknown, engagements: unknown }, series: { metric: 'views', total: days([null, null, null, null, null, null, null]), by_account: [] },
    top_posts: [], unranked_count: 0, warnings: [],
  };
  const out = await render('social', data, '/app/w1/social');
  assert.match(out, /把 IG 和 TikTok 近 30 天的貼文與帳號數據匯入 SmartSell/);
  assert.match(out, /還沒有採集到任何社媒數據/);
  assert.match(out, /未採集/);
  assert.match(out, /悅數美妝 IG/);
  assert.doesNotMatch(out, /vs-kpi-value">0</);
});

test('social page renders KPIs, warnings, accounts and ranked posts', async () => {
  const account = (id: string, platform: string, name: string, views: number | null) => ({
    social_account_id: id, platform, display_name: name, handle: `${id}.shop`, followers: views === null ? { ...unknown, delta: null } : { value: 1000, availability: 'observed', previous_value: 900, change_ratio: 0.111, delta: 100 },
    metrics: { views: { value: views, availability: views === null ? 'not_collected' : 'observed', previous_value: null, change_ratio: null, coverage: { observed: views === null ? 0 : 5, expected: 7 } },
      engagements: { value: views === null ? null : views / 10, availability: views === null ? 'not_collected' : 'observed' }, engagement_rate: { value: views === null ? null : 0.1, availability: views === null ? 'not_collected' : 'observed' } },
    posts_published: 2, last_observed_at: '2026-11-07T10:00:00.000Z',
  });
  const data: SocialData = {
    period, accounts: [account('a', 'instagram', 'Brand IG', 5000), account('b', 'tiktok', 'Brand TikTok', null)],
    totals: { views: { value: 5000, availability: 'observed', previous_value: 4000, change_ratio: 0.25, coverage: { observed: 1, expected: 2 } }, engagements: { value: 500, availability: 'observed' } },
    series: { metric: 'views', total: days([1000, null, 1000, 1000, 1000, 1000, null]), by_account: [] },
    top_posts: [{ platform_post_id: 'p1', social_account_id: 'a', platform: 'instagram', permalink: 'https://instagram.com/p/1', published_at: '2026-11-03T08:00:00.000Z', title: '新品開箱', campaign_id: 'c1', metrics: { views: { value: 3000, availability: 'observed' }, engagements: { value: null, availability: 'not_collected' } } }],
    unranked_count: 2, warnings: ['PARTIAL_COVERAGE', 'NON_ADDITIVE_ACROSS_PLATFORMS'],
  };
  const out = await render('social', data, '/app/w1/social', [['/views/plans', {}, [{ id: 'c1', name: '雙十一檔期', status: 'active', starts_at: null, ends_at: null }]]]);
  assert.match(out, /較前期 \+25%/);
  assert.match(out, /1\/2 個帳號有數據/);
  assert.match(out, /合計只包含已採集的部分/);
  assert.match(out, /跨平台合計只能當作參考/);
  assert.match(out, /7 天中有 5 天有數據/);
  assert.match(out, /新品開箱/);
  assert.match(out, /href="https:\/\/instagram\.com\/p\/1"/);
  assert.match(out, /雙十一檔期/);
  assert.match(out, /另有 2 則這段期間發布的貼文還沒有瀏覽數據/);
  assert.match(out, /1 個帳號在這段期間沒有任何數據/);
  assert.match(out, /aria-pressed="true"[^>]*>全部平台/);
  assert.match(out, /Brand TikTok/);
  assert.match(out, /把 Brand TikTok 近 7 天的貼文與帳號數據匯入 SmartSell/);
  assert.match(out, /粉絲淨增 100/);
});

test('ads page: empty prompt, then per-currency spend, pacing and a proposal awaiting approval', async () => {
  const empty: AdsData = { period, accounts: [], pacing: [], metrics: { spend: { ...unknown, currency: null } }, series: { spend: days([null]), currency: null }, proposals: [], warnings: [] };
  const none = await render('ads', empty, '/app/w1/ads');
  assert.match(none, /幫我把廣告帳戶和近 30 天的投放數據匯入 SmartSell/);
  const data: AdsData = {
    period, as_of: '2026-11-07T12:00:00.000Z',
    accounts: [{ id: 'a', provider: 'meta_ads', name: 'act_1', currency: 'USD', timezone: 'UTC', read_capability: 'available', last_import_at: '2026-11-07T10:00:00.000Z' },
      { id: 'b', provider: 'tiktok_ads', name: 'tt', currency: 'TWD', timezone: 'Asia/Taipei', read_capability: 'unavailable', last_import_at: null }],
    pacing: [{ campaign_id: 'c1', currency: 'USD', budget_minor: 100000, actual_spend_minor: 25000, coverage_ratio: 5 / 7, delayed: true }],
    metrics: { spend: { value: null, availability: 'not_applicable', currency: null, by_currency: [{ currency: 'TWD', value: 300000 }, { currency: 'USD', value: 25000 }] },
      impressions: { value: 12000, availability: 'observed' }, clicks: unknown, conversions: unknown },
    series: { spend: days([null, null, null, null, null, null, null]), currency: null, by_currency: [{ currency: 'TWD', points: days([100000, null, 200000, null, null, null, null]) }, { currency: 'USD', points: days([25000, null, null, null, null, null, null]) }] },
    proposals: [{ id: 'p1', name: 'Boost 新品', status: 'in_review', campaign_id: 'c1', schedule: { starts_at: '2026-11-08T00:00:00.000Z', ends_at: '2026-11-15T00:00:00.000Z', tz: 'UTC' },
      budget: { type: 'daily', amount_minor: 5000, currency: 'USD' }, estimates: [{ metric: 'reach', value: 5000, source: 'agent' }], approval_status: 'pending' }],
    adjustments_proposed: 0, warnings: ['MIXED_CURRENCIES'],
  };
  const out = await render('ads', data, '/app/w1/ads', [['/views/plans', {}, [{ id: 'c1', name: '雙十一檔期', status: 'active', starts_at: '2026-11-01T00:00:00.000Z', ends_at: '2026-11-30T00:00:00.000Z' }]]]);
  assert.match(out, /花費 · TWD/);
  assert.match(out, /花費 · USD/);
  assert.match(out, /多幣別分開顯示，不加總/);
  assert.match(out, /花費分幣別顯示，不會加總/);
  assert.match(out, /雙十一檔期/);
  assert.match(out, /數據未齊/);
  assert.match(out, /已回報 5\/7 天/);
  assert.match(out, /已用 25%/);
  assert.match(out, /估算/);
  assert.match(out, /≈ 5,000/);
  assert.match(out, /href="\/app\/w1\/decisions\?kind=ad_proposal"/);
  assert.match(out, /未授權讀取/);
  assert.match(out, /尚未匯入/);
  assert.doesNotMatch(out, /vs-kpi-value">0</);
  // A reviewer: budgets are hidden by role, which is not the same as "no plan has an ad budget".
  const hidden = await render('ads', { ...data, budget_availability: 'no_permission', pacing: [] }, '/app/w1/ads', [['/views/plans', {}, []]]);
  assert.match(hidden, /你的角色看不到預算/);
  assert.doesNotMatch(hidden, /還沒有任何計劃設定投放預算/);
  const hiddenRow = await render('ads', { ...data, pacing: [{ ...data.pacing![0]!, budget_minor: null, budget_availability: 'no_permission' }] }, '/app/w1/ads', [['/views/plans', {}, []]]);
  assert.match(hiddenRow, /你的角色看不到預算/);
  assert.doesNotMatch(hiddenRow, /未設定投放預算/);
});
