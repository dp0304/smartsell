import type { Context, Data, Row } from '@smartsell/contracts';
import { drainConnectorTasks, expireConnectorTasks } from './connector-service.ts';
import { bindingFor, connectorReady, sessionFor } from './device-control.ts';
import { audit, fail, find, one, text, time } from './input.ts';

export function activeMigration(ctx: Context, accountId: string) {
  return find(ctx, 'binding_migration', { social_account_id: accountId, status: 'draining' });
}

export function migrationImpact(ctx: Context, binding: Row, source: Row = binding) {
  const recorded = Array.isArray(source.affected_connector_task_ids) ? source.affected_connector_task_ids : [];
  const sourceDeviceId = source.source_device_id ?? binding.device_id;
  const sourcePhoneId = source === binding ? binding.mobile_device_id ?? null : source.source_mobile_device_id;
  const connector = ctx.list('connector_task').filter(row => row.binding_id === binding.id &&
    (recorded.includes(row.id) || (row.device_id === sourceDeviceId && (row.mobile_device_id ?? null) === sourcePhoneId)));
  const byAttempt = new Map(connector.map(row => [row.attempt_id, row]));
  const originalAttempts = new Map(ctx.list('execution_attempt')
    .filter(row => ['submitted', 'accepted', 'unknown'].includes(String(row.status)) || byAttempt.get(row.id)?.status === 'outcome_unknown')
    .map(row => [row.task_id, row.id]));
  const queued: Data[] = [], draining: Data[] = [], retained: Data[] = [];
  const affectedTaskIds = source.status === 'completed' && Array.isArray(source.affected_task_ids) ? new Set(source.affected_task_ids) : undefined;
  for (const task of ctx.list('execution_task').filter(row => row.social_account_id === binding.social_account_id &&
    (!affectedTaskIds || affectedTaskIds.has(row.id)))) {
    if (['published', 'failed', 'cancelled', 'expired'].includes(String(task.status))) continue;
    const attemptId = task.active_attempt_id ?? originalAttempts.get(task.id);
    const claim = byAttempt.get(attemptId);
    const entry = { id: task.id, status: task.status, attempt_id: attemptId };
    if (claim?.status === 'outcome_unknown' || originalAttempts.has(task.id) || ['accepted', 'outcome_unknown', 'cancel_pending'].includes(String(task.status))) retained.push(entry);
    else if (claim?.status === 'claimed') draining.push(entry);
    else if (claim?.status === 'queued' || ['queued', 'scheduled', 'blocked', 'retryable'].includes(String(task.status))) queued.push(entry);
  }
  return { binding_id: binding.id, queued, draining, retained,
    execution_task_ids: [...queued, ...draining, ...retained].map(row => row.id),
    connector_task_ids: connector.filter(row => ['queued', 'claimed', 'outcome_unknown'].includes(String(row.status))).map(row => row.id) };
}

export function migrationStatus(ctx: Context, binding: Row) {
  const migration = activeMigration(ctx, String(binding.social_account_id)) ??
    ctx.list('binding_migration').filter(row => row.source_binding_id === binding.id).at(-1) ?? null;
  return { migration, impact: migrationImpact(ctx, binding, migration ?? binding) };
}

