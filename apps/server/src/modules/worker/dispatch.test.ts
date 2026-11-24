import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Problem, Row } from '@smartsell/contracts';
import { ensureTask } from '../execution/service.js';
import { cancel, updateTarget } from '../planning/index.js';
import { hubFixture } from './fixtures.js';
import { dispatchWorkerJob } from './dispatch.js';
import { JOB, setJob } from './model.js';
import { moveQueuedChannelJobs, requestRevoke } from './revoke.js';
import { releaseSuccessors } from './successors.js';

const HOUR = 3_600_000;
const code = (expected: string) => (error: unknown) => { assert.equal((error as Problem).code, expected); return true; };

test('approval dispatches ahead in the same transaction: route, payload, links and one dispatched event (§5.2)', async () => {
  const f = hubFixture();
  const target = await f.schedule(2 * HOUR, 'New lure test');
  const job = f.jobOf(target.id);
  const task = f.task(target.id);
  assert.deepEqual(task.route, [{ executor: 'worker', device_id: f.device.id }]);
  assert.equal(task.worker_job_id, job.id);
  assert.equal(target.worker_job_id, job.id);
  assert.equal(job.status, 'queued');
  assert.equal(job.device_id, f.device.id);
  assert.deepEqual(job.device_history, [f.device.id]);
  assert.equal(job.not_before, target.scheduled_at);
  assert.equal(Date.parse(String(job.not_after)) - Date.parse(String(job.not_before)), 30 * 60_000);
  assert.equal(job.mode, 'auto');
  assert.equal(job.fencing_token, 0);
  const payload = job.payload as Row;
  assert.equal(payload.schema, 'smartsell.worker.publish.v1');
  assert.deepEqual((payload.channel as Row), { social_account_id: f.account.id, handle: 'lurelab', display_name: 'Lure Lab', profile_key: f.settings().chrome_profile_key, expected_identity: 'lurelab' });
  assert.deepEqual((payload.media as Row[])[0], { file_id: f.file.id, sha256: 'b'.repeat(64), bytes: 30_000_000, mime: 'video/mp4', filename: 'video.mp4', kind: 'video', duration_ms: 12_000, width: 1080, height: 1920 });
  assert.equal((payload.caption as Row).text, 'New lure test');
  assert.deepEqual(payload.limits, { window: null, daily_cap: 10 });
  assert.match(String(job.payload_hash), /^[a-f0-9]{64}$/);
  assert.deepEqual(f.timeline(job.id), ['dispatched']);
  assert.equal(f.events.filter(event => event.type === 'worker.job.dispatched').length, 1);
});

test('dispatch is idempotent; with generation and hash unchanged, ensureTask re-dispatches only when no live job exists (§5.2)', async () => {
  const f = hubFixture();
  const target = await f.schedule(2 * HOUR);
  const first = f.jobOf(target.id);
  assert.equal(dispatchWorkerJob(f.ctx, f.ctx.get('publish_target', target.id), f.task(target.id))!.id, first.id);
  ensureTask(f.ctx, f.ctx.get('publish_target', target.id));
  assert.equal(f.jobsOf(target.id).length, 1, 'no second job while one is live');
  // A pause release after the job was released (for example go denied) must dispatch again.
  setJob(f.ctx, first, { status: 'cancelled', finished_at: f.ctx.now });
  ensureTask(f.ctx, f.ctx.get('publish_target', target.id));
  const again = f.jobOf(target.id);
  assert.notEqual(again.id, first.id);
  assert.equal(again.status, 'queued');
  assert.equal(again.waits_for_job_id, null);
});

