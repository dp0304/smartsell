import { CLOCK_MARGIN_MS, type Context, type Data, type Row } from '@smartsell/contracts';
import { refreshPendingMedia } from './dispatch.js';
import { EVENT, JOB, addEvent, fullBlocker, isTerminal, jobs, locate, now, setJob, time, workerTiming } from './model.js';
import { lastContact, presenceOfflinePatches } from './presence.js';
import { scanSuccessors } from './successors.js';
import { neverClaimed, revokeOrphanJobs } from './revoke.js';

const LIFECYCLE_EVERY_MS = 15_000;
const RETAIN_EVENTS_MS = 90 * 86_400_000;
const lastRun = new Map<string, number>();
const lastPurge = new Map<string, number>();

/**
 * §5.6: the hub can prove a machine never started a job when it never said go and its last contact is older than the
 * offline-run staleness before not_before (a Worker cannot run offline on state that old, §5.7 rule 2).
 */
export function provablyNotRun(ctx: Context, job: Row): boolean {
  if (job.go_at || job.started_at || job.submitting_at) return false;
  // WE-2: no machine ever claimed it, so none can have run it (a claim always records claimed_at).
  if (!job.claimed_at) return true;
  const device = locate(ctx, 'connector_device', job.device_id);
  if (!device) return true;
  const contact = lastContact(device);
  if (contact.at === null) return true;
  const staleness = Number(job.offline_go_max_staleness_min ?? 30) * 60_000;
  return contact.at + contact.errorMs + CLOCK_MARGIN_MS < time(job.not_before) - staleness;
}

const revokedStatus = (job: Row) => (job.revoke as Data | null)?.reason === 'superseded' ? 'superseded' : 'cancelled';

/** WE-8: how long before not_after a post whose media is still uploading is parked as media_unavailable. */
export const UPLOAD_PARK_BEFORE_DEADLINE_MS = 10 * 60_000;
const UPLOADING = ['receiving', 'assembling', 'processing'];
/** Whether some media the job waits for is still arriving at the hub (its newest upload session is live). */
function uploadInProgress(ctx: Context, job: Row): boolean {
  const refs = Array.isArray(job.media_refs) ? job.media_refs as { asset_id?: string | null }[] : [];
  return refs.some(ref => {
    if (typeof ref?.asset_id !== 'string') return false;
    const session = ctx.list('media_upload_session').filter(row => row.media_id === ref.asset_id)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];
    return !!session && UPLOADING.includes(String(session.status));
  });
}

