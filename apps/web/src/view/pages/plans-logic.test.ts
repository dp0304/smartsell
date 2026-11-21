import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  budgetParts, budgetTotals, dayProgress, ganttWindow, goalShare, groupByDay, lastDay, matrixParts, metricName, milestoneState, needsAttention, phaseCounts, platformName,
  planPhase, planSpan, planSuggestions, sortMilestones, sortPlans, spanVisible, type PlanCardView, type PlanDetailView,
} from './plans-logic';

const now = Date.parse('2026-11-20T08:00:00.000Z');
const plan = (values: Partial<PlanCardView>): PlanCardView => ({ id: 'p', name: 'Plan', status: 'active', starts_at: null, ends_at: null, ...values });

test('phases follow the plan status, and only an unknown status falls back to the dates', () => {
  assert.equal(planPhase(plan({ status: 'active' }), now), 'live');
  assert.equal(planPhase(plan({ status: 'paused' }), now), 'live');
  assert.equal(planPhase(plan({ status: 'planned' }), now), 'upcoming');
  assert.equal(planPhase(plan({ status: 'wrapping' }), now), 'ended');
  assert.equal(planPhase(plan({ status: 'cancelled' }), now), 'ended');
  assert.equal(planPhase(plan({ status: 'draft', starts_at: '2026-11-01T00:00:00Z' }), now), 'draft');
  assert.equal(planPhase(plan({ status: 'mystery', starts_at: '2026-12-01T00:00:00Z' }), now), 'upcoming');
  assert.equal(planPhase(plan({ status: 'mystery', starts_at: '2026-10-01T00:00:00Z', ends_at: '2026-11-01T00:00:00Z' }), now), 'ended');
  assert.equal(planPhase(plan({ status: null }), now), 'draft');
  assert.deepEqual(phaseCounts([plan({ status: 'active' }), plan({ status: 'closed' }), plan({ status: 'planned' }), plan({ status: 'active' })], now),
    { live: 2, upcoming: 1, ended: 1, draft: 0 });
});

test('plans sort live (ending soonest) → upcoming (starting soonest) → drafts → most recently ended', () => {
  const plans = [
    plan({ id: 'old', status: 'closed', ends_at: '2026-01-01T00:00:00Z' }), plan({ id: 'recent', status: 'closed', ends_at: '2026-11-01T00:00:00Z' }),
    plan({ id: 'draft', status: 'draft' }), plan({ id: 'later', status: 'planned', starts_at: '2027-01-01T00:00:00Z' }),
    plan({ id: 'soon', status: 'planned', starts_at: '2026-12-01T00:00:00Z' }), plan({ id: 'long', status: 'active', ends_at: '2027-02-01T00:00:00Z' }),
    plan({ id: 'short', status: 'active', ends_at: '2026-11-25T00:00:00Z' }), plan({ id: 'open', status: 'active', ends_at: null }),
  ];
  assert.deepEqual(sortPlans(plans, now).map(row => row.id), ['short', 'long', 'open', 'soon', 'later', 'draft', 'recent', 'old']);
});

test('an exclusive end instant shows as the local day before it', () => {
  // Taipei: 11/15 00:00 → 11/29 00:00 is the 14 days 11/15..11/28 (the read model test fixture).
  assert.equal(lastDay('2026-11-28T16:00:00.000Z', 'Asia/Taipei'), '2026-11-28');
  assert.equal(lastDay('2026-11-28T18:30:00.000Z', 'Asia/Taipei'), '2026-11-29');
  assert.equal(lastDay('2026-11-28', 'Asia/Taipei'), '2026-11-28');
  assert.equal(lastDay(null), '');
  assert.deepEqual(planSpan(plan({ starts_at: '2026-11-14T16:00:00.000Z', ends_at: '2026-11-28T16:00:00.000Z' }), 'Asia/Taipei'), { start: '2026-11-15', end: '2026-11-28' });
  assert.deepEqual(planSpan(plan({ starts_at: '2026-11-14T16:00:00.000Z', ends_at: null }), 'Asia/Taipei'), { start: '2026-11-15', end: null });
  assert.equal(planSpan(plan({ starts_at: null }), 'UTC'), null);
});