test('a changed post supersedes the live job and the new job waits for it (§5.2, §5.10)', async () => {
  const f = hubFixture();
  const target = await f.schedule(2 * HOUR);
  const old = f.jobOf(target.id);
  f.claim();
  const moved = updateTarget(f.ctx, f.ctx.get('publish_target', target.id), { scheduled_at: new Date(Date.parse(String(target.scheduled_at)) + 20 * 60_000).toISOString() }, true);
  assert.equal(moved.approval_retained, true, 'same day within 60 minutes keeps the approval');
  const fresh = f.jobOf(target.id);
  assert.notEqual(fresh.id, old.id);
  assert.equal(f.job(old.id).status, 'releasing');
  assert.equal((f.job(old.id).revoke as Row).reason, 'superseded');
  assert.equal(fresh.waits_for_job_id, old.id);
  // Not claimable while the predecessor might still run.
  assert.deepEqual(f.claim([old.id]).jobs.map(job => job.job_id), []);
  f.report(old.id, 'released', {});
  assert.equal(f.job(old.id).status, 'superseded');
  assert.ok(f.timeline(fresh.id).includes('successor_released'));
  assert.deepEqual(f.claim([]).jobs.map(job => job.job_id), [fresh.id]);
});

test('successor release table: every predecessor outcome (§5.2)', async () => {
  const cases: { name: string; patch: Row | Record<string, unknown>; expect: 'released' | 'cancelled' | 'waiting' }[] = [
    { name: 'cancelled', patch: { status: 'cancelled' }, expect: 'released' },
    { name: 'superseded', patch: { status: 'superseded' }, expect: 'released' },
    { name: 'failed without effect', patch: { status: 'failed' }, expect: 'released' },
    { name: 'missed without effect', patch: { status: 'missed' }, expect: 'released' },
    { name: 'succeeded', patch: { status: 'succeeded', submitting_at: '2027-01-01T10:00:00.000Z' }, expect: 'cancelled' },
    { name: 'outcome_unknown', patch: { status: 'outcome_unknown', submitting_at: '2027-01-01T10:00:00.000Z' }, expect: 'cancelled' },
    { name: 'failed after submitting', patch: { status: 'failed', submitting_at: '2027-01-01T10:00:00.000Z' }, expect: 'cancelled' },
    { name: 'missed after submitting', patch: { status: 'missed', submitting_at: '2027-01-01T10:00:00.000Z' }, expect: 'cancelled' },
    { name: 'unreported', patch: { status: 'unreported' }, expect: 'waiting' },
    { name: 'releasing', patch: { status: 'releasing' }, expect: 'waiting' },
  ];
  for (const item of cases) {
    const f = hubFixture();
    const target = await f.schedule(2 * HOUR);
    const old = f.jobOf(target.id);
    f.claim();
    updateTarget(f.ctx, f.ctx.get('publish_target', target.id), { scheduled_at: new Date(Date.parse(String(target.scheduled_at)) + 10 * 60_000).toISOString() }, true);
    const successor = f.jobOf(target.id);
    // Set the predecessor's outcome without the status hooks, then run the release step the lifecycle runs.
    f.ctx.update(JOB, old.id, item.patch);
    releaseSuccessors(f.ctx, f.job(old.id));
    const after = f.job(successor.id);
    const state = after.status === 'cancelled' ? 'cancelled' : after.waits_released_at ? 'released' : 'waiting';
    assert.equal(state, item.expect, item.name);
    if (item.expect === 'cancelled') {
      assert.ok(f.timeline(successor.id).includes('successor_cancelled_predecessor_posted'), item.name);
      assert.ok(f.events.some(event => event.type === 'worker.job.late_fact' && event.payload.job_id === old.id), item.name);
      assert.ok(f.ctx.list('owner_alert').some(row => row.kind === 'late_fact_after_release'), `${item.name}: urgent alert`);
    }
  }
});

