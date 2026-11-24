import { ADMIN, OWNER_RESUME_BLOCKERS, Problem, hubSawStart, type Blocker, type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';
import { requireHuman } from '../../agent-actor.js';
import { alertHandleChanged } from '../alerts/index.js';
import { ATTEMPT, endAttempt } from '../execution/service.js';
import { resubmitIfWaiting, updateTarget } from '../planning/index.js';
import { createDryRunJob, refreshPendingMedia } from './dispatch.js';
import './engine.js';
import { JOB, addEvent, bumpSyncGeneration, latestJobForTarget, locate, machineName, now, setJob, str, time } from './model.js';
import { retireMachine, retireOperation } from './retire.js';
import { externalIdFromUrl } from './sync.js';

/**
 * Worker job engine (phase1-design §5, S3). C3 exports for other streams; the device protocol lives in device-jobs.ts,
 * the lifecycle scan in lifecycle.ts (run from createPublishHost().drain), the signed file routes in device-http.ts.
 */
export { createCheckLoginJob, dispatchWorkerJob, isWorkerRoute, buildPublishPayload } from './dispatch.js';
export { requestRevoke, revokeForTarget, moveQueuedChannelJobs, blocksMachineMove, ACTIVE_JOB_STATUSES } from './revoke.js';
export { retireMachine } from './retire.js';
export { latestJobForTarget, bumpSyncGeneration, deviceSyncState, configureWorkerHost, JOB, EVENT } from './model.js';
export { isMachineOnline, machinePresence } from './presence.js';
export { syncTaskFromJob } from './sync.js';
export { runWorkerLifecycle, workerLifecycle } from './lifecycle.js';
export { MemoryNonceStore, configureDeviceNonces } from './nonces.js';

const invalid = (path: string, message: string) => new Problem(422, 'INVALID_ARGUMENTS', message, { issues: [{ path, message }] });
function only(body: Data, allowed: string[]) {
  const extra = Object.keys(body).find(key => !allowed.includes(key));
  if (extra) throw invalid(extra, `Unknown field ${extra}. Allowed: ${allowed.join(', ') || 'none'}`);
}
const postJob = (ctx: Context, postId: string) => {
  const target = ctx.get('publish_target', postId);
  const job = latestJobForTarget(ctx, target.id);
  if (!job) throw new Problem(409, 'JOB_NOT_FOUND', '這則貼文沒有 Worker 工作');
  return { target, job };
};

/** §5.8 exit 2: the URL must be the account's own post on that platform. */
export function confirmedPost(ctx: Context, job: Row, raw: unknown): { url: string; external_post_id: string; handle_seen: string | null } {
  if (typeof raw !== 'string' || raw.length > 2048) throw invalid('url', '請貼上貼文網址');
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw invalid('url', '這不是有效的網址'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw invalid('url', '請貼上 https 的貼文網址');
  const account = ctx.get('social_account', String(job.social_account_id));
  url.hash = '';
  url.search = '';
  if (account.provider === 'x') {
    if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com', 'mobile.x.com', 'mobile.twitter.com'].includes(url.hostname)) throw invalid('url', '這不是 X 的網址');
    const own = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:\/.*)?$/.exec(url.pathname);
    const anonymous = /^\/i\/(?:web\/)?status\/(\d{1,25})(?:\/.*)?$/.exec(url.pathname);
    if (own && own[1].toLowerCase() !== String(account.handle ?? account.external_account_id ?? '').toLowerCase()) throw invalid('url', `這則貼文不是 @${account.handle ?? account.external_account_id} 發的`);
    const id = own?.[2] ?? anonymous?.[1];
    if (!id) throw invalid('url', '網址裡找不到貼文編號（/status/…）');
    return { url: `https://x.com/${own ? own[1] : 'i'}/status/${id}`, external_post_id: id, handle_seen: own?.[1]?.toLowerCase() ?? null };
  }
  if (account.provider === 'tiktok') {
    if (!['www.tiktok.com', 'tiktok.com', 'm.tiktok.com'].includes(url.hostname)) throw invalid('url', '這不是 TikTok 的網址');
    const match = /^\/(?:@([A-Za-z0-9_.]{1,64})\/)?video\/(\d{1,25})(?:\/.*)?$/.exec(url.pathname);
    if (!match) throw invalid('url', '網址裡找不到影片編號（/video/…）');
    return { url: `https://www.tiktok.com${url.pathname}`, external_post_id: match[2], handle_seen: match[1]?.toLowerCase() ?? null };
  }
  throw invalid('url', '這個平台在第 1 階段沒有 Worker 發布');
}

function confirmResult(ctx: Context, { params, body }: Input) {
  requireHuman(ctx, 'hub_posts_confirm_result');
  only(body, ['url']);
  const { job } = postJob(ctx, params.id);
  const started = !!job.started_at;
  if (!['outcome_unknown', 'unreported', 'result_pending', 'submitting'].includes(String(job.status)) && !(started && ['needs_owner', 'releasing', 'running'].includes(String(job.status)))) {
    throw new Problem(409, job.status === 'succeeded' ? 'POST_FINAL' : 'JOB_INVALID_STATE', job.status === 'succeeded' ? 'Final. Use post_schedule to post again.' : '這則貼文目前不需要確認結果');
  }
  const post = confirmedPost(ctx, job, body.url);
  const account = ctx.get('social_account', String(job.social_account_id));
  if (post.handle_seen && account.provider === 'tiktok' && account.handle && post.handle_seen !== account.handle) {
    addEvent(ctx, job, 'handle_changed', { from: account.handle, to: post.handle_seen, via: 'owner_confirmed' }, { actor: 'human' });
    ctx.update('social_account', account.id, { handle: post.handle_seen });
    alertHandleChanged(ctx, { social_account_id: account.id, from: String(account.handle), to: post.handle_seen, machine_id: typeof job.device_id === 'string' ? job.device_id : null, job_id: job.id });
  }
  addEvent(ctx, job, 'owner_confirmed', { url: post.url, external_post_id: post.external_post_id, previous_status: job.status }, { actor: 'human' });
  const next = setJob(ctx, job, {
    status: 'succeeded', owner_confirmed: true, finished_at: ctx.now, blocker: null, submitted_by: job.submitted_by ?? (job.mode === 'assist' ? 'owner' : 'auto'),
    result: { url: post.url, external_post_id: post.external_post_id, published_at: ctx.now, evidence_sha256: [], late_by_sec: 0 },
  });
  return { job_id: next.id, status: next.status, url: post.url, platform_post_id: locate(ctx, 'publish_target', params.id)?.platform_post_id ?? null };
}

function markNotPublished(ctx: Context, { params, body }: Input) {
  requireHuman(ctx, 'hub_posts_mark_not_published');
  only(body, ['confirm', 'note']);
  if (body.confirm !== true) throw invalid('confirm', '請確認這則貼文沒有發出（confirm: true）');
  if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 500)) throw invalid('note', '備註最多 500 字');
  const { job } = postJob(ctx, params.id);
  if (!['outcome_unknown', 'unreported'].includes(String(job.status))) throw new Problem(409, 'JOB_INVALID_STATE', '只有結果不明的貼文需要標記為沒有發出');
  addEvent(ctx, job, 'owner_marked_not_published', { previous_status: job.status, note: body.note ?? null }, { actor: 'human' });
  const next = setJob(ctx, job, { status: 'failed', owner_marked_not_published: true, finished_at: ctx.now, blocker: null });
  return { job_id: next.id, status: next.status, task_status: locate(ctx, 'execution_task', job.execution_task_id)?.status ?? null };
}

