import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ViewLang, type CalendarEvent } from '@smartsell/ui';
import { viewKey } from '../data/keys';
import type { CalendarView } from '../data/types';

// The page imports its stylesheet (bundled by Vite); under Node a stylesheet is an empty module.
registerHooks({ load: (url, context, next) => url.endsWith('.css') ? { format: 'module', source: '', shortCircuit: true } : next(url, context) });
// The app's i18n module reads browser storage at import time; give it just enough of a browser.
const globals = globalThis as unknown as { localStorage?: unknown; document?: unknown };
globals.localStorage ??= { getItem: () => null, setItem: () => undefined };
globals.document ??= { documentElement: {} };

// A month far ahead keeps "today" out of the range, whatever day the tests run.
const ws = 'w1';
async function render(url: string, view: CalendarView, range: { from: string; to: string }) {
  const { ViewContext } = await import('../data/use-view');
  const { CalendarPage } = await import('./CalendarPage');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(viewKey(ws, '/views/calendar', range), { data: view });
  client.setQueryData(viewKey(ws, '/views/plans', { limit: '200' }), { data: [{ id: 'c1', name: '春季新品檔期', status: 'planned', starts_at: null, ends_at: null }] });
  const context = { ws, base: '/app/w1', session: {} as never, workspace: {} as never };
  return renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter initialEntries={[url]}><ViewLang lang="zh">
    <ViewContext.Provider value={context}><CalendarPage /></ViewContext.Provider></ViewLang></MemoryRouter></QueryClientProvider>);
}

const event = (id: string, kind: string, starts_at: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: `${kind}:${id}`, kind, starts_at, ends_at: null, all_day: false, title: id, status: null, platform: null, brand_id: null, campaign_id: null,
  social_account_id: null, resource: { type: kind === 'plan' ? 'campaign' : 'publish_target', id }, needs_human: null, permalink: null, ...extra,
});
const sources = (locked: string[] = []) => ['publish', 'post', 'plan', 'milestone', 'production_due', 'deliverable_due', 'live', 'ad_flight', 'promotion']
  .map(kind => ({ kind, availability: locked.includes(kind) ? 'no_permission' : 'available' }));
const march = { from: '2099-02-23', to: '2099-04-05' };
const events = [
  event('c1', 'plan', '2099-03-01T16:00:00.000Z', { ends_at: '2099-03-15T16:00:00.000Z', all_day: true, title: '春季新品檔期', status: 'planned', campaign_id: 'c1' }),
  event('p1', 'publish', '2099-03-04T07:30:00.000Z', { title: '新品開箱', status: 'pending_approval', platform: 'instagram', needs_human: 'approval', campaign_id: 'c1',
    permalink: 'https://instagram.com/p/1' }),
  event('p2', 'publish', '2099-03-05T09:00:00.000Z', { title: '保養教學', status: 'scheduled', platform: 'tiktok' }),
];
const view = (list: CalendarEvent[], locked: string[] = []): CalendarView => ({ range: { ...march, tz: 'Asia/Taipei' }, events: list, sources: sources(locked), as_of: '2099-03-01T00:00:00.000Z' });

