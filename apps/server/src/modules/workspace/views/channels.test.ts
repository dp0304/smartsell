import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOMATION_NOTICE_VERSION, RISK_TERMS, RISK_TERMS_VERSION } from '@smartsell/contracts';
import { channelDetail, channelSummaries } from './channels.js';
import { viewWorld } from './hub-fixture.js';
import { buildToday } from './today.js';

test('channel readiness checklist, blockers and the effective mode', async () => {
  const w = viewWorld();
  const [tiktok, x] = channelSummaries(w.ctx);
  assert.deepEqual([x.provider, x.effective_mode, x.approval_mode, x.risk_ack_current, x.can_schedule, x.machine?.name], ['x', 'auto', 'direct', true, true, 'Mac-B']);
  assert.deepEqual(x.readiness, { logged_in: true, automation_notice: true, defaults_ready: true, approval_mode_chosen: true, risk_ack_or_assist: true, dry_run_passed: false });
  assert.deepEqual([tiktok.provider, tiktok.effective_mode, tiktok.risk_ack_required, tiktok.risk_ack_current, tiktok.readiness.risk_ack_or_assist], ['tiktok', 'assist', true, false, false]);
  const settings = w.ctx.list('channel_settings').find(row => row.social_account_id === w.tiktok.id)!;
  w.set('channel_settings', settings.id, { platform_defaults: {}, automation_notice_ack: null });
  const blocked = channelSummaries(w.ctx, { provider: 'tiktok' })[0];
  assert.deepEqual(blocked.blockers.map(item => item.code), ['automation_notice_missing', 'channel_defaults_missing']);
  assert.equal(blocked.can_schedule, false);
  // E30: the blockers (can_schedule false) and the setup reminders are separate channel_setup cards.
  const cards = buildToday(w.ctx).attention.filter(item => item.kind === 'channel_setup' && item.channel?.id === w.tiktok.id);
  assert.deepEqual(cards.map(item => [item.id, item.blocks_scheduling]), [[`channel:${w.tiktok.id}`, true], [`channel:${w.tiktok.id}:reminder`, false]]);
  const [card, reminder] = cards;
  assert.equal(card.title, 'TikTok @lurelab_tt 還沒設定完成，還不能排程（2 項）');
  assert.match(card.detail, /自動化告知/);
  assert.match(card.detail, /預設選項/);
  assert.doesNotMatch(card.detail, /試跑/);
  assert.equal(reminder.title, 'TikTok @lurelab_tt 的設定提醒（2 項，不影響排程）');
  assert.match(reminder.detail, /還沒確認代按發布的風險：在你確認之前，到發文時間要你在 Win-C 自己按「發布」/);
  assert.match(reminder.detail, /還沒試跑：.*（不影響排程與發布）/);
  assert.deepEqual(channelSummaries(w.ctx, { machine_id: w.device.id }).map(row => row.channel_id), [w.account.id]);
});

test('channel detail carries the risk terms, the automation notice, the pause and the posts', async () => {
  const w = viewWorld();
  await w.schedule('2026-11-24T13:00:00.000Z');
  const detail = channelDetail(w.ctx, w.account.id);
  assert.deepEqual(detail.risk_terms, { version: RISK_TERMS_VERSION, ...RISK_TERMS.x });
  assert.equal(detail.automation_notice.version, AUTOMATION_NOTICE_VERSION);
  assert.equal(detail.automation_notice.ack?.via, 'worker_app');
  assert.equal(detail.settings.social_account_id, w.account.id);
  assert.equal(detail.posts.length, 1);
  assert.equal(detail.scheduled_today, 1);
  assert.equal(detail.next_post?.local_time, '2026-11-24 13:00');
  w.ctx.create('pause_switch', { scope_type: 'social_account', scope_id: w.account.id, reason: '檢查文案', mode: 'hold', activated_at: w.ctx.now, activated_by: 'owner', created_via: 'agent' });
  const paused = channelDetail(w.ctx, w.account.id).pause!;
  assert.deepEqual([paused.scope, paused.reason, paused.by], ['social_account', '檢查文案', 'agent']);
  assert.match(paused.resume_web_url, /\/settings#st-pause$/);
  assert.throws(() => channelDetail(w.ctx, 'nope'), (error: { status?: number; code?: string }) => error.status === 404 && error.code === 'CHANNEL_NOT_FOUND');
});
