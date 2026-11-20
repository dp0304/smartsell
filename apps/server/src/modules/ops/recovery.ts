import { type Context, type Data, type Row } from '@smartsell/contracts';
import { change, choice, conflict, instant, integer, invalid, object, operation, services, strings, tenantStore, text, unavailable, upsert } from './support.js';

const backupIncludes = ['database', 'object_storage', 'config'] as const;
const domains = ['publish', 'reply', 'ad_action', 'sample_shipment', 'commission_payment', 'esp_send', 'connector_task'] as const;
const manualDecisions = ['adopt_external', 'keep_cancelled', 'requeue', 'manual'] as const;
type Decision = typeof manualDecisions[number];

function setBackupPolicy(ctx: Context, body: Data): Row {
  const store = tenantStore(ctx);
  const target = object(body.target, 'target');
  const schedule = text(body.schedule, 'schedule');
  if (!/^[\d*/?,\-]+(?:\s+[\d*/?,\-]+){4}$/.test(schedule)) invalid('schedule must be a five-field cron expression');
  const includes = strings(body.includes ?? backupIncludes, 'includes');
  if (backupIncludes.some(item => !includes.includes(item)) || includes.length !== backupIncludes.length) {
    invalid('Consistent backups include database, object storage, and config');
  }
  if (body.pitr_enabled !== undefined && typeof body.pitr_enabled !== 'boolean') invalid('pitr_enabled must be a boolean');
  return change(ctx, 'ops.backup.policy_updated', 'backup_policy', upsert(store, 'backup_policy', { key: 'default' }, {
    schedule, includes, retention_days: integer(body.retention_days, 'retention_days', 1, 36500), pitr_enabled: body.pitr_enabled ?? false,
    target: { destination_id: text(target.destination_id, 'target.destination_id'),
      secret_id: target.secret_id == null ? null : text(target.secret_id, 'target.secret_id') },
  }));
}

export function runBackup(ctx: Context, policyId: string, slot: string): Row {
  const store = tenantStore(ctx);
  const policy = store.get('backup_policy', policyId);
  const key = text(slot, 'slot');
  const prior = store.list('backup_run').find(row => row.policy_id === policyId && row.slot === key);
  if (prior?.status === 'succeeded' || prior?.status === 'verified') return prior;
  const backup = services(ctx).createBackup ?? unavailable('backup_executor');
  const run = prior ?? store.create('backup_run', { policy_id: policyId, slot: key, status: 'running' });
  let manifest: Data;
  try {
    const result = backup(ctx, policy, run.id);
    manifest = {
      consistent_at: instant(result.consistent_at, 'consistent_at'),
      db_snapshot_ref: text(result.db_snapshot_ref, 'db_snapshot_ref'),
      storage_manifest_ref: text(result.storage_manifest_ref, 'storage_manifest_ref'),
      config_ref: text(result.config_ref, 'config_ref'),
    };
    if (Date.parse(manifest.consistent_at as string) > Date.parse(ctx.now)) invalid('Invalid backup timestamp');
  } catch {
    return change(ctx, 'ops.backup.failed', 'backup_run', store.update('backup_run', run.id, { status: 'failed', error: 'backup_failed' }));
  }
  return change(ctx, 'ops.backup.succeeded', 'backup_run', store.update('backup_run', run.id, { ...manifest, status: 'succeeded', error: null }));
}

/** Run only after the restore request commits so the side-effect pause survives external I/O. */
export function executeRestore(ctx: Context, runId: string): Row {
  const store = tenantStore(ctx);
  const run = store.get('restore_run', runId);
  if (run.status === 'safe_mode') return run;
  if (run.status !== 'restoring' && run.status !== 'failed') conflict('invalid_restore_state', 'Restore is not executable');
  const backup = store.get('backup_run', String(run.backup_run_id));
  const restore = services(ctx).restoreBackup ?? unavailable('restore_executor');
  try { restore(ctx, backup, run.id); }
  catch {
    return change(ctx, 'ops.restore.failed', 'restore_run', store.update('restore_run', run.id, { status: 'failed', error: 'restore_failed' }));
  }
  return change(ctx, 'ops.restore.applied', 'restore_run', store.update('restore_run', run.id, { status: 'safe_mode', restored_at: ctx.now, error: null }));
}

