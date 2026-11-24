import { useEffect, useId, useRef } from 'react';
import { ExternalLink, X } from 'lucide-react';
import { CopyButton, Glyph, type CalendarEvent, type Lang } from '@smartsell/ui';
import { RouterLink, resourcePath, useText } from '../parts';
import { decisionHref, eventSpan, periodProgress, safePermalink } from './calendar-logic';
import { KindKey, NeedsMark, OverdueTag, StatusTag, isAllDay } from './calendar-parts';
import { clock, dayLabel, fill, kindLabel, needsDetail, platformLabel, resourceLabel, shortDay, t } from './calendar-text';
import { PostDetail } from './post-detail';
import { hub } from '../hub-copy';

/** When an event happens, in the workspace zone: a day, a time, or a period with its length. */
export function whenText(event: CalendarEvent, lang: Lang, timeZone: string | undefined, today: string) {
  const span = eventSpan(event, timeZone);
  if (!span) return '';
  const pick = (text: readonly [string, string]) => text[lang === 'en' ? 1 : 0];
  const timed = !isAllDay(event) && clock(event.starts_at, lang, timeZone) !== '00:00';
  if (span.period) {
    const start = `${dayLabel(span.first, lang, true)}${timed ? ` ${clock(event.starts_at, lang, timeZone)}` : ''}`;
    const running = periodProgress(span, today);
    return [`${start} – ${dayLabel(span.last, lang, true)}`, fill(pick(t.daysTotal), { n: span.days }), running && fill(pick(t.dayOf), { d: running.day, n: running.days })].filter(Boolean).join(' · ');
  }
  return `${dayLabel(span.first, lang, true)} ${isAllDay(event) ? pick(t.allDay) : clock(event.starts_at, lang, timeZone)}`;
}

/** Detail drawer for one event (a modal dialog: Esc, the close button or the backdrop close it). */
export function EventDrawer({ event, timeZone, today, planName, base, onClose }: {
  event: CalendarEvent; timeZone?: string; today: string; planName?: string; base: string; onClose: () => void;
}) {
  const { l, lang } = useText();
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  const span = eventSpan(event, timeZone);
  const permalink = safePermalink(event.permalink);
  const platform = platformLabel(event.platform, lang);
  const related = resourcePath(base, event.resource);
  const relatedLink = related && !related.endsWith('/calendar') && !(event.campaign_id && related === `${base}/plans/${encodeURIComponent(event.campaign_id)}`) ? related : undefined;
  const planHref = event.campaign_id ? `${base}/plans/${encodeURIComponent(event.campaign_id)}` : undefined;
  const shortWhen = span ? `${shortDay(span.first, lang)}${span.period ? ` – ${shortDay(span.last, lang)}` : isAllDay(event) ? '' : ` ${clock(event.starts_at, lang, timeZone)}`}` : '';
  const prompt = fill(l(t.agentPrompt), { title: event.title, when: shortWhen });
  // Phase 1 publish events carry the post id (§9.7): the drawer shows the post itself instead of a prompt to copy (§9.5).
  const postId = event.kind === 'publish' ? (event as CalendarEvent & { post_id?: string }).post_id : undefined;
  return <dialog ref={ref} className="cal-drawer" aria-labelledby={titleId} onClose={onClose}
    onClick={click => { if (click.target === click.currentTarget) ref.current?.close(); }}>
    <div className="cal-drawer-body">
      <header className="cal-drawer-head">
        <span className={`cal-drawer-kind cal-k-${event.kind}`}><KindKey kind={event.kind} />{kindLabel(event.kind, lang)}</span>
        <button type="button" className="vs-icon-button" aria-label={l(t.close)} title={l(t.close)} onClick={() => ref.current?.close()}><X size={16} aria-hidden="true" /></button>
      </header>
      <h2 id={titleId}>{event.title}</h2>
      {event.needs_human && !postId && <div className="cal-drawer-needs" role="note">
        <NeedsMark event={event} />
        <p>{l(needsDetail(event.kind, event.needs_human))}</p>
        <RouterLink to={decisionHref(base, event)} className="vs-btn primary-soft">{l(t.goDecisions)}</RouterLink>
      </div>}
      <dl className="cal-facts">
        <div><dt>{l(t.time)}</dt><dd>{whenText(event, lang, timeZone, today)}<small className="muted"> · {l(t.timeZone)} {timeZone ?? 'UTC'}</small></dd></div>
        {event.status && <div><dt>{l(t.status)}</dt><dd className="cal-facts-tags"><StatusTag event={event} /><OverdueTag event={event} today={today} timeZone={timeZone} /></dd></div>}
        {platform && <div><dt>{l(t.platform)}</dt><dd>{platform}</dd></div>}
        {planHref && event.kind !== 'plan' && <div><dt>{l(t.plan)}</dt><dd><RouterLink to={planHref}>{planName ?? l(t.openPlan)}</RouterLink></dd></div>}
      </dl>
      {(permalink || relatedLink || (planHref && event.kind === 'plan')) && <div className="vs-actions cal-drawer-links">
        {permalink && <a className="vs-btn" href={permalink} target="_blank" rel="noreferrer noopener"><ExternalLink size={14} aria-hidden="true" />{l(t.permalink)}</a>}
        {planHref && event.kind === 'plan' && <RouterLink to={planHref} className="vs-btn">{l(t.openPlan)}</RouterLink>}
        {relatedLink && <RouterLink to={relatedLink} className="vs-btn">{resourceLabel(event.resource?.type, lang)}</RouterLink>}
      </div>}
      {postId ? <div className="cal-drawer-post">
        <PostDetail postId={postId} compact />
        <RouterLink to={`${base}/posts/${encodeURIComponent(postId)}`} className="vs-btn">{l(hub.post.openFull)}</RouterLink>
      </div> : <div className="cal-drawer-agent">
        <p className="muted"><Glyph name="bot" />{l(t.askAgent)}</p>
        <blockquote>{lang === 'en' ? `“${prompt}”` : `「${prompt}」`}</blockquote>
        <CopyButton text={prompt} />
      </div>}
      <p className="cal-drawer-source muted">{l(t.source)}{lang === 'en' ? ': ' : '：'}{resourceLabel(event.resource?.type, lang) || kindLabel(event.kind, lang)}{event.resource?.id && <code>{event.resource.id}</code>}</p>
    </div>
  </dialog>;
}
