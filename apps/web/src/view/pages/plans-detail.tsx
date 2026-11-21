import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  ActorBadge, AgentPrompt, CopyButton, Glyph, StatusChip, eventKindText, formatDateTime, formatDay, formatMinor, formatNumber, formatTime, isDay, isNum,
  seriesColor, statusInfo, dayIn, type CalendarEvent, type Tuple,
} from '@smartsell/ui';
import { fill } from '../copy';
import { resourcePath, useText } from '../parts';
import { planCopy as pc, targetStatus } from './plans-copy';
import {
  groupByDay, matrixTotals, metricName, milestoneState, needsAttention, platformName, sortMilestones, suggestionPrompt,
  type PlanAdProposal, type PlanCell, type PlanContentItem, type PlanMilestone, type PlanPacing, type PlanProduct, type SuggestionKey,
} from './plans-logic';
import { StockChip, percentText } from './plans-parts';

/** An agent prompt for one suggestion, filled with the plan's own name. */
export function SuggestionPrompt({ suggestion, name, title, agentHref }: { suggestion: { key: SuggestionKey; n?: number }; name: string; title: string; agentHref: string }) {
  const { l } = useText();
  return <AgentPrompt title={title} prompt={fill(l(suggestionPrompt(suggestion.key)), { name, n: suggestion.n ?? '' })} agentHref={agentHref} />;
}

/** One line instead of a full prompt card, for sections that already show data. */
export function InlinePrompt({ suggestion, name }: { suggestion: { key: SuggestionKey; n?: number }; name: string }) {
  const { l, lang } = useText();
  const text = fill(l(suggestionPrompt(suggestion.key)), { name, n: suggestion.n ?? '' });
  return <p className="pl-ask"><Glyph name="bot" size={13} /><span className="muted">{l(['請你的 Agent：', 'Tell your agent:', '请你的 Agent：'])}</span>
    <span className="pl-ask-text">{lang === 'en' ? `“${text}”` : `「${text}」`}</span><CopyButton text={text} className="vs-btn ghost pl-ask-copy" /></p>;
}

/** Display status of a publish target: the shared words, or the planning-only states they lack. */
export function TargetChip({ status }: { status: string | null | undefined }) {
  const own = targetStatus[status ?? ''];
  return own ? <StatusChip status={status} tone={own.tone} label={own.label} /> : <StatusChip status={status} />;
}

const platformLabel = (platform: string | null | undefined, l: (value: Tuple) => string) => { const name = platformName(platform); return name ? l(name) : null; };

/** Rows per planned slot; the totals row takes the plan's own completeness so excess in one slot never fills another. */
export function MatrixTable({ cells, ratio: planRatio }: { cells: PlanCell[]; ratio?: number | null }) {
  const { l, lang } = useText();
  const total = matrixTotals(cells);
  const head = <tr><th scope="col">{l(pc.matrixAccount)}</th><th scope="col">{l(pc.planned)}</th><th scope="col">{l(pc.part.published)}</th>
    <th scope="col">{l(pc.part.scheduled)}</th><th scope="col">{l(pc.part.in_production)}</th><th scope="col">{l(pc.part.failed)}</th>
    <th scope="col">{l(pc.gapCol)}</th><th scope="col"><span className="vs-sr">{l(pc.completeness)}</span></th></tr>;
  const row = (key: string, label: ReactNode, values: typeof total, isTotal = false) => {
    const actual = values.published + values.scheduled + values.in_production + values.failed;
    const ratio = isTotal && planRatio !== undefined ? planRatio : values.planned_count ? Math.min(values.planned_count, actual) / values.planned_count : null;
    const excess = isTotal ? 0 : Math.max(0, actual - values.planned_count);
    const Cell = isTotal ? 'th' : 'td';
    return <tr key={key} className={isTotal ? 'pl-total' : undefined}>
      <th scope="row">{label}</th>
      <Cell>{values.planned_count}</Cell><Cell>{values.published}</Cell><Cell>{values.scheduled}</Cell><Cell>{values.in_production}</Cell>
      <Cell>{values.failed > 0 ? <span className="pl-flag tone-critical"><Glyph name="critical" size={12} />{values.failed}</span> : values.failed}</Cell>
      <Cell>{values.gap > 0 ? <span className="pl-flag tone-warning"><Glyph name="warning" size={12} />{values.gap}</span>
        : excess > 0 ? <span className="muted" title={fill(l(pc.beyondPlan), { n: excess })}>{fill(l(pc.excessCell), { n: excess })}</span> : <span className="muted">0</span>}</Cell>
      <Cell className="pl-matrix-bar">{ratio === null ? <span className="muted">—</span> : <span className="pl-bar small" role="img" aria-label={percentText(ratio, lang)}><span style={{ width: `${ratio * 100}%` }} /></span>}</Cell>
    </tr>;
  };
  return <div className="vs-table-scroll pl-matrix"><table className="vs-table">
    <caption className="vs-sr">{l(pc.matrix)}</caption>
    <thead>{head}</thead>
    <tbody>{cells.map((cell, index) => row(cell.slot_id ?? String(index), <span className="pl-matrix-label">
      <span>{platformLabel(cell.platform, l) ?? '—'} · {cell.account_name ?? l(pc.anyAccount)}</span>
      {cell.stage && <small className="muted">{l((pc.stage as Record<string, Tuple>)[cell.stage] ?? [cell.stage, cell.stage])}</small>}
    </span>, cell))}</tbody>
    {cells.length > 1 && <tfoot>{row('total', l(pc.totalRow), total, true)}</tfoot>}
  </table></div>;
}

