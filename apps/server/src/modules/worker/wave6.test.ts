// Wave 6 job-engine findings (G1-engine): each test reproduces one finding from the review and pins the fix.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Problem, Row } from '@smartsell/contracts';
import { cancel, updateTarget } from '../planning/index.js';
import { postStatus as agentPostStatus } from '../posting/model.js';
import { canForceRelease, missedReason, postStatus } from '../workspace/views/hub-model.js';
import { hubFixture, type HubFixture } from './fixtures.js';
import { createCheckLoginJob } from './dispatch.js';
import { POSSIBLY_SENT_TEXT, forceReleaseText } from './index.js';
import { UPLOAD_PARK_BEFORE_DEADLINE_MS } from './lifecycle.js';
import { JOB, syncGeneration } from './model.js';
import { moveQueuedChannelJobs } from './revoke.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const code = (expected: string) => (error: unknown) => { assert.equal((error as Problem).code, expected); return true; };
const agent = { role: 'owner' as const, agentCredentialId: 'agent-credential' };
const alertKinds = (f: HubFixture, from = 0) => f.ctx.list('owner_alert').slice(from).map(row => String(row.kind));
const attempts = (f: HubFixture, targetId: string) => f.ctx.list('execution_attempt').filter(row => row.task_id === f.task(targetId).id).map(row => String(row.status));
const target = (f: HubFixture, id: string) => f.ctx.get('publish_target', id);
const URL_X = 'https://x.com/lurelab/status/1861234567890123456';

async function pendingMediaPost(f: HubFixture, offsetMs: number, session = 'receiving') {
  const asset = f.ctx.create('asset', { kind: 'video', brand_id: null, ownership: 'owned', origin: 'agent_upload', status: 'uploading', title: 'big.mp4' });
  const version = f.ctx.create('asset_version', { asset_id: asset.id, file_object_id: null, sha256: 'c'.repeat(64), mime_type: 'video/mp4', meta: null });
  f.ctx.update('asset', asset.id, { current_version_id: version.id });
  f.ctx.create('media_upload_session', { media_id: asset.id, bytes: 30_000_000, filename: 'big.mp4', status: session });
  const clip = await f.variant('Big upload', [{ asset_id: asset.id, asset_version_id: version.id, role: 'primary' }]);
  const created = f.run('publishing_create_target', { social_account_id: f.account.id, content_variant_id: clip.id, late_policy: 'skip', grace_minutes: 30,
    scheduled_at: iso(Date.parse(f.ctx.now) + offsetMs) }) as Row;
  f.run('publishing_request_approval', {}, { id: created.id });
  return target(f, created.id);
}

// ---------- WE-1 ----------

test('WE-1: an owner-confirmed post stays published when the offline machine later flushes started/submitting/submitted/outcome_unknown', async () => {
  const f = hubFixture();
  const post = await f.schedule(HOUR);
  const job = f.jobOf(post.id);
  f.prepare(job.id);
  f.at('2027-01-01T10:58:00.000Z');
  f.heartbeat([job.id]);
  f.at(iso(Date.parse(String(job.not_after)) + 11 * MIN));
  f.lifecycle();
  assert.equal(f.job(job.id).status, 'unreported');
  f.run('hub_posts_confirm_result', { url: URL_X }, { id: post.id });
  assert.deepEqual([f.job(job.id).status, f.task(post.id).status, attempts(f, post.id)], ['succeeded', 'published', ['verified_published']]);
  const before = f.ctx.list('owner_alert').length;
  f.report(job.id, 'started', { go: 'offline', mode: 'auto' });
  f.report(job.id, 'submitting');
  f.report(job.id, 'submitted', {});
  f.report(job.id, 'outcome_unknown', { reason: 'readback_exhausted', evidence_sha256: [] });
  assert.equal(f.job(job.id).status, 'succeeded', 'the confirmed job keeps its result');
  assert.equal(f.task(post.id).status, 'published');
  assert.deepEqual(attempts(f, post.id), ['verified_published']);
  assert.equal(postStatus(f.ctx, target(f, post.id)), 'published');
  assert.deepEqual(alertKinds(f, before).filter(kind => kind === 'unknown' || kind === 'late_fact_after_release'), [], 'no false urgent alert');
  assert.ok(!f.timeline(job.id).includes('late_fact_after_release'));
  const recorded = f.ctx.list('worker_job_event').filter(row => row.job_id === job.id && row.event === 'outcome_unknown').at(-1)!;
  assert.deepEqual([(recorded.detail as Row).applied, (recorded.detail as Row).terminal, recorded.fence_override], [false, 'succeeded', true]);
});

