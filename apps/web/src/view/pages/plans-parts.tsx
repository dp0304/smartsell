import { Link } from 'react-router-dom';
import {
  AvailabilityTag, Glyph, StatusChip, availabilityText, formatDateTime, formatDay, formatMinor, formatNumber, intlLocale, isNum, relativeTime,
  type Lang, type Tuple,
} from '@smartsell/ui';
import { fill } from '../copy';
import { useText } from '../parts';
import { planCopy as pc } from './plans-copy';
import {
  budgetParts, goalPercent, goalShare, matrixKeys, matrixParts, metricName,
  type DayProgress, type PlanBudget, type PlanBudgetBlock, type PlanCardView, type PlanGoal, type PlanMatrix, type PlanProduct, type Span,
} from './plans-logic';

type L = (value: Tuple) => string;

export function percentText(ratio: number, lang: Lang) {
  return new Intl.NumberFormat(intlLocale(lang), { style: 'percent', maximumFractionDigits: 0 }).format(ratio);
}

/** "11/15 – 11/28", with years once the period leaves the current year. */
export function spanText(span: Span, lang: Lang, today: string) {
  const year = today.slice(0, 4);
  const options: Intl.DateTimeFormatOptions | undefined = span.start.slice(0, 4) !== year || (span.end && span.end.slice(0, 4) !== year)
    ? { year: 'numeric', month: 'numeric', day: 'numeric' } : undefined;
  return `${formatDay(span.start, lang, options)} – ${span.end ? formatDay(span.end, lang, options) : '…'}`;
}

export function progressText(progress: DayProgress, l: L) {
  switch (progress.kind) {
    case 'day': return fill(l(pc.dayOf), { day: progress.day, days: progress.days });
    case 'starts_in': return progress.days <= 0 ? l(pc.startsToday) : progress.days === 1 ? l(pc.startsTomorrow) : fill(l(pc.startsIn), { n: progress.days });
    case 'ended': return l(pc.ended);
    case 'open': return l(pc.openEnded);
    default: return l(pc.noDates);
  }
}

/** Goal values arrive in major units (the server converts currency goals), unlike `*_minor` budgets. */
export function goalValueText(value: number, unit: string, currency: string | null | undefined, lang: Lang) {
  const locale = intlLocale(lang);
  if (unit === 'currency' && currency) {
    try { return new Intl.NumberFormat(locale, { style: 'currency', currency, ...(Math.abs(value) >= 10000 ? { notation: 'compact', maximumFractionDigits: 1 } : {}) }).format(value); }
    catch { return `${formatNumber(value, lang, true)} ${currency}`; }
  }
  if (unit === 'percent') return `${formatNumber(value, lang)}%`;
  if (unit === 'ratio') return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(value);
  if (unit === 'seconds') {
    if (value >= 3600) return lang === 'en' ? `${formatNumber(Math.round(value / 360) / 10, lang)} h` : `${formatNumber(Math.round(value / 360) / 10, lang)} 小時`;
    if (value >= 60) return lang === 'en' ? `${formatNumber(Math.round(value / 60), lang)} min` : `${formatNumber(Math.round(value / 60), lang)} 分鐘`;
    return lang === 'en' ? `${formatNumber(value, lang)} s` : `${formatNumber(value, lang)} 秒`;
  }
  return formatNumber(value, lang, true);
}

/** Coverage of a goal's value: the shared availability words, or what the plan read model adds. */
export function CoverageTag({ status }: { status: string | null | undefined }) {
  const { l } = useText();
  const key = status ?? 'unknown';
  if (availabilityText[key]) return <AvailabilityTag availability={key} />;
  const own = (pc.coverage as Record<string, Tuple>)[key];
  return <span className="vs-tag tone-neutral" data-availability={key}>{own ? l(own) : l(pc.goalNotCollected)}</span>;
}

