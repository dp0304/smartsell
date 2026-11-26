import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Problem, type OwnerAlert, type Row } from '@smartsell/contracts';
import type { Context } from '@smartsell/contracts';
import { reportJob } from '../worker/device-jobs.js';
import { setJob } from '../worker/model.js';
import { resetPresence } from '../worker/presence.js';
import { alertFixture, job, post, seedHub, type AlertFixture } from './fixtures.js';
import { alertUploadFailed, applyAlertEvent, raiseAlert, scanAlertReminders, subscribers } from './index.js';
import { configureAlerts, resetAlertHooks } from './model.js';
import { createAlertsDrain } from './push.js';
import { createOwnerAlert } from './raise.js';
import { alertReminderSchedule } from './reminders.js';

const T = '2026-11-25T01:00:00.000Z';   // 09:00 in Asia/Shanghai
const status = (f: AlertFixture, row: Row, to: string, extra: Record<string, unknown> = {}) => {
  f.ctx.update('worker_job', row.id, { status: to, ...extra });
  return applyAlertEvent(f.ctx, 'worker.job.status_changed', { job_id: row.id, from: row.status, to, publish_target_id: row.publish_target_id,
    social_account_id: row.social_account_id, device_id: row.device_id, blocker_code: (extra.blocker as { code?: string } | undefined)?.code ?? null });
};
const blocker = (code: string, f: AlertFixture, machine = 'Mac-B', channel = 'X @fixture_x') => ({ code, phase: 'prepare', message: 'device text',
  resumable_by: 'auto', machine_id: 'm', machine_name: machine, social_account_id: 's', channel_label: channel, at: f.ctx.now });
const kinds = (f: AlertFixture) => f.alerts().map(row => row.kind);

test('C13 raiseAlert dedupes per (kind, dedupe_key), mirrors into the bell feed and validates programming errors', () => {
  const f = alertFixture();
  const { macB, x } = seedHub(f);
  const input = { kind: 'worker_blocker' as const, severity: 'urgent' as const, dedupe_key: 'job-1:captcha', title: 'Mac-B 的 X @fixture_x：出現驗證碼。', body: 'b',
    machine_id: macB.id, social_account_id: x.id };
  assert.equal(raiseAlert(f.ctx, input), undefined);
  raiseAlert(f.ctx, input);
  raiseAlert(f.ctx, { ...input, kind: 'missed' });   // same key, another kind: a separate alert
  assert.deepEqual(kinds(f), ['worker_blocker', 'missed']);
  const [first] = f.alerts();
  assert.equal(first!.seq, 1);
  assert.equal(first!.machine_label, 'Mac-B');
  assert.equal(first!.channel_label, 'X @fixture_x');
  assert.match(String(first!.web_url), /\/app\/ws-1\/channels\//);
  // Only the owner (not the viewer) gets the in-app mirror.
  assert.deepEqual(f.ctx.list('notification').map(row => [row.recipient_user_id, row.type]), [['owner-1', 'owner_alert'], ['owner-1', 'owner_alert']]);
  assert.ok(f.events.some(event => event.type === 'alerts.owner_alert.created'));
  assert.throws(() => raiseAlert(f.ctx, { ...input, kind: 'nope' as never }), (error: unknown) => error instanceof Problem && error.status === 422);
  assert.throws(() => raiseAlert(f.ctx, { ...input, dedupe_key: ' ' }), (error: unknown) => error instanceof Problem && error.status === 422);
  // A missing machine/channel/post never throws (S3 calls this from fact handlers that must not fail).
  raiseAlert(f.ctx, { ...input, dedupe_key: 'ghost', machine_id: 'gone', social_account_id: 'gone', post_id: 'gone' });
  assert.equal(f.alerts().at(-1)!.machine_label, '機器');
});

test('worker_blocker: every needs_owner names the machine and account; same blocker once, a new code or a resume alerts again', () => {
  const f = alertFixture();
  const { macB, x, winC, tt } = seedHub(f);
  const target = post(f, x, T);
  const captcha = job(f, { device: macB, account: x, target, notBefore: T, status: 'claimed' });
  status(f, captcha, 'needs_owner', { blocker: blocker('captcha', f) });
  const [alert] = f.alerts();
  assert.equal(alert!.kind, 'worker_blocker');
  assert.equal(alert!.severity, 'urgent');
  assert.match(String(alert!.title), /Mac-B/);
  assert.match(String(alert!.title), /@fixture_x/);
  assert.equal(alert!.body, 'Mac-B 的 X @fixture_x 出現驗證碼，已停止。請到 Mac-B 的 SmartSell Chrome 視窗完成驗證；完成後會自動繼續（不會重新整理頁面），截止 09:30。');
  assert.equal(alert!.post_id, target.id);
  status(f, captcha, 'needs_owner', { blocker: blocker('captcha', f) });   // repeated report
  status(f, captcha, 'claimed');
  status(f, captcha, 'needs_owner', { blocker: blocker('captcha', f) });   // same blocker again on the same job
  assert.equal(f.alerts().length, 1);
  status(f, captcha, 'needs_owner', { blocker: blocker('risk_prompt', f), resume_token: 0 });
  status(f, captcha, 'needs_owner', { blocker: blocker('risk_prompt', f), resume_token: 1 });   // owner pressed 恢復 and it blocked again
  assert.equal(f.alerts().length, 3);
  // Preflight login expiry on the other machine (E2E-5).
  const tiktok = job(f, { device: winC, account: tt, target: post(f, tt, T), notBefore: T, status: 'claimed' });
  status(f, tiktok, 'needs_owner', { blocker: blocker('login_expired', f, 'Win-C', 'TikTok @fixture_tt') });
  const login = f.alerts().at(-1)!;
  assert.match(String(login.body), /^Win-C 的 TikTok @fixture_tt 登入已過期/);
  // A job that failed before sending (e.g. platform rejected the upload) is a blocker alert too; the owner's own mark-not-published is not.
  const rejected = job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'running' });
  status(f, rejected, 'failed', { blocker: { ...blocker('upload_rejected', f), message: 'Video too long' } });
  assert.match(String(f.alerts().at(-1)!.body), /拒絕了這支影片：「Video too long」/);
  // hub_posts_mark_not_published sets owner_marked_not_published (worker/index.ts); only that ends silently (AO-7).
  const owned = job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'outcome_unknown' });
  const before = f.alerts().length;
  status(f, owned, 'failed', { owner_marked_not_published: true });
  assert.equal(f.alerts().length, before);
});