function retryPost(ctx: Context, { params, body }: Input) {
  requireHuman(ctx, 'hub_posts_retry');
  only(body, []);
  const { target, job } = postJob(ctx, params.id);
  const blocker = job.blocker as Blocker | null;
  // §5.11 rule 2: only a post blocked while preparing, before it ever started (the owner may click on the machine otherwise).
  if (job.status !== 'needs_owner' || blocker?.phase !== 'prepare' || job.started_at) {
    throw new Problem(409, 'RETRY_NOT_ALLOWED', 'Retry is only for a post blocked before it started. Use post_update reschedule for missed or failed posts.');
  }
  const updated = updateTarget(ctx, target, { scheduled_at: ctx.now }, true);
  if (!updated.approval_retained) resubmitIfWaiting(ctx, target.id);
  const fresh = latestJobForTarget(ctx, target.id);
  if (fresh && fresh.id !== job.id) ctx.update(JOB, fresh.id, { retry_of_job_id: job.id });
  const current = locate(ctx, 'publish_target', target.id)!;
  return { post_id: target.id, job_id: fresh?.id ?? null, previous_job_id: job.id, plan_status: current.plan_status, approval_retained: updated.approval_retained };
}

function resumeJob(ctx: Context, { params, body }: Input) {
  requireHuman(ctx, 'hub_jobs_resume');
  only(body, []);
  const job = ctx.get(JOB, params.id);
  const blocker = job.blocker as Blocker | null;
  if (job.status !== 'needs_owner' || !blocker || !OWNER_RESUME_BLOCKERS.includes(blocker.code)) {
    throw new Problem(409, 'RESUME_NOT_ALLOWED', '只有停下來等你看過的問題（風控提示、平台錯誤、頁面改版、文字被拒、確認對話框）可以按「恢復」');
  }
  if (now(ctx) >= time(job.not_after)) throw new Problem(409, 'RESUME_NOT_ALLOWED', '已超過遲到上限，請改到別的時間');
  const token = Number(job.resume_token ?? 0) + 1;
  addEvent(ctx, job, 'owner_resumed', { blocker_code: blocker.code, resume_token: token }, { actor: 'human' });
  const next = setJob(ctx, job, { blocker: null, resume_token: token });
  bumpSyncGeneration(ctx, [String(job.device_id)], 'job_resumed');
  return { job_id: next.id, status: next.status, resume_token: token };
}

