import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CalendarEvent } from '@smartsell/ui';
import {
  agendaDays, decisionHref, eventSpan, isOverdue, layoutWeek, modeParams, navigateParams, periodProgress, periodsIn, readCalendarParams, safePermalink,
  offeredKinds, shiftMonth, summarize, toggleKindParams,
} from './calendar-logic';

const event = (id: string, kind: string, starts_at: string, extra: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ id: `${kind}:${id}`, kind, starts_at, ends_at: null, all_day: false, title: id, status: null, ...extra });
const read = (query: string, today = '2026-11-20', narrow = false) => readCalendarParams(new URLSearchParams(query), today, narrow);

test('URL state: list is the default on narrow screens, ranges cover what is visible', () => {
  const wide = read('');
  assert.equal(wide.mode, 'month');
  assert.deepEqual([wide.from, wide.to], ['2026-10-26', '2026-12-06']);
  const narrow = read('', '2026-11-20', true);
  assert.equal(narrow.mode, 'list');
  assert.deepEqual([narrow.from, narrow.to], ['2026-11-01', '2026-11-30']);
  assert.equal(read('view=month', '2026-11-20', true).mode, 'month', 'An explicit view wins over the screen width');
  const week = read('view=week&week=2026-11-19');
  assert.deepEqual([week.week, week.from, week.to], ['2026-11-16', '2026-11-16', '2026-11-22'], 'Any day snaps to its Monday');
  assert.equal(read('month=2026-13').month, '2026-11', 'Invalid anchors fall back to today');
  assert.equal(read('kinds=publish,bogus,plan').kinds?.size, 2);
  assert.equal(read('kinds=').kinds?.size, 0);
  assert.equal(read('').kinds, null);
  assert.equal(shiftMonth('2026-12', 1), '2027-01');
  assert.equal(shiftMonth('2026-01', -1), '2025-12');
});

test('navigation writes ?month or ?week and drops the anchor for the current period', () => {
  const params = (query: string) => new URLSearchParams(query);
  const month = read('month=2026-12&event=publish:x');
  assert.equal(navigateParams(params('month=2026-12&event=publish:x'), month, -1, '2026-11-20').toString(), '');
  assert.equal(navigateParams(params('month=2026-12'), month, 1, '2026-11-20').toString(), 'month=2027-01');
  const week = read('view=week&week=2026-11-16');
  assert.equal(navigateParams(params('view=week&week=2026-11-16'), week, 1, '2026-11-20').toString(), 'view=week&week=2026-11-23');
  assert.equal(navigateParams(params('view=week&week=2026-11-23&brand=b'), read('view=week&week=2026-11-23'), 0, '2026-11-20').toString(), 'view=week&brand=b');
  assert.equal(modeParams(params('month=2027-02'), read('month=2027-02'), 'week', '2026-11-20').toString(), 'view=week&week=2027-02-01');
  assert.equal(modeParams(params(''), read(''), 'week', '2026-11-20').toString(), 'view=week');
  // 2026-12-28 week has its Thursday on 31 Dec, so it belongs to December.
  assert.equal(modeParams(params('view=week&week=2026-12-28'), read('view=week&week=2026-12-28'), 'month', '2026-11-20').toString(), 'view=month&month=2026-12');
  assert.equal(modeParams(params('view=week&week=2026-11-16'), read('view=week&week=2026-11-16'), 'list', '2026-11-20').toString(), 'view=list');
});

test('kind toggles: all kinds is no parameter, toggling off writes the remaining kinds', () => {
  const off = toggleKindParams(new URLSearchParams('event=x'), null, 'post');
  assert.equal(off.get('kinds'), 'publish,plan,milestone,production_due,deliverable_due,live,ad_flight,promotion');
  assert.equal(off.has('event'), false);
  assert.equal(toggleKindParams(off, new Set(off.get('kinds')!.split(',')), 'post').has('kinds'), false);
  assert.equal(toggleKindParams(new URLSearchParams(), new Set(['publish']), 'publish').get('kinds'), '');
  assert.equal(toggleKindParams(new URLSearchParams(), new Set(['publish']), 'plan', ['publish', 'plan']).has('kinds'), false,
    'Kinds the person cannot see do not keep the filter active');
});

