import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { change, choice, conflict, future, invalid, object, operation, services, tenantScope, tenantStore, requireTenantAdmin, text, upsert, type JobSelector } from './support.js';
import { assertLicenseAllowed } from './metering.js';

const ordinaryScopes = ['queue', 'provider', 'workspace', 'side_effect', 'task_kind'] as const;
const active = (ctx: Context, row: Row) => row.active === true && (!row.expires_at || Date.parse(String(row.expires_at)) > Date.parse(ctx.now));
const activeRules = (ctx: Context) => [...(tenantScope(ctx)?.list('job_pause_rule') ?? []), ...ctx.list('job_pause_rule')]
  .filter(row => active(ctx, row));

function accountPolicyHalted(row?: Row): boolean {
  if (!row) return false;
  const hasSources = typeof row.halted_by_workspace === 'boolean' || Array.isArray(row.ops_halt_rule_ids);
  return hasSources
    ? row.halted_by_workspace === true || (Array.isArray(row.ops_halt_rule_ids) && row.ops_halt_rule_ids.length > 0)
    : row.halted === true;
}

export function isEmergencyStopped(ctx: Context): boolean {
  return activeRules(ctx).some(row => row.scope === 'connector_auto' && ['all', ctx.workspaceId].includes(String(row.scope_value)))
    || ctx.list('connector_auto_policy').some(accountPolicyHalted);
}

export function assertEmergencyNotStopped(ctx: Context): void {
  if (isEmergencyStopped(ctx)) conflict('emergency_halt', 'Automatic connector activity is stopped');
}

export function isSafeMode(ctx: Context): boolean {
  return [...(tenantScope(ctx)?.list('restore_run') ?? []), ...ctx.list('restore_run')]
    .some(row => ['restoring', 'safe_mode', 'reconciling', 'needs_decision', 'failed'].includes(String(row.status)));
}

export function isJobPaused(ctx: Context, job: JobSelector): boolean {
  if (job.side_effect && (isSafeMode(ctx) || [...(tenantScope(ctx)?.list('maintenance_window') ?? []), ...ctx.list('maintenance_window')]
    .some(row => row.pause_side_effects === true && String(row.starts_at) <= ctx.now && ctx.now < String(row.ends_at)))) return true;
  const flags: Data = { queue: job.queue, provider: job.provider, task_kind: job.task_kind,
    workspace: ctx.workspaceId, side_effect: job.side_effect ? 'all' : undefined };
  return activeRules(ctx).some(row => ordinaryScopes.includes(row.scope as typeof ordinaryScopes[number])
    && flags[String(row.scope)] === row.scope_value);
}

export function isQueuePaused(ctx: Context, queue: string): boolean { return isJobPaused(ctx, { queue }); }

export function assertJobAllowed(ctx: Context, job: JobSelector): void {
  if (isJobPaused(ctx, job)) conflict('job_paused', 'The operations policy pauses this job');
  if (job.side_effect) assertLicenseAllowed(ctx, 'new_side_effect');
}

export function raiseAlert(ctx: Context, signal: string, scopeKey: string, severity: 'warning' | 'critical' | 'info', snapshot: Data = {}, tenant = false): Row {
  const store = tenant ? tenantStore(ctx) : ctx;
  const prior = store.list('alert_incident').find(row => row.signal === signal && row.scope_key === scopeKey && row.status !== 'resolved');
  if (prior) return store.update('alert_incident', prior.id, { snapshot, last_seen_at: ctx.now, occurrences: Number(prior.occurrences) + 1 });
  return change(ctx, 'ops.alert.raised', 'alert_incident', store.create('alert_incident', {
    signal, scope_key: scopeKey, severity, snapshot, first_seen_at: ctx.now, last_seen_at: ctx.now, status: 'open', occurrences: 1,
    notify_roles: ['owner', 'admin'],
  }), { signal, scope_key: scopeKey, severity });
}

