import { Link, useSearchParams } from 'react-router-dom';
import {
  AgentPrompt, LineChart, StatusChip, dayIn, diffDays, formatDateTime, formatDay, formatMinor, intlLocale, isNum, pick, relativeTime, type Tuple,
} from '@smartsell/ui';
import { copy, fill } from '../copy';
import { todayIn } from '../data/period';
import { useView, useViewContext, workspaceZone } from '../data/use-view';
import { Loaded, PageHeader, Section, useFilters, useText } from '../parts';
import {
  adsHeadline, adsWarningText, capabilityText, estimateMetricText, estimateValue, extraStatus, needsDecision, pacingState, spendSeries, spendTiles,
  type AdAccount, type AdProposal, type AdsData, type Pacing, type PlanInfo,
} from './ads-logic';
import { platformLabel, seriesCoverage } from './social-logic';
import { AskAgent, MeasureTile, Notices, usePlans } from './social-shared';
import './ads.css';

const t = {
  spend: ['花費', 'Spend', '花费'], impressions: ['曝光', 'Impressions'], clicks: ['點擊', 'Clicks', '点击'], conversions: ['轉換', 'Conversions', '转换'],
  perCurrency: ['多幣別分開顯示，不加總', 'Shown per currency, never added up', '多币别分开显示，不加总'],
  noAccess: ['你沒有查看投放帳戶的權限。需要時請工作區管理員開通「投放」讀取權限。', 'You do not have access to the ad accounts. Ask a workspace admin for ads read access if you need it.', '你没有查看投放账户的权限。需要时请工作区管理员开通「投放」读取权限。'],
  emptyDetail: ['投放帳戶和數據都由 Agent 幫你匯入；投放方案由 Agent 擬好後送來給你核准。', 'Your agent imports ad accounts and their data, and drafts ad proposals for you to approve.', '投放账户和数据都由 Agent 帮你导入；投放方案由 Agent 拟好后送来给你核准。'],
  emptyPrompt: ['幫我把廣告帳戶和近 30 天的投放數據匯入 SmartSell', 'Import my ad accounts and the last 30 days of ad data into SmartSell', '帮我把广告账户和近 30 天的投放数据导入 SmartSell'],
  noDataTitle: ['這段期間還沒有採集到投放數據', 'No ad data collected for this period', '这段期间还没有采集到投放数据'],
  noDataDetail: ['投放帳戶已建立，但沒有花費、曝光、點擊或轉換數據。', 'Ad accounts exist, but there is no spend, impressions, clicks or conversions data.', '投放账户已创建，但没有花费、曝光、点击或转换数据。'],
  importPrompt: ['把 {names} 近 {d} 天的投放數據匯入 SmartSell', 'Import the last {d} days of ad data for {names} into SmartSell', '把 {names} 近 {d} 天的投放数据导入 SmartSell'],
  pacing: ['預算進度', 'Budget pacing', '预算进度'], noPlan: ['未歸屬計劃的投放', 'Ads outside any plan', '未归属计划的投放'], planFallback: ['推廣計劃', 'Promotion plan', '推广计划'],
  periodSpend: ['期間花費', 'Spend in period', '期间花费'], budget: ['投放預算', 'Ad budget', '投放预算'], remaining: ['剩餘', 'Left', '剩余'], notSet: ['未設定', 'Not set', '未设置'],
  notCollected: ['未採集', 'Not collected', '未采集'], overBudget: ['超出預算', 'Over budget', '超出预算'], delayed: ['數據未齊', 'Data incomplete', '数据未齐'],
  reported: ['已回報 {a}/{b} 天', '{a} of {b} days reported', '已回报 {a}/{b} 天'], noUnits: ['還沒有投放單位回報花費', 'No ad units are reporting spend yet', '还没有投放单位回报花费'],
  elapsed: ['時間已過 {p}', '{p} of the plan time elapsed', '时间已过 {p}'], used: ['已用 {p}', '{p} used'], timeMark: ['豎線＝時間進度', 'Line = time elapsed', '竖线＝时间进度'],
  noBudget: ['未設定投放預算', 'No ad budget set', '未设置投放预算'], budgetHidden: ['你的角色看不到預算', 'Budgets are hidden for your role', '你的角色看不到预算'],
  hiddenPacing: ['你的角色看不到預算，所以這裡不顯示預算進度', 'Budgets are hidden for your role, so budget pacing is not shown', '你的角色看不到预算，所以这里不显示预算进度'], noSpend: ['尚未採集到花費，無法計算剩餘', 'No spend collected yet, so what is left is unknown', '尚未采集到花费，无法计算剩余'],
  noDates: ['計劃日期不明，無法確認是否涵蓋整個計劃', 'Plan dates are unknown, so the remaining budget cannot be confirmed', '计划日期不明，无法确认是否涵盖整个计划'],
  outside: ['所選期間沒有涵蓋整個計劃，剩餘無法從期間花費推算', 'The period does not cover the whole plan, so what is left cannot be derived', '所选期间没有涵盖整个计划，剩余无法从期间花费推算'],
  wholePlan: ['改看整個計劃期間', 'View the whole plan period', '改看整个计划期间'],
  noPacing: ['還沒有任何計劃設定投放預算', 'No plan has an ad budget yet', '还没有任何计划设置投放预算'],
  noPacingPrompt: ['幫我為進行中的推廣計劃設定投放預算', 'Set ad budgets for my live promotion plans', '帮我为进行中的推广计划设置投放预算'],
  spendNote: ['花費只計算所選期間；預算是整個計劃的投放預算。', 'Spend counts the selected period only; the budget is the whole plan’s ad budget.', '花费只计算所选期间；预算是整个计划的投放预算。'],
  spendTrend: ['花費走勢', 'Spend trend', '花费走势'],
  coverageAll: ['每一天都有花費數據。', 'Every day has spend data.', '每一天都有花费数据。'],
  coveragePart: ['{n} 天中有 {k} 天有花費數據；沒有數據的日子畫成斷點，不當作 0。', '{k} of {n} days have spend data; days without data are gaps, not 0.', '{n} 天中有 {k} 天有花费数据；没有数据的日子画成断点，不当作 0。'],
  coverageNone: ['這段期間沒有任何一天採集到花費。', 'No day in this period has spend data.', '这段期间没有任何一天采集到花费。'],
  proposals: ['投放方案', 'Ad proposals'], plan: ['計劃', 'Plan', '计划'], schedule: ['檔期', 'Schedule', '档期'], approval: ['審批', 'Approval', '审批'],
  daily: ['每日', 'Daily'], lifetime: ['總額', 'Lifetime', '总额'], notSubmitted: ['尚未送審', 'Not submitted', '尚未送审'], unassigned: ['未指定', 'None'],
  estimate: ['估算', 'Estimate'], estimateHint: ['以下為 Agent 或平台提供的估算，不是實際成效。', 'These are estimates from your agent or the platform, not actual results.', '以下为 Agent 或平台提供的估算，不是实际成效。'],
  source: ['來源', 'Source', '来源'], review: ['前往審批', 'Review and decide', '前往审批'], waiting: ['等你審批', 'Awaiting you', '等你审批'],
  noProposals: ['還沒有投放方案', 'No ad proposals yet', '还没有投放方案'],
  adjustments: ['Agent 另提出 {n} 項投放調整建議，可在進階工作台查看。', 'Your agent also suggested {n} ad adjustments; see them in the advanced workbench.', 'Agent 另提出 {n} 项投放调整建议，可在高级工作台查看。'], openAdvanced: ['查看', 'View'],
  accounts: ['投放帳戶', 'Ad accounts', '投放账户'], account: ['帳戶', 'Account', '账户'], currency: ['幣別', 'Currency', '币别'], timezone: ['時區', 'Time zone', '时区'],
  reporting: ['成效讀取', 'Reporting', '成效读取'], lastImport: ['最後匯入', 'Last import', '最后导入'], neverImported: ['尚未匯入', 'Never imported', '尚未导入'],
} satisfies Record<string, Tuple>;

