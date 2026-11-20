import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '@smartsell/sdk';
import { ViewLang } from '@smartsell/ui';

// i18n.ts reads the saved language and sets <html lang> when it loads.
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) },
  document: { documentElement: { lang: 'zh-Hant' } },
});
// The pages import their stylesheet; Vite handles it in the app, here it is an empty module.
registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
const { ViewContext } = await import('../data/use-view');
const { viewKey } = await import('../data/keys');
const { PlansPage } = await import('./PlansPage');
const { PlanPage } = await import('./PlanPage');

// Shapes as apps/server/src/modules/workspace/views/campaigns.test.ts asserts them.
const now = new Date();
const at = (days: number) => new Date(now.getTime() + days * 86_400_000).toISOString();
const launch = {
  id: 'c1', name: 'Launch', kind: 'launch', status: 'active', brand_id: 'b1', starts_at: at(-4), ends_at: at(10), timezone: 'Asia/Taipei', day: 5, days: 14,
  goals: [{ goal_id: 'g1', metric_key: 'norm.post.views', unit: 'count', currency: null, target_value: 1000, due_at: at(10), value: 500, progress_percent: 50, coverage_status: 'observed' },
    { goal_id: 'g2', metric_key: 'norm.post.engagements', unit: 'count', currency: null, target_value: 100, due_at: at(10), value: null, progress_percent: null, coverage_status: 'not_collected' }],
  matrix: { planned: 3, filled: 2, published: 1, scheduled: 1, in_production: 0, failed: 0, gap: 1, completeness_ratio: 2 / 3, outside_plan: 0, unplanned_items: 0 },
  budget: [{ currency: 'TWD', budget_minor: 150000, committed_minor: 0, actual_minor: 20000, remaining_minor: 130000, overrun_minor: 0, actual_complete: false }],
  products: [{ product_id: 'p1', title: 'Tee', role: 'hero', stock_status: 'low', risk: { severity: 'review', change_type: 'stock_low', change_event_id: 'e1' } }],
  next_publication: { publish_target_id: 't2', scheduled_at: at(2), title: 'Teaser' }, needs_decision: 3, created_via: 'agent', as_of: now.toISOString(),
};
const draft = { id: 'c2', name: 'Idea', kind: 'other', status: 'draft', brand_id: 'b1', starts_at: null, ends_at: null, timezone: 'UTC', day: null, days: null, goals: [],
  matrix: { planned: 0, filled: 0, published: 0, scheduled: 0, in_production: 0, failed: 0, gap: 0, completeness_ratio: null, outside_plan: 0, unplanned_items: 0 },
  budget: [], products: [], next_publication: null, needs_decision: 0, created_via: null, as_of: now.toISOString() };
const closed = { ...draft, id: 'c3', name: 'Old', status: 'closed', starts_at: '2026-01-01T00:00:00.000Z', ends_at: '2026-02-01T00:00:00.000Z', budget: { visible: false } };
const detail = {
  ...launch,
  events: [
    { id: 'plan:c1', kind: 'plan', starts_at: launch.starts_at, ends_at: launch.ends_at, title: 'Launch', status: 'active', resource: { type: 'campaign', id: 'c1' } },
    { id: 'post:x', kind: 'post', starts_at: at(-2), ends_at: null, title: 'Caption', status: 'system_verified', platform: 'instagram', permalink: 'https://instagram.com/p/1', resource: { type: 'platform_post', id: 'x' } },
    { id: 'milestone:m1', kind: 'milestone', starts_at: at(1), ends_at: null, title: 'Assets ready', status: 'open', resource: { type: 'work_item', id: 'm1' } },
    { id: 'publish:t2', kind: 'publish', starts_at: at(2), ends_at: null, title: 'Teaser', status: 'awaiting_approval', platform: 'instagram', needs_human: 'approval', resource: { type: 'publish_target', id: 't2' } },
    { id: 'ad_flight:a1', kind: 'ad_flight', starts_at: at(1), ends_at: at(7), title: 'Boost', status: 'in_review', resource: { type: 'ad_proposal', id: 'a1' } },
  ],
  cells: [{ slot_id: 's1', stage: 'launch', platform: 'instagram', social_account_id: null, account_name: null, market_id: null, planned_count: 3, in_production: 0, scheduled: 1, published: 1, failed: 0, gap: 1 }],
  milestones: [{ id: 'm1', title: 'Assets ready', due_at: at(1), status: 'open', blocked: false }, { id: 'm2', title: 'Brief signed', due_at: at(-1), status: 'open', blocked: false }],
  content: [{ content_item_id: 'i1', title: 'Teaser', production_stage: 'ready', production_due_at: at(0.5), created_via: 'agent',
    targets: [{ id: 't1', platform: 'instagram', social_account_id: 'sa', scheduled_at: at(-2), display_status: 'published' }, { id: 't2', platform: 'instagram', social_account_id: 'sa', scheduled_at: at(2), display_status: 'awaiting_approval' }] }],
  ads: { proposals: [{ id: 'a1', name: 'Boost', status: 'in_review', campaign_id: 'c1', ad_account_id: 'aa', schedule: { starts_at: at(1), ends_at: at(7), tz: 'Asia/Taipei' },
    budget: { type: 'daily', amount_minor: 30000, currency: 'TWD' }, estimates: [{ metric: 'impressions', value: 10000, source: 'provider_estimate' }], approval_status: 'pending', created_via: null }],
    spend: [{ campaign_id: 'c1', currency: 'TWD', budget_minor: 50000, actual_spend_minor: null, coverage_ratio: null, delayed: null }] },
};

