import { Problem, READ, type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';
import { operations as adsOperations } from '../../ads/workspace-operations.js';
import { coordinationOperations, campaignMatrix } from '../../campaign/coordination-operations.js';
import { STATUSES, goalProgress } from '../../campaign/core.js';
import { INTERNAL_READ } from '../../campaign/shared.js';
import { budgetSummary } from '../../campaign/spend-operations.js';
import { brandScope, invalid } from '../shared.js';
import { pendingDecisions } from './decisions.js';
import { activeVariants, catalogIndex, createdVia, group, snapshot, stockSummary, time, type CatalogIndex } from './products.js';

// Read-model for the agent-first web view. Contract: docs/agent-first-design.md 3.3.
const DAY = 86_400_000;
const statusOrder = ['active', 'paused', 'wrapping', 'planned', 'draft', 'closed', 'cancelled'];
const INACTIVE_TARGET = ['cancelled', 'superseded'];
const severityRank: Record<string, number> = { blocking: 0, review: 1 };
const closeReasons: Record<string, string> = { matched_native: 'published', manual_done: 'published', published: 'published', expired_skipped: 'expired', failed_final: 'failed' };

/** Execution tasks and unresolved attempts keyed for planning display status without per-target scans. */
export function executionIndex(ctx: Context) {
  const tasks = new Map<string, Row>();
  for (const row of ctx.list('execution_task')) if (typeof row.publish_target_id === 'string' && !tasks.has(row.publish_target_id)) tasks.set(row.publish_target_id, row);
  const byId = new Map(ctx.list('execution_task').map(row => [row.id, row]));
  const unresolved = new Set(ctx.list('execution_attempt').filter(row => row.status === 'unknown' && row.side_effect_possible !== false).map(row => String(row.task_id ?? row.execution_task_id)));
  return { unresolved, taskFor(target: Row) {
    const linked = byId.get(String(target.execution_task_id));
    return linked?.publish_target_id === target.id ? linked : tasks.get(target.id);
  } };
}
/** Same derivation as the planning module's calendar display status (not exported there). */
export function displayStatus(target: Row, execution: ReturnType<typeof executionIndex>): string {
  const task = execution.taskFor(target);
  if (target.plan_status === 'cancel_requested') return 'cancel_requested';
  const pending = Array.isArray(task?.pending_side_effects) && task.pending_side_effects.length > 0;
  if (task && (task.status === 'outcome_unknown' || execution.unresolved.has(task.id) || pending && task.status === 'manual')) return 'outcome_unknown';
  if (target.plan_status === 'closed') return closeReasons[String(target.close_reason)] ?? String(task?.status ?? target.close_reason ?? 'closed');
  if (target.plan_status === 'ready') return ['queued', 'running', 'accepted'].includes(String(task?.status)) ? 'executing' : String(task?.status ?? 'scheduled');
  return String(target.plan_status ?? target.status ?? 'draft');
}

function localDay(at: number, timeZone: string) {
  try { return new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at)); }
  catch { return new Date(at).toISOString().slice(0, 10); }
}
/** Day N of M in the campaign's own calendar; null before it starts or when the period is incomplete. */
function campaignDays(campaign: Row, now: number) {
  const start = time(campaign.starts_at), end = time(campaign.ends_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return { day: null, days: null };
  const tz = String(campaign.timezone ?? 'UTC');
  const index = (at: number) => Date.parse(`${localDay(at, tz)}T00:00:00Z`) / DAY;
  const first = index(start), days = index(end - 1) - first + 1, today = index(now) - first + 1;
  return { day: today < 1 ? null : Math.min(today, days), days };
}

/** Request-scoped lookups shared by every plan card. */
function planContext(ctx: Context, index: CatalogIndex = catalogIndex(ctx)) {
  const proposals = adsRead(ctx, 'ads_list_proposals');
  const targets = group(ctx.list('publish_target').filter(row => !INACTIVE_TARGET.includes(String(row.plan_status))), row => row.campaign_id);
  const goals = group(ctx.list('campaign_goal').filter(row => row.status === 'active'), row => row.campaign_id);
  const links = group(ctx.list('campaign_product'), row => row.campaign_id);
  const approvals = new Map(ctx.list('approval_request').map(row => [row.id, row]));
  const execution = executionIndex(ctx);
  const items = new Map(ctx.list('content_item').map(row => [row.id, row]));
  // The card links to /decisions?campaign=, so it counts with that list's own rules (role-visible kinds, expiry, current revisions).
  const decisions = group(pendingDecisions(ctx), row => row.campaign_id);
  const changes = ctx.list('change_event').filter(row => row.status === 'open' && Object.hasOwn(severityRank, String(row.severity)));
  const approval = (target: Row) => target.plan_status === 'awaiting_approval' && approvals.get(String(target.approval_request_id))?.status === 'pending';
  return {
    index, execution, items, changes, proposals, approval,
    targets: (campaignId: string) => targets.get(campaignId) ?? [],
    goals: (campaignId: string) => goals.get(campaignId) ?? [],
    links: (campaignId: string) => links.get(campaignId) ?? [],
    decisions: (campaignId: string) => decisions.get(campaignId)?.length ?? 0,
  };
}
type PlanContext = ReturnType<typeof planContext>;

/** Reads ads through the ads operation's own account scope so non-admins see only granted accounts. */
function adsRead(ctx: Context, name: 'ads_list_proposals' | 'ads_query_performance', query: Record<string, string> = {}) {
  const operation = adsOperations.find(item => item.name === name);
  if (!operation || !operation.roles.includes(ctx.role)) return undefined;
  const input: Input = { body: {}, params: {}, query };
  const scoped = operation.scopeContext?.(ctx, input) ?? ctx;
  return { scoped, rows: name === 'ads_list_proposals' ? scoped.list('ad_proposal') : [], run: () => operation.run(scoped, input) as Data };
}

function goals(ctx: Context, campaign: Row, plan: PlanContext) {
  return plan.goals(campaign.id).map(goal => {
    let progress: Data;
    try { progress = goalProgress(ctx, goal, campaign); }
    catch (error) {
      if (!(error instanceof Problem)) throw error;
      progress = { value: null, progress_percent: null, coverage: { status: 'unavailable' } };
    }
    return { goal_id: goal.id, metric_key: goal.metric_key, unit: goal.unit, currency: goal.currency ?? null, target_value: goal.target_value ?? null, due_at: goal.due_at ?? null,
      value: typeof progress.value === 'number' ? progress.value : null, progress_percent: typeof progress.progress_percent === 'number' ? progress.progress_percent : null,
      coverage_status: String((progress.coverage as Data | undefined)?.status ?? 'unknown') };
  });
}

function matrixSummary(matrix: ReturnType<typeof campaignMatrix>) {
  const totals = { planned: 0, filled: 0, published: 0, scheduled: 0, in_production: 0, failed: 0, gap: 0 };
  for (const cell of matrix.cells) {
    const planned = Number(cell.slot.planned_count) || 0;
    totals.planned += planned;
    totals.filled += Math.min(cell.actual.length, planned);
    totals.gap += cell.gap;
    for (const key of ['published', 'scheduled', 'in_production', 'failed'] as const) totals[key] += cell.counts[key];
  }
  return { ...totals, completeness_ratio: totals.planned ? totals.filled / totals.planned : null,
    outside_plan: matrix.outside_plan.length, unplanned_items: matrix.unplanned_items.length };
}

function products(campaign: Row, plan: PlanContext) {
  const { index } = plan;
  return plan.links(campaign.id).map(link => {
    const product = index.products.get(String(link.product_id));
    const variants = activeVariants(index, String(link.product_id)).filter(row => !Array.isArray(link.variant_ids) || link.variant_ids.includes(row.id));
    const markets = Array.isArray(link.market_ids) ? link.market_ids : null;
    const listings = variants.flatMap(variant => {
      const found = (index.listings.get(variant.id) ?? []).filter(row => !markets || markets.includes(row.market_id));
      return found.length ? found : [undefined];
    });
    const risk = plan.changes.filter(row => row.product_id === link.product_id && (!row.variant_id || !Array.isArray(link.variant_ids) || link.variant_ids.includes(row.variant_id))
      && (!row.market_id || !markets || markets.includes(row.market_id))).sort((a, b) => severityRank[String(a.severity)]! - severityRank[String(b.severity)]!)[0];
    return { product_id: link.product_id, title: product?.title ?? null, role: link.role ?? null, stock_status: stockSummary(listings).status,
      risk: risk ? { severity: risk.severity, change_type: risk.change_type, change_event_id: risk.id } : null };
  });
}

function planCard(ctx: Context, campaign: Row, plan: PlanContext, matrix = campaignMatrix(ctx, campaign)) {
  const now = time(ctx.now);
  const targets = plan.targets(campaign.id);
  const next = targets.filter(row => !['closed', 'cancel_requested'].includes(String(row.plan_status)) && time(row.scheduled_at) >= now).sort((a, b) => time(a.scheduled_at) - time(b.scheduled_at))[0];
  return {
    id: campaign.id, name: campaign.name ?? null, kind: campaign.kind ?? null, status: campaign.status ?? null, brand_id: campaign.brand_id ?? null,
    starts_at: campaign.starts_at ?? null, ends_at: campaign.ends_at ?? null, timezone: campaign.timezone ?? null, ...campaignDays(campaign, now),
    goals: goals(ctx, campaign, plan),
    matrix: matrixSummary(matrix),
    // Same roles as campaign_budget_summary. Actuals are final only once closeout has reconciled costs.
    budget: INTERNAL_READ.some(role => role === ctx.role) ? budgetSummary(ctx, campaign.id).currencies.map(row => ({
      currency: row.currency, budget_minor: row.budget_minor, committed_minor: row.committed_minor, actual_minor: row.actual_minor,
      remaining_minor: row.remaining_minor, overrun_minor: row.overrun_minor, actual_complete: campaign.status === 'closed' })) : { visible: false },
    products: products(campaign, plan),
    next_publication: next ? { publish_target_id: next.id, scheduled_at: next.scheduled_at, title: next.title ?? plan.items.get(String(next.content_item_id))?.title ?? null } : null,
    needs_decision: plan.decisions(campaign.id),
    created_via: createdVia(campaign), as_of: ctx.now,
  };
}

/** Plan cards for already-selected campaigns, sharing one set of lookups. */
export function planCards(ctx: Context, campaigns: Row[], index?: CatalogIndex) {
  const plan = planContext(ctx, index);
  return campaigns.map(row => planCard(ctx, row, plan));
}

function listPlans(raw: Context, { query }: Input) {
  const ctx = snapshot(raw);
  const brand = brandScope(ctx, query.brand_id);
  const statuses = query.status?.split(',').map(value => value.trim()).filter(Boolean);
  if (statuses?.some(value => !(STATUSES as readonly string[]).includes(value))) invalid(`status must be one of ${STATUSES.join(', ')}`);
  const campaigns = ctx.list('campaign').filter(row => (brand === undefined || row.brand_id === brand) && (!statuses?.length || statuses.includes(String(row.status))))
    .sort((a, b) => statusOrder.indexOf(String(a.status)) - statusOrder.indexOf(String(b.status)) || (time(a.starts_at) || Infinity) - (time(b.starts_at) || Infinity)
      || String(a.name).localeCompare(String(b.name)) || a.id.localeCompare(b.id));
  return planCards(ctx, campaigns);
}

function adsFor(ctx: Context, campaign: Row, plan: PlanContext) {
  const scoped = plan.proposals?.scoped;
  const proposals = (plan.proposals?.rows ?? []).filter(row => row.campaign_id === campaign.id).map(row => {
    const find = (kind: string, id: unknown) => {
      try { return typeof id === 'string' ? scoped!.get(kind, id) : undefined; }
      catch (error) { if (error instanceof Problem && error.status === 404) return undefined; throw error; }
    };
    const revision = find('ad_proposal_revision', row.current_revision_id);
    const schedule = revision?.schedule as Data | undefined, budget = revision?.budget as Data | undefined;
    return { id: row.id, name: row.name ?? null, status: row.status ?? null, campaign_id: row.campaign_id ?? null, ad_account_id: row.ad_account_id ?? null,
      schedule: schedule ? { starts_at: schedule.starts_at ?? null, ends_at: schedule.ends_at ?? null, tz: schedule.tz ?? null } : null,
      budget: budget ? { type: budget.type ?? null, amount_minor: budget.amount_minor ?? null, currency: budget.currency ?? null } : null,
      estimates: (Array.isArray(revision?.estimates) ? revision.estimates as Data[] : []).map(item => ({ metric: item.metric, value: item.value, source: item.source })),
      approval_status: find('ad_approval_request', row.approval_request_id)?.status ?? null, created_via: createdVia(row) };
  });
  // Report coverage over the elapsed part of the flight so unreported days stay visible.
  const tz = String(campaign.timezone ?? 'UTC'), now = time(ctx.now), start = time(campaign.starts_at);
  const until = Math.min(now, time(campaign.ends_at) - 1);
  const window: Record<string, string> = Number.isFinite(start) && start <= until && until - start <= 366 * DAY ? { from: localDay(start, tz), until: localDay(until, tz) } : {};
  let spend: Data[] = [];
  try {
    const pacing = adsRead(ctx, 'ads_query_performance', { campaign_id: campaign.id, ...window })?.run().pacing;
    spend = (Array.isArray(pacing) ? pacing as Data[] : []).map(row => ({ campaign_id: campaign.id, currency: row.currency, budget_minor: row.budget_minor ?? null,
      actual_spend_minor: row.actual_spend_minor ?? null, coverage_ratio: row.coverage_ratio ?? null, delayed: row.delayed ?? null }));
  } catch (error) { if (!(error instanceof Problem)) throw error; }
  return { proposals, spend };
}

function planDetail(raw: Context, { params }: Input) {
  const ctx = snapshot(raw);
  const campaign = ctx.get('campaign', params.id!);
  const plan = planContext(ctx);
  const matrix = campaignMatrix(ctx, campaign);
  const card = planCard(ctx, campaign, plan, matrix);
  const accounts = new Map(ctx.list('social_account').map(row => [row.id, row]));
  const platform = (row: Row) => { const account = accounts.get(String(row.social_account_id)); return account?.provider ?? account?.platform ?? row.platform ?? null; };
  const targets = plan.targets(campaign.id);
  const targetIds = new Set(targets.map(row => row.id));
  const items = [...plan.items.values()].filter(row => row.campaign_id === campaign.id && row.production_stage !== 'archived' && !row.archived_at);
  const milestones = (coordinationOperations.find(op => op.name === 'campaign_milestone_list')!.run(ctx, { body: {}, params: { id: campaign.id }, query: {} }) as Row[])
    .map(row => ({ id: row.id, title: row.title ?? null, due_at: row.due_at ?? null, status: row.status ?? null, blocked: row.blocked === true }));
  const ads = adsFor(ctx, campaign, plan);
  const base = { brand_id: campaign.brand_id ?? null, campaign_id: campaign.id, social_account_id: null, platform: null, permalink: null, needs_human: null, all_day: false, ends_at: null };
  const events = [
    { ...base, id: `plan:${campaign.id}`, kind: 'plan', starts_at: campaign.starts_at ?? null, ends_at: campaign.ends_at ?? null, title: campaign.name ?? null, status: campaign.status ?? null, resource: { type: 'campaign', id: campaign.id } },
    ...milestones.filter(row => row.due_at).map(row => ({ ...base, id: `milestone:${row.id}`, kind: 'milestone', starts_at: row.due_at, title: row.title, status: row.status, resource: { type: 'work_item', id: row.id } })),
    ...items.filter(row => row.production_due_at).map(row => ({ ...base, id: `production_due:${row.id}`, kind: 'production_due', starts_at: row.production_due_at, title: row.title ?? null, status: row.production_stage ?? null, resource: { type: 'content_item', id: row.id } })),
    ...targets.filter(row => row.scheduled_at).flatMap(row => {
      const status = displayStatus(row, plan.execution);
      if (status === 'published') return [];
      const needs_human = plan.approval(row) ? 'approval' : plan.execution.taskFor(row)?.sub_status === 'late_awaiting_decision' ? 'late_decision' : status === 'outcome_unknown' ? 'outcome_unknown' : null;
      return [{ ...base, id: `publish:${row.id}`, kind: 'publish', starts_at: row.scheduled_at, title: row.title ?? plan.items.get(String(row.content_item_id))?.title ?? null, status,
        platform: platform(row), social_account_id: row.social_account_id ?? null, needs_human, resource: { type: 'publish_target', id: row.id } }];
    }),
    ...ctx.list('platform_post').filter(row => row.published_at && (targetIds.has(String(row.publish_target_id)) || row.campaign_id === campaign.id)).map(row => ({ ...base, id: `post:${row.id}`, kind: 'post',
      starts_at: row.published_at, title: row.caption_snapshot ?? null, status: row.post_status ?? row.verification ?? null, platform: row.provider ?? platform(row),
      social_account_id: row.social_account_id ?? null, permalink: row.permalink ?? null, resource: { type: 'platform_post', id: row.id } })),
    ...ads.proposals.filter(row => row.schedule?.starts_at).map(row => ({ ...base, id: `ad_flight:${row.id}`, kind: 'ad_flight', starts_at: row.schedule!.starts_at, ends_at: row.schedule!.ends_at,
      title: row.name, status: row.status, resource: { type: 'ad_proposal', id: row.id } })),
  ].sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)) || a.id.localeCompare(b.id));
  return {
    ...card, events,
    cells: matrix.cells.map(cell => {
      const account = accounts.get(String(cell.slot.social_account_id));
      return { slot_id: cell.slot.id, stage: cell.slot.stage ?? null, platform: cell.slot.platform ?? null, social_account_id: cell.slot.social_account_id ?? null,
        account_name: account?.display_name ?? account?.handle ?? null, market_id: cell.slot.market_id ?? null, planned_count: Number(cell.slot.planned_count) || 0, ...cell.counts, gap: cell.gap };
    }),
    milestones,
    content: items.map(item => ({ content_item_id: item.id, title: item.title ?? null, production_stage: item.production_stage ?? null, production_due_at: item.production_due_at ?? null,
      created_via: createdVia(item), targets: targets.filter(row => row.content_item_id === item.id).map(row => ({ id: row.id, platform: platform(row), social_account_id: row.social_account_id ?? null,
        scheduled_at: row.scheduled_at ?? null, display_status: displayStatus(row, plan.execution) })) })),
    ads,
  };
}

const query = ['brand_id', 'status'] as const;
export const campaignsViewOperations: Operation[] = [
  { method: 'GET', path: '/views/plans', name: 'views_plans_list', roles: READ, contract: { query },
    summary: 'Promotion plan cards with goals, content matrix, budget, products, next publication and pending decisions', run: listPlans },
  { method: 'GET', path: '/views/plans/:id', name: 'views_plan_get', roles: READ,
    summary: 'Promotion plan with calendar events, matrix cells, milestones, content and advertising', run: planDetail },
];