export function AdsPage() {
  const { l } = useText();
  const { ws } = useViewContext();
  const { brandId, from, to } = useFilters(30);
  const read = useView<AdsData>('/views/ads', { brand_id: brandId, from, to });
  return <>
    <PageHeader title={l(copy.pages.adsTitle)} asOf={read.isPending ? undefined : read.asOf ?? null} timeZone={workspaceZone(ws)} />
    <Loaded read={read}>{view => <AdsBody view={view} brandId={brandId} />}</Loaded>
  </>;
}

function AdsBody({ view, brandId }: { view: AdsData; brandId?: string }) {
  const { l, lang } = useText();
  const { ws, base } = useViewContext();
  const tz = workspaceZone(ws);
  const plans = usePlans(brandId);
  const accounts = view.accounts ?? [], proposals = view.proposals ?? [];
  const warnings = (view.warnings ?? []).map(code => adsWarningText[code] ? l(adsWarningText[code]) : code);
  if (!accounts.length && !proposals.length) {
    if (view.warnings?.includes('AD_ACCOUNTS_HIDDEN')) return <Notices items={[l(t.noAccess)]} />;
    return <AgentPrompt title={l(copy.pages.adsEmpty)} detail={l(t.emptyDetail)} prompt={l(t.emptyPrompt)} agentHref={`${base}/agent`} />;
  }
  const metrics = view.metrics ?? {};
  const collected = [metrics.spend, metrics.impressions, metrics.clicks, metrics.conversions].some(metric => isNum(metric?.value) || (metric as { by_currency?: unknown[] } | undefined)?.by_currency?.length)
    || spendSeries(view.series).some(series => series.points.some(point => isNum(point.value))) || (view.pacing ?? []).some(row => isNum(row.actual_spend_minor));
  const tiles = spendTiles(metrics.spend, accounts);
  const days = view.period ? diffDays(view.period.from, view.period.to) + 1 : 30;
  const names = accounts.map(account => account.name || platformLabel(account.provider, lang)).join(lang === 'en' ? ', ' : '、');
  return <div className="vads-stack">
    <p className="vsx-answer">{adsHeadline(view, lang, plans, tz)}</p>
    <div className="vs-kpi-grid">
      {tiles.map(tile => <MeasureTile key={tile.key} label={tiles.length > 1 && tile.currency ? `${l(t.spend)} · ${tile.currency}` : l(t.spend)} metric={tile.metric}
        unit="currency" currency={tile.currency} goodDirection="none" compare={tile.compare} note={tile.compare ? null : l(t.perCurrency)} />)}
      <MeasureTile label={l(t.impressions)} metric={metrics.impressions} />
      <MeasureTile label={l(t.clicks)} metric={metrics.clicks} />
      <MeasureTile label={l(t.conversions)} metric={metrics.conversions} />
    </div>
    <Notices items={warnings} />
    {accounts.length > 0 && !collected && <AgentPrompt title={l(t.noDataTitle)} detail={l(t.noDataDetail)} prompt={fill(l(t.importPrompt), { names, d: days })} agentHref={`${base}/agent`} />}
    {spendSeries(view.series).some(line => line.points.some(point => isNum(point.value)))
      ? <div className="vs-columns"><PacingSection view={view} plans={plans} timeZone={tz} /><SpendSection view={view} /></div>
      : <PacingSection view={view} plans={plans} timeZone={tz} />}
    <ProposalsSection proposals={proposals} plans={plans} timeZone={tz} adjustments={view.adjustments_proposed ?? 0} />
    {accounts.length > 0 && <AccountsSection accounts={accounts} timeZone={tz} />}
  </div>;
}

