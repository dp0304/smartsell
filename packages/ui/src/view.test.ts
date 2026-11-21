import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  addDays, availabilityLabel, barPath, dayIn, diffDays, eventDays, formatMeasure, formatMinor, isDay, lineSegments, metricDelta,
  monthGrid, niceTicks, pick, statusInfo, weekStart,
} from './view.tsx';

test('lineSegments breaks at unknown values instead of treating them as zero', () => {
  assert.deepEqual(lineSegments([1, 2, null, 4, undefined, 0, 7]), [[[0, 1], [1, 2]], [[3, 4]], [[5, 0], [6, 7]]]);
  assert.deepEqual(lineSegments([null, null]), []);
});

test('metricDelta is unknown when either period is unknown or the base is zero', () => {
  assert.equal(metricDelta({ value: 120, availability: 'observed', previous_value: 100 }), 0.2);
  assert.equal(metricDelta({ value: 120, availability: 'observed', change_ratio: -0.5, previous_value: 100 }), -0.5);
  assert.equal(metricDelta({ value: 120, availability: 'observed', previous_value: null }), null);
  assert.equal(metricDelta({ value: 120, availability: 'observed', previous_value: 0 }), null);
  assert.equal(metricDelta({ value: null, availability: 'not_collected', previous_value: 10 }), null);
  assert.equal(metricDelta(undefined), null);
});

test('formatMinor uses the currency minor unit and refuses to guess a missing currency', () => {
  // Symbols name the currency (NT$, US$, JP¥) so amounts from different markets never look alike.
  assert.equal(formatMinor(123456, 'TWD', 'en'), 'NT$1,234.56');
  assert.equal(formatMinor(120000, 'TWD', 'zh'), 'NT$1,200');
  assert.equal(formatMinor(1500, 'JPY', 'en'), 'JP¥1,500');
  assert.equal(formatMinor(-250, 'USD', 'en'), '-US$2.50');
  assert.equal(formatMinor(100, 'XYZ', 'en'), 'XYZ 1');
  assert.equal(formatMinor(null, 'USD', 'en'), null);
  assert.equal(formatMinor(100, null, 'en'), null);
  assert.match(formatMeasure(100, 'currency', null, 'en'), /minor units/);
  assert.equal(formatMeasure(0.256, 'ratio', null, 'en'), '25.6%');
  assert.equal(formatMeasure(12000, 'count', null, 'en', true), '12K');
});

test('niceTicks returns clean steps that cover the data', () => {
  assert.deepEqual(niceTicks(0, 87, 4), [0, 25, 50, 75, 100]);
  assert.deepEqual(niceTicks(0, 3, 4, true), [0, 1, 2, 3]);
  assert.deepEqual(niceTicks(0, 0), [0, 1]);
  const ticks = niceTicks(-12, 40, 4);
  assert.ok(ticks[0] <= -12 && ticks[ticks.length - 1] >= 40);
});

test('day helpers work on calendar days, not local clock time', () => {
  assert.equal(addDays('2026-02-28', 1), '2026-03-01');
  assert.equal(diffDays('2026-11-01', '2026-11-30'), 29);
  assert.equal(isDay('2026-02-30'), false);
  assert.equal(isDay('2026-11-20'), true);
  assert.equal(dayIn('2026-11-20T17:30:00Z', 'Asia/Taipei'), '2026-11-21');
  assert.equal(dayIn('2026-11-20T17:30:00Z', 'UTC'), '2026-11-20');
  assert.equal(dayIn('2026-11-20'), '2026-11-20');
  assert.equal(weekStart('2026-11-22'), '2026-11-16');
});

test('monthGrid starts on Monday and keeps only weeks touching the month', () => {
  const grid = monthGrid('2026-11');
  assert.equal(grid[0], '2026-10-26');
  assert.equal(grid.length % 7, 0);
  assert.ok(grid.includes('2026-11-30'));
  assert.ok(grid.slice(-7).some(day => day.startsWith('2026-11')));
  assert.equal(monthGrid('2027-02').length, 28);
});

test('eventDays clips multi-day events to the visible range in the event zone', () => {
  assert.deepEqual(eventDays({ starts_at: '2026-11-29T02:00:00Z', ends_at: '2026-12-03T02:00:00Z' }, 'UTC', '2026-11-01', '2026-11-30'), ['2026-11-29', '2026-11-30']);
  assert.deepEqual(eventDays({ starts_at: '2026-11-20T16:30:00Z' }, 'Asia/Taipei', '2026-11-01', '2026-11-30'), ['2026-11-21']);
  assert.deepEqual(eventDays({ starts_at: '2026-12-02T00:00:00Z' }, 'UTC', '2026-11-01', '2026-11-30'), []);
});

test('labels: availability, status dictionary and tuples', () => {
  assert.equal(availabilityLabel('not_collected', 'zh'), '未採集');
  assert.equal(availabilityLabel(undefined, 'en'), 'Not collected');
  assert.deepEqual(statusInfo('failed', 'en'), { tone: 'critical', label: 'Failed' });
  assert.deepEqual(statusInfo('pending_approval', 'zh'), { tone: 'warning', label: '待審批' });
  assert.deepEqual(statusInfo('custom_state', 'en'), { tone: 'neutral', label: 'custom state' });
  assert.equal(pick(['中', 'En'], 'en'), 'En');
  assert.equal(pick('plain', 'zh'), 'plain');
});

test('barPath rounds only the data end', () => {
  assert.equal(barPath(0, 0, 0, 16, 'end'), '');
  assert.match(barPath(10, 0, 50, 16, 'end'), /^M10,0H56Q60,0 60,4V12Q60,16 56,16H10Z$/);
});