function setEmergency(ctx: Context, body: Data, halt: boolean): Row {
  const scope = text(body.scope, 'scope');
  if (scope !== 'all' && scope !== ctx.workspaceId) throw new Problem(403, 'forbidden', 'Workspace is outside the operation scope');
  const reason = text(body.reason, 'reason');
  if (halt && body.confirmed !== true) invalid('Emergency stop requires confirmation');
  if (scope === 'all') requireTenantAdmin(ctx);
  const store = scope === 'all' ? tenantStore(ctx) : ctx;
  const previous = store.list('job_pause_rule').find(row => row.scope === 'connector_auto' && row.scope_value === scope && row.active === true);
  if (halt && previous) return previous;
  if (!halt && !previous) conflict('emergency_stop_inactive', 'No active emergency stop at this scope');
  const rule = previous
    ? store.update('job_pause_rule', previous.id, { active: false, resumed_by: ctx.actorId, resumed_at: ctx.now, resume_reason: reason })
    : store.create('job_pause_rule', { scope: 'connector_auto', scope_value: scope, active: true, reason, actor_id: ctx.actorId, expires_at: null });
  const setAccountHalt = services(ctx).setConnectorAutoHalt;
  if (setAccountHalt) {
    setAccountHalt({ rule_id: rule.id, workspace_ids: scope === 'all' ? 'all' : [ctx.workspaceId],
      halted: halt, reason, actor: ctx.actorId });
  } else if (scope !== 'all') {
    const policy = ctx.list('connector_auto_policy')[0];
    const ids = new Set(Array.isArray(policy?.ops_halt_rule_ids) ? policy.ops_halt_rule_ids as string[] : []);
    if (halt) ids.add(rule.id);
    else ids.delete(rule.id);
    const halted = policy?.halted_by_workspace === true || ids.size > 0;
    const values = { ops_halt_rule_ids: [...ids], halted };
    if (policy) ctx.update('connector_auto_policy', policy.id, values);
    else ctx.create('connector_auto_policy', values);
    if (halted !== accountPolicyHalted(policy)) {
      ctx.emit(halted ? 'account.connector_auto_policy.halted' : 'account.connector_auto_policy.resumed', { source: 'ops', ops_rule_id: rule.id });
    }
  }
  if (halt) raiseAlert(ctx, 'connector_auto_halt_active', scope, 'critical', { rule_id: rule.id }, scope === 'all');
  else {
    const incident = store.list('alert_incident').find(row => row.signal === 'connector_auto_halt_active' && row.scope_key === scope && row.status !== 'resolved');
    if (incident) change(ctx, 'ops.alert.resolved', 'alert_incident', store.update('alert_incident', incident.id,
      { status: 'resolved', resolved_at: ctx.now, resolution_note: reason }));
  }
  return change(ctx, halt ? 'ops.connector_auto.stopped' : 'ops.connector_auto.resumed', 'job_pause_rule', rule,
    { rule_id: rule.id, scope: 'connector_auto', scope_value: scope, reason });
}

const destinationKinds = ['mcp_client', 'model_provider', 'data_vendor', 'outbound_webhook', 'platform_api', 'connector'] as const;
const effects = ['allow', 'allow_masked', 'deny'] as const;
type Effect = typeof effects[number];
type Rule = { destination_kind: string; destination_id?: string; data_class: string; effect: Effect };

function egressPolicies(ctx: Context) { return [ctx.list('egress_policy')[0], tenantScope(ctx)?.list('egress_policy')[0]]; }

