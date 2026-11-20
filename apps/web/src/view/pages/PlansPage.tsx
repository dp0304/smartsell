import { Link, useSearchParams } from 'react-router-dom';
import { ActorBadge, AgentPrompt, Glyph, StatusChip, Timeline, addDays, formatMinor, isNum, type TimelineLane, type Tuple } from '@smartsell/ui';
import { copy, fill } from '../copy';
import { todayIn } from '../data/period';
import { useView, useViewContext, workspaceZone } from '../data/use-view';
import { Loaded, PageHeader, Section, useFilters, useText } from '../parts';
import { planCopy as pc } from './plans-copy';
import {
  budgetTotals, dayProgress, ganttWindow, isPhase, matrixParts, phaseCounts, phases, planPhase, planSpan, sortPlans, spanVisible,
  type Phase, type PlanCardView,
} from './plans-logic';
import './plans.css';
import { BudgetBlock, CompletenessBar, GoalList, NeedsDecision, NextPublication, ProductChips, percentText, progressText, spanText } from './plans-parts';

const planHref = (base: string, id: string) => `${base}/plans/${encodeURIComponent(id)}`;
const RECENT_DAYS = 45;
const decisionsHref = (base: string, id: string) => `${base}/decisions?campaign=${encodeURIComponent(id)}`;

/** The page's answer in four tiles: what runs, what waits for you, how complete, what it has cost. */
function PlansSummary({ plans, counts, now }: { plans: PlanCardView[]; counts: Record<Phase, number>; now: number }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const live = plans.filter(plan => planPhase(plan, now) === 'live');
  const decisions = plans.reduce((sum, plan) => sum + (isNum(plan.needs_decision) ? plan.needs_decision : 0), 0);
  const content = live.reduce((sum, plan) => {
    const parts = matrixParts(plan.matrix);
    return { planned: sum.planned + parts.planned, filled: sum.filled + parts.filled };
  }, { planned: 0, filled: 0 });
  const money = budgetTotals(live);
  return <div className="pl-summary">
    <div className="pl-stat"><span className="pl-stat-label">{l(pc.summaryLive)}</span><strong className="pl-stat-value">{counts.live}</strong>
      <small className="muted">{l(pc.summaryUpcoming)} {counts.upcoming}</small></div>
    <div className={`pl-stat${decisions > 0 ? ' attention' : ''}`}><span className="pl-stat-label">{l(pc.summaryDecisions)}</span>
      <strong className="pl-stat-value">{decisions > 0 && <Glyph name="warning" size={18} />}{decisions}</strong>
      {decisions > 0 ? <Link to={`${base}/decisions`}>{l(copy.common.viewAll)}</Link> : <small className="muted">{l(copy.overview.nothingToDecide)}</small>}</div>
    <div className="pl-stat"><span className="pl-stat-label">{l(pc.completeness)} · {l(pc.summaryLive)}</span>
      {content.planned > 0 ? <><strong className="pl-stat-value">{percentText(content.filled / content.planned, lang)}</strong>
        <small className="muted">{fill(l(pc.filledOf), { a: content.filled, b: content.planned })}</small></>
        : <><strong className="pl-stat-value unknown">—</strong><small className="muted">{l(pc.nothingPlanned)}</small></>}</div>
    <div className="pl-stat"><span className="pl-stat-label">{l(pc.summarySpend)}</span>
      {money.currencies.length ? money.currencies.slice(0, 2).map(total => <span key={total.currency} className="pl-stat-money">
        <strong className="pl-stat-value">{formatMinor(total.spent, total.currency, lang, true)}</strong>
        <small className="muted">{fill(l(pc.ofBudget), { b: formatMinor(total.budget, total.currency, lang, true) ?? '—' })}</small>
        {total.overrun > 0 && <span className="pl-flag tone-critical"><Glyph name="critical" size={12} />{fill(l(pc.overrun), { a: formatMinor(total.overrun, total.currency, lang, true) ?? '' })}</span>}
      </span>) : <><strong className="pl-stat-value unknown">—</strong><small className="muted">{money.hidden ? l(pc.budgetHidden) : l(pc.noBudget)}</small></>}
      {money.currencies.length > 0 && money.hidden > 0 && <small className="muted">{l(pc.budgetHiddenSome)}</small>}
    </div>
  </div>;
}

/** Plans on one gantt; with no status filter, long-finished plans stay off it so the bars keep their width. */
function PlansGantt({ plans, zone, today, recentOnly }: { plans: PlanCardView[]; zone?: string; today: string; recentOnly: boolean }) {
  const { l } = useText();
  const { base } = useViewContext();
  const now = Date.now();
  const dated = plans.flatMap(plan => { const span = planSpan(plan, plan.timezone ?? zone); return span ? [{ plan, span }] : []; });
  const cutoff = addDays(today, -RECENT_DAYS);
  const older = recentOnly ? dated.filter(({ plan, span }) => planPhase(plan, now) === 'ended' && (span.end ?? span.start) < cutoff) : [];
  const shown = dated.filter(entry => !older.includes(entry));
  const range = ganttWindow(shown.map(entry => entry.span), today);
  const visible = range ? shown.filter(entry => spanVisible(entry.span, range)) : [];
  const notes = [plans.length - dated.length > 0 ? fill(l(pc.undated), { n: plans.length - dated.length }) : '',
    older.length ? fill(l(pc.olderEnded), { n: older.length }) : '', shown.length - visible.length > 0 ? fill(l(pc.outside), { n: shown.length - visible.length }) : ''].filter(Boolean);
  if (!range || !visible.length) return notes.length ? <p className="pl-note">{notes.join(' · ')}</p> : null;
  const lanes: TimelineLane[] = visible.map(({ plan, span }) => {
    const tz = plan.timezone ?? zone;
    const label = progressText(dayProgress(plan, todayIn(tz), tz, now), l);
    return { id: plan.id, label: plan.name ?? '—', href: planHref(base, plan.id),
      items: [{ id: plan.id, label, start: span.start, end: span.end, status: plan.status, href: planHref(base, plan.id) }] };
  });
  return <Section title={l(pc.gantt)}>
    <Timeline lanes={lanes} from={range.from} to={range.to} today={today} />
    {notes.length > 0 && <p className="pl-note">{notes.join(' · ')}</p>}
  </Section>;
}

