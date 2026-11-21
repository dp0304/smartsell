import { Problem, type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';
import { compareMetrics, metricDefinitions, metricQueryInput } from '../analytics/metrics.js';
import {
  CAMPAIGN, CAMPAIGNS, INTERNAL_READ, PLAN, array, campaign, choice, conflict, currency, day, event, fields,
  integer, invalid, locale, mutable, number, optionalText, optionalTimestamp, page, range, record, rows, scoped, strings, text, timestamp, version,
} from './shared.js';

export const CAMPAIGN_KINDS = ['launch', 'seasonal', 'promotion', 'always_on', 'brand', 'other'] as const;
export const STAGES = ['teaser', 'launch', 'sustain', 'conversion', 'recap', 'custom'] as const;
export const STATUSES = ['draft', 'planned', 'active', 'paused', 'wrapping', 'closed', 'cancelled'] as const;
const CAMPAIGN_FIELDS = ['brand_id', 'name', 'kind', 'starts_at', 'ends_at', 'timezone', 'owner_user_id', 'audience_note', 'objective_summary'];
const GOAL_FIELDS = ['campaign_market_id', 'metric_key', 'unit', 'currency', 'baseline_value', 'baseline_source', 'target_value', 'due_at', 'attribution_note'];
export const SLOT_FIELDS = ['stage', 'platform', 'social_account_id', 'market_id', 'locale', 'content_format', 'planned_count', 'window_start', 'window_end', 'owner_user_id', 'note'];

function campaignValues(ctx: Context, body: Data, before?: Row): Data {
  const starts_at = optionalTimestamp(body.starts_at, 'starts_at');
  const ends_at = optionalTimestamp(body.ends_at, 'ends_at');
  range(starts_at, ends_at, 'Campaign period');
  if (before && before.status !== 'draft' && (!starts_at || !ends_at)) invalid('A planned campaign must retain a complete period');
  const timezone = text(body.timezone, 'timezone');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); }
  catch { invalid('timezone must be an IANA time zone'); }
  if (/^[+-]/.test(timezone)) invalid('timezone must be an IANA time zone');
  const brand_id = text(body.brand_id, 'brand_id');
  ctx.get('brand', brand_id);
  if (before && brand_id !== before.brand_id) conflict('Campaign brand is immutable');
  return {
    brand_id, name: text(body.name, 'name'), kind: choice(body.kind, CAMPAIGN_KINDS, 'kind'), starts_at, ends_at, timezone,
    owner_user_id: text(body.owner_user_id ?? ctx.actorId, 'owner_user_id'),
    audience_note: optionalText(body.audience_note, 'audience_note', 10_000),
    objective_summary: optionalText(body.objective_summary, 'objective_summary', 10_000),
  };
}

export function createCampaign(ctx: Context, body: Data, templateId?: string): Row {
  fields(body, [...CAMPAIGN_FIELDS, 'utm_key', 'markets', 'products', 'goals', 'plan_slots']);
  const values = campaignValues(ctx, body);
  const base = (values.name as string).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 70) || 'campaign';
  const existing = new Set(ctx.list('campaign').map(row => row.utm_key));
  let utm_key = body.utm_key === undefined ? base : text(body.utm_key, 'utm_key', 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(utm_key)) invalid('utm_key can contain only URL-safe letters, digits, hyphens and underscores');
  if (body.utm_key === undefined) for (let suffix = 2; existing.has(utm_key); suffix++) utm_key = `${base}-${suffix}`;
  if (existing.has(utm_key)) conflict('utm_key already exists in this workspace');
  const row = ctx.create('campaign', { ...values, status: 'draft', utm_key, template_id: templateId ?? null, closed_at: null });
  event(ctx, 'campaign.created', row.id, { status: row.status, brand_id: row.brand_id });
  if (body.markets !== undefined) setMarkets(ctx, row, body.markets);
  if (body.products !== undefined) setProducts(ctx, row, body.products);
  if (body.goals !== undefined) {
    for (const item of array(body.goals, 'goals')) {
      const { market_id, ...goal } = record(item, 'goal');
      if (market_id !== undefined) {
        if (goal.campaign_market_id !== undefined) invalid('Choose market_id or campaign_market_id');
        goal.campaign_market_id = campaignMarket(ctx, row.id, text(market_id, 'market_id')).id;
      }
      makeGoal(ctx, row, goal);
    }
  }
  if (body.plan_slots !== undefined) for (const item of array(body.plan_slots, 'plan_slots')) makeSlot(ctx, row, record(item, 'plan slot'));
  return row;
}

