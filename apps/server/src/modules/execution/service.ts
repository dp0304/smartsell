import { ADMIN, Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { PUBLISH_ASSIST_WAIT_SECONDS, PUBLISH_RESULT_REPORT_SECONDS } from '../../../../../packages/connector-tasks/src/index.js';
import { attachMediaEvidence } from '../../extensions/media-files.js';
import { reconcileConnectorTask } from '../account/connector-service.js';
import { approvalValid, assessTarget, closeTarget, digest, invalidateTargets } from '../../../../../packages/domain/src/publishing/index.js';

export const TASK = 'execution_task', ATTEMPT = 'execution_attempt', POST = 'platform_post', SLOT = 'account_write_slot';
export const FINAL = ['published', 'cancelled', 'expired', 'failed'];
export const VERIFY_SCHEDULE_SECONDS = [30, 120, 300, 900, 3600, 21600];
export function verificationDelay(task: Row, index = 0) {
  const schedule = Array.isArray(task.verify_schedule_seconds) && task.verify_schedule_seconds.length ? task.verify_schedule_seconds : VERIFY_SCHEDULE_SECONDS;
  return Number(schedule[Math.min(index, schedule.length - 1)]);
}
const REFROZEN = ['scheduled', 'queued', 'blocked'];
export const status = (row: Row) => String(row.status);
export const time = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
export const after = (ctx: Context, seconds: number) => new Date(time(ctx.now) + seconds * 1000).toISOString();
export const conflict = (code: string, message: string) => new Problem(409, code, message);
export const invalid = (message: string) => new Problem(422, 'INVALID_INPUT', message);
export const optional = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= 4096 ? value.trim() : undefined;
export function text(value: unknown, field: string) {
  const parsed = optional(value);
  if (!parsed) throw invalid(`Invalid ${field}`);
  return parsed;
}
export function one<T extends string>(value: unknown, values: readonly T[], field: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw invalid(`Invalid ${field}`);
  return value as T;
}
export function ids(value: unknown, field: string, max = 50) {
  if (!Array.isArray(value) || !value.length || value.length > max) throw invalid(`Provide 1–${max} ${field}`);
  return [...new Set(value.map(entry => text(entry, field)))];
}
export const find = (ctx: Context, kind: string, id: unknown) => ctx.list(kind).find(row => row.id === id);
export const targetOf = (ctx: Context, task: Row) => ctx.get('publish_target', String(task.publish_target_id));
export const taskFor = (ctx: Context, target: Row) => ctx.list(TASK).find(row => row.publish_target_id === target.id);
export const attempts = (ctx: Context, task: Row) => ctx.list(ATTEMPT).filter(row => row.task_id === task.id);
export const latest = (ctx: Context, task: Row) => attempts(ctx, task).sort((a, b) => Number(b.attempt_no) - Number(a.attempt_no))[0];
const generation = (target: Row) => target.snapshot_generation ?? 1;
const sideEffect = (attempt: Row) => attempt.side_effect_possible === true || ['submitted', 'accepted', 'unknown'].includes(status(attempt));
export function pending(ctx: Context, task: Row) {
  const claims = new Set(ctx.list('connector_task').filter(row => ['claimed', 'outcome_unknown'].includes(status(row)) ||
    row.status === 'completed' && row.identity_checked_at).map(row => row.attempt_id));
  return attempts(ctx, task).find(row =>
    sideEffect(row) && ['in_progress', 'submitted', 'accepted', 'unknown'].includes(status(row)) ||
    row.executor === 'connector' && row.id === task.active_attempt_id && claims.has(row.id));
}
export function noPending(ctx: Context, task: Row) {
  if (pending(ctx, task) || ['outcome_unknown', 'accepted', 'cancel_pending'].includes(status(task))) {
    throw conflict('OUTCOME_UNKNOWN', 'Resolve the original attempt before starting another');
  }
}

export function transition(ctx: Context, task: Row, to: string, reason: string, patch: Data = {}) {
  const next = ctx.update(TASK, task.id, { ...patch, status: to, status_reason: reason, sub_status: patch.sub_status ?? null,
    ...(FINAL.includes(to) ? { finished_at: ctx.now } : {}) });
  const event = { task_id: task.id, publish_target_id: task.publish_target_id, reason, sub_status: next.sub_status };
  if (task.status !== to) {
    ctx.emit('execution.task.status_changed', { ...event, from: task.status, to });
    if (['blocked', 'failed', 'expired', 'cancelled'].includes(to)) ctx.emit(`execution.task.${to}`, event);
    if (to === 'manual') ctx.emit('execution.task.manual_required', event);
  }
  return next;
}

export function executionCheck(ctx: Context, task: Row, drainingClaim = false) {
  if (task.restore_hold) return { reason: 'restore_reconcile' };
  const target = targetOf(ctx, task);
  if (target.plan_status === 'paused') return { reason: 'paused' };
  if (target.plan_status !== 'ready' || target.frozen_hash !== task.frozen_hash || generation(target) !== task.snapshot_generation) return { reason: 'approval_invalid' };
  const assessment = assessTarget(ctx, target, 'execution', drainingClaim);
  if (!approvalValid(ctx, target, String(task.frozen_hash))) return { reason: 'approval_invalid' };
  const blockers = assessment.items.filter(item => item.severity === 'blocker');
  const catalog = blockers.find(item => item.check_key === 'listing_availability' || item.check_key === 'promotion_validity' || item.check_key === 'product_fact');
  if (catalog) return { reason: 'precheck_blocked', reviewReason: catalog.detail.old_snapshot_id ? 'product_price_claim_changed' : 'publishing_catalog_changed', blockers };
  if (assessment.hash !== task.frozen_hash || digest(task.frozen) !== digest(assessment.payload)) return { reason: 'approval_invalid' };
  const reason = blockers.some(item => item.check_key === 'device_online') ? 'device_offline'
    : blockers.some(item => item.check_key === 'mobile_device_online') ? 'mobile_unavailable'
    : blockers.length ? 'precheck_blocked' : undefined;
  return { reason, assessment, blockers };
}

export const authorized = (ctx: Context, task: Row) => executionCheck(ctx, task).reason;

export function blockExecution(ctx: Context, task: Row, check: ReturnType<typeof executionCheck>, extra: Data = {}) {
  const reason = check.reason ?? 'precheck_blocked';
  const next = transition(ctx, task, 'blocked', reason, { ...extra, sub_status: reason, precheck_blockers: check.blockers ?? [] });
  if (check.reviewReason) invalidateTargets(ctx, target => target.id === task.publish_target_id, check.reviewReason);
  return next;
}

export function ensureTask(ctx: Context, target: Row) {
  if (target.plan_status !== 'ready') throw conflict('TARGET_NOT_READY', 'The publish target must be ready');
  const existing = taskFor(ctx, target);
  if (existing?.snapshot_generation === generation(target) && existing?.frozen_hash === target.frozen_hash) {
    if (target.execution_task_id !== existing.id) ctx.update('publish_target', target.id, { execution_task_id: existing.id });
    return existing;
  }
  if (existing && (!REFROZEN.includes(status(existing)) || existing.active_attempt_id || pending(ctx, existing))) {
    throw conflict('TASK_ALREADY_STARTED', 'The existing execution cannot be refrozen');
  }
  const assessed = assessTarget(ctx, target, 'execution');
  if (!target.frozen_hash || assessed.hash !== target.frozen_hash || !assessed.payload || !approvalValid(ctx, target, assessed.hash)) throw conflict('APPROVAL_INVALID', 'The current payload differs from the approved payload');
  const settings = ctx.list('execution_setting');
  const scoped = (scope_type: string, scope_id: unknown) => settings.find(row => row.scope_type === scope_type && row.scope_id === scope_id);
  const policy = { ...scoped('workspace', ctx.workspaceId), ...scoped('brand', target.brand_id), ...scoped('social_account', target.social_account_id) };
  const latePolicy = target.late_policy ?? policy.late_policy ?? 'notify';
  const values = {
    publish_target_id: target.id, social_account_id: target.social_account_id, variant_revision_id: target.variant_revision_id,
    operation: target.operation ?? 'publish', content_format: target.content_format,
    approval_request_id: target.approval_request_id ?? null, frozen: structuredClone(assessed.payload),
    frozen_hash: assessed.hash, snapshot_generation: generation(target), frozen_version: Number(existing?.frozen_version ?? 0) + 1,
    due_at: target.scheduled_at ?? null, schedule_kind: target.schedule_kind ?? 'asap', schedule_tz: target.schedule_tz ?? null,
    route: [target.schedule_kind !== 'manual_date' && assessed.route === 'api' ? { executor: 'api', reason: 'capability_advertised' } :
      { executor: 'manual', reason: target.schedule_kind === 'manual_date' ? 'manual_date' : 'manual_fallback' }],
    assignee_user_id: existing?.assignee_user_id ?? target.owner_user_id ?? null,
    late_policy: latePolicy, grace_minutes: target.grace_minutes ?? policy.grace_minutes ?? (latePolicy === 'skip' ? 0 : 30),
    max_auto_retries: policy.max_auto_retries ?? 3, unknown_to_manual_after_minutes: policy.unknown_to_manual_after_minutes ?? 360,
    verify_schedule_seconds: policy.verify_schedule_seconds ?? VERIFY_SCHEDULE_SECONDS,
    late_override_at: null, next_retry_at: null, resume_status: null,
  };
  const state = time(target.scheduled_at) > time(ctx.now) ? 'scheduled' : 'queued';
  const task = existing ? transition(ctx, existing, state, 'refrozen', values) : ctx.create(TASK, { ...values, status: state, attempt_count: 0, auto_retry_count: 0, fencing_token: 0, active_attempt_id: null });
  if (target.execution_task_id !== task.id) ctx.update('publish_target', target.id, { execution_task_id: task.id });
  ctx.emit(existing ? 'execution.task.refrozen' : 'execution.task.created', { task_id: task.id, publish_target_id: target.id, frozen_hash: task.frozen_hash, snapshot_generation: task.snapshot_generation });
  return task;
}

export function late(ctx: Context, task: Row, availableAt = ctx.now) {
  const delay = time(availableAt) - time(task.due_at);
  if (task.late_override_at || !(delay > Number(task.grace_minutes) * 60_000)) return;
  const timing = { delay_minutes: Math.floor(delay / 60_000), late_evaluated_at: ctx.now };
  if (task.late_policy === 'notify') {
    const next = transition(ctx, task, 'blocked', 'late_awaiting_decision', { ...timing, sub_status: 'late_awaiting_decision' });
    ctx.emit('execution.task.late_decision_required', { task_id: task.id, publish_target_id: task.publish_target_id, recipient_user_id: task.assignee_user_id, ...timing });
    return next;
  }
  closeTarget(ctx, targetOf(ctx, task), 'expired_skipped');
  return transition(ctx, task, 'expired', 'late_policy', timing);
}

export function step(ctx: Context, attempt: Row, name: string, detail: Data = {}) {
  const seq = ctx.list('execution_attempt_step').filter(row => row.attempt_id === attempt.id).length + 1;
  ctx.create('execution_attempt_step', { attempt_id: attempt.id, seq, step: name, status: 'succeeded', detail, at: ctx.now });
}
export const fence = (task: Row): Data => ({ active_attempt_id: null, lease_expires_at: null, lease_owner_id: null, fencing_token: Number(task.fencing_token) + 1 });
export function settleConnector(ctx: Context, attempt: Row, outcome: 'verified' | 'failed' | 'unknown', externalPostId?: string) {
  if (attempt.executor !== 'connector') return;
  const connector = ctx.list('connector_task').find(row => row.attempt_id === attempt.id);
  if (connector?.status === 'outcome_unknown') reconcileConnectorTask(ctx, attempt.id, outcome, externalPostId);
}

export function endAttempt(ctx: Context, attempt: Row, state: string, patch: Data = {}) {
  if (attempt.executor === 'connector') {
    const connector = ctx.list('connector_task').find(row => row.attempt_id === attempt.id);
    if (state === 'abandoned' && connector?.status === 'queued') ctx.update('connector_task', connector.id, { status: 'abandoned' });
    if (state === 'unknown' && connector?.status === 'claimed') ctx.update('connector_task', connector.id, { status: 'outcome_unknown' });
  }
  const slot = ctx.list(SLOT).find(row => row.holder_id === attempt.id && row.fencing_token === attempt.write_slot_fencing_token);
  if (slot) ctx.update(SLOT, slot.id, { holder_id: null, holder_kind: null, lease_expires_at: null });
  return ctx.update(ATTEMPT, attempt.id, { ...patch, status: state, finished_at: ctx.now });
}

export function availableWriteSlot(ctx: Context, accountId: unknown) {
  const slot = ctx.list(SLOT).find(row => row.social_account_id === accountId);
  if (slot?.holder_id && (!slot.lease_expires_at || time(slot.lease_expires_at) > time(ctx.now))) {
    throw conflict('ACCOUNT_BUSY', 'Another operation holds the account write slot');
  }
  return slot;
}

export function holdWriteSlot(ctx: Context, slot: Row | undefined, accountId: unknown, holderKind: string, holderId: string, fencingToken: number, expiresAt: string) {
  const values = { social_account_id: accountId, holder_kind: holderKind, holder_id: holderId, fencing_token: fencingToken, lease_expires_at: expiresAt };
  return slot ? ctx.update(SLOT, slot.id, values) : ctx.create(SLOT, values);
}

export function openAttempt(ctx: Context, task: Row, executor: 'api' | 'manual' | 'connector', actor: string) {
  noPending(ctx, task);
  if (task.active_attempt_id) throw conflict('ATTEMPT_ACTIVE', 'An attempt is already active');
  const slot = availableWriteSlot(ctx, task.social_account_id);
  const attempt_no = Number(task.attempt_count) + 1;
  const fencing_token = Number(task.fencing_token) + 1;
  const write_slot_fencing_token = Number(slot?.fencing_token ?? 0) + 1;
  const lease_expires_at = after(ctx, executor === 'api' ? 600 : executor === 'connector' ? PUBLISH_ASSIST_WAIT_SECONDS + PUBLISH_RESULT_REPORT_SECONDS : 1800);
  const attempt = ctx.create(ATTEMPT, { task_id: task.id, attempt_no, executor, purpose: 'submit', fencing_token, write_slot_fencing_token,
    client_request_id: `${task.id}:${task.snapshot_generation}:${attempt_no}`, request_hash: task.frozen_hash, snapshot_generation: task.snapshot_generation,
    status: executor === 'manual' ? 'in_progress' : 'claimed', side_effect_possible: executor === 'manual', started_at: ctx.now, triggered_by_id: ctx.actorId });
  holdWriteSlot(ctx, slot, task.social_account_id, 'attempt', attempt.id, write_slot_fencing_token, lease_expires_at);
  const next = transition(ctx, task, executor === 'manual' ? 'manual' : 'running', 'attempt_started', {
    active_attempt_id: attempt.id, attempt_count: attempt_no, fencing_token, lease_expires_at, lease_owner_id: actor,
    sub_status: executor === 'manual' ? 'in_progress' : 'preparing_media', first_started_at: task.first_started_at ?? ctx.now,
  });
  step(ctx, attempt, 'claim');
  ctx.emit('execution.attempt.started', { task_id: task.id, attempt_id: attempt.id, executor, purpose: attempt.purpose });
  return { task: next, attempt };
}

export function activeVerification(ctx: Context, attempt: Row) {
  return ctx.list('execution_verification').find(row => row.attempt_id === attempt.id && row.status === 'requested');
}

export function cancellationTracking(ctx: Context, task: Row | null | undefined) {
  const attempt = task?.status === 'cancel_pending' ? pending(ctx, task) : undefined;
  const request = attempt && activeVerification(ctx, attempt);
  return request ? { operation_id: request.id } : {};
}

export const acceptsVerification = (result: unknown) =>
  typeof result === 'object' && result !== null && 'operation_id' in result;

export function requestVerification(ctx: Context, task: Row, attempt: Row, reason: string, available_at = ctx.now) {
  const existing = activeVerification(ctx, attempt);
  const cancellation = task.cancel_requested_at && !existing?.cancel_requested_at ? { cancel_requested_at: task.cancel_requested_at } : {};
  if (existing) {
    const patch = { ...cancellation, ...(time(existing.available_at) > time(available_at) && { available_at }) };
    return Object.keys(patch).length ? ctx.update('execution_verification', existing.id, patch) : existing;
  }
  const request = ctx.create('execution_verification', { task_id: task.id, attempt_id: attempt.id, status: 'requested', reason, available_at, ...cancellation });
  ctx.emit('execution.verification.requested', { task_id: task.id, attempt_id: attempt.id, operation_id: request.id });
  return request;
}
export function settleVerification(ctx: Context, attempt: Row, outcome: string) {
  for (const row of ctx.list('execution_verification').filter(row => row.attempt_id === attempt.id && row.status === 'requested')) {
    ctx.update('execution_verification', row.id, { status: 'completed', outcome, completed_at: ctx.now });
  }
}
export function uncertain(ctx: Context, task: Row, attempt: Row, reason: string) {
  const nextAttempt = endAttempt(ctx, attempt, 'unknown', { side_effect_possible: true, error_class: 'outcome_unknown', unknown_at: ctx.now, next_check_at: after(ctx, verificationDelay(task)) });
  const next = transition(ctx, task, task.cancel_requested_at ? 'cancel_pending' : 'outcome_unknown', reason, fence(task));
  ctx.emit('execution.attempt.outcome_unknown', { task_id: task.id, attempt_id: attempt.id, executor: attempt.executor, submitted_by: attempt.submitted_by ?? null, reason });
  requestVerification(ctx, next, nextAttempt, task.cancel_requested_at ? 'cancellation' : reason,
    task.cancel_requested_at ? ctx.now : String(nextAttempt.next_check_at));
  return next;
}

export function confirmCancellation(ctx: Context, task: Row, reason: string) {
  const target = targetOf(ctx, task);
  if (target.plan_status === 'cancel_requested') ctx.update('publish_target', target.id, { plan_status: 'cancelled' });
  return transition(ctx, task, 'cancelled', reason, { ...fence(task), restore_hold: false });
}
export function requestCancellation(ctx: Context, target: Row, verifyOnly = false) {
  const task = taskFor(ctx, target);
  if (!task || task.status === 'cancelled') return task ?? null;
  if (task.status === 'cancel_pending') {
    if (!verifyOnly && task.cancel_verify_only === true) {
      const next = ctx.update(TASK, task.id, { cancel_verify_only: false });
      const attempt = pending(ctx, next);
      if (attempt) requestVerification(ctx, next, attempt, 'cancellation');
      return next;
    }
    return task;
  }
  if (task.restore_hold && !pending(ctx, task)) throw conflict('RESTORE_RECONCILE_REQUIRED', 'Review the restored task before cancellation');
  if (FINAL.includes(status(task))) throw conflict('INVALID_STATE', 'The execution task is already closed');
  const patch = { cancel_requested_at: ctx.now, cancel_requested_by: ctx.actorId };
  const unresolved = pending(ctx, task);
  if (unresolved) {
    const next = transition(ctx, task, 'cancel_pending', 'external_outcome_pending', { ...patch, cancel_verify_only: verifyOnly });
    requestVerification(ctx, next, unresolved, 'cancellation');
    return next;
  }
  const active = find(ctx, ATTEMPT, task.active_attempt_id);
  if (active) endAttempt(ctx, active, 'abandoned');
  return transition(ctx, task, 'cancelled', 'cancelled_before_submit', { ...patch, ...fence(task) });
}

export function url(value: unknown) {
  const candidate = text(value, 'permalink');
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.hostname) { parsed.hash = ''; return parsed.href; }
  } catch { /* Report invalid values through the module contract. */ }
  throw invalid('Provide an HTTPS permalink');
}
export function attachEvidence(ctx: Context, value: unknown, kind: string, id: string) {
  return ids(value, 'evidence_file_ids', 20).map(fileId => {
    const file = find(ctx, 'file_object', fileId);
    const uploaded = find(ctx, 'evidence', fileId);
    const fileObject = file ?? find(ctx, 'file_object', uploaded?.file_object_id);
    if (!fileObject || fileObject.deleted_at || !['clean', 'skipped'].includes(String(fileObject.scan_status)) || fileObject.purpose !== 'evidence') throw invalid(`Evidence file is unavailable: ${fileId}`);
    if (fileObject.storage_key) return attachMediaEvidence(ctx, fileObject.id, { kind, id }).id;
    const existing = ctx.list('evidence').find(row => !row.deleted_at && row.file_object_id === fileObject.id && row.linked_resource_type === kind && row.linked_resource_id === id);
    return existing?.id ?? ctx.create('evidence', { kind: 'file', file_object_id: fileObject.id, captured_at: ctx.now, linked_resource_type: kind, linked_resource_id: id, captured_by: ctx.actorId }).id;
  });
}