test('WE-1: a result the Worker reads back after the owner confirmed keeps the confirmed URL; a different post id is noted on the event', async () => {
  const f = hubFixture();
  const post = await f.schedule(HOUR);
  const job = f.jobOf(post.id);
  f.prepare(job.id);
  f.at(String(job.not_before));
  f.go(job.id);
  f.report(job.id, 'started', { go: 'hub', mode: 'auto' });
  f.report(job.id, 'submitting');
  f.report(job.id, 'submitted', {});
  f.run('hub_posts_confirm_result', { url: URL_X }, { id: post.id });
  const before = f.ctx.list('owner_alert').length;
  f.report(job.id, 'result', f.resultData('1861234567890123999'));
  assert.equal(f.job(job.id).status, 'succeeded');
  assert.equal((f.job(job.id).result as Row).url, URL_X);
  assert.equal(f.task(post.id).status, 'published');
  assert.deepEqual(alertKinds(f, before), []);
  const event = f.ctx.list('worker_job_event').filter(row => row.job_id === job.id && row.event === 'result').at(-1)!;
  assert.equal((event.detail as Row).different_post, true);
});

test('WE-1: a late fact from an older released job never moves a published task back to outcome_unknown', async () => {
  const f = hubFixture();
  const post = await f.schedule(2 * HOUR);
  const old = f.jobOf(post.id);
  f.prepare(old.id);
  updateTarget(f.ctx, target(f, post.id), { scheduled_at: iso(Date.parse(String(post.scheduled_at)) + 10 * MIN) }, true);
  const next = f.jobOf(post.id);
  assert.notEqual(next.id, old.id);
  f.heartbeat([], { released_jobs: [old.id] });
  assert.equal(f.job(old.id).status, 'superseded');
  f.publishNow(next.id);
  assert.equal(f.task(post.id).status, 'published');
  f.report(old.id, 'submitting', {}, { fence: 1 });
  assert.equal(f.job(old.id).status, 'outcome_unknown', 'the late fact is kept on the old job');
  assert.ok(f.ctx.list('owner_alert').some(row => row.kind === 'late_fact_after_release'), 'and the owner is told');
  assert.equal(f.task(post.id).status, 'published', 'the published task stays published');
  assert.equal(target(f, post.id).worker_job_id, next.id, 'the post keeps following the job that published it');
  assert.equal(postStatus(f.ctx, target(f, post.id)), 'published');
});

// ---------- WE-2 ----------

test('WE-2: a parked media job no machine ever claimed is cancelled at once, and a retry does not wait on it', async () => {
  for (const action of ['cancel', 'retry'] as const) {
    const f = hubFixture();
    const post = await pendingMediaPost(f, HOUR, 'failed');
    const job = f.jobOf(post.id);
    f.at(iso(Date.parse(String(job.not_before)) - 29 * MIN));
    f.heartbeat([]);
    f.claim([]);
    f.lifecycle();
    assert.deepEqual([f.job(job.id).status, (f.job(job.id).blocker as Row).code, f.job(job.id).claimed_at ?? null], ['needs_owner', 'media_unavailable', null]);
    if (action === 'cancel') {
      cancel(f.ctx, target(f, post.id));
      assert.equal(f.job(job.id).status, 'cancelled', 'no machine holds it, so nobody has to release it');
      assert.equal(f.task(post.id).status, 'cancelled');
      assert.equal(target(f, post.id).plan_status, 'cancelled');
    } else {
      f.run('hub_posts_retry', {}, { id: post.id });
      assert.equal(f.job(job.id).status, 'superseded');
      const fresh = f.jobOf(post.id);
      assert.notEqual(fresh.id, job.id);
      assert.equal(fresh.waits_for_job_id ?? null, null, 'the new job does not wait on a job that can never be released');
    }
    // Until well past the window, with the machine online the whole time: nothing turns unreported.
    const end = Date.parse(String(job.not_after)) + 11 * MIN;
    while (Date.parse(f.ctx.now) < end) { f.advance(5 * MIN); f.heartbeat([]); f.claim([]); f.lifecycle(); }
    assert.notEqual(f.job(job.id).status, 'unreported');
    assert.ok(!f.ctx.list('owner_alert').some(row => row.kind === 'unknown'), 'no 未回報 alert for a post that never ran');
  }
});

