import { READ, type Context, type Input, type Operation, type Role, type Row } from '@smartsell/contracts';
import { addDays, dayStart, localDay } from '../../analytics/shared.js';
import { campaignMatrix } from '../../campaign/coordination-operations.js';
import { today, type WorkspaceOverviewContext } from '../overview.js';
import { brandScope, timestamp } from '../shared.js';
import { activityItems, agentPresence, type Label } from './activity.js';
import { adsSummary } from './ads.js';
import { calendarEvents, previousPeriod, viewPeriod, type ViewPeriod } from './calendar.js';
import { decisionItems } from './decisions.js';
import { group, snapshot } from './products.js';
import { comparedDays, comparedSum, dailyPoints, socialModel, type Availability, type Cell, type Point } from './social.js';

// Read-model for the agent-first web view. Contract: docs/agent-first-design.md 3.1.
// KPIs, publications and spend reuse the social, calendar and ads read models so home matches those pages.
export interface Kpi {
  key: 'views' | 'engagements' | 'followers' | 'ad_spend' | 'orders'; value: number | null; availability: Availability;
  unit: 'count' | 'currency'; currency: string | null; previous_value: number | null; change_ratio: number | null; sparkline: Point[];
  by_currency?: unknown;
}

const DAY = 86_400_000;
const UPCOMING_DAYS = 90;
const ORDER_READ: readonly Role[] = ['owner', 'admin', 'manager', 'analyst'];
const CLOSED_PUBLICATION = ['published', 'expired', 'failed', 'cancel_requested', 'closed'];
const DECISION_KINDS = new Set(['approval', 'publish_due_today']);
const ALERT_PROVIDERS = new Set(['planning.missed', 'execution.attention', 'account.health', 'ingest.health', 'commerce.risks', 'campaign.risks', 'creator.due']);
const alertLabels: Record<string, Label> = {
  missed_publish: ['發布錯過排定時間', 'Publication missed its scheduled time'], outcome_unknown: ['發布結果未知', 'Publication outcome unknown'],
  failed: ['發布失敗', 'Publication failed'], connector_auto_halted: ['自動模式已緊急停止', 'Automatic mode emergency stop active'],
  account_emergency_stop: ['帳號自動模式已停止', 'Account automatic mode is stopped'], expired: ['授權已過期', 'Authorization expired'],
  sync_failed: ['資料同步失敗', 'Data synchronization failed'], sync_delayed: ['資料同步延遲', 'Data synchronization is delayed'],
  inventory_risk: ['庫存需要注意', 'Listing inventory requires attention'], milestone_delayed: ['里程碑延遲', 'Campaign milestone delayed'],
  deliverable_due: ['達人交付到期', 'Creator deliverable due'], terms_outdated: ['自動模式條款已更新', 'Automatic mode terms changed'],
};

function kpi(key: Kpi['key'], metric: Cell & { previous_value?: number | null; change_ratio?: number | null; currency?: string | null; by_currency?: unknown }, sparkline: Point[], unit: Kpi['unit'] = 'count'): Kpi {
  return { key, value: metric.value, availability: metric.availability, unit, currency: unit === 'currency' ? metric.currency ?? null : null,
    previous_value: metric.previous_value ?? null, change_ratio: metric.change_ratio ?? null, sparkline, ...(metric.by_currency ? { by_currency: metric.by_currency } : {}) };
}
const unavailable = (key: Kpi['key'], period: ViewPeriod, availability: Availability): Kpi =>
  kpi(key, { value: null, availability }, period.days.map(date => ({ date, value: null, availability })));

function socialKpis(ctx: Context, period: ViewPeriod, brand: string | undefined): Kpi[] {
  const social = socialModel(ctx, { period, brand_id: brand });
  // Followers add each account's latest level in each period; an account without a level before leaves the change unknown.
  return [
    kpi('views', social.total('views'), social.series('views')),
    kpi('engagements', social.total('engagements'), social.series('engagements')),
    kpi('followers', comparedSum(social.cards.map(card => card.followers)), social.series('followers')),
  ];
}

function adSpend(ctx: Context, period: ViewPeriod, brand: string | undefined): Kpi {
  const ads = adsSummary(ctx, { period, brand_id: brand });
  return kpi('ad_spend', ads.metrics.spend as Parameters<typeof kpi>[1], ads.series.spend, 'currency');
}