test('day progress: server day N of M while running, days until start, ended, undated', () => {
  const launch = { status: 'active', starts_at: '2026-11-14T16:00:00.000Z', ends_at: '2026-11-28T16:00:00.000Z', day: 5, days: 14 };
  assert.deepEqual(dayProgress(launch, '2026-11-19', 'Asia/Taipei', now), { kind: 'day', day: 5, days: 14 });
  assert.deepEqual(dayProgress({ ...launch, day: null, days: null }, '2026-11-20', 'Asia/Taipei', now), { kind: 'day', day: 6, days: 14 });
  assert.deepEqual(dayProgress({ ...launch, status: 'planned', starts_at: '2026-11-30T16:00:00.000Z', ends_at: '2026-12-10T16:00:00.000Z' }, '2026-11-20', 'Asia/Taipei', now), { kind: 'starts_in', days: 11 });
  assert.deepEqual(dayProgress({ ...launch, status: 'wrapping' }, '2026-11-20', 'Asia/Taipei', now), { kind: 'ended' });
  assert.deepEqual(dayProgress({ ...launch, status: 'active' }, '2026-12-01', 'Asia/Taipei', now), { kind: 'ended' });
  assert.deepEqual(dayProgress({ status: 'draft', starts_at: null, ends_at: null }, '2026-11-20', 'UTC', now), { kind: 'undated' });
});

test('the gantt covers whole months around the plans and today, and cuts very long spreads', () => {
  assert.deepEqual(ganttWindow([{ start: '2026-11-15', end: '2026-11-28' }, { start: '2026-12-05', end: '2027-01-10' }], '2026-11-20'), { from: '2026-11-01', to: '2027-01-31' });
  assert.deepEqual(ganttWindow([{ start: '2026-12-05', end: null }], '2026-11-20'), { from: '2026-11-01', to: '2026-12-31' });
  assert.deepEqual(ganttWindow([{ start: '2026-02-28', end: '2026-02-28' }], '2026-11-20'), { from: '2026-02-01', to: '2026-11-30' });
  const cut = ganttWindow([{ start: '2024-01-01', end: '2024-02-01' }, { start: '2026-11-01', end: '2026-11-30' }], '2026-11-20')!;
  assert.deepEqual(cut, { from: '2026-05-01', to: '2026-11-30' });
  assert.equal(spanVisible({ start: '2024-01-01', end: '2024-02-01' }, cut), false);
  assert.equal(spanVisible({ start: '2026-04-20', end: '2026-05-02' }, cut), true);
  assert.equal(ganttWindow([], '2026-11-20'), null);
});

test('content completeness is unknown when nothing is planned and never overflows past the plan', () => {
  assert.equal(matrixParts({ planned: 0, published: 2, scheduled: 0, in_production: 0, failed: 0, gap: 0, completeness_ratio: null }).ratio, null);
  assert.equal(matrixParts(undefined).ratio, null);
  const parts = matrixParts({ planned: 12, filled: 7, published: 3, scheduled: 4, in_production: 0, failed: 0, gap: 5, completeness_ratio: 7 / 12 });
  assert.equal(parts.ratio, 7 / 12);
  assert.equal(parts.gap, 5);
  assert.deepEqual(parts.parts.map(part => [part.key, part.count, part.share]), [['published', 3, 3 / 12], ['scheduled', 4, 4 / 12]]);
  const excess = matrixParts({ planned: 2, published: 3, scheduled: 1, in_production: 0, failed: 0, gap: 0, completeness_ratio: 1 });
  assert.equal(excess.parts.reduce((sum, part) => sum + part.share, 0), 1);
  // Real demo shape: 13 scheduled but only 6 fill planned slots, so the bar is 6/16 long and 7 are reported as excess.
  const skewed = matrixParts({ planned: 16, filled: 6, published: 0, scheduled: 13, in_production: 0, failed: 0, gap: 10, completeness_ratio: 0.375 });
  assert.deepEqual([skewed.filled, skewed.excess, skewed.gap, skewed.parts[0]!.share], [6, 7, 10, 0.375]);
});

test('budget parts split recorded spend from open commitments and flag the overrun', () => {
  const fine = budgetParts({ currency: 'TWD', budget_minor: 150000, committed_minor: 30000, actual_minor: 20000, remaining_minor: 110000, overrun_minor: 0 });
  assert.deepEqual([fine.spent, fine.open, fine.over, fine.budgetMark], [20000, 20000, false, null]);
  assert.equal(fine.usedRatio, 40000 / 150000);
  const over = budgetParts({ currency: 'TWD', budget_minor: 100000, actual_minor: 120000, remaining_minor: -20000, overrun_minor: 20000 });
  assert.deepEqual([over.over, over.overrun, over.open, over.spentShare, over.budgetMark], [true, 20000, 0, 1, 100000 / 120000]);
  const totals = budgetTotals([{ budget: [{ currency: 'TWD', budget_minor: 100, actual_minor: 20, overrun_minor: 0 }] },
    { budget: [{ currency: 'TWD', budget_minor: 50, actual_minor: 80, overrun_minor: 30 }, { currency: 'HKD', budget_minor: 10, actual_minor: 0 }] }, { budget: { visible: false } }, {}]);
  assert.deepEqual(totals, { currencies: [{ currency: 'TWD', budget: 150, spent: 100, overrun: 30, plans: 2 }, { currency: 'HKD', budget: 10, spent: 0, overrun: 0, plans: 1 }], hidden: 1 });
});