test('WE-2 safety net: a releasing job that no machine ever claimed is settled by the lifecycle', async () => {
  const f = hubFixture();
  const post = await f.schedule(HOUR);
  const job = f.jobOf(post.id);
  // A row written before the fix: releasing although never claimed.
  f.ctx.update(JOB, job.id, { status: 'releasing', revoke: { reason: 'cancelled', requested_at: f.ctx.now } });
  f.lifecycle();
  assert.equal(f.job(job.id).status, 'cancelled');
});

// ---------- WE-3 / WE-10 ----------

test('WE-3: go on a job cancelled moments before not_before answers revoked + release, and the release completes the cancel', async () => {
  const f = hubFixture();
  const post = await f.schedule(HOUR);
  const job = f.jobOf(post.id);
  f.prepare(job.id);
  f.at(iso(Date.parse(String(job.not_before)) - 5000));
  f.heartbeat([job.id]);
  cancel(f.ctx, target(f, post.id));
  assert.deepEqual([f.job(job.id).status, f.task(post.id).status], ['releasing', 'cancel_pending']);
  f.at(String(job.not_before));
  assert.deepEqual(f.go(job.id), { go: false, reason: 'revoked', release: true });
  f.report(job.id, 'released', {});
  assert.deepEqual([f.job(job.id).status, f.task(post.id).status, target(f, post.id).plan_status], ['cancelled', 'cancelled', 'cancelled']);
});

test('WE-3: a go answered too_late ends the job as missed on the hub (the Worker never runs it after that answer)', async () => {
  const f = hubFixture();
  const post = await f.schedule(HOUR);
  const job = f.jobOf(post.id);
  f.prepare(job.id);
  f.at(iso(Date.parse(String(job.not_after)) + 1000));
  assert.deepEqual(f.go(job.id), { go: false, reason: 'too_late', release: false });
  assert.equal(f.job(job.id).status, 'missed');
  assert.equal(postStatus(f.ctx, target(f, post.id)), 'missed');
  assert.equal(missedReason(f.ctx, target(f, post.id), f.job(job.id), 'missed'), 'late');
  f.at(iso(Date.parse(String(job.not_after)) + 20 * MIN));
  f.lifecycle();
  assert.equal(f.job(job.id).status, 'missed', 'never unreported');
});

test('WE-10: a resent go for a running job is refused once the hub knows of a cancel, a pause or a lost approval', async () => {
  const f = hubFixture();
  const post = await f.schedule(HOUR);
  const job = f.jobOf(post.id);
  f.prepare(job.id);
  f.at(String(job.not_before));
  assert.equal(f.go(job.id).go, true);
  f.advance(2000);
  const paused = f.run('publishing_pause', { scope_type: 'social_account', scope_id: f.account.id, reason: 'hold' }) as Row;
  assert.deepEqual(f.go(job.id), { go: false, reason: 'paused', release: false });
  f.run('publishing_release_pause', {}, { id: paused.id });
  assert.equal(f.go(job.id).go, true, 'the lost answer is still given again when nothing changed');
  cancel(f.ctx, target(f, post.id));
  assert.deepEqual([f.job(job.id).status, (f.job(job.id).revoke as Row).reason], ['running', 'cancelled']);
  f.advance(3000);
  assert.deepEqual(f.go(job.id), { go: false, reason: 'revoked', release: true });
  f.report(job.id, 'released', {});
  assert.equal(f.job(job.id).status, 'cancelled');
});

// ---------- WE-4 ----------

