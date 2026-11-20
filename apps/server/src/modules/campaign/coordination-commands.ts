import type { Commands, Context, Entity, Fields } from '../types.ts';
import { command, emit, expected, fields, getCampaign, integer, invalid, list, moduleName, mutable, object, optionalText, options, readRoles, rows, strings, text, timestamp, writeRoles } from './command-input.ts';

function campaignUtm(campaign: Entity, raw: unknown) {
  const params = object(raw ?? {}, 'utm_params');
  fields(params, ['utm_source', 'utm_medium', 'utm_content', 'utm_term', 'utm_id']);
  return { ...Object.fromEntries(Object.entries(params).map(([key, value]) => [key, text(value, key, 150)])), utm_campaign: campaign.data.utm_key };
}

const campaignWork = (row: Entity, id: string) => row.data.campaign_id === id || (row.data.subject_ref?.type === 'campaign' && row.data.subject_ref.id === id);
const complete = (row?: Entity) => ['done', 'completed'].includes(row?.data.status);

async function milestones(ctx: Context, id: string) {
  const [workItems, dependencies] = await Promise.all([ctx.list('workspace', 'work_item'), ctx.list('workspace', 'work_item_dependency')]);
  return workItems.filter(row => campaignWork(row, id) && ['campaign_milestone', 'campaign_task'].includes(row.data.kind)).map(item => {
    const edges = dependencies.filter(row => (row.data.successor_id ?? row.data.work_item_id) === item.id && row.data.active !== false);
    const unfinished = edges.filter(row => {
      const previous = workItems.find(work => work.id === (row.data.predecessor_id ?? row.data.depends_on_id));
      if (!complete(previous)) return true;
      const lag = row.data.lag_hours ?? 0;
      return lag > 0 && (!previous?.data.completed_at || Date.parse(previous.data.completed_at) + lag * 3_600_000 > Date.parse(ctx.now));
    });
    const blocked = !complete(item) && item.data.status !== 'cancelled' && unfinished.length > 0;
    return { item, dependencies: edges, blocked, overdue: !complete(item) && item.data.status !== 'cancelled' && Date.parse(item.data.due_at) < Date.parse(ctx.now),
      ready_for_scheduling: complete(item) && item.data.payload?.gate === 'ready_for_scheduling' };
  });
}

export function targetContentItemId(target: Entity, variant?: Entity): string | undefined {
  return target.data.content_item_id ?? target.data.item_id ?? target.data.frozen?.content_item_id ?? variant?.data.content_item_id ?? variant?.data.item_id;
}

export function targetCampaignId(target: Entity, item?: Entity): string | undefined {
  return target.data.campaign_id ?? target.data.frozen?.campaign_id ?? item?.data.campaign_id;
}

