import { addDays, dayIn, diffDays, isDay, isNum, type CalendarEvent, type Tuple } from '@smartsell/ui';

// Response shapes of GET /views/plans and /views/plans/:id as the read model sends them
// (apps/server/src/modules/workspace/views/campaigns.ts); everything past id/name/status may be missing.
export interface PlanGoal {
  goal_id?: string; metric_key: string; unit: string; currency?: string | null; target_value: number | null; due_at?: string | null;
  value: number | null; progress_percent: number | null; coverage_status?: string | null;
}
export interface PlanMatrix {
  planned: number; filled?: number; published: number; scheduled: number; in_production: number; failed: number; gap: number;
  completeness_ratio: number | null; outside_plan?: number; unplanned_items?: number;
}
export interface PlanBudget {
  currency: string; budget_minor: number | null; committed_minor?: number | null; actual_minor: number | null;
  remaining_minor?: number | null; overrun_minor?: number | null; actual_complete?: boolean;
}
export type PlanBudgetBlock = PlanBudget[] | { visible: false };
export interface PlanProduct {
  product_id: string; title: string | null; role?: string | null; stock_status?: string | null;
  risk?: { severity: string; change_type: string; change_event_id?: string } | null;
}
export interface PlanCardView {
  id: string; name: string | null; kind?: string | null; status: string | null; brand_id?: string | null;
  starts_at: string | null; ends_at: string | null; timezone?: string | null; day?: number | null; days?: number | null;
  goals?: PlanGoal[]; matrix?: PlanMatrix; budget?: PlanBudgetBlock; products?: PlanProduct[];
  next_publication?: { publish_target_id: string; scheduled_at: string; title: string | null } | null;
  needs_decision?: number; created_via?: 'agent' | 'human' | null; as_of?: string;
}
export interface PlanCell {
  slot_id?: string; stage?: string | null; platform: string | null; social_account_id: string | null; account_name: string | null; market_id?: string | null;
  planned_count: number; published: number; scheduled: number; in_production: number; failed: number; gap: number;
}
export interface PlanMilestone { id: string; title: string | null; due_at: string | null; status: string | null; blocked?: boolean }
export interface PlanTarget { id: string; platform: string | null; social_account_id?: string | null; scheduled_at: string | null; display_status: string | null }
export interface PlanContentItem {
  content_item_id: string; title: string | null; production_stage: string | null; production_due_at?: string | null;
  created_via?: 'agent' | 'human' | null; targets?: PlanTarget[];
}
export interface PlanAdProposal {
  id: string; name: string | null; status: string | null; campaign_id?: string | null; ad_account_id?: string | null;
  schedule?: { starts_at: string | null; ends_at: string | null; tz?: string | null } | null;
  budget?: { type: string | null; amount_minor: number | null; currency: string | null } | null;
  estimates?: { metric: string; value: number | null; source?: string | null }[]; approval_status?: string | null; created_via?: 'agent' | 'human' | null;
}
export interface PlanPacing { campaign_id?: string | null; currency: string | null; budget_minor: number | null; actual_spend_minor: number | null; coverage_ratio: number | null; delayed: boolean | null }
export interface PlanDetailView extends PlanCardView {
  events?: CalendarEvent[]; cells?: PlanCell[]; milestones?: PlanMilestone[]; content?: PlanContentItem[];
  ads?: { proposals?: PlanAdProposal[]; spend?: PlanPacing[] };
}

/** The four groups the plan list filters by. */
export type Phase = 'live' | 'upcoming' | 'ended' | 'draft';
export const phases: readonly Phase[] = ['live', 'upcoming', 'ended', 'draft'];
const phaseOfStatus: Record<string, Phase> = {
  draft: 'draft', planned: 'upcoming', active: 'live', paused: 'live', wrapping: 'ended', closed: 'ended', cancelled: 'ended',
};
/** Status decides; an unknown status falls back to the plan's own period. */
export function planPhase(plan: Pick<PlanCardView, 'status' | 'starts_at' | 'ends_at'>, now = Date.now()): Phase {
  const known = phaseOfStatus[plan.status ?? ''];
  if (known) return known;
  const start = Date.parse(plan.starts_at ?? ''), end = Date.parse(plan.ends_at ?? '');
  if (!Number.isFinite(start)) return 'draft';
  if (start > now) return 'upcoming';
  return Number.isFinite(end) && end <= now ? 'ended' : 'live';
}
export const isPhase = (value: unknown): value is Phase => typeof value === 'string' && (phases as readonly string[]).includes(value);