/** Order counts are known only between the first recorded order and the last time order data was recorded; outside that they stay unknown. */
function orderCount(ctx: Context, period: ViewPeriod, brand: string | undefined): Kpi {
  if (!ORDER_READ.includes(ctx.role)) return unavailable('orders', period, 'no_permission');
  const stores = new Set(ctx.list('store').filter(row => brand === undefined || row.brand_id === brand).map(row => row.id));
  const orders = ctx.list('order').filter(row => (brand === undefined || stores.has(String(row.store_id))) && Number.isFinite(timestamp(row.placed_at)));
  if (!orders.length) return unavailable('orders', period, 'not_collected');
  const { tz } = period;
  const at = orders.map(row => timestamp(row.placed_at));
  const placed = at.map(time => localDay(time, tz));
  const first = placed.reduce((min, day) => day < min ? day : min);
  const recorded = Math.min(timestamp(ctx.now), orders.reduce((max, row) => Math.max(max, timestamp(row.updated_at) || 0, timestamp(row.created_at) || 0, timestamp(row.placed_at)), 0));
  const fresh = localDay(recorded, tz);
  const counts = new Map<string, number>();
  for (const day of placed) counts.set(day, (counts.get(day) ?? 0) + 1);
  const cell = (day: string): Cell | undefined => day >= first && day <= fresh ? { value: counts.get(day) ?? 0, availability: 'observed' } : undefined;
  // The last recorded day (today, typically) is in only up to the time it was recorded. Its counterpart counts orders up to the
  // same time of day, so an unfinished day does not read as a drop against a whole one.
  const counterpart = addDays(fresh, -period.days.length);
  const cutoff = dayStart(counterpart, tz) + recorded - dayStart(fresh, tz);
  const before = (day: string): Cell | undefined => {
    const known = cell(day);
    return known && day === counterpart ? { ...known, value: at.filter((time, index) => placed[index] === day && time <= cutoff).length } : known;
  };
  return kpi('orders', comparedDays(period.days.map(cell), previousPeriod(period).days.map(before)), dailyPoints(period.days, cell));
}

function publications(ctx: Context, period: ViewPeriod, brand: string | undefined) {
  const events = calendarEvents(ctx, { period, kinds: ['publish', 'post'], brand_id: brand });
  const publish = events.filter(event => event.kind === 'publish' && event.status !== 'cancel_requested');
  const status = (name: string) => publish.filter(event => event.status === name || event.status?.startsWith(`${name}_`)).length;
  const now = localDay(timestamp(ctx.now), period.tz);
  const ahead = viewPeriod(ctx, { from: now, to: addDays(now, UPCOMING_DAYS - 1) }, UPCOMING_DAYS, period.tz);
  const upcoming = calendarEvents(ctx, { period: ahead, kinds: ['publish'], brand_id: brand })
    .filter(event => timestamp(event.starts_at) >= timestamp(ctx.now) && !CLOSED_PUBLICATION.includes(String(event.status))).slice(0, 8);
  return {
    scheduled: publish.length, published: status('published') + events.filter(event => event.kind === 'post').length,
    failed: status('failed'), outcome_unknown: status('outcome_unknown'), upcoming,
  };
}

/**
 * campaignMatrix filters whole tables for its campaign and checks every target against every post. Grouping those rows by
 * campaign once (keeping their order) hands each matrix only its own rows, so live plans do not rescan the workspace per plan.
 */
function matrixScopes(ctx: Context) {
  const own = new Map(['campaign_plan_slot', 'content_item', 'publish_target', 'campaign_gap_item'].map(kind => [kind, group(ctx.list(kind), row => row.campaign_id)] as const));
  const itemCampaign = new Map(ctx.list('content_item').map(row => [row.id, row.campaign_id]));
  own.set('content_variant', group(ctx.list('content_variant'), row => itemCampaign.get(String(row.content_item_id))));
  // A post counts for a campaign through its publish target, or through an existing execution task one of the campaign's targets names.
  const tasks = new Set(ctx.list('execution_task').map(row => row.id));
  const targetCampaign = new Map(ctx.list('publish_target').map(row => [row.id, row.campaign_id]));
  const taskCampaigns = group(ctx.list('publish_target').filter(row => tasks.has(String(row.execution_task_id))), row => String(row.execution_task_id));
  const posts = new Map<string, Row[]>();
  for (const post of ctx.list('platform_post')) {
    const campaigns = new Set([targetCampaign.get(String(post.publish_target_id)), ...(taskCampaigns.get(String(post.execution_task_id)) ?? []).map(row => row.campaign_id)]);
    for (const id of campaigns) if (typeof id === 'string') { const list = posts.get(id); if (list) list.push(post); else posts.set(id, [post]); }
  }
  own.set('platform_post', posts);
  return (campaign: Row): Context => ({ ...ctx, list: kind => { const rows = own.get(kind); return rows ? [...rows.get(campaign.id) ?? []] : ctx.list(kind); } });
}