test('WE-4: a started job the Worker re-prepared after a resume is reported unreported past its window, so the owner has an exit', async () => {
  const f = hubFixture();
  const post = await f.schedule(HOUR);
  const job = f.jobOf(post.id);
  f.prepare(job.id);
  f.at(String(job.not_before));
  f.go(job.id);
  f.report(job.id, 'started', { go: 'hub', mode: 'auto' });
  f.report(job.id, 'blocked', { blocker: { code: 'risk_prompt', phase: 'before_submit', message: '', at: f.ctx.now } });
  f.run('hub_jobs_resume', {}, { id: job.id });
  f.report(job.id, 'prepared', { stage: 'final', login: 'verified', identity: 'lurelab', handle: 'lurelab', media_ok: true, driver: { provider: 'x', version: 'x@1' } });
  assert.equal(f.job(job.id).status, 'ready');
  // The machine dies for good before go.
  f.at(iso(Date.parse(String(job.not_after)) + 11 * MIN));
  f.lifecycle();
  assert.equal(f.job(job.id).status, 'unreported');
  assert.equal(postStatus(f.ctx, target(f, post.id)), 'unknown');
  assert.throws(() => f.run('hub_jobs_force_release', { confirm_text: forceReleaseText('Mac-B') }, { id: job.id }), code('POSSIBLY_SENT'), 'it started: E36');
  f.run('hub_posts_mark_not_published', { confirm: true }, { id: post.id });
  assert.equal(f.job(job.id).status, 'failed');
  assert.equal(postStatus(f.ctx, target(f, post.id)), 'failed');
});

// ---------- WE-5 ----------

test('WE-5: a login check that found the account signed out ends; it is not re-issued, 重新登入 starts a fresh window check and the account can move', async () => {
  const f = hubFixture();
  const check = createCheckLoginJob(f.ctx, f.account.id, { openLoginWindow: false });
  f.heartbeat([]);
  f.claim([]);
  f.report(check.id, 'login_state', { state: 'login_required', identity: null, handle: null, evidence_sha256: [] });
  const ended = f.job(check.id);
  assert.equal(ended.status, 'failed');
  assert.equal((ended.blocker as Row).code, 'login_expired');
  assert.equal((ended.result as Row).login_state, 'login_required');
  assert.equal(f.ctx.list('browser_session')[0].status, 'login_required');
  assert.ok(f.ctx.list('owner_alert').some(row => row.kind === 'login_check_failed'));
  for (let i = 0; i < 8; i++) {
    f.advance(15_000);
    assert.equal(f.heartbeat([]).claimable, 0);
    assert.deepEqual(f.claim([]).jobs, []);
  }
  assert.equal(f.job(check.id).fencing_token, 1, 'never re-issued');
  const again = createCheckLoginJob(f.ctx, f.account.id, { openLoginWindow: true });
  assert.notEqual(again.id, check.id);
  assert.equal((again.payload as Row).open_login_window, true);
  f.claim([]);
  f.report(again.id, 'login_state', { state: 'verified', identity: 'lurelab', handle: 'lurelab', evidence_sha256: [] });
  assert.deepEqual(moveQueuedChannelJobs(f.ctx, f.account.id, f.other.id), { moved: 0 });
});

test('WE-5: a login check blocked by a captcha ends; one waiting for Chrome stays with the machine and 重新登入 replaces it', async () => {
  const f = hubFixture();
  const check = createCheckLoginJob(f.ctx, f.account.id, { openLoginWindow: false });
  f.claim([]);
  f.report(check.id, 'prepare_blocked', { stage: 'preflight', blocker: { code: 'captcha', phase: 'prepare', message: '', at: f.ctx.now } });
  assert.equal(f.job(check.id).status, 'failed');
  const g = hubFixture();
  const waiting = createCheckLoginJob(g.ctx, g.account.id, { openLoginWindow: false });
  g.claim([]);
  g.report(waiting.id, 'prepare_blocked', { stage: 'preflight', blocker: { code: 'chrome_unavailable', phase: 'prepare', message: '', at: g.ctx.now } });
  assert.equal(g.job(waiting.id).status, 'needs_owner', 'the Worker keeps retrying Chrome');
  assert.equal(g.heartbeat([]).claimable, 0, 'a needs_owner check is not re-issued when the machine stops listing it');
  const fresh = createCheckLoginJob(g.ctx, g.account.id, { openLoginWindow: true });
  assert.notEqual(fresh.id, waiting.id);
  assert.equal((fresh.payload as Row).open_login_window, true);
  assert.deepEqual([g.job(waiting.id).status, (g.job(waiting.id).revoke as Row).reason], ['releasing', 'superseded']);
  // A withdrawn check whose machine never lets go ends after its window; it never blocks a machine change.
  assert.deepEqual(moveQueuedChannelJobs(g.ctx, g.account.id, g.other.id), { moved: 0 });
  g.at(iso(Date.parse(String(waiting.not_after)) + 1000));
  g.lifecycle();
  assert.equal(g.job(waiting.id).status, 'superseded');
});