test('spans treat ends_at as exclusive and follow the workspace time zone', () => {
  assert.deepEqual(eventSpan({ starts_at: '2026-11-10T00:00:00.000Z', ends_at: '2026-11-30T00:00:00.000Z' }, 'UTC'), { first: '2026-11-10', last: '2026-11-29', period: true, days: 20 });
  assert.deepEqual(eventSpan({ starts_at: '2026-11-20T23:30:00.000Z', ends_at: null }, 'Asia/Taipei'), { first: '2026-11-21', last: '2026-11-21', period: false, days: 1 });
  assert.deepEqual(eventSpan({ starts_at: '2026-11-15T00:00:00.000Z', ends_at: '2026-11-16T00:00:00.000Z' }, 'UTC'), { first: '2026-11-15', last: '2026-11-15', period: true, days: 1 });
  assert.deepEqual(eventSpan({ starts_at: '2026-11-15T10:00:00.000Z', ends_at: '2026-11-15T09:00:00.000Z' }, 'UTC')?.period, false, 'A broken end is ignored');
  assert.equal(eventSpan({ starts_at: 'nope', ends_at: null }, 'UTC'), null);
});

test('week layout packs overlapping periods into lanes and keeps points per day', () => {
  const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
  const events = [
    event('plan', 'plan', '2026-11-10T00:00:00.000Z', { ends_at: '2026-11-30T00:00:00.000Z', all_day: true }),
    event('promo', 'promotion', '2026-11-11T00:00:00.000Z', { ends_at: '2026-11-18T00:00:00.000Z' }),
    event('flight', 'ad_flight', '2026-11-18T00:00:00.000Z', { ends_at: '2026-11-20T00:00:00.000Z' }),
    event('late', 'publish', '2026-11-20T15:00:00.000Z'),
    event('early', 'publish', '2026-11-20T09:00:00.000Z'),
    event('outside', 'publish', '2026-11-25T09:00:00.000Z'),
  ];
  const layout = layoutWeek(events, days, 'UTC');
  assert.equal(layout.lanes, 2);
  const bar = (id: string) => layout.bars.find(item => item.event.id === id)!;
  assert.deepEqual([bar('plan:plan').col, bar('plan:plan').span, bar('plan:plan').lane, bar('plan:plan').before, bar('plan:plan').after], [0, 7, 0, true, true]);
  assert.deepEqual([bar('promotion:promo').col, bar('promotion:promo').span, bar('promotion:promo').lane, bar('promotion:promo').after], [0, 2, 1, false]);
  assert.deepEqual([bar('ad_flight:flight').col, bar('ad_flight:flight').span, bar('ad_flight:flight').lane], [2, 2, 1], 'A free lane is reused');
  assert.deepEqual(layout.points.get('2026-11-20')!.map(item => item.id), ['publish:early', 'publish:late']);
  const capped = layoutWeek(events, days, 'UTC', 1);
  assert.equal(capped.bars.length, 1);
  assert.equal(capped.hiddenBars.get('2026-11-16'), 1);
  assert.equal(capped.hiddenBars.get('2026-11-18'), 1);
  assert.equal(capped.hiddenBars.get('2026-11-22'), undefined);
});

test('agenda shows periods as start and end markers and points on their day', () => {
  const events = [
    event('plan', 'plan', '2026-11-10T00:00:00.000Z', { ends_at: '2026-11-30T00:00:00.000Z', all_day: true }),
    event('day', 'promotion', '2026-11-20T00:00:00.000Z', { ends_at: '2026-11-21T00:00:00.000Z' }),
    event('post', 'publish', '2026-11-20T09:00:00.000Z'),
    event('milestone', 'milestone', '2026-11-20T00:00:00.000Z', { all_day: true }),
  ];
  const days = agendaDays(events, '2026-11-01', '2026-11-30', 'UTC');
  assert.deepEqual(days.map(day => [day.day, day.items.map(item => `${item.role}:${item.event.id}`)]), [
    ['2026-11-10', ['start:plan:plan']],
    ['2026-11-20', ['single:promotion:day', 'point:milestone:milestone', 'point:publish:post']],
    ['2026-11-29', ['end:plan:plan']],
  ]);
  assert.equal(agendaDays(events, '2026-11-16', '2026-11-22', 'UTC', true).length, 7);
  assert.deepEqual(periodsIn(events, '2026-11-16', '2026-11-22', 'UTC').map(item => item.event.id), ['plan:plan', 'promotion:day']);
  assert.deepEqual(periodProgress(eventSpan(events[0], 'UTC')!, '2026-11-20'), { day: 11, days: 20 });
  assert.equal(periodProgress(eventSpan(events[0], 'UTC')!, '2026-12-01'), null);
});

