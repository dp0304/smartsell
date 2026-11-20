import type { Context, Fields } from '../types.js';
import { action, active, add, emit, get, identifier, list, manage, problems, put, str, instant } from './workbench-core.js';

const flow = 'initial_setup_v1';
const steps = {
  brand: 'Brand-scoped operations require an active brand.',
  market: 'Market language, time zone, and currency will be unavailable.',
  social_account: 'Social data and publishing capabilities will be unavailable.',
  connector_pairing: 'Connector-assisted execution will be unavailable.',
  product_source: 'The product catalog will be unavailable.',
  history_sync: 'Historical data and dependent metrics may be missing.',
  test_draft: 'Drafting has not been checked in this workspace.',
  invite_team: 'Team members cannot participate until invited.',
};
type Step = keyof typeof steps;
function stepKey(input: Fields): Step {
  const key = identifier(input.step_key ?? input.step);
  return Object.hasOwn(steps, key) ? key as Step : problems.missing('Onboarding step not found');
}
function flowKey(input: Fields) {
  if ((input.flow_key ?? input.flow ?? flow) !== flow) problems.missing('Onboarding flow not found');
}
const ready = (ok: boolean, code: string) => ({ ok, code: ok ? 'ready' : code });
export const deviceOnline = (ctx: Context, data: Fields) => data.status === 'online' ||
  (data.status === 'paired' && instant(data.online_at) >= instant(ctx.now) - 120_000);
