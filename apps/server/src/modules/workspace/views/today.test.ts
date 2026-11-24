import assert from 'node:assert/strict';
import test from 'node:test';
import type { Input } from '@smartsell/contracts';
import { calendarView } from './calendar.js';
import { channelDetail, channelSummaries } from './channels.js';
import { viewWorld } from './hub-fixture.js';
import { machineDetail } from './machines.js';
import { postDetail } from './posts.js';
import { buildOverview, buildToday } from './today.js';

const TOMORROW_9 = '2026-11-25T09:00:00.000Z';

test('upcoming groups one schedule by content and includes tomorrow; just scheduled by the Agent is flagged', async () => {
  const w = viewWorld();
  const { x, tiktok } = await w.scheduleBoth(TOMORROW_9);
  w.set('publish_target', x.id, { created_via: 'agent' });
  w.set('publish_target', tiktok.id, { created_via: 'agent' });
  const today = buildToday(w.ctx);
  assert.equal(today.upcoming.length, 1);
  const [group] = today.upcoming;
  assert.deepEqual(group.posts.map(post => [post.channel.label, post.machine?.name, post.mode, post.status, post.local_time]), [
    ['X @lurelab', 'Mac-B', 'auto', 'scheduled', '2026-11-25 09:00'],
    ['TikTok @lurelab_tt', 'Win-C', 'assist', 'awaiting_approval', '2026-11-25 09:00'],
  ]);
  assert.equal(group.title, 'video.mp4');
  assert.equal(group.just_scheduled, true);
  assert.equal(group.caption_excerpt, 'New lure test');
  assert.equal(today.date, '2026-11-24');
  assert.equal(buildToday(w.ctx, 'Pacific/Kiritimati').date, '2026-11-25');
  const approval = today.attention.find(item => item.kind === 'approval');
  assert.equal(approval?.post?.id, tiktok.id);
  assert.match(approval!.detail, /請在 11-25 09:30 前核准，之後這則不會發出/);
  assert.deepEqual(today.counts, { scheduled: 0, published: 0, needs_owner: 0, missed: 0, unknown: 0 });
  w.advance(3 * 3_600_000);
  assert.equal(buildToday(w.ctx).upcoming[0].just_scheduled, false);
});

test('attention: a captcha card names the machine and account; an offline machine with waiting posts; machine setup warnings', async () => {
  const w = viewWorld();
  const post = await w.schedule('2026-11-24T13:00:00.000Z');
  const job = w.jobOf(post.id);
  w.claim();
  w.report(job.id, 'prepare_blocked', { stage: 'preflight', blocker: { code: 'captcha', phase: 'prepare', message: 'captcha', at: w.ctx.now } });
  w.set('connector_device', w.other.id, { posture: { os: 'win32', os_version: '11', sleep_idle_min: 0, on_battery: false, auto_login: 'off', filevault: 'n/a', power_plan_sleep_min: 30 } });
  const today = buildToday(w.ctx);
  const card = today.attention.find(item => item.kind === 'job_blocker')!;
  assert.equal(card.severity, 'urgent');
  assert.equal(card.machine?.label, 'Mac-B');
  assert.equal(card.channel?.label, 'X @lurelab');
  assert.match(card.detail, /Mac-B 的 X @lurelab 出現驗證碼.*自動繼續/);
  assert.equal(card.detail.match(/自動繼續/g)?.length, 1, 'the auto-resume note is not repeated');
  assert.equal(today.attention.some(item => item.kind === 'login'), false, 'the captcha card covers the channel login state');
  assert.equal(today.counts.needs_owner, 1);
  const setup = today.attention.find(item => item.kind === 'machine_setup')!;
  assert.equal(setup.machine?.label, 'Win-C');
  assert.match(setup.detail, /Win-C 閒置 30 分鐘會睡眠/);
  assert.match(setup.detail, /Win-C 重開機後要有人登入/);
  assert.equal(today.attention[0].severity, 'urgent');

  const offline = viewWorld();
  await offline.schedule('2026-11-24T13:30:00.000Z');
  offline.set('connector_device', offline.device.id, { last_seen_at: '2026-11-24T11:00:00.000Z' });
  const card2 = buildToday(offline.ctx).attention.find(item => item.kind === 'machine_offline')!;
  assert.equal(card2.title, 'Mac-B 離線，1 則貼文等待中，最早 11-24 13:30');
  assert.equal(card2.severity, 'urgent');
});

