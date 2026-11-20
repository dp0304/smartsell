import { type Context, type Row } from '@smartsell/contracts';
import { audit, change, choice, conflict, instant, integer, object, operation, redact, services, text, unavailable } from './support.js';
import { raiseAlert } from './controls.js';

function auditRows(ctx: Context, query: Record<string, string>) {
  const from = query.from ? instant(query.from, 'from') : undefined;
  const to = query.to ? instant(query.to, 'to') : undefined;
  return ctx.list('audit_event').filter(row => (!query.actor || row.actor_id === query.actor)
    && (!query.action || row.action === query.action) && (!query.resource || row.resource_id === query.resource)
    && (!query.agent_job_id || row.agent_job_id === query.agent_job_id)
    && (!from || row.created_at >= from) && (!to || row.created_at <= to));
}

export function reportConnectorAutoStopped(ctx: Context, accountId: string, reason: string, blockId: string, location: 'browser' | 'mobile'): Row | undefined {
  if (reason === 'terms_outdated') return;
  return raiseAlert(ctx, 'connector_auto_stopped', text(accountId, 'account_id'), 'warning', {
    reason: text(reason, 'reason'), block_id: text(blockId, 'block_id'), location,
  });
}

function credentialView(row: Row) {
  return { id: row.id, purpose: row.purpose, provider: row.provider, status: row.status, expires_at: row.expires_at,
    last_used_at: row.last_used_at, created_at: row.created_at };
}

export const governanceOperations = [
  operation('GET', '/members', 'ops_list_member', 'Read scoped tenant members', ctx => {
    const list = services(ctx).members ?? unavailable('tenant_member_directory');
    return list(ctx).map(row => ({ id: row.id, name: row.name, role: row.role, status: row.status, version: row.version }));
  }),
  operation('PATCH', '/members/:id/disable', 'ops_disable_member', 'Disable a member and revoke credentials', (ctx, {params, body}) => {
    const disable = services(ctx).disableMember ?? unavailable('member_revocation');
    const reason = text(body.reason, 'reason');
    disable(ctx, params.id);
    audit(ctx, 'ops.member.disabled', 'member', params.id, { reason });
    ctx.emit('ops.member.disabled', { member_id: params.id, actor: ctx.actorId });
    return { id: params.id, status: 'disabled' };
  }),
  operation('GET', '/credentials', 'ops_list_credential', 'List credential metadata', ctx => {
    const list = services(ctx).credentials ?? unavailable('credential_directory');
    return list(ctx).map(credentialView);
  }),
  operation('POST', '/credentials/:id/revoke', 'ops_revoke_credential', 'Revoke credential via its owning service', (ctx, {params, body}) => {
    const revoke = services(ctx).revokeCredential ?? unavailable('credential_revocation');
    const reason = text(body.reason, 'reason');
    revoke(ctx, params.id);
    audit(ctx, 'ops.credential.revoked', 'credential', params.id, { reason });
    return { id: params.id, status: 'revoked' };
  }),
  operation('GET', '/audit-events', 'audit_query', 'Query scoped audit events', (ctx, {query}) => redact(auditRows(ctx, query)), { mcp: true }),
  operation('GET', '/exports', 'ops_list_export', 'List export requests', ctx => ctx.list('export_record')),
  operation('POST', '/exports', 'ops_create_export', 'Export eligible workspace data', (ctx, {body}) => {
    const selection = text(body.selection, 'selection');
    const data = selection === 'audit_event' ? redact(auditRows(ctx, {}))
      : redact((services(ctx).exportData ?? unavailable('authorized_export'))(ctx, selection));
    const row = change(ctx, 'ops.export.created', 'export_record', ctx.create('export_record', { selection, status: 'completed' }));
    return { export: row, data };
  }),
  operation('GET', '/alert-rules', 'ops_list_alert_rule', 'List monitoring rules', ctx => ctx.list('alert_rule')),
  operation('POST', '/alert-rules', 'ops_create_alert_rule', 'Configure a monitoring threshold', (ctx, {body}) => {
    const condition = object(body.condition, 'condition');
    return change(ctx, 'ops.alert.rule_created', 'alert_rule', ctx.create('alert_rule', {
      name: text(body.name, 'name'), signal: text(body.signal, 'signal'),
      severity: choice(body.severity, 'severity', ['critical', 'warning', 'info'] as const),
      condition: { op: choice(condition.op, 'op', ['>', '>=', '<', '<='] as const),
        threshold: integer(condition.threshold, 'threshold'), window_minutes: integer(condition.window_minutes, 'window_minutes', 1, 10080) },
      enabled: true,
    }));
  }),
  operation('GET', '/alert-incidents', 'ops_list_alert_incident', 'List active and resolved incidents', ctx => redact([
    ...ctx.list('alert_incident'), ...((ctx as import('./support.js').OpsContext).tenantScope?.list('alert_incident') ?? []),
  ])),
  ...(['ack', 'resolve'] as const).map(action => operation('POST', `/alert-incidents/:id/${action}`, `ops_${action}_alert_incident`,
    `${action === 'ack' ? 'Acknowledge' : 'Resolve'} an alert incident`, (ctx, {params, body}) => {
      const shared = (ctx as import('./support.js').OpsContext).tenantScope;
      const store = ctx.list('alert_incident').some(row => row.id === params.id) ? ctx : shared ?? ctx;
      const incident = store.get('alert_incident', params.id);
      if (incident.status === 'resolved') conflict('incident_resolved', 'Incident is already resolved');
      const values = action === 'ack' ? { status: 'acknowledged', acknowledged_by: ctx.actorId, acknowledged_at: ctx.now }
        : { status: 'resolved', resolution_note: text(body.reason, 'reason'), resolved_at: ctx.now };
      return redact(change(ctx, action === 'ack' ? 'ops.alert.acknowledged' : 'ops.alert.resolved', 'alert_incident',
        store.update('alert_incident', incident.id, values)));
    })),
  operation('POST', '/diagnostic-bundles', 'ops_create_diagnostic_bundle', 'Read redacted diagnostic data for an operation', (ctx, {body}) => {
    const id = text(body.operation_id, 'operation_id');
    const row = ctx.get('operation', id);
    const bundle = { operation: { id, kind: row.kind, status: row.status, queue: row.queue, error_code: row.error_code },
      audit: redact(auditRows(ctx, { resource: id })) };
    audit(ctx, 'ops.diagnostic.created', 'operation', id);
    return bundle;
  }),
];