export function CompletenessBar({ matrix, legend = true }: { matrix: Partial<PlanMatrix> | null | undefined; legend?: boolean }) {
  const { l, lang } = useText();
  const parts = matrixParts(matrix);
  if (!matrix || parts.planned === 0) return <div className="pl-metric">
    <div className="pl-metric-head"><span>{l(pc.completeness)}</span><span className="vs-tag tone-neutral">{l(availabilityText.not_collected)}</span></div>
    <p className="pl-note">{l(pc.nothingPlanned)}</p>
  </div>;
  const ratio = parts.ratio ?? 0;
  const counts = matrixKeys.map(key => ({ key, count: isNum(matrix[key]) ? matrix[key]! : 0 })).filter(part => part.count > 0 || part.key !== 'failed');
  const summary = `${l(pc.completeness)} ${percentText(ratio, lang)}: ${counts.map(part => `${l(pc.part[part.key])} ${part.count}`).join(', ')}; ${fill(l(pc.gap), { n: parts.gap })}`;
  return <div className="pl-metric">
    <div className="pl-metric-head"><span>{l(pc.completeness)}</span><strong>{percentText(ratio, lang)}</strong></div>
    <div className="pl-stack" role="img" aria-label={summary}>
      {parts.parts.map(part => <span key={part.key} className={`pl-seg pl-seg-${part.key}`} style={{ width: `${part.share * 100}%` }} title={`${l(pc.part[part.key])} ${part.count}`} />)}
    </div>
    <div className="pl-metric-foot">
      <span>{fill(l(pc.filledOf), { a: parts.filled, b: parts.planned })}{parts.excess > 0 && <span className="muted"> · {fill(l(pc.beyondPlan), { n: parts.excess })}</span>}</span>
      {parts.gap > 0 ? <span className="pl-flag tone-warning"><Glyph name="warning" size={12} />{fill(l(pc.gap), { n: parts.gap })}</span>
        : <span className="pl-flag tone-good"><Glyph name="check" size={12} />{l(pc.noGap)}</span>}
    </div>
    {legend && <ul className="pl-legend" aria-hidden="true">{counts.map(part => <li key={part.key}>
      {part.key === 'failed' ? <Glyph name="critical" size={11} /> : <i className={`pl-swatch pl-seg-${part.key}`} />}{l(pc.part[part.key])} <strong>{part.count}</strong>
    </li>)}</ul>}
  </div>;
}

export function GoalRow({ goal }: { goal: PlanGoal }) {
  const { l, lang } = useText();
  const name = l(metricName(goal.metric_key));
  const share = goalShare(goal), percent = goalPercent(goal);
  const known = isNum(goal.value);
  const value = known ? goalValueText(goal.value!, goal.unit, goal.currency, lang) : '—';
  const target = isNum(goal.target_value) ? goalValueText(goal.target_value, goal.unit, goal.currency, lang) : '—';
  const coverage = goal.coverage_status ?? (known ? 'observed' : 'not_collected');
  return <li className="pl-metric pl-goal">
    <div className="pl-metric-head"><span>{name}</span>
      <span><strong className={known ? undefined : 'muted'}>{value}</strong><small className="muted"> ／ {fill(l(pc.ofTarget), { b: target })}</small></span></div>
    {share !== null ? <div className="pl-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(share * 100)} aria-label={`${name} ${value} / ${target}`}>
      <span style={{ width: `${share * 100}%` }} /></div> : <div className="pl-bar empty" aria-hidden="true" />}
    <div className="pl-metric-foot">
      {percent !== null ? <span>{percentText(percent / 100, lang)}{percent >= 100 && <span className="pl-flag tone-good"><Glyph name="check" size={12} />{l(pc.reached)}</span>}</span> : <CoverageTag status={coverage} />}
      {known && coverage !== 'observed' && <CoverageTag status={coverage} />}
      {goal.due_at && <span className="muted">{fill(l(pc.due), { d: formatDay(goal.due_at.slice(0, 10), lang) })}</span>}
    </div>
  </li>;
}

export function GoalList({ goals, max }: { goals: PlanGoal[] | undefined; max?: number }) {
  const { l } = useText();
  if (!goals) return null;
  if (!goals.length) return <p className="pl-note">{l(pc.noGoals)}</p>;
  const shown = max ? goals.slice(0, max) : goals;
  return <>
    <ul className="pl-goals">{shown.map((goal, index) => <GoalRow key={goal.goal_id ?? `${goal.metric_key}-${index}`} goal={goal} />)}</ul>
    {goals.length > shown.length && <p className="pl-note">{fill(l(pc.moreGoals), { n: goals.length - shown.length })}</p>}
  </>;
}