test('syncTaskFromJob: task state and attempt ending for every job outcome (§5.2 table)', async () => {
  const outcomes: { name: string; drive: (f: ReturnType<typeof hubFixture>, id: string) => void; task: string; attempt: string | null; effect?: boolean }[] = [
    { name: 'claimed', drive: f => { f.claim(); }, task: 'scheduled', attempt: null },
    { name: 'running', drive: (f, id) => { f.prepare(id); f.at(String(f.job(id).not_before)); f.go(id); }, task: 'running', attempt: 'in_progress', effect: false },
    { name: 'assist wait (started needs_owner)', drive: (f, id) => { f.prepare(id); f.at(String(f.job(id).not_before)); f.go(id); f.report(id, 'started', { go: 'hub', mode: 'assist' });
      f.report(id, 'blocked', { blocker: { code: 'owner_click_required', phase: 'before_submit', message: '' } }); }, task: 'running', attempt: 'in_progress', effect: false },
    { name: 'submitting', drive: (f, id) => { f.prepare(id); f.at(String(f.job(id).not_before)); f.go(id); f.report(id, 'started', { go: 'hub', mode: 'auto' }); f.report(id, 'submitting'); },
      task: 'running', attempt: 'in_progress', effect: true },
    { name: 'succeeded', drive: (f, id) => { f.publishNow(id); }, task: 'published', attempt: 'verified_published' },
    { name: 'failed', drive: (f, id) => { f.prepare(id); f.at(String(f.job(id).not_before)); f.go(id); f.report(id, 'started', { go: 'hub', mode: 'auto' });
      f.report(id, 'failed', { code: 'upload_rejected', message: 'too long' }); }, task: 'blocked', attempt: 'failed', effect: false },
    { name: 'missed', drive: (f, id) => { f.claim(); f.report(id, 'missed', { reason: 'machine_was_off' }); }, task: 'blocked', attempt: null },
    { name: 'outcome_unknown', drive: (f, id) => { f.prepare(id); f.at(String(f.job(id).not_before)); f.go(id); f.report(id, 'started', { go: 'hub', mode: 'auto' }); f.report(id, 'submitting');
      f.report(id, 'outcome_unknown', { reason: 'readback_exhausted', evidence_sha256: [] }); }, task: 'outcome_unknown', attempt: 'unknown', effect: true },
    { name: 'mark not published', drive: (f, id) => { f.prepare(id); f.at(String(f.job(id).not_before)); f.go(id); f.report(id, 'started', { go: 'hub', mode: 'auto' }); f.report(id, 'submitting');
      f.report(id, 'outcome_unknown', { reason: 'x', evidence_sha256: [] }); f.run('hub_posts_mark_not_published', { confirm: true }, { id: String(f.job(id).publish_target_id) }); },
      task: 'blocked', attempt: 'failed', effect: false },
  ];
  for (const outcome of outcomes) {
    const f = hubFixture();
    const target = await f.schedule(HOUR);
    const job = f.jobOf(target.id);
    outcome.drive(f, job.id);
    const task = f.task(target.id);
    assert.equal(task.status, outcome.task, outcome.name);
    const attempt = f.ctx.list('execution_attempt').find(row => row.task_id === task.id);
    assert.equal(attempt?.status ?? null, outcome.attempt, outcome.name);
    if (attempt && outcome.effect !== undefined) assert.equal(attempt.side_effect_possible, outcome.effect, `${outcome.name}: side_effect_possible`);
    if (attempt?.executor) assert.equal(attempt.executor, 'worker');
    if (['blocked', 'published'].includes(outcome.task)) assert.equal(task.active_attempt_id ?? null, null, `${outcome.name}: active attempt cleared`);
  }
});