/** Live first, then what starts next, then drafts, then the most recently ended. */
export function sortPlans<T extends PlanCardView>(plans: readonly T[], now = Date.now()): T[] {
  const rank: Record<Phase, number> = { live: 0, upcoming: 1, draft: 2, ended: 3 };
  // Missing dates sort last in every group.
  const at = (value: string | null | undefined, missing: number) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : missing; };
  const byName = (a: T, b: T) => String(a.name ?? '').localeCompare(String(b.name ?? '')) || a.id.localeCompare(b.id);
  return [...plans].sort((a, b) => {
    const pa = planPhase(a, now), pb = planPhase(b, now);
    if (pa !== pb) return rank[pa] - rank[pb];
    if (pa === 'ended') return at(b.ends_at ?? b.starts_at, 0) - at(a.ends_at ?? a.starts_at, 0) || byName(a, b);
    if (pa === 'live') return at(a.ends_at, 8.64e15) - at(b.ends_at, 8.64e15) || byName(a, b);
    return at(a.starts_at, 8.64e15) - at(b.starts_at, 8.64e15) || byName(a, b);
  });
}

export function phaseCounts(plans: readonly PlanCardView[], now = Date.now()) {
  const counts: Record<Phase, number> = { live: 0, upcoming: 0, ended: 0, draft: 0 };
  for (const plan of plans) counts[planPhase(plan, now)]++;
  return counts;
}

/**
 * A plan's end is an exclusive instant (midnight after the last day), so the last day shown is
 * the local day just before it.
 */
export function lastDay(endsAt: string | null | undefined, timeZone?: string): string {
  if (!endsAt) return '';
  if (isDay(endsAt)) return endsAt;
  const end = Date.parse(endsAt);
  if (!Number.isFinite(end)) return '';
  return dayIn(new Date(end - 1).toISOString(), timeZone);
}
export interface Span { start: string; end: string | null }
export function planSpan(plan: Pick<PlanCardView, 'starts_at' | 'ends_at'>, timeZone?: string): Span | null {
  const start = dayIn(plan.starts_at, timeZone);
  if (!start) return null;
  const end = lastDay(plan.ends_at, timeZone);
  return { start, end: end && end >= start ? end : null };
}

const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
function monthEnd(day: string) {
  const [year, month] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}
/**
 * Whole months covering the plans and today. A very long spread is cut to half a year back and a
 * year ahead of today so the bars stay readable; plans outside the window are reported separately.
 */
export function ganttWindow(spans: readonly Span[], today: string): { from: string; to: string } | null {
  if (!spans.length || !isDay(today)) return null;
  let lo = today, hi = today;
  for (const span of spans) {
    if (span.start < lo) lo = span.start;
    const end = span.end ?? span.start;
    if (end > hi) hi = end;
  }
  if (diffDays(lo, hi) > 550) {
    const floor = addDays(today, -183), ceil = addDays(today, 366);
    if (lo < floor) lo = floor;
    if (hi > ceil) hi = ceil;
  }
  return { from: monthStart(lo), to: monthEnd(hi) };
}
export const spanVisible = (span: Span, window: { from: string; to: string }) => span.start <= window.to && (span.end ?? span.start) >= window.from;

export type DayProgress = { kind: 'day'; day: number; days: number } | { kind: 'starts_in'; days: number } | { kind: 'ended' } | { kind: 'undated' } | { kind: 'open' };
/** "Day N of M" while running (from the server), days until start before it, ended after it. */
export function dayProgress(plan: Pick<PlanCardView, 'status' | 'starts_at' | 'ends_at' | 'day' | 'days'>, today: string, timeZone?: string, now = Date.now()): DayProgress {
  const span = planSpan(plan, timeZone);
  if (!span) return { kind: 'undated' };
  const phase = planPhase(plan, now);
  if (phase === 'ended' || (span.end && span.end < today)) return { kind: 'ended' };
  if (span.start > today) return { kind: 'starts_in', days: diffDays(today, span.start) };
  if (isNum(plan.day) && isNum(plan.days)) return { kind: 'day', day: plan.day, days: plan.days };
  if (span.end) return { kind: 'day', day: diffDays(span.start, today) + 1, days: diffDays(span.start, span.end) + 1 };
  return { kind: 'open' };
}

