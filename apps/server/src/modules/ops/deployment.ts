import { isIP } from 'node:net';
import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { change, choice, instant, integer, invalid, object, operation, redact, services, strings, tenantScope, tenantStore, text, unavailable, upsert } from './support.js';
import { raiseAlert } from './controls.js';

const roles = ['api', 'mcp', 'worker', 'media', 'scheduler', 'ingress', 'public'] as const;
const urlKeys = ['public_base_url', 'public_pages_base_url', 'callback_base_url', 'mcp_base_url'] as const;
const settingKeys = [...urlKeys, 'egress_ips', 'feature_flags', 'smtp', 'object_storage'] as const;
const providers = ['shopify', 'shopee', 'lazada', 'amazon_sp'] as const;
const fixedEgress = ['shopify', 'shopee', 'lazada'];

export function recordHeartbeat(ctx: Context, nodeId: string, reportedRoles: readonly string[], version: string): Row {
  const store = tenantStore(ctx);
  const node_id = text(nodeId, 'node_id');
  const nodeRoles = reportedRoles.includes('all') ? [...roles]
    : strings(reportedRoles, 'roles').map(role => choice(role, 'role', roles));
  if (!nodeRoles.length) invalid('Provide at least one node role');
  const current = store.list('node_heartbeat').find(row => row.node_id === node_id);
  return upsert(store, 'node_heartbeat', { node_id }, { roles: nodeRoles, node_version: text(version, 'version'),
    started_at: current?.started_at ?? ctx.now, last_seen_at: ctx.now });
}

