import { useState, useSyncExternalStore } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, CalendarDays, ChartNoAxesCombined, CircleDollarSign, Eye, ListChecks, MousePointerClick, Users } from 'lucide-react';
import { ActivityList, AgentPrompt, Glyph, KpiTile, LineChart, StatusChip, decisionKindText, formatDateTime, formatDay, isNum, pick, relativeTime, type Tuple } from '@smartsell/ui';
import { copy, fill } from '../copy';
import { useView, useViewContext } from '../data/use-view';
import type { HomeView, Kpi, LivePlan } from '../data/types';
import { Loaded, PageHeader, Section, resourcePath, useFilters, useText } from '../parts';

const primaryMetrics = {
  views: { page: 'social', icon: Eye },
  engagements: { page: 'social', icon: MousePointerClick },
  followers: { page: 'social', icon: Users },
  ad_spend: { page: 'ads', icon: CircleDollarSign },
};
const metricLabel = (key: string): Tuple => (copy.kpi as Record<string, Tuple>)[key] ?? [key, key];
const hasPoints = (kpi: Kpi) => kpi.sparkline?.some(point => isNum(point.value)) ?? false;
const hasCurrency = (kpi: Kpi) => kpi.unit !== 'currency' || Boolean(kpi.currency);
type OverviewLink = (section: string, filters?: Record<string, string>) => string;
const approvalStatuses = new Set(['approval', 'awaiting_approval', 'pending_approval']);

// Match the grid breakpoint so DOM, reading and keyboard order follow the layout.
const narrowFocus = '(width < 1120px)';
function subscribeToFocusWidth(notify: () => void) {
  const query = window.matchMedia(narrowFocus);
  query.addEventListener('change', notify);
  return () => query.removeEventListener('change', notify);
}
const isFocusNarrow = () => window.matchMedia(narrowFocus).matches;

function KpiGrid({ kpis, range, link }: { kpis: Kpi[]; range: HomeView['period']; link: OverviewLink }) {
  const { l, lang } = useText();
  const available = Object.entries(primaryMetrics).flatMap(([key, config]) => {
    const kpi = kpis.find(item => item.key === key);
    return kpi ? [{ kpi, ...config }] : [];
  });
  const date = (day: string) => formatDay(day, lang, { year: 'numeric', month: 'short', day: 'numeric' });
  return <section className="vs-overview-kpis">
    <header className="vs-overview-kpi-head"><h2>{l(copy.overview.kpis)}</h2>
      {range && <span className="vs-overview-period"><CalendarDays size={14} aria-hidden="true" /><time dateTime={range.from}>{date(range.from)}</time> – <time dateTime={range.to}>{date(range.to)}</time></span>}
    </header>
    {available.length ? <div className="vs-kpi-grid">{available.map(({ kpi, page, icon: Icon }) => <KpiTile key={kpi.key}
      label={l(metricLabel(kpi.key))} metric={kpi} icon={<Icon size={17} aria-hidden="true" />}
      unit={kpi.unit} currency={kpi.currency} goodDirection={kpi.key === 'ad_spend' ? 'none' : 'up'}
      href={link(page, { ...range, ...(kpi.key === 'engagements' ? { metric: kpi.key } : {}) })} />)}</div>
      : <p className="vs-notice muted">{l(copy.overview.noMetrics)}</p>}
  </section>;
}

function DailyTrend({ kpis, adsHref }: { kpis: Kpi[]; adsHref: string }) {
  const { l } = useText();
  const [metric, setMetric] = useState('');
  const selected = kpis.find(kpi => kpi.key === metric)
    ?? kpis.find(kpi => hasPoints(kpi) && hasCurrency(kpi)) ?? kpis.find(hasPoints) ?? kpis[0];
  const heading = l(copy.overview.trend);
  const unit = selected?.unit === 'currency' ? selected.currency ?? undefined : selected?.unit === 'count' ? l(copy.overview.countUnit) : '%';
  const label = selected && l(metricLabel(selected.key));
  const supplementary = kpis.filter(kpi => !Object.hasOwn(primaryMetrics, kpi.key));
  return <Section title={<><ChartNoAxesCombined size={17} aria-hidden="true" />{heading}</>} className="vs-overview-trend"
    action={selected && <label className="vs-select"><span className="vs-sr">{heading}</span>
      <select value={selected.key} onChange={event => setMetric(event.target.value)}>
        {kpis.map(kpi => <option key={kpi.key} value={kpi.key}>{l(metricLabel(kpi.key))}</option>)}
      </select></label>}>
    {selected && label ? <>
      <p className="vs-trend-unit">{label}{unit && <> · {unit}</>}</p>
      {!hasCurrency(selected) && hasPoints(selected) ? <div className="vs-overview-quiet vs-trend-unavailable">
        <p className="muted">{l(copy.overview.spendByCurrency)}</p><Link to={adsHref}>{l(copy.nav.ads)} <ArrowUpRight size={13} aria-hidden="true" /></Link>
      </div> : <LineChart key={selected.key} title={`${heading} · ${label}${unit ? ` (${unit})` : ''}`} height={236}
        series={[{ key: selected.key, label, points: selected.sparkline ?? [] }]} unit={selected.unit} currency={selected.currency} />}
    </> : <p className="vs-overview-quiet muted">{l(copy.overview.noMetrics)}</p>}
    {supplementary.length > 0 && <div className="vs-overview-extra">{supplementary.map(kpi => <KpiTile key={kpi.key} label={l(metricLabel(kpi.key))} metric={kpi}
      unit={kpi.unit} currency={kpi.currency} />)}</div>}
  </Section>;
}

