import { admins, DomainError, readers, text, writers } from '../types.ts';
import type { Command, Commands, Context, Entity, Fields } from '../types.ts';
import { checkExecution } from '../planning/index.ts';
import {
  activeAttempt, add, assertFence, ATTEMPT, authorizeAssigned, conflict, finish, get, guard, int,
  need, patch, pending, prepare, recordBlock, recordPost, rows, scoped, stableId, targetFor,
  taskFor, taskId, TASK, terminal, transition, url,
} from './state.ts';

function command(roles: Command['roles'], run: Command['run']): Command {
  return { roles, async run(ctx, input) {
    if (!roles.includes(ctx.role)) throw new DomainError('forbidden', 'Insufficient execution permissions', 403);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError('invalid_input', 'Expected an object');
    return run(ctx, input);
  } };
}

async function enqueue(ctx: Context, input: Fields) {
  const targetId = text(input, 'target_id', 128);
  const id = taskId(targetId);
  const existing = await get(ctx, TASK, id);
  if (existing) return existing;
  const settings = await guard(ctx);
  await patch(ctx, settings, { checked_at: ctx.now });
  const target = await targetFor(ctx, targetId);
  const existingAfterClaim = await get(ctx, TASK, id);
  if (existingAfterClaim) return existingAfterClaim;
  if (target.data.status !== 'scheduled' || !target.data.frozen || !target.data.frozen_hash) {
    conflict('not_scheduled', 'Only approved and scheduled targets can be enqueued');
  }
  const { blockers } = await checkExecution(ctx, target);
  const invalidApproval = blockers.find(item => ['frozen_hash_invalid', 'approval_invalid', 'frozen_payload_changed'].includes(item.code));
  if (invalidApproval) conflict(invalidApproval.code, invalidApproval.message);
  const frozen = target.data.frozen;
  if (frozen.route !== 'manual' && (frozen.route !== 'official' || !frozen.adapter_key || !frozen.account_identity)) {
    conflict('route_unavailable', 'Use the manual route or explicitly configure an official adapter and account identity');
  }
  const latePolicy = input.late_policy ?? 'grace_window';
  if (!['grace_window', 'notify', 'skip'].includes(latePolicy)) throw new DomainError('invalid_input', 'Invalid late_policy');
  const task = await add(ctx, TASK, {
    target_id: target.id, due_at: target.data.scheduled_at, frozen_hash: target.data.frozen_hash,
    route: frozen.route, account_id: frozen.account_id, platform: frozen.platform,
    account_identity: frozen.account_identity ?? frozen.account_id, adapter_key: frozen.adapter_key ?? null,
    status: 'scheduled', attempt_count: 0, active_attempt_id: null, late_policy: latePolicy,
    grace_seconds: int(input, 'grace_seconds', 0, 86_400, latePolicy === 'skip' ? 0 : 3600),
    assignee_id: target.data.owner_id ?? ctx.actorId,
    restore_review: settings.data.restore_hold && (await rows(ctx, 'recovery_check')).some(row => row.data.target_id === target.id && row.data.status === 'pending'),
  }, id);
  await ctx.emit('execution.task.scheduled', { task_id: id, target_id: target.id });
  return task;
}

async function manualAttempt(ctx: Context, input: Fields) {
  const task = await taskFor(ctx, input);
  authorizeAssigned(ctx, task);
  const attempt = await need(ctx, ATTEMPT, text(input, 'attempt_id', 128));
  const slot = await assertFence(ctx, attempt, task, int(input, 'fencing_token', 1, Number.MAX_SAFE_INTEGER));
  if (!pending.has(attempt.data.status) || attempt.data.status === 'dispatched') {
    conflict('not_pending', 'Wait for the dispatch result or recover the expired lease before manual reconciliation');
  }
  return { task, attempt, slot };
}

async function reconcileManual(ctx: Context, input: Fields) {
  const { task, attempt, slot } = await manualAttempt(ctx, input);
  const outcome = input.outcome;
  if (outcome !== 'published' && outcome !== 'verified_absent') throw new DomainError('invalid_input', 'Invalid outcome');
  const evidence = text(input, 'evidence');
  if (outcome === 'published') {
    const permalink = url(input, 'permalink');
    const post = await recordPost(ctx, task, attempt, {
      external_post_id: input.external_post_id === undefined ? permalink : text(input, 'external_post_id', 256),
      permalink, evidence, verification: 'manual_confirmed',
    });
    const resolved = await finish(ctx, task, attempt, slot, {
      attemptStatus: 'verified_published', taskStatus: 'published', quota: 'consumed', evidence,
      extra: { post_id: post.id, restore_review: false },
    });
    return { task: resolved, post };
  }
  if (!admins.includes(ctx.role)) throw new DomainError('forbidden', 'An admin must confirm absence', 403);
  if (input.confirm_no_pending_submission !== true) throw new DomainError('invalid_input', 'Confirm that no submission can still publish');
  // An uncertain official submission may have used platform quota even if no work became visible.
  return { task: await finish(ctx, task, attempt, slot, {
    attemptStatus: 'verified_absent', taskStatus: 'retryable', quota: 'consumed', evidence, extra: { restore_review: false },
  }) };
}