function decide(ctx: Context, item: Row, decision: Decision, note: string | null, patch: Data = {}): Row {
  const apply = services(ctx).applyReconciliation ?? unavailable('apply_reconciliation');
  apply(ctx, { ...item, ...patch }, decision);
  return change(ctx, 'ops.restore.item_decided', 'restore_reconciliation_item', tenantStore(ctx)
    .update('restore_reconciliation_item', item.id, { ...patch, decision, decided_by: ctx.actorId, decided_at: ctx.now, note }), { decision });
}

function reconcileRestore(ctx: Context, runId: string): Row {
  const store = tenantStore(ctx);
  const run = store.get('restore_run', runId);
  if (!['safe_mode', 'reconciling', 'needs_decision'].includes(String(run.status))) conflict('invalid_restore_state', 'Restore must complete before reconciliation');
  if (run.reconciled_at && !store.list('restore_reconciliation_item').some(row => row.restore_run_id === run.id && row.decision === 'pending')) return run;
  const candidates = services(ctx).restoreCandidates ?? unavailable('restore_candidates');
  const lookup = services(ctx).reconcile ?? unavailable('external_reconciliation');
  const since = new Date(Date.parse(String(run.restore_point)) - Number(run.safety_margin_minutes) * 60_000).toISOString();
  const seen = new Set<string>();
  for (const candidate of candidates(ctx, since)) {
    const key: Data = { restore_run_id: run.id, domain: choice(candidate.domain, 'domain', domains),
      resource_type: text(candidate.resource_type, 'resource_type'), resource_id: text(candidate.resource_id, 'resource_id') };
    const candidateKey = JSON.stringify(key);
    if (seen.has(candidateKey)) continue;
    seen.add(candidateKey);
    const item = store.list('restore_reconciliation_item').find(row => Object.entries(key).every(([field, value]) => row[field] === value))
      ?? store.create('restore_reconciliation_item', { ...key, db_state: text(candidate.db_state, 'db_state'), decision: 'pending' });
    if (item.decision !== 'pending') continue;
    const remote = lookup(ctx, item);
    if (remote.state === 'present') decide(ctx, item, 'adopt_external', null, { external_state: 'present', evidence_id: text(remote.evidence_id, 'evidence_id') });
    else if (remote.state === 'absent' && remote.approved === true && remote.within_window === true) {
      decide(ctx, item, 'requeue', null, { external_state: 'absent', requeue_allowed: true });
    } else store.update('restore_reconciliation_item', item.id, { external_state: remote.state, requeue_allowed: false });
  }
  const pending = store.list('restore_reconciliation_item').filter(row => row.restore_run_id === run.id && row.decision === 'pending').length;
  return change(ctx, 'ops.restore.reconciliation_completed', 'restore_run', store.update('restore_run', run.id, {
    status: pending ? 'needs_decision' : 'safe_mode', reconciled_at: ctx.now, pending_items: pending,
  }), { pending_items: pending });
}

