import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { ViewLang } from '@smartsell/ui';

// i18n.ts reads the saved language and sets <html lang> when it loads.
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value), removeItem: (key: string) => void store.delete(key) },
  document: { documentElement: { lang: 'zh-Hant' } },
});
const { BudgetBlock, CompletenessBar, GoalRow, NeedsDecision } = await import('./plans-parts');
const { MatrixTable, PacingRow, ScheduleList } = await import('./plans-detail');

const html = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter><ViewLang lang="zh">{node}</ViewLang></MemoryRouter>);

test('completeness is "not collected" when nothing is planned, never 0%', () => {
  const out = html(<CompletenessBar matrix={{ planned: 0, published: 0, scheduled: 0, in_production: 0, failed: 0, gap: 0, completeness_ratio: null }} />);
  assert.match(out, /未採集/);
  assert.match(out, /尚未規劃內容數量/);
  assert.doesNotMatch(out, /0%/);
  const filled = html(<CompletenessBar matrix={{ planned: 12, filled: 7, published: 3, scheduled: 4, in_production: 0, failed: 1, gap: 5, completeness_ratio: 7 / 12 }} />);
  assert.match(filled, /58%/);
  assert.match(filled, /7／規劃 12 則/);
  assert.match(filled, /缺 5 則/);
  assert.match(filled, /失敗 <strong>1<\/strong>/);
});

test('a goal without a value shows "not collected" and draws no bar', () => {
  const unknown = html(<GoalRow goal={{ metric_key: 'norm.post.engagements', unit: 'count', target_value: 100, value: null, progress_percent: null, coverage_status: 'not_collected' }} />);
  assert.match(unknown, /互動/);
  assert.match(unknown, /未採集/);
  assert.doesNotMatch(unknown, /role="meter"/);
  const known = html(<GoalRow goal={{ metric_key: 'norm.post.views', unit: 'count', target_value: 1000, value: 500, progress_percent: 50, coverage_status: 'observed' }} />);
  assert.match(known, /aria-valuenow="50"/);
  assert.match(known, /目標 1,000/);
  const money = html(<GoalRow goal={{ metric_key: 'revenue', unit: 'currency', currency: 'TWD', target_value: 5000, value: 1200, progress_percent: 24, coverage_status: 'estimated' }} />);
  assert.match(money, /1,200/);
  assert.match(money, /估算/);
});

test('budget: hidden by role, missing, and an overrun spelled out with an icon', () => {
  assert.match(html(<BudgetBlock budget={{ visible: false }} />), /你的角色無法查看預算/);
  assert.match(html(<BudgetBlock budget={[]} />), /尚未登記預算/);
  const over = html(<BudgetBlock budget={[{ currency: 'TWD', budget_minor: 100000, committed_minor: 0, actual_minor: 120000, remaining_minor: -20000, overrun_minor: 20000, actual_complete: false }]} detail />);
  assert.match(over, /超出預算/);
  assert.match(over, /tone-critical/);
  assert.match(over, /pl-budget-mark/);
  assert.match(over, /結案對帳前/);
});

test('ad spend that was never reported stays "not collected"', () => {
  const out = html(<PacingRow row={{ currency: 'TWD', budget_minor: 50000, actual_spend_minor: null, coverage_ratio: null, delayed: null }} />);
  assert.match(out, /花費未採集/);
  assert.doesNotMatch(out, /\$0/);
});

test('matrix table rows, totals and flagged gaps; decision badge only when something waits', () => {
  const out = html(<MatrixTable cells={[
    { platform: 'instagram', social_account_id: 'a', account_name: 'Brand IG', stage: 'launch', planned_count: 3, published: 1, scheduled: 1, in_production: 0, failed: 0, gap: 1 },
    { platform: 'tiktok', social_account_id: null, account_name: null, stage: 'teaser', planned_count: 2, published: 0, scheduled: 0, in_production: 0, failed: 1, gap: 1 },
  ]} />);
  assert.match(out, /Instagram · Brand IG/);
  assert.match(out, /TikTok · 任一帳號/);
  assert.match(out, /上市/);
  assert.match(out, /合計/);
  assert.equal(out.match(/tone-warning/g)?.length, 3);
  assert.equal(html(<NeedsDecision count={0} href="/x" />), '');
  assert.match(html(<NeedsDecision count={2} href="/app/w/decisions?campaign=p" />), /2 項待你決定/);
});

test('schedule folds earlier days behind a toggle and starts at today', () => {
  const event = (id: string, starts_at: string) => ({ id, kind: 'publish', starts_at, title: id, status: 'scheduled' });
  const out = html(<ScheduleList events={[event('past', '2026-11-18T03:00:00Z'), event('now', '2026-11-20T03:00:00Z'), event('next', '2026-11-22T03:00:00Z')]}
    timeZone="UTC" today="2026-11-20" base="/app/w" />);
  assert.match(out, /顯示較早的 1 項/);
  assert.doesNotMatch(out, />past</);
  assert.match(out, />now</);
  assert.match(out, /今天/);
  // A late post from earlier still needs a decision, so it stays in view.
  const late = html(<ScheduleList events={[{ ...event('late', '2026-11-18T03:00:00Z'), status: 'blocked', needs_human: 'late_decision' as const }, event('next', '2026-11-22T03:00:00Z')]}
    timeZone="UTC" today="2026-11-20" base="/app/w" />);
  assert.match(late, />late</);
  assert.match(late, /逾時待決定/);
  assert.doesNotMatch(late, /顯示較早/);
});