function render(path: string, seed: (client: QueryClient) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  seed(client);
  const session = { csrf_token: 'x', workspaces: [{ id: 'w1', name: 'W' }] } as unknown as Session;
  return renderToStaticMarkup(<QueryClientProvider client={client}><ViewLang lang="zh"><MemoryRouter initialEntries={[path]}>
    <ViewContext.Provider value={{ ws: 'w1', session, workspace: session.workspaces[0], base: '/app/w1' }}>
      <Routes><Route path="/app/w1/plans" element={<PlansPage />} /><Route path="/app/w1/plans/:id" element={<PlanPage />} /></Routes>
    </ViewContext.Provider>
  </MemoryRouter></ViewLang></QueryClientProvider>);
}

test('plan list answers what runs, what waits, how complete and what it cost, then shows the gantt and cards', () => {
  const out = render('/app/w1/plans', client => client.setQueryData(viewKey('w1', '/views/plans', {}, true), { data: [launch, draft, closed] }));
  assert.match(out, /哪些推廣計劃在跑/);
  assert.match(out, /進行中計劃已記錄的花費/);
  assert.match(out, /NT\$200/);
  assert.match(out, /第 5 天／共 14 天/);
  assert.match(out, /vs-timeline/);
  assert.match(out, /vs-today/);
  assert.match(out, /1 個計劃尚未設定期間/);
  // The plan that ended in February stays off the gantt unless "ended" is selected.
  assert.match(out, /1 個較早結束的計劃未列入/);
  assert.match(out, /尚未設定：目標、預算、商品/);
  assert.match(out, /3 項待你決定/);
  assert.match(out, /decisions\?campaign=c1/);
  assert.match(out, /尚未規劃內容數量/);
  assert.match(out, /你的角色無法查看預算/);
  assert.match(out, /庫存偏低/);
  // Order: live, draft, ended.
  const cards = out.slice(out.indexOf('class="pl-grid"'));
  assert.ok(cards.indexOf('>Launch<') < cards.indexOf('>Idea<') && cards.indexOf('>Idea<') < cards.indexOf('>Old<'));
});

test('status filter in the URL narrows the cards', () => {
  const out = render('/app/w1/plans?status=draft', client => client.setQueryData(viewKey('w1', '/views/plans', {}, true), { data: [launch, draft, closed] }));
  assert.match(out, /aria-pressed="true">草稿/);
  assert.doesNotMatch(out, />Launch</);
  assert.match(out, />Idea</);
  const ended = render('/app/w1/plans?status=ended', client => client.setQueryData(viewKey('w1', '/views/plans', {}, true), { data: [launch, draft, closed] }));
  assert.match(ended, /vs-timeline-lane/);
  assert.doesNotMatch(ended, /較早結束/);
});

test('an empty plan list tells the person what to ask the agent', () => {
  const out = render('/app/w1/plans', client => client.setQueryData(viewKey('w1', '/views/plans', {}, true), { data: [] }));
  assert.match(out, /請你的 Agent/);
  assert.match(out, /幫我建立下個月的推廣計劃/);
});

test('plan detail: summary, decisions, goals, budget, matrix, schedule, milestones, content, products and ads', () => {
  const out = render('/app/w1/plans/c1', client => {
    client.setQueryData(viewKey('w1', '/views/plans/c1', {}), { data: detail });
    client.setQueryData(viewKey('w1', '/views/decisions', { campaign_id: 'c1' }), { data: [] });
  });
  for (const text of ['內容完成度', '67%', '目標', '瀏覽', '未採集', '預算', '已承諾未付', '內容矩陣', 'Instagram · 任一帳號', '日程', '在日曆中查看',
    'calendar\\?campaign=c1', '里程碑', '已逾期', 'Brief signed', '內容', '可發布', '待審批', '商品', '主推', '庫存偏低', '投放', '花費未採集', '每日 (?:NT|US)?\\$300', 'Boost', '建議下一步']) {
    assert.match(out, new RegExp(text), text);
  }
  // The plan period band is not repeated in the schedule, and past days fold behind a toggle.
  const schedule = out.slice(out.indexOf('class="pl-schedule"'), out.indexOf('class="vs-list pl-milestones"'));
  assert.doesNotMatch(schedule, />Launch</);
  assert.match(schedule, /顯示較早的 1 項/);
  assert.match(schedule, /Assets ready/);
});