export const recoveryOperations = [
  operation('GET', '/backup-policies', 'ops_list_backup_policy', 'List backup policies', ctx => tenantStore(ctx).list('backup_policy')),
  operation('PUT', '/backup-policies', 'ops_set_backup_policy', 'Configure a consistent backup policy', (ctx, {body}) => setBackupPolicy(ctx, body)),
  operation('GET', '/backup-runs', 'ops_list_backup_run', 'List real backup results', ctx => tenantStore(ctx).list('backup_run')),
  operation('POST', '/backup-runs', 'ops_create_backup_run', 'Run a configured backup', (ctx, {body, idempotencyKey}) => {
    const slot = idempotencyKey ?? text(body.slot, 'slot');
    return runBackup(ctx, text(body.policy_id, 'policy_id'), slot);
  }, { external: true }),
  operation('POST', '/backup-runs/:id/verify', 'ops_verify_backup_run', 'Verify backup through the configured restore drill', (ctx, {params}) => {
    const store = tenantStore(ctx);
    const backup = store.get('backup_run', params.id);
    if (backup.status === 'verified') return backup;
    if (backup.status !== 'succeeded') conflict('backup_incomplete', 'Only completed backups can be verified');
    const verify = services(ctx).verifyBackup ?? unavailable('backup_verifier');
    if (!verify(ctx, backup)) conflict('backup_not_verified', 'Backup verification did not pass');
    return change(ctx, 'ops.backup.verified', 'backup_run', store.update('backup_run', backup.id, {
      status: 'verified', verified_by_restore_drill_at: ctx.now,
    }));
  }, { external: true }),
  operation('GET', '/restore-runs', 'ops_list_restore_run', 'List restore runs', ctx => tenantStore(ctx).list('restore_run')),
  operation('POST', '/restore-runs', 'ops_create_restore_run', 'Enter safe mode and request a restore', (ctx, {body}) => {
    if (!services(ctx).restoreBackup) unavailable('restore_executor');
    const store = tenantStore(ctx);
    const backup = store.get('backup_run', text(body.backup_run_id, 'backup_run_id'));
    if (!['succeeded', 'verified'].includes(String(backup.status))) conflict('backup_incomplete', 'This backup is not restorable');
    if (store.list('restore_run').some(row => row.status !== 'resumed')) conflict('restore_in_progress', 'Resolve the active restore first');
    return change(ctx, 'ops.safe_mode.entered', 'restore_run', store.create('restore_run', {
      backup_run_id: backup.id, restore_point: backup.consistent_at, status: 'restoring', safe_mode_entered_at: ctx.now,
      safety_margin_minutes: integer(body.safety_margin_minutes ?? 60, 'safety_margin_minutes', 1, 10080),
    }));
  }),
  operation('POST', '/restore-runs/:id/execute', 'ops_execute_restore_run', 'Execute committed restore request', (ctx, {params}) => executeRestore(ctx, params.id), { external: true }),
  operation('POST', '/restore-runs/:id/reconcile', 'ops_reconcile_restore_run', 'Reconcile restored actions against authoritative external results', (ctx, {params}) => reconcileRestore(ctx, params.id), { external: true }),
  operation('GET', '/restore-runs/:id/items', 'ops_list_restore_reconciliation_item', 'List reconciliation items for a restore', (ctx, {params}) => {
    const store = tenantStore(ctx);
    const run = store.get('restore_run', params.id);
    return store.list('restore_reconciliation_item').filter(row => row.restore_run_id === run.id);
  }),
  operation('POST', '/restore-runs/:id/items/:item_id/decide', 'ops_decide_restore_reconciliation_item', 'Decide one unresolved discrepancy', (ctx, {body, params}) => {
    const store = tenantStore(ctx);
    const run = store.get('restore_run', params.id);
    const item = store.get('restore_reconciliation_item', params.item_id);
    if (run.status !== 'needs_decision' || item.restore_run_id !== run.id || item.decision !== 'pending') conflict('invalid_reconciliation_item', 'Item is not pending for this restore');
    const decision = choice(body.decision, 'decision', manualDecisions);
    if (decision === 'requeue' && item.requeue_allowed !== true) conflict('external_state_unverified', 'An eligible action must be confirmed absent before requeue');
    if (decision === 'adopt_external' && item.external_state !== 'present') conflict('external_state_unverified', 'External effect must be verified before adoption');
    return decide(ctx, item, decision, text(body.reason, 'reason'));
  }, { external: true }),
  operation('POST', '/restore-runs/:id/resume', 'ops_resume_restore_run', 'Exit safe mode only after complete reconciliation', (ctx, {params}) => {
    const store = tenantStore(ctx);
    const run = store.get('restore_run', params.id);
    if (run.status === 'resumed') return run;
    if (!run.reconciled_at || !['safe_mode', 'needs_decision'].includes(String(run.status)) || store.list('restore_reconciliation_item')
      .some(row => row.restore_run_id === run.id && row.decision === 'pending')) conflict('reconciliation_incomplete', 'Resolve and reconcile every restored action before resuming');
    return change(ctx, 'ops.safe_mode.exited', 'restore_run', store.update('restore_run', run.id, { status: 'resumed', pending_items: 0, resumed_at: ctx.now, resumed_by: ctx.actorId }));
  }),
];
