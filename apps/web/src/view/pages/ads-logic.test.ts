import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adsHeadline, withCode, estimateValue, isMoneyMetric, needsDecision, pacingState, spendSeries, spendTiles, type AdProposal, type AdsData, type Pacing, type PlanInfo } from './ads-logic';

const period = { from: '2026-10-22', to: '2026-11-20' };
const asOf = '2026-11-20T12:00:00.000Z';
const row = (values: Partial<Pacing> = {}): Pacing => ({ campaign_id: 'c1', currency: 'USD', budget_minor: 100000, actual_spend_minor: 25000, coverage_ratio: 1, delayed: false, ...values });
const plan = (starts_at: string | null, ends_at: string | null): PlanInfo => ({ id: 'c1', name: 'Launch', starts_at, ends_at });
const proposal = (values: Partial<AdProposal> = {}): AdProposal => ({ id: 'p1', name: 'Boost', status: 'draft', campaign_id: null, schedule: null, budget: null, estimates: [], approval_status: null, ...values });

test('spend tiles never add currencies together', () => {
  const mixed = spendTiles({ value: null, availability: 'not_applicable', by_currency: [{ currency: 'TWD', value: 300000 }, { currency: 'USD', value: 100 }] }, []);
  assert.deepEqual(mixed.map(tile => [tile.currency, tile.metric.value, tile.compare]), [['TWD', 300000, false], ['USD', 100, false]]);
  const single = spendTiles({ value: 125, availability: 'observed', currency: 'USD', previous_value: 100 }, []);
  assert.deepEqual(single.map(tile => [tile.currency, tile.metric.value, tile.compare]), [['USD', 125, true]]);
  // Unknown spend keeps its availability; the currency falls back to the only account currency.
  const unknown = spendTiles({ value: null, availability: 'not_collected', currency: null }, [{ id: 'a', provider: 'meta_ads', name: 'act', currency: 'TWD' }]);
  assert.deepEqual(unknown.map(tile => [tile.currency, tile.metric.value, tile.metric.availability]), [['TWD', null, 'not_collected']]);
  assert.deepEqual(spendTiles(undefined, []).map(tile => tile.metric.availability), ['not_collected']);
});

test('spend series: one line per currency, or the single series', () => {
  assert.deepEqual(spendSeries(undefined), []);
  assert.deepEqual(spendSeries({ spend: [{ date: '2026-11-01', value: 1 }], currency: 'USD' }).map(line => line.currency), ['USD']);
  assert.deepEqual(spendSeries({ spend: [], currency: null, by_currency: [{ currency: 'TWD', points: [] }, { currency: 'USD', points: [] }] }).map(line => line.currency), ['TWD', 'USD']);
});

test('pacing: remaining is only stated when the period covers the plan from its start', () => {
  const inside = pacingState(row(), plan('2026-11-01T00:00:00.000Z', '2026-11-30T00:00:00.000Z'), period, asOf, 'UTC');
  assert.deepEqual([inside.ratio, inside.over, inside.remaining, inside.remainingNote, inside.reportedDays, inside.periodDays], [0.25, false, 75000, null, 30, 30]);
  assert.ok(inside.elapsed! > 0.6 && inside.elapsed! < 0.7);
  const before = pacingState(row(), plan('2026-09-01T00:00:00.000Z', '2026-12-31T00:00:00.000Z'), period, asOf, 'UTC');
  assert.deepEqual([before.remaining, before.remainingNote, before.ratio], [null, 'outside_period', 0.25]);
  // A past period that ends before the plan does: later spend is missing too.
  const early = pacingState(row(), plan('2026-10-25T00:00:00.000Z', '2026-12-31T00:00:00.000Z'), { from: '2026-10-22', to: '2026-11-10' }, asOf, 'UTC');
  assert.equal(early.remainingNote, 'outside_period');
  assert.equal(pacingState(row({ budget_minor: null }), plan(null, null), period, asOf).remainingNote, 'no_budget');
  assert.equal(pacingState(row({ budget_minor: null, budget_availability: 'no_permission' }), plan(null, null), period, asOf).remainingNote, 'budget_hidden', 'A hidden budget is not a missing one');
  const unknownSpend = pacingState(row({ actual_spend_minor: null }), plan('2026-11-01T00:00:00.000Z', null), period, asOf);
  assert.deepEqual([unknownSpend.ratio, unknownSpend.remaining, unknownSpend.remainingNote, unknownSpend.over], [null, null, 'no_spend', false]);
  assert.equal(pacingState(row(), undefined, period, asOf).remainingNote, 'unknown_plan_dates');
  const over = pacingState(row({ actual_spend_minor: 120000 }), plan('2026-11-01T00:00:00.000Z', '2026-11-15T00:00:00.000Z'), period, asOf, 'UTC');
  assert.deepEqual([over.over, over.remaining, over.ratio, over.elapsed], [true, -20000, 1.2, 1]);
  const uncovered = pacingState(row({ coverage_ratio: null, delayed: null }), undefined, period, asOf);
  assert.equal(uncovered.reportedDays, null);
});