test('the five views compute the same status and link to each other after a post is published (E2E-1 views)', async () => {
  const w = viewWorld();
  const post = await w.schedule('2026-11-24T12:30:00.000Z');
  w.publishNow(w.jobOf(post.id).id);
  const detail = postDetail(w.ctx, post.id);
  assert.equal(detail.post.status, 'published');
  const today = buildToday(w.ctx);
  assert.deepEqual(today.recent_published.map(row => [row.post_id, row.status, row.url]), [[post.id, 'published', detail.result!.url]]);
  assert.equal(today.counts.published, 1);
  const machine = machineDetail(w.ctx, w.device.id);
  assert.deepEqual(machine.history.map(row => [row.post_id, row.status, row.url]), [[post.id, 'succeeded', detail.result!.url]]);
  const channel = channelDetail(w.ctx, w.account.id);
  assert.deepEqual(channel.posts.map(row => [row.post_id, row.status]), [[post.id, 'published']]);
  assert.equal(channel.published_today, 1);
  const calendar = calendarView(w.ctx, { body: {}, params: {}, query: { from: '2026-11-24', to: '2026-11-24', kinds: 'publish' } } as Input);
  const event = calendar.events.find(item => item.id === `publish:${post.id}`)!;
  assert.deepEqual([event.post_status, event.status, event.url, event.machine?.name, event.channel?.handle, event.title],
    ['published', 'published', detail.result!.url, 'Mac-B', 'lurelab', 'X @lurelab · New lure test']);
  assert.equal(detail.links.channel, channel.web_url);
  assert.equal(detail.links.machine, machine.web_url);
  assert.match(detail.links.calendar, /calendar\?view=week&week=2026-11-23&event=publish:/);
  assert.equal(buildOverview(w.ctx).today.published, 1);
  assert.equal(channelSummaries(w.ctx).find(row => row.channel_id === w.account.id)!.published_today, 1);
});

test('E21 login cards: 「重新登入」 (open_login) comes first and the copy no longer sends the owner to the Worker App', async () => {
  const w = viewWorld();
  const session = w.ctx.list('browser_session').find(row => row.social_account_id === w.account.id)!;
  const openLogin = { kind: 'open_login', label: '重新登入', method: 'POST', path: `/hub/channels/${w.account.id}/check`, body: { open_login_window: true } };
  const checkLogin = { kind: 'check_login', label: '檢查登入', method: 'POST', path: `/hub/channels/${w.account.id}/check`, body: {} };
  const loginCard = () => buildToday(w.ctx).attention.find(item => item.kind === 'login' && item.channel?.id === w.account.id)!;

  w.set('browser_session', session.id, { status: 'login_required' });
  let card = loginCard();
  assert.equal(card.id, `login:${w.account.id}`);
  assert.equal(card.detail, 'Mac-B 上的 X @lurelab 登入已失效，排到這個帳號的貼文發不出去。按「重新登入」，Mac-B 會開啟這個帳號的 SmartSell Chrome 登入視窗，請到 Mac-B 登入。');
  assert.deepEqual(card.actions, [openLogin, checkLogin, { kind: 'open', label: '開啟帳號' }]);
  assert.equal(card.blocks_scheduling, false, 'a sign-in problem never stops scheduling');
  for (const status of ['identity_mismatch', 'challenge']) {
    w.set('browser_session', session.id, { status });
    card = loginCard();
    assert.deepEqual(card.actions[0], openLogin, status);
    assert.match(card.detail, /「重新登入」.*Mac-B/, status);
  }
  w.set('browser_session', session.id, { status: 'verified' });

  // A post stopped on an expired login: the post card is the channel's login card.
  const post = await w.schedule('2026-11-24T13:00:00.000Z');
  const job = w.jobOf(post.id);
  w.claim();
  w.report(job.id, 'prepare_blocked', { stage: 'preflight', blocker: { code: 'login_expired', phase: 'prepare', message: 'login expired', at: w.ctx.now } });
  const today = buildToday(w.ctx);
  const cards = today.attention.filter(item => item.kind === 'login');
  assert.deepEqual(cards.map(item => item.id), [`post:${post.id}`], 'one login card per channel');
  assert.deepEqual(cards[0].actions.map(action => action.kind), ['open_login', 'check_login', 'open']);
  assert.deepEqual(cards[0].actions[0], openLogin);
  assert.match(cards[0].detail, /按「重新登入」，Mac-B 會開啟這個帳號的 SmartSell Chrome 登入視窗，請到 Mac-B 登入；登入後這裡會自動更新。$/);
  for (const item of today.attention) assert.doesNotMatch(`${item.title} ${item.detail}`, /SmartSell Worker 按/, item.id);
});