// ---------- WE-7 / F7 (E38) ----------

test('WE-7/F7 (E38): a go a moment before not_before is judged at not_before for the window and the daily cap', async () => {
  const f = hubFixture();
  f.ctx.update('channel_settings', f.settings().id, { window: { start: '11:00', end: '21:00', days: [1, 2, 3, 4, 5, 6, 7] } });
  const post = await f.schedule('2027-01-01T11:00:00.000Z');
  const job = f.jobOf(post.id);
  f.prepare(job.id);
  f.at('2027-01-01T10:59:59.950Z');
  assert.equal(f.go(job.id).go, true);
  assert.equal(f.job(job.id).status, 'running');
  // Daily cap: a post at 00:00 is counted on its own day, not on the day its go arrived.
  const g = hubFixture();
  g.ctx.update('channel_settings', g.settings().id, { daily_cap: 1 });
  const first = await g.schedule('2027-01-01T23:00:00.000Z');
  const second = await g.schedule('2027-01-02T00:00:00.000Z');
  g.at('2027-01-01T23:00:00.000Z');
  g.publishNow(g.jobOf(first.id).id);
  const late = g.jobOf(second.id);
  g.prepare(late.id);
  g.at('2027-01-01T23:59:59.500Z');
  assert.equal(g.go(late.id).go, true);
});

// ---------- WE-8 ----------

test('WE-8: a post due now whose video is still uploading waits; it is parked (with the alert) only near its deadline', async () => {
  const f = hubFixture();
  const post = await pendingMediaPost(f, 0);
  const job = f.jobOf(post.id);
  f.advance(5000);
  f.lifecycle();
  assert.equal(f.job(job.id).status, 'queued');
  assert.ok(!f.ctx.list('owner_alert').some(row => row.kind === 'worker_blocker'), 'no urgent alert while the upload is arriving');
  assert.equal(postStatus(f.ctx, target(f, post.id)), 'scheduled');
  f.at(iso(Date.parse(String(job.not_after)) - UPLOAD_PARK_BEFORE_DEADLINE_MS + 1000));
  f.lifecycle();
  assert.deepEqual([f.job(job.id).status, (f.job(job.id).blocker as Row).code], ['needs_owner', 'media_unavailable']);
  assert.ok(f.ctx.list('owner_alert').some(row => row.kind === 'worker_blocker'));
  // An upload that failed is not waited for: parked at prepare time as before.
  const g = hubFixture();
  const failed = await pendingMediaPost(g, 0, 'failed');
  g.advance(5000);
  g.lifecycle();
  assert.equal(g.jobOf(failed.id).status, 'needs_owner');
});

// ---------- WE-9 ----------

test('WE-9: an offline auto run after a withdrawn risk acknowledgement is flagged although the last heartbeat answer was lost', async () => {
  const f = hubFixture({ provider: 'tiktok' });
  const post = await f.schedule(HOUR);
  const job = f.jobOf(post.id);
  f.prepare(job.id);
  f.at(iso(Date.parse(String(job.not_before)) - 6 * MIN));
  assert.equal(f.heartbeat([job.id]).jobs[0].mode, 'auto');
  f.advance(20_000);
  f.ctx.update('channel_settings', f.settings().id, { risk_ack: null });
  f.advance(5000);
  assert.equal(f.heartbeat([job.id]).jobs[0].mode, 'assist', 'this answer never reaches the Worker');
  f.at(String(job.not_before));
  f.report(job.id, 'started', { go: 'offline', mode: 'auto' });
  assert.ok(f.timeline(job.id).includes('offline_run_used_stale_settings'));
  assert.ok(f.ctx.list('owner_alert').some(row => row.kind === 'offline_run_stale_settings' && row.severity === 'urgent'));
});

// ---------- WV-1 (E36) ----------