test('month view answers first, draws the plan as bars across weeks and marks what needs the person', async () => {
  const out = await render('/app/w1/calendar?month=2099-03', view(events, ['promotion']), march);
  assert.match(out, /這段期間第一則發布/);
  assert.match(out, /cal-next-title[^>]*>新品開箱</);
  assert.match(out, /3月4日週三 15:30/, 'Times are shown in the workspace zone');
  assert.match(out, /cal-tile-number">1</);
  // 「待你決定」 is merged into Today (§9.1): the summary sends the person there.
  assert.match(out, /href="\/app\/w1"[^>]*>到今日處理</);
  // 2 March – 15 March (ends_at is exclusive) covers two Monday-first weeks.
  assert.equal(out.match(/class="cal-bar cal-k-plan/g)?.length, 2);
  assert.match(out, /cal-bar cal-k-plan after/);
  assert.match(out, /cal-bar cal-k-plan before/);
  assert.match(out, /aria-label="發布排期 · 15:30 · 新品開箱 · Instagram · 待審批"/);
  assert.match(out, /cal-kind locked cal-k-promotion/);
  assert.match(out, /你的角色看不到：促銷/);
  assert.doesNotMatch(out, /cal-k-promotion" aria-pressed/, 'A kind the role cannot read is not a toggle with a zero count');
  assert.match(out, /<h2 class="cal-range" aria-live="polite">2099年3月<\/h2>/);
});

test('list view shows periods as start and end markers with their span', async () => {
  const out = await render('/app/w1/calendar?view=list&month=2099-03', view(events), { from: '2099-03-01', to: '2099-03-31' });
  assert.match(out, /這段期間的檔期與計劃/);
  assert.match(out, /3\/2 – 3\/15/);
  assert.match(out, /cal-row-when">開始</);
  assert.match(out, /cal-row-when">結束</);
  assert.match(out, /cal-row-when">15:30</);
  assert.match(out, /href="\/app\/w1\/decisions\?kind=publish_approval"/);
});

test('kind chips filter the calendar and stay the legend', async () => {
  const out = await render('/app/w1/calendar?month=2099-03&kinds=plan', view(events), march);
  assert.match(out, /cal-kind cal-k-publish" aria-pressed="false"/);
  assert.match(out, /cal-kind cal-k-plan" aria-pressed="true"/);
  assert.match(out, /cal-kind cal-k-live empty" aria-pressed="false">.*?直播<span class="cal-kind-count">0<\/span>/, 'Kinds the role can read count from zero');
  assert.doesNotMatch(out, /class="cal-chip /, 'Hidden kinds leave the grid');
  assert.match(out, /全部顯示/);
  const none = await render('/app/w1/calendar?month=2099-03&kinds=', view(events), march);
  assert.match(none, /目前的篩選隱藏了這段期間的 3 件事/);
});

test('an empty period says how posts get here and links to real pages instead of a prompt to copy (§9.5)', async () => {
  const out = await render('/app/w1/calendar?month=2099-03', view([]), march);
  assert.match(out, /這段期間沒有任何排程/);
  assert.match(out, /在 Codex 說「明天 9:00 把 video\.mp4 發到 X」/);
  assert.match(out, /href="\/app\/w1\/channels"/);
  assert.doesNotMatch(out, /幫我把 2099年3月 的社群發布排程和推廣檔期排好/);
  assert.doesNotMatch(out, /cal-summary/);
});

test('the event drawer shows time in the workspace zone, status, platform, permalink and links', async () => {
  const out = await render('/app/w1/calendar?month=2099-03&event=publish:p1', view(events), march);
  assert.match(out, /<dialog class="cal-drawer"/);
  assert.match(out, /2099年3月4日週三 15:30/);
  assert.match(out, /時區 Asia\/Taipei/);
  assert.match(out, /Agent 已送審，需要你核准或退回後才會發布/);
  assert.match(out, /class="vs-btn primary-soft" href="\/app\/w1\/decisions\?kind=publish_approval"/);
  assert.match(out, /href="https:\/\/instagram\.com\/p\/1"/);
  assert.match(out, /href="\/app\/w1\/plans\/c1"[^>]*>春季新品檔期</);
  assert.match(out, /幫我看一下日曆上「新品開箱」（3\/4 15:30）/);
  const missing = await render('/app/w1/calendar?month=2099-03&event=publish:gone', view(events), march);
  assert.match(missing, /在目前的期間或篩選中找不到這一項/);
});

test('week view lays the week out as columns with an agenda for narrow widths', async () => {
  const week = { from: '2099-03-02', to: '2099-03-08' };
  const out = await render('/app/w1/calendar?view=week&week=2099-03-04', view(events), week);
  assert.match(out, /cal-board week cal-wide-only/);
  assert.match(out, /cal-week rich/);
  assert.match(out, /cal-narrow-only/);
  assert.equal(out.match(/class="cal-agenda-day/g)?.length, 7, 'The narrow agenda lists every day of the week');
  assert.match(out, /3\/2 – 3\/8/);
});