const stageTone: Record<string, 'good' | 'warning' | 'info' | 'neutral'> = { ready: 'good', internal_review: 'warning', awaiting_assets: 'warning', archived: 'neutral' };
// Same colours as the calendar so an event reads the same on both pages.
const kindColor: Record<string, string> = {
  publish: seriesColor(0), production_due: seriesColor(1), post: seriesColor(2), milestone: seriesColor(3), deliverable_due: seriesColor(4),
  ad_flight: seriesColor(5), promotion: seriesColor(6), live: seriesColor(7),
};
const needsHumanText: Record<string, Tuple> = { approval: ['待審批', 'Needs approval', '待审批'], late_decision: ['逾時待決定', 'Late, needs a decision', '逾时待决定'], outcome_unknown: ['結果待核實', 'Outcome unknown', '结果待核实'] };

function EventRow({ event, timeZone, base }: { event: CalendarEvent; timeZone?: string; base: string }) {
  const { l, lang } = useText();
  const time = event.all_day || isDay(event.starts_at) ? '' : formatTime(event.starts_at, lang, timeZone);
  const href = event.permalink ?? resourcePath(base, event.resource);
  const kind = l(eventKindText[event.kind] ?? [event.kind, event.kind]);
  const end = event.ends_at ? dayIn(event.ends_at, timeZone) : '';
  const title = event.title ?? '—';
  // Milestone states live in their own list; a status the needs-you chip already says is not repeated.
  const same = (event.needs_human === 'approval' && event.status === 'awaiting_approval') || (event.needs_human === 'outcome_unknown' && event.status === 'outcome_unknown');
  const stage = event.kind === 'production_due' && event.status ? (pc.productionStage as Record<string, Tuple>)[event.status] : undefined;
  const status = !event.status || same || event.kind === 'post' || event.kind === 'milestone' ? null
    : event.kind === 'production_due' ? <StatusChip status={event.status} tone={stageTone[event.status] ?? 'info'} label={stage} /> : <TargetChip status={event.status} />;
  return <li className="pl-event">
    <i className="pl-event-key" style={{ background: kindColor[event.kind] ?? 'var(--muted)' }} aria-hidden="true" />
    <time className="pl-event-time" dateTime={event.starts_at}>{time || '—'}</time>
    <span className="pl-event-main">
      <span className="pl-event-title">{href ? (/^https?:/i.test(href) ? <a href={href} target="_blank" rel="noreferrer noopener">{title}</a> : <Link to={href}>{title}</Link>) : title}</span>
      <small className="muted">{kind}{event.platform && ` · ${platformLabel(event.platform, l)}`}{end && end > dayIn(event.starts_at, timeZone) && ` · ${fill(l(pc.until), { d: formatDay(end, lang) })}`}</small>
    </span>
    <span className="pl-event-chips">
      {event.needs_human && <StatusChip status={event.needs_human} tone="warning" label={needsHumanText[event.needs_human] ?? undefined} />}
      {status}
    </span>
  </li>;
}

const MAX_DAYS = 10;
/**
 * The plan's events by day from today on. Earlier days fold behind a toggle, except events that still
 * need a person (late, failed, awaiting approval), which stay in view.
 */
