import { Lock } from 'lucide-react';
import { Glyph, isDay, type CalendarEvent, type Lang } from '@smartsell/ui';
import { RouterLink, useText } from '../parts';
import { calendarKinds, decisionHref, isOverdue, periodProgress, type AgendaItem, type AgendaRole, type DayItem, type DayRole } from './calendar-logic';
import { clock, eventStatus, fill, kindLabel, needsText, platformLabel, shortDay, t } from './calendar-text';

export type OpenEvent = (event: CalendarEvent) => void;

/** The kind's legend colour; plan periods are a neutral dashed band. */
export const KindKey = ({ kind }: { kind: string }) => <i className={`cal-key cal-k-${kind}`} aria-hidden="true" />;

export const isAllDay = (event: CalendarEvent) => Boolean(event.all_day) || isDay(event.starts_at);
const alarming = (event: CalendarEvent) => event.status === 'failed';

/** Full spoken name of an event: kind, time, title, status and whether it needs the person. */
export function eventName(event: CalendarEvent, lang: Lang, timeZone?: string, role?: AgendaRole) {
  const time = isAllDay(event) ? '' : clock(event.starts_at, lang, timeZone);
  const status = eventStatus(event.kind, event.status, lang);
  const marker = role === 'start' ? t.starts : role === 'end' ? t.ends : null;
  const needs = event.needs_human ? (needsText[event.needs_human] ?? t.needsMarker)[lang === 'en' ? 1 : 0] : null;
  return [kindLabel(event.kind, lang), marker && marker[lang === 'en' ? 1 : 0], time, event.title, platformLabel(event.platform, lang), status?.label,
    needs !== status?.label && needs].filter(Boolean).join(' · ');
}

/** The event's status chip; next to a needs-you marker that says the same thing it steps aside. */
export function StatusTag({ event, besideNeeds = false }: { event: CalendarEvent; besideNeeds?: boolean }) {
  const { lang } = useText();
  const status = eventStatus(event.kind, event.status, lang);
  if (!status) return null;
  if (besideNeeds && event.needs_human && needsText[event.needs_human]?.[lang === 'en' ? 1 : 0] === status.label) return null;
  const glyph = { good: 'check', warning: 'warning', serious: 'serious', critical: 'critical', neutral: 'neutral', info: 'info' }[status.tone];
  return <span className={`vs-chip tone-${status.tone}`} data-status={event.status ?? undefined}><Glyph name={glyph} size={12} />{status.label}</span>;
}

/** A publication still waiting after its time; words plus an icon, never colour alone. */
export function OverdueTag({ event, today, timeZone }: { event: CalendarEvent; today: string; timeZone?: string }) {
  const { l } = useText();
  if (!isOverdue(event, new Date(), today, timeZone)) return null;
  return <span className="vs-chip tone-serious" title={l(t.overdueDetail)}><Glyph name="serious" size={12} />{l(t.overdue)}</span>;
}

/** 待審批／待決定／結果待核實 with an icon; as a link it goes to the matching decisions. */
export function NeedsMark({ event, base, compact = false }: { event: CalendarEvent; base?: string; compact?: boolean }) {
  const { l } = useText();
  if (!event.needs_human) return null;
  const label = l(needsText[event.needs_human] ?? t.needsMarker);
  const body = <><Glyph name="warning" size={12} />{compact ? <span className="vs-sr">{label}</span> : label}</>;
  if (base) return <RouterLink to={decisionHref(base, event)} className="cal-needs" title={label}>{body}</RouterLink>;
  return <span className="cal-needs" title={label}>{body}</span>;
}