test('goal bars draw only known values, clamped to the target', () => {
  assert.equal(goalShare({ value: null, target_value: 100, progress_percent: null }), null);
  assert.equal(goalShare({ value: 500, target_value: 1000, progress_percent: 50 }), 0.5);
  assert.equal(goalShare({ value: 1500, target_value: 1000, progress_percent: null }), 1);
  assert.deepEqual(metricName('norm.post.views'), ['瀏覽', 'Views', '浏览']);
  assert.deepEqual(metricName('custom.repeat_buyers'), ['repeat buyers', 'repeat buyers']);
  assert.deepEqual(platformName('meta_instagram'), ['Instagram', 'Instagram']);
  assert.deepEqual(platformName('mastodon'), ['mastodon', 'mastodon']);
  assert.equal(needsAttention({ needs_human: 'late_decision', status: 'blocked' }), true);
  assert.equal(needsAttention({ needs_human: null, status: 'scheduled' }), false);
});

test('schedule groups by local start day without the plan period band', () => {
  const event = (id: string, kind: string, starts_at: string) => ({ id, kind, starts_at, title: id });
  const groups = groupByDay([event('b', 'publish', '2026-11-20T17:00:00Z'), event('plan', 'plan', '2026-11-14T16:00:00Z'), event('a', 'milestone', '2026-11-20T01:00:00Z'),
    event('c', 'post', '2026-11-19T15:59:00Z')], 'Asia/Taipei');
  assert.deepEqual(groups.map(([day, list]) => [day, list.map(item => item.id)]), [['2026-11-19', ['c']], ['2026-11-20', ['a']], ['2026-11-21', ['b']]]);
});

test('milestones: blocked and overdue come first; finished ones never count as overdue', () => {
  const rows = [
    { id: 'm1', title: 'Later', due_at: '2026-12-01T00:00:00Z', status: 'open' },
    { id: 'm2', title: 'Late', due_at: '2026-11-10T00:00:00Z', status: 'open' },
    { id: 'm3', title: 'Stuck', due_at: '2026-12-05T00:00:00Z', status: 'open', blocked: true },
    { id: 'm4', title: 'Done', due_at: '2026-11-01T00:00:00Z', status: 'done' },
  ];
  assert.deepEqual(rows.map(row => milestoneState(row, now)), ['open', 'overdue', 'blocked', 'done']);
  assert.deepEqual(sortMilestones(rows, now).map(row => row.id), ['m3', 'm2', 'm1', 'm4']);
});

test('suggestions name what is missing; ended plans only get data imports', () => {
  const base: PlanDetailView = {
    ...plan({ status: 'active' }), goals: [{ metric_key: 'norm.post.views', unit: 'count', target_value: 1000, value: null, progress_percent: null, coverage_status: 'not_collected' }],
    matrix: { planned: 6, published: 1, scheduled: 1, in_production: 0, failed: 1, gap: 3, completeness_ratio: 0.5 }, budget: [], products: [],
    milestones: [{ id: 'm', title: 'Late', due_at: '2026-11-01T00:00:00Z', status: 'open' }],
    ads: { proposals: [], spend: [{ currency: 'TWD', budget_minor: 100, actual_spend_minor: null, coverage_ratio: null, delayed: null }] },
  };
  assert.deepEqual(planSuggestions(base, now).map(item => [item.key, item.n]),
    [['fix_failed', 1], ['fill_gaps', 3], ['follow_milestones', undefined], ['import_results', undefined], ['set_budget', undefined], ['add_products', undefined], ['import_ad_spend', undefined]]);
  assert.deepEqual(planSuggestions({ ...base, status: 'closed' }, now).map(item => item.key), ['import_results', 'import_ad_spend']);
  assert.deepEqual(planSuggestions({ ...plan({ status: 'draft' }), goals: [], matrix: { planned: 0, published: 0, scheduled: 0, in_production: 0, failed: 0, gap: 0, completeness_ratio: null },
    budget: { visible: false }, products: [{ product_id: 'x', title: 'X' }] }, now).map(item => item.key), ['plan_matrix', 'set_goals']);
});
