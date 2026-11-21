import { pick, dayIn, diffDays, formatMeasure, formatMinor, intlLocale, isNum, metricDelta, type Lang, type Metric, type Point, type Tone, type Tuple } from '@smartsell/ui';
import { periodText } from './social-logic';

// Response of GET /views/ads (apps/server/src/modules/workspace/views/ads.ts); optional at the edges.
export interface AdAccount {
  id: string; provider: string | null; name: string | null; currency: string | null; timezone?: string | null;
  read_capability?: string | null; last_import_at?: string | null;
}
export type BudgetAvailability = 'available' | 'no_permission';
export interface Pacing { campaign_id: string | null; currency: string; budget_minor: number | null; budget_availability?: BudgetAvailability; actual_spend_minor: number | null; coverage_ratio: number | null; delayed: boolean | null }
export interface AdEstimate { metric: string | null; value: number | null; source: string | null }
export interface AdProposal {
  id: string; name: string | null; status: string | null; campaign_id: string | null; ad_account_id?: string | null;
  schedule: { starts_at: string | null; ends_at: string | null; tz: string | null } | null;
  budget: { type: string | null; amount_minor: number | null; currency: string | null } | null;
  estimates?: AdEstimate[]; approval_status: string | null;
}
export interface SpendMetric extends Metric { currency?: string | null; by_currency?: { currency: string; value: number }[] }
export interface AdsData {
  period?: { from: string; to: string }; compare_period?: { from: string; to: string }; reporting_basis?: string;
  accounts?: AdAccount[]; pacing?: Pacing[]; budget_availability?: BudgetAvailability;
  metrics?: { spend?: SpendMetric; impressions?: Metric; clicks?: Metric; conversions?: Metric };
  series?: { spend: Point[]; currency?: string | null; by_currency?: { currency: string; points: Point[] }[] };
  proposals?: AdProposal[]; adjustments_proposed?: number; warnings?: string[]; as_of?: string;
}
export interface PlanInfo { id: string; name: string; starts_at: string | null; ends_at: string | null }

export interface SpendTile { key: string; currency: string | null; metric: Metric; compare: boolean }
/** Spend tiles: one per currency when accounts bill in several, because amounts are never added across currencies. */
export function spendTiles(spend: SpendMetric | undefined, accounts: readonly AdAccount[]): SpendTile[] {
  if (spend?.by_currency?.length) {
    return spend.by_currency.map(entry => ({ key: entry.currency, currency: entry.currency, metric: { value: entry.value, availability: 'observed' }, compare: false }));
  }
  const codes = [...new Set(accounts.map(account => account.currency).filter((code): code is string => !!code))];
  const metric: Metric = spend ?? { value: null, availability: 'not_collected' };
  return [{ key: 'spend', currency: spend?.currency ?? (codes.length === 1 ? codes[0] : null), metric, compare: true }];
}

/** Daily spend lines, one chart per currency (never two currencies on one axis). */
export function spendSeries(series: AdsData['series']): { currency: string | null; points: Point[] }[] {
  if (!series) return [];
  if (series.by_currency?.length) return series.by_currency.map(entry => ({ currency: entry.currency, points: entry.points }));
  return [{ currency: series.currency ?? null, points: series.spend ?? [] }];
}

export type RemainingNote = 'no_budget' | 'budget_hidden' | 'no_spend' | 'unknown_plan_dates' | 'outside_period' | null;
export interface PacingState {
  ratio: number | null; over: boolean; remaining: number | null; remainingNote: RemainingNote;
  elapsed: number | null; reportedDays: number | null; periodDays: number;
}
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Reads one pacing row. Spend only counts the selected period while the budget belongs to the whole plan, so
 * “remaining” is only stated when the period covers the plan from its start (and up to now or its end).
 */
