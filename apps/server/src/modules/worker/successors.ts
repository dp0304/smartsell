import { possiblySent, type Context, type Data, type Row, type WorkerJobRecord } from '@smartsell/contracts';
import { ATTEMPT } from '../execution/service.js';
import { JOB, addEvent, bumpSyncGeneration, isTerminal, locate, setJob } from './model.js';
import { requestRevoke } from './revoke.js';

/** A predecessor that may have produced a platform post: possiblySent, a reported `submitting`, or a side-effecting attempt. */
export function mayHavePosted(ctx: Context, job: Row): boolean {
  if (possiblySent(job as unknown as Pick<WorkerJobRecord, 'status' | 'submitting_at' | 'started_at'>)) return true;
  if (job.submitting_at) return true;
  const attempt = locate(ctx, ATTEMPT, job.attempt_id);
  return attempt?.side_effect_possible === true;
}

/** Whether a successor waiting on `job` may be claimed now (§5.2 successor table). */
export function waitingOn(ctx: Context, successor: Row): Row | undefined {
  if (typeof successor.waits_for_job_id !== 'string' || successor.waits_released_at) return undefined;
  return locate(ctx, JOB, successor.waits_for_job_id) ?? undefined;
}

/**
 * §5.2: a predecessor that ended without any possible external effect releases its successor; one that succeeded, is
 * outcome_unknown, or ever reported `submitting` cancels it (urgent alert, never a second post). unreported, releasing and
 * every other open state keep the successor waiting (the owner may force_release).
 */
export function releaseSuccessors(ctx: Context, predecessor: Row) {
  const pred = locate(ctx, JOB, predecessor.id) ?? predecessor;
  const status = String(pred.status);
  const ended = ['succeeded', 'failed', 'missed', 'cancelled', 'superseded', 'outcome_unknown'].includes(status);
  if (!ended) return;
  for (const successor of ctx.list(JOB).filter(row => row.waits_for_job_id === pred.id && !row.waits_released_at && row.status === 'queued')) {
    const posted = status === 'succeeded' || status === 'outcome_unknown' || mayHavePosted(ctx, pred);
    if (posted) {
      // The event goes first: S10 reads it to raise late_fact_after_release keyed by the predecessor (S10 ledger item 6).
      addEvent(ctx, successor, 'successor_cancelled_predecessor_posted', { predecessor_job_id: pred.id, predecessor_status: status });
      setJob(ctx, successor, { status: 'cancelled', finished_at: ctx.now, cancel_reason: 'predecessor_posted' });
      ctx.emit('worker.job.late_fact', { job_id: pred.id, publish_target_id: pred.publish_target_id ?? null, successor_cancelled: true });
    } else {
      addEvent(ctx, successor, 'successor_released', { predecessor_job_id: pred.id, predecessor_status: status });
      setJob(ctx, successor, { waits_released_at: ctx.now });
      bumpSyncGeneration(ctx, [String(successor.device_id)], 'successor_released');
    }
  }
}

/**
 * §5.4.3, §5.11 (E2E-13, closure-S8): a fact saying a released predecessor may have posted after all cancels every
 * successor that has not started — including one that hub_jobs_force_release had already released (waits_released_at),
 * which releaseSuccessors no longer looks at. Without this the released successor stayed claimable and could post a
 * second time. A queued successor is cancelled at once; one a machine already holds is revoked (releasing until the machine
 * lets go, go denied meanwhile). A successor that already started is left to its own facts.
 */
export function cancelSuccessorsAfterLateFact(ctx: Context, predecessor: Row) {
  const pred = locate(ctx, JOB, predecessor.id) ?? predecessor;
  for (const successor of ctx.list(JOB).filter(row => row.waits_for_job_id === pred.id && !isTerminal(row))) {
    if (successor.started_at || !['queued', 'claimed', 'ready', 'needs_owner'].includes(String(successor.status))) continue;
    addEvent(ctx, successor, 'successor_cancelled_predecessor_posted', { predecessor_job_id: pred.id, predecessor_status: String(pred.status), after_release: true });
    if (successor.status === 'queued') setJob(ctx, successor, { status: 'cancelled', finished_at: ctx.now, cancel_reason: 'predecessor_posted' });
    else requestRevoke(ctx, successor, 'superseded');
  }
}

/** Successors that wait on predecessors in states the lifecycle scan re-checks (outcome_unknown is not terminal). */
export function scanSuccessors(ctx: Context) {
  const waiting = ctx.list(JOB).filter(row => row.status === 'queued' && typeof row.waits_for_job_id === 'string' && !row.waits_released_at);
  const seen = new Set<string>();
  for (const successor of waiting) {
    const pred = locate(ctx, JOB, successor.waits_for_job_id);
    if (!pred) {
      setJob(ctx, successor, { waits_released_at: ctx.now });
      addEvent(ctx, successor, 'successor_released', { predecessor_job_id: successor.waits_for_job_id, predecessor_status: 'missing' } as Data);
      continue;
    }
    if (seen.has(pred.id)) continue;
    seen.add(pred.id);
    releaseSuccessors(ctx, pred);
  }
}