test('missed, unknown and published follow the job; dry runs never alert as posts; published can be switched off', () => {
  const f = alertFixture();
  const { winC, tt, macB, x } = seedHub(f);
  const missed = job(f, { device: winC, account: tt, target: post(f, tt, T), notBefore: T, status: 'ready' });
  f.ctx.create('worker_job_event', { job_id: missed.id, at: f.ctx.now, event: 'missed', actor: 'device', detail: { reason: 'machine_was_off' } });
  status(f, missed, 'missed');
  status(f, missed, 'missed');
  const alert = f.alerts().at(-1)!;
  assert.equal(alert.kind, 'missed');
  assert.match(String(alert.title), /Win-C/);
  assert.match(String(alert.title), /@fixture_tt/);
  assert.match(String(alert.body), /Win-C 在 09:30 前沒有開始（機器當時沒有開機或沒有連線），這則沒有發出。/);
  assert.equal(kinds(f).filter(kind => kind === 'missed').length, 1);

  const paused = job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'ready' });
  f.ctx.create('pause_switch', { scope_type: 'social_account', scope_id: x.id, status: 'active', created_via: 'agent' });
  f.ctx.create('worker_job_event', { job_id: paused.id, at: f.ctx.now, event: 'missed', actor: 'device', detail: { reason: 'paused' } });
  status(f, paused, 'missed');
  assert.match(String(f.alerts().at(-1)!.body), /這則沒有發出，因為這個帳號在 08:00 被 Agent 暫停/);

  const unknown = job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'running' });
  status(f, unknown, 'unreported');
  status(f, unknown, 'outcome_unknown');
  status(f, unknown, 'outcome_unknown');
  const unknowns = f.alerts().filter(row => row.kind === 'unknown');
  assert.equal(unknowns.length, 2);
  assert.match(String(unknowns[0]!.body), /Mac-B 未回報 09:00 的 X @fixture_x 貼文（目前離線）/);
  assert.match(String(unknowns[1]!.body), /Mac-B 已點擊發布，但讀不到 X @fixture_x 的貼文網址/);

  const target = post(f, x, T);
  const done = job(f, { device: macB, account: x, target, notBefore: T, status: 'result_pending' });
  status(f, done, 'succeeded', { result: { url: 'https://x.com/fixture_x/status/1', published_at: T } });
  status(f, done, 'succeeded');
  const published = f.alerts().filter(row => row.kind === 'published');
  assert.equal(published.length, 1);
  assert.equal(published[0]!.severity, 'info');
  assert.equal(published[0]!.title, 'X @fixture_x 已由 Mac-B 在 09:00 發出。');

  const dry = job(f, { device: macB, account: x, target: null, notBefore: T, status: 'running', dry_run: true });
  const count = f.alerts().length;
  status(f, dry, 'succeeded', { result: { dry_run: true } });
  status(f, dry, 'missed');
  assert.equal(f.alerts().length, count);

  f.ctx.role = 'owner';
  f.run('hub_alerts_update_channels', { body: { preferences: { published: false } } });
  const later = job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'result_pending' });
  status(f, later, 'succeeded');
  assert.equal(f.alerts().length, count);
});

test('late_fact_after_release: the late fact and the auto-cancelled successor produce one urgent alert', () => {
  const f = alertFixture();
  const { macB, x } = seedHub(f);
  const target = post(f, x, T);
  const old = job(f, { device: macB, account: x, target, notBefore: T, status: 'succeeded', result: { fence_override: true } });
  const successor = job(f, { device: macB, account: x, target, notBefore: T, status: 'queued', waits_for_job_id: old.id });
  applyAlertEvent(f.ctx, 'worker.job.late_fact', { job_id: old.id, publish_target_id: target.id, successor_cancelled: true });
  f.ctx.create('worker_job_event', { job_id: successor.id, at: f.ctx.now, event: 'successor_cancelled_predecessor_posted', actor: 'hub', detail: {} });
  status(f, successor, 'cancelled');
  const late = f.alerts().filter(row => row.kind === 'late_fact_after_release');
  assert.equal(late.length, 1);
  assert.equal(late[0]!.severity, 'urgent');
  assert.equal(late[0]!.body, 'Mac-B 在撤回後仍發出了 X @fixture_x 的舊版本；新版本已自動取消，不會再發。請到貼文頁確認。');
  // A successor the owner cancelled (no successor_cancelled_predecessor_posted event) is not a late fact.
  const other = job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'queued', waits_for_job_id: 'x' });
  status(f, other, 'cancelled');
  assert.equal(f.alerts().filter(row => row.kind === 'late_fact_after_release').length, 1);
});

