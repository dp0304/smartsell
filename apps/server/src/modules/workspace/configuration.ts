import { type Context, type Data, type Input, type Row } from '@smartsell/contracts';
import { bool, denied, id, invalid, isManager, label, missing, obj, pick, str, strings } from './shared.js';
import { summary, type SummaryCard } from './overview.js';
import { connectorReady, online, sessionFor } from '../account/device-control.js';
import type { Operation } from '@smartsell/contracts';

async function hasSocialCapability(ctx: Context) {
  const accounts = ctx.list('social_account').filter(row => row.status === 'active');
  if (!accounts.length) return false;
  const entry = new URL('../account/index.ts', import.meta.url);
  try {
    const { operations } = await import(entry.href) as { operations?: Operation[] };
    const capability = operations?.find(op => op.name === 'get_capabilities');
    if (!capability || !capability.roles.includes(ctx.role)) return false;
    for (const account of accounts) {
      const result = await capability.run(ctx, { params: { id: account.id }, query: {}, body: {} });
      if (Array.isArray(result) && result.some(row => row.status === 'available' || row.availability === 'available')) return true;
    }
  } catch { /* The account facade cannot currently confirm an available capability. */ }
  return false;
}

const steps = {
  brand: { impact: 'Brand-scoped operations require an active brand', check: (ctx: Context) => ctx.list('brand').some(row => row.status === 'active') },
  market: { impact: 'Localized content requires a configured market', check: (ctx: Context) => ctx.list('market').some(row => row.status === 'active' && ctx.list('brand').some(brand => brand.id === row.brand_id && brand.status === 'active')) },
  social_account: { impact: 'Social publishing requires an account with an available capability', check: hasSocialCapability },
  connector_pairing: { impact: 'Connector execution requires an online compatible device and verified mobile bindings when applicable', check: (ctx: Context) => {
    const devices = ctx.list('connector_device').filter(row => online(ctx, row) && row.compatibility_status !== 'blocked');
    if (!devices.length) return false;
    const mobileBindings = ctx.list('account_execution_binding').filter(row => row.connector_channel === 'mobile' && ['connector', 'hybrid'].includes(String(row.mode)));
    return mobileBindings.every(binding => {
      const device = devices.find(row => row.id === binding.device_id);
      const phone = ctx.list('mobile_device').find(row => row.id === binding.mobile_device_id);
      return !!device && !!phone && (phone.platform !== 'ios' || device.platform === 'macos') && phone.compatibility_status !== 'blocked' && connectorReady(ctx, binding);
    });
  } },
  product_source: { impact: 'Product-assisted work requires a connected store or active product data source', check: (ctx: Context) => ctx.list('store').some(row => row.status === 'active') || ctx.list('data_source').some(row => row.status === 'active' && (row.store_id != null || Array.isArray(row.resources) && row.resources.includes('products'))) },
  history_sync: { impact: 'Historical metrics and comparisons may be incomplete', check: (ctx: Context) => ctx.list('sync_run').some(row => ['backfill', 'history', 'initial'].includes(String(row.run_type)) && ['succeeded', 'completed'].includes(String(row.status))) },
  test_draft: { impact: 'The team has yet to create a draft', check: (ctx: Context) => ctx.list('content_item').some(row => ['draft', 'idea', 'in_production'].includes(String(row.status ?? row.production_stage))) },
  invite_team: { impact: 'Other members may lack access to continue setup', check: (ctx: Context) => ctx.list('workspace_invitation').some(row => ['pending', 'accepted'].includes(String(row.status))) },
};
const flowKey = 'initial_setup_v1';
function flow(value: string | undefined) { if (value !== flowKey) missing('Onboarding flow'); return flowKey; }
export function onboarding(ctx: Context, { params }: Input) {
  const key = flow(params.flow);
  const rows = ctx.list('onboarding_progress').filter(row => row.flow_key === key);
  return { flow_key: key, items: Object.keys(steps).map(step_key => rows.find(row => row.step_key === step_key) ?? { step_key, status: 'not_started' }) };
}
export async function modifyStep(ctx: Context, { params, body }: Input, skip: boolean) {
  const flow_key = flow(params.flow);
  const step_key = params.step as keyof typeof steps;
  if (!Object.hasOwn(steps, step_key)) return missing('Onboarding step');
  const step = steps[step_key];
  const previous = ctx.list('onboarding_progress').find(row => row.flow_key === flow_key && row.step_key === step_key);
  const passed = !skip && await step.check(ctx);
  const status = skip ? 'skipped' : passed ? 'done' : 'blocked';
  const identityMismatch = status === 'blocked' && step_key === 'connector_pairing' && ctx.list('account_execution_binding').some(binding =>
    binding.connector_channel === 'mobile' && ['connector', 'hybrid'].includes(String(binding.mode)) && sessionFor(ctx, binding)?.status === 'identity_mismatch');
  const values = { flow_key, step_key, status, skip_reason: skip ? str(body.reason, 'reason', 1000) : null,
    check_result: { passed, impact: step.impact, ...(identityMismatch && { reason: 'app_identity_mismatch' }) }, checked_at: ctx.now, updated_by_id: ctx.actorId };
  const row = previous ? ctx.update('onboarding_progress', previous.id, values) : ctx.create('onboarding_progress', values);
  if (passed && previous?.status !== 'done') ctx.emit('workspace.onboarding.step_completed', { flow_key, step_key });
  return row;
}