export function campaignMarket(ctx: Context, campaignId: string, marketId: string): Row {
  const market = rows(ctx, 'campaign_market', 'campaign_id', campaignId).find(row => row.market_id === marketId);
  return market ?? invalid('market_id must be a market on this campaign');
}

function setMarkets(ctx: Context, campaign: Row, value: unknown): Row[] {
  const prior = rows(ctx, 'campaign_market', 'campaign_id', campaign.id);
  const seen = new Set<string>();
  const result = array(value, 'markets').map(value => {
    const body = record(value, 'campaign market');
    fields(body, ['market_id', 'locales', 'starts_at', 'ends_at', 'owner_user_id', 'status']);
    const market_id = text(body.market_id, 'market_id');
    const market = ctx.get('market', market_id);
    if (market.brand_id != null && market.brand_id !== campaign.brand_id) invalid('Market belongs to another brand');
    if (seen.has(market_id)) invalid('A market may appear only once');
    seen.add(market_id);
    const locales = strings(body.locales, 'locales').map(value => locale(value, 'locale'));
    if (!locales.length || new Set(locales).size !== locales.length) invalid('Provide at least one unique market locale');
    const starts_at = optionalTimestamp(body.starts_at, 'starts_at');
    const ends_at = optionalTimestamp(body.ends_at, 'ends_at');
    range(starts_at, ends_at, 'Market period');
    const existing = prior.find(row => row.market_id === market_id);
    const data = {
      campaign_id: campaign.id, market_id, locales, starts_at, ends_at, owner_user_id: optionalText(body.owner_user_id, 'owner_user_id'),
      status: choice(body.status ?? existing?.status ?? 'planned', ['planned', 'active', 'skipped', 'done'], 'status'),
    };
    return existing ? ctx.update('campaign_market', existing.id, data) : ctx.create('campaign_market', data);
  });
  for (const old of prior.filter(row => !seen.has(row.market_id as string))) {
    if (['campaign_goal', 'brief', 'work_item'].some(kind => rows(ctx, kind, 'campaign_market_id', old.id).length > 0)
      || rows(ctx, 'campaign_plan_slot', 'campaign_id', campaign.id).some(slot => slot.market_id === old.market_id)
      || rows(ctx, 'campaign_product', 'campaign_id', campaign.id).some(product => Array.isArray(product.market_ids) && product.market_ids.includes(old.market_id))) {
      conflict('A referenced market cannot be removed');
    }
    ctx.remove('campaign_market', old.id);
  }
  return result;
}

function setProducts(ctx: Context, campaign: Row, value: unknown): Row[] {
  const prior = rows(ctx, 'campaign_product', 'campaign_id', campaign.id);
  const seen = new Set<string>();
  const result = array(value, 'products').map(value => {
    const body = record(value, 'campaign product');
    fields(body, ['product_id', 'variant_ids', 'market_ids', 'role']);
    const product_id = text(body.product_id, 'product_id');
    const product = ctx.get('product', product_id);
    if (product.brand_id !== campaign.brand_id) invalid('Product belongs to another brand');
    if (seen.has(product_id)) invalid('A product may appear only once');
    seen.add(product_id);
    const variant_ids = body.variant_ids == null ? null : strings(body.variant_ids, 'variant_ids');
    if (variant_ids?.length === 0) invalid('Use null to select all variants');
    for (const id of variant_ids ?? []) scoped(ctx, 'product_variant', id, 'product_id', product_id);
    const market_ids = body.market_ids == null ? null : strings(body.market_ids, 'market_ids');
    if (market_ids?.length === 0) invalid('Use null to select all markets');
    for (const id of market_ids ?? []) campaignMarket(ctx, campaign.id, id);
    const data = { campaign_id: campaign.id, product_id, variant_ids, market_ids, role: choice(body.role, ['hero', 'supporting', 'bundle', 'gift'], 'role') };
    const existing = prior.find(row => row.product_id === product_id);
    return existing ? ctx.update('campaign_product', existing.id, data) : ctx.create('campaign_product', data);
  });
  for (const old of prior.filter(row => !seen.has(row.product_id as string))) ctx.remove('campaign_product', old.id);
  return result;
}