/** One event as a compact chip inside a calendar cell; it opens the detail drawer. */
export function EventChip({ event, timeZone, onOpen, rich = false }: { event: CalendarEvent; timeZone?: string; onOpen: OpenEvent; rich?: boolean }) {
  const { lang } = useText();
  const time = isAllDay(event) ? '' : clock(event.starts_at, lang, timeZone);
  const platform = platformLabel(event.platform, lang);
  const status = eventStatus(event.kind, event.status, lang);
  return <button type="button" className={`cal-chip cal-k-${event.kind}${event.needs_human ? ' needs' : ''}${alarming(event) ? ' failed' : ''}`}
    aria-label={eventName(event, lang, timeZone)} title={eventName(event, lang, timeZone)} onClick={() => onOpen(event)}>
    <KindKey kind={event.kind} />
    {event.needs_human && <span className="cal-flag warn"><Glyph name="warning" size={11} /></span>}
    {alarming(event) && <span className="cal-flag bad"><Glyph name="critical" size={11} /></span>}
    {time && <time>{time}</time>}
    <span className="cal-chip-title">{event.title}</span>
    {rich && (platform || status) && <small className="cal-chip-meta">{[platform, status?.label].filter(Boolean).join(' · ')}</small>}
  </button>;
}

const roleText: Record<DayRole, readonly [string, string] | null> = { start: t.starts, end: t.ends, single: t.oneDay, during: t.continues, point: null };
/** One row of the agenda (list view, narrow week, day panel). */
export function AgendaRow({ item, timeZone, onOpen, base, today }: { item: AgendaItem | DayItem; timeZone?: string; onOpen: OpenEvent; base: string; today?: string }) {
  const { l, lang } = useText();
  const { event, role, span } = item;
  const marker = roleText[role];
  const when = role === 'point' ? (isAllDay(event) ? l(t.allDay) : clock(event.starts_at, lang, timeZone)) : l(marker!);
  const platform = platformLabel(event.platform, lang);
  const running = span.period && today ? periodProgress(span, today) : null;
  const progress = running && fill(l(t.dayOf), { d: running.day, n: running.days });
  return <li className={`cal-row cal-k-${event.kind}${role !== 'point' ? ' period' : ''}`}>
    <span className="cal-row-when">{when}</span>
    <span className="cal-row-main">
      <button type="button" className="cal-row-title" onClick={() => onOpen(event)} aria-label={eventName(event, lang, timeZone, role === 'during' ? undefined : role)}>
        <KindKey kind={event.kind} /><span>{event.title}</span>
      </button>
      <span className="cal-row-meta">
        <span>{kindLabel(event.kind, lang)}</span>
        {platform && <span>{platform}</span>}
        {span.period && <span>{shortDay(span.first, lang)} – {shortDay(span.last, lang)}</span>}
        {progress && <span>{progress}</span>}
      </span>
    </span>
    <span className="cal-row-state"><StatusTag event={event} besideNeeds />{today && <OverdueTag event={event} today={today} timeZone={timeZone} />}<NeedsMark event={event} base={base} /></span>
  </li>;
}

export interface KindSource { kind: string; availability: string }
/** Toggle chips that double as the colour legend; kinds the role cannot read are shown locked, never as zero. */
export function KindFilter({ shown, counts, sources, onToggle, onAll }: {
  shown: Set<string> | null; counts?: Record<string, number>; sources: readonly KindSource[]; onToggle: (kind: string) => void; onAll: () => void;
}) {
  const { l, lang } = useText();
  const locked = new Set(sources.filter(source => source.availability === 'no_permission').map(source => source.kind));
  const filtered = shown !== null && calendarKinds.some(kind => !locked.has(kind) && !shown.has(kind));
  return <div className="cal-kinds" role="group" aria-label={l(t.kinds)}>
    {calendarKinds.map(kind => {
      if (locked.has(kind)) return <span key={kind} className={`cal-kind locked cal-k-${kind}`} title={l(t.noPermission)}>
        <KindKey kind={kind} />{kindLabel(kind, lang)}<Lock size={12} aria-hidden="true" /><span className="cal-kind-count">{l(t.noPermission)}</span>
      </span>;
      const on = shown === null || shown.has(kind);
      const count = counts ? counts[kind] ?? 0 : undefined;
      return <button key={kind} type="button" className={`cal-kind cal-k-${kind}${count === 0 ? ' empty' : ''}`} aria-pressed={on} onClick={() => onToggle(kind)}>
        <KindKey kind={kind} />{kindLabel(kind, lang)}{count !== undefined && <span className="cal-kind-count">{count}</span>}
      </button>;
    })}
    {filtered && <button type="button" className="cal-kind reset" onClick={onAll}>{l(t.showAll)}</button>}
  </div>;
}
