import { Link, useParams } from 'react-router-dom';
import { ApiError } from '@smartsell/sdk';
import { ActorBadge, Glyph, StatusChip, formatMinor, isNum, type DecisionItem } from '@smartsell/ui';
import { copy, fill } from '../copy';
import { todayIn } from '../data/period';
import { useView, useViewContext, workspaceZone, type ViewResult } from '../data/use-view';
import { DecisionEntry, Loaded, PageHeader, Section, UnfinishedDecisions, useText } from '../parts';
import { planCopy as pc } from './plans-copy';
import { budgetParts, dayProgress, goalPercent, matrixParts, metricName, planPhase, planSpan, planSuggestions, type PlanDetailView } from './plans-logic';
import './plans.css';
import { BudgetBlock, CompletenessBar, GoalList, NextPublication, percentText, progressText, spanText } from './plans-parts';
import { ContentList, InlinePrompt, MatrixTable, MilestoneList, PacingRow, ProductRows, ProposalRow, ScheduleList, SuggestionPrompt } from './plans-detail';

/** Four tiles that answer "how is this plan doing" before any detail. */
function PlanSummary({ plan }: { plan: PlanDetailView }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const matrix = matrixParts(plan.matrix);
  const goals = plan.goals ?? [];
  const primary = goals[0];
  const primaryPercent = primary ? goalPercent(primary) : null;
  const budget = Array.isArray(plan.budget) ? plan.budget[0] : undefined;
  const money = budget ? budgetParts(budget) : null;
  const decisions = isNum(plan.needs_decision) ? plan.needs_decision : 0;
  return <div className="pl-summary">
    <div className="pl-stat"><span className="pl-stat-label">{l(pc.completeness)}</span>
      {matrix.ratio !== null ? <><strong className="pl-stat-value">{percentText(matrix.ratio, lang)}</strong>
        <small className="muted">{fill(l(pc.filledOf), { a: matrix.filled, b: matrix.planned })}{matrix.gap > 0 && ` · ${fill(l(pc.gap), { n: matrix.gap })}`}</small></>
        : <><strong className="pl-stat-value unknown">—</strong><small className="muted">{l(pc.nothingPlanned)}</small></>}</div>
    <div className="pl-stat"><span className="pl-stat-label">{l(pc.goals)}{primary && ` · ${l(metricName(primary.metric_key))}`}</span>
      {!primary ? <><strong className="pl-stat-value unknown">—</strong><small className="muted">{l(pc.noGoals)}</small></>
        : primaryPercent !== null ? <><strong className="pl-stat-value">{percentText(primaryPercent / 100, lang)}</strong>
          {goals.length > 1 && <small className="muted">{fill(l(pc.moreGoals), { n: goals.length - 1 })}</small>}</>
          : <><strong className="pl-stat-value unknown">—</strong><small className="muted">{l(pc.goalNotCollected)}</small></>}</div>
    <div className={`pl-stat${money?.over ? ' attention' : ''}`}><span className="pl-stat-label">{l(pc.budget)}{budget && ` · ${budget.currency}`}</span>
      {!Array.isArray(plan.budget) ? <><strong className="pl-stat-value unknown">—</strong><small className="muted">{plan.budget ? l(pc.budgetHidden) : l(copy.common.unknown)}</small></>
        : !budget || !money ? <><strong className="pl-stat-value unknown">—</strong><small className="muted">{l(pc.noBudget)}</small></>
          : <><strong className="pl-stat-value">{formatMinor(money.spent, budget.currency, lang, true) ?? '—'}</strong>
            <small className="muted">{fill(l(pc.ofBudget), { b: formatMinor(money.budget, budget.currency, lang, true) ?? '—' })}</small>
            {money.over && <span className="pl-flag tone-critical"><Glyph name="critical" size={12} />{fill(l(pc.overrun), { a: formatMinor(money.overrun, budget.currency, lang, true) ?? '' })}</span>}</>}</div>
    <div className={`pl-stat${decisions > 0 ? ' attention' : ''}`}><span className="pl-stat-label">{l(pc.summaryDecisions)}</span>
      <strong className="pl-stat-value">{decisions > 0 && <Glyph name="warning" size={18} />}{decisions}</strong>
      {decisions > 0 ? <Link to={`${base}/decisions?campaign=${encodeURIComponent(plan.id)}`}>{l(copy.common.viewAll)}</Link> : <small className="muted">{l(copy.overview.nothingToDecide)}</small>}</div>
  </div>;
}