function goalValues(ctx: Context, campaign: Row, body: Data): Data {
  const campaign_market_id = optionalText(body.campaign_market_id, 'campaign_market_id');
  if (campaign_market_id) scoped(ctx, 'campaign_market', campaign_market_id, 'campaign_id', campaign.id);
  const metric_key = text(body.metric_key, 'metric_key');
  const definition = metricDefinitions(ctx).filter(row => row.key === metric_key).sort((a, b) => b.revision - a.revision)[0]
    ?? ctx.list('metric_definition').find(row => row.key === metric_key);
  if (definition?.status !== 'active') invalid('metric_key must be an active Analytics metric definition');
  const unit = choice(body.unit, ['count', 'currency', 'percent', 'seconds'], 'unit');
  if (definition.unit !== unit) invalid('unit must match the Analytics metric definition');
  if (unit !== 'currency' && body.currency != null) invalid('currency is permitted only for currency metrics');
  const baseline_value = number(body.baseline_value, 'baseline_value');
  const baseline_source = text(body.baseline_source, 'baseline_source');
  return {
    campaign_id: campaign.id, campaign_market_id, metric_key, unit, currency: unit === 'currency' ? currency(body.currency) : null,
    baseline_value, baseline_source, target_value: number(body.target_value, 'target_value'), due_at: timestamp(body.due_at, 'due_at'),
    attribution_note: optionalText(body.attribution_note, 'attribution_note'),
  };
}

function goalRevision(ctx: Context, goal: Row, reason: string, previous?: Row): void {
  ctx.create('campaign_goal_revision', {
    campaign_id: goal.campaign_id, goal_id: goal.id, goal_version: goal.version, metric_key: goal.metric_key,
    target_value: goal.target_value, due_at: goal.due_at, status: goal.status, reason, changed_by: ctx.actorId,
    previous_target_value: previous?.target_value ?? null, previous_due_at: previous?.due_at ?? null,
  });
  event(ctx, 'goal.changed', goal.campaign_id as string, { goal_id: goal.id, metric_key: goal.metric_key, status: goal.status });
}
function makeGoal(ctx: Context, campaign: Row, body: Data): Row {
  fields(body, GOAL_FIELDS);
  const goal = ctx.create('campaign_goal', { ...goalValues(ctx, campaign, body), status: 'active' });
  goalRevision(ctx, goal, 'created');
  return goal;
}

function slotValues(ctx: Context, campaign: Row, body: Data): Data {
  const platform = text(body.platform, 'platform');
  const social_account_id = optionalText(body.social_account_id, 'social_account_id');
  if (social_account_id) {
    const account = ctx.get('social_account', social_account_id);
    if ((account.provider ?? account.platform) !== platform || (account.brand_id != null && account.brand_id !== campaign.brand_id)) invalid('Social account does not match the campaign brand and platform');
  }
  const market_id = optionalText(body.market_id, 'market_id');
  const language = body.locale == null ? null : locale(body.locale, 'locale');
  if (market_id) {
    const market = campaignMarket(ctx, campaign.id, market_id);
    if (language && !(market.locales as string[]).includes(language)) invalid('locale must be configured for the campaign market');
  }
  const window_start = optionalTimestamp(body.window_start, 'window_start');
  const window_end = optionalTimestamp(body.window_end, 'window_end');
  range(window_start, window_end, 'Slot window');
  return {
    campaign_id: campaign.id, stage: choice(body.stage, STAGES, 'stage'), platform, social_account_id, market_id, locale: language,
    content_format: optionalText(body.content_format, 'content_format'), planned_count: integer(body.planned_count ?? 1, 'planned_count', 1, 1000),
    window_start, window_end, owner_user_id: optionalText(body.owner_user_id, 'owner_user_id'), note: optionalText(body.note, 'note'),
  };
}
export function makeSlot(ctx: Context, campaign: Row, body: Data): Row {
  fields(body, SLOT_FIELDS);
  return ctx.create('campaign_plan_slot', slotValues(ctx, campaign, body));
}