async function cancel(ctx: Context, input: Fields) {
  const task = await taskFor(ctx, input);
  authorizeAssigned(ctx, task);
  if (terminal.has(task.data.status)) return task;
  const attempt = await activeAttempt(ctx, task);
  const reason = text(input, 'reason');
  const extra = { cancel_requested_at: ctx.now, cancel_reason: reason };
  if (task.data.restore_review || (attempt && pending.has(attempt.data.status))) {
    return transition(ctx, task, 'cancel_pending', extra);
  }
  if (!attempt) return transition(ctx, task, 'cancelled', extra);
  const slot = await assertFence(ctx, attempt, task, attempt.data.fencing_token);
  return finish(ctx, task, attempt, slot, {
    attemptStatus: 'abandoned', taskStatus: 'cancelled', quota: 'released', evidence: reason, extra,
  });
}

async function recover(ctx: Context, input: Fields) {
  const task = await taskFor(ctx, input);
  const attempt = await activeAttempt(ctx, task);
  if (!attempt || !['prepared', 'dispatched', 'manual_in_progress', 'accepted'].includes(attempt.data.status)) return { task, attempt };
  if (Date.parse(ctx.now) < Date.parse(attempt.data.lease_until)) conflict('lease_active', 'Attempt lease is still active');
  const slot = await assertFence(ctx, attempt, task, attempt.data.fencing_token);
  if (attempt.data.status === 'prepared' && !task.data.restore_review) {
    return { task: await finish(ctx, task, attempt, slot, {
      attemptStatus: 'abandoned', taskStatus: 'retryable', quota: 'released', evidence: 'Preparation lease expired before dispatch',
    }) };
  }
  const unknown = await patch(ctx, attempt, { status: 'outcome_unknown', reason: 'lease_expired' });
  await ctx.emit('execution.attempt.outcome_unknown', { task_id: task.id, attempt_id: attempt.id, reason: 'lease_expired' });
  return { task: await transition(ctx, task, task.data.cancel_requested_at ? 'cancel_pending' : 'outcome_unknown', { reason: 'lease_expired' }), attempt: unknown };
}

async function restoreHold(ctx: Context, input: Fields) {
  const reason = text(input, 'reason');
  let state = await guard(ctx);
  if (state.data.restore_hold) return state;
  state = await patch(ctx, state, { restore_hold: true, restore_reason: reason, started_at: ctx.now });
  for (const target of (await ctx.list('planning', 'publish_target')).filter(row => scoped(ctx, row))) {
    if (target.data.status !== 'scheduled' || Date.parse(target.data.scheduled_at) > Date.parse(ctx.now)) continue;
    // Restore can predate both the dispatch marker and the task. Track all due scheduled targets.
    const id = stableId('recovery_check', state.id, state.version, target.id);
    const task = await get(ctx, TASK, taskId(target.id));
    if (task && terminal.has(task.data.status)) continue;
    await add(ctx, 'recovery_check', { target_id: target.id, task_id: task?.id ?? null, status: 'pending' }, id);
    if (task) await patch(ctx, task, { restore_review: true });
  }
  await ctx.emit('execution.restore.hold_started', { reason });
  return state;
}