test('E30: a channel blocker and a setup reminder are separate cards; only the blocker stops scheduling', async () => {
  const w = viewWorld();
  const xCards = () => buildOverview(w.ctx).needs_owner.filter(item => item.kind === 'channel_setup' && item.channel?.id === w.account.id);
  // Ready to post, only no dry run yet: a suggestion that says it changes nothing.
  let [reminder, ...rest] = xCards();
  assert.equal(rest.length, 0);
  assert.deepEqual([reminder.id, reminder.severity, reminder.blocks_scheduling, reminder.title],
    [`channel:${w.account.id}:reminder`, 'normal', false, '建議：X @lurelab 試跑一次']);
  assert.match(reminder.detail, /不影響排程與發布。$/);
  assert.doesNotMatch(`${reminder.title} ${reminder.detail}`, /還沒設定完成/);
  assert.deepEqual(reminder.actions, [{ kind: 'open', label: '開啟帳號設定' }]);

  // An unconfirmed approval mode and login are reminders too, worded with what happens until the owner acts.
  const settings = w.ctx.list('channel_settings').find(row => row.social_account_id === w.account.id)!;
  w.set('channel_settings', settings.id, { approval_mode: 'needs_approval', approval_mode_confirmed_at: null });
  const session = w.ctx.list('browser_session').find(row => row.social_account_id === w.account.id)!;
  w.set('browser_session', session.id, { status: 'unknown' });
  [reminder, ...rest] = xCards();
  assert.equal(rest.length, 0);
  assert.equal(reminder.title, 'X @lurelab 的設定提醒（3 項，不影響排程）');
  assert.match(reminder.detail, /^還沒確認登入：按「檢查登入」確認。發文時 Mac-B 會先檢查登入，沒有登入的話那則貼文會停下來等你登入；/);
  assert.match(reminder.detail, /還沒選擇核准方式：在你選擇之前，每則貼文都要你核准後才會發出；/);
  assert.match(reminder.detail, /還沒試跑：建議試跑一次，確認 Mac-B 能替這個帳號發文（不影響排程與發布）。$/);
  assert.deepEqual(reminder.actions.map(action => action.kind), ['check_login', 'open']);
  assert.equal(reminder.blocks_scheduling, false);
  w.set('channel_settings', settings.id, { approval_mode: 'direct', approval_mode_confirmed_at: w.ctx.now });
  w.set('browser_session', session.id, { status: 'verified' });

  // A paused machine is a blocker (channels[].blockers, can_schedule false): its own card, urgent while posts are upcoming.
  await w.schedule('2026-11-24T13:00:00.000Z');
  w.set('connector_device', w.device.id, { paused: true });
  const cards = xCards();
  assert.deepEqual(cards.map(item => [item.id, item.blocks_scheduling, item.severity]),
    [[`channel:${w.account.id}`, true, 'urgent'], [`channel:${w.account.id}:reminder`, false, 'normal']]);
  assert.equal(cards[0].title, 'X @lurelab 還沒設定完成，還不能排程（1 項）');
  assert.match(cards[0].detail, /Mac-B 已暫停/);
  assert.doesNotMatch(cards[0].detail, /試跑/);
  assert.equal(channelSummaries(w.ctx).find(row => row.channel_id === w.account.id)!.can_schedule, false);

  // A passed dry run removes the reminder; every other card says it does not stop scheduling.
  w.set('connector_device', w.device.id, { paused: false });
  w.ctx.create('worker_job', { kind: 'publish_post', dry_run: true, status: 'succeeded', social_account_id: w.account.id, device_id: w.device.id, finished_at: w.ctx.now });
  assert.deepEqual(xCards(), []);
  for (const item of buildToday(w.ctx).attention) assert.equal(item.blocks_scheduling, /^channel:[^:]+$/.test(item.id), item.id);
});
