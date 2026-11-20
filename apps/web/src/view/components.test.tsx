import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ActivityList, AgentPrompt, BarChart, DecisionCard, Freshness, KpiTile, LineChart, MonthCalendar, Sparkline, StatusChip, Timeline, ViewLang,
  type CalendarEvent, type DecisionItem, type Lang,
} from '@smartsell/ui';

const html = (node: ReactNode, lang: Lang = 'zh') => renderToStaticMarkup(<ViewLang lang={lang}>{node}</ViewLang>);
const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;
const days = (from: string, values: (number | null)[]) => values.map((value, index) => ({
  date: new Date(Date.parse(`${from}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10), value, availability: value === null ? 'not_collected' : 'observed',
}));

test('KpiTile shows "not collected" for a null value and never renders it as zero', () => {
  const out = html(<KpiTile label="瀏覽" metric={{ value: null, availability: 'not_collected', previous_value: 10 }} />);
  assert.match(out, /未採集/);
  assert.match(out, /—/);
  assert.doesNotMatch(out, />0</);
  assert.doesNotMatch(out, /較前期/);
});

test('KpiTile formats *_minor money and the change against the prior period', () => {
  const out = html(<KpiTile label="Ad spend" unit="currency" currency="TWD" goodDirection="none" metric={{ value: 123456, availability: 'observed', previous_value: 100000 }} />, 'en');
  assert.match(out, /1,234\.56/);
  assert.match(out, /\+23\.5%/);
  assert.match(out, /tone-neutral/);
  const estimated = html(<KpiTile label="Views" metric={{ value: 900, availability: 'estimated' }} />, 'en');
  assert.match(estimated, /Estimated/);
  assert.match(estimated, /No prior period/);
});

test('LineChart draws a gap for null points, a legend for two series and a table toggle', () => {
  const out = html(<LineChart title="Views" series={[
    { key: 'a', label: 'Instagram', points: days('2026-11-01', [3, 5, null, 4, 6]) },
    { key: 'b', label: 'TikTok', points: days('2026-11-01', [1, 2, 2, 3, 3]) },
  ]} />, 'en');
  assert.equal(count(out, /class="vs-line"/g), 3);
  assert.match(out, /class="vs-legend"/);
  assert.match(out, /Instagram/);
  assert.match(out, /aria-pressed="false"[^>]*>Table</);
  const single = html(<LineChart title="Views" series={[{ key: 'a', label: 'Total', points: days('2026-11-01', [3, 5]) }]} />);
  assert.doesNotMatch(single, /class="vs-legend"/);
  const empty = html(<LineChart title="Views" series={[{ key: 'a', label: 'Total', points: days('2026-11-01', [null, null]) }]} />);
  assert.match(empty, /此期間沒有已採集的數據/);
  assert.equal(count(empty, /class="vs-line"/g), 0);
});

test('Sparkline and BarChart leave unknown values out instead of drawing zero', () => {
  assert.equal(count(html(<Sparkline label="s" points={[1, null, 3, 4]} />), /class="vs-line"/g), 1);
  const bars = html(<BarChart title="Spend" bars={[{ key: 'a', label: 'Meta', value: 40 }, { key: 'b', label: 'Google', value: null, availability: 'no_permission' }]} />, 'en');
  assert.equal(count(bars, /<path /g), 1);
  assert.match(bars, /No permission/);
});

const item: DecisionItem = {
  id: 'publish_approval:1', kind: 'publish_approval', severity: 'high', title: 'IG post 11/22', created_at: '2026-11-20T01:00:00Z',
  requested_by: { type: 'agent', label: 'Claude Code' }, resource: { type: 'publish_target', id: 't1', version: 7 },
  preview: { text: 'Caption text', fields: [{ label: ['排程', 'Schedule'], before: null, after: '2026-11-22 20:00' }] },
  actions: [
    { key: 'approve', label: ['核准', 'Approve'], method: 'POST', path: '/publish-targets/t1/approve', version: 7, tone: 'primary' },
    { key: 'reject', label: ['退回', 'Reject'], method: 'POST', path: '/publish-targets/t1/reject', requires_reason: true, tone: 'danger' },
  ],
};

test('DecisionCard previews the proposal, who asked, and one button per action', () => {
  const out = html(<DecisionCard item={item} />);
  for (const text of ['發布審批', '高優先', 'Claude Code', 'Caption text', '排程', '2026-11-22 20:00', '核准', '退回']) assert.ok(out.includes(text), text);
  // A new proposal has nothing before it, so there is no empty "before" column.
  assert.ok(!out.includes('未設定'));
  const change = html(<DecisionCard item={{ ...item, preview: { fields: [{ label: ['平台', 'Platform'], before: 'tiktok', after: 'meta_instagram' }] } }} />);
  for (const text of ['原本', 'TikTok', 'Instagram']) assert.ok(change.includes(text), text);
  assert.match(out, /severity-high/);
  const readOnly = html(<DecisionCard item={{ ...item, actions: [] }} />, 'en');
  assert.match(readOnly, /No decision actions are available to you/);
});

test('MonthCalendar puts events on their local day and folds overflow into +N', () => {
  const events: CalendarEvent[] = Array.from({ length: 5 }, (_, index) => ({ id: `e${index}`, kind: 'publish', title: `Post ${index}`, starts_at: `2026-11-20T0${index}:00:00Z` }));
  const out = html(<MonthCalendar month="2026-11" events={[...events, { id: 'p', kind: 'plan', title: 'Launch', starts_at: '2026-11-18', ends_at: '2026-11-19', all_day: true }]} timeZone="UTC" today="2026-11-20" />, 'en');
  assert.match(out, /\+2/);
  assert.equal(count(out, />Launch</g), 2);
  assert.match(out, /Scheduled post/);
  const week = html(<MonthCalendar month="2026-11" mode="week" week="2026-11-16" events={events} timeZone="UTC" today="2026-11-20" />, 'en');
  assert.equal(count(week, />Post \d</g), 5);
});

test('Timeline positions items inside the range and marks today', () => {
  const out = html(<Timeline from="2026-11-01" to="2026-11-30" today="2026-11-16" lanes={[{ id: 'p', label: 'Plan', items: [
    { id: 'a', label: 'Window', start: '2026-11-11', end: '2026-11-20' }, { id: 'b', label: 'Due', start: '2026-11-25' }, { id: 'c', label: 'Out', start: '2026-12-05' },
  ] }]} />);
  assert.match(out, /left:33\.33[0-9]*%;width:33\.33[0-9]*%/);
  assert.match(out, /milestone/);
  assert.doesNotMatch(out, /Out/);
  assert.equal(count(out, /vs-today/g), 2);
});

test('AgentPrompt, StatusChip, Freshness and ActivityList speak the selected language', () => {
  const prompt = html(<AgentPrompt title="還沒有商品" prompt="幫我匯入商品" agentHref="/app/w/agent" />);
  assert.match(prompt, /「幫我匯入商品」/);
  assert.match(prompt, /href="\/app\/w\/agent"/);
  assert.match(html(<StatusChip status="outcome_unknown" />, 'en'), /tone-serious[^>]*>.*Outcome unknown/);
  assert.match(html(<Freshness asOf={null} />, 'en'), /Data time unknown/);
  const activity = html(<ActivityList items={[{ id: 'a', occurred_at: '2026-11-20T00:00:00Z', actor: { type: 'agent', label: null }, action: 'publishing_create_target', summary: ['建立了發布排期', 'Created a publish schedule'], count: 3, resource: { type: 'publish_target', id: 't', title: 'Nov post' } }]} />, 'en');
  assert.match(activity, /Agent/);
  assert.match(activity, /Created a publish schedule/);
  assert.match(activity, /×3/);
});