test('approval_due: at scheduling time, 60 and 10 minutes before (urgent last), never after approval or for auto-approved posts', () => {
  const f = alertFixture('2026-11-24T22:00:00.000Z');   // 06:00 local; post at 09:00
  const { x } = seedHub(f);
  const target = post(f, x, T, { plan_status: 'awaiting_approval' });
  const request = f.ctx.create('approval_request', { resource_type: 'planning.publish_target', resource_id: target.id, status: 'pending', due_at: f.plus(30, T) });
  f.ctx.update('publish_target', target.id, { approval_request_id: request.id });
  applyAlertEvent(f.ctx, 'core.approval_request.created', { request_id: request.id, resource_id: target.id });
  scanAlertReminders(f.ctx);
  let approvals = f.alerts().filter(row => row.kind === 'approval_due');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0]!.severity, 'normal');
  assert.equal(approvals[0]!.title, 'X @fixture_x（Mac-B）09:00 的貼文等你核准，期限 09:30。');
  assert.match(String(approvals[0]!.body), /請在 09:30 前核准，之後這則不會發出。/);
  f.at(f.plus(-61, T)); scanAlertReminders(f.ctx);
  assert.equal(f.alerts().filter(row => row.kind === 'approval_due').length, 1);
  f.at(f.plus(-60, T)); scanAlertReminders(f.ctx); scanAlertReminders(f.ctx);
  f.at(f.plus(-30, T)); scanAlertReminders(f.ctx);
  f.at(f.plus(-10, T)); scanAlertReminders(f.ctx);
  approvals = f.alerts().filter(row => row.kind === 'approval_due');
  assert.deepEqual(approvals.map(row => row.severity), ['normal', 'normal', 'urgent']);
  assert.match(String(approvals[2]!.title), /還有 10 分鐘/);

  // A post scheduled 5 minutes out gets one urgent notice, not three.
  const soon = post(f, x, f.plus(5), { plan_status: 'awaiting_approval' });
  const soonRequest = f.ctx.create('approval_request', { resource_type: 'planning.publish_target', resource_id: soon.id, status: 'pending', due_at: f.plus(35) });
  applyAlertEvent(f.ctx, 'core.approval_request.created', { request_id: soonRequest.id });
  scanAlertReminders(f.ctx);
  const soonAlerts = f.alerts().filter(row => row.kind === 'approval_due' && row.post_id === soon.id);
  assert.deepEqual(soonAlerts.map(row => row.severity), ['urgent']);

  // Approved in time: no later reminder. Auto-approved (direct): nothing at all.
  const g = alertFixture('2026-11-24T22:00:00.000Z');
  const hub = seedHub(g);
  const approved = post(g, hub.x, T, { plan_status: 'awaiting_approval' });
  const approvedRequest = g.ctx.create('approval_request', { resource_type: 'planning.publish_target', resource_id: approved.id, status: 'pending', due_at: g.plus(30, T) });
  applyAlertEvent(g.ctx, 'core.approval_request.created', { request_id: approvedRequest.id });
  g.ctx.update('approval_request', approvedRequest.id, { status: 'approved' });
  g.ctx.update('publish_target', approved.id, { plan_status: 'ready' });
  g.at(g.plus(-10, T)); scanAlertReminders(g.ctx);
  const direct = post(g, hub.tt, T, { plan_status: 'ready' });
  const directRequest = g.ctx.create('approval_request', { resource_type: 'planning.publish_target', resource_id: direct.id, status: 'approved', approved_via: 'channel_policy', due_at: g.plus(30, T) });
  applyAlertEvent(g.ctx, 'core.approval_request.created', { request_id: directRequest.id });
  assert.deepEqual(g.alerts().map(row => row.kind), ['approval_due']);
});

test('missed (not_approved): a post still awaiting approval after scheduled_at + lateness alerts once', () => {
  const f = alertFixture();
  const { x } = seedHub(f);
  const target = post(f, x, T, { plan_status: 'awaiting_approval' });
  const request = f.ctx.create('approval_request', { resource_type: 'planning.publish_target', resource_id: target.id, status: 'pending', due_at: f.plus(30, T) });
  f.ctx.update('publish_target', target.id, { approval_request_id: request.id });
  f.at(f.plus(30, T)); scanAlertReminders(f.ctx);
  assert.equal(f.alerts().filter(row => row.kind === 'missed').length, 0);
  f.ctx.update('approval_request', request.id, { status: 'expired' });   // scanPlanningDue revoked it
  f.at(f.plus(31, T)); scanAlertReminders(f.ctx); scanAlertReminders(f.ctx);
  const missed = f.alerts().filter(row => row.kind === 'missed');
  assert.equal(missed.length, 1);
  assert.match(String(missed[0]!.body), /這則沒有在 09:30 前核准，所以沒有發出。/);
  assert.equal(missed[0]!.title, 'X @fixture_x（Mac-B）的貼文沒有發出（沒有在期限內核准）。');
});