test('WV-1 (E36): force_release refuses a job the hub saw start with 409 POSSIBLY_SENT; the post stays unknown with confirm/mark', async () => {
  const f = hubFixture();
  const post = await f.schedule(HOUR);
  const job = f.jobOf(post.id);
  f.prepare(job.id);
  f.at(String(job.not_before));
  f.go(job.id);
  f.report(job.id, 'started', { go: 'hub', mode: 'auto' });
  f.at(iso(Date.parse(String(job.not_after)) + 11 * MIN));
  f.lifecycle();
  assert.equal(f.job(job.id).status, 'unreported');
  assert.equal(canForceRelease(f.job(job.id)), false);
  assert.throws(() => f.run('hub_jobs_force_release', { confirm_text: forceReleaseText('Mac-B') }, { id: job.id }), (error: unknown) => {
    const problem = error as Problem;
    assert.deepEqual([problem.status, problem.code, problem.message], [409, 'POSSIBLY_SENT', POSSIBLY_SENT_TEXT]);
    assert.match(POSSIBLY_SENT_TEXT, /這則可能已經發出，請先到平台確認：有就貼上網址，沒有就按「確認沒有發出」/);
    return true;
  });
  assert.equal(f.job(job.id).status, 'unreported');
  assert.equal(postStatus(f.ctx, target(f, post.id)), 'unknown');
  f.run('hub_posts_confirm_result', { url: URL_X }, { id: post.id });
  assert.equal(postStatus(f.ctx, target(f, post.id)), 'published');
});

test('WV-1 (E36): a release with no start on record is still allowed and is E17\'s missed run; a legacy started release says released_unconfirmed', async () => {
  const f = hubFixture();
  const post = await f.schedule(2 * HOUR);
  const old = f.jobOf(post.id);
  f.claim();
  cancel(f.ctx, target(f, post.id));
  assert.equal(f.job(old.id).status, 'releasing');
  assert.equal(canForceRelease(f.job(old.id)), true);
  f.run('hub_jobs_force_release', { confirm_text: forceReleaseText('Mac-B') }, { id: old.id });
  assert.equal(f.job(old.id).status, 'cancelled');
  const g = hubFixture();
  const gp = await g.schedule(HOUR);
  const unstarted = g.jobOf(gp.id);
  g.claim();
  g.at(iso(Date.parse(String(unstarted.not_after)) + 11 * MIN));
  g.heartbeat();
  g.lifecycle();
  assert.equal(g.job(unstarted.id).status, 'unreported');
  g.run('hub_jobs_force_release', { confirm_text: forceReleaseText('Mac-B') }, { id: unstarted.id });
  assert.equal(postStatus(g.ctx, target(g, gp.id)), 'missed');
  assert.equal(missedReason(g.ctx, target(g, gp.id), g.job(unstarted.id), 'missed'), 'machine_was_off');
  // A row force-released before E36 although it had started.
  g.ctx.update(JOB, unstarted.id, { started_at: g.ctx.now });
  assert.equal(missedReason(g.ctx, target(g, gp.id), g.job(unstarted.id), 'missed'), 'released_unconfirmed');
});

// ---------- F1 (E37) ----------

test('F1 (E37): a rejected post derives rejected for the web and the Agent; a new request ends it', async () => {
  const f = hubFixture({ approval: 'needs_approval' });
  const post = await f.schedule(HOUR);
  assert.equal(postStatus(f.ctx, target(f, post.id)), 'awaiting_approval');
  f.run('publishing_reject', { reason: 'Not this one' }, { id: post.id });
  assert.equal(postStatus(f.ctx, target(f, post.id)), 'rejected');
  assert.equal(agentPostStatus(f.ctx, target(f, post.id)), 'rejected', 'the Agent sees rejected, not draft');
  f.run('publishing_request_approval', {}, { id: post.id });
  assert.equal(postStatus(f.ctx, target(f, post.id)), 'awaiting_approval');
  assert.equal(agentPostStatus(f.ctx, target(f, post.id)), 'awaiting_approval');
});

// ---------- COH-3 (E41) ----------