export function BudgetMeter({ row, detail = false }: { row: PlanBudget; detail?: boolean }) {
  const { l, lang } = useText();
  const parts = budgetParts(row);
  const money = (value: number | null) => value === null ? '—' : formatMinor(value, row.currency, lang, !detail) ?? '—';
  const summary = `${l(pc.budget)} ${row.currency}: ${l(pc.spent)} ${money(parts.spent)} / ${money(parts.budget)}${parts.over ? `; ${fill(l(pc.overrun), { a: money(parts.overrun) })}` : ''}`;
  return <div className="pl-metric">
    <div className="pl-metric-head"><span>{l(pc.budget)} <small className="muted">{row.currency}</small></span>
      <span><strong>{money(parts.spent)}</strong><small className="muted"> ／ {money(parts.budget)}</small></span></div>
    <div className={`pl-stack pl-budget${parts.over ? ' over' : ''}`} role="img" aria-label={summary}>
      <span className="pl-seg pl-seg-spent" style={{ width: `${parts.spentShare * 100}%` }} title={`${l(pc.spent)} ${money(parts.spent)}`} />
      {parts.openShare > 0 && <span className="pl-seg pl-seg-open" style={{ width: `${parts.openShare * 100}%` }} title={`${l(pc.committed)} ${money(parts.open)}`} />}
      {parts.budgetMark !== null && <i className="pl-budget-mark" style={{ left: `${parts.budgetMark * 100}%` }} title={`${l(pc.budgetTotal)} ${money(parts.budget)}`} />}
    </div>
    <div className="pl-metric-foot">
      {parts.over ? <span className="pl-flag tone-critical"><Glyph name="critical" size={12} />{fill(l(pc.overrun), { a: money(parts.overrun) })}</span>
        : parts.usedRatio !== null ? <span>{fill(l(pc.used), { p: percentText(parts.usedRatio, lang) })}</span> : <span />}
      {parts.open ? <span className="pl-legend-inline"><i className="pl-swatch pl-seg-open" />{l(pc.committed)} {money(parts.open)}</span> : null}
    </div>
    {detail && <dl className="pl-dl">
      <div><dt>{l(pc.budgetTotal)}</dt><dd>{money(parts.budget)}</dd></div>
      <div><dt><i className="pl-swatch pl-seg-spent" />{l(pc.spent)}</dt><dd>{money(parts.spent)}</dd></div>
      <div><dt><i className="pl-swatch pl-seg-open" />{l(pc.committed)}</dt><dd>{money(parts.open)}</dd></div>
      <div><dt>{l(pc.remaining)}</dt><dd className={parts.over ? 'pl-negative' : undefined}>{money(parts.remaining)}</dd></div>
    </dl>}
    {detail && row.actual_complete === false && <p className="pl-note">{l(pc.provisional)}</p>}
  </div>;
}

export function BudgetBlock({ budget, detail = false }: { budget: PlanBudgetBlock | undefined; detail?: boolean }) {
  const { l } = useText();
  if (budget === undefined) return null;
  if (!Array.isArray(budget)) return <p className="pl-note">{l(pc.budgetHidden)}</p>;
  if (!budget.length) return <div className="pl-metric"><div className="pl-metric-head"><span>{l(pc.budget)}</span></div><p className="pl-note">{l(pc.noBudget)}</p></div>;
  return <div className="pl-stack-list">{budget.map(row => <BudgetMeter key={row.currency} row={row} detail={detail} />)}</div>;
}

const stockTone: Record<string, 'good' | 'warning' | 'critical' | 'neutral'> = { in_stock: 'good', low: 'warning', out_of_stock: 'critical' };
export function StockChip({ status }: { status: string | null | undefined }) {
  const key = status ?? 'unknown';
  if (key === 'unknown') return <StatusChip status="unknown" tone="neutral" label={pc.stockUnknown} />;
  return <StatusChip status={key} tone={stockTone[key]} />;
}

/** Up to `max` product names; only stock problems get a chip so the card stays quiet when all is well. */
export function ProductChips({ products, base, max = 3 }: { products: PlanProduct[] | undefined; base: string; max?: number }) {
  const { l } = useText();
  if (!products) return null;
  if (!products.length) return <p className="pl-note">{l(pc.noProducts)}</p>;
  return <div className="pl-products">
    <span className="pl-label">{l(pc.products)}</span>
    <ul className="pl-chips">
      {products.slice(0, max).map(product => <li key={product.product_id}>
        <Link to={`${base}/products/${encodeURIComponent(product.product_id)}`} className="pl-chip-link" title={product.title ?? undefined}>{product.title ?? product.product_id}</Link>
        {['low', 'out_of_stock'].includes(String(product.stock_status)) && <StockChip status={product.stock_status} />}
      </li>)}
      {products.length > max && <li className="muted">{fill(l(pc.moreProducts), { n: products.length - max })}</li>}
    </ul>
  </div>;
}

export function NextPublication({ next, timeZone }: { next: PlanCardView['next_publication']; timeZone?: string }) {
  const { l, lang } = useText();
  if (next === undefined) return null;
  return <p className="pl-next"><span className="pl-label">{l(pc.nextPublication)}</span>
    {next ? <><time dateTime={next.scheduled_at} title={relativeTime(next.scheduled_at, lang)}>{formatDateTime(next.scheduled_at, lang, timeZone)}</time>
      <span className="pl-next-title">{next.title ?? '—'}</span></> : <span className="muted">{l(pc.noNext)}</span>}
  </p>;
}

export function NeedsDecision({ count, href }: { count: number | undefined; href: string }) {
  const { l } = useText();
  if (!isNum(count) || count <= 0) return null;
  return <Link to={href} className="pl-decide"><Glyph name="warning" size={13} />{fill(l(pc.needsDecision), { n: count })}</Link>;
}