export function startMigration(ctx: Context, binding: Row, body: Data) {
  const account = ctx.get('social_account', String(binding.social_account_id));
  if (activeMigration(ctx, account.id)) fail('MIGRATION_IN_PROGRESS');
  if (!binding.device_id || account.status !== 'active' || body.owned_account_confirmed !== true) fail('EXECUTION_BINDING_INVALID');
  const channel = one(body.connector_channel, ['browser', 'mobile'] as const);
  const device = ctx.get('connector_device', text(body.device_id));
  if (device.status !== 'active') fail('EXECUTION_BINDING_INVALID');
  const phone = channel === 'mobile' ? ctx.get('mobile_device', text(body.mobile_device_id)) : undefined;
  const app = phone ? text(body.mobile_app) : null;
  if (device.id === binding.device_id && channel === binding.connector_channel && (phone?.id ?? null) === (binding.mobile_device_id ?? null)) fail('MIGRATION_TARGET_UNCHANGED');
  let session: Row;
  if (phone) {
    const link = sessionFor(ctx, { ...binding, connector_channel: 'mobile', mobile_device_id: phone.id, mobile_app: app, device_id: device.id });
    if (!link || phone.device_id !== device.id || phone.status !== 'ready') fail('MOBILE_APP_BINDING_INVALID');
    session = ctx.update('mobile_app_binding', link.id, { status: 'pending_identity', verified_at: null });
    ctx.emit('account.mobile_app.identity_requested', { binding_id: session.id, device_id: device.id });
  } else {
    session = ctx.create('browser_session', { social_account_id: account.id, device_id: device.id, binding_id: binding.id, status: 'pending_identity' });
    ctx.emit('account.browser_session.login_requested', { session_id: session.id, device_id: device.id });
  }
  const affected = migrationImpact(ctx, binding);
  drainConnectorTasks(ctx, row => row.binding_id === binding.id, true);
  ctx.update('account_execution_binding', binding.id, { paused: true });
  const migration = ctx.create('binding_migration', {
    social_account_id: account.id, source_binding_id: binding.id, source_device_id: binding.device_id,
    source_connector_channel: binding.connector_channel, source_mobile_device_id: binding.mobile_device_id ?? null,
    target_device_id: device.id, target_connector_channel: channel, target_mobile_device_id: phone?.id ?? null,
    target_mobile_app: app, target_session_id: session.id, status: 'draining', started_by: ctx.actorId,
    affected_task_ids: affected.execution_task_ids, affected_connector_task_ids: affected.connector_task_ids,
    unknown_outcome_count: affected.retained.length,
  });
  audit(ctx, 'account.binding_migration.started', { migration_id: migration.id, binding_id: binding.id });
  ctx.emit('account.binding_migration.started', { migration_id: migration.id, binding_id: binding.id, social_account_id: account.id });
  return { migration, impact: affected };
}

export function completeMigration(ctx: Context, accountId: string) {
  const binding = bindingFor(ctx, accountId) ?? fail('BINDING_NOT_CONFIGURED');
  const migration = activeMigration(ctx, accountId);
  if (!migration) {
    const result = migrationStatus(ctx, binding);
    if (result.migration?.status === 'completed') return result;
    return fail('MIGRATION_NOT_STARTED');
  }
  expireConnectorTasks(ctx);
  if (ctx.list('connector_task').some(row => row.binding_id === binding.id && row.status === 'claimed')) fail('EXECUTION_DRAIN_REQUIRED');
  const target = {
    ...binding, device_id: migration.target_device_id, connector_channel: migration.target_connector_channel,
    mobile_device_id: migration.target_mobile_device_id, mobile_app: migration.target_mobile_app,
    paused: false, connector_mode: 'assist', auto_ack_at: null, auto_ack_by: null, auto_ack_terms_version: null,
    auto_ack_generation: Number(binding.auto_ack_generation ?? 0) + 1, auto_failure_streak: 0,
  };
  const session = sessionFor(ctx, target);
  if (!session || session.id !== migration.target_session_id || session.status !== 'verified' ||
      Date.parse(String(session.verified_at)) < Date.parse(migration.created_at)) fail('FRESH_IDENTITY_CHECK_REQUIRED');
  if (ctx.get('social_account', accountId).status !== 'active' || !connectorReady(ctx, target)) fail('MIGRATION_TARGET_NOT_READY');
  const impact = migrationImpact(ctx, binding, migration);
  for (const row of ctx.list('browser_session').filter(row => row.binding_id === binding.id && row.id !== session.id && row.status !== 'revoked')) {
    ctx.update('browser_session', row.id, { status: 'revoked' });
  }
  const { device_id, connector_channel, mobile_device_id, mobile_app, paused, connector_mode, auto_ack_at, auto_ack_by,
    auto_ack_terms_version, auto_ack_generation, auto_failure_streak } = target;
  ctx.update('account_execution_binding', binding.id, { device_id, connector_channel, mobile_device_id, mobile_app, paused, connector_mode,
    auto_ack_at, auto_ack_by, auto_ack_terms_version, auto_ack_generation, auto_failure_streak });
  const completed = ctx.update('binding_migration', migration.id, {
    status: 'completed', completed_at: ctx.now, completed_by: ctx.actorId, unknown_outcome_count: impact.retained.length,
    affected_task_ids: [...new Set([...(migration.affected_task_ids as string[]), ...impact.execution_task_ids])],
  });
  audit(ctx, 'account.binding_migration.completed', { migration_id: migration.id, binding_id: binding.id });
  ctx.emit('account.binding.changed', { binding_id: binding.id, social_account_id: accountId });
  return { migration: completed, impact };
}