export function matchingPost(ctx: Context, account: Row, values: Data, task?: Row) {
  const matches = ctx.list(POST).filter(row => row.social_account_id === account.id && ((values.external_post_id && row.external_post_id === values.external_post_id) || (values.permalink && row.permalink === values.permalink)));
  const existing = matches[0];
  if (matches.length > 1 || (existing?.external_post_id && values.external_post_id && existing.external_post_id !== values.external_post_id) ||
      (task && existing?.publish_target_id && existing.publish_target_id !== task.publish_target_id)) throw conflict('POST_ALREADY_LINKED', 'The permalink or external ID belongs to another post or target');
  return existing;
}

export function savePost(ctx: Context, account: Row, values: Data, task?: Row) {
  const existing = matchingPost(ctx, account, values, task);
  const links = task ? { publish_target_id: task.publish_target_id, execution_task_id: task.id } : {};
  const post = existing ? ctx.update(POST, existing.id, { ...links, external_post_id: existing.external_post_id ?? values.external_post_id,
    permalink: values.permalink ?? existing.permalink,
    ...(values.verification === 'system_verified' && values.visibility != null ? { visibility: values.visibility } : {}),
    ...(values.verification === 'system_verified' && values.submitted_by != null ? { submitted_by: values.submitted_by } : {}),
    verification: existing.verification === 'system_verified' ? existing.verification : values.verification,
    evidence_ids: [...new Set([...(Array.isArray(existing.evidence_ids) ? existing.evidence_ids : []), ...(Array.isArray(values.evidence_ids) ? values.evidence_ids : [])])], last_observed_at: ctx.now,
  }) : ctx.create(POST, { ...values, ...links, social_account_id: account.id, provider: account.provider ?? account.platform, first_seen_at: ctx.now, last_observed_at: ctx.now });
  if (!existing) ctx.emit('execution.platform_post.observed', { platform_post_id: post.id, origin: post.origin });
  if (task && !existing?.publish_target_id) ctx.emit('execution.platform_post.linked', { platform_post_id: post.id, ...links });
  return post;
}

