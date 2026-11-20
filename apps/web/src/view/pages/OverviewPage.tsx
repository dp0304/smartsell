import { Link } from 'react-router-dom';
import { ActivityList, AgentPrompt, Glyph, KpiTile, StatusChip, decisionKindText, formatDateTime, formatDay, isNum, pick, relativeTime, type Tuple } from '@smartsell/ui';
import { copy, fill } from '../copy';
import { useView, useViewContext } from '../data/use-view';
import type { HomeView, Kpi, LivePlan } from '../data/types';
import { Loaded, PageHeader, Section, resourcePath, useFilters, useText } from '../parts';

const kpiLink: Record<string, string> = { views: 'social', engagements: 'social', followers: 'social', ad_spend: 'ads' };

function KpiGrid({ kpis }: { kpis: Kpi[] }) {
  const { l } = useText();
  const { base } = useViewContext();
  return <div className="vs-kpi-grid">{kpis.map(kpi => <KpiTile key={kpi.key} label={l((copy.kpi as Record<string, Tuple>)[kpi.key] ?? [kpi.key, kpi.key])} metric={kpi}
    unit={kpi.unit} currency={kpi.currency} sparkline={kpi.sparkline} goodDirection={kpi.key === 'ad_spend' ? 'none' : 'up'}
    href={kpiLink[kpi.key] ? `${base}/${kpiLink[kpi.key]}` : undefined} />)}</div>;
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
  return <>
    <PageHeader title={l(copy.overview.title)} asOf={read.isPending ? undefined : read.asOf ?? null} timeZone={read.value?.timezone} />
    <Loaded read={read}>{home => {
      const tz = home.timezone;
      const needs = home.needs_you;
      const week = home.this_week;
      const agent = home.agent;
      return <div className="vs-overview">
        <Section title={<>{l(copy.overview.needsYou)}{needs && isNum(needs.total) && needs.total > 0 && <span className="vs-badge">{needs.total}</span>}</>}
          action={needs && needs.total > 0 ? <Link to={`${base}/decisions`}>{l(copy.common.viewAll)}</Link> : undefined} className="vs-span-2">
          {!needs ? <p className="muted">{l(copy.common.unknown)}</p> : needs.items.length === 0
            ? <p className="vs-all-clear"><Glyph name="check" />{l(copy.overview.nothingToDecide)}</p>
            : <ul className="vs-needs-list">{needs.items.slice(0, 5).map(item => <li key={item.id} className={`severity-${item.severity}`}>
              <span className="vs-decision-kind">{pick(decisionKindText[item.kind] ?? [item.kind, item.kind], lang)}</span>
              <span className="vs-needs-main"><strong>{item.title}</strong>
                <small>{[item.requested_by?.type === 'agent' ? item.requested_by.label ?? 'Agent' : null, item.due_at ? `${l(['期限', 'Due'])} ${formatDateTime(item.due_at, lang, tz)}` : null].filter(Boolean).join(' · ')}</small></span>
              <Link className="vs-btn primary-soft" to={`${base}/decisions?kind=${encodeURIComponent(item.kind)}`}>{l(['去決定', 'Decide'])}</Link>
            </li>)}</ul>}
        </Section>
        {home.kpis && home.kpis.length > 0 && <Section title={l(copy.overview.kpis)} className="vs-span-2"><KpiGrid kpis={home.kpis} /></Section>}
        <Section title={l(copy.overview.thisWeek)} action={<Link to={`${base}/calendar`}>{l(copy.nav.calendar)}</Link>}>
          {week ? <>
            <div className="vs-count-row">
              <Count label={copy.overview.scheduled} value={week.scheduled} /><Count label={copy.overview.published} value={week.published} />
              <Count label={copy.overview.failed} value={week.failed} tone="critical" /><Count label={copy.overview.outcomeUnknown} value={week.outcome_unknown} tone="serious" />
            </div>
            {week.upcoming.length ? <ul className="vs-list">{week.upcoming.slice(0, 8).map(event => <li key={event.id}>
              <time className="vs-when">{formatDateTime(event.starts_at, lang, tz)}</time>
              <span className="vs-grow">{event.platform && <small className="muted">{event.platform} · </small>}{event.title}</span>
              {event.needs_human && <StatusChip status={event.needs_human} tone="warning" />}{event.status && <StatusChip status={event.status} />}
            </li>)}</ul> : <AgentPrompt title={l(copy.overview.noUpcoming)} prompt={l(copy.overview.noUpcomingPrompt)} agentHref={`${base}/agent`} />}
          </> : <p className="muted">{l(copy.common.unknown)}</p>}
        </Section>
        <Section title={l(copy.overview.livePlans)} action={<Link to={`${base}/plans`}>{l(copy.nav.plans)}</Link>}>
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