test('missed, failed and mark_not_published can be rescheduled, and each reschedule dispatches a new job (§5.2)', async () => {
  for (const end of ['missed', 'failed', 'mark_not_published'] as const) {
    const f = hubFixture();
    const target = await f.schedule(HOUR);
    const job = f.jobOf(target.id);
    f.prepare(job.id);
    if (end === 'missed') f.report(job.id, 'missed', { reason: 'late' });
    else {
      f.at(String(job.not_before));
      f.go(job.id);
      f.report(job.id, 'started', { go: 'hub', mode: 'auto' });
      if (end === 'failed') f.report(job.id, 'failed', { code: 'media_hash_mismatch', message: 'hash' });
      else {
        f.report(job.id, 'submitting');
        f.report(job.id, 'outcome_unknown', { reason: 'x', evidence_sha256: [] });
        assert.throws(() => updateTarget(f.ctx, f.ctx.get('publish_target', target.id), { scheduled_at: new Date(Date.parse(f.ctx.now) + HOUR).toISOString() }, true), code('LEASE_HELD'));
        f.run('hub_posts_mark_not_published', { confirm: true }, { id: target.id });
      }
    }
    const moved = updateTarget(f.ctx, f.ctx.get('publish_target', target.id), { scheduled_at: new Date(Date.parse(f.ctx.now) + 2 * HOUR).toISOString() }, true);
    if (!moved.approval_retained) {
      const { resubmitIfWaiting } = await import('../planning/index.js');
      resubmitIfWaiting(f.ctx, target.id);
    }
    const fresh = f.jobOf(target.id);
    assert.notEqual(fresh.id, job.id, end);
    assert.equal(fresh.status, 'queued', end);
    assert.equal(fresh.waits_for_job_id, null, `${end}: a predecessor that never posted does not block`);
  }
});

test('Worker-aware cancellation: queued, claimed, running, assist wait, submitting, outcome_unknown (§5.10)', async () => {
  const setup = async (drive: (f: ReturnType<typeof hubFixture>, id: string) => void) => {
    const f = hubFixture();
    const target = await f.schedule(HOUR);
    const job = f.jobOf(target.id);
    drive(f, job.id);
    return { f, target, job };
  };
  {
    const { f, target, job } = await setup(() => {});
    cancel(f.ctx, f.ctx.get('publish_target', target.id));
    assert.equal(f.job(job.id).status, 'cancelled');
    assert.equal(f.task(target.id).status, 'cancelled');
    assert.equal(f.ctx.get('publish_target', target.id).plan_status, 'cancelled');
  }
  {
    const { f, target, job } = await setup(f => { f.claim(); });
    const result = cancel(f.ctx, f.ctx.get('publish_target', target.id));
    assert.equal((result as unknown as Row).plan_status, 'cancel_requested');
    assert.equal(f.task(target.id).status, 'cancel_pending');
    assert.equal(f.job(job.id).status, 'releasing');
    assert.deepEqual(f.heartbeat([job.id]).revoked_jobs, [{ job_id: job.id, reason: 'cancelled' }]);
    f.heartbeat([], { released_jobs: [job.id] });
    assert.equal(f.job(job.id).status, 'cancelled');
    assert.equal(f.task(target.id).status, 'cancelled');
    assert.equal(f.ctx.get('publish_target', target.id).plan_status, 'cancelled');
  }
  for (const assist of [false, true]) {
    const { f, target, job } = await setup((f, id) => {
      f.prepare(id); f.at(String(f.job(id).not_before)); f.go(id); f.report(id, 'started', { go: 'hub', mode: assist ? 'assist' : 'auto' });
      if (assist) f.report(id, 'blocked', { blocker: { code: 'owner_click_required', phase: 'before_submit', message: '' } });
    });
    cancel(f.ctx, f.ctx.get('publish_target', target.id));
    assert.equal(f.job(job.id).status, assist ? 'needs_owner' : 'running', 'a started job keeps its state with revoke set');
    assert.equal((f.job(job.id).revoke as Row).reason, 'cancelled');
    assert.deepEqual(f.heartbeat([job.id]).revoked_jobs.map(item => item.job_id), [job.id]);
    f.report(job.id, 'released', {});
    assert.equal(f.job(job.id).status, 'cancelled');
    assert.equal(f.task(target.id).status, 'cancelled');
    assert.equal(f.ctx.list('execution_attempt').find(row => row.task_id === f.task(target.id).id)?.status, 'abandoned');
  }
  {
    const { f, target } = await setup((f, id) => { f.prepare(id); f.at(String(f.job(id).not_before)); f.go(id); f.report(id, 'started', { go: 'hub', mode: 'auto' }); f.report(id, 'submitting'); });
    assert.throws(() => cancel(f.ctx, f.ctx.get('publish_target', target.id)), code('POST_LOCKED'));
  }
  {
    const { f, target } = await setup((f, id) => { f.prepare(id); f.at(String(f.job(id).not_before)); f.go(id); f.report(id, 'started', { go: 'hub', mode: 'auto' }); f.report(id, 'submitting');
      f.report(id, 'outcome_unknown', { reason: 'x', evidence_sha256: [] }); });
    assert.throws(() => cancel(f.ctx, f.ctx.get('publish_target', target.id)), code('POST_RESULT_UNKNOWN'));
  }
  {
    // A running job cancelled too late: the facts win, the post shows published and cancel_failed is emitted.
    const { f, target, job } = await setup((f, id) => { f.prepare(id); f.at(String(f.job(id).not_before)); f.go(id); f.report(id, 'started', { go: 'hub', mode: 'auto' }); });
    cancel(f.ctx, f.ctx.get('publish_target', target.id));
    f.report(job.id, 'submitting');
    f.report(job.id, 'submitted', {});
    f.report(job.id, 'result', f.resultData());
    assert.equal(f.job(job.id).status, 'succeeded');
    assert.equal(f.task(target.id).status, 'published');
    assert.ok(f.events.some(event => event.type === 'execution.task.cancel_failed'));
    assert.ok(f.ctx.list('owner_alert').some(row => row.kind === 'late_fact_after_release'));
  }
});