test('click_post_soon: assist jobs alert at not_before − prepare_lead_min and at not_before; the owner_click_required blocker is the second one', () => {
  const f = alertFixture('2026-11-25T00:00:00.000Z');
  const { macB, x } = seedHub(f);
  f.ctx.update('connector_device', macB.id, { remote_access: { kind: 'vnc', host: 'mac-b.tail1234.ts.net' } });
  const assist = job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'claimed', mode: 'assist' });
  job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'claimed', mode: 'auto' });
  f.at(f.plus(-31, T)); scanAlertReminders(f.ctx);
  assert.equal(f.alerts().filter(row => row.kind === 'click_post_soon').length, 0);
  f.at(f.plus(-30, T)); scanAlertReminders(f.ctx); scanAlertReminders(f.ctx);
  let clicks = f.alerts().filter(row => row.kind === 'click_post_soon');
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0]!.severity, 'normal');
  assert.equal(clicks[0]!.title, '09:00 要在 Mac-B 按「發布」：X @fixture_x。');
  assert.match(String(clicks[0]!.body), /09:00–09:30 之間到 Mac-B 按「發布」。也可以從遠端畫面操作：vnc:\/\/mac-b\.tail1234\.ts\.net/);
  f.at(T);
  status(f, assist, 'needs_owner', { blocker: blocker('owner_click_required', f) });
  scanAlertReminders(f.ctx);
  clicks = f.alerts().filter(row => row.kind === 'click_post_soon');
  assert.deepEqual(clicks.map(row => row.severity), ['normal', 'urgent']);
  assert.equal(f.alerts().filter(row => row.kind === 'worker_blocker').length, 0);
  assert.match(String(clicks[1]!.body), /^Mac-B 的 X @fixture_x 已準備好，等你在 Mac-B 按「發布」（這個帳號沒有開啟代按發布），截止 09:30。/);
  // The S2 hook wins over the dispatch-time mode (risk ack withdrawn after dispatch).
  const g = alertFixture();
  const hub = seedHub(g);
  job(g, { device: hub.macB, account: hub.x, target: post(g, hub.x, T), notBefore: T, status: 'claimed', mode: 'auto' });
  configureAlerts({ effectiveMode: () => 'assist' });
  try {
    g.at(g.plus(-20, T)); scanAlertReminders(g.ctx);
    assert.equal(g.alerts().filter(row => row.kind === 'click_post_soon').length, 1);
  } finally { resetAlertHooks(); }
});

test('login_check_failed, upload_done and upload_failed', () => {
  const f = alertFixture();
  const { winC, tt } = seedHub(f);
  const check = job(f, { device: winC, account: tt, notBefore: f.ctx.now, kind: 'check_login', status: 'claimed' });
  f.ctx.create('worker_job_event', { job_id: check.id, at: f.ctx.now, event: 'login_state', actor: 'device', detail: { state: 'login_required' } });
  status(f, check, 'needs_owner');
  status(f, check, 'failed');
  const login = f.alerts().filter(row => row.kind === 'login_check_failed');
  assert.equal(login.length, 1);
  assert.equal(login[0]!.title, 'Win-C 的 TikTok @fixture_tt 登入檢查失敗：登入已過期或還沒登入。');
  assert.equal(login[0]!.post_id, null);

  const upload = f.ctx.create('asset', { origin: 'agent_upload', status: 'ready', title: 'video.mp4' });
  const library = f.ctx.create('asset', { origin: 'library', status: 'ready', title: 'old.mp4' });
  applyAlertEvent(f.ctx, 'asset.version.created', { asset_id: library.id });
  applyAlertEvent(f.ctx, 'asset.version.created', { asset_id: upload.id });
  applyAlertEvent(f.ctx, 'asset.version.created', { asset_id: upload.id });
  assert.deepEqual(f.alerts().filter(row => row.kind === 'upload_done').map(row => row.title), ['video.mp4 已上傳完成。']);
  const broken = f.ctx.create('asset', { origin: 'agent_upload', status: 'failed', title: 'big.mov' });
  alertUploadFailed(f.ctx, { media_id: broken.id, reason: 'file_changed' });
  alertUploadFailed(f.ctx, { media_id: broken.id, reason: 'expired' });
  const failed = f.alerts().filter(row => row.kind === 'upload_failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.severity, 'urgent');
  assert.equal(failed[0]!.title, 'big.mov 上傳失敗（檔案在上傳中被改動）。');
});

test('machine_offline_with_jobs: offline over 10 minutes with a job due within 2 hours, once per offline episode', () => {
  const f = alertFixture();
  const { macB, x } = seedHub(f);
  f.ctx.update('connector_device', macB.id, { last_seen_at: f.plus(-9) });
  job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'claimed' });
  scanAlertReminders(f.ctx);
  assert.equal(f.alerts().filter(row => row.kind === 'machine_offline_with_jobs').length, 0);
  f.at(f.plus(2)); scanAlertReminders(f.ctx); scanAlertReminders(f.ctx);
  const offline = f.alerts().filter(row => row.kind === 'machine_offline_with_jobs');
  assert.equal(offline.length, 1);
  assert.equal(offline[0]!.title, 'Mac-B 離線，1 則貼文等待中，最早 09:00。');
  assert.equal(offline[0]!.severity, 'urgent');
  // Live presence (C14) counts as online even when the stored last_seen_at is old.
  const g = alertFixture();
  const hub = seedHub(g);
  g.ctx.update('connector_device', hub.macB.id, { last_seen_at: g.plus(-60) });
  Object.assign(g.ctx, { presence: (id: string) => id === hub.macB.id ? { last_seen_at: g.ctx.now } : undefined });
  job(g, { device: hub.macB, account: hub.x, target: post(g, hub.x, T), notBefore: T, status: 'claimed' });
  // Jobs more than 2 hours away and paused machines do not alert.
  g.ctx.update('connector_device', hub.winC.id, { last_seen_at: g.plus(-60) });
  job(g, { device: hub.winC, account: hub.tt, target: post(g, hub.tt, g.plus(180)), notBefore: g.plus(180), status: 'queued' });
  scanAlertReminders(g.ctx);
  assert.equal(g.alerts().filter(row => row.kind === 'machine_offline_with_jobs').length, 0);
  // Back online then offline again: a new episode alerts again.
  f.ctx.update('connector_device', macB.id, { last_seen_at: f.ctx.now });
  f.at(f.plus(11)); scanAlertReminders(f.ctx);
  assert.equal(f.alerts().filter(row => row.kind === 'machine_offline_with_jobs').length, 2);
});