export function evaluateEgress(ctx: Context, destination: { kind: string; id?: string }, dataClasses: readonly string[]): Effect {
  if (!destinationKinds.includes(destination.kind as typeof destinationKinds[number]) || dataClasses.length === 0) return 'deny';
  const policies = egressPolicies(ctx);
  const evaluateOne = (dataClass: string): Effect => {
    if (dataClass === 'credential') return 'deny';
    for (const policy of policies) {
      const rules = (policy?.rules ?? []) as Rule[];
      const matching = rules.filter(rule => rule.destination_kind === destination.kind && rule.data_class === dataClass);
      const rule = (destination.id ? matching.find(item => item.destination_id === destination.id) : undefined)
        ?? matching.find(item => !item.destination_id);
      if (rule) return rule.effect;
    }
    return (policies[0]?.default_effect ?? policies[1]?.default_effect ?? 'deny') as Effect;
  };
  const decisions = dataClasses.map(evaluateOne);
  return decisions.includes('deny') ? 'deny' : decisions.includes('allow_masked') ? 'allow_masked' : 'allow';
}

export function setEgressPolicy(ctx: Context, scope: 'workspace' | 'default', rules: unknown, defaultEffect?: unknown): Row {
  if (!Array.isArray(rules) || rules.length > 1000) invalid('rules must be an array');
  const seen = new Set<string>();
  const parsed = rules.map(value => {
    const rule = object(value, 'rule');
    const destination_kind = choice(rule.destination_kind, 'destination_kind', destinationKinds);
    const destination_id = rule.destination_id === undefined || rule.destination_id === null ? undefined : text(rule.destination_id, 'destination_id');
    const dataClasses = Array.isArray(rule.data_classes) ? rule.data_classes : [rule.data_class];
    if (dataClasses.length === 0 || dataClasses.length > 20) invalid('Invalid data_classes');
    const effect = choice(rule.effect, 'effect', effects);
    return dataClasses.map(value => {
      const data_class = text(value, 'data_class');
      if (data_class === 'credential' && effect !== 'deny') invalid('Credentials cannot be sent');
      const key = JSON.stringify([destination_kind, destination_id, data_class]);
      if (seen.has(key)) invalid('Duplicate egress rule');
      seen.add(key);
      return { destination_kind, destination_id, data_class, effect };
    });
  }).flat();
  const store = scope === 'workspace' ? ctx : tenantStore(ctx);
  return change(ctx, 'ops.egress_policy.updated', 'egress_policy', upsert(store, 'egress_policy', {
    workspace_id: scope === 'workspace' ? ctx.workspaceId : null,
  }, { rules: parsed, default_effect: choice(defaultEffect ?? 'deny', 'default_effect', ['allow', 'deny'] as const) }));
}

export function confirmModelEgress(ctx: Context, providerId: string, dataClasses: readonly string[], effect: 'allow' | 'allow_masked' = 'allow'): Row {
  const policy = egressPolicies(ctx)[0];
  const rules = ((policy?.rules ?? []) as Rule[]).filter(rule => rule.destination_kind !== 'model_provider' || rule.destination_id !== providerId);
  return setEgressPolicy(ctx, 'workspace', [...rules, ...[...new Set(dataClasses)].map(data_class => ({
    destination_kind: 'model_provider', destination_id: providerId, data_class, effect,
  }))], policy?.default_effect);
}

export function removeModelEgress(ctx: Context, providerId: string): void {
  const policy = egressPolicies(ctx)[0];
  if (!policy) return;
  const rules = (policy.rules ?? []) as Rule[];
  const remaining = rules.filter(rule => rule.destination_kind !== 'model_provider' || rule.destination_id !== providerId);
  if (remaining.length !== rules.length) setEgressPolicy(ctx, 'workspace', remaining, policy.default_effect);
}