export const matrixKeys = ['published', 'scheduled', 'in_production', 'failed'] as const;
export type MatrixKey = typeof matrixKeys[number];
/**
 * Stacked parts of the planned content. The bar is as long as the filled share (Σmin(actual, planned)
 * per slot) so it always agrees with the completeness number; its parts keep the mix of statuses,
 * and content beyond a slot's planned count is reported as `excess` instead of stretching the bar.
 * Nothing planned means completeness is unknown.
 */
export function matrixParts(matrix: Partial<PlanMatrix> | null | undefined) {
  const planned = isNum(matrix?.planned) ? matrix.planned : 0;
  const counts = matrixKeys.map(key => ({ key, count: isNum(matrix?.[key]) ? matrix[key] : 0 }));
  const actual = counts.reduce((sum, part) => sum + part.count, 0);
  const filled = planned > 0 ? Math.min(planned, isNum(matrix?.filled) ? matrix.filled : Math.min(actual, planned)) : 0;
  const ratio = planned > 0 ? (isNum(matrix?.completeness_ratio) ? matrix.completeness_ratio : filled / planned) : null;
  const length = ratio ?? 0;
  return {
    planned, actual, filled, excess: Math.max(0, actual - filled), gap: isNum(matrix?.gap) ? matrix.gap : Math.max(0, planned - filled), ratio,
    parts: counts.filter(part => part.count > 0).map(part => ({ ...part, share: actual ? part.count / actual * length : 0 })),
  };
}

/** Spent and open commitments against the budget; open = budget − actual − remaining. */
export function budgetParts(row: PlanBudget) {
  const budget = isNum(row.budget_minor) ? row.budget_minor : null;
  const spent = isNum(row.actual_minor) ? row.actual_minor : null;
  const open = budget !== null && spent !== null && isNum(row.remaining_minor) ? Math.max(0, budget - spent - row.remaining_minor) : null;
  const overrun = isNum(row.overrun_minor) ? row.overrun_minor : budget !== null && spent !== null ? Math.max(0, spent + (open ?? 0) - budget) : null;
  const scale = Math.max(budget ?? 0, (spent ?? 0) + (open ?? 0));
  return {
    budget, spent, open, overrun, remaining: isNum(row.remaining_minor) ? row.remaining_minor : null,
    spentShare: scale && spent !== null ? spent / scale : 0, openShare: scale && open ? open / scale : 0,
    budgetMark: scale && budget !== null && budget < scale ? budget / scale : null, over: (overrun ?? 0) > 0,
    usedRatio: budget ? ((spent ?? 0) + (open ?? 0)) / budget : null,
  };
}

/** Per-currency totals over several plans; hidden budgets are left out rather than counted as zero. */
export function budgetTotals(plans: readonly Pick<PlanCardView, 'budget'>[]) {
  const totals = new Map<string, { currency: string; budget: number; spent: number; overrun: number; plans: number }>();
  let hidden = 0;
  for (const plan of plans) {
    if (!Array.isArray(plan.budget)) { if (plan.budget) hidden++; continue; }
    for (const row of plan.budget) {
      if (!row.currency) continue;
      const total = totals.get(row.currency) ?? { currency: row.currency, budget: 0, spent: 0, overrun: 0, plans: 0 };
      total.budget += isNum(row.budget_minor) ? row.budget_minor : 0;
      total.spent += isNum(row.actual_minor) ? row.actual_minor : 0;
      total.overrun += isNum(row.overrun_minor) ? row.overrun_minor : 0;
      total.plans++;
      totals.set(row.currency, total);
    }
  }
  return { currencies: [...totals.values()].sort((a, b) => b.budget - a.budget || a.currency.localeCompare(b.currency)), hidden };
}

/** Bar share for a goal; null when the value is unknown so no bar is drawn. */
export function goalShare(goal: Pick<PlanGoal, 'value' | 'target_value' | 'progress_percent'>): number | null {
  const percent = isNum(goal.progress_percent) ? goal.progress_percent
    : isNum(goal.value) && isNum(goal.target_value) && goal.target_value !== 0 ? goal.value / goal.target_value * 100 : null;
  return percent === null ? null : Math.max(0, Math.min(100, percent)) / 100;
}
export const goalPercent = (goal: Pick<PlanGoal, 'value' | 'target_value' | 'progress_percent'>) =>
  isNum(goal.progress_percent) ? goal.progress_percent : isNum(goal.value) && isNum(goal.target_value) && goal.target_value !== 0 ? goal.value / goal.target_value * 100 : null;