test('machine_setup (E43): a warning alerts when it first appears or changes, not every day; after an hour gone it alerts again', () => {
  const f = alertFixture();
  const { macB } = seedHub(f);
  const setupAlerts = () => f.alerts().filter(row => row.kind === 'machine_setup');
  f.ctx.update('connector_device', macB.id, { posture: { sleep_idle_min: 10, auto_login: 'off', filevault: 'on' } });
  scanAlertReminders(f.ctx); scanAlertReminders(f.ctx);
  assert.deepEqual(setupAlerts().map(row => row.body), ['Mac-B 閒置 10 分鐘會睡眠。Worker 持有排程時會阻止閒置睡眠，但闔上螢幕或手動睡眠仍會錯過。',
    'Mac-B 重開機後要有人登入，Worker 才會啟動（FileVault 已開啟）。']);
  // E25: the title names the machine; it does not repeat the body.
  assert.deepEqual(setupAlerts().map(row => row.title), ['Mac-B 的設定需要調整', 'Mac-B 的設定需要調整']);
  // COH-5: the next day, and the day after, the same accepted warnings send nothing (they were 2 new pushes a day before E43).
  f.at(f.plus(60 * 24)); scanAlertReminders(f.ctx);
  f.at(f.plus(60 * 24)); scanAlertReminders(f.ctx);
  assert.equal(setupAlerts().length, 2);
  // Numbers alone (idle minutes, clock offset) are not news.
  f.ctx.update('connector_device', macB.id, { posture: { sleep_idle_min: 30, auto_login: 'off', filevault: 'on' }, clock_offset_ms: 40_000 });
  scanAlertReminders(f.ctx);
  assert.deepEqual(setupAlerts().map(row => row.setup_code), ['sleep_enabled', 'no_auto_login', 'clock_skew']);
  f.ctx.update('connector_device', macB.id, { clock_offset_ms: 55_000 });
  scanAlertReminders(f.ctx);
  assert.equal(setupAlerts().length, 3);
  // What the warning says changed (FileVault turned off, auto-login still off): one new alert.
  f.ctx.update('connector_device', macB.id, { posture: { sleep_idle_min: 30, auto_login: 'off', filevault: 'off' } });
  scanAlertReminders(f.ctx);
  assert.equal(setupAlerts().length, 4);
  assert.equal(setupAlerts().at(-1)!.body, 'Mac-B 重開機後要有人登入，Worker 才會啟動。');
  // Gone for 30 minutes and back: the same episode. Gone for over an hour and back: a new appearance.
  f.ctx.update('connector_device', macB.id, { posture: { sleep_idle_min: 0, auto_login: 'off', filevault: 'off' } });
  scanAlertReminders(f.ctx);
  f.at(f.plus(30)); scanAlertReminders(f.ctx);
  f.ctx.update('connector_device', macB.id, { posture: { sleep_idle_min: 10, auto_login: 'off', filevault: 'off' } });
  scanAlertReminders(f.ctx);
  assert.equal(setupAlerts().length, 4);
  f.ctx.update('connector_device', macB.id, { posture: { sleep_idle_min: 0, auto_login: 'off', filevault: 'off' } });
  scanAlertReminders(f.ctx);
  f.at(f.plus(61)); scanAlertReminders(f.ctx);
  f.ctx.update('connector_device', macB.id, { posture: { sleep_idle_min: 10, auto_login: 'off', filevault: 'off' } });
  scanAlertReminders(f.ctx); scanAlertReminders(f.ctx);
  assert.equal(setupAlerts().length, 5);
  assert.equal(setupAlerts().at(-1)!.setup_code, 'sleep_enabled');

  // An alert raised before E43 (daily key) counts as already told.
  const g = alertFixture();
  const hub = seedHub(g);
  g.ctx.update('connector_device', hub.winC.id, { posture: { auto_login: 'off' } });
  createOwnerAlert(g.ctx, { kind: 'machine_setup', severity: 'normal', dedupe_key: `${hub.winC.id}:no_auto_login:2026-11-24`, title: 'Win-C 的設定需要調整',
    body: 'Win-C 重開機後要有人登入，Worker 才會啟動。', machine_id: hub.winC.id });
  scanAlertReminders(g.ctx);
  assert.equal(g.alerts().filter(row => row.kind === 'machine_setup').length, 1);
});