test('requestRevoke: queued → cancelled at once, claimed → releasing, started → revoke only, submitting → POST_LOCKED', async () => {
  const f = hubFixture();
  const a = f.jobOf((await f.schedule(HOUR)).id);
  assert.equal(requestRevoke(f.ctx, a, 'cancelled'), 'cancelled');
  assert.equal(f.job(a.id).status, 'cancelled');
  const b = f.jobOf((await f.schedule(HOUR + 60_000)).id);
  f.claim();
  assert.equal(requestRevoke(f.ctx, f.job(b.id), 'superseded'), 'releasing');
  const g = hubFixture();
  const c = g.jobOf((await g.schedule(HOUR)).id);
  g.prepare(c.id); g.at(String(c.not_before)); g.go(c.id);
  assert.equal(requestRevoke(g.ctx, g.job(c.id), 'cancelled'), 'revoke_pending');
  assert.equal(g.job(c.id).status, 'running');
  g.report(c.id, 'started', { go: 'hub', mode: 'auto' });
  g.report(c.id, 'submitting');
  assert.throws(() => requestRevoke(g.ctx, g.job(c.id), 'cancelled'), code('POST_LOCKED'));
});

test('changing machines: active jobs refuse with CHANNEL_HAS_ACTIVE_JOBS; only queued jobs move with a new fence (§5.10)', async () => {
  const f = hubFixture();
  const first = f.jobOf((await f.schedule(HOUR)).id);
  const second = f.jobOf((await f.schedule(30 * HOUR)).id);
  f.claim([], { horizon_minutes: 120 });
  assert.equal(f.job(first.id).status, 'claimed');
  assert.throws(() => moveQueuedChannelJobs(f.ctx, f.account.id, f.other.id), (error: unknown) => {
    assert.equal((error as Problem).code, 'CHANNEL_HAS_ACTIVE_JOBS');
    assert.deepEqual((error as Problem).details?.post_ids, [first.publish_target_id]);
    return true;
  });
  requestRevoke(f.ctx, f.job(first.id), 'cancelled');
  f.heartbeat([], { released_jobs: [first.id] });
  assert.deepEqual(moveQueuedChannelJobs(f.ctx, f.account.id, f.other.id), { moved: 1 });
  const moved = f.job(second.id);
  assert.equal(moved.device_id, f.other.id);
  assert.deepEqual(moved.device_history, [f.device.id, f.other.id]);
  assert.equal(moved.fencing_token, 1);
  assert.ok(f.timeline(second.id).includes('reassigned'));
});