/** Trusted read-back ingress for platform sync. A native post does not close any plan by itself. */
export function upsertObservedPost(ctx: Context, accountId: string, observation: Data) {
  const account = ctx.get('social_account', accountId);
  const external_post_id = text(observation.external_post_id, 'external_post_id');
  const permalink = observation.permalink == null ? null : url(observation.permalink);
  const post_status = one(observation.post_status ?? 'live', ['live', 'private', 'processing', 'removed_by_platform', 'deleted', 'hidden', 'unknown'], 'post_status');
  const published_at = observation.published_at ?? null;
  if (published_at !== null && (!Number.isFinite(time(published_at)) || time(published_at) > time(ctx.now))) throw invalid('Invalid published_at');
  const existing = matchingPost(ctx, account, { external_post_id, permalink });
  const observed_at = observation.observed_at ?? ctx.now;
  if (!Number.isFinite(time(observed_at)) || time(observed_at) > time(ctx.now)) throw invalid('Invalid observed_at');
  if (existing && time(observed_at) < time(existing.last_platform_observation_at)) return existing;
  const post = savePost(ctx, account, { external_post_id, permalink, post_status, published_at,
    caption_snapshot: optional(observation.caption_snapshot) ?? null, origin: 'native', verification: 'system_verified',
    visibility: observation.visibility == null ? null : one(observation.visibility, ['public', 'private', 'unlisted'], 'visibility'),
  });
  const next = ctx.update(POST, post.id, { post_status, last_platform_observation_at: observed_at });
  if (existing && post.post_status !== post_status) {
    ctx.emit('execution.platform_post.status_changed', { platform_post_id: post.id, post_status, previous_status: post.post_status });
  }
  for (const watch of ctx.list('post_watch').filter(row => row.platform_post_id === post.id && row.status === 'active' && time(row.watch_until) > time(ctx.now))) {
    const ended = ['deleted', 'removed_by_platform'].includes(post_status);
    ctx.update('post_watch', watch.id, { last_status: post_status, last_observed_at: observed_at, status: ended ? 'completed' : 'active',
      ...(ended ? { completed_at: ctx.now } : {}) });
  }
  return next;
}

