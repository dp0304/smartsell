// E2E-7 (TikTok answers an error after Post and creates nothing: outcome_unknown, conservative; after the owner marks
// it not published a reschedule posts exactly once) and E2E-6 (X creates the post but neither the toast nor the profile
// shows it: result_pending → outcome_unknown; restarts of the hub and Mac-B never re-post; post_update and retry are
// refused until the owner marks it not published). Run in that order on one stack (phase1-design §10.2).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { MachineDetail, WorkerJobStatus } from '../../packages/contracts/src/index.ts';
import { fixturePosts, jobIdOf, jobView, postView, schedule, waitJobStatus, waitPostStatus } from './cases.ts';
import { localWhen, marker, sleep, slotAfter, stackUnavailable, startStack, until, type Stack } from './stack.ts';

describe('E2E result unknown: never re-posted automatically', { skip: stackUnavailable, concurrency: false, timeout: 15 * 60_000 }, () => {
  let stack: Stack;
  before(async () => { stack = await startStack({ name: 'unknown' }); });
  after(async () => { await stack?.close(); });

  test('E2E-7: post_error_not_created → outcome_unknown (after_submit); marked not published by the owner, a reschedule posts exactly once', async () => {
    stack.fixtures.setScenario('tiktok', 'post_error_not_created');
    const caption = marker('E2E-7 error not created');
    const at = slotAfter(90_000);
    const { posts } = await schedule(stack, { providers: ['tiktok'], at, caption });
    const postId = posts.tiktok.post_id;
    const jobId = await jobIdOf(stack, postId);
    const unknown = await waitJobStatus(stack, jobId, ['outcome_unknown', 'succeeded', 'failed', 'needs_owner', 'missed'], at - Date.now() + 120_000);
    assert.equal(unknown.status, 'outcome_unknown', JSON.stringify(unknown.timeline.slice(-4)));
    const blocked = unknown.timeline.find(row => row.event === 'blocked');
    assert.equal((blocked?.detail.blocker as { phase?: string } | undefined)?.phase, 'after_submit', JSON.stringify(blocked));
    assert.equal((await postView(stack, postId)).post.status, 'unknown');
    assert.equal(fixturePosts(stack, 'tiktok', caption).length, 0, 'the platform created nothing');
    const refused = await stack.mcp('post_update', { post_id: postId, action: 'reschedule', when: localWhen(slotAfter(90_000)) });
    assert.equal(refused.error?.code, 'POST_RESULT_UNKNOWN');
    await stack.rest('POST', `/hub/posts/${postId}/mark-not-published`, { confirm: true });
    assert.equal((await jobView(stack, jobId)).status, 'failed');
    assert.equal((await postView(stack, postId)).post.status, 'failed');
    stack.fixtures.setScenario('tiktok', 'ok');
    const again = slotAfter(90_000);
    const rescheduled = await stack.mcp<{ post: { status: string } }>('post_update', { post_id: postId, action: 'reschedule', when: localWhen(again) });
    assert.ok(rescheduled.ok, JSON.stringify(rescheduled.error));
    const view = await waitPostStatus(stack, postId, ['published', 'unknown', 'missed', 'failed', 'needs_owner'], again - Date.now() + 120_000);
    assert.equal(view.post.status, 'published', JSON.stringify(view.task?.timeline.slice(-4)));
    assert.notEqual(view.task?.task_id, jobId, 'a new job posted it');
    assert.equal(fixturePosts(stack, 'tiktok', caption).length, 1, 'exactly one TikTok post');
  });

  test('E2E-6: created_hidden → result_pending → outcome_unknown; one post; restarts add no job and no post; reschedule and retry refused until marked not published', async () => {
    stack.fixtures.setScenario('x', 'created_hidden');
    const caption = marker('E2E-6 created hidden');
    const at = slotAfter(90_000);
    const { posts } = await schedule(stack, { providers: ['x'], at, caption });
    const postId = posts.x.post_id;
    const jobId = await jobIdOf(stack, postId);
    const seen: WorkerJobStatus[] = [];
    await until(async () => {
      const status = (await jobView(stack, jobId)).status;
      if (seen.at(-1) !== status) seen.push(status);
      return ['outcome_unknown', 'succeeded', 'failed', 'missed'].includes(status);
    }, at - Date.now() + 180_000, 'job settles', 500);
    assert.equal(seen.at(-1), 'outcome_unknown', seen.join(' → '));
    assert.ok(seen.indexOf('result_pending') !== -1 && seen.indexOf('result_pending') < seen.indexOf('outcome_unknown'), `passes result_pending first: ${seen.join(' → ')}`);
    const timeline = (await jobView(stack, jobId)).timeline.map(row => row.event);
    assert.ok(timeline.indexOf('submitted') < timeline.indexOf('outcome_unknown') && timeline.includes('readback_pending'), timeline.join(','));
    const all = () => stack.fixtures.posts().filter(post => post.platform === 'x' && post.text.startsWith(caption));
    assert.equal(all().length, 1, 'the platform has exactly one (hidden) post');

    await stack.killHub('SIGKILL');
    await stack.stopRunner('Mac-B');
    await stack.startHub();
    await stack.startRunner('Mac-B');
    await stack.nextHeartbeat('Mac-B', 60_000);
    await stack.nextHeartbeat('Mac-B', 60_000);
    await sleep(5_000);
    assert.equal(all().length, 1, 'still exactly one post after restarting the hub and Mac-B');
    const after = await postView(stack, postId);
    assert.equal(after.post.status, 'unknown');
    assert.equal(after.task?.task_id, jobId, 'no new job for the post');
    const machine = await stack.view<MachineDetail>(`/views/machines/${stack.machines['Mac-B'].deviceId}`);
    assert.deepEqual([...machine.upcoming, ...machine.history].filter(item => item.post_id === postId).map(item => item.task_id), [jobId]);

    const reschedule = await stack.mcp('post_update', { post_id: postId, action: 'reschedule', when: localWhen(slotAfter(20 * 60_000)) });
    assert.equal(reschedule.error?.code, 'POST_RESULT_UNKNOWN');
    const retry = await stack.restRaw('POST', `/hub/posts/${postId}/retry`, {});
    assert.equal(retry.status, 409, JSON.stringify(retry.body));
    await stack.rest('POST', `/hub/posts/${postId}/mark-not-published`, { confirm: true });
    const allowed = await stack.mcp<{ post: { status: string } }>('post_update', { post_id: postId, action: 'reschedule', when: localWhen(slotAfter(20 * 60_000)) });
    assert.ok(allowed.ok, `reschedule allowed after mark_not_published: ${JSON.stringify(allowed.error)}`);
    assert.equal(allowed.data.post.status, 'scheduled');
    const next = await until(async () => { const id = (await postView(stack, postId)).task?.task_id; return id && id !== jobId && id; }, 30_000, 'a new job after the owner decided');
    assert.ok(next);
    // Do not let the far reschedule post a second time on this stack.
    const cancelled = await stack.mcp('post_update', { post_id: postId, action: 'cancel' });
    assert.ok(cancelled.ok, JSON.stringify(cancelled.error));
    assert.equal(all().length, 1);
  });
});