export function pacingState(row: Pacing, plan: PlanInfo | undefined, period: { from: string; to: string } | undefined, asOf: string | undefined, timeZone?: string): PacingState {
  const periodDays = period ? diffDays(period.from, period.to) + 1 : 0;
  const budget = row.budget_minor, actual = row.actual_spend_minor;
  const ratio = isNum(budget) && budget > 0 && isNum(actual) ? actual / budget : null;
  let remaining: number | null = null;
  let remainingNote: RemainingNote = null;
  const start = plan?.starts_at ? dayIn(plan.starts_at, timeZone) : '';
  const end = plan?.ends_at ? dayIn(plan.ends_at, timeZone) : '';
  const today = asOf ? dayIn(asOf, timeZone) : '';
  // A budget hidden from this role is not a missing budget.
  if (row.budget_availability === 'no_permission') remainingNote = 'budget_hidden';
  else if (!isNum(budget)) remainingNote = 'no_budget';
  else if (!isNum(actual)) remainingNote = 'no_spend';
  else if (!period || !start) remainingNote = 'unknown_plan_dates';
  else if (start < period.from || !((end && end <= period.to) || (today && today <= period.to))) remainingNote = 'outside_period';
  else remaining = budget - actual;
  let elapsed: number | null = null;
  const from = plan?.starts_at ? Date.parse(plan.starts_at) : NaN, to = plan?.ends_at ? Date.parse(plan.ends_at) : NaN, now = asOf ? Date.parse(asOf) : NaN;
  if (Number.isFinite(from) && Number.isFinite(to) && Number.isFinite(now) && to > from) elapsed = clamp01((now - from) / (to - from));
  return {
    ratio, over: isNum(budget) && isNum(actual) && actual > budget, remaining, remainingNote, elapsed,
    reportedDays: isNum(row.coverage_ratio) && periodDays ? Math.round(row.coverage_ratio * periodDays) : null, periodDays,
  };
}

/** A proposal waits on a person while it is in review or its approval request is still pending. */
export const needsDecision = (proposal: AdProposal) => proposal.status === 'in_review' || proposal.approval_status === 'pending';

// Proposal and approval states the shared StatusChip does not know yet.
export const extraStatus: Record<string, [Tone, string, string, string?]> = {
  exported: ['neutral', '已匯出', 'Exported', '已导出'], launched: ['good', '已上線', 'Launched', '已上线'], external_draft: ['info', '已建平台草稿', 'Platform draft'],
  invalidated: ['neutral', '已失效', 'Invalidated'], pending: ['warning', '待審批', 'Pending approval', '待审批'],
};

export const estimateMetricText: Record<string, Tuple> = {
  reach: ['觸及', 'Reach', '触及'], impressions: ['曝光', 'Impressions'], clicks: ['點擊', 'Clicks', '点击'], conversions: ['轉換', 'Conversions', '转换'],
  spend: ['花費', 'Spend', '花费'], cpc: ['單次點擊成本', 'CPC', '单次点击成本'], cpm: ['千次曝光成本', 'CPM'], cpa: ['單次轉換成本', 'CPA', '单次转换成本'], ctr: ['點擊率', 'CTR', '点击率'],
  video_views: ['影片觀看', 'Video views', '视频观看'], views: ['瀏覽', 'Views', '浏览'], purchases: ['購買', 'Purchases', '购买'], revenue: ['營收', 'Revenue', '营收'], roas: ['廣告投資報酬率', 'ROAS', '广告投资报酬率'],
};
/** Money estimates are integers in the budget's currency (the server requires the currencies to match). */
export const isMoneyMetric = (metric: string | null | undefined) => !!metric && /(spend|cost|cpc|cpm|cpa|cpv|budget|revenue)/i.test(metric) && !/roas/i.test(metric);
export function estimateValue(estimate: AdEstimate, currency: string | null | undefined, lang: Lang): string | null {
  if (!isNum(estimate.value)) return null;
  if (isMoneyMetric(estimate.metric)) return formatMinor(estimate.value, currency, lang) ?? formatMeasure(estimate.value, 'currency', null, lang);
  return formatMeasure(estimate.value, 'count', null, lang);
}

export const capabilityText: Record<string, [Tone, string, string, string?]> = {
  available: ['good', '可讀取成效', 'Reporting available', '可读取成效'], unavailable: ['neutral', '未授權讀取', 'No reporting access', '未授权读取'],
};

export const adsWarningText: Record<string, Tuple> = {
  AD_ACCOUNTS_HIDDEN: ['部分投放帳戶你沒有查看權限，已隱藏；以下數字不包含它們。', 'Some ad accounts are hidden because you lack access; the figures below exclude them.', '部分投放账户你没有查看权限，已隐藏；以下数字不包含它们。'],
  MIXED_CURRENCIES: ['投放帳戶使用多種幣別，花費分幣別顯示，不會加總。', 'Ad accounts bill in several currencies, so spend is shown per currency and never added together.', '投放账户使用多种币别，花费分币别显示，不会加总。'],
};