const metricNames: Record<string, Tuple> = {
  views: ['瀏覽', 'Views'], video_views: ['影片觀看', 'Video views'], impressions: ['曝光', 'Impressions'], reach: ['觸及', 'Reach'],
  engagements: ['互動', 'Engagements'], engagement_rate: ['互動率', 'Engagement rate'], likes: ['按讚', 'Likes'], comments: ['留言', 'Comments'],
  shares: ['分享', 'Shares'], saves: ['收藏', 'Saves'], followers: ['粉絲', 'Followers'], clicks: ['點擊', 'Clicks'], spend: ['花費', 'Spend'],
  conversions: ['轉換', 'Conversions'], orders: ['訂單', 'Orders'], revenue: ['營收', 'Revenue'], watch_time_seconds: ['觀看時長', 'Watch time'],
  redirects: ['短連結點擊', 'Link redirects'], clicks_filtered: ['有效點擊', 'Filtered clicks'],
};
/** A metric key such as `norm.post.views` named by its last part; unknown keys keep their own name. */
export function metricName(key: string): Tuple {
  const last = key.split('.').pop() ?? key;
  return metricNames[last] ?? metricNames[key] ?? [last.replace(/_/g, ' '), last.replace(/_/g, ' ')];
}

const platformNames: Record<string, Tuple> = {
  instagram: ['Instagram', 'Instagram'], facebook: ['Facebook', 'Facebook'], threads: ['Threads', 'Threads'], tiktok: ['TikTok', 'TikTok'],
  youtube: ['YouTube', 'YouTube'], douyin: ['抖音', 'Douyin'], xiaohongshu: ['小紅書', 'Xiaohongshu'], x: ['X', 'X'], twitter: ['X', 'X'],
  line: ['LINE', 'LINE'], generic: ['其他平台', 'Other platform'], meta: ['Meta', 'Meta'], google: ['Google', 'Google'],
};
/** Provider-prefixed keys (meta_instagram) fall back to the platform they name. */
export const platformName = (platform: string | null | undefined): Tuple | null =>
  platform ? platformNames[platform] ?? platformNames[platform.replace(/^(meta|google|bytedance)_/, '')] ?? [platform, platform] : null;

const attentionStatus = ['failed', 'blocked', 'outcome_unknown'];
/** Past events that still need a person stay in view when earlier days fold away. */
export const needsAttention = (event: Pick<CalendarEvent, 'needs_human' | 'status'>) => Boolean(event.needs_human) || attentionStatus.includes(String(event.status));

/** Events in day order (plan-period bands excluded), grouped by the local day they start. */
export function groupByDay(events: readonly CalendarEvent[], timeZone?: string): [day: string, events: CalendarEvent[]][] {
  const groups = new Map<string, CalendarEvent[]>();
  const sorted = events.filter(event => event.kind !== 'plan' && event.starts_at)
    .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)) || a.id.localeCompare(b.id));
  for (const event of sorted) {
    const day = dayIn(event.starts_at, timeZone);
    if (!day) continue;
    groups.set(day, [...(groups.get(day) ?? []), event]);
  }
  return [...groups];
}

const finishedMilestone = ['done', 'completed', 'cancelled', 'closed'];
export type MilestoneState = 'done' | 'blocked' | 'overdue' | 'open';
export function milestoneState(milestone: PlanMilestone, now = Date.now()): MilestoneState {
  if (finishedMilestone.includes(String(milestone.status))) return 'done';
  if (milestone.blocked || milestone.status === 'blocked') return 'blocked';
  const due = Date.parse(milestone.due_at ?? '');
  return Number.isFinite(due) && due < now ? 'overdue' : 'open';
}
/** Blocked and overdue first, then by due date. */
export function sortMilestones(milestones: readonly PlanMilestone[], now = Date.now()) {
  const rank: Record<MilestoneState, number> = { blocked: 0, overdue: 1, open: 2, done: 3 };
  return [...milestones].sort((a, b) => rank[milestoneState(a, now)] - rank[milestoneState(b, now)]
    || (a.due_at ?? '￿').localeCompare(b.due_at ?? '￿') || a.id.localeCompare(b.id));
}