test('daily_summary at 21:00 workspace time lists tomorrow and open issues without captions, once a day, and can be switched off', () => {
  const f = alertFixture('2026-11-25T12:59:00.000Z');   // 20:59 local
  const { macB, x, tt } = seedHub(f);
  post(f, x, '2026-11-26T01:00:00.000Z', { caption: 'SECRET CAPTION TEXT' });
  post(f, tt, '2026-11-26T03:30:00.000Z');
  post(f, tt, '2026-11-26T04:00:00.000Z', { plan_status: 'cancelled' });
  job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'outcome_unknown' });
  scanAlertReminders(f.ctx);
  assert.equal(f.alerts().filter(row => row.kind === 'daily_summary').length, 0);
  f.at('2026-11-25T13:00:00.000Z'); scanAlertReminders(f.ctx); scanAlertReminders(f.ctx);
  const summary = f.alerts().filter(row => row.kind === 'daily_summary');
  assert.equal(summary.length, 1);
  assert.equal(summary[0]!.title, '明天有 2 則排程，1 件待處理。');
  assert.equal(summary[0]!.severity, 'info');
  assert.match(String(summary[0]!.body), /09:00 X @fixture_x（Mac-B）\n11:30 TikTok @fixture_tt（Win-C）/);
  assert.doesNotMatch(String(summary[0]!.body), /SECRET CAPTION/);
  const g = alertFixture('2026-11-25T13:00:00.000Z');
  seedHub(g);
  g.run('hub_alerts_update_channels', { body: { preferences: { daily_summary: false } } });
  scanAlertReminders(g.ctx);
  assert.equal(g.alerts().length, 0);
});

test('views_alerts and hub_alerts_read: newest first, unread filter, strict query, read marks', () => {
  const f = alertFixture();
  seedHub(f);
  for (const key of ['a', 'b', 'c']) createOwnerAlert(f.ctx, { kind: 'machine_setup', severity: 'normal', dedupe_key: key, title: `t-${key}`, body: 'b' });
  const list = f.run<OwnerAlert[]>('views_alerts');
  assert.deepEqual(list.map(alert => alert.title), ['t-c', 't-b', 't-a']);
  assert.deepEqual(Object.keys(list[0]!).sort(), ['at', 'body', 'channel', 'id', 'kind', 'machine', 'post', 'read_at', 'severity', 'title', 'web_url']);
  assert.throws(() => f.run('views_alerts', { query: { since: 'x' } }), (error: unknown) => error instanceof Problem && error.status === 422);
  assert.throws(() => f.run('views_alerts', { query: { unread: 'yes' } }), (error: unknown) => error instanceof Problem && error.status === 422);
  assert.deepEqual(f.run('hub_alerts_read', { body: { ids: [list[0]!.id] } }), { updated: 1, unread: 2 });
  assert.equal(f.run<OwnerAlert[]>('views_alerts', { query: { unread: 'true' } }).length, 2);
  assert.throws(() => f.run('hub_alerts_read', { body: { ids: ['missing'] } }), (error: unknown) => error instanceof Problem && error.status === 422);
  assert.throws(() => f.run('hub_alerts_read', { body: {} }), (error: unknown) => error instanceof Problem && error.status === 422);
  assert.deepEqual(f.run('hub_alerts_read', { body: { all: true } }), { updated: 2, unread: 0 });
  f.ctx.role = 'agent';
  assert.equal(f.run<OwnerAlert[]>('views_alerts').length, 3);   // READ includes the agent role
  assert.throws(() => f.run('hub_alerts_get_channels'), (error: unknown) => error instanceof Problem && error.status === 403);
});

test('the triggers subscriber accepts exactly the source events and runs from an outbox envelope', () => {
  const f = alertFixture();
  const { macB, x } = seedHub(f);
  const subscriber = subscribers[0]!;
  assert.equal(subscriber.accepts('worker.job.status_changed'), true);
  assert.equal(subscriber.accepts('alerts.owner_alert.created'), false);
  const row = job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'needs_owner', blocker: blocker('two_factor', f) });
  subscriber.run(f.ctx, { type: 'worker.job.status_changed', data: { job_id: row.id, from: 'claimed', to: 'needs_owner', blocker_code: 'two_factor' } });
  assert.match(String(f.alerts()[0]!.body), /^Mac-B 的 X @fixture_x 要求二次驗證/);
});

test('after hub downtime only the most urgent due approval reminder goes out; a machine pause is named in missed copy', () => {
  const f = alertFixture('2026-11-24T20:00:00.000Z');
  const { x, macB } = seedHub(f);
  const target = post(f, x, T, { plan_status: 'awaiting_approval' });
  const request = f.ctx.create('approval_request', { resource_type: 'planning.publish_target', resource_id: target.id, status: 'pending', due_at: f.plus(30, T) });
  f.at(f.plus(-5, T));   // the hub was down from scheduling until 5 minutes before
  scanAlertReminders(f.ctx);
  assert.deepEqual(f.alerts().filter(row => row.kind === 'approval_due').map(row => [row.severity, row.dedupe_key]),
    [['urgent', `approval_due:${target.id}:${request.id}:10`]]);

  f.ctx.update('connector_device', macB.id, { paused: true, paused_at: f.ctx.now, paused_by: 'user:owner-1' });
  const held = job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'ready' });
  f.ctx.create('worker_job_event', { job_id: held.id, at: f.ctx.now, event: 'missed', actor: 'device', detail: { reason: 'paused' } });
  status(f, held, 'missed');
  assert.match(String(f.alerts().at(-1)!.body), /這則沒有發出，因為這台機器在 08:55 被你暫停/);
});