/** One pass of §5.13 items 1–9 inside a single short write transaction. Writes only jobs that change. */
export function workerLifecycle(ctx: Context) {
  const at = now(ctx);
  const timing = workerTiming();
  for (const { id, patch } of presenceOfflinePatches(ctx)) ctx.update('connector_device', id, patch);
  refreshPendingMedia(ctx);
  revokeOrphanJobs(ctx);
  for (const job of jobs(ctx)) {
    if (isTerminal(job)) continue;
    const status = String(job.status);
    const notAfter = time(job.not_after);
    const notBefore = time(job.not_before);
    // 1–2: never claimed and past the window.
    if ((status === 'queued' || (status === 'needs_owner' && !job.claimed_at)) && at > notAfter) {
      if (job.kind === 'check_login' && status === 'queued' && job.requeued_at) { setJob(ctx, job, { status: 'failed', finished_at: ctx.now }); continue; }
      // E41: the account's machine was retired and the account was not moved to another one.
      const retired = locate(ctx, 'connector_device', job.device_id)?.status === 'revoked';
      addEvent(ctx, job, 'missed_unclaimed', { reason: job.media_pending ? 'media_unavailable' : retired ? 'machine_retired' : 'unclaimed' });
      setJob(ctx, job, { status: 'missed', finished_at: ctx.now });
      continue;
    }
    // WE-2 safety net: a job being released that no machine ever claimed has nobody to release it.
    if (status === 'releasing' && neverClaimed(job)) {
      addEvent(ctx, job, 'cancelled_unclaimed', { via: 'lifecycle', reason: (job.revoke as Data | null)?.reason ?? null });
      setJob(ctx, job, { status: revokedStatus(job), finished_at: ctx.now, blocker: null });
      continue;
    }
    // A login check being withdrawn (its account moved machines) ends once its window has passed.
    if (job.kind === 'check_login' && status === 'releasing' && at > notAfter) {
      addEvent(ctx, job, 'lease_expired', { via: 'lifecycle', reason: (job.revoke as Data | null)?.reason ?? null });
      setJob(ctx, job, { status: revokedStatus(job), finished_at: ctx.now, blocker: null });
      continue;
    }
    // 6: a check_login lease that expired without login_state is queued once more, then failed (§5.12).
    if (job.kind === 'check_login' && ['claimed', 'ready', 'needs_owner'].includes(status) && Number.isFinite(time(job.lease_expires_at)) && at > time(job.lease_expires_at)) {
      if (job.requeued_at) { addEvent(ctx, job, 'unreported', { kind: 'check_login' }); setJob(ctx, job, { status: 'failed', finished_at: ctx.now }); }
      else {
        addEvent(ctx, job, 'requeued', { reason: 'lease_expired' });
        setJob(ctx, job, { status: 'queued', requeued_at: ctx.now, not_before: ctx.now, not_after: new Date(at + 10 * 60_000).toISOString(), lease_expires_at: null, blocker: null });
      }
      continue;
    }
    if (job.kind === 'check_login') continue;
    // 3: claimed but never started, well past the window.
    if (['claimed', 'ready', 'needs_owner', 'releasing'].includes(status) && !job.started_at && at > notAfter + timing.unreportedGraceMs) {
      if (provablyNotRun(ctx, job)) {
        addEvent(ctx, job, 'missed_machine_off', { reason: 'machine_off', previous_status: status });
        setJob(ctx, job, { status: status === 'releasing' ? revokedStatus(job) : 'missed', finished_at: ctx.now });
      } else {
        addEvent(ctx, job, 'unreported', { previous_status: status });
        setJob(ctx, job, { status: 'unreported' });
      }
      continue;
    }
    // 4: running without a submitting report, well past the window — also a started job the Worker re-prepared after a resume
    // (back to claimed/ready) or that is being revoked (WE-4): nothing else would ever end it.
    if ((status === 'running' || (['claimed', 'ready', 'needs_owner', 'releasing'].includes(status) && job.started_at)) && !job.submitting_at &&
      at > notAfter + timing.unreportedGraceMs) {
      addEvent(ctx, job, 'unreported', { previous_status: status });
      setJob(ctx, job, { status: 'unreported' });
      continue;
    }
    // 5: submitting/result_pending beyond the read-back guard and the lease.
    if (status === 'submitting' || status === 'result_pending') {
      const since = time(job.submitted_at ?? job.submitting_at);
      const lease = time(job.lease_expires_at);
      const limit = Math.max(Number.isFinite(lease) ? lease : 0, (Number.isFinite(since) ? since : at) + timing.resultPendingGuardMs);
      if (at > limit) {
        addEvent(ctx, job, 'result_pending_timeout', { since: job.submitted_at ?? job.submitting_at ?? null });
        setJob(ctx, job, { status: 'outcome_unknown', blocker: fullBlocker(ctx, job, { code: 'platform_error', phase: 'after_submit', message: '', at: ctx.now }) });
      }
      continue;
    }
    // 7: media still missing when the final prepare is due. While the upload is still arriving (WE-8: Codex posts a video
    // "now" while the relay is still sending it), the job waits instead: it is parked, and the owner alerted, only once the
    // deadline is near — UPLOAD_PARK_BEFORE_DEADLINE_MS before not_after, never before not_before.
    if (status !== 'queued' || job.media_pending !== true) continue;
    const parkAt = uploadInProgress(ctx, job) ? Math.max(notBefore, notAfter - UPLOAD_PARK_BEFORE_DEADLINE_MS)
      : notBefore - Number(job.prepare_lead_min ?? timing.prepareLeadMin) * 60_000;
    if (at >= parkAt) {
      addEvent(ctx, job, 'media_unavailable', {});
      setJob(ctx, job, { status: 'needs_owner', blocker: fullBlocker(ctx, job, { code: 'media_unavailable', phase: 'prepare', message: '', at: ctx.now }) });
    }
  }
  // 8: successors of predecessors that ended (or turned outcome_unknown) since the last pass.
  scanSuccessors(ctx);
  // 9: daily purge of the timeline of jobs that ended more than 90 days ago.
  if (at - (lastPurge.get(ctx.workspaceId) ?? 0) >= 86_400_000) {
    lastPurge.set(ctx.workspaceId, at);
    const old = new Set(jobs(ctx).filter(job => isTerminal(job) && Number.isFinite(time(job.finished_at ?? job.updated_at)) &&
      at - time(job.finished_at ?? job.updated_at) > RETAIN_EVENTS_MS).map(job => job.id));
    if (old.size) for (const event of ctx.list(EVENT).filter(row => old.has(String(row.job_id)))) ctx.remove(EVENT, event.id);
  }
}

/** §5.13: added to createPublishHost().drain (every 5 s), throttled here to one pass per workspace every 15 s. */
export async function runWorkerLifecycle(transact: <T>(run: (ctx: Context) => T | Promise<T>) => Promise<T>, force = false) {
  await transact(ctx => {
    const at = Date.now();
    if (!force && at - (lastRun.get(ctx.workspaceId) ?? 0) < LIFECYCLE_EVERY_MS) return;
    lastRun.set(ctx.workspaceId, at);
    workerLifecycle(ctx);
  });
}

export { JOB };