async function matrix(ctx: Context, id: string) {
  const [slots, items, variants, targets, accounts, posts] = await Promise.all([
    rows(ctx, 'campaign_plan_slot', id), ctx.list('content', 'content_item'), ctx.list('content', 'content_variant'),
    ctx.list('planning', 'publish_target'), ctx.list('account', 'social_account'), ctx.list('execution', 'platform_post'),
  ]);
  const itemIds = new Set(items.filter(row => row.data.campaign_id === id).map(row => row.id));
  const linkedVariants = variants.filter(row => itemIds.has(row.data.content_item_id ?? row.data.item_id));
  const itemsById = new Map(items.map(row => [row.id, row]));
  const variantsById = new Map(variants.map(row => [row.id, row]));
  const targetItem = (row: Entity) => {
    const variant = variantsById.get(row.data.content_variant_id ?? row.data.variant_id);
    const itemId = targetContentItemId(row, variant);
    return itemId ? itemsById.get(itemId) : undefined;
  };
  const targetRows = targets.filter(row =>
    targetCampaignId(row, targetItem(row)) === id &&
    !['cancelled', 'superseded'].includes(row.data.plan_status ?? row.data.status));
  const linkedVariantIds = new Set(targetRows.map(row => row.data.content_variant_id ?? row.data.variant_id));
  const actuals = targetRows.map(row => {
    const content_variant_id = row.data.content_variant_id ?? row.data.variant_id;
    const variant = variantsById.get(content_variant_id);
    const item = targetItem(row);
    const social_account_id = row.data.social_account_id ?? row.data.account_id;
    const account = accounts.find(item => item.id === social_account_id);
    const post = posts.find(item => (item.data.publish_target_id ?? item.data.target_id) === row.id);
    const result = row.data.close_reason ?? row.data.plan_status ?? row.data.status;
    const hasSchedule = result === 'scheduled' || (!!row.data.scheduled_at && !['draft', 'awaiting_approval', 'changes_requested', 'rejected'].includes(result));
    const phase = post || ['published', 'manual_done', 'matched_native'].includes(result) ? 'published' :
      ['failed', 'failed_final', 'expired_skipped'].includes(result) ? 'failed' : hasSchedule ? 'scheduled' : 'in_production';
    return { ...variant?.data, id: row.id, phase, type: 'publish_target', content_variant_id, social_account_id,
      content_item_id: item?.id ?? row.data.content_item_id ?? row.data.item_id ?? null,
      platform: row.data.platform ?? account?.data.platform ?? account?.data.provider ?? variant?.data.platform,
      stage: row.data.stage ?? row.data.campaign_stage ?? variant?.data.stage ?? variant?.data.campaign_stage ?? item?.data.campaign_stage,
      content_format: row.data.content_format ?? variant?.data.format, market_id: row.data.market_id ?? variant?.data.market_id,
      locale: row.data.locale ?? variant?.data.locale, status: row.data.status, plan_status: row.data.plan_status,
      campaign_plan_slot_id: row.data.campaign_plan_slot_id ?? variant?.data.campaign_plan_slot_id ?? item?.data.campaign_plan_slot_id,
      scheduled_at: row.data.scheduled_at ?? null, production_due_at: item?.data.production_due_at ?? null,
      at: row.data.scheduled_at ?? post?.data.published_at ?? null, platform_post_id: post?.id ?? null } as Fields;
  });
  for (const row of linkedVariants) {
    if (linkedVariantIds.has(row.id)) continue;
    const item = items.find(entry => entry.id === (row.data.content_item_id ?? row.data.item_id));
    actuals.push({ ...row.data, id: row.id, type: 'content_variant', phase: 'in_production', at: null,
      stage: row.data.stage ?? item?.data.campaign_stage, content_format: row.data.content_format ?? row.data.format,
      campaign_plan_slot_id: item?.data.campaign_plan_slot_id });
  }
  for (const row of items) if (itemIds.has(row.id) && !linkedVariants.some(variant => (variant.data.content_item_id ?? variant.data.item_id) === row.id) &&
    !targetRows.some(target => (target.data.content_item_id ?? target.data.item_id) === row.id)) actuals.push({ ...row.data, id: row.id, type: 'content_item', phase: 'in_production', at: null });
  const grouped = new Map(slots.map(slot => [slot.id, [] as Fields[]]));
  const unplanned: Fields[] = [];
  const overlaps: Fields[] = [];
  const dimensionKeys = ['social_account_id', 'market_id', 'locale', 'content_format'];
  const bounds = ['window_start', 'window_end'];
  const specificity = (row: Entity) => [...dimensionKeys, ...bounds].filter(key => !!row.data[key]).length;
  for (const actual of actuals) {
    const candidates = slots.filter(slot => {
      const { data } = slot;
      if (actual.campaign_plan_slot_id) return actual.campaign_plan_slot_id === slot.id;
      return data.platform === actual.platform && (!actual.stage || data.stage === actual.stage) && dimensionKeys.every(key => !data[key] || data[key] === actual[key]) &&
        (!data.window_start || (actual.at && Date.parse(actual.at) >= Date.parse(data.window_start))) &&
        (!data.window_end || (actual.at && Date.parse(actual.at) < Date.parse(data.window_end)));
    });
    candidates.sort((a, b) => specificity(b) - specificity(a) || a.id.localeCompare(b.id));
    if (!candidates.length) unplanned.push(actual);
    else {
      grouped.get(candidates[0].id)!.push(actual);
      if (candidates.length > 1) overlaps.push({ actual_id: actual.id, slot_ids: candidates.map(row => row.id) });
    }
  }
  const cells = slots.map(slot => {
    const actual = grouped.get(slot.id)!;
    const counts = { in_production: 0, scheduled: 0, published: 0, failed: 0 };
    for (const row of actual) counts[row.phase as keyof typeof counts]++;
    return { slot, actual, counts, gap: Math.max(0, slot.data.planned_count - actual.length), excess: Math.max(0, actual.length - slot.data.planned_count) };
  });
  return { cells, unplanned, overlaps, calendar: actuals.filter(row => row.type === 'publish_target' && row.at).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)) };
}

