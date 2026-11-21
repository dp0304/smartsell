import { addDays, dayIn, diffDays, isDay, monthGrid, weekStart, type CalendarEvent } from '@smartsell/ui';

// Pure state and layout for the calendar page: URL parameters, event spans, week lanes, agenda rows and the summary.

export const calendarKinds = ['publish', 'post', 'plan', 'milestone', 'production_due', 'deliverable_due', 'live', 'ad_flight', 'promotion'] as const;
export type CalendarKind = typeof calendarKinds[number];
export type Mode = 'month' | 'week' | 'list';
export type NeedsHuman = 'approval' | 'late_decision' | 'outcome_unknown';
export const needsHumanKinds: readonly NeedsHuman[] = ['approval', 'late_decision', 'outcome_unknown'];

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isMonth = (value: unknown): value is string => typeof value === 'string' && MONTH.test(value);
export function shiftMonth(month: string, by: number) {
  const [year, index] = month.split('-').map(Number);
  return new Date(Date.UTC(year, index - 1 + by, 1)).toISOString().slice(0, 7);
}
export const lastOfMonth = (month: string) => addDays(`${shiftMonth(month, 1)}-01`, -1);

export interface CalendarState {
  mode: Mode; explicitMode: boolean; unit: 'month' | 'week';
  /** Anchor month (month and list views) and anchor Monday (week view). */
  month: string; week: string;
  /** Inclusive day range that is visible and fetched. */
  from: string; to: string;
  /** Kinds the person chose to show; null shows every kind. */
  kinds: Set<string> | null;
  campaign: string | null; event: string | null;
}

/** Reads ?view, ?month, ?week, ?kinds, ?campaign and ?event; without ?view narrow screens start in the list. */
export function readCalendarParams(params: URLSearchParams, today: string, narrow: boolean): CalendarState {
  const raw = params.get('view');
  const explicitMode = raw === 'month' || raw === 'week' || raw === 'list';
  const mode: Mode = explicitMode ? raw : narrow ? 'list' : 'month';
  const unit = mode === 'week' ? 'week' : 'month';
  const weekParam = params.get('week');
  const week = weekStart(isDay(weekParam) ? weekParam : today);
  const monthParam = params.get('month');
  const month = isMonth(monthParam) ? monthParam : today.slice(0, 7);
  let from: string, to: string;
  if (mode === 'week') { from = week; to = addDays(week, 6); }
  else if (mode === 'month') { const grid = monthGrid(month); from = grid[0]; to = grid[grid.length - 1]; }
  else { from = `${month}-01`; to = lastOfMonth(month); }
  const kindsParam = params.get('kinds');
  const kinds = kindsParam === null ? null : new Set(kindsParam.split(',').map(kind => kind.trim()).filter(kind => (calendarKinds as readonly string[]).includes(kind)));
  return { mode, explicitMode, unit, month, week, from, to, kinds, campaign: params.get('campaign') || null, event: params.get('event') || null };
}

const withChanges = (params: URLSearchParams, changes: Record<string, string | null>) => {
  const next = new URLSearchParams(params);
  for (const [key, value] of Object.entries(changes)) if (value === null) next.delete(key); else next.set(key, value);
  return next;
};

/** Previous (-1), today (0) or next (+1) period. The current period is written as no anchor at all. */
export function navigateParams(params: URLSearchParams, state: CalendarState, by: -1 | 0 | 1, today: string) {
  if (by === 0) return withChanges(params, { month: null, week: null, event: null });
  if (state.unit === 'week') {
    const week = addDays(state.week, by * 7);
    return withChanges(params, { week: week === weekStart(today) ? null : week, month: null, event: null });
  }
  const month = shiftMonth(state.month, by);
  return withChanges(params, { month: month === today.slice(0, 7) ? null : month, week: null, event: null });
}