export function publish(ctx: Context, task: Row, attempt: Row, values: Data) {
  const account = ctx.get('social_account', String(task.social_account_id));
  const post = savePost(ctx, account, values, task);
  step(ctx, attempt, 'verify', { platform_post_id: post.id, evidence_ids: values.evidence_ids ?? [] });
  endAttempt(ctx, attempt, 'verified_published', { outcome_checked_at: ctx.now, submitted_by: values.submitted_by, next_check_at: null });
  settleVerification(ctx, attempt, 'published');
  settleConnector(ctx, attempt, 'verified', optional(post.external_post_id));
  const next = transition(ctx, task, 'published', String(post.verification), { ...fence(task), restore_hold: false, platform_post_id: post.id, sub_status: post.visibility ?? 'public' });
  closeTarget(ctx, targetOf(ctx, task), post.origin === 'native' ? 'matched_native' : values.verification === 'manual_confirmed' ? 'manual_done' : 'published');
  const event = { task_id: task.id, publish_target_id: task.publish_target_id, platform_post_id: post.id, verification: post.verification, submitted_by: values.submitted_by };
  ctx.emit('execution.task.published', event);
  if (task.cancel_requested_at) ctx.emit('execution.task.cancel_failed', event);
  return { task: next, platform_post: post };
}