function PacingSection({ view, plans, timeZone }: { view: AdsData; plans: Map<string, PlanInfo>; timeZone?: string }) {
  const { l } = useText();
  const rows = [...(view.pacing ?? [])].sort((a, b) => Number(b.campaign_id !== null) - Number(a.campaign_id !== null));
  return <Section title={l(t.pacing)}>
    {rows.length ? <>
      <ul className="vads-pacing">{rows.map(row => <PacingRow key={`${row.campaign_id ?? '-'}:${row.currency}`} row={row} view={view} plan={row.campaign_id ? plans.get(row.campaign_id) : undefined} timeZone={timeZone} />)}</ul>
      <p className="vsx-foot muted">{l(t.spendNote)}{rows.some(row => row.campaign_id && plans.get(row.campaign_id)?.starts_at && plans.get(row.campaign_id)?.ends_at) && <> {l(t.timeMark)}</>}</p>
    </> : view.budget_availability === 'no_permission' ? <p className="muted">{l(t.hiddenPacing)}</p> : <AskAgent title={l(t.noPacing)} prompt={l(t.noPacingPrompt)} />}
  </Section>;
}

function PacingRow({ row, view, plan, timeZone }: { row: Pacing; view: AdsData; plan?: PlanInfo; timeZone?: string }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const [params] = useSearchParams();
  const state = pacingState(row, plan, view.period, view.as_of, timeZone);
  const money = (minor: number | null) => isNum(minor) ? formatMinor(minor, row.currency, lang) ?? String(minor) : null;
  const percent = (ratio: number) => new Intl.NumberFormat(intlLocale(lang), { style: 'percent', maximumFractionDigits: 0 }).format(ratio);
  const name = row.campaign_id ? plan?.name ?? l(t.planFallback) : l(t.noPlan);
  // A link that widens the period to the whole plan (up to today), so “left” can be computed honestly.
  const wholePlan = (() => {
    if (state.remainingNote !== 'outside_period' || !plan?.starts_at) return null;
    const from = dayIn(plan.starts_at, timeZone), today = todayIn(timeZone), end = plan.ends_at ? dayIn(plan.ends_at, timeZone) : today;
    const to = end < today ? end : today;
    if (!from || !to || from > to || diffDays(from, to) >= 366) return null;
    const next = new URLSearchParams(params);
    next.set('from', from); next.set('to', to);
    return `?${next.toString()}`;
  })();
  const remainingNote = { no_budget: t.noBudget, budget_hidden: t.budgetHidden, no_spend: t.noSpend, unknown_plan_dates: t.noDates, outside_period: t.outside }[state.remainingNote ?? 'no_budget'];
  return <li className="vads-pace">
    <div className="vs-row-head">
      <span className="vads-pace-name">{row.campaign_id ? <Link to={`${base}/plans/${encodeURIComponent(row.campaign_id)}`}>{name}</Link> : name} <small className="muted">{row.currency}</small></span>
      <span className="vs-actions">
        {state.over && <StatusChip status="over_budget" tone="serious" label={t.overBudget} />}
        {row.delayed === true && <StatusChip status="delayed" tone="warning" label={t.delayed} />}
      </span>
    </div>
    {isNum(state.ratio) && <div className={`vads-meter${state.over ? ' over' : ''}`} role="meter" aria-valuemin={0} aria-valuemax={Math.max(100, Math.round(state.ratio * 100))} aria-valuenow={Math.round(state.ratio * 100)}
      aria-valuetext={fill(l(t.used), { p: percent(state.ratio) })} aria-label={`${name} ${row.currency}`}>
      <span style={{ width: `${Math.min(100, state.ratio * 100)}%` }} />
      {isNum(state.elapsed) && <i style={{ left: `${state.elapsed * 100}%` }} aria-hidden="true" />}
    </div>}
    <dl className="vads-figures">
      <div><dt>{l(t.periodSpend)}</dt><dd>{money(row.actual_spend_minor) ?? <span className="muted">{l(t.notCollected)}</span>}</dd></div>
      <div><dt>{l(t.budget)}</dt><dd>{money(row.budget_minor) ?? <span className="muted">{l(row.budget_availability === 'no_permission' ? t.budgetHidden : t.notSet)}</span>}</dd></div>
      {isNum(state.remaining) ? <div><dt>{l(t.remaining)}</dt><dd className={state.remaining < 0 ? 'over' : undefined}>{money(state.remaining)}</dd></div> : null}
    </dl>
    <small className="muted vads-pace-meta">
      {isNum(state.ratio) && <span>{fill(l(t.used), { p: percent(state.ratio) })}</span>}
      {isNum(state.elapsed) && <span>{fill(l(t.elapsed), { p: percent(state.elapsed) })}</span>}
      {isNum(state.reportedDays) ? <span>{fill(l(t.reported), { a: state.reportedDays, b: state.periodDays })}</span> : <span>{l(t.noUnits)}</span>}
      {!isNum(state.remaining) && state.remainingNote !== 'no_budget' && <span>{l(remainingNote)}{wholePlan && <> · <Link to={wholePlan}>{l(t.wholePlan)}</Link></>}</span>}
    </small>
  </li>;
}