function PlanDecisions({ plan, read, timeZone }: { plan: PlanDetailView; read: ViewResult<DecisionItem[]>; timeZone?: string }) {
  const { l } = useText();
  const { base } = useViewContext();
  const items = Array.isArray(read.value) ? read.value : [];
  // Without items the summary tile already links to the decisions page.
  if (!items.length) return <UnfinishedDecisions />;
  const href = `${base}/decisions?campaign=${encodeURIComponent(plan.id)}`;
  return <Section className="pl-decisions" title={<>{l(pc.decisions)}<span className="vs-badge">{items.length}</span></>}
    action={<Link to={href}>{l(copy.common.viewAll)}</Link>}>
    <UnfinishedDecisions />
    <div className="vs-decision-list">{items.slice(0, 5).map(item => <DecisionEntry key={item.id} item={item} compact timeZone={timeZone} />)}</div>
  </Section>;
}

function PlanDetail({ plan, decisions, asOf }: { plan: PlanDetailView; decisions: ViewResult<DecisionItem[]>; asOf: string | null }) {
  const { l, lang } = useText();
  const { ws, base } = useViewContext();
  const zone = plan.timezone ?? workspaceZone(ws);
  const today = todayIn(zone);
  const now = Date.now();
  const span = planSpan(plan, zone);
  const progress = dayProgress(plan, today, zone, now);
  const name = plan.name ?? l(copy.pages.planTitle);
  const agent = `${base}/agent`;
  const suggestions = planSuggestions(plan, now);
  // The first suggestion is shown at the top, so sections only repeat the others.
  const has = (key: string) => suggestions.find((item, index) => index > 0 && item.key === key);
  const phase = planPhase(plan, now);
  // Open the calendar on the month in view: today while the plan runs, otherwise its first month.
  const month = (phase === 'live' || !span ? today : span.start).slice(0, 7);
  const calendarHref = `${base}/calendar?campaign=${encodeURIComponent(plan.id)}&month=${month}`;
  const events = (plan.events ?? []).filter(event => event.kind !== 'plan');
  const cells = plan.cells ?? [];
  const proposals = plan.ads?.proposals ?? [];
  const spend = plan.ads?.spend ?? [];
  const milestones = plan.milestones ?? [];
  const content = plan.content ?? [];
  // Empty sections suggest a first step only while the plan can still change.
  const open = phase !== 'ended';
  const extra = [isNum(plan.matrix?.outside_plan) && plan.matrix!.outside_plan! > 0 ? fill(l(pc.outsidePlan), { n: plan.matrix!.outside_plan! }) : '',
    isNum(plan.matrix?.unplanned_items) && plan.matrix!.unplanned_items! > 0 ? fill(l(pc.unplannedItems), { n: plan.matrix!.unplanned_items! }) : ''].filter(Boolean);
  return <div className="pl-page">
    <PageHeader title={name} subtitle={`${span ? `${spanText(span, lang, today)} · ` : ''}${progressText(progress, l)}`} asOf={asOf} timeZone={zone ?? undefined}>
      <StatusChip status={plan.status} />
      {plan.created_via === 'agent' && <span title={l(pc.byAgent)}><ActorBadge type="agent" /></span>}
    </PageHeader>
    <PlanSummary plan={plan} />
    {suggestions[0] && <SuggestionPrompt suggestion={suggestions[0]} name={name} title={l(pc.nextStep)} agentHref={agent} />}
    <PlanDecisions plan={plan} read={decisions} timeZone={zone ?? undefined} />
    <div className="pl-detail-grid">
      <Section title={l(pc.goals)}>
        {plan.goals?.length ? <GoalList goals={plan.goals} /> : <>
          <p className="pl-note">{l(pc.noGoals)}</p>
          {has('set_goals') && <SuggestionPrompt suggestion={has('set_goals')!} name={name} title={l(pc.noGoals)} agentHref={agent} />}
        </>}
        {has('import_results') && <InlinePrompt suggestion={has('import_results')!} name={name} />}
      </Section>
      <Section title={l(pc.budget)}>
        <BudgetBlock budget={plan.budget} detail />
        {has('set_budget') && <SuggestionPrompt suggestion={has('set_budget')!} name={name} title={l(pc.noBudget)} agentHref={agent} />}
      </Section>
      <Section className="pl-wide" title={l(pc.matrix)}>
        <CompletenessBar matrix={plan.matrix} />
        {cells.length > 0 && <MatrixTable cells={cells} ratio={matrixParts(plan.matrix).ratio} />}
        {extra.length > 0 && <p className="pl-note">{extra.join(' · ')}</p>}
        {has('plan_matrix') && <SuggestionPrompt suggestion={has('plan_matrix')!} name={name} title={l(pc.nothingPlanned)} agentHref={agent} />}
        {has('fix_failed') && <InlinePrompt suggestion={has('fix_failed')!} name={name} />}
        {has('fill_gaps') && <InlinePrompt suggestion={has('fill_gaps')!} name={name} />}
      </Section>
      <Section title={l(pc.schedule)} action={<Link to={calendarHref}>{l(pc.openCalendar)}</Link>}>
        <NextPublication next={plan.next_publication} timeZone={zone ?? undefined} />
        {events.length ? <ScheduleList events={events} timeZone={zone ?? undefined} today={today} base={base} /> : <>
          <p className="pl-note">{l(pc.noEvents)}</p>
          {open && content.length > 0 && <SuggestionPrompt suggestion={{ key: 'schedule_content' }} name={name} title={l(pc.noEvents)} agentHref={agent} />}
        </>}
      </Section>
      <Section title={l(pc.milestones)}>
        {milestones.length ? <MilestoneList milestones={milestones} timeZone={zone ?? undefined} /> : <>
          <p className="pl-note">{l(pc.noMilestones)}</p>
          {open && <InlinePrompt suggestion={{ key: 'add_milestones' }} name={name} />}
        </>}
        {has('follow_milestones') && <InlinePrompt suggestion={has('follow_milestones')!} name={name} />}
      </Section>
      <Section title={l(pc.content)}>
        {content.length ? <ContentList items={content} timeZone={zone ?? undefined} /> : <>
          <p className="pl-note">{l(pc.noContent)}</p>
          {open && <SuggestionPrompt suggestion={{ key: 'produce_content' }} name={name} title={l(pc.noContent)} agentHref={agent} />}
        </>}
      </Section>
      <Section title={l(pc.products)}>
        {plan.products?.length ? <ProductRows products={plan.products} base={base} /> : <>
          <p className="pl-note">{l(pc.noProducts)}</p>
          {has('add_products') && <SuggestionPrompt suggestion={has('add_products')!} name={name} title={l(pc.noProducts)} agentHref={agent} />}
        </>}
      </Section>
      <Section className="pl-wide" title={l(pc.ads)} action={<Link to={`${base}/ads`}>{l(pc.openAds)}</Link>}>
        {spend.length > 0 && <div className="pl-stack-list">{spend.map((row, index) => <PacingRow key={`${row.currency}-${index}`} row={row} />)}</div>}
        {has('import_ad_spend') && <InlinePrompt suggestion={has('import_ad_spend')!} name={name} />}
        {proposals.length ? <>
          <h3 className="vs-subhead">{l(pc.proposals)}</h3>
          <ul className="vs-list pl-proposals">{proposals.map(proposal => <ProposalRow key={proposal.id} proposal={proposal} timeZone={zone ?? undefined} />)}</ul>
        </> : <>
          <p className="pl-note">{l(pc.noAds)}</p>
          {open && <InlinePrompt suggestion={{ key: 'draft_ads' }} name={name} />}
        </>}
      </Section>
    </div>
  </div>;
}

export function PlanPage() {
  const { l } = useText();
  const { id = '' } = useParams();
  const { base } = useViewContext();
  const read = useView<PlanDetailView>(`/views/plans/${encodeURIComponent(id)}`, {}, { enabled: Boolean(id) });
  const decisions = useView<DecisionItem[]>('/views/decisions', { campaign_id: id }, { enabled: Boolean(id) });
  const missing = read.value === undefined && read.error instanceof ApiError && read.error.status === 404;
  return <>
    <Link to={`${base}/plans`} className="pl-back">← {l(pc.back)}</Link>
    {missing ? <div className="vs-card pl-empty"><p>{l(pc.notFound)}</p></div>
      : <Loaded read={read}>{plan => <PlanDetail plan={plan} decisions={decisions} asOf={read.asOf ?? null} />}</Loaded>}
  </>;
}