export function transition(ctx: Context, row: Row, to: string, reason: string | null, closedByCloseout = false): Row {
  const allowed: Record<string, readonly string[]> = {
    draft: ['planned', 'cancelled'], planned: ['active', 'cancelled'], active: ['paused', 'wrapping'], paused: ['active'], wrapping: ['closed'],
  };
  if (!allowed[String(row.status)]?.includes(to) || (to === 'closed' && !closedByCloseout)) conflict(`Cannot transition from ${row.status} to ${to}`);
  if (to === 'planned' && (!row.starts_at || !row.ends_at || !rows(ctx, 'campaign_goal', 'campaign_id', row.id).some(goal => goal.status === 'active'))) {
    conflict('Planning requires a complete period and at least one active goal');
  }
  const changed = ctx.update('campaign', row.id, { status: to, ...(to === 'closed' ? { closed_at: ctx.now } : {}) });
  event(ctx, 'campaign.status_changed', row.id, { from: row.status, to, reason });
  return changed;
}

/** Scheduler entry point. Caller runs once per workspace in a transaction. */
export function autoTransition(ctx: Context): Row[] {
  return ctx.list('campaign').flatMap(row => {
    const at = Date.parse(ctx.now);
    if (row.status === 'planned' && typeof row.starts_at === 'string' && Date.parse(row.starts_at) <= at) {
      const active = transition(ctx, row, 'active', 'scheduled_start');
      if (typeof row.ends_at === 'string' && Date.parse(row.ends_at) <= at) return [transition(ctx, active, 'wrapping', 'scheduled_end')];
      return [active];
    }
    if (row.status === 'active' && typeof row.ends_at === 'string' && Date.parse(row.ends_at) <= at) return [transition(ctx, row, 'wrapping', 'scheduled_end')];
    return [];
  });
}

export function goalProgress(ctx: Context, goal: Row, campaign: Row): Data {
  const unknown = { goal_id: goal.id, value: null, progress_percent: null, coverage: { status: 'unknown' }, attribution_note: goal.attribution_note };
  const market = typeof goal.campaign_market_id === 'string' ? ctx.get('campaign_market', goal.campaign_market_id) : null;
  const starts = Date.parse(String(market?.starts_at ?? campaign.starts_at));
  const end = Math.min(Date.parse(ctx.now), Date.parse(String(goal.due_at)));
  if (!Number.isFinite(starts) || !Number.isFinite(end) || starts >= end) return unknown;
  const key = String(goal.metric_key);
  const definition = metricDefinitions(ctx).find(item => item.key === key);
  if (!definition) return unknown;
  const subjectType = definition.subject_types.includes('campaign') ? 'campaign' :
    definition.subject_types.includes('platform_post') ? 'platform_post' : null;
  if (!subjectType) return { ...unknown, coverage: { status: 'unavailable', reason: 'unsupported_campaign_grain' } };

  // Use the publication's campaign and market bindings for post goals.
  const postIds = new Set(subjectType === 'platform_post' ? ctx.list('platform_post').filter(post =>
    post.campaign_id === campaign.id && (!market || post.market_id === market.market_id)).map(post => post.id) : []);
  const scope: Context = { ...ctx, list(kind) {
    const items = ctx.list(kind);
    if (kind === 'platform_post' && subjectType === 'platform_post') return items.filter(row => postIds.has(row.id));
    if (kind !== 'metric_observation') return items;
    return items.filter(row => {
      if (row.subject_type !== subjectType) return false;
      const dims = (row.dims ?? {}) as Data;
      if (dims.attribution_model) return false;
      return subjectType === 'platform_post' ? postIds.has(String(row.subject_id)) && Date.parse(String(row.observed_at)) <= end :
        row.subject_id === campaign.id && (dims.market_id ?? row.market_id ?? null) === (market?.market_id ?? null);
    });
  } };
  try {
    const result = compareMetrics(scope, metricQueryInput(scope, {
      metrics: [key], subject: { type: subjectType, filter: subjectType === 'campaign' ? { subject_ids: [campaign.id] } : {} },
      time: { from: new Date(starts).toISOString(), to: new Date(end).toISOString(), tz: campaign.timezone,
        basis: subjectType === 'platform_post' ? 'published_at' : 'period' },
      ...(goal.unit === 'currency' ? { report_currency: goal.currency } : {}),
    }));
    const cell = result.rows.length === 1 ? result.rows[0]!.values[key] as Data | undefined : undefined;
    const raw = typeof cell?.value === 'number' ? cell.value : null;
    const value = raw !== null && goal.unit === 'currency'
      ? raw / (10 ** (new Intl.NumberFormat('en', { style: 'currency', currency: String(goal.currency) }).resolvedOptions().maximumFractionDigits ?? 2)) : raw;
    const progress = value !== null && typeof goal.target_value === 'number' && goal.target_value !== 0 ? value / goal.target_value * 100 : null;
    return { ...unknown, value, progress_percent: Number.isFinite(progress) ? progress : null,
      coverage: { status: cell?.availability ?? 'unknown', ...result.coverage }, warnings: result.warnings };
  } catch (error) {
    if (error instanceof Problem && error.status === 403) return { ...unknown, coverage: { status: 'no_permission' } };
    throw error;
  }
}