/** Switches view and carries the anchor across: a week belongs to the month holding its Thursday. */
export function modeParams(params: URLSearchParams, state: CalendarState, mode: Mode, today: string) {
  if (mode === 'week') {
    if (state.unit === 'week') return withChanges(params, { view: mode });
    const week = state.month === today.slice(0, 7) ? weekStart(today) : weekStart(`${state.month}-01`);
    return withChanges(params, { view: mode, month: null, week: week === weekStart(today) ? null : week });
  }
  if (state.unit === 'month') return withChanges(params, { view: mode });
  const month = addDays(state.week, 3).slice(0, 7);
  return withChanges(params, { view: mode, week: null, month: month === today.slice(0, 7) ? null : month });
}

/** Turns one kind on or off; all kinds shown is written as no parameter. */
export function toggleKindParams(params: URLSearchParams, shown: Set<string> | null, kind: string, available: readonly string[] = calendarKinds) {
  const next = new Set(shown ?? available);
  if (next.has(kind)) next.delete(kind); else next.add(kind);
  const all = available.every(item => next.has(item));
  return withChanges(params, { kinds: all ? null : calendarKinds.filter(item => next.has(item)).join(','), event: null });
}
export const onlyKindParams = (params: URLSearchParams, kind: string) => withChanges(params, { kinds: kind, event: null });
export const allKindsParams = (params: URLSearchParams) => withChanges(params, { kinds: null });
export const eventParams = (params: URLSearchParams, id: string | null) => withChanges(params, { event: id });

export interface Span { first: string; last: string; period: boolean; days: number }
/**
 * Local days an event covers. `ends_at` is an exclusive instant (a plan ending 2026-11-30T00:00 covers up to 29 Nov),
 * so the last day is the one holding the moment just before it.
 */
export function eventSpan(event: Pick<CalendarEvent, 'starts_at' | 'ends_at'>, timeZone?: string): Span | null {
  const first = dayIn(event.starts_at, timeZone);
  if (!first) return null;
  const start = Date.parse(event.starts_at), end = event.ends_at ? Date.parse(event.ends_at) : Number.NaN;
  if (!Number.isFinite(end) || !(end > start)) return { first, last: first, period: false, days: 1 };
  const lastRaw = dayIn(new Date(end - 1).toISOString(), timeZone);
  const last = lastRaw && lastRaw >= first ? lastRaw : first;
  return { first, last, period: true, days: diffDays(first, last) + 1 };
}

const kindRank = (kind: string) => { const index = (calendarKinds as readonly string[]).indexOf(kind); return index < 0 ? calendarKinds.length : index; };
const isAllDay = (event: CalendarEvent) => Boolean(event.all_day) || isDay(event.starts_at);
/** All-day items first, then by time, kind and id, so every view lists a day the same way. */
export function compareEvents(a: CalendarEvent, b: CalendarEvent) {
  return Number(isAllDay(b)) - Number(isAllDay(a)) || a.starts_at.localeCompare(b.starts_at) || kindRank(a.kind) - kindRank(b.kind) || a.id.localeCompare(b.id);
}

export interface WeekBar { event: CalendarEvent; col: number; span: number; lane: number; before: boolean; after: boolean }
export interface WeekLayout { bars: WeekBar[]; lanes: number; points: Map<string, CalendarEvent[]>; hiddenBars: Map<string, number> }
/**
 * Lays one Monday-first week out: multi-day periods become bars packed into the fewest lanes (first fit,
 * longest first) and the rest stay per-day points. Bars past `maxLanes` are counted per day instead.
 */
