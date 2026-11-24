// E2E-5 (TikTok login expired: the post-claim preflight stops long before prepare and tells the owner which machine
// and account) and E2E-2b (X risk acknowledgement withdrawn before a hub outage: offline, Mac-B prepares and stops
// before Post; never clicks), on one stack (phase1-design §10.2). E2E-5 finishes before the outage.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ChannelDetail, TodayView } from '../../packages/contracts/src/index.ts';
import { fixturePosts, jobIdOf, jobView, localJob, postView, schedule, waitJobStatus } from './cases.ts';
import { marker, sleepUntil, slotAfter, stackUnavailable, startStack, TIMING, until, type Data, type Stack } from './stack.ts';

describe('E2E owner stops: login expired at preflight; assist mode survives a hub outage', { skip: stackUnavailable, concurrency: false, timeout: 15 * 60_000 }, () => {
  let stack: Stack;
  before(async () => { stack = await startStack({ name: 'hub-down-assist' }); });
  after(async () => { await stack?.close(); });

  test('E2E-5: login_expired → prepare_blocked{preflight} right after the claim, session login_required, a login card and an alert naming Win-C and @fixture_tt', async () => {
    stack.fixtures.setScenario('tiktok', 'login_expired');
    const caption = marker('E2E-5 login expired');
    const at = slotAfter(6 * 60_000);
    const scheduledAt = Date.now();
    const { posts } = await schedule(stack, { providers: ['tiktok'], at, caption });
    const postId = posts.tiktok.post_id;
    const jobId = await jobIdOf(stack, postId);
    const blocked = await until(async () => { const view = await jobView(stack, jobId); return view.timeline.find(row => row.event === 'prepare_blocked') && view; }, 120_000, 'prepare_blocked');
    const event = blocked.timeline.find(row => row.event === 'prepare_blocked')!;
    assert.equal(event.detail.stage, 'preflight');
    assert.equal((event.detail.blocker as Data | undefined)?.code, 'login_expired');
    const prepareAt = at - TIMING.prepareLeadSec * 1000;
    assert.ok(Date.parse(event.at) < prepareAt - 3 * 60_000, `blocked at the post-claim preflight, ${Math.round((prepareAt - Date.parse(event.at)) / 1000)} s before prepare`);
    assert.ok(Date.parse(event.at) - scheduledAt < 90_000, 'within a minute or so of scheduling');
    const job = await waitJobStatus(stack, jobId, ['needs_owner'], 30_000);
    assert.equal(job.blocker?.code, 'login_expired');
    assert.equal(job.blocker?.machine_name, 'Win-C');
    assert.equal(job.blocker?.channel_label, 'TikTok @fixture_tt');
    const channel = await stack.view<ChannelDetail>(`/views/channels/${stack.channels.tiktok.id}`);
    assert.equal(channel.login.state, 'login_required');
    const today = await stack.view<TodayView>('/views/today');
    const card = today.attention.find(item => item.kind === 'login' && item.channel?.id === stack.channels.tiktok.id);
    assert.ok(card, `login card in attention: ${JSON.stringify(today.attention.map(item => [item.kind, item.channel?.label]))}`);
    const alert = await stack.ownerAlert('worker_blocker', 'tiktok', item => item.post?.id === postId, 60_000);
    assert.equal(alert.severity, 'urgent');
    // The phone push is sent by the hub's drain after the alert commits (outside the transaction), so it follows shortly.
    await until(() => stack.ntfy.pushes().some(push => `${push.title} ${push.message}`.includes('Win-C') && `${push.title} ${push.message}`.includes('@fixture_tt')),
      30_000, 'phone push naming Win-C and @fixture_tt');
    assert.equal(fixturePosts(stack, 'tiktok', caption).length, 0);
    // Out of the way of the next case.
    const cancelled = await stack.mcp<Data>('post_update', { post_id: postId, action: 'cancel' });
    assert.ok(cancelled.ok, JSON.stringify(cancelled.error));
  });

  test('E2E-2b: risk ack withdrawn at T − 60 s, hub down T − 20 s … T + 40 s: Mac-B prepares and stops before Post; never clicks', async () => {
    const caption = marker('E2E-2b assist offline');
    const at = slotAfter(120_000);
    const { posts } = await schedule(stack, { providers: ['x'], at, caption });
    const postId = posts.x.post_id;
    const jobId = await jobIdOf(stack, postId);
    await until(async () => (await jobView(stack, jobId)).timeline.some(row => row.event === 'prepared'), 90_000, 'X preflight');
    await sleepUntil(at - 60_000);
    await stack.rest('DELETE', `/hub/channels/${stack.channels.x.id}/risk-ack`);
    await until(() => localJob(stack, 'Mac-B', jobId)?.sync.mode === 'assist', 40_000, 'Mac-B synced mode=assist');
    assert.ok(Date.now() < at - 20_000, 'synced before the outage');
    await sleepUntil(at - 20_000);
    await stack.killHub('SIGKILL');
    await sleepUntil(at + 40_000);
    // While the hub was down: prepared, stopped before Post, no click.
    assert.equal(fixturePosts(stack, 'x', caption).length, 0, 'no X post');
    assert.equal(stack.fixtures.events().filter(event => event.platform === 'x' && event.event === 'post_clicked').length, 0, 'Post was never clicked');
    const local = localJob(stack, 'Mac-B', jobId);
    assert.equal(local?.blocker?.code, 'owner_click_required', `Mac-B waits for the owner: ${JSON.stringify(local)}`);
    await stack.startHub();
    const restartedAt = Date.now();
    const waiting = await waitJobStatus(stack, jobId, ['needs_owner', 'missed', 'succeeded', 'outcome_unknown'], 60_000);
    assert.equal(waiting.status, 'needs_owner');
    assert.equal(waiting.blocker?.code, 'owner_click_required');
    assert.equal(waiting.blocker?.machine_name, 'Mac-B');
    const started = waiting.timeline.find(row => row.event === 'started');
    assert.deepEqual([started?.detail.go, started?.detail.mode], ['offline', 'assist']);
    assert.ok(Date.now() - restartedAt < 60_000);
    // The mode change reached Mac-B before the outage, so this was not a stale-settings run.
    assert.ok(!stack.alerts.all().some(alert => alert.kind === 'offline_run_stale_settings' && alert.post?.id === postId));
    const notAfter = at + TIMING.latenessMin * 60_000;
    const missed = await waitJobStatus(stack, jobId, ['missed', 'succeeded', 'outcome_unknown'], notAfter - Date.now() + 90_000);
    assert.equal(missed.status, 'missed');
    assert.equal(missed.timeline.find(row => row.event === 'missed')?.detail.reason, 'owner_not_clicked');
    assert.equal((await postView(stack, postId)).post.status, 'missed');
    assert.equal(fixturePosts(stack, 'x', caption).length, 0, 'still no X post after not_after');
  });
});
