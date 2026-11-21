import { verify } from 'node:crypto';
import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { change, choice, conflict, instant, integer, invalid, object, operation, services, strings, tenantScope, tenantStore, text, unavailable, upsert } from './support.js';

const gauges = ['seats', 'brands', 'social_accounts', 'storage_bytes'] as const;
const metrics = [...gauges, 'sync_calls', 'model_tokens', 'mcp_calls', 'vendor_queries'] as const;
const limitKeys: Readonly<Record<string, string>> = {
  seats: 'seats', brands: 'brands', social_accounts: 'social_accounts', storage_bytes: 'storage_gb',
  sync_calls: 'sync_calls_month', model_tokens: 'ai_tokens_month',
};
const owns = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
const isGauge = (key: string) => (gauges as readonly string[]).includes(key);
const meterStore = (ctx: Context) => tenantScope(ctx) ?? ctx;

function period(now: string): [string, string] {
  const time = new Date(now);
  return [new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), 1)).toISOString(),
    new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth() + 1, 1)).toISOString()];
}

export function getUsage(ctx: Context, metric: string, at = ctx.now) {
  const meter = choice(metric, 'meter_key', metrics);
  const [start, end] = period(at);
  const events = meterStore(ctx).list('usage_event').filter(row => row.meter_key === meter
    && String(row.occurred_at) <= at).sort((a, b) => String(a.occurred_at).localeCompare(String(b.occurred_at))
      || Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0));
  let current = 0;
  let quantity = 0;
  for (const event of events) {
    const inPeriod = String(event.occurred_at) >= start && String(event.occurred_at) < end;
    if (isGauge(meter)) {
      current += Number(event.quantity);
      if (inPeriod) quantity = Math.max(quantity, current);
      else if (String(event.occurred_at) < start) quantity = current;
    } else if (inPeriod) current += Number(event.quantity);
  }
  return { meter_key: meter, period_start: start, period_end: end, aggregation: isGauge(meter) ? 'peak' : 'sum',
    quantity: isGauge(meter) ? quantity : current, current, scope: tenantScope(ctx) ? 'tenant' : 'workspace' };
}

export function recordUsage(ctx: Context, metric: string, quantity: number, source?: string): Row {
  const meter = choice(metric, 'meter_key', metrics);
  const delta = integer(quantity, 'quantity', isGauge(meter) ? -Number.MAX_SAFE_INTEGER : 0);
  const store = meterStore(ctx);
  const history = store.list('usage_event').filter(row => row.meter_key === meter);
  const sourceRef = source === undefined ? null : text(source, 'source');
  if (sourceRef !== null) {
    const existing = history.find(row => row.source_ref === sourceRef && row.workspace_id === ctx.workspaceId);
    if (existing) {
      if (existing.quantity !== delta) conflict('usage_source_mismatch', 'Usage was already recorded with a different quantity');
      return existing;
    }
  }
  const usage = getUsage(ctx, meter);
  if (!Number.isSafeInteger(usage.current + delta) || usage.current + delta < 0) invalid('Usage total is out of range');
  const ordinal = history.reduce((max, item) => Math.max(max, Number(item.ordinal ?? 0)), 0) + 1;
  const row = store.create('usage_event', { workspace_id: ctx.workspaceId, meter_key: meter, quantity: delta,
    source_ref: sourceRef, occurred_at: ctx.now, ordinal });
  const total = getUsage(ctx, meter);
  upsert(store, 'usage_meter', { meter_key: meter, period_start: total.period_start }, { ...total, computed_at: ctx.now });
  const limit = usageLimit(ctx, meter);
  if (limit !== undefined && usage.current < limit && total.current >= limit) {
    ctx.emit('ops.license.limit_reached', { meter_key: meter, limit, quantity: total.current });
  }
  return row;
}

function entitlement(ctx: Context): Row | undefined {
  return tenantScope(ctx)?.list('license_entitlement').find(row => row.module_key === 'core');
}

export function getLicenseState(ctx: Context): 'active' | 'grace' | 'read_only' | 'terminated' {
  const license = entitlement(ctx);
  if (!license) return 'active';
  if (license.status === 'terminated') return 'terminated';
  if (license.status === 'read_only' || Date.parse(ctx.now) < Date.parse(String(license.valid_from))) return 'read_only';
  const expires = license.valid_until === null ? Infinity : Date.parse(String(license.valid_until));
  const now = Date.parse(ctx.now);
  if (now >= expires + 14 * 86_400_000) return 'read_only';
  return now >= expires || license.status === 'grace' ? 'grace' : 'active';
}

export function assertLicenseAllowed(ctx: Context, activity: 'read' | 'export' | 'verify' | 'new_side_effect'): void {
  const state = getLicenseState(ctx);
  if ((state === 'terminated' && activity !== 'export') || (state === 'read_only' && activity === 'new_side_effect')) {
    throw new Problem(402, 'LICENSE_READ_ONLY', 'The license does not permit this activity', { state });
  }
}