async function connector(ctx: Context, skipping = false) {
  const [bindings, devices, phones, apps] = await Promise.all([
    ctx.list('account', 'account_execution_binding'), ctx.list('account', 'device'),
    ctx.list('account', 'mobile_device'), ctx.list('account', 'mobile_app_binding'),
  ]);
  const local = bindings.filter(row => active(row) && ['connector', 'hybrid', 'local_device', 'mobile', 'mobile_app'].includes(row.data.mode));
  if (skipping) return ready(local.length === 0, 'connector_required');
  const online = devices.filter(row => deviceOnline(ctx, row.data) && ['windows', 'macos', 'darwin', 'win32'].includes(row.data.host_os ?? row.data.os) && row.data.compatible !== false && row.data.compatibility !== 'blocked');
  if (!online.length) return ready(false, 'no_compatible_online_connector');
  const mobile = local.filter(row => row.data.mode === 'mobile' || row.data.mode === 'mobile_app' || row.data.connector_channel === 'mobile' || row.data.mobile_device_id || row.data.mobile_app_binding_id);
  if (!mobile.length) return ready(true, 'ready');
  for (const binding of mobile) {
    const app = apps.find(row => active(row) && (row.id === binding.data.mobile_app_binding_id || row.data.social_account_id === binding.data.social_account_id));
    if (!app) return ready(false, 'mobile_app_binding_missing');
    const identity = app.data.identity_status ?? app.data.verification_status ?? app.data.status;
    if (identity === 'identity_mismatch' || identity === 'mismatch') return ready(false, 'identity_mismatch');
    const phone = phones.find(row => row.id === app.data.mobile_device_id);
    if (!phone || !deviceOnline(ctx, phone.data) || phone.data.compatible === false || phone.data.compatibility === 'blocked' || app.data.compatible === false ||
      !online.some(row => row.id === (phone.data.connector_device_id ?? phone.data.device_id ?? binding.data.device_id))) return ready(false, 'mobile_device_unavailable');
    if (!['verified', 'match', 'matched'].includes(identity)) return ready(false, 'mobile_identity_unverified');
  }
  return ready(true, 'ready');
}
async function check(ctx: Context, step: Step) {
  switch (step) {
    case 'brand': return ready((await list(ctx, 'brand')).some(row => row.data.status === 'active'), 'brand_missing');
    case 'market': {
      const brands = new Set((await list(ctx, 'brand')).filter(row => row.data.status === 'active').map(row => row.id));
      return ready((await list(ctx, 'market')).some(row => row.data.status === 'active' && brands.has(row.data.brand_id)), 'market_missing');
    }
    case 'social_account': {
      const [accounts, capabilities, connections, links, manual] = await Promise.all([
        ctx.list('account', 'social_account'), ctx.list('account', 'capability'), ctx.list('account', 'connection'),
        ctx.list('account', 'social_account_connection'), ctx.list('account', 'manual_result'),
      ]);
      return ready(accounts.some(account => account.data.status === 'active' && (
        capabilities.some(row => row.data.social_account_id === account.id && (row.data.available === true || row.data.status === 'available' || row.data.availability === 'available')) ||
        links.some(row => row.data.social_account_id === account.id && connections.some(conn => conn.id === row.data.connection_id && conn.data.status === 'active' && (!conn.data.expires_at || instant(conn.data.expires_at) > instant(ctx.now)))) ||
        manual.some(row => row.data.social_account_id === account.id && ['completed', 'published', 'succeeded', 'success', 'done'].includes(row.data.outcome))
      )), 'available_account_missing');
    }
    case 'connector_pairing': return connector(ctx);
    case 'product_source': {
      const [sources, products] = await Promise.all([ctx.list('ingest', 'data_source'), ctx.list('commerce', 'product')]);
      return ready(sources.some(row => active(row) && ['product', 'products', 'product_catalog', 'catalog', 'store_catalog'].includes(row.data.kind ?? row.data.dataset ?? row.data.type)) || products.some(active), 'product_source_missing');
    }
    case 'history_sync': return ready((await ctx.list('ingest', 'sync_run')).some(row => ['succeeded', 'completed'].includes(row.data.status) && (row.data.is_backfill === true || ['initial', 'backfill', 'history', 'full', 'full_backfill'].includes(row.data.run_type ?? row.data.kind ?? row.data.mode ?? row.data.trigger))), 'history_sync_incomplete');
    case 'test_draft': return ready((await ctx.list('content', 'content_variant')).some(row => ['draft', 'ready', 'approved'].includes(row.data.status)) || (await ctx.list('content', 'content_item')).some(row => ['draft', 'writing', 'ready'].includes(row.data.status ?? row.data.production_stage)), 'test_draft_missing');
    case 'invite_team': return ready((await ctx.list('team', 'member')).some(row => active(row) && (row.data.user_id ?? row.data.userId) !== ctx.actorId), 'team_invitation_missing');
  }
}
async function record(ctx: Context, step: Step, skip?: string) {
  const id = `${flow}:${step}`;
  const row = await get(ctx, 'onboarding_progress', id);
  const result = skip ? { ok: false, code: 'skipped', impact: steps[step] } : await check(ctx, step);
  const data = { flow_key: flow, step_key: step, status: skip ? 'skipped' : result.ok ? 'done' : 'blocked',
    check_result: result, checked_at: ctx.now, updated_by_id: ctx.actorId, skip_reason: skip ?? null };
  const next = row ? await put(ctx, row, data) : await add(ctx, 'onboarding_progress', data, id);
  if (next.data.status === 'done' && row?.data.status !== 'done') await emit(ctx, 'onboarding.step_completed', { flow_key: flow, step_key: step });
  return next;
}
export async function onboardingStatus(ctx: Context, input: Fields) {
  flowKey(input);
  const prior = new Map((await list(ctx, 'onboarding_progress')).filter(row => row.data.flow_key === flow).map(row => [row.data.step_key, row]));
  return { flow_key: flow, items: Object.entries(steps).map(([step_key, impact]) => ({ step_key, impact, status: 'not_started', ...prior.get(step_key)?.data })) };
}
export async function recheckOnboarding(ctx: Context, event: string) {
  const step: Step = event.startsWith('ingest.') ? 'history_sync' : event.startsWith('account.connection.') ? 'social_account' : 'connector_pairing';
  const row = await get(ctx, 'onboarding_progress', `${flow}:${step}`);
  if (row && row.data.status !== 'skipped') await record(ctx, step);
}
export const onboardingQueries = { onboarding_status: action(manage, onboardingStatus) };
export const onboardingCommands = {
  check_onboarding_step: action(manage, (ctx, input) => { flowKey(input); return record(ctx, stepKey(input)); }),
  skip_onboarding_step: action(manage, async (ctx, input) => {
    flowKey(input);
    const step = stepKey(input);
    const reason = str(input.skip_reason ?? input.reason, 'skip_reason', 1000);
    if (step === 'connector_pairing' && !(await connector(ctx, true)).ok) problems.conflict('A workspace account requires connector execution');
    return record(ctx, step, reason);
  }),
};