function listCampaigns(ctx: Context, { query }: Input) {
  const statuses = query.status === undefined ? null : query.status.split(',').map(value => choice(value.trim(), STATUSES, 'status'));
  const active_on = query.active_on === undefined ? null : day(query.active_on, 'active_on');
  return ctx.list('campaign').filter(row => {
    if (statuses && !statuses.includes(row.status as typeof STATUSES[number])) return false;
    if (query.brand_id && row.brand_id !== query.brand_id) return false;
    if (!active_on) return true;
    if (typeof row.starts_at !== 'string' || typeof row.ends_at !== 'string') return false;
    const date = new Intl.DateTimeFormat('en', { timeZone: String(row.timezone), year: 'numeric', month: '2-digit', day: '2-digit' });
    const localDay = (value: string) => {
      const parts = Object.fromEntries(date.formatToParts(new Date(value)).map(part => [part.type, part.value]));
      return `${parts.year}-${parts.month}-${parts.day}`;
    };
    return localDay(row.starts_at) <= active_on && localDay(row.ends_at) >= active_on;
  }).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
}

export const coreOperations: Operation[] = [
  { method: 'GET', path: CAMPAIGNS, name: 'campaign_list', roles: INTERNAL_READ, summary: 'List campaigns with optional status, brand and date filters',
    listForRest: listCampaigns, run: (ctx, input) => page(listCampaigns(ctx, input), input.query) },
  { method: 'POST', path: CAMPAIGNS, name: 'campaign_create_draft', roles: [...PLAN, 'agent'], summary: 'Create a campaign with optional markets, products and goals', run: (ctx, { body }) => createCampaign(ctx, body) },
  { method: 'PATCH', path: CAMPAIGN, name: 'campaign_update', roles: [...PLAN, 'agent'], versionKind: 'campaign', summary: 'Update campaign metadata', run(ctx, input) {
    const row = campaign(ctx, input);
    mutable(row);
    version(row, input);
    fields(input.body, [...CAMPAIGN_FIELDS, 'expected_version']);
    const updated = ctx.update('campaign', row.id, campaignValues(ctx, { ...row, ...input.body }, row));
    event(ctx, 'campaign.updated', row.id, { version: updated.version });
    return updated;
  } },
  { method: 'POST', path: `${CAMPAIGN}/transition`, name: 'campaign_transition', roles: PLAN, versionKind: 'campaign', summary: 'Manually transition a campaign', run(ctx, input) {
    const row = campaign(ctx, input);
    version(row, input);
    fields(input.body, ['to', 'reason', 'expected_version']);
    return transition(ctx, row, choice(input.body.to, STATUSES, 'to'), optionalText(input.body.reason, 'reason'));
  } },
  ...(['markets', 'products'] as const).map((resource): Operation => ({ method: 'PUT', path: `${CAMPAIGN}/${resource}`, name: `campaign_set_${resource}`, roles: PLAN, versionKind: 'campaign', summary: `Replace campaign ${resource}`, run(ctx, input) {
    const row = campaign(ctx, input);
    mutable(row);
    version(row, input);
    fields(input.body, [resource, 'expected_version']);
    const result = (resource === 'markets' ? setMarkets : setProducts)(ctx, row, input.body[resource]);
    const changed = ctx.update('campaign', row.id, {});
    event(ctx, 'campaign.updated', row.id, { version: changed.version, field: resource });
    return { [resource]: result, campaign_version: changed.version };
  } })),
  { method: 'GET', path: `${CAMPAIGN}/goals`, name: 'campaign_goal_list', roles: INTERNAL_READ, summary: 'List goals and Analytics coverage', run(ctx, input) {
    const row = campaign(ctx, input);
    const goals = rows(ctx, 'campaign_goal', 'campaign_id', row.id);
    return goals.map(goal => ({ ...goal, progress: goalProgress(ctx, goal, row) }));
  } },
  { method: 'POST', path: `${CAMPAIGN}/goals`, name: 'campaign_goal_create', roles: PLAN, summary: 'Add an Analytics-backed campaign goal', run(ctx, input) {
    const row = campaign(ctx, input); mutable(row);
    return makeGoal(ctx, row, input.body);
  } },
  { method: 'GET', path: `${CAMPAIGN}/goals/:goalId`, name: 'campaign_goal_get', roles: INTERNAL_READ, summary: 'Read a campaign goal and revision history', run(ctx, input) {
    const row = campaign(ctx, input);
    const goal = scoped(ctx, 'campaign_goal', input.params.goalId!, 'campaign_id', row.id);
    return { ...goal, revisions: rows(ctx, 'campaign_goal_revision', 'goal_id', goal.id), progress: goalProgress(ctx, goal, row) };
  } },
  { method: 'PATCH', path: `${CAMPAIGN}/goals/:goalId`, name: 'campaign_goal_update', roles: PLAN, summary: 'Revise a goal with a recorded reason', run(ctx, input) {
    const row = campaign(ctx, input); mutable(row);
    const before = scoped(ctx, 'campaign_goal', input.params.goalId!, 'campaign_id', row.id);
    version(before, input);
    if (before.status === 'withdrawn') conflict('A withdrawn goal is read-only');
    fields(input.body, [...GOAL_FIELDS, 'reason', 'expected_version']);
    const reason = text(input.body.reason, 'reason');
    const goal = ctx.update('campaign_goal', before.id, goalValues(ctx, row, { ...before, ...input.body }));
    goalRevision(ctx, goal, reason, before);
    return goal;
  } },
  { method: 'DELETE', path: `${CAMPAIGN}/goals/:goalId`, name: 'campaign_goal_withdraw', roles: PLAN, summary: 'Withdraw a goal while preserving history', run(ctx, input) {
    const row = campaign(ctx, input); mutable(row);
    const before = scoped(ctx, 'campaign_goal', input.params.goalId!, 'campaign_id', row.id);
    version(before, input);
    fields(input.body, ['reason', 'expected_version']);
    if (before.status === 'withdrawn') return before;
    const goal = ctx.update('campaign_goal', before.id, { status: 'withdrawn' });
    goalRevision(ctx, goal, optionalText(input.body.reason, 'reason') ?? 'withdrawn', before);
    return goal;
  } },
  { method: 'GET', path: `${CAMPAIGN}/plan-slots`, name: 'campaign_plan_slot_list', roles: INTERNAL_READ, summary: 'List campaign plan slots', run: (ctx, input) => rows(ctx, 'campaign_plan_slot', 'campaign_id', campaign(ctx, input).id) },
  { method: 'POST', path: `${CAMPAIGN}/plan-slots`, name: 'campaign_plan_slot_create', roles: PLAN, summary: 'Add a campaign plan slot', run(ctx, input) {
    const row = campaign(ctx, input); mutable(row);
    return makeSlot(ctx, row, input.body);
  } },
  { method: 'GET', path: `${CAMPAIGN}/plan-slots/:slotId`, name: 'campaign_plan_slot_get', roles: INTERNAL_READ, summary: 'Read a campaign plan slot', run: (ctx, input) => scoped(ctx, 'campaign_plan_slot', input.params.slotId!, 'campaign_id', campaign(ctx, input).id) },
  { method: 'PATCH', path: `${CAMPAIGN}/plan-slots/:slotId`, name: 'campaign_plan_slot_update', roles: PLAN, summary: 'Update a campaign plan slot', run(ctx, input) {
    const row = campaign(ctx, input); mutable(row);
    const slot = scoped(ctx, 'campaign_plan_slot', input.params.slotId!, 'campaign_id', row.id);
    version(slot, input);
    fields(input.body, [...SLOT_FIELDS, 'expected_version']);
    return ctx.update('campaign_plan_slot', slot.id, slotValues(ctx, row, { ...slot, ...input.body }));
  } },
  { method: 'DELETE', path: `${CAMPAIGN}/plan-slots/:slotId`, name: 'campaign_plan_slot_delete', roles: PLAN, summary: 'Delete a campaign plan slot', run(ctx, input) {
    mutable(campaign(ctx, input));
    const slot = scoped(ctx, 'campaign_plan_slot', input.params.slotId!, 'campaign_id', input.params.id!);
    version(slot, input);
    ctx.remove('campaign_plan_slot', slot.id);
    return { id: slot.id, deleted: true };
  } },
];