test('summary: next publication skips settled ones, needs-human counted by type', () => {
  const now = new Date('2026-11-20T12:00:00.000Z');
  const events = [
    event('past', 'publish', '2026-11-20T08:00:00.000Z', { status: 'scheduled' }),
    event('done', 'publish', '2026-11-20T13:00:00.000Z', { status: 'published' }),
    event('next', 'publish', '2026-11-20T14:00:00.000Z', { status: 'scheduled', needs_human: 'approval' }),
    event('later', 'publish', '2026-11-22T14:00:00.000Z', { status: 'draft' }),
    event('unknown', 'publish', '2026-11-19T14:00:00.000Z', { status: 'outcome_unknown', needs_human: 'outcome_unknown' }),
    event('plan', 'plan', '2026-11-10T00:00:00.000Z', { ends_at: '2026-11-30T00:00:00.000Z' }),
  ];
  const summary = summarize(events, now, '2026-11-20', 'UTC');
  assert.equal(summary.next?.id, 'publish:next');
  assert.equal(summary.upcoming, 2);
  assert.deepEqual(summary.needs, { approval: 1, needs_owner: 0, missed: 0, late_decision: 0, outcome_unknown: 1, total: 2 });
  assert.equal(summary.counts.publish, 5);
  assert.deepEqual([summary.scheduled, summary.published, summary.periods], [4, 1, 1]);
  assert.equal(summary.today, 4, 'Today counts the plan running through it');
  assert.equal(summarize([], now, '2026-11-20', 'UTC').next, null);
  assert.deepEqual(events.map(item => isOverdue(item, now, '2026-11-20', 'UTC')), [true, false, false, false, false, false],
    'Only a publication still waiting after its time is overdue; an unknown outcome has its own marker');
});

test('decision links and permalinks', () => {
  assert.equal(decisionHref('/app/w', { kind: 'publish', needs_human: 'approval' }), '/app/w/decisions?kind=publish_approval');
  assert.equal(decisionHref('/app/w', { kind: 'ad_flight', needs_human: 'approval' }), '/app/w/decisions?kind=ad_proposal');
  assert.equal(decisionHref('/app/w', { kind: 'publish', needs_human: 'late_decision' }), '/app/w/decisions?kind=late_decision');
  assert.equal(decisionHref('/app/w', { kind: 'publish', needs_human: 'outcome_unknown' }), '/app/w/decisions');
  assert.equal(safePermalink('https://example.com/p/1'), 'https://example.com/p/1');
  assert.equal(safePermalink('javascript:alert(1)'), null);
  assert.equal(safePermalink('not a url'), null);
});

test('E37: a post the owner rejected reads 已駁回 in the calendar and is never marked overdue', async () => {
  const { eventStatus } = await import('./calendar-text');
  assert.deepEqual(eventStatus('publish', 'rejected', 'zh'), { tone: 'neutral', label: '已駁回' });
  assert.deepEqual(eventStatus('publish', 'rejected', 'en'), { tone: 'neutral', label: 'Rejected' });
  const now = new Date('2026-11-20T12:00:00.000Z');
  assert.equal(isOverdue(event('rejected', 'publish', '2026-11-20T08:00:00.000Z', { status: 'rejected' }), now, '2026-11-20', 'UTC'), false);
});

test('U6: phase 1 offers only post kinds, plus a hidden kind the period really has; 顯示其他模組 offers every kind', () => {
  assert.deepEqual(offeredKinds(false), ['publish', 'post']);
  assert.deepEqual(offeredKinds(false, { publish: 3, plan: 1, live: 0 }), ['publish', 'post', 'plan']);
  assert.deepEqual(offeredKinds(true), ['publish', 'post', 'plan', 'milestone', 'production_due', 'deliverable_due', 'live', 'ad_flight', 'promotion']);
});
