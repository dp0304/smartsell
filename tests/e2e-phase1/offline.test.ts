// E2E-3 (Win-C off past the lateness limit: no post, missed{machine_was_off}, the owner is told), E2E-3c (reschedule
// after the miss posts exactly once), E2E-3b (late but within the limit: posts, late_by_sec ≈ 60) on Win-C, and
// concurrently E2E-4 (captcha on X: needs_owner on Mac-B, read-only wait without reloads, then continues) on Mac-B.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fixturePosts, jobIdOf, jobView, postView, schedule, waitJobStatus, waitPostStatus, type ScheduledPost } from './cases.ts';
import { localWhen, marker, sleep, sleepUntil, slotAfter, stackUnavailable, startStack, TIMING, until, type Stack } from './stack.ts';

describe('E2E machine offline around T; captcha on the other machine', { skip: stackUnavailable, concurrency: true, timeout: 20 * 60_000 }, () => {
  let stack: Stack;
  before(async () => { stack = await startStack({ name: 'offline' }); });
  after(async () => { await stack?.close(); });

  /** Schedules TikTok at T, waits for Win-C's claim, preflight and final prepare, and stops Win-C at T − 10 s. */
  async function offAtT(caption: string) {
    const at = slotAfter(90_000);
    const { posts } = await schedule(stack, { providers: ['tiktok'], at, caption });
    const postId = posts.tiktok.post_id;
    const jobId = await jobIdOf(stack, postId);
    // The post-claim preflight is skipped when this channel passed a check within 30 min (§8.5), so wait for the claim;
    // the final prepare at T − prepare is what must have happened before the stop.
    await until(async () => (await jobView(stack, jobId)).timeline.some(row => row.event === 'claimed'), 60_000, 'claimed by Win-C');
    await sleepUntil(at - 10_000);
    const before = await jobView(stack, jobId);
    assert.equal(before.status, 'ready', 'claimed and finally prepared before the stop');
    assert.ok(before.timeline.some(row => row.event === 'prepared' && row.detail.stage === 'final'));
    await stack.stopRunner('Win-C');
    return { at, postId, jobId };
  }

  test('E2E-3 → E2E-3c → E2E-3b on Win-C', async t => {
    let missedPost = '';
    let missedJob = '';
    const caption3 = marker('E2E-3 off past limit');
    await t.test('E2E-3: stopped at T − 10 s, back at T + 3 min 30 s: no post, missed{machine_was_off}, the owner hears it names Win-C and @fixture_tt (stream and phone)', async () => {
      const { at, postId, jobId } = await offAtT(caption3);
      missedPost = postId; missedJob = jobId;
      await sleepUntil(at + TIMING.latenessMin * 60_000 + 30_000);
      await stack.startRunner('Win-C');
      const job = await waitJobStatus(stack, jobId, ['missed', 'succeeded', 'outcome_unknown'], 90_000);
      assert.equal(job.status, 'missed');
      const reported = job.timeline.find(row => row.event === 'missed' && row.actor === 'device');
      assert.equal(reported?.detail.reason, 'machine_was_off', JSON.stringify(job.timeline.slice(-4)));
      assert.equal(fixturePosts(stack, 'tiktok', caption3).length, 0, 'not posted late');
      assert.equal((await postView(stack, postId)).post.status, 'missed');
      const alert = await stack.ownerAlert('missed', 'tiktok', item => item.post?.id === postId, 60_000);
      assert.equal(alert.severity, 'urgent');
      await until(() => stack.ntfy.pushes().find(push => `${push.title} ${push.message}`.includes('Win-C') && `${push.title} ${push.message}`.includes('@fixture_tt')
        && /沒有發出|錯過/.test(`${push.title} ${push.message}`)), 60_000, 'ntfy push naming Win-C and @fixture_tt');
      await sleep(5_000);
      assert.equal(fixturePosts(stack, 'tiktok', caption3).length, 0, 'still no post after Win-C came back');
    });

    await t.test('E2E-3c: post_update reschedule to now + 90 s after the miss: the direct channel approves it, a new job runs, exactly one post', async () => {
      assert.ok(missedPost, 'E2E-3 ran');
      const at = slotAfter(90_000);
      const result = await stack.mcp<{ post: ScheduledPost; approval_retained: boolean; changes: string[] }>('post_update', { post_id: missedPost, action: 'reschedule', when: localWhen(at) });
      assert.ok(result.ok, JSON.stringify(result.error));
      if (result.data.approval_retained === false) assert.equal(result.data.post.approval, 'approved_by_channel_policy', 'direct channel re-approved automatically');
      assert.equal(result.data.post.status, 'scheduled');
      assert.equal(Date.parse(result.data.post.scheduled_at), at);
      const newJob = await until(async () => { const id = (await postView(stack, missedPost)).task?.task_id; return id && id !== missedJob && id; }, 30_000, 'a new job');
      const view = await waitPostStatus(stack, missedPost, ['published', 'needs_owner', 'missed', 'failed', 'unknown'], at - Date.now() + 120_000);
      assert.equal(view.post.status, 'published', JSON.stringify(view.task?.timeline.slice(-4)));
      assert.equal(view.task?.task_id, newJob);
      assert.equal(fixturePosts(stack, 'tiktok', caption3).length, 1, 'exactly one TikTok post');
      assert.equal((await jobView(stack, missedJob)).status, 'missed', 'the missed job stays missed');
    });

    await t.test('E2E-3b: stopped at T − 10 s, back at T + 60 s (limit 3 min): posts, late_by_sec ≈ 60', async () => {
      const caption = marker('E2E-3b late within limit');
      const { at, postId, jobId } = await offAtT(caption);
      await sleepUntil(at + 60_000);
      await stack.startRunner('Win-C');
      const view = await waitPostStatus(stack, postId, ['published', 'needs_owner', 'missed', 'failed', 'unknown'], 120_000);
      assert.equal(view.post.status, 'published', JSON.stringify(view.task?.timeline.slice(-4)));
      assert.equal(view.task?.task_id, jobId);
      const late = view.result?.late_by_sec ?? -1;
      assert.ok(late >= 55 && late <= 90, `late_by_sec ${late} ≈ 60`);
      assert.equal(fixturePosts(stack, 'tiktok', caption).length, 1);
      assert.ok(Date.parse(fixturePosts(stack, 'tiktok', caption)[0].created_at) <= at + TIMING.latenessMin * 60_000, 'inside the lateness limit');
    });
  });

  test('E2E-4: captcha on X → needs_owner on Mac-B, no post, an alert naming Mac-B and @fixture_x, no reload while waiting, then it continues and posts once', async () => {
    stack.fixtures.setScenario('x', 'captcha');
    const caption = marker('E2E-4 captcha');
    const at = slotAfter(150_000);
    const { posts } = await schedule(stack, { providers: ['x'], at, caption });
    const postId = posts.x.post_id;
    const jobId = await jobIdOf(stack, postId);
    const blocked = await waitJobStatus(stack, jobId, ['needs_owner'], 90_000);
    assert.equal(blocked.blocker?.code, 'captcha');
    assert.equal(blocked.blocker?.machine_name, 'Mac-B');
    assert.equal(blocked.blocker?.channel_label, 'X @fixture_x');
    assert.equal((await postView(stack, postId)).post.status, 'needs_owner');
    assert.equal(fixturePosts(stack, 'x', caption).length, 0);
    const alert = await stack.ownerAlert('worker_blocker', 'x', item => item.post?.id === postId, 60_000);
    assert.equal(alert.severity, 'urgent');
    // Read-only observation (§5.9): over several 10 s polls the blocked page is never loaded again.
    // Only X pages: Win-C runs E2E-3 concurrently on the TikTok fixture.
    const xLoads = () => Object.fromEntries(Object.entries(stack.fixtures.pageLoads()).filter(([path]) => path.startsWith('/x/')));
    const loadsBefore = xLoads();
    assert.ok(Object.keys(loadsBefore).length > 0);
    await sleep(25_000);
    assert.deepEqual(xLoads(), loadsBefore, 'no reload or navigation while the captcha waits for the owner');
    assert.ok(Date.now() < at - TIMING.prepareLeadSec * 1000, 'the owner clears it before prepare');
    stack.fixtures.setScenario('x', 'ok');
    const view = await waitPostStatus(stack, postId, ['published', 'unknown', 'missed', 'failed'], at - Date.now() + 120_000);
    assert.equal(view.post.status, 'published', JSON.stringify(view.task?.timeline.slice(-5)));
    assert.equal(view.task?.task_id, jobId, 'the same job continued');
    assert.equal(fixturePosts(stack, 'x', caption).length, 1, 'exactly one post');
    const timeline = (await jobView(stack, jobId)).timeline.map(row => row.event);
    assert.ok(timeline.indexOf('prepare_blocked') < timeline.indexOf('result'));
  });
});
