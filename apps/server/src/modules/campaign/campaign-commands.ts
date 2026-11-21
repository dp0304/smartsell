import { required, type Commands, type Context, type Entity, type Fields } from '../types.ts';
import { command, conflict, currency, emit, expected, fields, getCampaign, integer, invalid, list, moduleName, mutable, numeric, object, optionalText, options, readRoles, reference, related, rows, strings, text, timestamp, windowDates, writeRoles } from './command-input.ts';

const kinds = ['launch', 'seasonal', 'promotion', 'always_on', 'brand', 'other'] as const;
const transitions: Record<string, readonly string[]> = {
  draft: ['planned', 'cancelled'], planned: ['active', 'cancelled'], active: ['paused', 'wrapping'], paused: ['active'], wrapping: [],
};
const campaignFields = ['brand_id', 'name', 'kind', 'starts_at', 'ends_at', 'timezone', 'owner_user_id', 'audience_note', 'objective_summary'];
const goalFields = ['campaign_market_id', 'metric_key', 'unit', 'currency', 'baseline_value', 'baseline_source', 'target_value', 'due_at', 'attribution_note'];
const slotFields = ['stage', 'platform', 'social_account_id', 'market_id', 'locale', 'content_format', 'planned_count', 'window_start', 'window_end', 'owner_user_id', 'note'];

async function campaignData(ctx: Context, input: Fields) {
  const timezone = text(input.timezone ?? 'UTC', 'timezone', 100);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { invalid('Unknown timezone'); }
  const brand = await required(ctx, 'workspace', 'brand', text(input.brand_id, 'brand_id'));
  if (brand.data.status === 'archived') conflict('Campaign brand is archived');
  return {
    brand_id: brand.id,
    name: text(input.name, 'name'), kind: options(input.kind, 'kind', kinds), timezone,
    ...windowDates(input, 'starts_at', 'ends_at'), owner_user_id: text(input.owner_user_id ?? ctx.actorId, 'owner_user_id'),
    audience_note: optionalText(input.audience_note, 'audience_note', 4096), objective_summary: optionalText(input.objective_summary, 'objective_summary', 4096),
  };
}
async function marketData(ctx: Context, input: Fields) {
  fields(input, ['market_id', 'locales', 'starts_at', 'ends_at', 'owner_user_id', 'status']);
  let locales: string[];
  try { locales = Intl.getCanonicalLocales(strings(input.locales ?? [], 'locales')); } catch { return invalid('Invalid locales'); }
  return {
    market_id: await reference(ctx, 'workspace', 'market', input.market_id, 'market_id'), locales,
    ...windowDates(input, 'starts_at', 'ends_at'), owner_user_id: optionalText(input.owner_user_id, 'owner_user_id'),
    status: options(input.status ?? 'planned', 'status', ['planned', 'active', 'skipped', 'done']),
  };
}
async function productData(ctx: Context, campaignId: string, input: Fields) {
  fields(input, ['product_id', 'variant_ids', 'market_ids', 'role']);
  const product_id = await reference(ctx, 'commerce', 'product', input.product_id, 'product_id');
  const market_ids = input.market_ids == null ? null : strings(input.market_ids, 'market_ids');
  const variant_ids = input.variant_ids == null ? null : strings(input.variant_ids, 'variant_ids');
  if (market_ids) {
    const markets = await rows(ctx, 'campaign_market', campaignId);
    if (market_ids.some(id => !markets.some(row => row.data.market_id === id))) invalid('Product market must belong to the campaign');
  }
  if (variant_ids?.length) {
    const variants = await ctx.list('commerce', 'product_variant');
    if (variant_ids.some(id => !variants.some(row => row.id === id && row.data.product_id === product_id))) invalid('Product variants must belong to the product');
  }
  return { product_id, market_ids, variant_ids, role: options(input.role ?? 'hero', 'role', ['hero', 'supporting', 'bundle', 'gift']) };
}
async function goalData(ctx: Context, campaignId: string, input: Fields) {
  const metric_key = text(input.metric_key, 'metric_key');
  const definition = (await ctx.list('analytics', 'metric_definition')).find(row => row.data.key === metric_key && row.data.status !== 'deprecated');
  if (!definition) invalid('metric_key must exist in the analytics metric dictionary');
  const unit = options(input.unit, 'unit', ['count', 'currency', 'percent', 'seconds']);
  const market = input.campaign_market_id == null ? null : await related(ctx, 'campaign_market', campaignId, input.campaign_market_id);
  if (market?.data.removed_at) invalid('Goal market has been removed');
  if (unit !== 'currency' && input.currency != null) invalid('currency requires a currency goal');
  return {
    metric_key, unit, currency: unit === 'currency' ? currency(input.currency) : null,
    campaign_market_id: market?.id ?? null, baseline_value: numeric(input.baseline_value, 'baseline_value'),
    baseline_source: optionalText(input.baseline_source, 'baseline_source'), target_value: numeric(input.target_value, 'target_value'),
    due_at: timestamp(input.due_at, 'due_at'), attribution_note: optionalText(input.attribution_note, 'attribution_note'),
  };
}
async function slotData(ctx: Context, campaignId: string, input: Fields) {
  const market_id = optionalText(input.market_id, 'market_id');
  if (market_id && !(await rows(ctx, 'campaign_market', campaignId)).some(row => row.data.market_id === market_id)) invalid('Slot market must belong to the campaign');
  const platform = text(input.platform, 'platform', 80);
  const social_account_id = input.social_account_id == null ? null : await reference(ctx, 'account', 'social_account', input.social_account_id, 'social_account_id');
  if (social_account_id) {
    const account = await ctx.get('account', 'social_account', social_account_id);
    if (account?.data.platform && account.data.platform !== platform) invalid('Account platform must match slot platform');
  }
  let locale = optionalText(input.locale, 'locale', 80);
  if (locale) {
    try { [locale] = Intl.getCanonicalLocales(locale); } catch { invalid('Invalid locale'); }
  }
  return {
    stage: options(input.stage, 'stage', ['teaser', 'launch', 'sustain', 'conversion', 'recap', 'custom']), platform, social_account_id,
    market_id, locale, content_format: optionalText(input.content_format, 'content_format'),
    planned_count: integer(input.planned_count ?? 1, 'planned_count', 1, 10_000), ...windowDates(input, 'window_start', 'window_end'),
    owner_user_id: optionalText(input.owner_user_id, 'owner_user_id'), note: optionalText(input.note, 'note'),
  };
}
async function addGoal(ctx: Context, campaignId: string, values: Fields) {
  const row = await ctx.insert(moduleName, 'campaign_goal', { ...values, campaign_id: campaignId, status: 'active' });
  await emit(ctx, 'goal.changed', campaignId, { goal_id: row.id, version: row.version });
  return row;
}
async function transition(ctx: Context, row: Entity, to: string, version: number, reason: string | null) {
  const from = row.data.status;
  if (!transitions[from]?.includes(to)) conflict(`Cannot transition campaign from ${from} to ${to}`);
  if (to === 'planned') {
    const goals = await rows(ctx, 'campaign_goal', row.id);
    if (!row.data.starts_at || !row.data.ends_at || !goals.some(goal => goal.data.status !== 'withdrawn')) conflict('Planning requires a date window and at least one goal');
  }
  if (to === 'active' && Date.parse(row.data.ends_at) <= Date.parse(ctx.now)) conflict('Campaign end has passed');
  const updated = await ctx.update(moduleName, 'campaign', row.id, { status: to }, version);
  await emit(ctx, 'campaign.status_changed', row.id, { from, to, status: to, reason });
  return updated;
}

