import { useState, useSyncExternalStore } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CalendarDays, ChevronLeft, ChevronRight, List, Rows3 } from 'lucide-react';
import { addDays, monthGrid, type CalendarEvent } from '@smartsell/ui';
import { copy } from '../copy';
import { todayIn } from '../data/period';
import { useView, useViewContext, workspaceZone } from '../data/use-view';
import type { CalendarView, PlanCard } from '../data/types';
import { Loaded, PageHeader, RouterLink, useFilters, useText } from '../parts';
import {
  allKindsParams, eventParams, modeParams, navigateParams, offeredKinds, periodsIn, readCalendarParams, summarize, toggleKindParams, type Mode,
} from './calendar-logic';
import { useShowMoreModules } from '../../preferences';
import { EventDrawer } from './calendar-drawer';
import { Agenda, DayPanel, MonthGrid, PeriodList, WeekGrid } from './calendar-grid';
import { KindFilter } from './calendar-parts';
import { CalendarSummaryStrip } from './calendar-summary';
import { fill, kindLabel, monthLabel, shortDay, t } from './calendar-text';
import './calendar.css';

const NARROW = '(max-width: 639px)';
function useNarrow() {
  return useSyncExternalStore(
    notify => { const query = window.matchMedia(NARROW); query.addEventListener('change', notify); return () => query.removeEventListener('change', notify); },
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

const modeIcon = { month: CalendarDays, week: Rows3, list: List } as const;

/** 日曆: what goes out next and what happens when, over month, week and list views. */
export function CalendarPage() {
  const { l, lang } = useText();
  const { ws, base } = useViewContext();
  const { brandId } = useFilters();
  const [params, setParams] = useSearchParams();
  const narrow = useNarrow();
  const moreModules = useShowMoreModules();
  const state = readCalendarParams(params, todayIn(workspaceZone(ws)), narrow);
  // Period, view and plan changes are history steps; filters and the open drawer replace the entry.
  const update = (next: URLSearchParams) => setParams(next, { replace: true });
  const go = (next: URLSearchParams) => setParams(next);

  // The plan filter is checked against the plans of the selected brand before it is sent.
  const plans = useView<PlanCard[]>('/views/plans', { brand_id: brandId, limit: '200' });
  const planList = plans.isPlaceholderData || !Array.isArray(plans.value) ? undefined : plans.value;
  const waitForPlans = Boolean(state.campaign) && planList === undefined && !plans.isError;
  const campaignKnown = !state.campaign || !planList || Boolean(plans.nextCursor) || planList.some(plan => plan.id === state.campaign);
  const campaignId = state.campaign && campaignKnown && !waitForPlans ? state.campaign : undefined;
  const planName = new Map((planList ?? (Array.isArray(plans.value) ? plans.value : [])).map(plan => [plan.id, plan.name]));

  const read = useView<CalendarView>('/views/calendar', { from: state.from, to: state.to, brand_id: brandId, campaign_id: campaignId }, { enabled: !waitForPlans });
  const zone = read.value?.range?.tz ?? workspaceZone(ws);
  const today = todayIn(zone);
  const [picked, setPicked] = useState<{ key: string; day: string } | null>(null);
  const pickKey = `${state.mode}:${state.from}`;
  const selected = picked?.key === pickKey ? picked.day : null;
  const [hideEarlier, setHideEarlier] = useState(true);

  const open = (event: CalendarEvent) => update(eventParams(params, event.id));
  const unit = state.unit === 'week';
  const rangeLabel = unit ? `${shortDay(state.from, lang)} – ${shortDay(state.to, lang)}` : monthLabel(state.month, lang);
  const modes: [Mode, readonly [string, string]][] = [['month', t.month], ['week', t.week], ['list', t.list]];

  return <div className="cal-page">
    <PageHeader title={l(copy.pages.calendarTitle)} subtitle={l(t.subtitle)} asOf={read.isPending ? undefined : read.asOf ?? null} timeZone={zone} />
    <div className="cal-toolbar">
      <div className="cal-nav" role="group" aria-label={l(t.navigation)}>
        <button type="button" className="vs-icon-button" aria-label={l(unit ? t.prevWeek : t.prevMonth)} title={l(unit ? t.prevWeek : t.prevMonth)}
          onClick={() => go(navigateParams(params, state, -1, today))}><ChevronLeft size={16} aria-hidden="true" /></button>
        <button type="button" className="cal-today-button" onClick={() => go(navigateParams(params, state, 0, today))}>{l(t.today)}</button>
        <button type="button" className="vs-icon-button" aria-label={l(unit ? t.nextWeek : t.nextMonth)} title={l(unit ? t.nextWeek : t.nextMonth)}
          onClick={() => go(navigateParams(params, state, 1, today))}><ChevronRight size={16} aria-hidden="true" /></button>
        <h2 className="cal-range" aria-live="polite">{rangeLabel}</h2>
      </div>
      <div className="cal-modes" role="group" aria-label={l(t.viewMode)}>
        {modes.map(([mode, label]) => {
          const Icon = modeIcon[mode];
          return <button key={mode} type="button" aria-pressed={state.mode === mode} onClick={() => go(modeParams(params, state, mode, today))}><Icon size={14} aria-hidden="true" />{l(label)}</button>;
        })}
      </div>
      {(planName.size > 0 || state.campaign) && <div className="cal-plan">
        <label><span className="vs-sr">{l(t.plan)}</span>
          <select value={state.campaign ?? ''} onChange={change => { const next = new URLSearchParams(params); if (change.target.value) next.set('campaign', change.target.value); else next.delete('campaign'); next.delete('event'); go(next); }}>
            <option value="">{l(t.allPlans)}</option>
            {state.campaign && !planName.has(state.campaign) && <option value={state.campaign}>{l(t.plan)} {state.campaign.slice(0, 8)}</option>}
            {[...planName].map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select></label>
        {campaignId && <RouterLink to={`${base}/plans/${encodeURIComponent(campaignId)}`} className="cal-plan-link">{l(t.openPlan)}</RouterLink>}
      </div>}
      <span className="cal-tz muted" title={l(t.timeZoneHint)}>{l(t.timeZone)} {zone ?? 'UTC'}</span>
    </div>
    {state.campaign && !campaignKnown && <p className="vs-notice warning cal-notice" role="status">{l(t.planMismatch)}
      <button type="button" className="vs-link-button" onClick={() => { const next = new URLSearchParams(params); next.delete('campaign'); update(next); }}>{l(t.clearPlan)}</button></p>}
    <Loaded read={read}>{view => {
      const all = Array.isArray(view.events) ? view.events : [];
      const sources = Array.isArray(view.sources) ? view.sources : [];
      const summary = summarize(all, new Date(), today, zone);
      const offered = offeredKinds(moreModules, summary.counts);
      // A kind the filter does not offer (a hidden module, U6) is not worth a 「你的角色看不到」 note either.
      const locked = sources.filter(source => source.availability === 'no_permission' && offered.includes(source.kind as never)).map(source => source.kind);
      const available = offered.filter(kind => !locked.includes(kind));
      const shown = state.kinds ? all.filter(event => state.kinds!.has(event.kind)) : all;
      const current = state.event ? all.find(event => event.id === state.event) : undefined;
      const from = view.range?.from ?? state.from, to = view.range?.to ?? state.to;
      const past = to < today;
      return <div className="cal-body">
        {locked.length > 0 && <p className="vs-notice cal-notice" role="note">{fill(l(t.noPermissionNote), { kinds: locked.map(kind => kindLabel(kind, lang)).join(lang === 'en' ? ', ' : '、') })}</p>}
        {state.event && !current && !read.isPlaceholderData && <p className="vs-notice cal-notice" role="status">{l(t.notOnCalendar)}
          <button type="button" className="vs-link-button" onClick={() => update(eventParams(params, null))}>{l(t.close)}</button></p>}
        {all.length ? <CalendarSummaryStrip summary={summary} from={from} to={to} today={today} timeZone={zone} base={base} onOpen={open} />
          : <div className="cal-empty vs-notice" role="status"><p><strong>{l(copy.pages.calendarEmpty)}</strong></p>
            <p className="muted">{l(['在 Codex 說「明天 9:00 把 video.mp4 發到 X」，排好的貼文會出現在今日與這裡。', 'Tell Codex "post video.mp4 to X tomorrow at 9:00"; scheduled posts show up on Today and here.'])}</p>
            <div className="vs-actions"><RouterLink to={base} className="vs-btn">{l(['今日', 'Today'])}</RouterLink><RouterLink to={`${base}/channels`} className="vs-btn">{l(['帳號', 'Channels'])}</RouterLink>
              <RouterLink to={`${base}/agent`} className="vs-btn">{l(['連接 AI 助手', 'Connect your AI assistant'])}</RouterLink></div></div>}
        <KindFilter kinds={offered} shown={state.kinds} counts={summary.counts} sources={sources} onToggle={kind => update(toggleKindParams(params, state.kinds, kind, available))} onAll={() => update(allKindsParams(params))} />
        {all.length > 0 && !shown.length && <p className="vs-notice cal-notice" role="status">{fill(l(t.filteredEmpty), { n: all.length })}
          <button type="button" className="vs-link-button" onClick={() => update(allKindsParams(params))}>{l(t.clearFilters)}</button></p>}
        <div className="cal-view">
          {state.mode === 'month' && <>
            <MonthGrid month={state.month} days={monthGrid(state.month)} events={shown} timeZone={zone} today={today} onOpen={open}
              selected={selected} onDay={day => setPicked(selected === day ? null : { key: pickKey, day })} />
            {selected && <DayPanel day={selected} events={shown} timeZone={zone} today={today} onOpen={open} base={base} onClose={() => setPicked(null)} />}
          </>}
          {state.mode === 'week' && <WeekGrid days={Array.from({ length: 7 }, (_, index) => addDays(state.week, index))} events={shown} timeZone={zone} today={today} onOpen={open} base={base}
            periods={<PeriodList periods={periodsIn(shown, state.from, state.to, zone)} today={today} onOpen={open} />} />}
          {state.mode === 'list' && (shown.length > 0 || all.length > 0) && <>
            <PeriodList periods={periodsIn(shown, state.from, state.to, zone)} today={today} onOpen={open} />
            <Agenda events={shown} from={state.from} to={state.to} timeZone={zone} today={today} onOpen={open} base={base}
              collapseBefore={today > state.from && today <= state.to ? { hidden: hideEarlier, toggle: () => setHideEarlier(value => !value) } : undefined} />
          </>}
        </div>
        {current && <EventDrawer key={current.id} event={current} timeZone={zone} today={today} base={base} planName={current.campaign_id ? planName.get(current.campaign_id) : undefined}
          onClose={() => update(eventParams(params, null))} />}
      </div>;
    }}</Loaded>
  </div>;
}