async function recordRecovery(ctx: Context, input: Fields) {
  const check = await need(ctx, 'recovery_check', text(input, 'check_id', 128));
  if (check.data.status !== 'pending') return check;
  const evidence = text(input, 'evidence');
  const task = await get(ctx, TASK, taskId(check.data.target_id));
  if (task && await activeAttempt(ctx, task)) conflict('verification_required', 'Reconcile the active attempt before clearing the restore check');
  const proof = input.outcome;
  if (proof !== 'verified_absent' && proof !== 'already_published') throw new DomainError('invalid_input', 'Invalid recovery outcome');
  if (proof === 'verified_absent' && input.confirm_no_pending_submission !== true) {
    throw new DomainError('invalid_input', 'Confirm that no submission can still publish');
  }
  if (task?.data.status === 'published' && proof !== 'already_published') conflict('outcome_conflict', 'Task already has a verified post');
  if (proof === 'already_published' && task?.data.status !== 'published') {
    const target = await targetFor(ctx, check.data.target_id);
    const permalink = url(input, 'permalink');
    const postId = input.external_post_id === undefined ? permalink : text(input, 'external_post_id', 256);
    const frozen = target.data.frozen;
    if (!frozen) conflict('frozen_target_changed', 'Recovered target has no frozen payload');
    const id = stableId('platform_post', frozen.platform, frozen.account_identity ?? frozen.account_id, postId);
    const post = await get(ctx, 'platform_post', id);
    if (post && post.data.target_id !== target.id) conflict('post_already_linked', 'Platform post already belongs to another target');
    const tracked = task ?? await enqueue(ctx, { target_id: target.id });
    if (!post) await add(ctx, 'platform_post', {
      external_post_id: postId, permalink, verification: 'manual_confirmed', evidence, task_id: tracked.id,
      target_id: target.id, account_id: frozen.account_id, platform: frozen.platform, origin: 'recovered', observed_at: ctx.now,
    }, id);
    await transition(ctx, tracked, 'published', { post_id: id, restore_review: false });
  } else if (task?.data.status === 'cancel_pending') {
    await transition(ctx, task, 'cancelled', { restore_review: false });
  } else if (task) {
    await patch(ctx, task, { restore_review: false });
  }
  const result = await patch(ctx, check, { status: 'resolved', outcome: proof, evidence, resolved_by: ctx.actorId, resolved_at: ctx.now });
  await ctx.emit('execution.restore.check_resolved', { check_id: check.id, target_id: check.data.target_id, outcome: proof });
  return result;
}

