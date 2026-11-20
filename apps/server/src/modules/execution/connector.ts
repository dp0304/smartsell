import { Problem, type Context, type Row } from '@smartsell/contracts';
import { digest, entries, object } from '../../../../../packages/domain/src/publishing/index.js';
import { parseConnectorTask, type ConnectorTask } from '../../../../../packages/connector-tasks/src/tasks.js';
import { enqueueConnectorTask, type ConnectorServices } from '../account/connector-service.js';
import { bindingFor } from '../account/device-control.js';
import { ATTEMPT, SLOT, TASK, executionCheck, find, openAttempt, time } from './service.js';

export type ConnectorDispatch = {
  services: Omit<ConnectorServices, 'authorizeTask'>;
  /** Encode the approved snapshot using the configured task version and media resolver. */
  encode(ctx: Context, task: Row, binding: Row): Omit<ConnectorTask, 'attempt_id'> | undefined;
};

/** Shared by the signed device gateway and enqueue. The device cannot supply authorization. */
export function authorizeConnectorAttempt(ctx: Context, wire: ConnectorTask, fencingToken: number, slotToken: number) {
  const attempt = find(ctx, ATTEMPT, wire.attempt_id);
  const task = find(ctx, TASK, attempt?.task_id);
  if (!attempt || !task || attempt.executor !== 'connector' || attempt.status !== 'claimed' || task.status !== 'running' ||
    task.active_attempt_id !== attempt.id || task.fencing_token !== fencingToken || attempt.fencing_token !== fencingToken ||
    attempt.write_slot_fencing_token !== slotToken || attempt.request_hash !== task.frozen_hash || attempt.wire_digest !== digest(wire) ||
    task.cancel_requested_at || time(task.lease_expires_at) <= time(ctx.now)) return false;
  const slot = ctx.list(SLOT).find(row => row.social_account_id === wire.account_id);
  if (slot?.holder_kind !== 'attempt' || slot.holder_id !== attempt.id || slot.fencing_token !== slotToken || time(slot.lease_expires_at) <= time(ctx.now)) return false;
  const claim = ctx.list('connector_task').find(row => row.attempt_id === attempt.id && row.status === 'claimed');
  const drainingClaim = !!claim && ctx.list('binding_migration').some(row => row.source_binding_id === wire.binding_id && row.status === 'draining');
  const check = executionCheck(ctx, task, drainingClaim);
  return !check.reason && check.assessment?.route === 'connector';
}

export function dispatchConnector(ctx: Context, task: Row, config: ConnectorDispatch) {
  const binding = bindingFor(ctx, String(task.social_account_id));
  if (!binding || !config.services.connectorConfigured?.(ctx, binding.id, 'assist')) return;
  // AC derives the mode from its binding. An explicitly assist-only target cannot use an auto binding.
  const target = ctx.get('publish_target', String(task.publish_target_id));
  if (target.connector_mode_pref === 'assist' && binding.connector_mode === 'auto') return;
  const wire = config.encode(ctx, task, binding);
  if (!wire) return;
  const prepared = parseConnectorTask({ ...wire, attempt_id: task.id });
  const frozen = object(task.frozen);
  const renditions = new Map(entries(frozen.refs).filter(ref => ref.ref_type === 'asset_rendition').map(ref => [ref.ref_id, ref.binding]));
  const versions = new Map(entries(frozen.media_bindings).map(binding => [binding.asset_version_id, binding.sha256]));
  const approvedMedia = entries(frozen.media).filter(media => !media.role || ['primary', 'slide'].includes(String(media.role)))
    .map(media => media.rendition_id ? renditions.get(media.rendition_id) : versions.get(media.asset_version_id));
  if (!prepared.kind.endsWith('.publish') || !('approval' in prepared.payload) || prepared.payload.approval.id !== task.approval_request_id ||
    prepared.payload.revision.id !== task.variant_revision_id || prepared.payload.revision.draft ||
    prepared.payload.revision.body !== (object(frozen.rendered).text ?? '') ||
    prepared.payload.revision.visibility !== (frozen.visibility ?? 'public') ||
    digest(prepared.payload.revision.media.map(media => media.sha256)) !== digest(approvedMedia)) {
    throw new Problem(422, 'CONNECTOR_FORMAT_UNAVAILABLE', 'The connector payload does not match the frozen revision');
  }
  const opened = openAttempt(ctx, task, 'connector', String(binding.device_id));
  const parsed = { ...prepared, attempt_id: opened.attempt.id };
  const attempt = ctx.update(ATTEMPT, opened.attempt.id, { wire_digest: digest(parsed), device_id: binding.device_id,
    connector_channel: binding.connector_channel, connector_mode: binding.connector_mode ?? 'assist', mobile_device_id: binding.mobile_device_id ?? null });
  enqueueConnectorTask(ctx, parsed, {
    fencing_token: Number(attempt.fencing_token), write_slot_token: Number(attempt.write_slot_fencing_token),
    lease_expires_at: String(opened.task.lease_expires_at),
    ...(Number.isFinite(time(task.due_at)) && !task.late_override_at ? { latest_submit_at: new Date(time(task.due_at) + Number(task.grace_minutes) * 60_000).toISOString() } : {}),
  }, { ...config.services, authorizeTask: authorizeConnectorAttempt });
  return ctx.update(TASK, task.id, { route: [{ executor: 'connector', device_id: binding.device_id,
    connector_channel: binding.connector_channel, connector_mode: attempt.connector_mode, mobile_device_id: attempt.mobile_device_id }] });
}