function SpendSection({ view }: { view: AdsData }) {
  const { l } = useText();
  const lines = spendSeries(view.series);
  return <Section title={l(t.spendTrend)}>
    {lines.map(line => {
      const coverage = seriesCoverage(line.points);
      const title = line.currency && lines.length > 1 ? `${l(t.spendTrend)} · ${line.currency}` : l(t.spendTrend);
      const note = coverage.known === 0 ? l(t.coverageNone) : coverage.known === coverage.total ? l(t.coverageAll) : fill(l(t.coveragePart), { n: coverage.total, k: coverage.known });
      return <div key={line.currency ?? 'spend'} className="vads-spend">
        {lines.length > 1 && <h3 className="vads-subhead">{line.currency}</h3>}
        <LineChart title={title} unit="currency" currency={line.currency} series={[{ key: line.currency ?? 'spend', label: line.currency ? `${l(t.spend)} (${line.currency})` : l(t.spend), points: line.points }]} />
        <p className="vsx-foot muted">{note}</p>
      </div>;
    })}
  </Section>;
}

function ProposalStatus({ status }: { status: string | null }) {
  const extra = status ? extraStatus[status] : undefined;
  if (!extra) return <StatusChip status={status} />;
  return <StatusChip status={status} tone={extra[0]} label={[extra[1], extra[2], extra[3]]} />;
}

