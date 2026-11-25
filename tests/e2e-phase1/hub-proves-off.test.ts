// E2E-3d (Win-C stops right after its preflight and never returns: the hub itself proves it could not have run, so the
// job is missed — not unreported — and can be rescheduled without force_release), concurrently with E2E-13 (Mac-B is
// partitioned, the post is rescheduled within tolerance, the owner force-releases the old job, Mac-B still posts it by
// the offline rule; when it reconnects the late fact wins: old job succeeded, successor cancelled, one post).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { WorkerJobStatus } from '../../packages/contracts/src/index.ts';
import { fixturePosts, jobIdOf, jobView, postView, schedule, waitJobStatus, type ScheduledPost } from './cases.ts';
import { localWhen, marker, sleep, sleepUntil, slotAfter, stackUnavailable, startStack, TIMING, until, type Data, type Stack } from './stack.ts';

describe('E2E the hub decides from what it knows; late facts after a forced release', { skip: stackUnavailable, concurrency: true, timeout: 20 * 60_000 }, () => {
  let stack: Stack;
  // E2E-13 reads the hub's records at its end (hub stopped); E2E-3d runs concurrently and must be finished by then.
  const e2e3d = Promise.withResolvers<void>();
  before(async () => { stack = await startStack({ name: 'hub-proves-off' }); });
  after(async () => { await stack?.close(); });

  test('E2E-3d: T = now + 6 min; Win-C stops right after its preflight; at not_after + 30 s the hub marks it missed (missed_machine_off), never unreported; reschedule needs no force_release', async t => {
    t.after(() => e2e3d.resolve());
    const caption = marker('E2E-3d hub proves off');
    const at = slotAfter(6 * 60_000);
    const { posts } = await schedule(stack, { providers: ['tiktok'], at, caption });
    const postId = posts.tiktok.post_id;
    const jobId = await jobIdOf(stack, postId);
    await until(async () => (await jobView(stack, jobId)).timeline.some(row => row.event === 'prepared' && row.detail.stage === 'preflight'), 90_000, 'Win-C preflight');
    await stack.stopRunner('Win-C');
    const stoppedAt = Date.now();
    assert.ok(stoppedAt < at - 4 * 60_000 - 30_000, 'stopped long enough before T for the hub to prove it');
    const seen: WorkerJobStatus[] = [];
    const notAfter = at + TIMING.latenessMin * 60_000;
    await until(async () => {
      const status = (await jobView(stack, jobId)).status;
      if (seen.at(-1) !== status) seen.push(status);
      return ['missed', 'unreported', 'succeeded', 'cancelled'].includes(status);
    }, notAfter + TIMING.unreportedGraceSec * 1000 + 60_000 - Date.now(), 'the hub settles the job', 2000);
    assert.equal(seen.at(-1), 'missed', `statuses ${seen.join(' → ')}`);
    assert.ok(!seen.includes('unreported'), 'never unreported');
    const job = await jobView(stack, jobId);
    const event = job.timeline.find(row => row.event === 'missed_machine_off');
    assert.ok(event, `missed_machine_off in ${job.timeline.map(row => row.event).join(',')}`);
    assert.equal(event.actor, 'hub');
    assert.ok(Date.parse(event.at) >= notAfter + TIMING.unreportedGraceSec * 1000 - 1000, 'decided after not_after + grace');
    assert.equal((await postView(stack, postId)).post.status, 'missed');
    assert.equal(fixturePosts(stack, 'tiktok', caption).length, 0);
    const rescheduled = await stack.mcp<{ post: ScheduledPost }>('post_update', { post_id: postId, action: 'reschedule', when: localWhen(slotAfter(30 * 60_000)) });
    assert.ok(rescheduled.ok, `reschedule without force_release: ${JSON.stringify(rescheduled.error)}`);
    assert.equal(rescheduled.data.post.status, 'scheduled');
    const next = await until(async () => { const id = (await postView(stack, postId)).task?.task_id; return id && id !== jobId && id; }, 30_000, 'a new job');
    assert.equal((await jobView(stack, next)).status, 'queued', 'queued for Win-C');
    const cancelled = await stack.mcp('post_update', { post_id: postId, action: 'cancel' });
    assert.ok(cancelled.ok);
  });

  test('E2E-13: partition Mac-B at T − 60 s, reschedule within tolerance (old job releasing), force_release; Mac-B posts offline; on reconnect: fence_override success, late_fact_after_release, successor cancelled, one post', async () => {
    const caption = marker('E2E-13 late fact');
    const at = slotAfter(150_000);
    const { posts } = await schedule(stack, { providers: ['x'], at, caption });
    const postId = posts.x.post_id;
    const oldJob = await jobIdOf(stack, postId);
    await until(async () => (await jobView(stack, oldJob)).timeline.some(row => row.event === 'prepared'), 90_000, 'Mac-B preflight');
    await sleepUntil(at - 60_000);
    stack.partition('Mac-B', true);
    const moved = await stack.mcp<{ post: ScheduledPost; approval_retained: boolean }>('post_update', { post_id: postId, action: 'reschedule', when: localWhen(at + 5 * 60_000) });
    assert.ok(moved.ok, JSON.stringify(moved.error));
    assert.equal(moved.data.approval_retained, true, 'within tolerance');
    assert.equal((await jobView(stack, oldJob)).status, 'releasing', 'the old job waits for Mac-B to let go');
    const successor = await until(async () => { const id = (await postView(stack, postId)).task?.task_id; return id && id !== oldJob && id; }, 30_000, 'successor job');
    const released = await stack.rest<Data>('POST', `/hub/jobs/${oldJob}/force-release`, { confirm_text: '我確認 Mac-B 已關機或已斷網，不會發出這則貼文。' });
    assert.ok(released);
    assert.equal((await jobView(stack, oldJob)).status, 'cancelled', 'force-released');
    // Mac-B never heard any of it: at T it cannot reach the hub and runs the old job by the offline rule.
    await until(() => fixturePosts(stack, 'x', caption).length >= 1, 90_000, 'Mac-B posted the old job offline');
    assert.ok(Math.abs(Date.parse(fixturePosts(stack, 'x', caption)[0].created_at) - at) < 30_000, 'on time');
    await sleep(5_000);
    stack.partition('Mac-B', false);
    // The first late fact (submitting) makes the job outcome_unknown until the result fact arrives; on a loaded runner the
    // gap between the two outbox deliveries is long enough to observe, so wait for the settled status only.
    const old = await waitJobStatus(stack, oldJob, ['succeeded'], 90_000)
      .catch(async error => { const view = await jobView(stack, oldJob); throw new Error(`${error.message}: ${view.status}, ${view.timeline.map(row => row.event).join(',')}`); });
    assert.equal(old.status, 'succeeded');
    assert.ok(old.timeline.some(row => row.event === 'late_fact_after_release'), old.timeline.map(row => row.event).join(','));
    assert.equal(old.timeline.find(row => row.event === 'started')?.detail.go, 'offline');
    const next = await waitJobStatus(stack, successor, ['cancelled', 'superseded', 'claimed', 'ready', 'running', 'succeeded'], 60_000);
    assert.equal(next.status, 'cancelled', 'the successor is cancelled before any machine claims it');
    assert.ok(!next.timeline.some(row => ['claimed', 'started'].includes(row.event)), 'never claimed, never started');
    assert.ok(next.timeline.some(row => row.event === 'successor_cancelled_predecessor_posted'), next.timeline.map(row => row.event).join(','));
    const alert = await stack.ownerAlert('late_fact_after_release', 'x', item => item.post?.id === postId, 60_000);
    assert.equal(alert.severity, 'urgent');
    assert.equal((await postView(stack, postId)).post.status, 'published');
    await stack.nextHeartbeat('Mac-B', 30_000);
    await stack.nextHeartbeat('Mac-B', 30_000);
    assert.equal(fixturePosts(stack, 'x', caption).length, 1, 'exactly one X post');
    // §5.4.3: the facts that arrived after the release are recorded with fence_override (the views do not show the flag).
    await e2e3d.promise;
    await stack.killHub('SIGTERM');
    const records = stack.records();
    assert.equal(records.get('worker_job', oldJob)?.fence_override, true, 'the old job was moved by an overriding fact');
    const events = records.list('worker_job_event').filter(row => row.job_id === oldJob);
    const late = events.find(row => row.event === 'late_fact_after_release');
    assert.equal(late?.fence_override, true);
    const first = events.filter(row => ['submitting', 'submitted', 'result'].includes(String(row.event)) && row.actor === 'device')
      .sort((a, b) => Number(a.seq) - Number(b.seq))[0];
    assert.equal(first?.fence_override, true, `the first possibly-sent fact after the release (${String(first?.event)}) is flagged`);
    assert.equal(records.get('worker_job', successor)?.status, 'cancelled');
    assert.equal(records.list('platform_post').filter(row => row.publish_target_id === postId).length, 1, 'one platform_post for the post');
    await stack.startHub();
  });
});