export function layoutWeek(events: readonly CalendarEvent[], days: readonly string[], timeZone?: string, maxLanes = Infinity): WeekLayout {
  const first = days[0], last = days[days.length - 1];
  const points = new Map<string, CalendarEvent[]>(days.map(day => [day, []]));
  const candidates: Omit<WeekBar, 'lane'>[] = [];
  for (const event of events) {
    const span = eventSpan(event, timeZone);
    if (!span || span.last < first || span.first > last) continue;
    if (!span.period) { points.get(span.first)?.push(event); continue; }
    const start = span.first < first ? first : span.first, end = span.last > last ? last : span.last;
    candidates.push({ event, col: diffDays(first, start), span: diffDays(start, end) + 1, before: span.first < first, after: span.last > last });
  }
  candidates.sort((a, b) => a.col - b.col || b.span - a.span || kindRank(a.event.kind) - kindRank(b.event.kind) || a.event.id.localeCompare(b.event.id));
  const lanes: boolean[][] = [];
  const bars: WeekBar[] = [];
  const hiddenBars = new Map<string, number>();
  for (const bar of candidates) {
    let lane = lanes.findIndex(used => used.slice(bar.col, bar.col + bar.span).every(taken => !taken));
    if (lane < 0) { lane = lanes.length; lanes.push(Array(days.length).fill(false)); }
    for (let col = bar.col; col < bar.col + bar.span; col++) lanes[lane][col] = true;
    if (lane < maxLanes) bars.push({ ...bar, lane });
    else for (let col = bar.col; col < bar.col + bar.span; col++) hiddenBars.set(days[col], (hiddenBars.get(days[col]) ?? 0) + 1);
  }
  for (const list of points.values()) list.sort(compareEvents);
  return { bars, lanes: Math.min(lanes.length, maxLanes), points, hiddenBars };
}

/** Splits a day list into Monday-first weeks. */
export const weeksOf = (days: readonly string[]) => Array.from({ length: Math.ceil(days.length / 7) }, (_, index) => days.slice(index * 7, index * 7 + 7));

export type AgendaRole = 'point' | 'start' | 'end' | 'single';
export interface AgendaItem { event: CalendarEvent; role: AgendaRole; span: Span }
export interface AgendaDay { day: string; items: AgendaItem[] }
/** Days with something on them; periods appear as a start marker and an end marker instead of on every day. */
export function agendaDays(events: readonly CalendarEvent[], from: string, to: string, timeZone?: string, includeEmpty = false): AgendaDay[] {
  const byDay = new Map<string, AgendaItem[]>();
  const push = (day: string, item: AgendaItem) => { if (day >= from && day <= to) byDay.set(day, [...(byDay.get(day) ?? []), item]); };
  for (const event of events) {
    const span = eventSpan(event, timeZone);
    if (!span) continue;
    if (!span.period) push(span.first, { event, role: 'point', span });
    else if (span.first === span.last) push(span.first, { event, role: 'single', span });
    else { push(span.first, { event, role: 'start', span }); push(span.last, { event, role: 'end', span }); }
  }
  const roleRank: Record<AgendaRole, number> = { start: 0, single: 1, end: 2, point: 3 };
  const days = includeEmpty ? Array.from({ length: diffDays(from, to) + 1 }, (_, index) => addDays(from, index)) : [...byDay.keys()].sort();
  return days.map(day => ({ day, items: (byDay.get(day) ?? []).sort((a, b) => roleRank[a.role] - roleRank[b.role] || compareEvents(a.event, b.event)) }));
}

export type DayRole = AgendaRole | 'during';
export interface DayItem { event: CalendarEvent; role: DayRole; span: Span }
/** Everything on one day, periods included with where the day falls in them. */
export function dayItems(events: readonly CalendarEvent[], day: string, timeZone?: string): DayItem[] {
  const roleRank: Record<DayRole, number> = { start: 0, single: 1, during: 2, end: 3, point: 4 };
  return events.flatMap(event => {
    const span = eventSpan(event, timeZone);
    if (!span || span.first > day || span.last < day) return [];
    const role: DayRole = !span.period ? 'point' : span.first === span.last ? 'single' : day === span.first ? 'start' : day === span.last ? 'end' : 'during';
    return [{ event, role, span }];
  }).sort((a, b) => roleRank[a.role] - roleRank[b.role] || compareEvents(a.event, b.event));
}