export const commands: Commands = {
  enqueue: command(writers, enqueue),
  get_task: command(readers, async (ctx, input) => {
    const task = await taskFor(ctx, input);
    const [attempts, verifications, handovers, target] = await Promise.all([
      rows(ctx, ATTEMPT), rows(ctx, 'verify_attempt'), rows(ctx, 'execution_handover'), targetFor(ctx, task.data.target_id),
    ]);
    const forTask = (row: Entity) => row.data.task_id === task.id;
    return {
      task, target, attempts: attempts.filter(forTask), verifications: verifications.filter(forTask),
      handovers: handovers.filter(forTask), post: task.data.post_id ? await need(ctx, 'platform_post', task.data.post_id) : null,
    };
  }),
  list_tasks: command(readers, async (ctx, input) => {
    const status = input.status === undefined ? null : text(input, 'status', 48);
    const targetId = input.target_id === undefined ? null : text(input, 'target_id', 128);
    const limit = int(input, 'limit', 1, 200, 100);
    const offset = int(input, 'offset', 0, Number.MAX_SAFE_INTEGER, 0);
    const tasks = (await rows(ctx, TASK)).filter(task =>
      (!status || task.data.status === status) && (!targetId || task.data.target_id === targetId),
    ).sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id));
    return { tasks: tasks.slice(offset, offset + limit), has_more: tasks.length > offset + limit };
  }),
  preflight: command(writers, async (ctx, input) => checkExecution(ctx, await targetFor(ctx, text(input, 'target_id', 128)))),
  due_scan: command(admins, async (ctx, input) => {
    const limit = int(input, 'limit', 1, 200, 100);
    if ((await get(ctx, 'execution_guard', stableId('execution_guard', ctx.workspaceId)))?.data.restore_hold) {
      return { tasks: [], has_more: false, reason: 'restore_hold' };
    }
    const existing = new Set((await rows(ctx, TASK)).map(row => row.data.target_id));
    const ready = (await ctx.list('planning', 'publish_target')).filter(row => scoped(ctx, row) &&
      row.data.status === 'scheduled' && !existing.has(row.id) && Date.parse(row.data.scheduled_at) <= Date.parse(ctx.now));
    for (const row of ready.slice(0, limit)) await enqueue(ctx, { target_id: row.id });
    const due = (await rows(ctx, TASK)).filter(row =>
      !terminal.has(row.data.status) && !row.data.active_attempt_id && !row.data.restore_review &&
      Date.parse(row.data.due_at) <= Date.parse(ctx.now) &&
      (!row.data.retry_at || Date.parse(row.data.retry_at) <= Date.parse(ctx.now)),
    ).sort((a, b) => a.data.due_at.localeCompare(b.data.due_at) || a.id.localeCompare(b.id));
    return { tasks: due.slice(0, limit), has_more: due.length > limit };
  }),
  prepare_official: command(admins, async (ctx, input) => prepare(ctx, await taskFor(ctx, input), 'official')),
  begin_manual: command(writers, async (ctx, input) => {
    const task = await taskFor(ctx, input);
    authorizeAssigned(ctx, task);
    return prepare(ctx, task, 'manual');
  }),
  reconcile_manual: command(writers, reconcileManual),
  report_manual_unknown: command(writers, async (ctx, input) => {
    const { task, attempt } = await manualAttempt(ctx, input);
    if (attempt.data.route !== 'manual') conflict('wrong_route', 'Use official verification for official attempts');
    if (attempt.data.status === 'outcome_unknown') return { task, attempt };
    const evidence = text(input, 'evidence');
    const unknown = await patch(ctx, attempt, { status: 'outcome_unknown', evidence, reported_by: ctx.actorId });
    await ctx.emit('execution.attempt.outcome_unknown', { attempt_id: attempt.id, task_id: task.id, reason: 'manual_outcome_unknown' });
    return { attempt: unknown, task: await transition(ctx, task, task.data.cancel_requested_at ? 'cancel_pending' : 'outcome_unknown', { reason: 'manual_outcome_unknown' }) };
  }),
  cancel: command(writers, cancel),
  recover_lease: command(admins, recover),
  allow_late: command(admins, async (ctx, input) => {
    const task = await taskFor(ctx, input);
    if (task.data.reason !== 'late_awaiting_decision' || task.data.status !== 'blocked') conflict('invalid_state', 'Task is not waiting for a late decision');
    const reason = text(input, 'reason');
    const seconds = int(input, 'extension_seconds', 1, 3600);
    const result = await transition(ctx, task, 'scheduled', { late_override_until: new Date(Date.parse(ctx.now) + seconds * 1000).toISOString(), reason: null });
    await ctx.emit('execution.task.late_allowed', { task_id: task.id, reason, actor_id: ctx.actorId });
    return result;
  }),
  handover_manual: command(admins, async (ctx, input) => {
    const task = await taskFor(ctx, input);
    const reason = text(input, 'reason');
    if (terminal.has(task.data.status) || task.data.restore_review || task.data.cancel_requested_at) conflict('invalid_state', 'Task cannot be handed over');
    const attempt = await activeAttempt(ctx, task);
    if (attempt && pending.has(attempt.data.status)) conflict('verification_required', 'Pending side effects must be reconciled before changing route');
    const assignee = text(input, 'assignee_id', 128);
    const change = { route: 'manual', assignee_id: assignee, retry_at: null, reason: null };
    const handover = await add(ctx, 'execution_handover', { task_id: task.id, from_route: task.data.route, to_route: 'manual', reason, assignee_id: assignee, actor_id: ctx.actorId });
    await ctx.emit('execution.handover.completed', { handover_id: handover.id, task_id: task.id });
    if (!attempt) return transition(ctx, task, 'scheduled', change);
    const slot = await assertFence(ctx, attempt, task, attempt.data.fencing_token);
    return finish(ctx, task, attempt, slot, { attemptStatus: 'abandoned', taskStatus: 'scheduled', quota: 'released', evidence: reason, extra: change });
  }),
  start_restore_hold: command(admins, restoreHold),
  list_recovery: command(admins, async (ctx, input) => {
    const status = input.status ?? 'pending';
    if (!['pending', 'resolved', 'all'].includes(status)) throw new DomainError('invalid_input', 'Invalid recovery status');
    return (await rows(ctx, 'recovery_check')).filter(row => status === 'all' || row.data.status === status);
  }),
  record_recovery: command(admins, recordRecovery),
  release_restore_hold: command(admins, async (ctx, input) => {
    const reason = text(input, 'reason');
    const state = await guard(ctx);
    if (!state.data.restore_hold) return state;
    if ((await rows(ctx, 'recovery_check')).some(row => row.data.status === 'pending')) conflict('restore_pending', 'Resolve every recovery check first');
    const result = await patch(ctx, state, { restore_hold: false, released_at: ctx.now, release_reason: reason });
    await ctx.emit('execution.restore.hold_released', { reason });
    return result;
  }),
};

export const executionCommands = commands;
export { createOfficialWorker } from './official.ts';
export { bindOfficialPlatform } from './platform-adapter.ts';

export { operations } from './ops.js';
export { ensureTask, registerManualPost, requestCancellation, upsertObservedPost } from './service.js';
export { authorizeConnectorAttempt, type ConnectorDispatch } from './connector.js';
export { createExecutionWorker, scanWorkspaceExecution as scanExecution, holdRestoredExecution, releaseExecutionHold } from './worker.js';
