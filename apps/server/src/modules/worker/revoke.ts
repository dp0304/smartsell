import { Problem, type Context, type Data, type RevokeReason, type Row, type WorkerJobStatus } from '@smartsell/contracts';
import { approvalValid } from '../../../../../packages/domain/src/publishing/index.js';
import { TASK, transition } from '../execution/service.js';
import { JOB, addEvent, bumpSyncGeneration, isTerminal, liveJobs, locate, setJob } from './model.js';

export const postLocked = () => new Problem(409, 'POST_LOCKED', 'Publishing is in progress; wait for the result.');
export const resultUnknown = (details?: Data) => new Problem(409, 'POST_RESULT_UNKNOWN',
  'The result is unknown. Ask the owner to confirm published or not published at web_url.', details);

/** Jobs that keep an account on its machine (§5.10 換機器 rule 1). */
export const ACTIVE_JOB_STATUSES: readonly WorkerJobStatus[] = ['claimed', 'ready', 'running', 'submitting', 'result_pending', 'needs_owner',
  'releasing', 'unreported', 'outcome_unknown'];

const revokedStatus = (reason: RevokeReason): WorkerJobStatus => reason === 'superseded' ? 'superseded' : 'cancelled';
/** No machine ever held the job: never claimed, never told go, never started (WE-2). */
export const neverClaimed = (job: Row) => !job.claimed_at && !job.go_at && !job.started_at && !job.submitting_at;

/**
 * C3 (§5.10). queued, or never claimed (WE-2), → cancelled/superseded at once; claimed, ready and an unstarted needs_owner → releasing (the next
 * heartbeat carries it in revoked_jobs and hold=true); a started job keeps its state with `revoke` set until the Worker
 * reports released or the facts say it posted. submitting/result_pending throw POST_LOCKED.
 */
export function requestRevoke(ctx: Context, job: Row, reason: RevokeReason): 'cancelled' | 'releasing' | 'revoke_pending' {
  const current = locate(ctx, JOB, job.id) ?? job;
  if (isTerminal(current)) return 'cancelled';
  const status = String(current.status);
  if (status === 'submitting' || status === 'result_pending') throw postLocked();
  if (status === 'outcome_unknown' || status === 'unreported') throw resultUnknown({ job_id: current.id });
  // A cancellation replaces a weaker pending reason (superseded, approval_invalidated); never the other way round.
  const revoke = current.revoke && (current.revoke as Data).reason === 'cancelled' ? current.revoke : { reason, requested_at: ctx.now };
  const effective = (revoke as Data).reason as RevokeReason;
  // WE-2: a job no machine ever claimed (queued, or parked by the hub as needs_owner media_unavailable) has nobody to
  // release it, so it ends at once like a queued job instead of waiting in releasing until the lifecycle calls it unreported.
  if (status === 'queued' || neverClaimed(current)) {
    addEvent(ctx, current, 'revoke_requested', { reason: effective, outcome: 'cancelled_unclaimed' });
    setJob(ctx, current, { status: revokedStatus(effective), revoke, finished_at: ctx.now });
    return 'cancelled';
  }
  const started = !!current.started_at || status === 'running';
  addEvent(ctx, current, 'revoke_requested', { reason: effective, outcome: started ? 'revoke_pending' : 'releasing' });
  if (started) setJob(ctx, current, { revoke });
  else setJob(ctx, current, { status: 'releasing', revoke });
  bumpSyncGeneration(ctx, [String(current.device_id)], 'job_revoked');
  return started ? 'revoke_pending' : 'releasing';
}

/**
 * C3 for S2's blockUnsent: revokes live jobs that no longer match the current task (frozen hash or scheduled time), and
 * every live job once the target is not ready any more. The target's current matching job is not revoked while it has not
 * started: go check 5 and the heartbeat hold stop it, and a direct channel re-approves it in the same transaction (§4.1).
 * A matching job that already started is revoked when its approval is gone, because only the Worker's check before the
 * click can stop it then (§5.10). Never throws: submitting/result_pending and unknown jobs are left to their result.
 */
export function revokeForTarget(ctx: Context, target: Row, reason: RevokeReason): void {
  const current = locate(ctx, 'publish_target', target.id) ?? target;
  const task = ctx.list(TASK).find(row => row.publish_target_id === current.id);
  for (const job of liveJobs(ctx, row => row.publish_target_id === current.id && row.kind === 'publish_post' && row.dry_run !== true)) {
    if (['submitting', 'result_pending', 'outcome_unknown', 'unreported'].includes(String(job.status))) continue;
    const matches = job.id === current.worker_job_id && !!task && job.execution_task_id === task.id && job.frozen_hash === task.frozen_hash &&
      job.scheduled_for === current.scheduled_at;
    if (matches && current.plan_status === 'ready') {
      const started = !!job.started_at || job.status === 'running';
      if (!started || approvalValid(ctx, current, String(job.frozen_hash))) continue;
    }
    requestRevoke(ctx, job, reason);
  }
}

/**
 * Lifecycle safety net (§5.10 rule): a live job whose post moved on — rescheduled or edited without a dispatch in the same
 * transaction, sent back for approval, closed or cancelled elsewhere — is revoked instead of running out its window and
 * reporting `missed`. A paused post keeps its job (pause never revokes).
 */
