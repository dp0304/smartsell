import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import { addDays, type CalendarEvent } from '@smartsell/ui';
import { useText } from '../parts';
import { agendaDays, dayItems, eventSpan, layoutWeek, periodProgress, weeksOf, type Span } from './calendar-logic';
import { AgendaRow, EventChip, KindKey, eventName, type OpenEvent } from './calendar-parts';
import { dayLabel, fill, kindLabel, shortDay, t, weekdayShort } from './calendar-text';

interface GridProps { events: readonly CalendarEvent[]; timeZone?: string; today: string; onOpen: OpenEvent }

/** One Monday-first week: day backgrounds, multi-day periods as spanning bars, then the day's own events. */
function WeekRow({ days, month, events, timeZone, today, onOpen, selected, onDay, rich }: GridProps & {
  days: readonly string[]; month?: string; selected?: string | null; onDay?: (day: string) => void; rich: boolean;
}) {
  const { l, lang } = useText();
  const maxLanes = rich ? Infinity : 3;
  const maxPoints = rich ? Infinity : 3;
  const layout = layoutWeek(events, days, timeZone, maxLanes);
  const pointsRow = layout.lanes + 2;
  const rows = `var(--cal-head) ${'var(--cal-lane) '.repeat(layout.lanes)}minmax(0, 1fr)`;
  return <div className={`cal-week${rich ? ' rich' : ''}`} style={{ '--cal-rows': rows } as CSSProperties}>
    {days.map((day, index) => {
      const points = layout.points.get(day) ?? [];
      const total = points.length + layout.bars.filter(bar => bar.col <= index && bar.col + bar.span > index).length + (layout.hiddenBars.get(day) ?? 0);
      const className = ['cal-cell', month && !day.startsWith(month) ? 'outside' : '', day === today ? 'today' : '', day === selected ? 'selected' : ''].filter(Boolean).join(' ');
      const name = `${dayLabel(day, lang)}${day === today ? ` · ${l(t.today)}` : ''} · ${total ? fill(l(t.items), { n: total }) : l(t.nothing)}`;
      return <div key={day} className={className} style={{ gridColumn: index + 1, gridRow: `1 / ${pointsRow + 1}` }}>
        {onDay ? <button type="button" className="cal-date" aria-label={name} aria-pressed={day === selected} onClick={() => onDay(day)}>
          {rich && <span className="cal-dow">{weekdayShort(day, lang)}</span>}<span className="cal-num">{Number(day.slice(8))}</span>
          {total > 0 && <span className="cal-dots" aria-hidden="true">{[...new Set([...layout.bars.filter(bar => bar.col <= index && bar.col + bar.span > index).map(bar => bar.event.kind), ...points.map(event => event.kind)])].slice(0, 4).map(kind => <KindKey key={kind} kind={kind} />)}</span>}
        </button> : <span className="cal-date">{rich && <span className="cal-dow">{weekdayShort(day, lang)}</span>}<span className="cal-num">{Number(day.slice(8))}</span></span>}
      </div>;
    })}
    {layout.bars.map(bar => {
      const style = { gridColumn: `${bar.col + 1} / span ${bar.span}`, gridRow: bar.lane + 2 };
      const span = eventSpan(bar.event, timeZone);
      const name = `${eventName(bar.event, lang, timeZone)}${span ? ` · ${shortDay(span.first, lang)} – ${shortDay(span.last, lang)}` : ''}`;
      return <button key={`${bar.event.id}-${days[0]}`} type="button" style={style} onClick={() => onOpen(bar.event)}
        className={`cal-bar cal-k-${bar.event.kind}${bar.before ? ' before' : ''}${bar.after ? ' after' : ''}${bar.event.needs_human ? ' needs' : ''}`}
        aria-label={name} title={name}>
        <span className="cal-bar-title">{bar.event.title}</span>
        {bar.event.needs_human && <span className="cal-bar-flag" aria-hidden="true">!</span>}
      </button>;
    })}
    {days.map((day, index) => {
      const points = layout.points.get(day) ?? [];
      const visible = points.slice(0, maxPoints);
      const hidden = points.length - visible.length + (layout.hiddenBars.get(day) ?? 0);
      if (!visible.length && !hidden) return null;
      return <div key={`p-${day}`} className="cal-points" style={{ gridColumn: index + 1, gridRow: pointsRow }}>
        {visible.map(event => <EventChip key={event.id} event={event} timeZone={timeZone} onOpen={onOpen} rich={rich} />)}
        {hidden > 0 && (onDay ? <button type="button" className="cal-more" onClick={() => onDay(day)}>{fill(l(t.more), { n: hidden })}</button>
          : <span className="cal-more">{fill(l(t.more), { n: hidden })}</span>)}
      </div>;
    })}
  </div>;
}

// Any Monday gives the column names.
const MONDAY = '2026-11-16';
function Weekdays() {
  const { lang } = useText();
  return <div className="cal-dows" aria-hidden="true">{Array.from({ length: 7 }, (_, index) => <span key={index}>{weekdayShort(addDays(MONDAY, index), lang)}</span>)}</div>;
}