function canReadView(ctx: Context, row: Row) { return row.owner_id === ctx.actorId || row.shared === true; }
export function savedViews(ctx: Context) { return ctx.list('saved_view').filter(row => canReadView(ctx, row)); }
export function saveView(ctx: Context, { params, body }: Input) {
  const previous = params.id ? ctx.get('saved_view', params.id) : undefined;
  if (previous && !canReadView(ctx, previous)) missing('Saved view');
  if (previous && previous.owner_id !== ctx.actorId) denied();
  const patch = pick(body, { name: label, resource_type: id, shared: value => bool(value, 'shared'), filters: value => obj(value, 'filters') });
  if (patch.shared === true && !isManager(ctx) && ctx.role !== 'analyst' && ctx.role !== 'editor') denied();
  return previous ? ctx.update('saved_view', previous.id, patch) : ctx.create('saved_view', { name: label(body.name), resource_type: id(body.resource_type), filters: {}, shared: false, ...patch, owner_id: ctx.actorId });
}

function dashboardRow(ctx: Context, key: string) {
  return ctx.list('dashboard_layout').find(row => row.owner_id === ctx.actorId && row.key === key);
}
export async function readDashboard(ctx: Context, input: Input) {
  const key = id(input.params.id);
  const layout = dashboardRow(ctx, key);
  if (!layout && key !== 'personal') missing('Dashboard');
  return { layout: layout ?? { key, cards: [] }, summary: await summary(ctx, input, layout?.cards as SummaryCard[] | undefined) };
}
export async function saveDashboard(ctx: Context, input: Input) {
  const { body, params, expectedVersion } = input;
  const key = id(params.id);
  if (!Array.isArray(body.cards) || body.cards.length < 1 || body.cards.length > 20) return invalid('cards must contain 1 to 20 metric queries');
  const cards = body.cards.map((value): SummaryCard => {
    const card = obj(value, 'card');
    const metric_keys = strings(card.metric_keys, 'metric_keys', 30);
    if (!metric_keys.length) invalid('metric_keys are required');
    const filters = Object.fromEntries(Object.entries(obj(card.filters ?? {}, 'filters')).map(([filter, set]) => [filter, strings(set, filter)]));
    return { subject: id(card.subject), metric_keys, dimensions: strings(card.dimensions ?? [], 'dimensions'), filters,
      ...(card.period !== undefined ? { period: pick(obj(card.period, 'period'), { from: id, to: id, basis: id }) } : {}),
      ...(card.compare_period !== undefined ? { compare_period: pick(obj(card.compare_period, 'compare_period'), { type: id, from: id, to: id }) } : {}) };
  });
  await summary(ctx, { ...input, query: {} }, cards);
  const previous = dashboardRow(ctx, key);
  if (previous && expectedVersion !== previous.version) return invalid('Dashboard expected_version does not match');
  const fields: Data = { owner_id: ctx.actorId, key, cards };
  return previous ? ctx.update('dashboard_layout', previous.id, fields) : ctx.create('dashboard_layout', fields);
}