const resultName = { conversions: ['轉換', 'conversions', '转化'], clicks: ['點擊', 'clicks', '点击'], impressions: ['曝光', 'impressions'] } as const;
/** Next to other currencies a bare “$” is ambiguous (TWD in zh, USD in en), so the code is added. */
export const withCode = (text: string | null, currency: string) => text && /^-?\$/.test(text) ? `${text} ${currency}` : text;

const percent = (ratio: number, lang: Lang, signed = false) => new Intl.NumberFormat(intlLocale(lang), { style: 'percent', maximumFractionDigits: 0, ...(signed ? { signDisplay: 'exceptZero' as const } : {}) }).format(ratio);

/** One sentence answering “how much did I spend, how did it do, how much budget is left?”. */
export function adsHeadline(view: AdsData, lang: Lang, plans: Map<string, PlanInfo>, timeZone?: string): string {
  const en = lang === 'en';
  const accounts = view.accounts ?? [], proposals = view.proposals ?? [];
  const lead = periodText(view.period, lang);
  if (!accounts.length && !proposals.length) return en ? `${lead}: no ad accounts or proposals yet.` : lang === 'zh-Hans' ? `${lead}：还没有投放账户或投放方案。` : `${lead}：還沒有投放帳戶或投放方案。`;
  const parts: string[] = [];
  const spend = view.metrics?.spend;
  if (spend?.by_currency?.length) {
    const amounts = spend.by_currency.map(entry => withCode(formatMinor(entry.value, entry.currency, lang, true), entry.currency) ?? `${entry.value} ${entry.currency}`);
    parts.push(en ? `spent ${amounts.join(' and ')} (per currency)` : lang === 'zh-Hans' ? `花费 ${amounts.join('、')}（按币种）` : `花費 ${amounts.join('、')}（分幣別）`);
  } else if (spend && isNum(spend.value)) {
    const currency = spend.currency ?? null;
    const amount = formatMeasure(spend.value, 'currency', currency, lang, true);
    const delta = metricDelta(spend);
    const change = delta === null ? '' : en ? ` (${percent(delta, lang, true)} vs prior period)` : lang === 'zh-Hans' ? `（较前期 ${percent(delta, lang, true)}）` : `（較前期 ${percent(delta, lang, true)}）`;
    parts.push(en ? `spent ${amount}${change}` : lang === 'zh-Hans' ? `花费 ${amount}${change}` : `花費 ${amount}${change}`);
  } else parts.push(en ? 'spend not collected' : lang === 'zh-Hans' ? '花费未采集' : '花費未採集');
  // The deepest known result: conversions, else clicks, else impressions.
  const result = (['conversions', 'clicks', 'impressions'] as const).find(key => isNum(view.metrics?.[key]?.value));
  if (result) {
    const value = formatMeasure(view.metrics![result]!.value!, 'count', null, lang, true);
    parts.push(en ? `${value} ${result}` : `${pick(resultName[result], lang)} ${value}`);
  } else parts.push(en ? 'results not collected' : lang === 'zh-Hans' ? '成效未采集' : '成效未採集');
  const rows = (view.pacing ?? []).map(row => ({ row, state: pacingState(row, row.campaign_id ? plans.get(row.campaign_id) : undefined, view.period, view.as_of, timeZone) }));
  const over = rows.filter(entry => entry.state.over).length;
  if (over) parts.push(en ? `${over} plan budget${over > 1 ? 's' : ''} overspent` : lang === 'zh-Hans' ? `${over} 个计划已超出预算` : `${over} 個計劃已超出預算`);
  else {
    const left = new Map<string, number>();
    for (const { row, state } of rows) if (isNum(state.remaining)) left.set(row.currency, (left.get(row.currency) ?? 0) + state.remaining);
    const amounts = [...left].map(([currency, value]) => left.size > 1 ? withCode(formatMinor(value, currency, lang, true), currency) : formatMinor(value, currency, lang, true)).filter((text): text is string => !!text);
    if (amounts.length) parts.push(en ? `${amounts.join(' and ')} budget left` : lang === 'zh-Hans' ? `预算还剩 ${amounts.join('、')}` : `預算還剩 ${amounts.join('、')}`);
  }
  const waiting = proposals.filter(needsDecision).length;
  if (waiting) parts.push(en ? `${waiting} proposal${waiting > 1 ? 's' : ''} awaiting your approval` : lang === 'zh-Hans' ? `${waiting} 个投放方案等你审批` : `${waiting} 個投放方案等你審批`);
  return en ? `${lead}: ${parts.join(', ')}.` : `${lead}：${parts.join('，')}。`;
}