/** Matrix rows plus a totals row; nothing planned and nothing produced means no rows. */
export function matrixTotals(cells: readonly PlanCell[]) {
  const total = { planned_count: 0, published: 0, scheduled: 0, in_production: 0, failed: 0, gap: 0 };
  for (const cell of cells) for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += isNum(cell[key]) ? cell[key] : 0;
  return total;
}

export type SuggestionKey = 'plan_matrix' | 'fill_gaps' | 'fix_failed' | 'set_goals' | 'import_results' | 'set_budget' | 'add_products' | 'import_ad_spend' | 'follow_milestones'
  | 'produce_content' | 'schedule_content' | 'add_milestones' | 'draft_ads';
const suggestionText: Record<SuggestionKey, Tuple> = {
  plan_matrix: ['幫我為『{name}』規劃各平台、各帳號要發幾則內容', 'Plan how many posts “{name}” needs on each platform and account'],
  fill_gaps: ['幫我把『{name}』還缺的 {n} 則內容做好並排程', 'Produce and schedule the {n} posts still missing from “{name}”'],
  fix_failed: ['幫我查看『{name}』發布失敗的 {n} 則內容，修正後重新排程', 'Check the {n} failed posts in “{name}”, fix them and reschedule'],
  set_goals: ['幫我為『{name}』設定目標，例如瀏覽數和互動數', 'Set goals for “{name}”, such as views and engagements'],
  import_results: ['幫我匯入『{name}』相關貼文的最新成效數據', 'Import the latest performance data for the posts in “{name}”'],
  set_budget: ['幫我登記『{name}』的預算和已發生的費用', 'Record the budget and costs so far for “{name}”'],
  add_products: ['幫我把這次要推的商品加進『{name}』', 'Add the products this promotion pushes to “{name}”'],
  import_ad_spend: ['幫我匯入『{name}』的投放花費', 'Import the ad spend for “{name}”'],
  follow_milestones: ['幫我跟進『{name}』逾期或受阻的里程碑，並更新進度', 'Follow up on the overdue or blocked milestones in “{name}” and update them'],
  // Empty-state prompts: offered where a section is empty, not ranked as next steps.
  produce_content: ['幫我為『{name}』產出第一批內容草稿', 'Draft the first batch of content for “{name}”'],
  schedule_content: ['幫我把『{name}』已完成的內容排進發布日程', 'Schedule the finished content of “{name}” for publishing'],
  add_milestones: ['幫我為『{name}』設定製作里程碑和期限', 'Set production milestones and deadlines for “{name}”'],
  draft_ads: ['幫我為『{name}』建一份投放方案，附預算與預估成效', 'Draft an ad proposal for “{name}” with a budget and estimated results'],
};
export const suggestionPrompt = (key: SuggestionKey) => suggestionText[key];

/** What the agent could do next for a plan, most useful first; ended plans only get data imports. */
export function planSuggestions(plan: PlanDetailView, now = Date.now()): { key: SuggestionKey; n?: number }[] {
  const phase = planPhase(plan, now);
  const out: { key: SuggestionKey; n?: number }[] = [];
  const running = phase === 'live' || phase === 'upcoming' || phase === 'draft';
  const matrix = matrixParts(plan.matrix);
  const failed = isNum(plan.matrix?.failed) ? plan.matrix.failed : 0;
  if (running && plan.matrix && matrix.planned === 0) out.push({ key: 'plan_matrix' });
  if (running && failed > 0) out.push({ key: 'fix_failed', n: failed });
  if (running && matrix.gap > 0) out.push({ key: 'fill_gaps', n: matrix.gap });
  const milestones = plan.milestones ?? [];
  if (running && milestones.some(row => ['blocked', 'overdue'].includes(milestoneState(row, now)))) out.push({ key: 'follow_milestones' });
  if (plan.goals && plan.goals.length === 0 && running) out.push({ key: 'set_goals' });
  if (phase !== 'draft' && phase !== 'upcoming' && (plan.goals ?? []).some(goal => !isNum(goal.value))) out.push({ key: 'import_results' });
  if (Array.isArray(plan.budget) && plan.budget.length === 0 && running) out.push({ key: 'set_budget' });
  if (plan.products && plan.products.length === 0 && running) out.push({ key: 'add_products' });
  if (phase !== 'draft' && phase !== 'upcoming' && (plan.ads?.spend ?? []).some(row => !isNum(row.actual_spend_minor))) out.push({ key: 'import_ad_spend' });
  return out;
}