function updateSetting(ctx: Context, name: string, value: unknown): Row {
  const key = choice(name, 'setting key', settingKeys);
  const mode = services(ctx).deploymentMode;
  let normalized: unknown;
  let is_secret_ref = false;
  if (key === 'egress_ips') {
    if (mode !== 'private') invalid('Fixed egress is configured by the deployment operator');
    normalized = strings(value, 'egress_ips').map(ip => {
      if (!isIP(ip)) invalid('Each fixed egress address must be an IP address');
      return ip;
    });
  } else if (key === 'smtp' || key === 'object_storage') {
    normalized = text(value, 'secret_id');
    is_secret_ref = true;
  } else if (key === 'feature_flags') {
    normalized = Object.fromEntries(Object.entries(object(value, key)).map(([flag, enabled]) => {
      if (!/^[a-z][a-z0-9_]*$/.test(flag) || typeof enabled !== 'boolean') invalid('Feature flags must map module keys to booleans');
      return [flag, enabled];
    }));
  } else {
    let url: URL;
    try { url = new URL(text(value, 'value')); } catch { invalid('Invalid service URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid('Invalid service URL');
    normalized = url.toString();
  }
  return change(ctx, 'ops.setting.updated', 'deployment_setting', upsert(tenantStore(ctx), 'deployment_setting', { key }, { value: normalized, is_secret_ref }), { key });
}

function settingsView(row: Row): Row { return row.is_secret_ref ? { ...row, value: '[redacted]' } : row; }

export interface ProviderObservation {
  provider: string;
  connection_id: string;
  ip_allowlist_denied?: boolean;
  callback?: 'reachable' | 'unreachable' | 'missing_prerequisite';
}

/** Input comes from a configured provider adapter or callback worker. */
export function recordProviderObservation(ctx: Context, observation: ProviderObservation): Row {
  const provider = choice(observation.provider, 'provider', providers);
  const connection = text(observation.connection_id, 'connection_id');
  const callback = observation.callback === undefined ? undefined : choice(observation.callback, 'callback', ['reachable', 'unreachable', 'missing_prerequisite'] as const);
  const prior = ctx.list('deployment_precheck').find(row => row.provider === provider && row.connection_id === connection);
  const row = upsert(ctx, 'deployment_precheck', { provider, connection_id: connection }, {
    ip_allowlist_denied: observation.ip_allowlist_denied ?? prior?.ip_allowlist_denied ?? null,
    callback: callback ?? prior?.callback ?? null, checked_at: ctx.now,
  });
  const result = precheck(ctx, row);
  if (result.reason === 'platform_ip_denied') raiseAlert(ctx, 'platform_ip_denied', `${provider}:${connection}`, 'critical');
  for (const endpoint of ctx.list('callback_endpoint').filter(item => item.provider === provider && item.connection_id === connection)) {
    ctx.update('callback_endpoint', endpoint.id, { fallback_polling: result.fallback === 'fallback_polling' });
  }
  return row;
}

function precheck(ctx: Context, row: Row) {
  const configured = tenantScope(ctx)?.list('deployment_setting').find(item => item.key === 'egress_ips')?.value;
  const needsIp = fixedEgress.includes(String(row.provider));
  const result = (status: string, fallback: string | null, reason: string | null) => ({
    provider: row.provider, connection_id: row.connection_id, status, fallback, reason,
  });
  if (needsIp && (row.ip_allowlist_denied === true || (services(ctx).deploymentMode === 'private' && (!Array.isArray(configured) || !configured.length)))) {
    return result('blocked', 'file_import', 'platform_ip_denied');
  }
  if (['unreachable', 'missing_prerequisite'].includes(String(row.callback))) return result('degraded', 'fallback_polling', String(row.callback));
  return result(row.callback === 'reachable' || row.ip_allowlist_denied === false ? 'ok' : 'unknown', null, null);
}

function workspaceHealth(ctx: Context) {
  const online = (row: Row) => row.status === 'online' || row.online === true;
  return {
    connectors_online: ctx.list('connector_device').filter(online).length,
    mobile_devices_online: ctx.list('mobile_device').filter(online).length,
    provider_checks: ctx.list('deployment_precheck').map(row => precheck(ctx, row)),
  };
}

function deploymentHealth(ctx: Context) {
  const nodes = tenantScope(ctx)?.list('node_heartbeat') ?? [];
  const live = (row: Row) => Date.parse(ctx.now) - Date.parse(String(row.last_seen_at)) < 30_000;
  return {
    deployment_mode: services(ctx).deploymentMode ?? 'unknown',
    roles: Object.fromEntries(roles.map(role => {
      const reporters = nodes.filter(row => Array.isArray(row.roles) && row.roles.includes(role));
      return [role, reporters.length === 0 ? 'unknown' : reporters.some(live) ? 'online' : 'offline'];
    })),
    infrastructure: services(ctx).health?.() ?? { db: 'unknown', storage: 'unknown' },
    ...workspaceHealth(ctx),
  };
}

export const deploymentOperations = [
  operation('GET', '/health', 'ops_get_deployment_health', 'Read deployment and role health', ctx => deploymentHealth(ctx)),
  operation('GET', '/workspace-health', 'ops_get_health', 'Read scoped connector and sync health', ctx => workspaceHealth(ctx), { mcp: true }),
  operation('GET', '/settings', 'ops_list_setting', 'Read masked deployment settings', ctx => tenantStore(ctx).list('deployment_setting').map(settingsView)),
  operation('PUT', '/settings/:key', 'ops_update_setting', 'Set a supported deployment setting', (ctx, {params, body}) => settingsView(updateSetting(ctx, params.key, body.value))),
  operation('GET', '/callback-endpoints', 'ops_list_callback_endpoint', 'List configured callbacks and polling status', ctx => ctx.list('callback_endpoint').map(row => redact(row))),
  operation('PUT', '/callback-endpoints', 'ops_set_callback_endpoint', 'Configure a provider callback endpoint', (ctx, {body}) => {
    const provider = text(body.provider, 'provider');
    const channel = choice(body.channel ?? 'https', 'channel', ['https', 'sqs', 'eventbridge'] as const);
    if ((provider === 'amazon_sp') === (channel === 'https')) invalid('Amazon notifications use SQS or EventBridge. Other callbacks use HTTPS.');
    const path = text(body.path, 'path');
    if (channel === 'https' && (!/^\/[a-zA-Z0-9_/-]+$/.test(path) || path.startsWith('//'))) invalid('HTTPS callback requires a local route');
    const connection = body.connection_id == null ? null : text(body.connection_id, 'connection_id');
    const row = upsert(ctx, 'callback_endpoint', { provider, channel, connection_id: connection }, { path,
      verify_secret_id: body.verify_secret_id == null ? null : text(body.verify_secret_id, 'verify_secret_id'),
      reachable: null, last_check_at: null, fallback_polling: false });
    return redact(change(ctx, 'ops.callback.updated', 'callback_endpoint', row));
  }),
  operation('POST', '/callback-endpoints/:id/probe', 'ops_probe_callback_endpoint', 'Check callback reachability with the configured probe', (ctx, {params}) => {
    const endpoint = ctx.get('callback_endpoint', params.id);
    const probe = services(ctx).probeCallback ?? unavailable('callback_probe');
    const reachable = probe(ctx, endpoint);
    const observation = providers.includes(endpoint.provider as typeof providers[number]) && typeof endpoint.connection_id === 'string'
      ? recordProviderObservation(ctx, { provider: String(endpoint.provider), connection_id: endpoint.connection_id, callback: reachable ? 'reachable' : 'unreachable' })
      : endpoint;
    const blocked = precheck(ctx, observation).fallback === 'file_import';
    return redact(ctx.update('callback_endpoint', endpoint.id, { reachable, last_check_at: ctx.now, fallback_polling: !reachable && !blocked }));
  }, { external: true }),
  operation('GET', '/releases', 'ops_list_system_release', 'Read installed release records', ctx => tenantStore(ctx).list('system_release')),
  operation('GET', '/component-compat', 'ops_list_component_compat', 'Read component compatibility records', ctx => tenantStore(ctx).list('component_compat')),
  operation('PUT', '/component-compat/:id', 'ops_update_component_compat', 'Adjust an installed private component policy', (ctx, {params, body}) => {
    if (services(ctx).deploymentMode !== 'private') throw new Problem(403, 'forbidden', 'Component publishing requires platform release authority');
    if (Object.keys(body).some(key => key !== 'status' && key !== 'supported_modes')) invalid('Only status and supported_modes can be adjusted');
    const store = tenantStore(ctx);
    const record = store.get('component_compat', params.id);
    const values: Data = {};
    if (body.status !== undefined) values.status = choice(body.status, 'status', ['supported', 'deprecated', 'blocked'] as const);
    if (body.supported_modes !== undefined) {
      if (record.component_type !== 'connector_task') invalid('Only connector tasks declare supported modes');
      values.supported_modes = strings(body.supported_modes, 'supported_modes').map(mode => choice(mode, 'mode', ['assist', 'auto'] as const));
    }
    return change(ctx, values.status === 'blocked' ? 'ops.component.blocked' : 'ops.component.updated', 'component_compat', store.update('component_compat', record.id, values));
  }),
  operation('GET', '/auto-terms', 'ops_list_auto_terms', 'Read installed auto-mode terms', ctx => tenantStore(ctx).list('auto_terms')),
  operation('POST', '/auto-terms', 'ops_publish_auto_terms', 'Restrict auto-mode terms publishing to platform release authority', ctx => {
    if (services(ctx).deploymentMode === 'private') throw new Problem(404, 'not_found', 'Resource not found');
    throw new Problem(403, 'forbidden', 'Terms publishing requires platform release authority');
  }),
  operation('GET', '/auto-terms/:version', 'ops_get_auto_terms', 'Read installed terms by version', (ctx, {params}) => tenantStore(ctx).list('auto_terms').filter(row => row.terms_version === params.version)),
  operation('POST', '/maintenance-windows', 'ops_create_maintenance_window', 'Schedule a maintenance pause', (ctx, {body}) => {
    const starts = instant(body.starts_at, 'starts_at');
    const ends = instant(body.ends_at, 'ends_at');
    if (ends <= starts || ends <= ctx.now || typeof body.pause_side_effects !== 'boolean') invalid('Invalid maintenance window');
    return change(ctx, 'ops.maintenance.scheduled', 'maintenance_window', tenantStore(ctx).create('maintenance_window', {
      starts_at: starts, ends_at: ends, pause_side_effects: body.pause_side_effects,
    }));
  }),
  operation('POST', '/upgrade-runs', 'ops_create_upgrade_run', 'Record the host upgrade preflight result', (ctx, {body}) => {
    const store = tenantStore(ctx);
    const release = store.get('system_release', text(body.release_id, 'release_id'));
    const preflight = services(ctx).upgradePreflight ?? unavailable('upgrade_preflight');
    const checked = preflight(ctx, release);
    const outstanding = integer(checked.outstanding_side_effects, 'outstanding_side_effects');
    return change(ctx, 'ops.upgrade.preflight_completed', 'upgrade_run', store.create('upgrade_run', {
      release_id: release.id, preflight: checked,
      status: checked.migration_ok === true && checked.connector_compat_ok === true && outstanding === 0 ? 'preflight_passed' : 'preflight_blocked',
    }));
  }, { external: true }),
];
