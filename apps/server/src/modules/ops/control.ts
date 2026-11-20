import { admins, DomainError, text, type Context, type Entity } from '../types.js';
import { workspaceHalt } from '../account/policy.js';
import { deviceOnline } from '../account/devices.js';
import { capabilities, changed, choice, command, flag, invalid, object, ops, policyScope, reason, save, tenantAdmin, tenantDefault } from './command-support.js';

const settings = 'deployment_setting';
const pause = 'job_pause_rule';
const safeMode = 'safe_mode';
const roles = ['api', 'mcp', 'worker', 'media', 'scheduler', 'ingress', 'public'] as const;
const states = ['ok', 'degraded', 'down'] as const;
const connectorRuleId = (scope: string) => `connector_auto:${scope}`;

export async function isSafeMode(ctx: Context): Promise<boolean> {
  const [local, global] = await Promise.all([ctx.get(ops, settings, safeMode), tenantDefault(ctx, settings, safeMode)]);
  return local?.data.enabled === true || global?.data.enabled === true;
}

/** Graphile-worker flags. The scheduler should separately consult isSafeMode before expanding targets. */
export async function forbiddenJobFlags(ctx: Context): Promise<string[]> {
  const active = (await ctx.list(ops, pause)).filter(row => row.data.active === true
    && (row.data.expires_at == null || Date.parse(row.data.expires_at) > Date.parse(ctx.now)));
  const flags = new Set<string>();
  if (await isSafeMode(ctx)) flags.add('fx');
  const prefixes = new Map([['queue', 'q'], ['provider', 'p'], ['workspace', 'ws'], ['task_kind', 'k']]);
  for (const row of active) {
    const prefix = prefixes.get(row.data.scope);
    if (prefix) flags.add(`${prefix}:${row.data.scope_value}`);
    if (row.data.scope === 'side_effect' && row.data.scope_value === 'all') flags.add('fx');
  }
  return [...flags];
}

function stopped(rule?: Entity): boolean {
  return rule?.data.scope === 'connector_auto' && rule.data.active === true;
}

export async function isConnectorAutoStopped(ctx: Context): Promise<boolean> {
  const [workspace, all, accountPolicy] = await Promise.all([
    ctx.get(ops, pause, connectorRuleId(ctx.workspaceId)), tenantDefault(ctx, pause, connectorRuleId('all')),
    ctx.get('account', 'connector_auto_policy', 'connector_auto_policy'),
  ]);
  return stopped(workspace) || stopped(all) || accountPolicy?.data.halted === true;
}

/** Account or workspace creation can call this from its transaction to apply a current global stop. */
export async function inheritConnectorAutoStop(ctx: Context): Promise<void> {
  const global = await tenantDefault(ctx, pause, connectorRuleId('all'));
  if (global && stopped(global)) await workspaceHalt(ctx, true, global.data.reason, global.id);
}

async function changeConnectorStop(ctx: Context, input: Record<string, unknown>, enabled: boolean) {
  const scope = input.scope_value ?? ctx.workspaceId;
  if (scope !== 'all' && scope !== ctx.workspaceId) throw new DomainError('not_found', 'Workspace not found', 404);
  const note = reason(input);
  const id = connectorRuleId(scope);
  const host = capabilities(ctx);
  const records = scope === 'all' ? tenantAdmin(ctx) : ctx;
  if (scope === 'all' && !host.opsProjectConnectorHalt) {
    throw new DomainError('ops_capability_unavailable', 'Tenant connector halt projection unavailable', 503);
  }
  const existing = await records.get(ops, pause, id);
  if (!enabled && !existing) throw new DomainError('not_found', 'Emergency stop rule not found', 404);
  const rule = await save(records, pause, id, {
    scope: 'connector_auto', scope_value: scope, workspace_id: scope === 'all' ? null : scope,
    reason: note, active: enabled, enabled, stopped: enabled, expires_at: null,
  }, input.version);
  if (scope === 'all') await host.opsProjectConnectorHalt!(scope, rule.id, enabled, note);
  else await workspaceHalt(ctx, enabled, note, rule.id);
  return changed(ctx, `ops.connector_auto.${enabled ? 'stopped' : 'resumed'}`, rule,
    { rule_id: rule.id, scope: 'connector_auto', scope_value: scope, reason: note });
}