// ---------- wave 6 (G5-ops): AO-4, AO-5, AO-6, AO-7 ----------

let eventSeq = 0;
function reporter(f: AlertFixture, device: { id: string }, jobId: string, fence = 1, firstSeq = 1) {
  let seq = firstSeq - 1;
  return (event: string, data: Record<string, unknown> = {}) => reportJob(f.ctx as unknown as Context, device as never, {
    job_id: jobId, fencing_token: fence, seq: ++seq, event_id: `evt-${String(++eventSeq).padStart(8, '0')}`, event, data, worker_time: f.ctx.now });
}

test('AO-4: after a hub outage the first scans do not call healthy machines offline; one still silent 10 minutes after the restart is', async t => {
  t.after(() => resetPresence());
  // 08:52 local: the last 5-minute presence write before the hub went down (08:55–09:10, §5.1).
  const f = alertFixture('2026-11-25T00:52:00.000Z');
  const { macB, winC, x, tt } = seedHub(f);
  job(f, { device: macB, account: x, target: post(f, x, '2026-11-25T02:00:00.000Z'), notBefore: '2026-11-25T02:00:00.000Z', status: 'ready' });
  job(f, { device: winC, account: tt, target: post(f, tt, '2026-11-25T02:30:00.000Z'), notBefore: '2026-11-25T02:30:00.000Z', status: 'claimed' });
  const offline = () => f.alerts().filter(row => row.kind === 'machine_offline_with_jobs');
  f.at('2026-11-25T01:10:00.000Z');   // 09:10: the hub process starts, no heartbeat yet
  resetPresence(f.ctx.now);
  // Both startup paths: the alerts.reminders schedule and the first drain cycle.
  alertReminderSchedule.run(f.ctx as unknown as Context);
  await createAlertsDrain()(async run => run(f.ctx as unknown as Context));
  assert.deepEqual(offline(), []);
  // Mac-B reconnects at once and heartbeats (live presence, C14); Win-C stays silent past 10 minutes counted from the restart.
  Object.assign(f.ctx, { presence: (id: string) => id === macB.id ? { last_seen_at: f.ctx.now } : undefined });
  f.at('2026-11-25T01:20:30.000Z');
  alertReminderSchedule.run(f.ctx as unknown as Context);
  assert.deepEqual(offline().map(row => row.title), ['Win-C 離線，1 則貼文等待中，最早 10:30。']);
  assert.match(String(offline()[0]!.body), /^Win-C 從 08:52 起沒有連線/);
});

test('AO-5: a second captcha on the same job after the owner solved the first one alerts again (real report path)', () => {
  const f = alertFixture('2026-11-24T14:00:00.000Z');   // 22:00 local
  const { macB, x } = seedHub(f);
  const target = post(f, x, T);
  const row = job(f, { device: macB, account: x, target, notBefore: T, status: 'claimed', fencing_token: 1, seq_by_fence: {} });
  const report = reporter(f, macB, row.id);
  const blockers = () => f.alerts().filter(item => item.kind === 'worker_blocker');
  report('prepare_blocked', { blocker: { code: 'captcha', message: 'challenge' }, stage: 'preflight' });
  assert.equal(blockers().length, 1);
  report('prepare_blocked', { blocker: { code: 'captcha', message: 'challenge' }, stage: 'preflight' });   // still blocked: no repeat
  assert.equal(blockers().length, 1);
  f.at('2026-11-24T14:05:00.000Z');
  report('prepared', { stage: 'preflight' });   // the owner solved it; the Worker went on
  assert.equal(f.ctx.get('worker_job', row.id).status, 'claimed');
  f.at('2026-11-25T00:30:00.000Z');   // 08:30: the final prepare hits a captcha again
  report('prepare_blocked', { blocker: { code: 'captcha', message: 'challenge' }, stage: 'final' });
  assert.equal(f.ctx.get('worker_job', row.id).status, 'needs_owner');
  assert.equal(blockers().length, 2);
  assert.match(String(blockers()[1]!.body), /^Mac-B 的 X @fixture_x 出現驗證碼，已停止。.*截止 09:30。$/);
  // A retried outbox event of the first transition, after the job moved on, raises nothing new.
  setJob(f.ctx as unknown as Context, f.ctx.get('worker_job', row.id), { status: 'claimed', blocker: null });
  applyAlertEvent(f.ctx, 'worker.job.status_changed', { job_id: row.id, from: 'claimed', to: 'needs_owner', blocker_code: 'captcha' });
  assert.equal(blockers().length, 2);
});