export function postDetails(ctx: Context, body: Data) {
  if (body.published_at !== undefined && (!Number.isFinite(time(body.published_at)) || time(body.published_at) > time(ctx.now))) throw invalid('published_at must be a valid time no later than now');
  return { permalink: url(body.permalink), external_post_id: body.external_post_id == null ? null : text(body.external_post_id, 'external_post_id'), published_at: body.published_at ?? ctx.now };
}
export function assignee(ctx: Context, task: Row) {
  if (task.assignee_user_id && task.assignee_user_id !== ctx.actorId && !ADMIN.includes(ctx.role)) throw new Problem(403, 'FORBIDDEN', 'Only the assignee or administrator can take this action');
}

export function manualComplete(ctx: Context, task: Row, body: Data, origin = 'system') {
  const restoreBackfill = task.restore_hold && origin === 'manual_registered' && ADMIN.includes(ctx.role);
  if (!restoreBackfill && !['manual', 'accepted', 'outcome_unknown', 'cancel_pending'].includes(status(task))) throw conflict('INVALID_STATE', 'The task is not awaiting a manual result');
  assignee(ctx, task);
  const values = postDetails(ctx, body);
  let attempt = pending(ctx, task);
  if (attempt && attempt.executor !== 'manual' && !['accepted', 'unknown'].includes(status(attempt))) {
    throw conflict('ATTEMPT_ACTIVE', 'Wait for the executor attempt to reach reconciliation');
  }
  if (!attempt) {
    const reason = restoreBackfill ? undefined : authorized(ctx, task);
    if (reason) throw conflict('PRECHECK_BLOCKED', `Execution is blocked: ${reason}`);
    // Backfill records an existing publication and does not grant a new write lease.
    if (task.active_attempt_id) throw conflict('ATTEMPT_ACTIVE', 'Resolve the active attempt first');
    const attempt_no = Number(task.attempt_count) + 1;
    attempt = ctx.create(ATTEMPT, { task_id: task.id, attempt_no, executor: 'manual', purpose: 'backfill',
      status: 'in_progress', request_hash: task.frozen_hash, snapshot_generation: task.snapshot_generation,
      started_at: ctx.now, triggered_by_id: ctx.actorId });
    task = ctx.update(TASK, task.id, { attempt_count: attempt_no });
  }
  const evidence_ids = attachEvidence(ctx, body.evidence_file_ids ?? body.evidence_ids, 'execution_attempt', attempt.id);
  return publish(ctx, task, attempt, { ...values, evidence_ids, origin, verification: 'manual_confirmed', submitted_by: attempt.executor === 'manual' ? 'manual' : attempt.submitted_by ?? null, post_status: 'live' });
}

export function registerManualPost(ctx: Context, target: Row, body: Data) {
  let task = taskFor(ctx, target) ?? ensureTask(ctx, target);
  if (task.status === 'published' && task.platform_post_id) {
    const post = ctx.get(POST, String(task.platform_post_id));
    if (post.permalink === url(body.permalink)) return post;
    throw conflict('POST_ALREADY_LINKED', 'The target has a different platform post');
  }
  if (REFROZEN.includes(status(task)) && !task.restore_hold && !task.active_attempt_id && !pending(ctx, task)) {
    task = transition(ctx, task, 'manual', 'manual_registration');
  }
  return manualComplete(ctx, task, body, 'manual_registered').platform_post;
}