/** Month grid; a click on a day opens that day's full list below the grid. */
export function MonthGrid({ month, days, selected, onDay, ...props }: GridProps & { month: string; days: readonly string[]; selected: string | null; onDay: (day: string) => void }) {
  return <div className="cal-board month">
    <Weekdays />
    {weeksOf(days).map(week => <WeekRow key={week[0]} days={week} month={month} selected={selected} onDay={onDay} rich={false} {...props} />)}
  </div>;
}

/** Week: seven columns when there is room, a day-by-day list when narrow (switched by a container query). */
export function WeekGrid({ days, base, periods, ...props }: GridProps & { days: readonly string[]; base: string; periods?: ReactNode }) {
  return <>
    <div className="cal-board week cal-wide-only"><WeekRow days={days} rich {...props} /></div>
    <div className="cal-narrow-only">{periods}<Agenda events={props.events} from={days[0]} to={days[days.length - 1]} timeZone={props.timeZone} today={props.today} onOpen={props.onOpen} base={base} includeEmpty /></div>
  </>;
}

/** Day-by-day list; periods show as start and end markers. */
export function Agenda({ events, from, to, timeZone, today, onOpen, base, includeEmpty = false, collapseBefore }: GridProps & {
  from: string; to: string; base: string; includeEmpty?: boolean; collapseBefore?: { hidden: boolean; toggle: () => void };
}) {
  const { l, lang } = useText();
  let days = agendaDays(events, from, to, timeZone, includeEmpty);
  if (!includeEmpty && today >= from && today <= to && !days.some(day => day.day === today)) days = [...days, { day: today, items: [] }].sort((a, b) => a.day.localeCompare(b.day));
  const earlier = collapseBefore ? days.filter(day => day.day < today) : [];
  const shown = collapseBefore?.hidden ? days.filter(day => day.day >= today) : days;
  return <div className="cal-agenda">
    {collapseBefore && earlier.length > 0 && <button type="button" className="vs-link-button cal-earlier" aria-expanded={!collapseBefore.hidden} onClick={collapseBefore.toggle}>
      {collapseBefore.hidden ? fill(l(t.earlier), { n: earlier.length }) : l(t.hideEarlier)}
    </button>}
    {shown.map(({ day, items }) => <section key={day} className={`cal-agenda-day${day === today ? ' today' : ''}${day < today ? ' past' : ''}`} aria-label={dayLabel(day, lang)}>
      <h3>{dayLabel(day, lang)}{day === today && <span className="cal-today-tag">{l(t.today)}</span>}</h3>
      {items.length ? <ul className="cal-rows">{items.map(item => <AgendaRow key={`${item.event.id}-${item.role}`} item={item} timeZone={timeZone} onOpen={onOpen} base={base} today={today} />)}</ul>
        : <p className="muted cal-nothing">{l(t.nothing)}</p>}
    </section>)}
  </div>;
}

/** The selected day's full list under the month grid. */
export function DayPanel({ day, events, timeZone, today, onOpen, base, onClose }: GridProps & { day: string; base: string; onClose: () => void }) {
  const { l, lang } = useText();
  const items = dayItems(events, day, timeZone);
  const ref = useRef<HTMLElement>(null);
  // On a phone the panel opens below the grid; bring it into view.
  useEffect(() => { ref.current?.scrollIntoView?.({ block: 'nearest' }); }, [day]);
  return <section ref={ref} className="cal-day-panel" aria-label={dayLabel(day, lang)}>
    <header><h3>{dayLabel(day, lang, true)}{day === today && <span className="cal-today-tag">{l(t.today)}</span>}<span className="vs-count"> · {items.length ? fill(l(t.items), { n: items.length }) : l(t.nothing)}</span></h3>
      <button type="button" className="vs-link-button" onClick={onClose}>{l(t.closeDay)}</button></header>
    {items.length > 0 && <ul className="cal-rows">{items.map(item => <AgendaRow key={`${item.event.id}-${item.role}`} item={item} timeZone={timeZone} onOpen={onOpen} base={base} today={today} />)}</ul>}
  </section>;
}

/** Plans, flights and promotions that overlap the range, as a compact list above the agenda. */
export function PeriodList({ periods, today, onOpen }: { periods: { event: CalendarEvent; span: Span }[]; today: string; onOpen: OpenEvent }) {
  const { l, lang } = useText();
  if (!periods.length) return null;
  return <section className="cal-periods" aria-label={l(t.running)}>
    <h3>{l(t.running)}</h3>
    <ul>{periods.map(({ event, span }) => {
      const running = periodProgress(span, today);
      return <li key={event.id} className={`cal-k-${event.kind}`}>
        <button type="button" className="cal-period" onClick={() => onOpen(event)}>
          <KindKey kind={event.kind} /><span className="cal-period-title">{event.title}</span>
          <small>{kindLabel(event.kind, lang)} · {shortDay(span.first, lang)} – {shortDay(span.last, lang)}{running ? ` · ${fill(l(t.dayOf), { d: running.day, n: running.days })}` : ''}</small>
        </button>
      </li>;
    })}</ul>
  </section>;
}
