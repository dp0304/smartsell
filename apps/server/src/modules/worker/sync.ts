import { type Blocker, type Context, type Data, type Row } from '@smartsell/contracts';
import { ATTEMPT, TASK, confirmCancellation, endAttempt, fence, publish, transition } from '../execution/service.js';
import { JOB, addEvent, fullBlocker, locate, setJob, str } from './model.js';

/** Statuses that hold the Worker's attempt open (§5.2 table). */
const RUNNING = ['running', 'submitting', 'result_pending'];
const isWorkerTask = (task: Row | undefined) => Array.isArray(task?.route) && (task!.route as Data[])[0]?.executor === 'worker';

/** X: /status/<id>; TikTok: /video/<id> (§3.7). */
export function externalIdFromUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  return /\/status\/(\d+)/.exec(url)?.[1] ?? /\/video\/(\d+)/.exec(url)?.[1] ?? null;
}

function ensureAttempt(ctx: Context, task: Row, job: Row): Row {
  const existing = locate(ctx, ATTEMPT, job.attempt_id);
  if (existing) return existing;
  const attemptNo = Number(task.attempt_count ?? 0) + 1;
  const attempt = ctx.create(ATTEMPT, {
    task_id: task.id, attempt_no: attemptNo, executor: 'worker', purpose: 'submit', status: 'in_progress', side_effect_possible: false,
    worker_job_id: job.id, device_id: job.device_id, request_hash: task.frozen_hash, snapshot_generation: task.snapshot_generation,
    client_request_id: `${task.id}:${job.id}`, started_at: job.started_at ?? ctx.now, triggered_by_id: 'worker',
  });
  ctx.update(TASK, task.id, { attempt_count: attemptNo, active_attempt_id: attempt.id, first_started_at: task.first_started_at ?? ctx.now });
  ctx.update(JOB, job.id, { attempt_id: attempt.id });
  ctx.emit('execution.attempt.started', { task_id: task.id, attempt_id: attempt.id, executor: 'worker', purpose: 'submit', worker_job_id: job.id });
  return attempt;
}

function closeAttempt(ctx: Context, task: Row, job: Row, state: string, patch: Data = {}) {
  const attempt = locate(ctx, ATTEMPT, job.attempt_id);
  if (attempt && ['in_progress', 'claimed'].includes(String(attempt.status)) || attempt && state === 'failed' && attempt.status === 'unknown') {
    endAttempt(ctx, attempt, state, patch);
  }
  // Every attempt end clears active_attempt_id so hasExecutionRisk() and pending() return to false (§5.2).
  const current = ctx.get(TASK, task.id);
  if (current.active_attempt_id) ctx.update(TASK, task.id, { active_attempt_id: null });
}

/**
 * §5.2: execution_task status and execution_attempt endings are written only here, from the job's state. Idempotent.
 * A job that is not the task's current job only touches the task when its facts say it posted (or may have).
 */
