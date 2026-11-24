// E2E-8 (cancel a claimed TikTok post at T − 40 s: cancelling, Win-C gives it up on its next heartbeat, nothing posts),
// concurrently with E2E-8b (X in assist mode: cancel while Mac-B waits for the owner's click; the draft is discarded)
// followed by E2E-10 (assist mode: two click_post_soon alerts, then the owner clicks Post and the job succeeds with
// submitted_by owner). phase1-design §10.2.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fixturePosts, jobIdOf, jobView, localJob, postView, schedule, waitJobStatus, waitPostStatus, type ScheduledPost } from './cases.ts';
import { marker, sleep, sleepUntil, slotAfter, stackUnavailable, startStack, TIMING, until, type Stack } from './stack.ts';

describe('E2E cancel and assist', { skip: stackUnavailable, concurrency: true, timeout: 15 * 60_000 }, () => {
  let stack: Stack;
  // E2E-10 stops the hub at its end to read the job record; E2E-8 runs concurrently and must be finished by then.
  const e2e8 = Promise.withResolvers<void>();
  before(async () => { stack = await startStack({ name: 'cancel' }); });
  after(async () => { await stack?.close(); });

  test('E2E-8: post_update cancel at T − 40 s on a claimed TikTok post → cancelling; Win-C drops it on its next heartbeat; job and post cancelled; nothing posts', async t => {
    t.after(() => e2e8.resolve());
    const caption = marker('E2E-8 cancel claimed');
    const at = slotAfter(120_000);
    const { posts } = await schedule(stack, { providers: ['tiktok'], at, caption });
    const postId = posts.tiktok.post_id;
    const jobId = await jobIdOf(stack, postId);
    await waitJobStatus(stack, jobId, ['claimed', 'ready'], 60_000);
    await sleepUntil(at - 40_000);
    const cancelled = await stack.mcp<{ post: ScheduledPost }>('post_update', { post_id: postId, action: 'cancel', reason: 'E2E-8' });
    assert.ok(cancelled.ok, JSON.stringify(cancelled.error));
    assert.equal(cancelled.data.post.status, 'cancelling');
    const cancelAt = Date.now();
    await stack.nextHeartbeat('Win-C', 30_000);
    await until(() => localJob(stack, 'Win-C', jobId)?.state === 'released', 5_000, 'Win-C released the job locally after that heartbeat');
    const job = await waitJobStatus(stack, jobId, ['cancelled'], 40_000);
    assert.ok(Date.now() < at, `cancelled ${Math.round((Date.now() - cancelAt) / 1000)} s after the request, before T`);
    assert.equal(job.status, 'cancelled');
    assert.equal((await postView(stack, postId)).post.status, 'cancelled');
    await sleepUntil(at + 30_000);
    assert.equal(fixturePosts(stack, 'tiktok', caption).length, 0, 'nothing was posted');
    assert.equal((await jobView(stack, jobId)).status, 'cancelled');
  });

  test('E2E-8b → E2E-10 on X in assist mode', async t => {
    await stack.rest('DELETE', `/hub/channels/${stack.channels.x.id}/risk-ack`);

    await t.test('E2E-8b: cancel while Mac-B waits for the owner to click Post: draft discarded, released, job cancelled, no post', async () => {
      const caption = marker('E2E-8b cancel assist');
      const at = slotAfter(90_000);
      const { posts } = await schedule(stack, { providers: ['x'], at, caption });
      assert.equal(posts.x.route.mode, 'assist');
      assert.equal(posts.x.owner_action?.kind, 'click_post');
      const postId = posts.x.post_id;
      const jobId = await jobIdOf(stack, postId);
      const waiting = await waitJobStatus(stack, jobId, ['needs_owner', 'succeeded', 'missed'], at - Date.now() + 60_000);
      assert.equal(waiting.status, 'needs_owner');
      assert.equal(waiting.blocker?.code, 'owner_click_required');
      const cancelled = await stack.mcp<{ post: ScheduledPost }>('post_update', { post_id: postId, action: 'cancel', reason: 'E2E-8b' });
      assert.ok(cancelled.ok, JSON.stringify(cancelled.error));
      assert.equal(cancelled.data.post.status, 'cancelling');
      const job = await waitJobStatus(stack, jobId, ['cancelled', 'succeeded', 'outcome_unknown'], 60_000);
      assert.equal(job.status, 'cancelled');
      assert.ok(job.timeline.some(row => row.event === 'released'), job.timeline.map(row => row.event).join(','));
      assert.equal((await postView(stack, postId)).post.status, 'cancelled');
      assert.equal(fixturePosts(stack, 'x', caption).length, 0, 'no X post');
      assert.equal(stack.fixtures.events().filter(event => event.platform === 'x' && event.event === 'post_clicked').length, 0);
    });

    await t.test('E2E-10: needs_owner/owner_click_required; click_post_soon at T − prepare and at T; the owner clicks Post; succeeded with submitted_by owner', async () => {
      const caption = marker('E2E-10 owner clicks');
      const at = slotAfter(120_000);
      const { posts } = await schedule(stack, { providers: ['x'], at, caption });
      const postId = posts.x.post_id;
      const jobId = await jobIdOf(stack, postId);
      const lead = await stack.ownerAlert('click_post_soon', 'x', item => item.post?.id === postId && item.severity === 'normal', at - Date.now() + 30_000);
      const leadAt = Date.parse(lead.received_at);
      assert.ok(leadAt >= at - TIMING.prepareLeadSec * 1000 - 20_000 && leadAt < at, `first reminder around T − prepare (${(leadAt - at) / 1000} s)`);
      const due = await stack.ownerAlert('click_post_soon', 'x', item => item.post?.id === postId && item.severity === 'urgent', at - Date.now() + 60_000);
      assert.ok(Date.parse(due.received_at) >= at - 5_000, `second reminder at T (${(Date.parse(due.received_at) - at) / 1000} s)`);
      assert.equal(stack.alerts.all().filter(alert => alert.kind === 'click_post_soon' && alert.post?.id === postId).length, 2);
      const waiting = await waitJobStatus(stack, jobId, ['needs_owner'], 60_000);
      assert.equal(waiting.blocker?.code, 'owner_click_required');
      assert.equal(fixturePosts(stack, 'x', caption).length, 0, 'the Worker did not click');
      await sleep(3_000);
      stack.fixtures.ownerClick('x');   // the owner clicks Post in that Chrome window (§8.15 /__fixture/owner-click)
      const done = await waitJobStatus(stack, jobId, ['succeeded', 'outcome_unknown', 'missed'], 90_000);
      assert.equal(done.status, 'succeeded', JSON.stringify(done.timeline.slice(-4)));
      const view = await waitPostStatus(stack, postId, ['published'], 30_000);
      assert.match(view.result?.url ?? '', /^https:\/\/x\.com\/fixture_x\/status\/\d+$/);
      assert.equal(fixturePosts(stack, 'x', caption).length, 1);
      // submitted_by lives on the job record (the views do not show it): read it with the hub stopped.
      await e2e8.promise;
      await stack.killHub('SIGTERM');
      const record = stack.records().get('worker_job', jobId);
      assert.equal(record?.submitted_by, 'owner');
      assert.equal(record?.status, 'succeeded');
      await stack.startHub();
    });
  });
});
