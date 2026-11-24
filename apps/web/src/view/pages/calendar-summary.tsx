import { CopyButton, Glyph, type CalendarEvent } from '@smartsell/ui';
import { RouterLink, useText } from '../parts';
import { eventSpan, needsHumanKinds, type CalendarSummary } from './calendar-logic';
import { NeedsMark, StatusTag, isAllDay, type OpenEvent } from './calendar-parts';
import { clock, dayLabel, fill, needsText, platformLabel, t } from './calendar-text';

/** The page's answer first: what goes out next, what needs the person, and how full the period is. */
export function CalendarSummaryStrip({ summary, from, to, today, timeZone, base, onOpen }: {
  summary: CalendarSummary; from: string; to: string; today: string; timeZone?: string; base: string; onOpen: OpenEvent;
}) {
  const { l, lang } = useText();
  const past = to < today, future = from > today;
  const next = summary.next;
  const containsToday = from <= today && to >= today;
  return <div className="cal-summary">
    <section className="cal-tile next" aria-labelledby="cal-next-title">
      <h2 id="cal-next-title">{l(future ? t.firstTitle : t.nextTitle)}</h2>
      {next ? <NextPost event={next} timeZone={timeZone} onOpen={onOpen} />
        : <>
          <p className="cal-tile-empty">{l(past ? t.nextPast : t.nextNone)}</p>
          {!past && <div className="cal-mini-prompt"><span className="muted"><Glyph name="bot" size={13} />{lang === 'en' ? `“${l(t.nextPrompt)}”` : `「${l(t.nextPrompt)}」`}</span><CopyButton text={l(t.nextPrompt)} className="vs-btn ghost" /></div>}
        </>}
      {next && summary.upcoming > 1 && <p className="muted cal-tile-foot">{fill(l(t.moreUpcoming), { n: summary.upcoming - 1 })}</p>}
    </section>
    <section className={`cal-tile needs${summary.needs.total ? ' active' : ''}`} aria-labelledby="cal-needs-title">
      <h2 id="cal-needs-title">{l(t.needsTitle)}</h2>
      {summary.needs.total ? <>
        <strong className="cal-tile-number">{summary.needs.total}</strong>
        <ul className="cal-needs-list">{needsHumanKinds.filter(kind => summary.needs[kind] > 0).map(kind => <li key={kind}>
          <span className="cal-needs"><Glyph name="warning" size={12} />{l(needsText[kind])}</span><span className="vs-count">{summary.needs[kind]}</span>
        </li>)}</ul>
        <RouterLink to={base} className="vs-btn primary-soft">{l(['到今日處理', 'Handle on Today'])}</RouterLink>
      </> : <p className="cal-tile-empty"><Glyph name="check" size={14} />{l(t.needsNone)}</p>}
    </section>
    <section className="cal-tile range" aria-labelledby="cal-range-title">
      <h2 id="cal-range-title">{l(t.rangeTitle)}</h2>
      <dl className="cal-tile-counts">
        <div><dt>{l(t.scheduledCount)}</dt><dd>{summary.scheduled}</dd></div>
        <div><dt>{l(t.publishedCount)}</dt><dd>{summary.published}</dd></div>
        <div><dt>{l(t.periodsCount)}</dt><dd>{summary.periods}</dd></div>
      </dl>
      {containsToday && <p className="muted cal-tile-foot">{summary.today ? fill(l(t.todayCount), { n: summary.today }) : l(t.todayNone)}</p>}
    </section>
  </div>;
}

function NextPost({ event, timeZone, onOpen }: { event: CalendarEvent; timeZone?: string; onOpen: OpenEvent }) {
  const { l, lang } = useText();
  const span = eventSpan(event, timeZone);
  const when = span ? `${dayLabel(span.first, lang)} ${isAllDay(event) ? l(t.allDay) : clock(event.starts_at, lang, timeZone)}` : '';
  const platform = platformLabel(event.platform, lang);
  return <div className="cal-next">
    <button type="button" className="cal-next-title" onClick={() => onOpen(event)}>{event.title}</button>
    <p className="cal-next-when"><time dateTime={event.starts_at}>{when}</time>{platform && <span> · {platform}</span>}</p>
    <p className="cal-next-state"><StatusTag event={event} besideNeeds /><NeedsMark event={event} /></p>
  </div>;
}