export const coordinationCommands: Commands = {
  get_context: command(readRoles, async (ctx, input) => {
    const campaign = await getCampaign(ctx, input);
    const [markets, products, goals, briefs, slots, progress, facts, revisions] = await Promise.all([
      rows(ctx, 'campaign_market', campaign.id), rows(ctx, 'campaign_product', campaign.id), rows(ctx, 'campaign_goal', campaign.id),
      rows(ctx, 'brief', campaign.id), rows(ctx, 'campaign_plan_slot', campaign.id), ctx.list('analytics', 'campaign_goal_progress'),
      ctx.list('commerce', 'product_fact'), ctx.list('commerce', 'product_fact_revision'),
    ]);
    const revisionsById = new Map(revisions.map(row => [row.id, row]));
    return { campaign, markets, products: products.map(product => ({ association: product, approved_facts: facts.flatMap(fact => {
      if (fact.data.product_id !== product.data.product_id || fact.data.archived_at) return [];
      const revision = revisionsById.get(fact.data.approved_revision_id);
      return revision?.data.review_status === 'approved' ? [{ fact, revision }] : [];
    }) })),
      goals: goals.map(goal => ({ goal, progress: progress.find(row => row.data.campaign_id === campaign.id && row.data.goal_id === goal.id)?.data ?? null })),
      briefs: await Promise.all(briefs.map(async brief => ({ brief, approved_revision: brief.data.approved_revision_id ? await ctx.get(moduleName, 'brief_revision', brief.data.approved_revision_id) ?? null : null }))),
      plan_slots: slots, matrix: await matrix(ctx, campaign.id), milestones: await milestones(ctx, campaign.id) };
  }),
  matrix: command(readRoles, async (ctx, input) => matrix(ctx, (await getCampaign(ctx, input)).id)),
  create_gap_items: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'slot_id', 'count', 'dry_run', 'production_due_at']);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    const slotId = text(input.slot_id, 'slot_id');
    const cell = (await matrix(ctx, campaign.id)).cells.find(({ slot }) => slot.id === slotId);
    if (!cell) invalid('Select a plan slot in this campaign');
    const count = integer(input.count ?? Math.min(cell.gap, 20), 'count', 0, 20);
    if (count > cell.gap) invalid('Count exceeds the current gap');
    if (input.dry_run !== undefined && typeof input.dry_run !== 'boolean') invalid('dry_run must be a boolean');
    const due = timestamp(input.production_due_at, 'production_due_at');
    const setup = cell.slot.data;
    const title = `${setup.platform} ${setup.stage} content`;
    if (input.dry_run) return { dry_run: true, slot_id: slotId, current_gap: cell.gap, count, production_due_at: due, title };
    const { createItem } = await import('../content/index.ts');
    const items: Entity[] = [];
    for (let index = 0; index < count; index++) {
      const { item } = await createItem(ctx, { campaign_id: campaign.id, brand_id: campaign.data.brand_id, title,
        owner_user_id: setup.owner_user_id ?? ctx.actorId, production_due_at: due,
        variants: [{ platform: setup.platform, format: setup.content_format ?? 'text', locale: setup.locale ?? 'und',
          market_id: setup.market_id, social_account_id: setup.social_account_id }] },
        { lineage: { campaign_plan_slot_id: slotId, campaign_stage: setup.stage } });
      items.push(item);
    }
    const tasks = await coordinationCommands.create_tasks.run(ctx, { campaign_id: campaign.id,
      tasks: items.map(item => ({ key: `gap:${item.id}`, title: `${title} (${item.id})`, due_at: due, owner_user_id: setup.owner_user_id ?? ctx.actorId })) });
    return { items, tasks };
  }),
  list_milestones: command(readRoles, async (ctx, input) => milestones(ctx, (await getCampaign(ctx, input)).id)),
  create_tasks: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'tasks']);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    const existing = await ctx.list('workspace', 'work_item');
    const created = new Map<string, Entity>();
    for (const value of list(input.tasks, 'tasks')) {
      const task = object(value, 'task');
      fields(task, ['key', 'kind', 'title', 'due_at', 'owner_user_id', 'dependencies', 'gate']);
      const key = text(task.key, 'key');
      if (created.has(key) || existing.some(row => row.id === key)) invalid('Task keys must be unique');
      const kind = options(task.kind ?? 'campaign_task', 'kind', ['campaign_task', 'campaign_milestone']);
      const gate = task.gate == null ? null : options(task.gate, 'gate', ['ready_for_scheduling']);
      if (gate && kind !== 'campaign_milestone') invalid('Only milestones support a gate');
      const due_at = timestamp(task.due_at, 'due_at');
      const dependencies = list(task.dependencies ?? [], 'dependencies').map(entry => {
        const dependency = object(entry, 'dependency');
        fields(dependency, ['predecessor', 'lag_hours']);
        const ref = text(dependency.predecessor, 'predecessor');
        const predecessor = created.get(ref) ?? existing.find(row => row.id === ref && campaignWork(row, campaign.id));
        if (!predecessor) invalid('Predecessor must be an existing campaign task or appear earlier in the batch');
        return { predecessor_id: predecessor.id, lag_hours: integer(dependency.lag_hours ?? 0, 'lag_hours', 0, 8760) };
      });
      if (new Set(dependencies.map(dep => dep.predecessor_id)).size !== dependencies.length) invalid('Duplicate dependencies');
      const owner_user_id = optionalText(task.owner_user_id, 'owner_user_id') ?? ctx.actorId;
      const row = await ctx.insert('workspace', 'work_item', {
        kind, type: kind === 'campaign_milestone' ? 'milestone' : 'production_task', title: text(task.title, 'title'),
        campaign_id: campaign.id, brand_id: campaign.data.brand_id, subject_ref: { type: 'campaign', id: campaign.id },
        resource_type: 'campaign', resource_id: campaign.id, source_type: 'manual', priority: 'normal',
        assignee_type: 'user', assignee_id: owner_user_id, owner_user_id, due_at, status: 'open', payload: { gate },
      });
      created.set(key, row);
      for (const dependency of dependencies) await ctx.insert('workspace', 'work_item_dependency', { ...dependency, successor_id: row.id, work_item_id: row.id, depends_on_id: dependency.predecessor_id, type: 'finish_to_start' });
      await ctx.emit('workspace.work_item.created', { work_item_id: row.id, campaign_id: campaign.id });
    }
    return [...created.values()];
  }),
  check_milestones: command(['owner', 'admin'], async (ctx, input) => {
    const campaign = await getCampaign(ctx, input);
    const day = timestamp(ctx.now, 'now').slice(0, 10);
    const marked = await rows(ctx, 'milestone_delay_notice', campaign.id);
    const delayed = (await milestones(ctx, campaign.id)).filter(row => row.item.data.kind === 'campaign_milestone' && (row.blocked || row.overdue));
    for (const row of delayed) {
      if (marked.some(mark => mark.data.day === day && mark.data.work_item_id === row.item.id)) continue;
      await ctx.insert(moduleName, 'milestone_delay_notice', { campaign_id: campaign.id, day, work_item_id: row.item.id });
      await emit(ctx, 'milestone.delayed', campaign.id, { work_item_id: row.item.id, blocked: row.blocked, overdue: row.overdue });
    }
    return delayed;
  }),
  list_links: command(readRoles, async (ctx, input) => {
    const campaign = await getCampaign(ctx, input);
    return (await ctx.list('traffic', 'short_link')).filter(row => row.data.campaign_id === campaign.id);
  }),
  resolve_tracking_campaign: command(readRoles, async (ctx, input) => {
    fields(input, ['short_link_id', 'content_item_id']);
    const linkId = optionalText(input.short_link_id, 'short_link_id');
    const contentId = optionalText(input.content_item_id, 'content_item_id');
    if (Boolean(linkId) === Boolean(contentId)) invalid('Choose a short link or a content item');
    const subject = linkId ? await ctx.get('traffic', 'short_link', linkId) : await ctx.get('content', 'content_item', contentId!);
    if (!subject?.data.campaign_id || subject.data.removed_at) return null;
    return await ctx.get(moduleName, 'campaign', subject.data.campaign_id) ?? null;
  }),
  tracking_summary: command(readRoles, async (ctx, input) => {
    fields(input, ['campaign_id']);
    const campaign = await getCampaign(ctx, input);
    const { commands: traffic } = await import('../traffic/index.ts');
    const { promotionCommands } = await import('../commerce/promotion-commands.ts');
    const [links, content, clicks, promotionViews] = await Promise.all([
      coordinationCommands.list_links.run(ctx, { campaign_id: campaign.id }) as Promise<Entity[]>,
      ctx.list('content', 'content_item'),
      traffic.links_get_stats.run(ctx, { campaign_id: campaign.id }),
      promotionCommands.promotion_get.run(ctx, { campaign_id: campaign.id }) as Promise<{
        promotion: Entity; observed_usage_count: number;
      }[]>,
    ]);
    const promotions = promotionViews.map(({ promotion, observed_usage_count }) => ({
      promotion_id: promotion.id, name: promotion.data.name, observed_usage_count,
    }));
    return {
      campaign_id: campaign.id, links, clicks, promotions,
      content_items: content.filter(item => item.data.campaign_id === campaign.id && !item.data.removed_at),
      observed_coupon_usage_count: promotions.reduce((count, promotion) => count + promotion.observed_usage_count, 0),
    };
  }),
  prepare_link: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'utm_params']);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    return { campaign_id: campaign.id, brand_id: campaign.data.brand_id, utm_params: campaignUtm(campaign, input.utm_params) };
  }),
  create_link: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'utm_params', 'destination_url', 'landing_destination_id', 'expires_at', 'fallback_url', 'content_item_id', 'publish_target_id', 'collaboration_id', 'product_variant_id', 'market_id']);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    for (const [key, module, kind] of [['content_item_id', 'content', 'content_item'], ['collaboration_id', 'creator', 'collaboration']]) {
      if (input[key] === undefined) continue;
      const row = await ctx.get(module, kind, text(input[key], key));
      if (row?.data.campaign_id !== campaign.id) invalid(`${key} must belong to the campaign`);
    }
    if (input.publish_target_id !== undefined) {
      const target = await ctx.get('planning', 'publish_target', text(input.publish_target_id, 'publish_target_id'));
      if (!target) invalid('publish_target_id must belong to the campaign');
      const variantId = target.data.content_variant_id ?? target.data.variant_id;
      const variant = variantId ? await ctx.get('content', 'content_variant', variantId) : undefined;
      const itemId = targetContentItemId(target, variant);
      const item = itemId ? await ctx.get('content', 'content_item', itemId) : undefined;
      if (targetCampaignId(target, item) !== campaign.id) invalid('publish_target_id must belong to the campaign');
      if (itemId && input.content_item_id !== undefined && input.content_item_id !== itemId) invalid('content_item_id must match the publish target');
    }
    const { commands } = await import('../traffic/index.ts');
    return commands.links_create.run(ctx, { ...input, campaign_id: campaign.id, utm_params: campaignUtm(campaign, input.utm_params) });
  }),
  set_tracking_config: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'expected_version', 'conversion_goals', 'default_attribution_window_days', 'landing_targets']);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    const conversion_goals = strings(input.conversion_goals, 'conversion_goals').map(value => options(value, 'conversion_goals', ['order', 'lead', 'signup']));
    const default_attribution_window_days = integer(input.default_attribution_window_days, 'default_attribution_window_days', 1, 365);
    const landing_targets = strings(input.landing_targets ?? [], 'landing_targets');
    const existing = (await rows(ctx, 'tracking_config', campaign.id))[0];
    const data = { campaign_id: campaign.id, conversion_goals, default_attribution_window_days, landing_targets };
    if (!existing) return ctx.insert(moduleName, 'tracking_config', data);
    return ctx.update(moduleName, 'tracking_config', existing.id, data, expected(existing, input.expected_version));
  }),
  get_tracking_config: command(readRoles, async (ctx, input) => (await rows(ctx, 'tracking_config', (await getCampaign(ctx, input)).id))[0] ?? null),
};