export function syncTaskFromJob(ctx: Context, input: Row) {
  const job = locate(ctx, JOB, input.id) ?? input;
  if (job.kind !== 'publish_post' || job.dry_run === true || typeof job.execution_task_id !== 'string') return;
  const task = locate(ctx, TASK, job.execution_task_id);
  if (!task || !isWorkerTask(task)) return;
  const current = task.worker_job_id === job.id;
  const status = String(job.status);
  if (task.status === 'published' && status !== 'succeeded') {
    // WE-1: a published post (read back or confirmed by the owner) never moves back to running or unknown, and the post keeps
    // following the job that published it; a later fact of this or an older job is recorded on that job only.
    const attempt = locate(ctx, ATTEMPT, job.attempt_id);
    if (attempt && ['in_progress', 'claimed'].includes(String(attempt.status)) && !['queued', 'claimed', 'ready', 'running', 'submitting', 'result_pending', 'needs_owner', 'releasing'].includes(status)) {
      endAttempt(ctx, attempt, ['outcome_unknown', 'unreported'].includes(status) ? 'unknown' : 'abandoned', { side_effect_possible: !!job.submitting_at });
    }
    return;
  }
  const posted = status === 'succeeded' || status === 'outcome_unknown' || status === 'unreported';
  if (!current && !posted && !job.attempt_id) return;
  if (!current && posted) {
    // A late fact from an older job wins: the post page and the task follow the job that may have posted (§5.4.3).
    ctx.update(TASK, task.id, { worker_job_id: job.id });
    const target = locate(ctx, 'publish_target', task.publish_target_id);
    if (target && target.worker_job_id !== job.id) ctx.update('publish_target', target.id, { worker_job_id: job.id });
  }
  const started = !!job.started_at || RUNNING.includes(status);
  if (!current && !posted) {
    // An older job that had started and was then released: end its attempt, leave the task to the current job.
    if (['cancelled', 'superseded', 'failed', 'missed'].includes(status)) closeAttempt(ctx, ctx.get(TASK, task.id), job, 'abandoned');
    return;
  }
  const fresh = () => ctx.get(TASK, task.id);
  switch (status) {
    case 'queued': case 'claimed': case 'ready':
      return;
    case 'needs_owner': case 'releasing':
      if (!started) return;
      ensureAttempt(ctx, fresh(), job);
      if (fresh().status !== 'running' && fresh().status !== 'cancel_pending') transition(ctx, fresh(), 'running', 'worker_started', { sub_status: 'needs_owner' });
      return;
    case 'running': case 'submitting': case 'result_pending': {
      const attempt = ensureAttempt(ctx, fresh(), job);
      if ((status !== 'running' || job.submitting_at) && attempt.side_effect_possible !== true) {
        ctx.update(ATTEMPT, attempt.id, { side_effect_possible: true, ...(job.submitted_at ? { submitted_at: job.submitted_at } : {}) });
      }
      if (fresh().status !== 'running' && fresh().status !== 'cancel_pending') transition(ctx, fresh(), 'running', 'worker_started', { sub_status: status });
      else if (fresh().sub_status !== status && fresh().status === 'running') ctx.update(TASK, task.id, { sub_status: status });
      return;
    }
    case 'succeeded': {
      if (fresh().status === 'published') return;
      const attempt = ensureAttempt(ctx, fresh(), job);
      const result = (job.result ?? {}) as Data;
      const values = {
        external_post_id: str(result.external_post_id) ?? externalIdFromUrl(result.url), permalink: str(result.url) ?? null,
        published_at: str(result.published_at) ?? ctx.now, verification: job.owner_confirmed ? 'manual_confirmed' : 'system_verified',
        registered_via: job.owner_confirmed ? 'human' : 'worker_readback', submitted_by: job.submitted_by ?? 'auto',
        evidence_ids: Array.isArray(result.evidence_ids) ? result.evidence_ids : [], post_status: 'live', origin: 'system', worker_job_id: job.id,
      };
      try {
        const { platform_post } = publish(ctx, fresh(), attempt, values);
        ctx.update('platform_post', platform_post.id, { worker_job_id: job.id, content_item_id: locate(ctx, 'publish_target', task.publish_target_id)?.content_item_id ?? null });
        ctx.update('publish_target', String(task.publish_target_id), { platform_post_id: platform_post.id });
      } catch (error) {
        if (job.owner_confirmed) throw error;
        // §3.7: a conflict is recorded, never thrown back at the Worker, or it would resend the same fact forever.
        addEvent(ctx, job, 'fact_conflict', { code: (error as { code?: string }).code ?? 'PUBLISH_FAILED', message: String((error as Error).message ?? error).slice(0, 300),
          url: values.permalink, external_post_id: values.external_post_id });
        const blocker = fullBlocker(ctx, job, { code: 'result_conflict', phase: 'after_submit', message: '', at: ctx.now });
        setJob(ctx, job, { status: 'outcome_unknown', blocker });
      }
      return;
    }
    case 'outcome_unknown': case 'unreported': {
      const attempt = ensureAttempt(ctx, fresh(), job);
      if (attempt.status !== 'unknown') {
        endAttempt(ctx, attempt, 'unknown', { side_effect_possible: true, error_class: 'outcome_unknown', unknown_at: ctx.now });
        ctx.emit('execution.attempt.outcome_unknown', { task_id: task.id, attempt_id: attempt.id, executor: 'worker', submitted_by: job.submitted_by ?? null, reason: status });
      }
      const next = fresh();
      if (next.status !== 'outcome_unknown') transition(ctx, next, next.cancel_requested_at ? 'cancel_pending' : 'outcome_unknown', `job_${status}`, { ...fence(next) });
      return;
    }
    case 'failed': {
      const owner = job.owner_marked_not_published === true;
      closeAttempt(ctx, fresh(), job, 'failed', { side_effect_possible: false, ...(owner && { outcome_checked_at: ctx.now }),
        error_class: owner ? 'owner_marked_not_published' : str((job.failure as Data | undefined)?.code) ?? 'job_failed' });
      const next = fresh();
      if (next.cancel_requested_at && next.status === 'cancel_pending') { confirmCancellation(ctx, next, 'cancelled_not_published'); return; }
      transition(ctx, next, 'blocked', owner ? 'owner_marked_not_published' : 'job_failed', { ...fence(next), sub_status: owner ? 'owner_marked_not_published' : 'job_failed' });
      return;
    }
    case 'missed': {
      closeAttempt(ctx, fresh(), job, 'abandoned', { pre_submit_failure: true });
      const next = fresh();
      if (next.cancel_requested_at && next.status === 'cancel_pending') { confirmCancellation(ctx, next, 'cancelled_before_submit'); return; }
      transition(ctx, next, 'blocked', 'job_missed', { ...fence(next), sub_status: 'job_missed' });
      return;
    }
    case 'cancelled': case 'superseded': {
      closeAttempt(ctx, fresh(), job, 'abandoned', { pre_submit_failure: true });
      const next = fresh();
      const reason = (job.revoke as Data | null)?.reason;
      if (next.cancel_requested_at || reason === 'cancelled') {
        if (!['cancelled', 'published'].includes(String(next.status))) confirmCancellation(ctx, next, 'cancelled_before_submit');
        return;
      }
      // Released for a new version or an invalid approval: the post itself is not cancelled. A task the job had
      // started returns to a refreezable state so the new job or a resubmission can take over (§5.2 table).
      if (!['scheduled', 'queued', 'blocked'].includes(String(next.status))) {
        transition(ctx, next, 'blocked', job.force_released ? 'force_released' : 'job_released', { ...fence(next), sub_status: 'job_released' });
      }
      return;
    }
  }
}

/** The blocker a job shows on the post page; undefined when it has none. */
export const jobBlocker = (job: Row): Blocker | undefined => (job.blocker as Blocker | null) ?? undefined;