test('COH-3 (E41): hub_machines_retire is person-only, revokes the machine and settles its jobs without re-posting anything possibly sent', async () => {
  const f = hubFixture();
  const running = await f.schedule(HOUR);
  const held = await f.schedule(2 * HOUR);
  const later = await f.schedule(30 * HOUR);
  const runJob = f.jobOf(running.id);
  f.prepare(runJob.id);   // also claims `held`
  const check = createCheckLoginJob(f.ctx, f.account.id, { openLoginWindow: false });
  f.claim([runJob.id, f.jobOf(held.id).id]);
  f.at(String(runJob.not_before));
  f.go(runJob.id);
  f.report(runJob.id, 'started', { go: 'hub', mode: 'auto' });
  const heldJob = f.job(f.jobOf(held.id).id);
  assert.equal(heldJob.status, 'claimed');
  assert.equal(f.jobOf(later.id).status, 'queued');
  assert.throws(() => f.run('hub_machines_retire', { confirm: true }, { id: f.device.id }, agent), code('HUMAN_REQUIRED'));
  assert.throws(() => f.run('hub_machines_retire', {}, { id: f.device.id }), code('INVALID_ARGUMENTS'));
  const generation = syncGeneration(f.ctx);
  const result = f.run('hub_machines_retire', { confirm: true }, { id: f.device.id }) as Row;
  assert.deepEqual(result.jobs, { waiting_for_machine: 2, ended: 1, to_confirm: 1 });
  assert.deepEqual(result.posts_to_confirm, [running.id]);
  assert.deepEqual((result.channels as Row[]).map(item => item.social_account_id), [f.account.id]);
  assert.equal(f.ctx.get('connector_device', f.device.id).status, 'revoked');
  assert.ok(syncGeneration(f.ctx) > generation);
  // The started post may have gone out: unknown, never re-posted, never force-releasable.
  assert.equal(f.job(runJob.id).status, 'unreported');
  assert.equal(postStatus(f.ctx, target(f, running.id)), 'unknown');
  assert.throws(() => f.run('hub_jobs_force_release', { confirm_text: forceReleaseText('Mac-B') }, { id: runJob.id }), code('POSSIBLY_SENT'));
  // The held but unstarted post went back to the queue; the far one stays queued; the login check ended.
  const requeued = f.job(heldJob.id);
  assert.deepEqual([requeued.status, requeued.claimed_at ?? null, requeued.fencing_token], ['queued', null, Number(heldJob.fencing_token) + 1]);
  assert.equal(f.jobOf(later.id).status, 'queued');
  assert.equal(f.job(check.id).status, 'cancelled');
  // The account needs another machine.
  assert.ok(f.ctx.get('account_execution_binding', f.binding.id).machine_retired_at);
  assert.ok(f.ctx.list('browser_session').every(row => row.status === 'revoked'));
  assert.ok(f.events.some(event => event.type === 'account.binding.changed' && event.payload.machine_retired === true));
  // After the owner settles the unknown post, the queued posts follow the account to its next machine.
  assert.throws(() => moveQueuedChannelJobs(f.ctx, f.account.id, f.other.id), code('CHANNEL_HAS_ACTIVE_JOBS'));
  f.run('hub_posts_mark_not_published', { confirm: true }, { id: running.id });
  assert.deepEqual(moveQueuedChannelJobs(f.ctx, f.account.id, f.other.id), { moved: 2 });
  assert.equal(f.job(heldJob.id).device_id, f.other.id);
  // Cancelling a requeued post ends it at once: no machine holds it.
  cancel(f.ctx, target(f, held.id));
  assert.equal(f.job(heldJob.id).status, 'cancelled');
  // Idempotent.
  assert.equal((f.run('hub_machines_retire', { confirm: true }, { id: f.device.id }) as Row).already_retired, true);
});

test('COH-3 (E41): retiring a machine that pressed Post leaves the result unknown (outcome_unknown) for the owner', async () => {
  const f = hubFixture();
  const post = await f.schedule(HOUR);
  const job = f.jobOf(post.id);
  f.prepare(job.id);
  f.at(String(job.not_before));
  f.go(job.id);
  f.report(job.id, 'started', { go: 'hub', mode: 'auto' });
  f.report(job.id, 'submitting');
  f.run('hub_machines_retire', { confirm: true }, { id: f.device.id });
  assert.equal(f.job(job.id).status, 'outcome_unknown');
  assert.equal(postStatus(f.ctx, target(f, post.id)), 'unknown');
  assert.ok(f.timeline(job.id).includes('machine_retired'));
});

test('COH-3 (E41): a queued post whose account was never moved after its machine was retired is missed as machine_retired', async () => {
  const f = hubFixture();
  const post = await f.schedule(30 * HOUR);
  const job = f.jobOf(post.id);
  f.run('hub_machines_retire', { confirm: true }, { id: f.device.id });
  assert.equal(f.job(job.id).status, 'queued');
  f.at(iso(Date.parse(String(job.not_after)) + 1000));
  f.lifecycle();
  assert.equal(f.job(job.id).status, 'missed');
  assert.equal(missedReason(f.ctx, target(f, post.id), f.job(job.id), 'missed'), 'machine_retired');
});
