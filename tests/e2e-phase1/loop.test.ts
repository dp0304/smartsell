// E2E-1 main loop, E2E-12 dry run and E2E-9 machine change (phase1-design §10.2), on one stack, in that order.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { MachineDetail, ChannelDetail, PostDetailView, TodayView } from '../../packages/contracts/src/index.ts';
import { fixturePosts, jobIdOf, jobView, schedule, waitJobStatus, waitPostStatus } from './cases.ts';
import { marker, slotAfter, stackUnavailable, startStack, until, type Data, type Stack } from './stack.ts';

describe('E2E loop: MCP → hub → each machine → fixture platform → URL back', { skip: stackUnavailable, concurrency: false, timeout: 15 * 60_000 }, () => {
  let stack: Stack;
  before(async () => { stack = await startStack({ name: 'loop' }); });
  after(async () => { await stack?.close(); });

  test('E2E-1: overview → media_upload → one post_schedule for two channels; both post at T and every view agrees', async () => {
    // 1. What the Agent reads first.
    const overview = await stack.mcp<{ workspace: { timezone: string }; channels: { channel_id: string; provider: string; handle: string; machine: string; can_schedule: boolean }[] }>('smartsell_overview', {});
    assert.ok(overview.ok);
    assert.equal(overview.data.workspace.timezone, 'Asia/Shanghai');
    const x = overview.data.channels.find(channel => channel.provider === 'x' && channel.machine === 'Mac-B');
    const tt = overview.data.channels.find(channel => channel.provider === 'tiktok' && channel.machine === 'Win-C');
    assert.ok(x?.can_schedule && tt?.can_schedule, JSON.stringify(overview.data.channels));
    assert.equal(x.channel_id, stack.channels.x.id);
    assert.equal(tt.channel_id, stack.channels.tiktok.id);

    // 2. media_upload by absolute path: the relay reads the 30 MB file; nothing large reaches the model.
    const upload = await stack.mcp<Data>('media_upload', { path: stack.video!.path });
    assert.ok(upload.ok, JSON.stringify(upload.error));
    assert.equal(upload.data.status, 'ready');
    assert.equal(upload.data.sha256, stack.video!.sha256);
    assert.equal(upload.data.bytes, stack.video!.bytes);
    assert.ok(stack.video!.bytes > 25 * 1024 * 1024, `clip is about 30 MB (${stack.video!.bytes})`);
    assert.ok(upload.bytes < 4096, `media_upload result is small (${upload.bytes} bytes), no base64`);

    // 3. One post_schedule for both channels, `when` = now + 90 s in local wall-clock (workspace zone, timezone omitted).
    const caption = marker('E2E-1 loop');
    const at = slotAfter(90_000);
    const { result, posts } = await schedule(stack, { providers: ['x', 'tiktok'], at, caption, mediaId: String(upload.data.media_id) });
    assert.ok(stack.mcpCalls.length <= 6, `MCP calls ${stack.mcpCalls.length}`);
    assert.equal(stack.mcpCalls.filter(call => call.isError).length, 0);
    for (const [provider, machine] of [['x', 'Mac-B'], ['tiktok', 'Win-C']] as const) {
      const post = posts[provider];
      assert.equal(post.status, 'scheduled', JSON.stringify(post));
      assert.equal(post.approval, 'approved_by_channel_policy');
      assert.deepEqual([post.route.kind, post.route.machine_name, post.route.mode], ['machine', machine, 'auto']);
      assert.equal(Date.parse(post.scheduled_at), at);
      assert.match(post.local_time, /Asia\/Shanghai$/);
    }
    const ids = [posts.x.post_id, posts.tiktok.post_id];
    assert.equal(result.data.posts.length, 2);

    // views_today.upcoming: one group (the content) with both posts.
    const today = await stack.view<TodayView>('/views/today');
    const groups = today.upcoming.filter(group => group.posts.some(post => ids.includes(post.post_id)));
    assert.equal(groups.length, 1, `one content group: ${JSON.stringify(today.upcoming.map(group => group.posts.map(post => post.post_id)))}`);
    assert.deepEqual(groups[0].posts.map(post => post.post_id).sort(), [...ids].sort());

    // 4. By T + 60 s both fixture platforms have exactly one post each, with the uploaded bytes.
    await until(() => fixturePosts(stack, 'x', caption).length >= 1 && fixturePosts(stack, 'tiktok', caption).length >= 1, Math.max(0, at - Date.now()) + 60_000,
      'both fixture posts by T + 60 s', 500);
    assert.ok(Date.now() <= at + 60_000 + 1000, `posted by T + 60 s (now T + ${Math.round((Date.now() - at) / 1000)} s)`);
    for (const provider of ['x', 'tiktok'] as const) {
      const made = fixturePosts(stack, provider, caption);
      assert.equal(made.length, 1, `${provider}: exactly one post`);
      assert.equal(made[0].media_sha256, stack.video!.sha256, `${provider}: media bytes intact`);
      assert.ok(Date.parse(made[0].created_at) >= at - 60_000, `${provider} posted around T, not before go`);
    }

    // 5. The hub: both jobs succeeded with a system-verified platform_post and the URL.
    const details: PostDetailView[] = [];
    for (const id of ids) {
      const view = await waitPostStatus(stack, id, ['published'], 60_000);
      assert.equal(view.task?.status, 'succeeded');
      assert.equal(view.result?.verification, 'system_verified');
      assert.ok(view.result?.url, 'URL back at the hub');
      details.push(view);
    }
    assert.match(details[0].result!.url!, /^https:\/\/x\.com\/fixture_x\/status\/\d+$/);
    assert.match(details[1].result!.url!, /^https:\/\/www\.tiktok\.com\/@fixture_tt\/video\/\d+$/);

    // 6. Every page reads the same two posts as published, linked to each other.
    const todayAfter = await stack.view<TodayView>('/views/today');
    for (const id of ids) {
      const inToday = [...todayAfter.recent_published, ...todayAfter.upcoming.flatMap(group => group.posts)].find(post => post.post_id === id);
      assert.equal(inToday?.status, 'published', `today shows ${id}`);
    }
    for (const [index, provider] of (['x', 'tiktok'] as const).entries()) {
      const channel = stack.channels[provider];
      const machine = stack.machines[channel.machine];
      const detail = details[index];
      assert.equal(detail.post.status, 'published');
      assert.equal(detail.post.channel.id, channel.id);
      assert.equal(detail.post.machine?.id, machine.deviceId);
      assert.ok(detail.links.calendar.includes(detail.post.post_id), 'post links to its calendar event');
      assert.ok(detail.links.machine?.includes(machine.deviceId), 'post links to its machine');
      assert.ok(detail.links.channel.includes(channel.id), 'post links to its channel');
      const machineView = await stack.view<MachineDetail>(`/views/machines/${machine.deviceId}`);
      const job = [...machineView.history, ...machineView.upcoming].find(item => item.post_id === detail.post.post_id);
      assert.equal(job?.task_id, detail.task?.task_id, `${machine.name} lists the job`);
      assert.equal(job?.status, 'succeeded');
      assert.ok(machineView.channels.some(item => item.social_account_id === channel.id), `${machine.name} lists ${channel.label}`);
      const channelView = await stack.view<ChannelDetail>(`/views/channels/${channel.id}`);
      const listed = channelView.posts.find(post => post.post_id === detail.post.post_id);
      assert.equal(listed?.status, 'published', `${channel.label} lists the post`);
      assert.equal(channelView.machine?.id, machine.deviceId);
      const jobDetail = await jobView(stack, detail.task!.task_id);
      assert.equal(jobDetail.post_id, detail.post.post_id);
      assert.equal(jobDetail.machine.id, machine.deviceId);
      assert.equal(jobDetail.channel.id, channel.id);
    }
    const day = new Date(at).toISOString().slice(0, 10);
    const calendar = await stack.view<{ events: (Data & { post_id?: string; post_status?: string; machine?: { id: string }; channel?: { id: string } })[] }>(
      `/views/calendar?from=${day}&to=${day}&kinds=publish`);
    for (const [index, id] of ids.entries()) {
      const event = calendar.events.find(item => item.post_id === id);
      assert.equal(event?.post_status, 'published', `calendar shows ${id}`);
      assert.equal(event?.id, `publish:${id}`);
      assert.equal(event?.machine?.id, details[index].post.machine?.id);
      assert.equal(event?.channel?.id, details[index].post.channel.id);
    }

    // 7. The owner hears about both on the alert stream (and the phone).
    for (const provider of ['x', 'tiktok'] as const) {
      const alert = await stack.ownerAlert('published', provider, item => item.post?.id === posts[provider].post_id, 30_000);
      assert.equal(alert.severity, 'info');
    }
    assert.equal(stack.alerts.all().filter(alert => alert.kind === 'published' && ids.includes(alert.post?.id ?? '')).length, 2);
  });

  test('E2E-12: hub_channels_dry_run without media uses the bundled clip, creates no post, keeps the before_submit shot and a full driver trace', async () => {
    for (const provider of ['x', 'tiktok'] as const) {
      const channel = stack.channels[provider];
      const before = stack.fixtures.posts().length;
      const started = await stack.rest<Data>('POST', `/hub/channels/${channel.id}/dry-run`, {});
      const jobId = String(started.task_id ?? started.job_id ?? started.id);
      const job = await waitJobStatus(stack, jobId, ['succeeded', 'failed', 'needs_owner'], 180_000);
      assert.equal(job.status, 'succeeded', JSON.stringify(job.timeline.slice(-4)));
      assert.equal(job.dry_run, true);
      assert.equal(job.post_id, null, 'a dry run has no post');
      assert.equal(job.result?.dry_run, true);
      assert.equal(stack.fixtures.posts().length, before, 'nothing was posted on the platform');
      const channelView = await stack.view<ChannelDetail>(`/views/channels/${channel.id}`);
      assert.ok(channelView.readiness.dry_run_passed, `${channel.label}: dry run passed`);
      assert.ok(job.timeline.some(row => row.event === 'dry_run_done'), 'dry_run_done in the timeline');
      const dispatched = job.timeline.find(row => row.event === 'dispatched');
      assert.equal(dispatched?.detail.bundled, true, 'the payload uses the bundled test clip, not an uploaded media');
      assert.ok(!job.timeline.some(row => ['submitting', 'submitted', 'result'].includes(row.event)), 'never reached the Post click');
      // The before_submit screenshot is the dry run's evidence (§8.12: shot, then the draft is discarded).
      assert.equal(job.result?.evidence_sha256.length, 1, `before_submit evidence: ${JSON.stringify(job.result)}`);
      // driver_trace: every step of the flow, each with its selector match (§8.11); the machine page shows it.
      const machineView = await stack.view<MachineDetail>(`/views/machines/${stack.machines[channel.machine].deviceId}`);
      assert.equal(machineView.last_driver_trace?.job_id, jobId);
      const trace = machineView.last_driver_trace!.steps;
      assert.ok(trace.every(step => typeof step.step === 'string' && Number.isFinite(step.ms) && ['primary', 'fallback', 'none'].includes(step.matched)));
      assert.ok(trace.every(step => step.matched !== 'none'), `no step missed its element: ${JSON.stringify(trace)}`);
      // The bundled clip has no caption, so there is no caption step; everything else up to discarding the draft.
      const required = provider === 'x' ? ['x.ready', 'x.identity', 'x.file_input', 'x.attached', 'x.upload_done', 'x.post_button', 'x.discard']
        : ['tt.ready', 'tt.file_input', 'tt.uploaded', 'tt.caption', 'tt.visibility', 'tt.allow_comment', 'tt.allow_reuse', 'tt.post_button', 'tt.discard_confirm'];
      for (const step of required) assert.ok(trace.some(item => item.step === step), `trace has ${step}: ${trace.map(item => item.step).join(',')}`);
    }
  });

  test('E2E-9: (a) rebinding TikTok to Mac-B before the claim moves the job there and Mac-B posts; (b) rebinding after a claim is 409 CHANNEL_HAS_ACTIVE_JOBS', async () => {
    const tiktok = stack.channels.tiktok;
    const macB = stack.machines['Mac-B'];
    const winC = stack.machines['Win-C'];
    // (a) Win-C cannot claim: it is cut off from the hub before the post exists.
    stack.partition('Win-C', true);
    const caption = marker('E2E-9a rebind');
    const at = slotAfter(150_000);
    const { posts } = await schedule(stack, { providers: ['tiktok'], at, caption });
    const jobId = await jobIdOf(stack, posts.tiktok.post_id);
    assert.equal((await jobView(stack, jobId)).status, 'queued');
    await stack.rest('PUT', `/hub/channels/${tiktok.id}/machine`, { device_id: macB.deviceId, owned_account_confirmed: true });
    const moved = await jobView(stack, jobId);
    assert.equal(moved.machine.id, macB.deviceId, 'the queued job moved to Mac-B');
    const posted = await waitPostStatus(stack, posts.tiktok.post_id, ['published', 'needs_owner', 'failed', 'missed'], Math.max(0, at - Date.now()) + 120_000);
    assert.equal(posted.post.status, 'published', JSON.stringify(posted.task?.timeline.slice(-5)));
    assert.equal(posted.post.machine?.id, macB.deviceId, 'Mac-B posted it');
    assert.equal(fixturePosts(stack, 'tiktok', caption).length, 1);

    // (b) A post claimed by Mac-B: moving the channel back to Win-C is refused while the job is live.
    stack.partition('Win-C', false);
    const second = marker('E2E-9b rebind');
    const { posts: later } = await schedule(stack, { providers: ['tiktok'], at: slotAfter(10 * 60_000), caption: second });
    const laterJob = await jobIdOf(stack, later.tiktok.post_id);
    await waitJobStatus(stack, laterJob, ['claimed', 'ready'], 60_000);
    const refused = await stack.restRaw('PUT', `/hub/channels/${tiktok.id}/machine`, { device_id: winC.deviceId, owned_account_confirmed: true });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal((refused.body.error as Data | undefined)?.code ?? refused.body.code, 'CHANNEL_HAS_ACTIVE_JOBS');
    const still = await jobView(stack, laterJob);
    assert.equal(still.machine.id, macB.deviceId, 'the claimed job stays on Mac-B');
    // Clean up: cancel the far post so nothing else runs on this stack.
    const cancel = await stack.mcp<Data>('post_update', { post_id: later.tiktok.post_id, action: 'cancel' });
    assert.ok(cancel.ok, JSON.stringify(cancel.error));
  });
});
