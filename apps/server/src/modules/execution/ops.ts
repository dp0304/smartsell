import { ADMIN, Problem, READ, WRITE, type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';
import { maintenanceConnection, postMaintenanceStatuses, type PostMaintenanceServices } from './post-maintenance.js';
import { assessTarget, closeTarget } from '../../../../../packages/domain/src/publishing/index.js';
import {
  ATTEMPT, FINAL, POST, SLOT, TASK, VERIFY_SCHEDULE_SECONDS, acceptsVerification, after, assignee, attachEvidence, attempts, authorized, availableWriteSlot,
  blockExecution, cancellationTracking, conflict, confirmCancellation, endAttempt, executionCheck, fence,
  find, holdWriteSlot, ids, invalid, late, latest, manualComplete, noPending, one, openAttempt, optional, pending, postDetails,
  registerManualPost, requestCancellation, requestVerification, savePost, settleConnector, settleVerification, status, step, targetOf, taskFor, text, time,
  transition, uncertain,
} from './service.js';

const HUMAN: typeof WRITE = WRITE.filter(role => role !== 'agent');
const resource = (ctx: Context, input: Input, kind = TASK) => ctx.get(kind, input.params.id);
function requireHuman(ctx: Context) {
  if (ctx.role === 'agent' || (ctx as Context & { agentCredentialId?: string }).agentCredentialId) {
    throw new Problem(403, 'PERMISSION_DENIED', 'Only a person can perform this action');
  }
}

export function retry(ctx: Context, task: Row) {
  noPending(ctx, task);
  const previous = latest(ctx, task);
  if (task.status !== 'retryable' || !previous || (previous.status !== 'verified_absent' && !(['rejected', 'abandoned'].includes(status(previous)) && previous.pre_submit_failure === true))) {
    throw conflict('NOT_RETRYABLE', 'The previous attempt does not have a safe retry disposition');
  }
  const check = executionCheck(ctx, task);
  if (check.reason) return blockExecution(ctx, task, check, { resume_status: 'retryable' });
  return late(ctx, task) ?? transition(ctx, task, 'queued', 'retry_requested', { next_retry_at: null });
}

export function runNow(ctx: Context, task: Row) {
  noPending(ctx, task);
  if (!['scheduled', 'queued', 'blocked'].includes(status(task)) || ['reschedule_requested', 'restore_reconcile', 'late_awaiting_decision'].includes(String(task.sub_status))) {
    throw conflict('INVALID_STATE', 'Resolve the task hold or scheduling decision first');
  }
  const check = executionCheck(ctx, task);
  if (check.reason) return blockExecution(ctx, task, check);
  return late(ctx, task) ?? routeNow(ctx, task, 'run_requested', time(task.due_at) > time(ctx.now) ? { run_requested_at: ctx.now, late_override_at: ctx.now } : {});
}

function routeNow(ctx: Context, task: Row, reason: string, patch: Data) {
  if (task.schedule_kind !== 'manual_date' && assessTarget(ctx, targetOf(ctx, task), 'execution').route !== 'manual') {
    return transition(ctx, task, 'queued', reason, { ...patch, next_retry_at: null });
  }
  return transition(ctx, task, 'manual', reason, { ...patch, route: [{ executor: 'manual', reason }], sub_status: 'awaiting_assignee' });
}

export function handover(ctx: Context, task: Row, body: Data) {
  noPending(ctx, task);
  if (FINAL.includes(status(task)) || task.restore_hold || ['late_awaiting_decision', 'reschedule_requested'].includes(String(task.sub_status))) {
    throw conflict('INVALID_STATE', 'Resolve the task hold or scheduling decision first');
  }
  one(body.to_executor ?? 'manual', ['manual'], 'to_executor');
  const reason = optional(body.reason) ?? 'operator_handover';
  const assignee_user_id = optional(body.assignee_user_id ?? body.assignee) ?? task.assignee_user_id ?? null;
  const active = find(ctx, ATTEMPT, task.active_attempt_id);
  const previous = active ?? latest(ctx, task);
  if (active) endAttempt(ctx, active, 'abandoned');
  const completed_steps = previous ? ctx.list('execution_attempt_step').filter(row => row.attempt_id === previous.id && row.status === 'succeeded').map(row => row.step) : [];
  const handover = ctx.create('execution_handover', { task_id: task.id, from_attempt_id: previous?.id ?? null, from_executor: previous?.executor ?? null,
    to_executor: 'manual', assignee_user_id, reason, completed_steps, pending_side_effects: [], status: 'completed', completed_at: ctx.now });
  const next = transition(ctx, task, 'manual', reason, { ...fence(task), assignee_user_id, route: [{ executor: 'manual', reason }], sub_status: 'awaiting_assignee' });
  ctx.emit('execution.handover.completed', { task_id: task.id, handover_id: handover.id });
  return { task: next, handover };
}

function manualStart(ctx: Context, task: Row) {
  if (task.status !== 'manual') throw conflict('INVALID_STATE', 'Route the task to manual execution first');
  noPending(ctx, task);
  assignee(ctx, task);
  if (!task.late_override_at && time(task.due_at) > time(ctx.now)) throw conflict('NOT_DUE', 'The task is not due');
  const check = executionCheck(ctx, task);
  if (check.reason) return { task: blockExecution(ctx, task, check) };
  const delayed = late(ctx, task);
  return delayed ? { task: delayed } : openAttempt(ctx, task, 'manual', ctx.actorId);
}

function manualBundle(ctx: Context, task: Row) {
  if (task.status !== 'manual') throw conflict('INVALID_STATE', 'The task is not on the manual route');
  assignee(ctx, task);
  const attempt = pending(ctx, task);
  if (attempt && (attempt.executor !== 'manual' || attempt.status !== 'in_progress' || attempt.id !== task.active_attempt_id || task.lease_owner_id !== ctx.actorId)) {
    throw conflict('OUTCOME_UNKNOWN', 'Resolve the original attempt before opening another bundle');
  }
  const reason = authorized(ctx, task);
  if (reason) throw conflict('PRECHECK_BLOCKED', `Execution is blocked: ${reason}`);
  return { task_id: task.id, publish_target_id: task.publish_target_id, social_account_id: task.social_account_id,
    frozen_hash: task.frozen_hash, snapshot_generation: task.snapshot_generation, frozen: task.frozen, due_at: task.due_at, attempt_id: attempt?.id ?? null,
    instructions: ['Start the manual attempt before publishing.', 'Confirm the signed-in account. Publish the approved payload once.', 'Record the permalink and upload evidence. If submission is uncertain, request reconciliation.'],
  };
}

function manualAbandon(ctx: Context, task: Row, body: Data) {
  if (!['manual', 'cancel_pending', 'outcome_unknown'].includes(status(task))) throw conflict('INVALID_STATE', 'The task is not awaiting manual resolution');
  assignee(ctx, task);
  const reason = text(body.reason, 'reason');
  const result = one(body.result ?? 'cancelled', ['cancelled', 'failed'], 'result');
  const attempt = pending(ctx, task);
  if (attempt) {
    if (attempt.executor !== 'manual' || body.confirmed_not_submitted !== true || !['in_progress', 'unknown'].includes(status(attempt))) {
      throw conflict('OUTCOME_UNKNOWN', 'Resolve the original external outcome first');
    }
    const evidence_ids = attachEvidence(ctx, body.evidence_file_ids, 'execution_attempt', attempt.id);
    step(ctx, attempt, 'verify', { evidence_ids, confirmed_not_submitted: true, reason });
    endAttempt(ctx, attempt, 'abandoned', { side_effect_possible: false, evidence_ids });
    settleVerification(ctx, attempt, 'manual_confirmed_not_submitted');
  }
  if (task.cancel_requested_at) return confirmCancellation(ctx, task, reason);
  if (result === 'cancelled') {
    const target = targetOf(ctx, task);
    ctx.update('publish_target', target.id, { plan_status: 'cancelled' });
    ctx.emit('planning.target.cancelled', { target_id: target.id, reason });
  } else {
    closeTarget(ctx, targetOf(ctx, task), 'failed_final');
  }
  return transition(ctx, task, result, reason, fence(task));
}

function lateDecision(ctx: Context, task: Row, body: Data) {
  if (task.sub_status !== 'late_awaiting_decision') throw conflict('INVALID_STATE', 'The task is not awaiting a late decision');
  const decision = one(body.decision, ['skip', 'run_now', 'reschedule'], 'decision');
  const reason = optional(body.reason) ?? decision;
  if (decision === 'run_now') {
    const blocked = authorized(ctx, task);
    if (blocked) throw conflict('PRECHECK_BLOCKED', `Execution is blocked: ${blocked}`);
  }
  ctx.emit('execution.task.late_decision_recorded', { task_id: task.id, decision, reason, decided_by: ctx.actorId });
  if (decision === 'skip') {
    closeTarget(ctx, targetOf(ctx, task), 'expired_skipped');
    return transition(ctx, task, 'expired', reason);
  }
  if (decision === 'reschedule') {
    ctx.emit('execution.target.reschedule_requested', { task_id: task.id, publish_target_id: task.publish_target_id, reason });
    return transition(ctx, task, 'blocked', reason, { sub_status: 'reschedule_requested' });
  }
  return routeNow(ctx, task, reason, { late_override_at: ctx.now, late_decision_by: ctx.actorId });
}

function reconcile(ctx: Context, task: Row, body: Data) {
  const attempt = pending(ctx, task);
  if (!attempt) throw conflict('INVALID_STATE', 'The task has no unresolved attempt');
  if (body.outcome === 'verified_absent') {
    if (!ADMIN.includes(ctx.role)) throw new Problem(403, 'FORBIDDEN', 'An administrator must confirm absence');
    requireHuman(ctx);
    if (!['unknown', 'accepted'].includes(status(attempt))) throw conflict('ATTEMPT_ACTIVE', 'Wait for the running attempt to finish');
    if (body.confirmed_no_pending_submission !== true || body.visibility_window_elapsed !== true) {
      throw invalid('Confirm no request can still publish and the visibility window has elapsed');
    }
    const evidence_ids = attachEvidence(ctx, body.evidence_file_ids, 'execution_attempt', attempt.id);
    step(ctx, attempt, 'verify', { outcome: 'verified_absent', evidence_ids, verified_by: ctx.actorId });
    endAttempt(ctx, attempt, 'verified_absent', { side_effect_possible: false, outcome_checked_at: ctx.now, evidence_ids, next_check_at: null });
    settleVerification(ctx, attempt, 'verified_absent');
    settleConnector(ctx, attempt, 'failed');
    const next = task.cancel_requested_at ? confirmCancellation(ctx, task, 'verified_absent')
      : transition(ctx, task, 'retryable', 'verified_absent', { ...fence(task), restore_hold: false, next_retry_at: null });
    return { task: next, version: next.version };
  }
  if (attempt.executor === 'manual' && attempt.status === 'in_progress' && body.outcome_unknown === true) {
    assignee(ctx, task);
    requireHuman(ctx);
    const next = uncertain(ctx, task, attempt, optional(body.reason) ?? 'manual_submission_uncertain');
    return { task: next, version: next.version, operation_id: requestVerification(ctx, next, attempt, 'manual_submission_uncertain').id };
  }
  return { task, version: task.version, operation_id: requestVerification(ctx, task, attempt, optional(body.reason) ?? 'requested').id };
}

export function cancelTask(ctx: Context, task: Row, verifyOnly = false) {
  const target = targetOf(ctx, task);
  const next = requestCancellation(ctx, target, verifyOnly);
  const plan_status = next?.status === 'cancel_pending' ? 'cancel_requested' : 'cancelled';
  if (target.plan_status !== plan_status) {
    ctx.update('publish_target', target.id, { plan_status });
    ctx.emit(`planning.target.${plan_status}`, { publish_target_id: target.id });
  }
  return next;
}

function actions(ctx: Context, task: Row) {
  if (!WRITE.includes(ctx.role) || FINAL.includes(status(task))) return [];
  const open = pending(ctx, task);
  const list = open ? ['reconcile'] : [];
  if ((task.status !== 'cancel_pending' || task.cancel_verify_only === true) && (!task.restore_hold || open)) list.push('cancel');
  if (task.status === 'retryable' && !open) list.push('retry');
  if (['scheduled', 'queued', 'blocked'].includes(status(task)) && !['reschedule_requested', 'restore_reconcile', 'late_awaiting_decision'].includes(String(task.sub_status))) list.push('run_now');
  if (HUMAN.includes(ctx.role) && !(ctx as Context & { agentCredentialId?: string }).agentCredentialId) {
    const assigned = !task.assignee_user_id || task.assignee_user_id === ctx.actorId || ADMIN.includes(ctx.role);
    if (task.sub_status === 'late_awaiting_decision') list.push('late_decision');
    if (!open && !task.restore_hold && !['late_awaiting_decision', 'reschedule_requested'].includes(String(task.sub_status))) list.push('handover');
    if (assigned && ['manual', 'accepted', 'cancel_pending', 'outcome_unknown'].includes(status(task)) &&
      (!open || open.executor === 'manual' || open.status !== 'in_progress')) list.push('manual_complete');
    if (assigned && task.status === 'manual' && (!open || (open.executor === 'manual' && open.status === 'in_progress' && task.lease_owner_id === ctx.actorId))) {
      list.push('manual_abandon', 'manual_bundle');
      if (!open) list.push('manual_start');
    }
  }
  return list;
}

function listTasks(ctx: Context, query: Input['query']) {
  return ctx.list(TASK).filter(row => ['status', 'sub_status', 'social_account_id', 'publish_target_id'].every(field => !query[field] || row[field] === query[field]) &&
    (['executor', 'connector_channel', 'connector_mode'].every(field => !query[field] ||
      (Array.isArray(row.route) && row.route.some(item => item[field] === query[field])))));
}

function detail(ctx: Context, task: Row) {
  const history = attempts(ctx, task);
  const attemptIds = new Set(history.map(row => row.id));
  return { ...task, attempts: history,
    steps: ctx.list('execution_attempt_step').filter(row => attemptIds.has(String(row.attempt_id))),
    evidence: ctx.list('evidence').filter(row => row.linked_resource_type === 'execution_attempt' && attemptIds.has(String(row.linked_resource_id))),
    handovers: ctx.list('execution_handover').filter(row => row.task_id === task.id),
    verifications: ctx.list('execution_verification').filter(row => row.task_id === task.id),
    platform_post: find(ctx, POST, task.platform_post_id) ?? null,
    pending_side_effects: history.filter(row => pending(ctx, task)?.id === row.id).map(row => row.id), allowed_actions: actions(ctx, task),
  };
}

function cancelExecution(ctx: Context, task: Row) {
  const next = cancelTask(ctx, task);
  return next && { ...next, ...cancellationTracking(ctx, next) };
}

const BATCH = { run_now: runNow, retry, cancel: cancelExecution, reconcile, handover };
type BatchAction = keyof typeof BATCH;
function batchPreview(ctx: Context, body: Data) {
  const action = one(body.action, Object.keys(BATCH) as BatchAction[], 'action');
  if (action === 'handover') requireHuman(ctx);
  const params = action === 'handover' ? { reason: text(body.reason, 'reason'), assignee_user_id: optional(body.assignee_user_id) ?? null } : {};
  const items = ids(body.task_ids, 'task_ids').map(id => {
    const task = ctx.get(TASK, id);
    return { task_id: task.id, version: task.version, status: task.status, allowed: actions(ctx, task).includes(action) };
  });
  return ctx.create('execution_batch', { action, params, items, status: 'previewed', actor_id: ctx.actorId, expires_at: after(ctx, 900) });
}
function batchApply(ctx: Context, batch: Row) {
  if (batch.actor_id !== ctx.actorId) throw new Problem(403, 'FORBIDDEN', 'Only the preview owner can apply this batch');
  const action = one(batch.action, Object.keys(BATCH) as BatchAction[], 'action');
  if (action === 'handover') requireHuman(ctx);
  if (batch.status === 'applied') return batch.operation_id ? batch : recordBatchOperation(ctx, batch, batch.results as Data[]);
  if (batch.status !== 'previewed' || time(batch.expires_at) <= time(ctx.now)) throw conflict('BATCH_EXPIRED', 'Preview this batch again');
  const tasks = (batch.items as { task_id: string; version: number; allowed: boolean }[]).map(item => {
    const task = ctx.get(TASK, item.task_id);
    if (task.version !== item.version) throw conflict('BATCH_STALE', 'A task changed after preview');
    if (!item.allowed || !actions(ctx, task).includes(action)) throw conflict('BATCH_BLOCKED', 'One or more tasks cannot perform this action');
    return task;
  });
  const results = tasks.map(task => {
    const result = BATCH[action](ctx, task, batch.params as Data);
    const next = ctx.get(TASK, task.id);
    return { task_id: next.id, task_version: next.version, status: next.status, status_reason: next.status_reason,
      ...(result && 'operation_id' in result && { verification_operation_id: result.operation_id }) };
  });
  const result = recordBatchOperation(ctx, batch, results);
  ctx.emit('execution.batch.applied', { batch_id: batch.id, action, task_ids: tasks.map(task => task.id), operation_id: result.operation_id });
  return result;
}

function recordBatchOperation(ctx: Context, batch: Row, results: Data[]) {
  const operation = ctx.create('operation', { kind: 'publishing.apply_execution_batch', resource_id: batch.id,
    status: 'succeeded', total: results.length });
  results.forEach((result, item_no) => ctx.create('operation_item', {
    ...result, task_status: result.status, status: 'succeeded', operation_id: operation.id, item_no,
  }));
  return ctx.update('execution_batch', batch.id, { status: 'applied', results, operation_id: operation.id, applied_at: batch.applied_at ?? ctx.now });
}

function action(name: string, summary: string, handler: (ctx: Context, task: Row, body: Data) => unknown, human = false): Operation {
  return { path: `/execution-tasks/:id/${name.replaceAll('_', '-')}`, method: 'POST', name: `publishing_${name}`, summary, roles: human ? HUMAN : WRITE,
    run(ctx, input) {
      const task = resource(ctx, input);
      const version = input.expectedVersion ?? input.body.expected_version;
      if (version !== undefined && task.version !== version) throw conflict('VERSION_CONFLICT', 'The task changed');
      return handler(ctx, task, input.body);
    },
  };
}

const POST_ACTIONS = ['edit_caption', 'delete', 'hide', 'unschedule'] as const;
function postOperation(ctx: Context, post: Row, body: Data) {
  const kind = one(body.kind, POST_ACTIONS, 'kind');
  const requestedExecutor = one(body.executor ?? 'manual', ['manual', 'api'], 'executor');
  const reason = text(body.reason, 'reason');
  if (post.post_status === 'deleted') throw conflict('INVALID_STATE', 'The post is already deleted');
  if (kind === 'unschedule' && post.post_status !== 'scheduled') throw conflict('INVALID_STATE', 'Only a scheduled post can be unscheduled');
  if (ctx.list('post_operation').some(row => row.platform_post_id === post.id && postMaintenanceStatuses.includes(String(row.status)))) throw conflict('OPERATION_PENDING', 'Resolve the existing post operation first');
  const caption = (body.after_payload as Data | undefined)?.caption;
  if (kind === 'edit_caption' && (typeof caption !== 'string' || caption.length > 4096)) throw invalid('Provide a caption');
  if (body.expected_version !== undefined && body.expected_version !== post.version) throw conflict('VERSION_CONFLICT', 'The post changed');
  const services = (ctx as Context & { postMaintenanceServices?: PostMaintenanceServices }).postMaintenanceServices;
  if (requestedExecutor === 'api' && !maintenanceConnection(ctx, post, kind, services)) {
    throw conflict('CAPABILITY_UNAVAILABLE', 'The official post operation is unavailable for this account');
  }
  const slot = availableWriteSlot(ctx, post.social_account_id);
  const write_slot_fencing_token = Number(slot?.fencing_token ?? 0) + 1;
  const lease_expires_at = after(ctx, 1800);
  const record = ctx.create('post_operation', { platform_post_id: post.id, kind, executor: requestedExecutor, status: requestedExecutor === 'api' ? 'queued' : 'manual', reason,
    before_snapshot: structuredClone(post), after_payload: kind === 'edit_caption' ? { caption } : null, requested_by: ctx.actorId,
    write_slot_fencing_token, lease_expires_at, action_url: post.permalink ?? null });
  holdWriteSlot(ctx, slot, post.social_account_id, 'post_operation', record.id, write_slot_fencing_token, lease_expires_at);
  ctx.emit(requestedExecutor === 'api' ? 'execution.post_operation.queued' : 'execution.post_operation.manual_required', { post_operation_id: record.id, platform_post_id: post.id });
  return record;
}
function completePostOperation(ctx: Context, row: Row, body: Data) {
  if (row.status !== 'manual') throw conflict('INVALID_STATE', 'The operation is not awaiting a manual result');
  const post = ctx.get(POST, String(row.platform_post_id));
  if (row.requested_by !== ctx.actorId && !ADMIN.includes(ctx.role)) throw new Problem(403, 'FORBIDDEN', 'Only the requesting operator or an administrator can confirm this operation');
  const outcome = one(body.outcome, ['completed', 'failed'], 'outcome');
  const before = row.before_snapshot as Row;
  if (outcome === 'completed' && (post.post_status !== before.post_status || post.caption_snapshot !== before.caption_snapshot)) {
    throw conflict('VERSION_CONFLICT', 'The published caption or status changed while the operation was pending');
  }
  const actionResult = row.kind === 'edit_caption' ? (row.after_payload as Data).caption : undefined;
  if (outcome === 'completed' && row.kind === 'edit_caption' && body.observed_caption !== actionResult) {
    throw invalid('Confirm the caption read back from the platform matches the requested caption');
  }
  const evidence_ids = attachEvidence(ctx, body.evidence_file_ids, 'post_operation', row.id);
  if (outcome === 'completed') {
    const patch = row.kind === 'edit_caption' ? { caption_snapshot: (row.after_payload as Data).caption }
      : { post_status: row.kind === 'delete' ? 'deleted' : row.kind === 'hide' ? 'hidden' : 'cancelled' };
    ctx.update(POST, post.id, patch);
    if (patch.post_status) ctx.emit('execution.platform_post.status_changed', { platform_post_id: post.id, post_status: patch.post_status });
  }
  const slot = ctx.list(SLOT).find(value => value.holder_kind === 'post_operation' && value.holder_id === row.id && value.fencing_token === row.write_slot_fencing_token);
  if (slot) ctx.update(SLOT, slot.id, { holder_kind: null, holder_id: null, lease_expires_at: null });
  const next = ctx.update('post_operation', row.id, {
    status: outcome === 'completed' ? 'verified' : 'failed', verification: 'manual_confirmed', evidence_ids,
    completed_at: ctx.now, completed_by: ctx.actorId, ...(body.observed_caption === actionResult && typeof actionResult === 'string' ? { observed_caption: actionResult } : {}),
    ...(outcome === 'completed' ? { after_snapshot: structuredClone(ctx.get(POST, post.id)) } : {}),
  });
  ctx.emit('execution.post_operation.completed', { post_operation_id: row.id, platform_post_id: post.id, outcome });
  return next;
}

function setting(ctx: Context, input: Input) {
  const scope_type = one(input.params.scope_type, ['workspace', 'brand', 'social_account'], 'scope_type');
  const scope_id = text(input.params.scope_id, 'scope_id');
  if (scope_type === 'workspace' && scope_id !== ctx.workspaceId) throw new Problem(404, 'NOT_FOUND', 'Workspace setting is unavailable');
  if (scope_type !== 'workspace') ctx.get(scope_type, scope_id);
  const row = ctx.list('execution_setting').find(value => value.scope_type === scope_type && value.scope_id === scope_id);
  const defaults = { late_policy: 'notify', grace_minutes: 30, max_auto_retries: 3, unknown_to_manual_after_minutes: 360, verify_schedule_seconds: VERIFY_SCHEDULE_SECONDS };
  return { scope_type, scope_id, row, defaults };
}

const executionOperations: Operation[] = [
  { path: '/execution-tasks', method: 'GET', name: 'publishing_list_execution', roles: READ, summary: 'List execution tasks', run: (ctx, input) => listTasks(ctx, input.query) },
  { path: '/execution-tasks/:id', method: 'GET', name: 'publishing_get_execution', roles: READ, summary: 'Read an execution timeline', run(ctx, input) {
    const task = input.params.id ? resource(ctx, input) : input.query.target_id ? taskFor(ctx, ctx.get('publish_target', input.query.target_id)) : undefined;
    if (!task) throw new Problem(404, 'NOT_FOUND', 'Execution task not found');
    return detail(ctx, task);
  } },
  { path: '/execution-exceptions', method: 'GET', name: 'publishing_list_exceptions', roles: READ, summary: 'List execution exceptions', run: (ctx, input) => listTasks(ctx, input.query).filter(row => ['blocked', 'outcome_unknown', 'manual', 'failed', 'cancel_pending'].includes(status(row))) },
  { path: '/execution-tasks/:id/manual-bundle', method: 'GET', name: 'publishing_get_manual_bundle', roles: HUMAN, summary: 'Read the approved manual bundle', run: (ctx, input) => manualBundle(ctx, resource(ctx, input)) },
  action('run_now', 'Run prechecks and dispatch the available execution path', runNow),
  action('retry', 'Queue a verified-safe retry', retry),
  { ...action('reconcile', 'Request verification of an unresolved outcome', reconcile), accepted: acceptsVerification },
  { ...action('cancel', 'Cancel before submission or request confirmation', cancelExecution), accepted: acceptsVerification },
  action('late_decision', 'Decide how to handle an overdue task', lateDecision, true),
  action('handover', 'Fence and hand a safe task to a human', handover, true), action('manual_start', 'Start a manual attempt', manualStart, true),
  action('manual_complete', 'Record a manual result with evidence', manualComplete, true), action('manual_abandon', 'Record a manual abandonment', manualAbandon, true),
  { path: '/platform-posts', method: 'GET', name: 'posts_list', roles: READ, summary: 'List platform posts', run: (ctx, input) => ctx.list(POST).filter(row => ['social_account_id', 'origin', 'verification'].every(field => !input.query[field] || row[field] === input.query[field])) },
  { path: '/platform-posts/:id', method: 'GET', name: 'posts_get', roles: READ, summary: 'Read a platform post and its maintenance audit', run(ctx, input) {
    const post = resource(ctx, input, POST);
    const task = find(ctx, TASK, post.execution_task_id);
    const services = (ctx as Context & { postMaintenanceServices?: PostMaintenanceServices }).postMaintenanceServices;
    return { ...post, official_operations: POST_ACTIONS.filter(kind => maintenanceConnection(ctx, post, kind, services)), post_operations: ctx.list('post_operation').filter(row => row.platform_post_id === post.id),
      post_watch: ctx.list('post_watch').find(row => row.platform_post_id === post.id) ?? null,
      publication: task ? detail(ctx, task) : null,
      metrics_history_path: `/performance/posts/${encodeURIComponent(post.id)}/history` };
  } },
  { path: '/platform-posts/:id/watch', method: 'PUT', name: 'posts_set_watch', roles: HUMAN, summary: 'Track a publication in platform observations', run(ctx, input) {
    const post = resource(ctx, input, POST);
    if (!post.external_post_id || post.verification !== 'system_verified' || ['deleted', 'removed_by_platform'].includes(String(post.post_status))) {
      throw conflict('POST_NOT_WATCHABLE', 'Watch requires a current, system-verified platform post');
    }
    const until = time(input.body.watch_until);
    if (!(until > time(ctx.now) && until <= time(ctx.now) + 90 * 86_400_000)) throw invalid('watch_until must be within the next 90 days');
    const previous = ctx.list('post_watch').find(row => row.platform_post_id === post.id);
    const patch = { platform_post_id: post.id, watch_until: new Date(until).toISOString(), last_status: post.post_status, status: 'active', completed_at: null };
    return previous ? ctx.update('post_watch', previous.id, patch) : ctx.create('post_watch', patch);
  } },
  { path: '/platform-posts/register', method: 'POST', name: 'posts_register_manual', roles: HUMAN, summary: 'Register a post and its evidence', run(ctx, { body }) {
    const targetId = body.publish_target_id ?? body.target_id;
    if (targetId) return registerManualPost(ctx, ctx.get('publish_target', text(targetId, 'publish_target_id')), body);
    const account = ctx.get('social_account', text(body.social_account_id, 'social_account_id'));
    const post = savePost(ctx, account, { ...postDetails(ctx, body), origin: 'manual_registered', verification: 'manual_confirmed', submitted_by: 'manual', post_status: 'live' });
    const evidence_ids = attachEvidence(ctx, body.evidence_file_ids, POST, post.id);
    return ctx.update(POST, post.id, { evidence_ids: [...new Set([...(Array.isArray(post.evidence_ids) ? post.evidence_ids : []), ...evidence_ids])] });
  } },
  { path: '/platform-posts/:id/operations', method: 'POST', name: 'posts_request_operation', roles: HUMAN, summary: 'Request a platform post operation', run: (ctx, input) => postOperation(ctx, resource(ctx, input, POST), {
    ...input.body, expected_version: input.expectedVersion ?? input.body.expected_version,
  }) },
  { path: '/post-operations/:id/manual-complete', method: 'POST', name: 'posts_complete_operation', roles: HUMAN, summary: 'Record a manual post operation result', run: (ctx, input) => completePostOperation(ctx, resource(ctx, input, 'post_operation'), input.body) },
  { path: '/execution-batches/preview', method: 'POST', name: 'publishing_preview_execution_batch', roles: WRITE, summary: 'Preview the effect of an execution batch', run: (ctx, input) => batchPreview(ctx, input.body) },
  { path: '/execution-batches/:id/apply', method: 'POST', name: 'publishing_apply_execution_batch', roles: WRITE, accepted: true, summary: 'Apply a current batch preview', run: (ctx, input) => batchApply(ctx, resource(ctx, input, 'execution_batch')) },
  { path: '/execution-settings/:scope_type/:scope_id', method: 'GET', name: 'publishing_get_execution_settings', roles: ADMIN, summary: 'Read execution settings', run(ctx, input) {
    const { row, defaults, ...scope } = setting(ctx, input);
    return row ?? { ...scope, ...defaults };
  } },
  { path: '/execution-settings/:scope_type/:scope_id', method: 'PUT', name: 'publishing_set_execution_settings', roles: ADMIN, summary: 'Set execution settings', run(ctx, input) {
    const { row, defaults, ...scope } = setting(ctx, input);
    const policy = one(input.body.late_policy ?? row?.late_policy ?? defaults.late_policy, ['skip', 'notify', 'grace_window'], 'late_policy');
    const patch: Data = { ...scope, late_policy: policy };
    for (const field of ['grace_minutes', 'max_auto_retries', 'unknown_to_manual_after_minutes'] as const) {
      const value = input.body[field] ?? row?.[field] ?? defaults[field];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > (field === 'max_auto_retries' ? 10 : 10080)) throw invalid(`Invalid ${field}`);
      patch[field] = value;
    }
    const schedule = input.body.verify_schedule_seconds ?? row?.verify_schedule_seconds ?? defaults.verify_schedule_seconds;
    if (!Array.isArray(schedule) || !schedule.length || schedule.length > 20 ||
      schedule.some((delay, index) => !Number.isSafeInteger(delay) || delay < 1 || delay > 86_400 || (index > 0 && delay <= schedule[index - 1]))) {
      throw invalid('Provide 1–20 increasing verification delays between 1 and 86400 seconds');
    }
    patch.verify_schedule_seconds = schedule;
    return row ? ctx.update('execution_setting', row.id, patch) : ctx.create('execution_setting', patch);
  } },
];

export const operations: Operation[] = executionOperations.map(operation => {
  if (operation.roles !== HUMAN && operation.roles !== ADMIN) return operation;
  return {
    ...operation, mcp: false,
    run(ctx, input) {
      requireHuman(ctx);
      return operation.run(ctx, input);
    },
  };
});