test('proposals: decisions, money estimates in the budget currency', () => {
  assert.equal(needsDecision(proposal({ status: 'in_review' })), true);
  assert.equal(needsDecision(proposal({ status: 'draft', approval_status: 'pending' })), true);
  assert.equal(needsDecision(proposal({ status: 'approved', approval_status: 'approved' })), false);
  assert.deepEqual(['spend', 'cpc', 'reach', 'roas', 'cost_per_result', null].map(isMoneyMetric), [true, true, false, false, true, false]);
  assert.equal(estimateValue({ metric: 'reach', value: 5000, source: 'agent' }, 'USD', 'en'), '5,000');
  assert.equal(estimateValue({ metric: 'spend', value: 12345, source: 'agent' }, 'USD', 'en'), 'US$123.45');
  assert.equal(estimateValue({ metric: 'spend', value: null, source: 'agent' }, 'USD', 'en'), null);
});

test('the headline covers spend, results, budget and waiting approvals', () => {
  const plans = new Map([['c1', plan('2026-11-01T00:00:00.000Z', '2026-11-30T00:00:00.000Z')]]);
  assert.match(adsHeadline({ period, accounts: [], proposals: [] }, 'zh', plans), /還沒有投放帳戶或投放方案/);
  const view: AdsData = {
    period, as_of: asOf, accounts: [{ id: 'a', provider: 'meta_ads', name: 'act', currency: 'USD' }],
    metrics: { spend: { value: 25000, availability: 'observed', currency: 'USD', previous_value: 20000, change_ratio: 0.25 }, conversions: { value: null, availability: 'not_collected' }, clicks: { value: 1200, availability: 'observed' } },
    pacing: [row()], proposals: [proposal({ status: 'in_review' }), proposal({ id: 'p2' })],
  };
  const zh = adsHeadline(view, 'zh', plans, 'UTC');
  assert.match(zh, /花費 US\$250(\.00)?（較前期 \+25%）/);
  assert.match(zh, /點擊 1,200/);
  assert.match(zh, /預算還剩 US\$750/);
  assert.match(zh, /1 個投放方案等你審批。$/);
  const mixed = adsHeadline({ ...view, metrics: { spend: { value: null, availability: 'not_applicable', by_currency: [{ currency: 'TWD', value: 300000 }, { currency: 'USD', value: 100 }] } }, pacing: [] }, 'en', plans);
  assert.match(mixed, /per currency/);
  assert.match(mixed, /NT\$3,000 and US\$1/);
  assert.match(mixed, /results not collected/);
  assert.doesNotMatch(mixed, /budget left/);
  assert.deepEqual([withCode('$3,000', 'TWD'), withCode('US$3', 'USD'), withCode(null, 'USD')], ['$3,000 TWD', 'US$3', null]);
  const over = adsHeadline({ ...view, pacing: [row({ actual_spend_minor: 200000 })] }, 'zh', plans, 'UTC');
  assert.match(over, /1 個計劃已超出預算/);
});