/** Process-owned heartbeat writer. The host calls this every 15 seconds. */
export async function recordHeartbeat(ctx: Context, input: Record<string, unknown>) {
  const id = text(input, 'node_id', 128);
  if (!Array.isArray(input.roles) || input.roles.length < 1 || input.roles.length > roles.length) return invalid('Invalid roles');
  const nodeRoles = [...new Set(input.roles.map(role => choice(role, roles, 'role')))];
  const status = object(input.status, 'status');
  const queueLag = status.queue_lag_s;
  if (queueLag !== undefined && (typeof queueLag !== 'number' || !Number.isFinite(queueLag) || queueLag < 0)) return invalid('Invalid queue_lag_s');
  const store = capabilities(ctx).opsTenantStore ?? ctx;
  const previous = await store.get(ops, 'node_heartbeat', id);
  const data = { node_id: id, roles: nodeRoles, version: text(input, 'version', 128),
    last_seen_at: ctx.now, started_at: previous?.data.started_at ?? ctx.now, status: {
      db: choice(status.db, states, 'db'), storage: choice(status.storage, states, 'storage'), queue_lag_s: queueLag ?? null,
    } };
  return previous ? store.update(ops, 'node_heartbeat', id, data, previous.version) : store.insert(ops, 'node_heartbeat', data, id);
}

async function health(ctx: Context) {
  const host = capabilities(ctx);
  const store = (host.opsTenantRole && host.opsTenantStore) || ctx;
  const [heartbeats, connectors, mobiles, prechecks] = await Promise.all([
    store.list(ops, 'node_heartbeat'), store.list('account', 'device'), store.list('account', 'mobile_device'),
    store.list(ops, 'deployment_precheck'),
  ]);
  const now = Date.parse(ctx.now);
  const fresh = (timestamp: string, ms: number) => now >= Date.parse(timestamp) && now - Date.parse(timestamp) < ms;
  const nodes = heartbeats.map(({ data }) => ({
    node_id: data.node_id, roles: data.roles, version: data.version, last_seen_at: data.last_seen_at,
    started_at: data.started_at, status: data.status, online: fresh(data.last_seen_at, 30_000),
  }));
  const active = nodes.filter(node => node.online);
  const status = (key: 'db' | 'storage') => {
    const observed = active.map(node => node.status?.[key]);
    return observed.includes('down') ? 'down' : observed.includes('degraded') ? 'degraded' : observed.includes('ok') ? 'ok' : 'unknown';
  };
  const queueLags = active.flatMap(node => {
    const lag = node.status?.queue_lag_s;
    return typeof lag === 'number' && Number.isFinite(lag) ? [lag] : [];
  });
  const onlineConnectors = new Set(connectors.filter(row => deviceOnline(ctx, row)).map(row => row.id));
  const onlineMobiles = mobiles.filter(({ data }) => data.status === 'active' && onlineConnectors.has(data.device_id)
    && fresh(data.last_seen_at, 90_000));
  return { safe_mode: await isSafeMode(ctx), connector_auto_stopped: await isConnectorAutoStopped(ctx),
    nodes, db: status('db'), storage: status('storage'), queue_lag_s: queueLags.length ? Math.max(...queueLags) : null,
    connectors_online: onlineConnectors.size, mobile_devices_online: onlineMobiles.length,
    deployment_prechecks: prechecks.map(({ data }) => ({ provider: data.provider, status: data.status, fallback: data.fallback })) };
}

export const controlCommands = {
  health: command(admins, health),
  set_safe_mode: command(admins, async (ctx, input) => {
    const scope = policyScope(ctx, input);
    const enabled = flag(input.enabled, 'enabled');
    const note = reason(input);
    const store = scope === null ? tenantAdmin(ctx) : ctx;
    return changed(ctx, `ops.safe_mode.${enabled ? 'entered' : 'exited'}`, await save(store, settings, safeMode, {
      key: safeMode, workspace_id: scope, enabled, value: enabled, reason: note,
    }, input.version), { workspace_id: scope, enabled, reason: note });
  }),
  get_connector_auto: command(admins, async ctx => {
    const [workspaceRule, tenantRule, bindings] = await Promise.all([
      ctx.get(ops, pause, connectorRuleId(ctx.workspaceId)), tenantDefault(ctx, pause, connectorRuleId('all')),
      ctx.list('account', 'account_execution_binding'),
    ]);
    const now = Date.parse(ctx.now);
    const counts = { browser: 0, mobile: 0 };
    const recentStops = [];
    for (const { id, data } of bindings) {
      const channel = data.connector_channel === 'mobile' ? 'mobile' : 'browser';
      if (data.connector_mode === 'auto') counts[channel]++;
      const stoppedAt = Date.parse(data.auto_stopped_at);
      if (stoppedAt <= now && now - stoppedAt < 86_400_000) {
        recentStops.push({ binding_id: id, channel, reason: data.auto_stop_reason, stopped_at: data.auto_stopped_at });
      }
    }
    return { stopped: await isConnectorAutoStopped(ctx), tenant_stopped: stopped(tenantRule),
      ops_workspace_stopped: stopped(workspaceRule), enabled_accounts: counts, recent_stops: recentStops };
  }),
  emergency_stop: command(admins, (ctx, input) => changeConnectorStop(ctx, input, true)),
  resume_connector_auto: command(admins, (ctx, input) => changeConnectorStop(ctx, input, false)),
};