function livePlans(ctx: Context, period: ViewPeriod, brand: string | undefined) {
  const live = ctx.list('campaign').filter(row => ['active', 'paused', 'wrapping'].includes(String(row.status)) && (brand === undefined || row.brand_id === brand) &&
    !(timestamp(row.starts_at) >= period.end) && !(timestamp(row.ends_at) < period.start));
  const scope = live.length ? matrixScopes(ctx) : () => ctx;
  return live.sort((a, b) => (timestamp(a.ends_at) || Infinity) - (timestamp(b.ends_at) || Infinity) || a.id.localeCompare(b.id))
    .map(row => {
      let planned: number | null = null, filled = 0, published: number | null = null;
      try {
        const { cells } = campaignMatrix(scope(row), row);
        planned = cells.reduce((sum, cell) => sum + (Number(cell.slot.planned_count) || 0), 0);
        filled = cells.reduce((sum, cell) => sum + Math.min(cell.actual.length, Number(cell.slot.planned_count) || 0), 0);
        published = cells.reduce((sum, cell) => sum + cell.counts.published, 0);
      } catch { planned = null; published = null; }
      const ends = timestamp(row.ends_at);
      return { id: row.id, name: row.name ?? null, status: row.status, starts_at: row.starts_at ?? null, ends_at: row.ends_at ?? null,
        days_left: Number.isFinite(ends) ? Math.max(0, Math.ceil((ends - timestamp(ctx.now)) / DAY)) : null,
        completeness_ratio: planned ? filled / planned : null, published, planned };
    });
}

async function alerts(ctx: Context, brand: string | undefined) {
  try {
    const result = await today(ctx as WorkspaceOverviewContext, { body: {}, params: {}, query: { ...(brand ? { brand_id: brand } : {}), limit: '100' } });
    return result.items.filter(item => ALERT_PROVIDERS.has(item.provider) && !DECISION_KINDS.has(item.kind) && item.severity !== 'info').slice(0, 20).map(item => ({
      kind: item.kind, severity: item.severity as 'blocker' | 'high' | 'normal', title: item.title, label: alertLabels[item.kind] ?? [item.title, item.title] as Label,
      resource: item.resource,
    }));
  } catch { return []; }
}

export async function home(raw: Context, { query }: Input) {
  // Every section below reads the same tables; one cached read per kind keeps this view one pass over the workspace.
  const ctx = snapshot(raw);
  const brand = brandScope(ctx, query.brand_id);
  const period = viewPeriod(ctx, query, 7);
  const decisions = decisionItems(ctx, { brand_id: brand });
  return {
    as_of: ctx.now, timezone: period.tz, period: { from: period.from, to: period.to },
    needs_you: { total: decisions.length, items: decisions.slice(0, 5) },
    this_week: publications(ctx, period, brand),
    kpis: [...socialKpis(ctx, period, brand), adSpend(ctx, period, brand), orderCount(ctx, period, brand)],
    live_plans: livePlans(ctx, period, brand),
    agent: { ...agentPresence(ctx), recent: activityItems(ctx, { actor: 'agent', limit: '6', ...(brand ? { brand_id: brand } : {}) }) },
    alerts: await alerts(ctx, brand),
  };
}

export const homeViewOperations: Operation[] = [
  { method: 'GET', path: '/views/home', name: 'views_home', roles: READ, summary: 'Overview of decisions, publications, KPIs, live plans and Agent activity',
    contract: { query: ['from', 'to', 'tz', 'brand_id'] }, run: home },
];