export function ScheduleList({ events, timeZone, today, base }: { events: CalendarEvent[]; timeZone?: string; today: string; base: string }) {
  const { l, lang } = useText();
  const [earlier, setEarlier] = useState(false);
  const [all, setAll] = useState(false);
  const groups = groupByDay(events, timeZone);
  const future = groups.some(([day]) => day >= today);
  // When everything is in the past there is nothing to fold.
  const fold = future && !earlier;
  const hidden = fold ? groups.filter(([day]) => day < today).reduce((sum, [, list]) => sum + list.filter(event => !needsAttention(event)).length, 0) : 0;
  const shownGroups = fold ? groups.flatMap(([day, list]): [string, CalendarEvent[]][] => {
    if (day >= today) return [[day, list]];
    const kept = list.filter(needsAttention);
    return kept.length ? [[day, kept]] : [];
  }) : groups;
  const shown = all ? shownGroups : shownGroups.slice(0, MAX_DAYS);
  if (!groups.length) return null;
  const pastCount = groups.filter(([day]) => day < today).reduce((sum, [, list]) => sum + list.length, 0);
  return <div className="pl-schedule">
    {future && (hidden > 0 || earlier) && pastCount > 0 && <button type="button" className="vs-link-button" aria-expanded={earlier} onClick={() => setEarlier(!earlier)}>
      {earlier ? l(pc.hideEarlier) : fill(l(pc.earlier), { n: hidden })}</button>}
    <ol className="pl-days">{shown.map(([day, list]) => <li key={day} className={day === today ? 'today' : day < today ? 'past' : undefined}>
      <h3 className="pl-day">{formatDay(day, lang, { month: 'numeric', day: 'numeric', weekday: 'short' })}{day === today && <small> · {l(pc.today)}</small>}</h3>
      <ul className="pl-events">{list.map(event => <EventRow key={event.id} event={event} timeZone={timeZone} base={base} />)}</ul>
    </li>)}</ol>
    {shownGroups.length > MAX_DAYS && <button type="button" className="vs-link-button" aria-expanded={all} onClick={() => setAll(!all)}>
      {all ? l(pc.showLess) : fill(l(pc.showAll), { n: shownGroups.reduce((sum, [, list]) => sum + list.length, 0) })}</button>}
  </div>;
}

const milestoneChip: Record<string, { tone: 'critical' | 'serious' | 'good' | 'neutral'; label: Tuple }> = {
  blocked: { tone: 'critical', label: pc.blocked }, overdue: { tone: 'serious', label: pc.overdue }, done: { tone: 'good', label: pc.milestoneDone }, open: { tone: 'neutral', label: pc.milestoneOpen },
};
export function MilestoneList({ milestones, timeZone }: { milestones: PlanMilestone[]; timeZone?: string }) {
  const { lang } = useText();
  const now = Date.now();
  return <ul className="vs-list pl-milestones">{sortMilestones(milestones, now).map(row => {
    const state = milestoneState(row, now);
    const chip = milestoneChip[state];
    return <li key={row.id} className={`state-${state}`}>
      <StatusChip status={state} tone={chip.tone} label={chip.label} />
      <span className="vs-grow">{row.title ?? '—'}</span>
      {row.due_at && <time className="vs-when" dateTime={row.due_at}>{formatDateTime(row.due_at, lang, timeZone)}</time>}
    </li>;
  })}</ul>;
}

const MAX_ITEMS = 8;
export function ContentList({ items, timeZone }: { items: PlanContentItem[]; timeZone?: string }) {
  const { l, lang } = useText();
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, MAX_ITEMS);
  return <>
    <ul className="vs-list pl-content">{shown.map(item => {
      const stage = item.production_stage ? (pc.productionStage as Record<string, Tuple>)[item.production_stage] : undefined;
      const targets = item.targets ?? [];
      return <li key={item.content_item_id}>
        <div className="pl-content-head">
          <strong className="vs-grow">{item.title ?? '—'}</strong>
          {item.production_stage && <StatusChip status={item.production_stage} tone={stageTone[item.production_stage] ?? 'info'} label={stage} />}
          {item.created_via === 'agent' && <span title={l(pc.byAgent)}><ActorBadge type="agent" /></span>}
        </div>
        {item.production_due_at && item.production_stage !== 'ready' && <small className="muted">{fill(l(pc.productionDue), { d: formatDateTime(item.production_due_at, lang, timeZone) })}</small>}
        {targets.length ? <ul className="pl-targets">{targets.map(target => <li key={target.id}>
          <span>{platformLabel(target.platform, l) ?? '—'}</span>
          <time className="muted" dateTime={target.scheduled_at ?? undefined}>{target.scheduled_at ? formatDateTime(target.scheduled_at, lang, timeZone) : '—'}</time>
          <TargetChip status={target.display_status} />
        </li>)}</ul> : <small className="muted">{l(pc.noTargets)}</small>}
      </li>;
    })}</ul>
    {items.length > MAX_ITEMS && <button type="button" className="vs-link-button" aria-expanded={all} onClick={() => setAll(!all)}>
      {all ? l(pc.showLess) : fill(l(pc.showAll), { n: items.length })}</button>}
  </>;
}