export function revokeOrphanJobs(ctx: Context) {
  for (const job of liveJobs(ctx, row => row.kind === 'publish_post' && row.dry_run !== true && !row.revoke &&
    ['queued', 'claimed', 'ready', 'needs_owner', 'running'].includes(String(row.status)) && !row.submitting_at &&
    // A successor still waiting on its predecessor is decided by the successor table (§5.2), not here.
    !(typeof row.waits_for_job_id === 'string' && !row.waits_released_at))) {
    const target = locate(ctx, 'publish_target', job.publish_target_id);
    const plan = String(target?.plan_status ?? '');
    if (plan === 'paused' || plan === 'cancel_requested') continue;
    if (plan === 'ready' && target!.worker_job_id === job.id && target!.scheduled_at === job.scheduled_for) continue;
    const started = !!job.started_at || job.status === 'running';
    if (plan === 'ready' && started) continue;   // a started job on a ready post is stopped only by an explicit revoke
    const reason: RevokeReason = !target || ['closed', 'cancelled'].includes(plan) ? 'cancelled'
      : plan === 'ready' ? 'superseded' : 'approval_invalidated';
    requestRevoke(ctx, job, reason);
  }
}

/**
 * Whether a job keeps its account on its machine (§5.10 換機器 rule 1). Only a real post that a machine holds or may have
 * run does: a login check or a dry run on the old machine is moot once the account moves, and a post no machine ever
 * claimed (queued, or parked by the hub for its media) simply follows the account (WE-5, WE-2). bindMachine should use
 * this instead of ACTIVE_JOB_STATUSES alone, so a login check never blocks a move with 「這 1 則貼文」 naming no post.
 */
export function blocksMachineMove(job: Row): boolean {
  if (!ACTIVE_JOB_STATUSES.includes(job.status as WorkerJobStatus)) return false;
  if (job.kind !== 'publish_post' || job.dry_run === true) return false;
  return !neverClaimed(job) || !['queued', 'needs_owner'].includes(String(job.status));
}

/** C3 (§5.10 step 3): queued jobs follow the account to its new machine; anything already claimed blocks the move. */
export function moveQueuedChannelJobs(ctx: Context, socialAccountId: string, newDeviceId: string): { moved: number } {
  const live = liveJobs(ctx, job => job.social_account_id === socialAccountId);
  const active = live.filter(blocksMachineMove);
  if (active.length) {
    const postIds = [...new Set(active.map(job => job.publish_target_id).filter((id): id is string => typeof id === 'string'))];
    throw new Problem(409, 'CHANNEL_HAS_ACTIVE_JOBS', `請先取消或等這 ${postIds.length || active.length} 則貼文結束，再換機器`, { post_ids: postIds, job_ids: active.map(job => job.id) });
  }
  const binding = ctx.list('account_execution_binding').find(row => row.social_account_id === socialAccountId);
  let moved = 0;
  const devices = new Set<string>([newDeviceId]);
  for (const job of live.filter(row => row.device_id !== newDeviceId)) {
    // A login check or dry run of the old machine is withdrawn there; the new machine gets its own check (§5.10 step 4).
    if (job.kind !== 'publish_post' || job.dry_run === true) {
      devices.add(String(job.device_id));
      try { requestRevoke(ctx, job, 'superseded'); } catch { /* a dry run past its click is left to its own facts */ }
      continue;
    }
    if (!(job.status === 'queued' || (job.status === 'needs_owner' && neverClaimed(job)))) continue;
    devices.add(String(job.device_id));
    const history = Array.isArray(job.device_history) ? job.device_history as string[] : [];
    setJob(ctx, job, { device_id: newDeviceId, device_history: [...new Set([...history, newDeviceId])], fencing_token: Number(job.fencing_token ?? 0) + 1,
      ...(binding && { binding_id: binding.id }) });
    addEvent(ctx, job, 'reassigned', { from_device_id: job.device_id, to_device_id: newDeviceId });
    moved++;
  }
  if (moved) bumpSyncGeneration(ctx, [...devices], 'jobs_reassigned');
  return { moved };
}

/**
 * §5.10 取消, Worker-aware. Runs in planning's cancel transaction: no job, queued or never claimed (WE-2) → everything cancelled now;
 * claimed/ready/needs_owner/running → task cancel_pending and the job revoked; submitting/result_pending → POST_LOCKED;
 * outcome_unknown/unreported → POST_RESULT_UNKNOWN. Returns the task.
 */
export function cancelWorkerTask(ctx: Context, target: Row, task: Row): Row {
  const job = liveJobs(ctx, row => row.publish_target_id === target.id && row.kind === 'publish_post' && row.dry_run !== true)
    .sort((a, b) => (a.id === target.worker_job_id ? -1 : b.id === target.worker_job_id ? 1 : 0))[0];
  const status = String(job?.status ?? '');
  if (status === 'submitting' || status === 'result_pending') throw postLocked();
  if (status === 'outcome_unknown' || status === 'unreported' || task.status === 'outcome_unknown') throw resultUnknown({ post_id: target.id });
  const patch = { cancel_requested_at: ctx.now, cancel_requested_by: ctx.actorId };
  if (!job || status === 'queued' || neverClaimed(job)) {
    if (job) requestRevoke(ctx, job, 'cancelled');
    const fresh = ctx.get(TASK, task.id);
    if (fresh.status === 'cancelled') return fresh;
    return transition(ctx, fresh, 'cancelled', 'cancelled_before_claim', { ...patch, active_attempt_id: null });
  }
  const pending = transition(ctx, ctx.get(TASK, task.id), 'cancel_pending', 'worker_release_pending', patch);
  requestRevoke(ctx, job, 'cancelled');
  return ctx.get(TASK, pending.id);
}