function ProposalsSection({ proposals, plans, timeZone, adjustments }: { proposals: AdProposal[]; plans: Map<string, PlanInfo>; timeZone?: string; adjustments: number }) {
  const { l } = useText();
  const { ws } = useViewContext();
  const ordered = [...proposals].sort((a, b) => Number(needsDecision(b)) - Number(needsDecision(a)));
  const waiting = proposals.filter(needsDecision).length;
  return <Section title={<>{l(t.proposals)} <span className="vs-count">{proposals.length}</span>{waiting > 0 && <span className="vs-badge">{waiting} {l(t.waiting)}</span>}</>}>
    {ordered.length ? <ul className="vads-proposals">{ordered.map(proposal => <ProposalRow key={proposal.id} proposal={proposal} plan={proposal.campaign_id ? plans.get(proposal.campaign_id) : undefined} timeZone={timeZone} />)}</ul>
      : <AskAgent title={l(t.noProposals)} prompt={l(copy.pages.adsPrompt)} />}
    {adjustments > 0 && <p className="vsx-foot muted">{fill(l(t.adjustments), { n: adjustments })} <Link to={`/w/${encodeURIComponent(ws)}/ads/experiments`}>{l(t.openAdvanced)}</Link></p>}
  </Section>;
}

function ProposalRow({ proposal, plan, timeZone }: { proposal: AdProposal; plan?: PlanInfo; timeZone?: string }) {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const { brandId } = useFilters();
  const decisions = `${base}/decisions?${new URLSearchParams({ kind: 'ad_proposal', ...(brandId ? { brand: brandId } : {}) }).toString()}`;
  const zone = proposal.schedule?.tz || timeZone;
  const day = (value: string | null | undefined) => value ? formatDay(dayIn(value, zone), lang, { year: 'numeric', month: 'numeric', day: 'numeric' }) : null;
  const start = day(proposal.schedule?.starts_at), end = day(proposal.schedule?.ends_at);
  const budget = proposal.budget;
  const amount = budget ? formatMinor(budget.amount_minor, budget.currency, lang) : null;
  const estimates = (proposal.estimates ?? []).filter(estimate => estimate.metric);
  const waiting = needsDecision(proposal);
  return <li className={`vads-proposal${waiting ? ' waiting' : ''}`}>
    <div className="vs-row-head"><strong className="vads-proposal-name">{proposal.name || l(t.proposals)}</strong>
      <span className="vs-actions"><ProposalStatus status={proposal.status} />
        {waiting && <Link className="vs-btn primary-soft" to={decisions}>{l(t.review)}</Link>}</span></div>
    <dl className="vads-facts">
      <div><dt>{l(t.plan)}</dt><dd>{proposal.campaign_id ? <Link to={`${base}/plans/${encodeURIComponent(proposal.campaign_id)}`}>{plan?.name ?? l(t.planFallback)}</Link> : <span className="muted">{l(t.unassigned)}</span>}</dd></div>
      <div><dt>{l(t.schedule)}</dt><dd>{start ? <>{start}{end && <> – {end}</>}{proposal.schedule?.tz && <small className="muted"> {proposal.schedule.tz}</small>}</> : <span className="muted">{l(t.notSet)}</span>}</dd></div>
      <div><dt>{l(t.budget)}</dt><dd>{amount ? <>{budget?.type === 'daily' ? `${l(t.daily)} ` : budget?.type === 'lifetime' ? `${l(t.lifetime)} ` : ''}{amount}</> : <span className="muted">{l(t.notSet)}</span>}</dd></div>
      <div><dt>{l(t.approval)}</dt><dd>{proposal.approval_status ? <ProposalStatus status={proposal.approval_status} /> : <span className="muted">{l(t.notSubmitted)}</span>}</dd></div>
    </dl>
    {estimates.length > 0 && <div className="vads-estimates" aria-label={l(t.estimateHint)}>
      <span className="vs-tag tone-info" title={l(t.estimateHint)}>{l(t.estimate)}</span>
      <ul>{estimates.map((estimate, index) => {
        const label = estimate.metric ? pick(estimateMetricText[estimate.metric] ?? [estimate.metric.replace(/_/g, ' '), estimate.metric.replace(/_/g, ' ')], lang) : '';
        const value = estimateValue(estimate, budget?.currency, lang);
        return <li key={`${estimate.metric}-${index}`}><span className="muted">{label}</span> <strong>≈ {value ?? l(t.notCollected)}</strong>
          {estimate.source && <small className="muted"> · {l(t.source)} {estimate.source}</small>}</li>;
      })}</ul>
    </div>}
  </li>;
}