test('AO-6: an assist job not prepared at not_before never gets "ready, click Post"; the real ready report still alerts', () => {
  const f = alertFixture('2026-11-25T00:00:00.000Z');
  const { winC, tt } = seedHub(f);
  const assist = job(f, { device: winC, account: tt, target: post(f, tt, T), notBefore: T, status: 'claimed', mode: 'assist' });
  const clicks = () => f.alerts().filter(row => row.kind === 'click_post_soon');
  f.at(T); scanAlertReminders(f.ctx);
  assert.equal(clicks().filter(row => /已準備好/.test(String(row.body))).length, 0, 'nothing is prepared at 09:00');
  // Still not reported 2 minutes later: say so, without claiming readiness.
  f.at(f.plus(2, T)); scanAlertReminders(f.ctx); scanAlertReminders(f.ctx);
  assert.deepEqual(clicks().map(row => [row.severity, row.title]), [['normal', 'Win-C 還沒準備好 TikTok @fixture_tt 的草稿（截止 09:30）。']]);
  assert.doesNotMatch(String(clicks()[0]!.body), /已準備好/);
  // 09:07: Win-C really prepared the draft and reports owner_click_required: the urgent "click Post now" goes out.
  f.at(f.plus(7, T));
  status(f, assist, 'needs_owner', { blocker: blocker('owner_click_required', f, 'Win-C', 'TikTok @fixture_tt') });
  scanAlertReminders(f.ctx);
  assert.deepEqual(clicks().map(row => row.severity), ['normal', 'urgent']);
  assert.match(String(clicks()[1]!.body), /^Win-C 的 TikTok @fixture_tt 已準備好，等你在 Win-C 按「發布」/);
  // A login blocker at not_before is already its own worker_blocker alert: no "not ready" notice on top.
  const g = alertFixture('2026-11-25T00:00:00.000Z');
  const hub = seedHub(g);
  const login = job(g, { device: hub.winC, account: hub.tt, target: post(g, hub.tt, T), notBefore: T, status: 'claimed', mode: 'assist' });
  g.at(T);
  status(g, login, 'needs_owner', { blocker: blocker('login_expired', g, 'Win-C', 'TikTok @fixture_tt') });
  g.at(g.plus(5, T));
  g.ctx.update('connector_device', hub.winC.id, { last_seen_at: g.ctx.now });
  scanAlertReminders(g.ctx);
  assert.deepEqual(g.alerts().map(row => row.kind), ['worker_blocker']);
});

test('AO-7: a Worker that settles an unreported post as failed tells the owner; the owner marking it not published does not', () => {
  const f = alertFixture('2026-11-25T01:00:00.000Z');
  const { macB, x } = seedHub(f);
  const row = job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'running', started_at: '2026-11-25T01:00:05.000Z',
    fencing_token: 1, seq_by_fence: { '1': 3 } });
  f.at('2026-11-25T01:45:00.000Z');
  setJob(f.ctx as unknown as Context, f.ctx.get('worker_job', row.id), { status: 'unreported' });
  assert.match(String(f.alerts().at(-1)!.body), /機器上線後會自動補報/);
  f.at('2026-11-25T02:30:00.000Z');
  reporter(f, macB, row.id, 1, 4)('failed', { code: 'upload_rejected', message: 'Video too long' });
  assert.equal(f.ctx.get('worker_job', row.id).status, 'failed');
  const late = f.alerts().at(-1)!;
  assert.equal(late.kind, 'worker_blocker');
  assert.equal(late.severity, 'urgent');
  assert.equal(late.title, 'X @fixture_x（Mac-B）的貼文沒有發出（Mac-B 後來回報）。');
  assert.equal(late.body, 'Mac-B 後來回報：X @fixture_x 的這則貼文沒有發出（平台拒絕了這支影片），它在送出前就停止了。要改到別的時間嗎？');
  // The owner's own mark-not-published (event + flag, worker/index.ts) stays silent.
  const owned = job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'unreported' });
  const before = f.alerts().length;
  f.ctx.create('worker_job_event', { job_id: owned.id, at: f.ctx.now, event: 'owner_marked_not_published', actor: 'human', detail: {} });
  setJob(f.ctx as unknown as Context, f.ctx.get('worker_job', owned.id), { status: 'failed', owner_marked_not_published: true });
  assert.equal(f.alerts().length, before);
});

test('U7: a platform rejection is worded once; the blocker keeps the platform text and the alert fills its own sentence with it', () => {
  const f = alertFixture('2026-11-25T01:00:00.000Z');
  const { macB, x } = seedHub(f);
  const sentence = 'X @fixture_x 拒絕了這支影片：「Video format not supported」。這則沒有發出。';
  const row = job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'running', started_at: '2026-11-25T01:00:05.000Z',
    fencing_token: 1, seq_by_fence: { '1': 3 } });
  reporter(f, macB, row.id, 1, 4)('failed', { code: 'upload_rejected', message: 'Video format not supported' });
  const stored = f.ctx.get('worker_job', row.id).blocker as Record<string, unknown>;
  assert.deepEqual([stored.message, stored.platform_message], [sentence, 'Video format not supported']);
  const alert = f.alerts().at(-1)!;
  assert.equal(alert.body, sentence, 'not 「X 拒絕了這支影片：「X 拒絕了這支影片：「…」。…」。…」');
  assert.equal(alert.title, 'Mac-B 的 X @fixture_x：平台拒絕了這支影片，這則沒有發出。');
  // A stored owner sentence without platform_message (written before U7) is not wrapped again either.
  const old = job(f, { device: macB, account: x, target: post(f, x, T), notBefore: T, status: 'claimed' });
  status(f, old, 'needs_owner', { blocker: { ...blocker('upload_rejected', f), message: sentence } });
  assert.equal(f.alerts().at(-1)!.body, 'X @fixture_x 拒絕了這支影片：「平台沒有提供說明」。這則沒有發出。');
});