/** One quiet line for what a plan still lacks, instead of an empty block per topic. */
function missingParts(plan: PlanCardView, l: (value: Tuple) => string) {
  return [plan.goals && !plan.goals.length ? l(pc.goals) : '', Array.isArray(plan.budget) && !plan.budget.length ? l(pc.budget) : '',
    plan.products && !plan.products.length ? l(pc.products) : ''].filter(Boolean);
}

function PlanCardItem({ plan, zone }: { plan: PlanCardView; zone?: string }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const tz = plan.timezone ?? zone;
  const today = todayIn(tz);
  const now = Date.now();
  const span = planSpan(plan, tz);
  const progress = dayProgress(plan, today, tz, now);
  const phase = planPhase(plan, now);
  const missing = missingParts(plan, l);
  return <li className="vs-card pl-card">
    <div className="pl-card-head">
      <Link to={planHref(base, plan.id)} className="pl-card-title">{plan.name ?? '—'}</Link>
      <StatusChip status={plan.status} />
    </div>
    <p className="pl-card-meta">
      {span && <span>{spanText(span, lang, today)}</span>}
      <strong>{progressText(progress, l)}</strong>
      {plan.created_via === 'agent' && <span title={l(pc.byAgent)}><ActorBadge type="agent" /></span>}
    </p>
    <NeedsDecision count={plan.needs_decision} href={decisionsHref(base, plan.id)} />
    <CompletenessBar matrix={plan.matrix} />
    {plan.goals && plan.goals.length > 0 && <div className="pl-block"><span className="pl-label">{l(pc.goals)}</span><GoalList goals={plan.goals} max={2} /></div>}
    {!(Array.isArray(plan.budget) && !plan.budget.length) && <BudgetBlock budget={plan.budget} />}
    {plan.products && plan.products.length > 0 && <ProductChips products={plan.products} base={base} />}
    {(plan.next_publication || phase === 'live') && <NextPublication next={plan.next_publication} timeZone={tz} />}
    {missing.length > 0 && <p className="pl-note">{fill(l(pc.notSetYet), { list: missing.join(l(pc.listJoin)) })}</p>}
  </li>;
}

export function PlansPage() {
  const { l } = useText();
  const { ws, base } = useViewContext();
  const { brandId } = useFilters();
  const [params, setParams] = useSearchParams();
  const raw = params.get('status');
  const phase: Phase | '' = isPhase(raw) ? raw : '';
  const read = useView<PlanCardView[]>('/views/plans', { brand_id: brandId }, { allPages: true });
  const choose = (next: Phase | '') => {
    const query = new URLSearchParams(params);
    if (next) query.set('status', next); else query.delete('status');
    setParams(query, { replace: true });
  };
  return <>
    <PageHeader title={l(copy.pages.plansTitle)} subtitle={l(pc.listSubtitle)} asOf={read.isPending ? undefined : read.asOf ?? null} />
    <Loaded read={read}>{items => {
      const all = Array.isArray(items) ? items : [];
      if (!all.length) return <AgentPrompt title={l(copy.pages.plansEmpty)} prompt={l(copy.pages.plansPrompt)} agentHref={`${base}/agent`} />;
      // A list response carries no workspace zone; a plan's own zone is the next best "today".
      const zone = workspaceZone(ws) ?? all.find(plan => plan.timezone)?.timezone ?? undefined;
      const now = Date.now();
      const counts = phaseCounts(all, now);
      const sorted = sortPlans(all, now);
      const shown = phase ? sorted.filter(plan => planPhase(plan, now) === phase) : sorted;
      return <div className="pl-page">
        <PlansSummary plans={all} counts={counts} now={now} />
        {read.nextCursor && <p className="vs-notice">{l(copy.common.more)}</p>}
        <div className="vs-filter-row" role="group" aria-label={l(pc.phaseFilter)}>
          <button type="button" aria-pressed={!phase} onClick={() => choose('')}>{l(pc.all)}<span className="vs-count"> {all.length}</span></button>
          {phases.map(key => <button key={key} type="button" aria-pressed={phase === key} onClick={() => choose(key)}>
            {l(pc.phase[key])}<span className="vs-count"> {counts[key]}</span></button>)}
        </div>
        {shown.length ? <>
          <PlansGantt plans={shown} zone={zone} today={todayIn(zone)} recentOnly={!phase} />
          <ul className="pl-grid">{shown.map(plan => <PlanCardItem key={plan.id} plan={plan} zone={zone} />)}</ul>
        </> : <div className="vs-card pl-empty">
          <p className="muted">{l(pc.noneInPhase)}</p>
          {(phase === 'live' || phase === 'upcoming') && <AgentPrompt title={l(copy.pages.plansEmpty)} prompt={l(copy.pages.plansPrompt)} agentHref={`${base}/agent`} />}
        </div>}
      </div>;
    }}</Loaded>
  </>;
}