function AccountsSection({ accounts, timeZone }: { accounts: AdAccount[]; timeZone?: string }) {
  const { l, lang } = useText();
  return <Section title={<>{l(t.accounts)} <span className="vs-count">{accounts.length}</span></>}>
    <div className="vsx-table-wrap"><table className="vsx-table">
      <caption className="vs-sr">{l(t.accounts)}</caption>
      <thead><tr><th scope="col">{l(t.account)}</th><th scope="col">{l(t.currency)}</th><th scope="col">{l(t.timezone)}</th><th scope="col">{l(t.reporting)}</th><th scope="col">{l(t.lastImport)}</th></tr></thead>
      <tbody>{accounts.map(account => {
        const capability = capabilityText[account.read_capability ?? 'unavailable'] ?? capabilityText.unavailable;
        return <tr key={account.id}>
          <th scope="row" className="lead"><span className="vsx-platform">{platformLabel(account.provider, lang)}</span><span className="vsx-name">{account.name ?? account.id}</span></th>
          <td data-label={l(t.currency)}>{account.currency ?? '—'}</td>
          <td data-label={l(t.timezone)}>{account.timezone ?? '—'}</td>
          <td data-label={l(t.reporting)}><StatusChip status={account.read_capability ?? 'unavailable'} tone={capability[0]} label={[capability[1], capability[2], capability[3]]} /></td>
          <td data-label={l(t.lastImport)}>{account.last_import_at
            ? <time dateTime={account.last_import_at} title={formatDateTime(account.last_import_at, lang, timeZone)}>{relativeTime(account.last_import_at, lang)}</time>
            : <span className="muted">{l(t.neverImported)}</span>}</td>
        </tr>;
      })}</tbody>
    </table></div>
  </Section>;
}