export function ProductRows({ products, base }: { products: PlanProduct[]; base: string }) {
  const { l } = useText();
  return <ul className="vs-list pl-product-rows">{products.map(product => {
    const role = product.role ? (pc.role as Record<string, Tuple>)[product.role] : undefined;
    const risk = product.risk ? (pc.risk as Record<string, Tuple>)[product.risk.change_type] : undefined;
    return <li key={product.product_id}>
      <Link to={`${base}/products/${encodeURIComponent(product.product_id)}`} className="vs-grow">{product.title ?? product.product_id}</Link>
      {product.role && <span className="vs-tag">{role ? l(role) : product.role}</span>}
      <StockChip status={product.stock_status} />
      {product.risk && !(product.risk.change_type === 'stock_low' && product.stock_status === 'low') && !(product.risk.change_type === 'out_of_stock' && product.stock_status === 'out_of_stock') && <StatusChip status={product.risk.severity} tone={product.risk.severity === 'blocking' ? 'critical' : 'warning'}
        label={risk ?? [product.risk.change_type, product.risk.change_type]} />}
    </li>;
  })}</ul>;
}

/** Reported ad spend against the ad budget; unreported spend stays "not collected", never 0. */
export function PacingRow({ row }: { row: PlanPacing }) {
  const { l, lang } = useText();
  const money = (value: number | null) => value === null ? null : formatMinor(value, row.currency, lang);
  const spent = money(row.actual_spend_minor), budget = money(row.budget_minor);
  const share = isNum(row.actual_spend_minor) && isNum(row.budget_minor) && row.budget_minor > 0 ? Math.min(1, row.actual_spend_minor / row.budget_minor) : null;
  return <div className="pl-metric">
    <div className="pl-metric-head"><span>{l(pc.adsSpend)} <small className="muted">{row.currency}</small></span>
      <span>{spent ? <strong>{spent}</strong> : <span className="vs-tag tone-neutral">{l(pc.spendUnknown)}</span>}<small className="muted"> ／ {budget ?? '—'}</small></span></div>
    {share !== null ? <div className="pl-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={`${l(pc.adsSpend)} ${spent} / ${budget}`}><span style={{ width: `${share * 100}%` }} /></div>
      : <div className="pl-bar empty" aria-hidden="true" />}
    <div className="pl-metric-foot">
      {isNum(row.coverage_ratio) ? <span>{fill(l(pc.coverageDays), { p: percentText(row.coverage_ratio, lang) })}</span> : <span />}
      {row.delayed && <span className="pl-flag tone-warning"><Glyph name="warning" size={12} />{l(pc.delayed)}</span>}
    </div>
  </div>;
}

export function ProposalRow({ proposal, timeZone }: { proposal: PlanAdProposal; timeZone?: string }) {
  const { l, lang } = useText();
  const budget = proposal.budget;
  const amount = budget ? formatMinor(budget.amount_minor, budget.currency, lang) : null;
  const schedule = proposal.schedule;
  const zone = schedule?.tz ?? timeZone;
  const status = targetStatus[proposal.status ?? ''];
  return <li className="pl-proposal">
    <div className="pl-content-head">
      <strong className="vs-grow">{proposal.name ?? '—'}</strong>
      {status ? <StatusChip status={proposal.status} tone={status.tone} label={status.label} /> : <StatusChip status={proposal.status} />}
      {proposal.approval_status && proposal.approval_status !== proposal.status && !(proposal.approval_status === 'pending' && proposal.status === 'in_review')
        && <StatusChip status={proposal.approval_status} label={[`審批：${statusInfo(proposal.approval_status, 'zh').label}`, `Approval: ${statusInfo(proposal.approval_status, 'en').label}`, `审批：${statusInfo(proposal.approval_status, 'zh').label}`]} />}
      {proposal.created_via === 'agent' && <span title={l(pc.byAgent)}><ActorBadge type="agent" /></span>}
    </div>
    <small className="muted">
      {schedule?.starts_at && <>{formatDay(dayIn(schedule.starts_at, zone ?? undefined), lang)}{schedule.ends_at && ` – ${formatDay(dayIn(schedule.ends_at, zone ?? undefined), lang)}`}</>}
      {schedule?.starts_at && amount && ' · '}
      {amount && fill(l(budget?.type === 'daily' ? pc.daily : pc.lifetime), { a: amount })}
    </small>
    {proposal.estimates && proposal.estimates.length > 0 && <p className="pl-estimates"><span className="pl-label">{l(pc.estimates)}</span>
      {proposal.estimates.map(item => <span key={item.metric}>{l(metricName(item.metric))} {isNum(item.value) ? formatNumber(item.value, lang, true) : '—'}</span>)}
      <span className="vs-tag tone-info">{l(['估算', 'Estimated'])}</span></p>}
  </li>;
}
