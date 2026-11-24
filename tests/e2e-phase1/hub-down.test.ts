// E2E-2 (hub down at T: Mac-B posts X offline on time, reports after recovery) and E2E-2c (TikTok paused before the
// outage: Win-C holds through it and ends missed{paused}), on one stack sharing one hub outage (phase1-design §10.2).
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fixturePosts, jobIdOf, jobView, localJob, postView, schedule, waitJobStatus } from './cases.ts';
import { marker, sleep, sleepUntil, slotAfter, stackUnavailable, startStack, TIMING, until, type Data, type Stack } from './stack.ts';

describe('E2E hub outage: offline go on time, holds survive the outage', { skip: stackUnavailable, concurrency: false, timeout: 15 * 60_000 }, () => {
  let stack: Stack;
  let at = 0;
  const caption = { x: marker('E2E-2 offline'), tiktok: marker('E2E-2c paused') };
  const post = { x: '', tiktok: '' };
  const job = { x: '', tiktok: '' };
  let pauseId = '';
  let restartedAt = 0;

  before(async () => { stack = await startStack({ name: 'hub-down' }); });
  after(async () => { await stack?.close(); });

  test('schedule X (auto, Mac-B) and TikTok (Win-C) at the same T; both claimed and prepared', async () => {
    at = slotAfter(120_000);
    const { posts } = await schedule(stack, { providers: ['x'], at, caption: caption.x });
    const { posts: tt } = await schedule(stack, { providers: ['tiktok'], at, caption: caption.tiktok });
    post.x = posts.x.post_id; post.tiktok = tt.tiktok.post_id;
    job.x = await jobIdOf(stack, post.x);
    job.tiktok = await jobIdOf(stack, post.tiktok);
    for (const id of [job.x, job.tiktok]) {
      await until(async () => (await jobView(stack, id)).timeline.some(row => row.event === 'prepared'), 90_000, `preflight of ${id}`);
    }
  });

  test('E2E-2c: publishing_pause{scope:channel} on TikTok at T − 60 s reaches Win-C in its next heartbeat (hold)', async () => {
    await sleepUntil(at - 60_000);
    const paused = await stack.mcp<Data>('publishing_pause', { scope: 'channel', id: stack.channels.tiktok.id, reason: 'E2E-2c pause before the outage' });
    assert.ok(paused.ok, JSON.stringify(paused.error));
    pauseId = String(paused.data.pause_id);
    // "Wait one heartbeat": the runner's own job store must hold the paused state before the hub goes away.
    await until(() => { const local = localJob(stack, 'Win-C', job.tiktok); return local?.sync.hold === true && local.sync.hold_reason === 'paused' && local; },
      40_000, 'Win-C synced hold=paused');
    assert.ok(Date.now() < at - 20_000, 'synced before the outage');
    assert.equal(localJob(stack, 'Mac-B', job.x)?.sync.hold, false, 'X is not held');
  });

  test('the hub is killed at T − 20 s and restarted at T + 40 s', async () => {
    await sleepUntil(at - 20_000);
    await stack.killHub('SIGKILL');
    await sleepUntil(at + 40_000);
    await stack.startHub();
    restartedAt = Date.now();
  });

  test('E2E-2: X went out offline at T ± 15 s, and within 60 s of the restart the job is succeeded with go_source offline', async () => {
    const made = fixturePosts(stack, 'x', caption.x);
    assert.equal(made.length, 1, 'exactly one X post, made while the hub was down');
    const createdAt = Date.parse(made[0].created_at);
    assert.ok(Math.abs(createdAt - at) <= 15_000, `created at T ${createdAt - at >= 0 ? '+' : ''}${(createdAt - at) / 1000} s`);
    assert.equal(made[0].media_sha256, stack.video!.sha256);
    const done = await waitJobStatus(stack, job.x, ['succeeded'], Math.max(5_000, restartedAt + 60_000 - Date.now()));
    assert.ok(Date.now() <= restartedAt + 61_000, 'succeeded within 60 s of the restart');
    const view = await postView(stack, post.x);
    assert.equal(view.post.status, 'published');
    assert.equal(view.task?.go_source, 'offline');
    assert.equal(view.result?.verification, 'system_verified');
    const started = done.timeline.find(row => row.event === 'started');
    assert.equal(started?.detail.go, 'offline');
    assert.ok(!done.timeline.some(row => row.event === 'go'), 'the hub never answered go: it was down');
  });

  test('E2E-2c: no TikTok post; after the restart the job is still held; at not_after it is missed{paused}; releasing the pause posts nothing', async () => {
    assert.equal(fixturePosts(stack, 'tiktok', caption.tiktok).length, 0);
    await stack.nextHeartbeat('Win-C', 60_000);
    const local = localJob(stack, 'Win-C', job.tiktok);
    assert.equal(local?.sync.hold, true, 'still held after the hub came back');
    assert.ok(Date.parse(local!.sync.synced_at) >= restartedAt, 'synced from the restarted hub');
    const live = await jobView(stack, job.tiktok);
    assert.ok(['claimed', 'ready'].includes(live.status), `job waits (${live.status})`);
    const notAfter = at + TIMING.latenessMin * 60_000;
    const missed = await waitJobStatus(stack, job.tiktok, ['missed', 'succeeded', 'cancelled', 'failed', 'outcome_unknown'], notAfter - Date.now() + 90_000);
    assert.equal(missed.status, 'missed');
    const event = missed.timeline.find(row => row.event === 'missed');
    assert.equal(event?.detail.reason, 'paused', JSON.stringify(event));
    assert.ok(Date.parse(event!.at) >= notAfter - 1000, 'not before not_after');
    assert.equal((await postView(stack, post.tiktok)).post.status, 'missed');
    assert.equal(fixturePosts(stack, 'tiktok', caption.tiktok).length, 0, 'nothing was posted while paused');
    await stack.rest('POST', `/pause-switches/${pauseId}/release`, {});
    await sleep(20_000);
    assert.equal(fixturePosts(stack, 'tiktok', caption.tiktok).length, 0, 'releasing the pause does not re-post');
    assert.equal((await postView(stack, post.tiktok)).post.status, 'missed');
    const alert = await stack.ownerAlert('missed', 'tiktok', item => item.post?.id === post.tiktok, 30_000);
    assert.equal(alert.severity, 'urgent');
  });

  test('E2E-2: the hub recorded every fact in order, seq continuous per fencing token, each event once', async () => {
    await stack.killHub('SIGTERM');
    const records = stack.records();
    const events = records.list('worker_job_event').filter(row => row.job_id === job.x);
    const device = events.filter(row => typeof row.seq === 'number').sort((a, b) => (a.fencing_token as number) - (b.fencing_token as number) || (a.seq as number) - (b.seq as number));
    assert.ok(device.length >= 6, JSON.stringify(device.map(row => row.event)));
    const byFence = Map.groupBy(device, row => Number(row.fencing_token));
    for (const [fence, rows] of byFence) {
      assert.deepEqual(rows.map(row => row.seq), rows.map((_row, index) => index + 1), `fence ${fence}: seq 1..n without gaps`);
    }
    assert.equal(new Set(device.map(row => row.event_id)).size, device.length, 'each event_id recorded once');
    const order = device.map(row => String(row.event)).filter(name => ['started', 'submitting', 'submitted', 'result'].includes(name));
    assert.deepEqual(order, ['started', 'submitting', 'submitted', 'result']);
    const prepared = device.filter(row => row.event === 'prepared').map(row => (row.detail as Data).stage);
    assert.deepEqual(prepared, ['preflight', 'final'], 'preflight then final prepare before the outage');
    const jobRow = records.get('worker_job', job.x)!;
    assert.equal(jobRow.status, 'succeeded');
    assert.equal(jobRow.go_source, 'offline');
    assert.equal(records.list('worker_job').filter(row => row.publish_target_id === post.x).length, 1, 'no second job for the X post');
    await stack.startHub();
  });
});