function Count({ label, value, tone }: { label: Tuple; value: number | null | undefined; tone?: string }) {
  const { l } = useText();
  return <div className={`vs-count-tile${tone && isNum(value) && value > 0 ? ` tone-${tone}` : ''}`}><strong>{isNum(value) ? value : '—'}</strong><span>{l(label)}</span></div>;
}

function PlanRow({ plan }: { plan: LivePlan }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const ratio = plan.completeness_ratio;
  return <li className="vs-plan-row">
    <div className="vs-row-head"><Link to={`${base}/plans/${encodeURIComponent(plan.id)}`}>{plan.name}</Link><StatusChip status={plan.status} /></div>
    <small className="muted">{plan.starts_at ? formatDay(plan.starts_at.slice(0, 10), lang) : '—'} – {plan.ends_at ? formatDay(plan.ends_at.slice(0, 10), lang) : '—'}
      {isNum(plan.days_left) && <> · {plan.days_left > 0 ? fill(l(copy.common.daysLeft), { n: plan.days_left }) : l(copy.common.ended)}</>}</small>
    {isNum(ratio) ? <div className="vs-meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)} aria-label={l(copy.overview.completeness)}>
      <span style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%` }} /></div> : <small className="muted">{l(copy.overview.completenessUnknown)}</small>}
    {isNum(plan.planned) && isNum(plan.published) && <small className="muted">{fill(l(copy.overview.publishedOfPlanned), { a: plan.published, b: plan.planned })}</small>}
  </li>;
}

export function OverviewPage() {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const { brandId, from, to } = useFilters(7);
  const read = useView<HomeView>('/views/home', { brand_id: brandId, from, to });
  const narrow = useSyncExternalStore(subscribeToFocusWidth, isFocusNarrow, () => false);
  function link(section: string, filters: Record<string, string> = {}) {
    const query = new URLSearchParams({ ...(brandId ? { brand: brandId } : {}), ...filters }).toString();
    return `${base}/${section}${query ? `?${query}` : ''}`;
  }
  return <>
    <PageHeader title={l(copy.overview.title)} asOf={read.isPending ? undefined : read.asOf ?? null} timeZone={read.value?.timezone} />
    <Loaded read={read}>{home => {
      const tz = home.timezone;
      const needs = home.needs_you;
      const week = home.this_week;
      const agent = home.agent;
      const kpis = home.kpis ?? [];
      const range = home.period ?? (from && to ? { from, to } : undefined);
      const trend = <DailyTrend key="trend" kpis={kpis} adsHref={link('ads', range)} />;
      const decisions = <Section key="decisions" title={<><ListChecks size={17} aria-hidden="true" />{l(copy.overview.needsYou)}{needs && needs.total > 0 && <span className="vs-badge">{needs.total}</span>}</>}
        action={needs && needs.total > 0 ? <Link to={link('decisions')}>{l(copy.common.viewAll)}</Link> : undefined} className="vs-overview-decisions">
        {!needs ? <p className="vs-overview-quiet muted">{l(copy.common.unknown)}</p> : needs.items.length === 0
          ? <p className="vs-overview-quiet vs-all-clear"><Glyph name="check" />{l(copy.overview.nothingToDecide)}</p>
          : <ul className="vs-needs-list">{needs.items.slice(0, 5).map(item => <li key={item.id}>
            <div className="vs-needs-main"><strong>{item.title}</strong>
              <small>{[pick(decisionKindText[item.kind] ?? [item.kind, item.kind], lang), item.requested_by?.type === 'agent' ? item.requested_by.label ?? 'Agent' : null,
                item.due_at ? `${l(['期限', 'Due'])} ${formatDateTime(item.due_at, lang, tz)}` : null].filter(Boolean).join(' · ')}</small>
              {item.severity !== 'normal' && <StatusChip status={item.severity} />}
            </div>
            <Link className="vs-btn primary-soft" to={link('decisions', { kind: item.kind })} aria-label={`${l(['去決定', 'Decide', '去决定'])} · ${item.title}`}>
              {l(['去決定', 'Decide', '去决定'])}<ArrowUpRight size={13} aria-hidden="true" />
            </Link>
          </li>)}</ul>}
      </Section>;
      return <div className="vs-overview">
        <KpiGrid kpis={kpis} range={range} link={link} />
        <div className="vs-overview-focus">{narrow ? [decisions, trend] : [trend, decisions]}</div>
        <Section title={l(copy.overview.thisWeek)} action={<Link to={link('calendar')}>{l(copy.nav.calendar)}</Link>}>
          {week ? <>
            <div className="vs-count-row">
              <Count label={copy.overview.scheduled} value={week.scheduled} /><Count label={copy.overview.published} value={week.published} />
              <Count label={copy.overview.failed} value={week.failed} tone="critical" /><Count label={copy.overview.outcomeUnknown} value={week.outcome_unknown} tone="serious" />
            </div>
            {week.upcoming.length ? <ul className="vs-list">{week.upcoming.slice(0, 8).map(event => <li key={event.id}>
              <time className="vs-when">{formatDateTime(event.starts_at, lang, tz)}</time>
              <span className="vs-grow">{event.platform && <small className="muted">{event.platform} · </small>}{event.title}</span>
              {event.needs_human && !(event.needs_human === 'approval' && approvalStatuses.has(event.status ?? '')) &&
                <StatusChip status={event.needs_human} tone="warning" />}
              {event.status && <StatusChip status={event.status} />}
            </li>)}</ul> : <AgentPrompt title={l(copy.overview.noUpcoming)} prompt={l(copy.overview.noUpcomingPrompt)} agentHref={`${base}/agent`} />}
          </> : <p className="muted">{l(copy.common.unknown)}</p>}
        </Section>
        <Section title={l(copy.overview.livePlans)} action={<Link to={link('plans')}>{l(copy.nav.plans)}</Link>}>
          {home.live_plans?.length ? <ul className="vs-list vs-plans">{home.live_plans.map(plan => <PlanRow key={plan.id} plan={plan} />)}</ul>
            : <AgentPrompt title={l(copy.overview.noPlans)} prompt={l(copy.overview.noPlansPrompt)} agentHref={`${base}/agent`} />}
        </Section>
        <Section title={l(copy.overview.agentRecent)} action={<Link to={`${base}/agent`}>{l(copy.common.viewAll)}</Link>}>
          {!agent ? <p className="muted">{l(copy.common.unknown)}</p> : agent.connections === 0 ? <div className="vs-prompt">
            <strong className="vs-prompt-title">{l(copy.overview.connectAgent)}</strong><p className="muted">{l(copy.overview.connectAgentDetail)}</p>
            <div className="vs-actions"><Link className="vs-btn primary-soft" to={`${base}/agent`}>{l(copy.agent.connect)}</Link></div>
          </div> : <>
            <p className="muted"><small>{l(copy.overview.lastSeen)}: {agent.last_seen_at ? relativeTime(agent.last_seen_at, lang) : l(copy.overview.neverSeen)}</small></p>
            {agent.recent.length ? <ActivityList items={agent.recent} timeZone={tz} resourceHref={item => resourcePath(base, item.resource)} /> : <p className="muted">{l(copy.overview.noActivity)}</p>}
          </>}
        </Section>
        <Section title={l(copy.overview.alerts)}>
          {home.alerts?.length ? <ul className="vs-list">{home.alerts.map((alert, index) => {
            const href = resourcePath(base, alert.resource);
            return <li key={`${alert.kind}-${index}`}><StatusChip status={alert.severity} /><span className="vs-grow">{href ? <Link to={href}>{alert.title}</Link> : alert.title}</span></li>;
          })}</ul> : home.alerts ? <p className="vs-all-clear"><Glyph name="check" />{l(copy.overview.noAlerts)}</p> : <p className="muted">{l(copy.common.unknown)}</p>}
        </Section>
      </div>;
    }}</Loaded>
  </>;
}
