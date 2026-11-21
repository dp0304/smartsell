import { Problem, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { attributionQuery } from '../analytics/commerce.js';
import { financialRoles } from '../analytics/metrics.js';
import { operations as contentOperations } from '../content/index.js';
import { operations as planningOperations } from '../planning/index.js';
import { phase } from '../commerce/domain.js';
import { COMMERCE_WRITE } from '../commerce/store-operations.js';
import { linkOperations, linkStats } from '../traffic/links.js';
import { addDependencies, canReadTask, createTask } from '../workspace/tasks.js';
import { approvedFacts } from './brief-operations.js';
import { campaignMarket, goalProgress } from './core.js';
import { CAMPAIGN, INTERNAL_READ, PLAN, array, campaign, choice, conflict, event, fields, flag, invalid, mutable, optionalText, optionalTimestamp, record, rows, scoped, strings, text, version } from './shared.js';

export async function applyCampaignPauseEvent(ctx: Context, envelope: Data): Promise<void> {
  const data = record(envelope.data, 'campaign status event');
  const campaign = ctx.get('campaign', text(data.campaign_id, 'campaign_id'));
  if (campaign.status !== data.to) return; // The event may arrive after a newer transition.
  const current = ctx.list('pause_switch').find(row => row.scope_type === 'campaign' && row.scope_id === campaign.id && !row.released_at);
  if (data.to === 'paused' && !current) {
    const activate = planningOperations.find(operation => operation.name === 'publishing_pause')!;
    const pause = await activate.run(ctx, { params: {}, query: {}, body: { scope_type: 'campaign', scope_id: campaign.id, reason: data.reason ?? 'Campaign paused', mode: 'hold' } }) as Row;
    ctx.update('pause_switch', pause.id, { campaign_transition_pause: true });
  }
  // Publishing owns release decisions: an operator uses its existing resume workflow for missed targets.
}

function campaignTasks(ctx: Context, campaignId: string): Row[] {
  return rows(ctx, 'work_item', 'campaign_id', campaignId).filter(task => canReadTask(ctx, task));
}
function pendingDependencies(ctx: Context, taskId: string): Row[] {
  const now = Date.parse(ctx.now);
  return rows(ctx, 'work_item_dependency', 'work_item_id', taskId).filter(edge => {
    const before = ctx.get('work_item', String(edge.depends_on_id));
    return before.status !== 'done' || (Number(edge.lag_hours ?? 0) > 0 && Date.parse(String(before.completed_at)) + Number(edge.lag_hours) * 3_600_000 > now);
  });
}
function taskView(ctx: Context, task: Row) {
  return { ...task, blocked: task.status === 'blocked' || pendingDependencies(ctx, task.id).length !== 0, dependencies: rows(ctx, 'work_item_dependency', 'work_item_id', task.id) };
}
function taskValues(ctx: Context, campaign: Row, body: Data, defaultKind: 'campaign_task' | 'campaign_milestone') {
  fields(body, ['title', 'kind', 'due_at', 'description', 'assignee_id', 'campaign_market_id', 'depends_on_ids', 'key', 'depends_on_keys', 'gate', 'priority']);
  const kind = choice(body.kind ?? defaultKind, ['campaign_task', 'campaign_milestone'], 'kind');
  const campaign_market_id = optionalText(body.campaign_market_id, 'campaign_market_id');
  if (campaign_market_id) scoped(ctx, 'campaign_market', campaign_market_id, 'campaign_id', campaign.id);
  const gate = body.gate == null ? null : choice(body.gate, ['ready_for_scheduling'], 'gate');
  if (gate && kind !== 'campaign_milestone') invalid('Only a milestone can carry a scheduling gate');
  const dependsOn = strings(body.depends_on_ids ?? [], 'depends_on_ids');
  for (const id of dependsOn) scoped(ctx, 'work_item', id, 'campaign_id', campaign.id);
  return {
    key: optionalText(body.key, 'key'), dependsOn, dependsOnKeys: strings(body.depends_on_keys ?? [], 'depends_on_keys'), kind, campaign_market_id, gate,
    body: {
      title: text(body.title, 'title', 200), type: kind === 'campaign_milestone' ? 'milestone' : 'production_task',
      description: optionalText(body.description, 'description', 4096), due_at: optionalTimestamp(body.due_at, 'due_at'),
      priority: choice(body.priority ?? 'normal', ['urgent', 'high', 'normal', 'low'], 'priority'),
      ...(body.assignee_id !== undefined ? { assignee_id: text(body.assignee_id, 'assignee_id') } : {}),
      brand_id: campaign.brand_id, campaign_id: campaign.id, resource_type: 'campaign', resource_id: campaign.id,
    },
  };
}
export function createCampaignTasks(ctx: Context, campaign: Row, raw: unknown, kind: 'campaign_task' | 'campaign_milestone' = 'campaign_task'): Row[] {
  const tasks = array(raw, 'tasks', 100).map(value => taskValues(ctx, campaign, record(value, 'task'), kind));
  if (!tasks.length) invalid('Provide at least one task');
  const keyed = new Set<string>();
  for (const task of tasks) {
    if (task.key && keyed.has(task.key)) invalid('Duplicate task key');
    if (task.key) keyed.add(task.key);
  }
  if (tasks.some(task => task.dependsOnKeys.some(key => !keyed.has(key)))) invalid('Unknown prerequisite task key');
  const created = tasks.map(task => {
    const row = createTask(ctx, { body: task.body, params: {}, query: {} });
    return ctx.update('work_item', row.id, { kind: task.kind, campaign_market_id: task.campaign_market_id, subject_ref: { type: 'campaign', id: campaign.id }, payload: task.gate ? { gate: task.gate } : {} });
  });
  const ids = new Map(tasks.flatMap((task, index) => task.key ? [[task.key, created[index]!.id]] : []));
  return tasks.map((task, index) => {
    const row = created[index]!;
    const depends_on_ids = [...new Set([...task.dependsOn, ...task.dependsOnKeys.map(key => ids.get(key)!)])];
    return depends_on_ids.length ? addDependencies(ctx, { params: { id: row.id }, body: { depends_on_ids }, query: {} }).work_item : row;
  });
}

export function checkMilestones(ctx: Context): string[] {
  const openCampaigns = new Set(ctx.list('campaign').filter(row => !['closed', 'cancelled'].includes(String(row.status))).map(row => row.id));
  const date = ctx.now.slice(0, 10);
  const prior = new Set(ctx.list('campaign_milestone_alert').filter(row => row.date === date).map(row => row.work_item_id));
  const alerted: string[] = [];
  for (const task of ctx.list('work_item')) {
    if (task.kind !== 'campaign_milestone' || !openCampaigns.has(String(task.campaign_id)) || ['done', 'cancelled'].includes(String(task.status)) || prior.has(task.id)) continue;
    const overdue = Date.parse(String(task.due_at)) < Date.parse(ctx.now);
    const blocked = task.status === 'blocked' || pendingDependencies(ctx, task.id).length > 0;
    if (!overdue && !blocked) continue;
    ctx.create('campaign_milestone_alert', { campaign_id: task.campaign_id, work_item_id: task.id, date });
    event(ctx, 'milestone.delayed', String(task.campaign_id), { work_item_id: task.id, overdue, blocked, due_at: task.due_at });
    alerted.push(task.id);
  }
  return alerted;
}

type Actual = { content_item_id: string; content_variant_id: string | null; publish_target_id: string | null; platform_post_ids: string[]; platform: unknown; social_account_id: unknown; market_id: unknown; locale: unknown; content_format: unknown; stage: unknown; scheduled_at: unknown; production_due_at: unknown; status: 'in_production' | 'scheduled' | 'published' | 'failed'; preferred_slot: unknown };
const formats: Record<string, string> = { image: 'feed_image', video: 'long_video', short: 'short_video' };
function matches(slot: Row, actual: Actual): boolean {
  if (actual.preferred_slot && actual.preferred_slot !== slot.id) return false;
  if (actual.stage && actual.stage !== slot.stage) return false;
  if (slot.platform !== actual.platform) return false;
  for (const key of ['social_account_id', 'market_id', 'locale', 'content_format'] as const) {
    if (slot[key] == null) continue;
    if (key === 'content_format') {
      if ((formats[String(slot[key])] ?? slot[key]) !== (formats[String(actual[key])] ?? actual[key])) return false;
    } else if (slot[key] !== actual[key]) return false;
  }
  const at = Date.parse(String(actual.scheduled_at));
  // A variant awaiting scheduling can fill planning capacity, while its production due date stays independent.
  if (actual.publish_target_id && (slot.window_start || slot.window_end) && !Number.isFinite(at)) return false;
  return !Number.isFinite(at) || ((!slot.window_start || at >= Date.parse(String(slot.window_start))) && (!slot.window_end || at <= Date.parse(String(slot.window_end))));
}
function actuals(ctx: Context, campaign: Row): { actual: Actual[]; unplanned_items: Row[] } {
  const items = rows(ctx, 'content_item', 'campaign_id', campaign.id).filter(row => row.production_stage !== 'archived' && !row.archived_at);
  const itemMap = new Map(items.map(row => [row.id, row]));
  const variants = ctx.list('content_variant').filter(row => itemMap.has(String(row.content_item_id)) && !row.archived_at);
  const variantMap = new Map(variants.map(row => [row.id, row]));
  const accounts = new Map(ctx.list('social_account').map(row => [row.id, row]));
  const tasks = new Map(ctx.list('execution_task').map(row => [row.id, row]));
  const posts = ctx.list('platform_post');
  const targets = rows(ctx, 'publish_target', 'campaign_id', campaign.id).filter(row => !['cancelled', 'superseded'].includes(String(row.plan_status ?? row.status)));
  const gaps = new Map(rows(ctx, 'campaign_gap_item', 'campaign_id', campaign.id).map(row => [row.content_item_id, row.slot_id]));
  const result: Actual[] = targets.map(target => {
    const variant = variantMap.get(String(target.content_variant_id));
    const item = itemMap.get(String(target.content_item_id ?? variant?.content_item_id));
    const account = accounts.get(String(target.social_account_id));
    const task = tasks.get(String(target.execution_task_id));
    const found = posts.filter(row => row.publish_target_id === target.id || (task && row.execution_task_id === task.id));
    const published = found.length > 0 || task?.status === 'published' || ['published', 'manual_done', 'matched_native'].includes(String(target.close_reason));
    const failed = ['failed', 'failed_final', 'expired_skipped'].some(status => [target.close_reason, task?.status, target.status].includes(status));
    return {
      content_item_id: String(target.content_item_id ?? variant?.content_item_id), content_variant_id: typeof target.content_variant_id === 'string' ? target.content_variant_id : null,
      publish_target_id: target.id, platform_post_ids: found.map(row => row.id), platform: account?.provider ?? account?.platform ?? variant?.platform ?? target.platform,
      social_account_id: target.social_account_id, market_id: target.market_id ?? variant?.market_id, locale: target.locale ?? variant?.locale,
      content_format: variant?.format ?? target.content_format, stage: target.campaign_stage ?? variant?.campaign_stage ?? item?.campaign_stage,
      scheduled_at: target.scheduled_at ?? null, production_due_at: item?.production_due_at ?? null,
      status: published ? 'published' : failed ? 'failed' : target.scheduled_at ? 'scheduled' : 'in_production', preferred_slot: gaps.get(item?.id),
    };
  });
  const targeted = new Set(result.map(row => row.content_variant_id));
  for (const variant of variants.filter(row => !targeted.has(row.id))) {
    const item = itemMap.get(String(variant.content_item_id))!;
    result.push({ content_item_id: item.id, content_variant_id: variant.id, publish_target_id: null, platform_post_ids: [],
      platform: variant.platform, social_account_id: variant.social_account_id, market_id: variant.market_id, locale: variant.locale,
      content_format: variant.format, stage: variant.campaign_stage ?? item.campaign_stage, scheduled_at: null,
      production_due_at: item.production_due_at ?? null, status: 'in_production', preferred_slot: gaps.get(item.id) });
  }
  const shown = new Set(result.map(row => row.content_item_id));
  return { actual: result, unplanned_items: items.filter(row => !shown.has(row.id)) };
}
export function campaignMatrix(ctx: Context, campaign: Row) {
  const slots = rows(ctx, 'campaign_plan_slot', 'campaign_id', campaign.id);
  const { actual, unplanned_items } = actuals(ctx, campaign);
  const outside: Actual[] = [];
  const allocated = new Map<string, Actual[]>();
  const specificity = (slot: Row) => ['social_account_id', 'market_id', 'locale', 'content_format', 'window_start', 'window_end'].filter(key => slot[key] != null).length;
  for (const row of actual) {
    const candidates = slots.filter(slot => matches(slot, row)).sort((a, b) => specificity(b) - specificity(a) || a.id.localeCompare(b.id));
    const slot = candidates.find(candidate => (allocated.get(candidate.id)?.length ?? 0) < Number(candidate.planned_count)) ?? candidates[0];
    if (!slot) { outside.push(row); continue; }
    const assigned = allocated.get(slot.id) ?? [];
    assigned.push(row);
    allocated.set(slot.id, assigned);
  }
  const cells = slots.map(slot => {
    const actual = allocated.get(slot.id) ?? [];
    const counts = { in_production: 0, scheduled: 0, published: 0, failed: 0 };
    for (const row of actual) counts[row.status]++;
    const planned = Number(slot.planned_count);
    return { slot, actual, counts, gap: Math.max(0, planned - actual.length), excess: Math.max(0, actual.length - planned) };
  });
  const duplicateTargets = new Map<string, string[]>();
  for (const row of actual.filter(row => row.publish_target_id)) {
    const key = JSON.stringify([row.content_variant_id, row.social_account_id, row.scheduled_at]);
    duplicateTargets.set(key, [...(duplicateTargets.get(key) ?? []), row.publish_target_id!]);
  }
  return { campaign_id: campaign.id, cells, outside_plan: outside, unplanned_items, duplicates: [...duplicateTargets.values()].filter(ids => ids.length > 1) };
}

const variantFormats = { instagram: 'feed_image', facebook: 'feed_image', tiktok: 'short_video', youtube: 'short_video', douyin: 'short_video', xiaohongshu: 'note', generic: 'text' } as const;
async function fillGaps(ctx: Context, campaign: Row, body: Data) {
  fields(body, ['dry_run', 'slot_ids', 'production_due_at']);
  const dry_run = flag(body.dry_run, 'dry_run', true);
  const productionDue = optionalTimestamp(body.production_due_at, 'production_due_at');
  const matrix = campaignMatrix(ctx, campaign);
  const slotIds = body.slot_ids === undefined ? matrix.cells.map(cell => cell.slot.id) : strings(body.slot_ids, 'slot_ids');
  const drafts = slotIds.flatMap(id => {
    const cell = matrix.cells.find(cell => cell.slot.id === id);
    if (!cell) return invalid('Unknown plan slot');
    if (cell.gap === 0) return [];
    const { slot } = cell;
    if (cell.gap > 100) invalid('Reduce planned count or fill the slot in smaller plans');
    const market = typeof slot.market_id === 'string' ? campaignMarket(ctx, campaign.id, slot.market_id) : null;
    const platform = choice(slot.platform, Object.keys(variantFormats) as (keyof typeof variantFormats)[], 'platform');
    const locale = slot.locale ?? (market?.locales as string[] | undefined)?.[0] ?? 'und';
    return Array.from({ length: cell.gap }, (_, index) => ({
      slot_id: slot.id,
      content: {
        brand_id: campaign.brand_id, campaign_id: campaign.id, title: `${String(campaign.name).slice(0, 140)} – ${slot.stage} ${platform} ${cell.actual.length + index + 1}`,
        owner_user_id: slot.owner_user_id, production_due_at: productionDue,
        variants: [{ platform, format: formats[String(slot.content_format)] ?? slot.content_format ?? variantFormats[platform], locale, market_id: slot.market_id, social_account_id: slot.social_account_id }],
      },
      task: { title: `${platform} ${slot.stage} production`, due_at: productionDue, campaign_market_id: market?.id ?? null, ...(slot.owner_user_id ? { assignee_id: slot.owner_user_id } : {}) },
    }));
  });
  if (drafts.length > 100) invalid('Select up to 100 gaps per request');
  if (dry_run) return { dry_run, drafts };
  const write = contentOperations.find(operation => operation.name === 'content_create_draft');
  if (!write) throw new Problem(503, 'integration_unavailable', 'Content draft creation is unavailable');
  const created = [];
  for (const draft of drafts) {
    const result = await write.run(ctx, { params: {}, query: {}, body: draft.content }) as Row | { item: Row };
    const item = ('item' in result ? result.item : result) as Row;
    const [task] = createCampaignTasks(ctx, campaign, [draft.task]);
    ctx.create('campaign_gap_item', { campaign_id: campaign.id, slot_id: draft.slot_id, content_item_id: item.id, work_item_id: task!.id });
    created.push({ slot_id: draft.slot_id, content_item_id: item.id, work_item_id: task!.id });
  }
  return { dry_run, created };
}

function campaignProductRisks(ctx: Context, campaignId: string): Data[] {
  const links = rows(ctx, 'campaign_product', 'campaign_id', campaignId);
  const products = new Map(ctx.list('product').map(product => [product.id, product]));
  const changes = ctx.list('change_event').filter(change => change.status === 'open' && ['blocking', 'review'].includes(String(change.severity)));
  return links.flatMap(link => {
    const product = products.get(String(link.product_id));
    const risks: Data[] = [];
    if (!product || ['removed_at_source', 'archived'].includes(String(product.status))) {
      risks.push({ product_id: link.product_id, status: product?.status ?? 'unavailable' });
    }
    for (const change of changes) {
      if (change.product_id !== link.product_id) continue;
      if (change.variant_id && Array.isArray(link.variant_ids) && !link.variant_ids.includes(change.variant_id)) continue;
      if (change.market_id && Array.isArray(link.market_ids) && !link.market_ids.includes(change.market_id)) continue;
      risks.push({ product_id: link.product_id, variant_id: change.variant_id, market_id: change.market_id,
        change_event_id: change.id, status: change.change_type, severity: change.severity });
    }
    return risks;
  });
}

export const coordinationOperations: Operation[] = [
  { method: 'GET', path: CAMPAIGN, name: 'campaign_get_context', roles: INTERNAL_READ, summary: 'Read goals, product facts, approved briefs, schedule and production progress', run(ctx, input) {
    const row = campaign(ctx, input);
    const { actual, unplanned_items } = actuals(ctx, row);
    const tasks = campaignTasks(ctx, row.id);
    return { ...row,
      markets: rows(ctx, 'campaign_market', 'campaign_id', row.id), products: rows(ctx, 'campaign_product', 'campaign_id', row.id), approved_facts: approvedFacts(ctx, row.id),
      goals: rows(ctx, 'campaign_goal', 'campaign_id', row.id).map(goal => ({ ...goal, progress: goalProgress(ctx, goal, row) })),
      briefs: rows(ctx, 'brief', 'campaign_id', row.id).map(brief => ({ ...brief, approved_revision: typeof brief.approved_revision_id === 'string' ? ctx.get('brief_revision', brief.approved_revision_id) : null })),
      plan_slots: rows(ctx, 'campaign_plan_slot', 'campaign_id', row.id),
      progress: { production_tasks: tasks.length, completed_tasks: tasks.filter(task => task.status === 'done').length, publish_targets: actual.filter(row => row.publish_target_id).length, published: actual.filter(row => row.status === 'published').length, failed: actual.filter(row => row.status === 'failed').length, unplanned_content: unplanned_items.length },
      calendar: { production: tasks.map(task => ({ work_item_id: task.id, due_at: task.due_at })), publication: actual.filter(row => row.publish_target_id).map(row => ({ publish_target_id: row.publish_target_id, scheduled_at: row.scheduled_at, status: row.status })) },
      product_risks: campaignProductRisks(ctx, row.id),
    };
  } },
  { method: 'GET', path: `${CAMPAIGN}/matrix`, name: 'campaign_matrix', roles: INTERNAL_READ, summary: 'Compare content and publish targets to campaign plan slots', run: (ctx, input) => campaignMatrix(ctx, campaign(ctx, input)) },
  { method: 'POST', path: `${CAMPAIGN}/matrix/gaps/create-items`, name: 'campaign_create_gap_items', roles: PLAN, summary: 'Preview or create content and work items to fill plan gaps', run(ctx, input) {
    const row = campaign(ctx, input); mutable(row);
    return fillGaps(ctx, row, input.body);
  } },
  { method: 'GET', path: `${CAMPAIGN}/milestones`, name: 'campaign_milestone_list', roles: INTERNAL_READ, summary: 'Read production milestones and prerequisite status', run(ctx, input) {
    return campaignTasks(ctx, campaign(ctx, input).id).filter(row => row.kind === 'campaign_milestone').map(row => taskView(ctx, row));
  } },
  { method: 'POST', path: `${CAMPAIGN}/milestones`, name: 'campaign_milestone_create', roles: PLAN, summary: 'Add a production milestone in Workspace', run(ctx, input) {
    const row = campaign(ctx, input); mutable(row);
    if (input.body.kind !== undefined && input.body.kind !== 'campaign_milestone') invalid('Use the task endpoint for other work items');
    return createCampaignTasks(ctx, row, [input.body], 'campaign_milestone')[0];
  } },
  { method: 'POST', path: `${CAMPAIGN}/tasks`, name: 'campaign_create_tasks', roles: PLAN, summary: 'Create dependent production work items in Workspace', run(ctx, input) {
    const row = campaign(ctx, input); mutable(row);
    fields(input.body, ['tasks', 'campaign_id']);
    if (input.body.campaign_id !== undefined && input.body.campaign_id !== row.id) invalid('campaign_id does not match the route');
    return createCampaignTasks(ctx, row, input.body.tasks);
  } },
  { method: 'GET', path: `${CAMPAIGN}/tracking-summary`, name: 'campaign_tracking_summary', roles: INTERNAL_READ, summary: 'List campaign tracking resources and separate redirects from observed coupon uses', run(ctx, input) {
    const campaignId = campaign(ctx, input).id;
    const links = rows(ctx, 'short_link', 'campaign_id', campaignId);
    const clicks = linkStats(ctx, new Set(links.map(link => link.id)), {});
    const content_items = rows(ctx, 'content_item', 'campaign_id', campaignId).filter(item => !item.removed_at)
      .map(({ id, title, production_stage, campaign_id }) => ({ id, title, production_stage, campaign_id }));
    const commercePhase = phase(ctx);
    const canSeePromotions = COMMERCE_WRITE.some(role => role === ctx.role) && (commercePhase === 'p1' || commercePhase === 'p2');
    const promotions = canSeePromotions ? rows(ctx, 'promotion', 'campaign_id', campaignId) : [];
    const counts = new Map(promotions.map(promo => [promo.id, 0]));
    if (counts.size) for (const usage of ctx.list('discount_usage')) {
      const id = String(usage.promotion_id);
      if (counts.has(id)) counts.set(id, counts.get(id)! + 1);
    }
    return { campaign_id: campaignId, links, clicks, content_items,
      promotions: promotions.map(({ id, name }) => ({ promotion_id: id, name, observed_usage_count: counts.get(id)! })),
      observed_coupon_usage_count: canSeePromotions ? [...counts.values()].reduce((total, count) => total + count, 0) : null };
  } },
  { method: 'GET', path: `${CAMPAIGN}/links`, name: 'campaign_link_list', roles: PLAN, summary: 'List this campaign’s short links', run: (ctx, input) => rows(ctx, 'short_link', 'campaign_id', campaign(ctx, input).id) },
  { method: 'POST', path: `${CAMPAIGN}/links`, name: 'campaign_link_create', roles: PLAN, summary: 'Create a Traffic short link with the immutable campaign UTM key', async run(ctx, input) {
    const row = campaign(ctx, input); mutable(row);
    const body = input.body;
    fields(body, ['domain_id', 'code', 'destination_url', 'landing_destination_id', 'product_variant_id', 'market_id', 'market_routes', 'fallback_url', 'expires_at', 'content_item_id', 'publish_target_id', 'collaboration_id', 'utm_template_id', 'utm_params', 'variables']);
    for (const [field, kind] of [['content_item_id', 'content_item'], ['publish_target_id', 'publish_target'], ['collaboration_id', 'collaboration']] as const) {
      if (body[field] != null) scoped(ctx, kind, text(body[field], field), 'campaign_id', row.id);
    }
    if (body.market_id != null) campaignMarket(ctx, row.id, text(body.market_id, 'market_id'));
    for (const item of array(body.market_routes ?? [], 'market_routes', 20)) campaignMarket(ctx, row.id, text(record(item, 'market route').market_id, 'market_id'));
    if (body.product_variant_id != null) {
      const variant = ctx.get('product_variant', text(body.product_variant_id, 'product_variant_id'));
      if (!rows(ctx, 'campaign_product', 'campaign_id', row.id).some(product => product.product_id === variant.product_id
        && (!Array.isArray(product.variant_ids) || product.variant_ids.includes(variant.id))
        && (!body.market_id || !Array.isArray(product.market_ids) || product.market_ids.includes(body.market_id)))) invalid('Product variant is outside the campaign scope');
    }
    const { utm_template_id, variables, utm_params, ...rest } = body;
    if (utm_template_id !== undefined && utm_params !== undefined) invalid('Select UTM parameters or a UTM template');
    let params = record(utm_params ?? {}, 'utm_params');
    if (utm_template_id !== undefined) {
      const preview = linkOperations.find(operation => operation.name === 'utm_build')!;
      const result = await preview.run(ctx, { params: {}, query: {}, body: { utm_template_id, variables: { ...record(variables ?? {}, 'variables'), 'campaign.slug': row.utm_key } } }) as Data;
      params = record(result.utm_params, 'utm_params');
    }
    const create = linkOperations.find(operation => operation.name === 'links_create')!;
    return create.run(ctx, { params: {}, query: {}, idempotencyKey: input.idempotencyKey, body: { ...rest, campaign_id: row.id, brand_id: row.brand_id, utm_params: { ...params, utm_campaign: row.utm_key } } });
  } },
  { method: 'GET', path: `${CAMPAIGN}/attribution`, name: 'campaign_attribution_compare', roles: financialRoles, summary: 'Compare Analytics attribution models for this campaign', run(ctx, input) {
    const row = campaign(ctx, input);
    const from = input.query.from ?? row.starts_at;
    const to = input.query.to ?? row.ends_at ?? ctx.now;
    if (!from) invalid('Provide from or configure a campaign start');
    const models = input.query.models?.split(',').map(model => model.trim());
    return attributionQuery(ctx, { from, to, tz: row.timezone, models, store_id: input.query.store_id, subject: { type: 'campaign', id: row.id } });
  } },
  { method: 'GET', path: `${CAMPAIGN}/tracking-config`, name: 'campaign_tracking_get', roles: INTERNAL_READ, summary: 'Read configured conversions and attribution window', run: (ctx, input) => rows(ctx, 'tracking_config', 'campaign_id', campaign(ctx, input).id)[0] ?? null },
  { method: 'PUT', path: `${CAMPAIGN}/tracking-config`, name: 'campaign_tracking_set', roles: PLAN, versionKind: 'campaign', summary: 'Set conversion definitions and verified campaign landing targets', run(ctx, input) {
    const row = campaign(ctx, input); mutable(row); version(row, input);
    const body = input.body;
    fields(body, ['conversion_goals', 'default_attribution_window_days', 'landing_targets', 'expected_version']);
    const conversion_goals = strings(body.conversion_goals, 'conversion_goals').map(goal => choice(goal, ['order', 'lead', 'signup'], 'conversion goal'));
    const landing_targets = array(body.landing_targets ?? [], 'landing_targets').map(value => {
      const target = record(value, 'landing target');
      fields(target, ['type', 'id']);
      const type = choice(target.type, ['short_link', 'landing_page'], 'landing target type');
      const id = text(target.id, 'landing target id');
      if (type === 'short_link') scoped(ctx, type, id, 'campaign_id', row.id);
      else scoped(ctx, type, id, 'brand_id', String(row.brand_id));
      return { type, id };
    });
    if (new Set(landing_targets.map(item => `${item.type}:${item.id}`)).size !== landing_targets.length) conflict('Landing targets must be unique');
    const window = body.default_attribution_window_days;
    if (typeof window !== 'number' || !Number.isInteger(window) || window < 1 || window > 365) invalid('Attribution window must be 1–365 days');
    const prior = rows(ctx, 'tracking_config', 'campaign_id', row.id)[0];
    const data = { campaign_id: row.id, conversion_goals, default_attribution_window_days: window, landing_targets };
    const saved = prior ? ctx.update('tracking_config', prior.id, data) : ctx.create('tracking_config', data);
    const changed = ctx.update('campaign', row.id, {});
    event(ctx, 'campaign.updated', row.id, { field: 'tracking_config', version: changed.version });
    return { ...saved, campaign_version: changed.version };
  } },
];