export const controlOperations = [
  operation('GET', '/connector-auto', 'ops_get_connector_auto', 'Read connector emergency stop status', ctx => ({
    halted: isEmergencyStopped(ctx), rules: activeRules(ctx).filter(row => row.scope === 'connector_auto'),
    bindings: ctx.list('account_execution_binding').filter(row => row.connector_mode === 'auto').length,
    recent_stops: ctx.list('alert_incident').filter(row => row.signal === 'connector_auto_stopped'
      && Date.parse(String(row.last_seen_at)) > Date.parse(ctx.now) - 86_400_000),
  })),
  operation('POST', '/connector-auto/emergency-stop', 'ops_emergency_stop', 'Stop automatic connector submission', (ctx, {body}) => setEmergency(ctx, body, true)),
  operation('POST', '/connector-auto/resume', 'ops_resume_connector_auto', 'Remove a specific connector halt', (ctx, {body}) => setEmergency(ctx, body, false)),
  operation('GET', '/job-pause-rules', 'ops_list_job_pause_rules', 'List active job pause rules', ctx => activeRules(ctx)),
  operation('POST', '/job-pause-rules', 'ops_create_job_pause_rule', 'Pause matching jobs', (ctx, {body}) => {
    const scope = choice(body.scope, 'scope', ordinaryScopes);
    const scopeValue = text(body.scope_value, 'scope_value');
    if ((scope === 'workspace' && scopeValue !== ctx.workspaceId) || (scope === 'side_effect' && scopeValue !== 'all')) invalid('Invalid rule scope');
    return change(ctx, 'ops.queue.paused', 'job_pause_rule', ctx.create('job_pause_rule', { scope, scope_value: scopeValue,
      reason: text(body.reason, 'reason'), active: true, expires_at: body.expires_at == null ? null : future(body.expires_at, ctx, 'expires_at') }));
  }),
  operation('DELETE', '/job-pause-rules/:id', 'ops_resume_job_pause_rule', 'Resume matching jobs', (ctx, {params, body}) => {
    const rule = ctx.get('job_pause_rule', params.id);
    if (rule.scope === 'connector_auto') conflict('use_connector_resume', 'Use connector emergency resume');
    return change(ctx, 'ops.queue.resumed', 'job_pause_rule', ctx.update('job_pause_rule', rule.id, {
      active: false, resume_reason: text(body.reason, 'reason'), resumed_at: ctx.now,
    }));
  }),
  operation('GET', '/jobs', 'ops_list_job', 'List recorded jobs and operation state', (ctx, {query}) => ctx.list('operation')
    .filter(row => ['queue', 'status', 'kind'].every(key => !query[key] || row[key] === query[key]))),
  operation('POST', '/jobs/:id/retry', 'ops_retry_job', 'Retry a classified retryable operation', (ctx, {params}) => {
    const row = ctx.get('operation', params.id);
    if (row.side_effect !== false) conflict('reconciliation_required', 'Check the external effect before retrying');
    if (row.status !== 'failed' || row.retryable !== true) conflict('job_not_retryable', 'Operation is not classified as retryable');
    return change(ctx, 'ops.job.retry_requested', 'operation', ctx.update('operation', row.id, { status: 'queued', retry_requested_at: ctx.now }));
  }),
  operation('GET', '/egress-policies', 'ops_list_egress_policy', 'Read applicable egress policies', ctx => egressPolicies(ctx).filter(Boolean)),
  operation('PUT', '/egress-policies/:scope', 'ops_set_egress_policy', 'Set outbound data policy', (ctx, {params, body}) => {
    const scope = params.scope === ctx.workspaceId ? 'workspace' : choice(params.scope, 'scope', ['workspace', 'default'] as const);
    return setEgressPolicy(ctx, scope, body.rules, body.default_effect);
  }),
  operation('POST', '/egress-policies/evaluate', 'ops_evaluate_egress', 'Evaluate an outbound policy', (ctx, {body}) => {
    const destination = object(body.destination, 'destination');
    if (!Array.isArray(body.data_classes)) invalid('data_classes must be an array');
    return { effect: evaluateEgress(ctx, { kind: text(destination.kind, 'destination.kind'),
      id: destination.id === undefined ? undefined : text(destination.id, 'destination.id') }, body.data_classes.map(item => text(item, 'data_class'))) };
  }),
];
