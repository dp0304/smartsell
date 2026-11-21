import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ViewLang, type Lang } from '@smartsell/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { viewKey } from '../data/keys';
import type { HomeView, Kpi } from '../data/types';

const globals = globalThis as unknown as { localStorage?: unknown; document?: unknown };
globals.localStorage ??= { getItem: () => null, setItem: () => undefined };
globals.document ??= { documentElement: {} };

const ws = 'w1';
const base = `/app/${ws}`;
const period = { from: '2026-11-01', to: '2026-11-05' };

async function render(kpis: Kpi[], thisWeek?: HomeView['this_week'], lang: Lang = 'zh') {
  const { ViewContext } = await import('../data/use-view');
  const { OverviewPage } = await import('./OverviewPage');
  const client = new QueryClient();
  const data: HomeView = { period, kpis, this_week: thisWeek, needs_you: { total: 0, items: [] }, alerts: [] };
  client.setQueryData(viewKey(ws, '/views/home', { brand_id: 'b1', ...period }), { data });
  return renderToStaticMarkup(<QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[`${base}?${new URLSearchParams({ brand: 'b1', ...period })}`]}><ViewLang lang={lang}>
      <ViewContext.Provider value={{ ws, base, session: {} as never, workspace: {} as never }}><OverviewPage /></ViewContext.Provider>
    </ViewLang></MemoryRouter>
  </QueryClientProvider>);
}

function kpi(key: string, values: (number | null)[], availability = 'not_collected'): Kpi {
  const observed = values.filter(value => value !== null);
  return {
    key, unit: key === 'ad_spend' ? 'currency' : 'count', currency: null,
    value: observed.length ? observed.reduce((sum, value) => sum + value, 0) : null,
    availability: observed.length ? 'observed' : availability,
    sparkline: values.map((value, index) => ({ date: `2026-11-0${index + 1}`, value, availability: value === null ? availability : 'observed' })),
  };
}

test('the overview leads with four metrics, keeps restricted orders, and selects the first usable daily series', async () => {
  const out = await render([
    kpi('views', [null, null, null, null, null]), kpi('engagements', [0, 2, null, 4, 5]), kpi('followers', [null]),
    kpi('ad_spend', [null]), kpi('orders', [null], 'no_permission'),
  ]);
  assert.equal(out.match(/<a\b[^>]*class="vs-kpi"/g)?.length, 4);
  assert.match(out, /\/social\?brand=b1&amp;from=2026-11-01&amp;to=2026-11-05&amp;metric=engagements/);
  assert.match(out, /每日趨勢 · 互動 \(計數\)/);
  assert.match(out, /class="vs-card vs-overview-trend"[\s\S]+class="vs-card vs-overview-decisions"/);
  assert.equal(out.match(/class="vs-line"/g)?.length, 2);
  assert.match(out, /無權限查看/);
});

test('missing daily values show a compact empty state with a table toggle', async () => {
  const out = await render([kpi('views', [null, null])]);
  assert.match(out, /此期間沒有已採集的數據/);
  assert.match(out, /aria-pressed="false"[^>]*>表格</);
  assert.doesNotMatch(out, /class="vs-grid"|class="vs-line"|class="vs-kpi-value">0</);
});

test('spend points without a single currency link to filtered Ads instead of joining the amounts', async () => {
  const out = await render([kpi('ad_spend', [null, 100, 400])]);
  assert.match(out, /此期間沒有單一可用幣別/);
  assert.match(out, /\/ads\?brand=b1&amp;from=2026-11-01&amp;to=2026-11-05/);
  assert.doesNotMatch(out, /class="vs-line"/);
});

test('publishing shows equivalent approval states once and keeps distinct states in both languages', async () => {
  const upcoming = [
    { id: '1', title: 'Post awaiting approval', status: 'awaiting_approval', needs_human: 'approval' },
    { id: '2', title: 'Post with pending approval', status: 'pending_approval', needs_human: 'approval' },
    { id: '3', title: 'Blocked post', status: 'blocked', needs_human: 'approval' },
    { id: '4', title: 'Overdue approval', status: 'awaiting_approval', needs_human: 'late_decision' },
  ] as const;
  const week = { scheduled: 4, published: 0, failed: 0, outcome_unknown: 0,
    upcoming: upcoming.map(event => ({ kind: 'publish', starts_at: '2026-11-04T12:00:00Z', ...event })) };
  const zh = await render([], week);
  assert.match(zh, /Post awaiting approval<\/span>(?:(?!<\/li>)[\s\S])*待審批<\/span><\/li>/);
  const en = await render([], week, 'en');
  for (const out of [zh, en]) {
    assert.equal(out.match(/data-status="approval"/g)?.length, 1);
    assert.match(out, /Blocked post<\/span>(?:(?!<\/li>)[\s\S])*data-status="approval"(?:(?!<\/li>)[\s\S])*data-status="blocked"/);
    assert.match(out, /Overdue approval<\/span>(?:(?!<\/li>)[\s\S])*data-status="late_decision"(?:(?!<\/li>)[\s\S])*data-status="awaiting_approval"/);
  }
  assert.match(en, /data-status="awaiting_approval"[^>]*>[\s\S]*?Awaiting approval<\/span>/);
  assert.match(en, /data-status="pending_approval"[^>]*>[\s\S]*?Pending approval<\/span>/);
});