/** Periods (plans, flights, promotions) overlapping the range, longest-running first. */
export function periodsIn(events: readonly CalendarEvent[], from: string, to: string, timeZone?: string) {
  return events.flatMap(event => {
    const span = eventSpan(event, timeZone);
    return span?.period && span.first <= to && span.last >= from ? [{ event, span }] : [];
  }).sort((a, b) => a.span.first.localeCompare(b.span.first) || b.span.days - a.span.days || compareEvents(a.event, b.event));
}

/** Day N of M for a period on `today`; null outside it. */
export function periodProgress(span: Span, today: string): { day: number; days: number } | null {
  if (today < span.first || today > span.last) return null;
  return { day: diffDays(span.first, today) + 1, days: span.days };
}

const SETTLED = new Set(['published', 'failed', 'expired', 'closed', 'cancelled', 'cancel_requested', 'superseded']);
export interface CalendarSummary {
  counts: Record<string, number>;
  needs: Record<NeedsHuman, number> & { total: number };
  /** First publication still to go out at or after `now` inside the loaded range. */
  next: CalendarEvent | null;
  upcoming: number;
  /** Publications still scheduled vs. already out (scheduled ones that went out plus posts found on the platform). */
  scheduled: number; published: number; periods: number;
  today: number;
}
export function summarize(events: readonly CalendarEvent[], now: Date, today: string, timeZone?: string): CalendarSummary {
  const counts: Record<string, number> = {};
  const needs = { approval: 0, late_decision: 0, outcome_unknown: 0, total: 0 };
  let next: CalendarEvent | null = null, upcoming = 0, onToday = 0, scheduled = 0, published = 0, periods = 0;
  const at = now.getTime();
  for (const event of [...events].sort(compareEvents)) {
    counts[event.kind] = (counts[event.kind] ?? 0) + 1;
    if (event.needs_human && event.needs_human in needs) { needs[event.needs_human as NeedsHuman] += 1; needs.total += 1; }
    const span = eventSpan(event, timeZone);
    if (span && span.first <= today && span.last >= today) onToday += 1;
    if (span?.period) periods += 1;
    if (event.kind === 'post' || event.kind === 'publish' && event.status === 'published') published += 1;
    else if (event.kind === 'publish') scheduled += 1;
    if (event.kind !== 'publish' || SETTLED.has(String(event.status))) continue;
    const pending = isAllDay(event) ? (span?.first ?? '') >= today : Date.parse(event.starts_at) >= at;
    if (!pending) continue;
    upcoming += 1;
    if (!next || Date.parse(event.starts_at) < Date.parse(next.starts_at)) next = event;
  }
  return { counts, needs, next, upcoming, scheduled, published, periods, today: onToday };
}

/** A publication whose time has passed without it going out (or being settled otherwise). */
export function isOverdue(event: CalendarEvent, now: Date, today: string, timeZone?: string) {
  if (event.kind !== 'publish' || SETTLED.has(String(event.status)) || event.status === 'outcome_unknown') return false;
  return isAllDay(event) ? (eventSpan(event, timeZone)?.first ?? today) < today : Date.parse(event.starts_at) < now.getTime();
}

/** Where the person settles an event that needs them; the decisions page filters by its own kinds. */
export function decisionHref(base: string, event: Pick<CalendarEvent, 'kind' | 'needs_human'>) {
  const kind = event.needs_human === 'late_decision' ? 'late_decision'
    : event.needs_human === 'approval' && event.kind === 'publish' ? 'publish_approval'
      : event.needs_human === 'approval' && event.kind === 'ad_flight' ? 'ad_proposal' : null;
  return `${base}/decisions${kind ? `?kind=${kind}` : ''}`;
}

/** Only http(s) permalinks are shown as links. */
export const safePermalink = (value: string | null | undefined) => {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null; }
  catch { return null; }
};