export const campaignCommands: Commands = {
  list: command(readRoles, async (ctx, input) => {
    fields(input, ['status', 'brand_id', 'active_on']);
    const status = input.status == null ? null : (Array.isArray(input.status) ? strings(input.status, 'status') : [text(input.status, 'status')]);
    for (const state of status ?? []) options(state, 'status', [...Object.keys(transitions), 'closed', 'cancelled']);
    const brandId = optionalText(input.brand_id, 'brand_id');
    const activeOn = input.active_on == null ? null : timestamp(input.active_on, 'active_on');
    return (await ctx.list(moduleName, 'campaign')).filter(row =>
      (!status || status.includes(row.data.status)) && (!brandId || row.data.brand_id === brandId) &&
      (!activeOn || (row.data.starts_at && row.data.ends_at && row.data.starts_at <= activeOn && activeOn < row.data.ends_at)));
  }),
  create_draft: command(writeRoles, async (ctx, input) => {
    fields(input, [...campaignFields, 'utm_key', 'markets', 'products', 'goals']);
    const values = await campaignData(ctx, input);
    const utmKey = input.utm_key == null
      ? `${values.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 63) || 'campaign'}-${crypto.randomUUID()}`
      : text(input.utm_key, 'utm_key', 100);
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(utmKey)) invalid('utm_key must use lowercase ASCII letters, digits, hyphens, or underscores');
    if ((await ctx.list(moduleName, 'campaign')).some(row => row.data.utm_key === utmKey)) conflict('utm_key already exists');
    const campaign = await ctx.insert(moduleName, 'campaign', { ...values, status: 'draft', utm_key: utmKey });
    await emit(ctx, 'campaign.created', campaign.id, { version: campaign.version });
    await saveRelations(ctx, campaign.id, 'campaign_market', 'market_id', input.markets ?? [], item => marketData(ctx, item));
    await saveRelations(ctx, campaign.id, 'campaign_product', 'product_id', input.products ?? [], item => productData(ctx, campaign.id, item));
    for (const value of list(input.goals ?? [], 'goals')) {
      const goal = object(value, 'goal');
      fields(goal, [...goalFields, 'market_id']);
      if (goal.market_id != null && goal.campaign_market_id != null) invalid('Goal market provided twice');
      const market = goal.market_id == null ? null : (await rows(ctx, 'campaign_market', campaign.id)).find(row => row.data.market_id === goal.market_id);
      if (goal.market_id != null && !market) invalid('Goal market must belong to the campaign');
      await addGoal(ctx, campaign.id, await goalData(ctx, campaign.id, { ...goal, campaign_market_id: market?.id ?? goal.campaign_market_id }));
    }
    return campaign;
  }),
  update: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'expected_version', 'patch']);
    const campaign = await getCampaign(ctx, input);
    const version = expected(campaign, input.expected_version);
    if (!['draft', 'planned'].includes(campaign.data.status)) conflict('Only draft or planned campaigns may be edited');
    const patch = object(input.patch, 'patch');
    fields(patch, campaignFields);
    if (!Object.keys(patch).length) invalid('patch must contain a change');
    const values = await campaignData(ctx, { ...campaign.data, ...patch });
    const updated = await ctx.update(moduleName, 'campaign', campaign.id, values, version);
    if (updated.data.status === 'planned' && (!updated.data.starts_at || !updated.data.ends_at)) conflict('A planned campaign requires a date window');
    await emit(ctx, 'campaign.updated', campaign.id, { version: updated.version });
    return updated;
  }),
  transition: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'expected_version', 'to', 'reason']);
    const campaign = await getCampaign(ctx, input);
    return transition(ctx, campaign, text(input.to, 'to'), expected(campaign, input.expected_version), optionalText(input.reason, 'reason'));
  }),
  auto_transition: command(['owner', 'admin'], async (ctx, input) => {
    fields(input, []);
    const now = timestamp(ctx.now, 'now');
    const changed: Entity[] = [];
    for (const row of await ctx.list(moduleName, 'campaign')) {
      let campaign = row;
      if (campaign.data.status === 'planned' && campaign.data.starts_at <= now && now < campaign.data.ends_at) {
        campaign = await transition(ctx, campaign, 'active', campaign.version, 'scheduled_start');
        changed.push(campaign);
      }
      if (campaign.data.status === 'active' && campaign.data.ends_at <= now) changed.push(await transition(ctx, campaign, 'wrapping', campaign.version, 'scheduled_end'));
    }
    return changed;
  }),
  set_markets: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'expected_version', 'markets']);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    const version = expected(campaign, input.expected_version);
    const markets = await saveRelations(ctx, campaign.id, 'campaign_market', 'market_id', input.markets, item => marketData(ctx, item));
    const marketIds = new Set(markets.map(row => row.data.market_id));
    const associationIds = new Set(markets.map(row => row.id));
    const [goals, products, slots, briefs] = await Promise.all(['campaign_goal', 'campaign_product', 'campaign_plan_slot', 'brief'].map(kind => rows(ctx, kind, campaign.id)));
    if (goals.some(row => row.data.status !== 'withdrawn' && row.data.campaign_market_id && !associationIds.has(row.data.campaign_market_id)) ||
      briefs.some(row => row.data.campaign_market_id && !associationIds.has(row.data.campaign_market_id)) ||
      slots.some(row => row.data.market_id && !marketIds.has(row.data.market_id)) ||
      products.some(row => row.data.market_ids?.some((id: string) => !marketIds.has(id)))) conflict('A removed market is still referenced');
    const updated = await ctx.update(moduleName, 'campaign', campaign.id, {}, version);
    await emit(ctx, 'campaign.updated', campaign.id, { version: updated.version });
    return { campaign: updated, markets };
  }),
  set_products: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'expected_version', 'products']);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    const version = expected(campaign, input.expected_version);
    const products = await saveRelations(ctx, campaign.id, 'campaign_product', 'product_id', input.products, item => productData(ctx, campaign.id, item));
    const updated = await ctx.update(moduleName, 'campaign', campaign.id, {}, version);
    await emit(ctx, 'campaign.updated', campaign.id, { version: updated.version });
    return { campaign: updated, products };
  }),
  list_goals: command(readRoles, async (ctx, input) => rows(ctx, 'campaign_goal', (await getCampaign(ctx, input)).id)),
  create_goal: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', ...goalFields]);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    return addGoal(ctx, campaign.id, await goalData(ctx, campaign.id, input));
  }),
  update_goal: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'goal_id', 'expected_version', 'patch', 'reason']);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    const row = await related(ctx, 'campaign_goal', campaign.id, input.goal_id);
    const version = expected(row, input.expected_version);
    const patch = object(input.patch, 'patch');
    fields(patch, goalFields);
    if (!Object.keys(patch).length || row.data.status === 'withdrawn') conflict('Goal cannot be updated');
    const values = await goalData(ctx, campaign.id, { ...row.data, ...patch });
    const reason = text(input.reason, 'reason');
    const updated = await ctx.update(moduleName, 'campaign_goal', row.id, values, version);
    await ctx.insert(moduleName, 'campaign_goal_revision', { goal_id: row.id, campaign_id: campaign.id, previous: row.data, current: updated.data, reason, changed_by: ctx.actorId });
    await emit(ctx, 'goal.changed', campaign.id, { goal_id: row.id, version: updated.version });
    return updated;
  }),
  withdraw_goal: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'goal_id', 'expected_version', 'reason']);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    const row = await related(ctx, 'campaign_goal', campaign.id, input.goal_id);
    const version = expected(row, input.expected_version);
    if (row.data.status === 'withdrawn') conflict('Goal was already withdrawn');
    if (campaign.data.status === 'planned' && !(await rows(ctx, 'campaign_goal', campaign.id)).some(goal => goal.id !== row.id && goal.data.status !== 'withdrawn')) conflict('A planned campaign requires a goal');
    const reason = text(input.reason, 'reason');
    const updated = await ctx.update(moduleName, 'campaign_goal', row.id, { status: 'withdrawn' }, version);
    await ctx.insert(moduleName, 'campaign_goal_revision', { goal_id: row.id, campaign_id: campaign.id, previous: row.data, current: updated.data, reason, changed_by: ctx.actorId });
    await emit(ctx, 'goal.changed', campaign.id, { goal_id: row.id, version: updated.version });
    return updated;
  }),
  list_plan_slots: command(readRoles, async (ctx, input) => rows(ctx, 'campaign_plan_slot', (await getCampaign(ctx, input)).id)),
  create_plan_slot: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', ...slotFields]);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    return ctx.insert(moduleName, 'campaign_plan_slot', { ...await slotData(ctx, campaign.id, input), campaign_id: campaign.id });
  }),
  update_plan_slot: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'slot_id', 'expected_version', 'patch']);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    const row = await related(ctx, 'campaign_plan_slot', campaign.id, input.slot_id);
    if (row.data.removed_at) conflict('Slot has been removed');
    const patch = object(input.patch, 'patch');
    fields(patch, slotFields);
    if (!Object.keys(patch).length) invalid('patch must contain a change');
    return ctx.update(moduleName, 'campaign_plan_slot', row.id, await slotData(ctx, campaign.id, { ...row.data, ...patch }), expected(row, input.expected_version));
  }),
  remove_plan_slot: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'slot_id', 'expected_version']);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    const row = await related(ctx, 'campaign_plan_slot', campaign.id, input.slot_id);
    if (row.data.removed_at) conflict('Slot has been removed');
    return ctx.update(moduleName, 'campaign_plan_slot', row.id, { removed_at: ctx.now }, expected(row, input.expected_version));
  }),
};

async function saveRelations(ctx: Context, campaignId: string, kind: string, identity: string, input: unknown, parse: (item: Fields) => Promise<Fields>) {
  const values = await Promise.all(list(input, kind).map(value => parse(object(value, kind))));
  const keys = new Set(values.map(value => value[identity]));
  if (keys.size !== values.length) invalid(`${kind} contains duplicates`);
  const existing = (await ctx.list(moduleName, kind)).filter(row => row.data.campaign_id === campaignId);
  const result: Entity[] = [];
  for (const value of values) {
    const row = existing.find(item => item.data[identity] === value[identity]);
    result.push(row ? await ctx.update(moduleName, kind, row.id, { ...value, removed_at: null }, row.version) : await ctx.insert(moduleName, kind, { ...value, campaign_id: campaignId }));
  }
  for (const row of existing) {
    if (!row.data.removed_at && !keys.has(row.data[identity])) await ctx.update(moduleName, kind, row.id, { removed_at: ctx.now }, row.version);
  }
  return result;
}