export const forceReleaseText = (machine: string) => `我確認 ${machine} 已關機或已斷網，不會發出這則貼文。`;
/** E36 owner copy for 409 POSSIBLY_SENT. */
export const POSSIBLY_SENT_TEXT = '這則可能已經發出，請先到平台確認：有就貼上網址，沒有就按「確認沒有發出」';

function forceRelease(ctx: Context, { params, body }: Input) {
  requireHuman(ctx, 'hub_jobs_force_release');
  only(body, ['confirm_text']);
  const job = ctx.get(JOB, params.id);
  if (!['releasing', 'unreported'].includes(String(job.status))) throw new Problem(409, 'JOB_INVALID_STATE', '只有「取消中」或「未回報」的工作可以強制釋放');
  // E36: the hub knows this job may already have posted (go, started or submitting recorded). Releasing it would turn an unknown
  // result into "not published" and invite a second post; the owner checks the platform instead (§5.8 exits 2 and 3).
  if (hubSawStart(job)) {
    throw new Problem(409, 'POSSIBLY_SENT', POSSIBLY_SENT_TEXT, { job_id: job.id, post_id: job.publish_target_id ?? null, use: ['hub_posts_confirm_result', 'hub_posts_mark_not_published'] });
  }
  const expected = forceReleaseText(machineName(ctx, job.device_id));
  if (typeof body.confirm_text !== 'string' || body.confirm_text.trim() !== expected) {
    throw new Problem(422, 'CONFIRM_TEXT_MISMATCH', `請輸入：${expected}`, { expected });
  }
  // The owner takes the risk that the machine does not post (§12.1 risk 7); a later fact is still accepted and alerted.
  const attempt = locate(ctx, ATTEMPT, job.attempt_id);
  if (attempt && ['in_progress', 'unknown'].includes(String(attempt.status))) endAttempt(ctx, attempt, 'failed', { side_effect_possible: false, outcome_checked_at: ctx.now, error_class: 'force_released' });
  addEvent(ctx, job, 'force_released', { previous_status: job.status }, { actor: 'human' });
  const next = setJob(ctx, job, { status: 'cancelled', force_released: true, finished_at: ctx.now, blocker: null });
  bumpSyncGeneration(ctx, [String(job.device_id)], 'job_force_released');
  return { job_id: next.id, status: next.status };
}

function dryRun(ctx: Context, { params, body }: Input) {
  requireHuman(ctx, 'hub_channels_dry_run');
  only(body, ['media_id', 'caption']);
  if (body.media_id !== undefined && (typeof body.media_id !== 'string' || !body.media_id)) throw invalid('media_id', 'media_id 需為素材 ID');
  if (body.caption !== undefined && (typeof body.caption !== 'string' || body.caption.length > 2200)) throw invalid('caption', '文案最多 2200 字');
  const job = createDryRunJob(ctx, params.id, { media_id: str(body.media_id), caption: str(body.caption) });
  return { job_id: job.id, status: job.status, dry_run: true, not_after: job.not_after, machine_id: job.device_id };
}

/** §5.14 human operations, registered under their full hub_* names so HUMAN_ONLY matches them (§4.6). */
export const operations: Operation[] = [
  { method: 'POST', path: '/hub/posts/:id/confirm-result', name: 'hub_posts_confirm_result', roles: ADMIN,
    summary: 'Confirm that a post with an unknown result was published, by its URL (person only)', run: confirmResult },
  { method: 'POST', path: '/hub/posts/:id/mark-not-published', name: 'hub_posts_mark_not_published', roles: ADMIN,
    summary: 'Confirm that a post with an unknown result was not published, so it can be rescheduled (person only)', run: markNotPublished },
  { method: 'POST', path: '/hub/posts/:id/retry', name: 'hub_posts_retry', roles: ADMIN,
    summary: 'Retry now a post that was blocked while preparing and never started (person only)', run: retryPost },
  { method: 'POST', path: '/hub/jobs/:id/resume', name: 'hub_jobs_resume', roles: ADMIN,
    summary: 'Resume a Worker job that stopped for the owner to look at (person only)', run: resumeJob },
  { method: 'POST', path: '/hub/jobs/:id/force-release', name: 'hub_jobs_force_release', roles: ADMIN,
    summary: 'Release a job whose machine is off, after the owner confirms it will not post (person only)', run: forceRelease },
  { method: 'POST', path: '/hub/channels/:id/dry-run', name: 'hub_channels_dry_run', roles: ADMIN,
    summary: 'Run the Worker up to the Post button without posting (person only)', run: dryRun },
  // E41 (COH-3): the web's machine page 「撤銷這台機器」.
  { ...retireOperation, roles: ADMIN, run: (ctx, { params, body }) => retireMachine(ctx, params.id!, body) },
];

/** §5.2: media that finished uploading clears media_pending on the jobs waiting for it. */
export const subscribers = [{
  id: 'worker.media',
  accepts: (type: string) => type === 'asset.version.created' || type === 'media.upload.ready',
  run(ctx: Context, _event?: Data) { refreshPendingMedia(ctx); },
}];

/** Kept for the scheduler fallback: the drain (createPublishHost) runs the lifecycle every 15 s; this covers hosts without it. */
export { externalIdFromUrl };