export function assertModuleEnabled(ctx: Context, module: string): void {
  const flags = (tenantScope(ctx) ?? ctx).list('deployment_setting').find(row => row.key === 'feature_flags')?.value as Data | undefined;
  const grant = tenantScope(ctx)?.list('license_entitlement').find(row => row.module_key === module);
  const modules = entitlement(ctx)?.modules as string[] | undefined;
  if (flags?.[module] === false || grant?.enabled === false || (modules && module !== 'core' && !modules.includes(module))) {
    throw new Problem(403, 'module_disabled', 'Module is disabled', { module });
  }
}

function usageLimit(ctx: Context, metric: string): number | undefined {
  if (!owns(limitKeys, metric)) return;
  const limits = entitlement(ctx)?.limits as Record<string, { limit: number }> | undefined;
  const configured = limits?.[limitKeys[metric]]?.limit;
  return configured === undefined ? undefined : metric === 'storage_bytes' ? configured * 1_000_000_000 : configured;
}

export function assertUsageAllowed(ctx: Context, metric: string, quantity: number, currentQuantity?: number): void {
  const meter = choice(metric, 'meter_key', metrics);
  const delta = integer(quantity, 'quantity');
  if (delta > 0) assertLicenseAllowed(ctx, 'new_side_effect');
  const limit = usageLimit(ctx, meter);
  if (limit === undefined) return;
  const used = currentQuantity ?? getUsage(ctx, meter).current;
  if (delta > 0 && used + delta > limit) {
    throw new Problem(402, 'LICENSE_LIMIT', 'License quota exceeded', { meter_key: meter, limit, used });
  }
}

export function assertSyncIntervalAllowed(ctx: Context, minutes: number): void {
  const interval = integer(minutes, 'interval_minutes', 1);
  const minimum = (entitlement(ctx)?.limits as Record<string, { limit: number }> | undefined)?.min_sync_interval_min?.limit;
  if (minimum !== undefined && interval < minimum) throw new Problem(402, 'LICENSE_LIMIT', 'Sync interval is below the licensed minimum', { minimum });
}

function installLicense(ctx: Context, body: Data): Row {
  const config = services(ctx).offlineLicense ?? unavailable('offline_license_verifier');
  if (services(ctx).deploymentMode !== 'private') invalid('Offline licenses require private deployment');
  const store = tenantStore(ctx);
  if (typeof body.payload !== 'string' || body.payload.length > 65_536) invalid('payload must be signed JSON text');
  const payload = body.payload;
  const signature = text(body.signature, 'signature');
  if (!/^[a-zA-Z0-9+/]+={0,2}$/.test(signature)) invalid('Invalid signature encoding');
  let verified = false;
  try { verified = verify(null, Buffer.from(payload), config.publicKey, Buffer.from(signature, 'base64')); }
  catch { unavailable('offline_license_verifier'); }
  if (!verified) invalid('Invalid offline license signature');
  let data: Data;
  try { data = object(JSON.parse(payload), 'payload'); } catch { invalid('Invalid license payload'); }
  if (data.install_fingerprint !== config.installFingerprint) invalid('Offline license is for another installation');
  const modules = strings(data.modules, 'modules');
  const limits = Object.fromEntries(Object.entries(object(data.limits, 'limits')).map(([key, value]) => {
    if (![...Object.values(limitKeys), 'min_sync_interval_min'].includes(key)) invalid('Unknown license limit');
    const entry = object(value, key);
    if (entry.basis !== 'license') invalid('Offline license limit basis must be license');
    const max = key === 'storage_gb' ? Math.floor(Number.MAX_SAFE_INTEGER / 1_000_000_000) : Number.MAX_SAFE_INTEGER;
    return [key, { limit: integer(entry.limit, key, 0, max), basis: 'license' }];
  }));
  const from = instant(data.valid_from, 'valid_from');
  const until = data.valid_until === null ? null : instant(data.valid_until, 'valid_until');
  if (until !== null && until <= from) invalid('Invalid license validity interval');
  const installed = store.list('license_file').find(row => row.signature === signature);
  if (installed?.superseded_by) conflict('license_superseded', 'This license was superseded');
  if (installed) return entitlement(ctx)!;
  const file = store.create('license_file', { payload, signature, install_fingerprint: config.installFingerprint,
    verified_at: ctx.now, superseded_by: null });
  for (const old of store.list('license_file').filter(row => row.id !== file.id && row.superseded_by === null)) {
    store.update('license_file', old.id, { superseded_by: file.id });
  }
  return change(ctx, 'ops.license.status_changed', 'license_entitlement', upsert(store, 'license_entitlement', { module_key: 'core' }, {
    source: 'offline_license_file', enabled: true, modules, limits, valid_from: from, valid_until: until, status: 'active', license_file_id: file.id,
  }));
}

export const meteringOperations = [
  operation('GET', '/usage', 'ops_get_usage', 'Read current values and monthly usage', (ctx, {query}) => query.meter_key
    ? getUsage(ctx, query.meter_key) : metrics.map(metric => getUsage(ctx, metric)), { roles: ['owner'] }),
  operation('GET', '/license', 'ops_get_license', 'Read license and effective status', ctx => ({ ...entitlement(ctx), status: getLicenseState(ctx) }),
    { roles: ['owner'] }),
  operation('POST', '/license/file', 'ops_install_license_file', 'Verify and install the signed offline license', (ctx, {body}) => installLicense(ctx, body),
    { roles: ['owner'] }),
];
