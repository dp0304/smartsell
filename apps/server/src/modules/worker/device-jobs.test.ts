import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { RISK_TERMS_VERSION, type Problem, type Row } from '@smartsell/contracts';
import { hubFixture } from './fixtures.js';
import { createCheckLoginJob } from './dispatch.js';
import { JOB, deviceSyncState, syncGeneration } from './model.js';
import { requestRevoke } from './revoke.js';

const HOUR = 3_600_000;
const code = (expected: string) => (error: unknown) => { assert.equal((error as Problem).code, expected); return true; };
const blocker = (code: string, phase = 'prepare') => ({ blocker: { code, phase, message: '', at: '2027-01-01T10:00:00.000Z' } });

test('claim: 24 h horizon, check_login regardless of time, paused machine gets nothing, past not_after becomes missed (§5.4.2)', async () => {
  const f = hubFixture();
  const soon = f.jobOf((await f.schedule(2 * HOUR)).id);
  const later = f.jobOf((await f.schedule(30 * HOUR)).id);
  const check = createCheckLoginJob(f.ctx, f.account.id, { openLoginWindow: false });
  f.ctx.update('connector_device', f.device.id, { paused: true });
  assert.deepEqual(f.claim().jobs, [], 'a paused machine claims nothing');
  f.ctx.update('connector_device', f.device.id, { paused: false });
  const claimed = f.claim();
  assert.deepEqual(claimed.jobs.map(job => job.job_id).sort(), [soon.id, check.id].sort());
  const record = f.job(soon.id);
  assert.equal(record.status, 'claimed');
  assert.equal(record.fencing_token, 1);
  assert.equal(record.lease_expires_at, new Date(Date.parse(String(record.not_after)) + 15 * 60_000).toISOString());
  assert.equal(f.job(later.id).status, 'queued');
  // Held jobs are not re-issued (their fence is stable); a lost one is re-issued with a new fence.
  assert.deepEqual(f.claim([soon.id, check.id]).jobs, []);
  assert.deepEqual(f.claim([check.id]).jobs.map(job => [job.job_id, job.fencing_token]), [[soon.id, 2]]);
  f.advance(31 * HOUR);
  f.claim([soon.id, check.id]);
  assert.equal(f.job(later.id).status, 'missed');
  assert.ok(f.timeline(later.id).includes('missed_unclaimed'));
});

test('report transitions for every event (§5.4.3 table)', async () => {
  const f = hubFixture();
  const target = await f.schedule(HOUR);
  const job = f.jobOf(target.id);
  f.claim();
  f.report(job.id, 'prepared', { stage: 'preflight', login: 'verified', identity: 'lurelab', handle: 'lurelab_new', media_ok: true, driver: { provider: 'x', version: 'x@2026.11.1' } });
  assert.equal(f.job(job.id).status, 'claimed');
  assert.ok(f.job(job.id).preflight_at);
  assert.equal(f.ctx.get('social_account', f.account.id).handle, 'lurelab_new', 'handle follows the observation');
  assert.ok(f.timeline(job.id).includes('handle_changed'));
  f.report(job.id, 'prepare_blocked', { stage: 'final', ...blocker('login_expired') });
  assert.equal(f.job(job.id).status, 'needs_owner');
  assert.equal((f.job(job.id).blocker as Row).machine_name, 'Mac-B');
  assert.match(String((f.job(job.id).blocker as Row).message), /Mac-B 的 X @lurelab_new 登入已過期/);
  assert.equal(f.ctx.list('browser_session')[0].status, 'login_required');
  assert.ok(f.ctx.list('owner_alert').some(row => row.kind === 'worker_blocker'), 'the owner is alerted');
  f.report(job.id, 'prepared', { stage: 'final', login: 'verified', identity: 'lurelab', handle: 'lurelab_new', media_ok: true, driver: { provider: 'x', version: 'x@2026.11.1' } });
  assert.equal(f.job(job.id).status, 'ready');
  assert.equal(f.job(job.id).blocker, null, 'an auto-resumable blocker clears on prepared');
  assert.equal(f.ctx.list('browser_session')[0].status, 'verified');
  f.at(String(job.not_before));
  const first = f.go(job.id) as { go: boolean; mode: string };
  assert.deepEqual([first.go, first.mode], [true, 'auto']);
  f.report(job.id, 'started', { go: 'hub', mode: 'auto' });
  assert.equal(f.job(job.id).status, 'running');
  f.report(job.id, 'submitting');
  assert.equal(f.job(job.id).status, 'submitting');
  f.report(job.id, 'submitted', { toast_url: 'https://x.com/lurelab_new/status/1' });
  assert.equal(f.job(job.id).status, 'result_pending');
  f.report(job.id, 'readback_pending', { attempt: 1, next_at: f.ctx.now });
  assert.equal(f.job(job.id).status, 'result_pending');
  f.report(job.id, 'result', { ...f.resultData('1861234567890123456'), url: 'https://x.com/lurelab_new/status/1861234567890123456', external_post_id: null });
  const done = f.job(job.id);
  assert.equal(done.status, 'succeeded');
  assert.equal((done.result as Row).external_post_id, '1861234567890123456', 'parsed from the URL (§3.7)');
  const post = f.ctx.get('platform_post', String(f.ctx.get('publish_target', target.id).platform_post_id));
  assert.equal(post.verification, 'system_verified');
  assert.equal(post.registered_via, 'worker_readback');
  assert.equal(post.worker_job_id, job.id);
  // failed, missed, outcome_unknown, after_submit blocked, dry_run_done and login_state on fresh jobs.
  const g = hubFixture();
  const a = g.jobOf((await g.schedule(HOUR)).id);
  g.claim();
  g.report(a.id, 'failed', { code: 'media_hash_mismatch', message: 'hash' });
  assert.equal(g.job(a.id).status, 'failed');
  const b = g.jobOf((await g.schedule(HOUR + 60_000)).id);
  g.claim([a.id]);
  g.report(b.id, 'missed', { reason: 'machine_was_off' });
  assert.equal(g.job(b.id).status, 'missed');
  const c = g.jobOf((await g.schedule(HOUR + 120_000)).id);
  g.prepare(c.id);
  g.at(String(g.job(c.id).not_before));
  g.go(c.id);
  g.report(c.id, 'started', { go: 'hub', mode: 'auto' });
  g.report(c.id, 'submitting');
  g.report(c.id, 'blocked', blocker('platform_error', 'after_submit'));
  assert.equal(g.job(c.id).status, 'outcome_unknown');
  const check = createCheckLoginJob(g.ctx, g.account.id, { openLoginWindow: false });
  g.claim([a.id, b.id, c.id]);
  // WE-5 (wave 6): a check that did not find the account signed in is over (failed, with the login state and the blocker);
  // it used to stay needs_owner and was re-issued every heartbeat. An open check is still reused; an ended one is not.
  const open = createCheckLoginJob(g.ctx, g.account.id, { openLoginWindow: false });
  assert.equal(open.id, check.id, 'an open check is reused');
  g.report(check.id, 'login_state', { state: 'challenge', identity: null, handle: null, evidence_sha256: [] });
  assert.equal(g.job(check.id).status, 'failed');
  assert.equal((g.job(check.id).blocker as Row).code, 'captcha');
  assert.equal((g.job(check.id).result as Row).login_state, 'challenge');
  assert.ok(g.ctx.list('owner_alert').some(row => row.kind === 'login_check_failed'));
  const check2 = createCheckLoginJob(g.ctx, g.account.id, { openLoginWindow: true });
  assert.notEqual(check2.id, check.id, 'a new check (here with the sign-in window) starts fresh');
});

test('event_id dedupe, per-fence seq, SEQ_GAP with expected and SEQ_CONFLICT (§5.4.3)', async () => {
  const f = hubFixture();
  const job = f.jobOf((await f.schedule(HOUR)).id);
  f.claim();
  const id = randomUUID();
  assert.deepEqual(f.report(job.id, 'prepared', { stage: 'preflight', login: 'verified', identity: 'lurelab', handle: 'lurelab', media_ok: true, driver: {} }, { event_id: id }), { status: 'ok' });
  assert.deepEqual(f.report(job.id, 'prepared', { stage: 'preflight', login: 'verified', identity: 'lurelab', handle: 'lurelab', media_ok: true, driver: {} }, { event_id: id, seq: 1 }), { status: 'duplicate' });
  assert.throws(() => f.report(job.id, 'readback_pending', {}, { seq: 4 }), (error: unknown) => {
    assert.equal((error as Problem).code, 'SEQ_GAP');
    assert.equal((error as Problem).details?.expected, 2);
    return true;
  });
  assert.throws(() => f.report(job.id, 'readback_pending', {}, { seq: 1 }), code('SEQ_CONFLICT'));
  assert.deepEqual(f.report(job.id, 'readback_pending', {}, { seq: 2 }), { status: 'ok' });
  // A new fence (re-claim after local data loss) starts at seq 1 again.
  f.claim([]);
  assert.equal(f.job(job.id).fencing_token, 2);
  assert.deepEqual(f.report(job.id, 'readback_pending', {}, { seq: 1, fence: 2 }), { status: 'ok' });
  assert.deepEqual(f.job(job.id).seq_by_fence, { 1: 2, 2: 1 });
});

test('facts are accepted on a lost fence and on ended jobs; lease reports get JOB_FENCE_LOST (§5.4.3)', async () => {
  const f = hubFixture();
  const target = await f.schedule(HOUR);
  const job = f.jobOf(target.id);
  f.claim();
  f.claim([]);   // fence 2; the Worker still holds fence 1 facts in its outbox
  assert.throws(() => f.report(job.id, 'prepared', { stage: 'final', login: 'verified', identity: 'lurelab', handle: 'lurelab', media_ok: true, driver: {} }, { fence: 1 }), code('JOB_FENCE_LOST'));
  assert.throws(() => f.report(job.id, 'prepared', { stage: 'final' }, { machine: f.other }), code('JOB_FENCE_LOST'), 'a machine outside device_history');
  // Facts from fence 1 still land (fence_override on the event).
  f.report(job.id, 'started', { go: 'offline', mode: 'auto' }, { fence: 1 });
  assert.equal(f.job(job.id).status, 'running');
  const override = f.ctx.list('worker_job_event').find(row => row.job_id === job.id && row.event === 'started')!;
  assert.equal(override.fence_override, true);
  // A job the hub released (cancelled before claim, e.g. force-released) that turns out to have posted: late fact.
  const g = hubFixture();
  const gt = await g.schedule(HOUR);
  const old = g.jobOf(gt.id);
  g.prepare(old.id);
  requestRevoke(g.ctx, g.job(old.id), 'cancelled');
  g.heartbeat([], { released_jobs: [old.id] });
  assert.equal(g.job(old.id).status, 'cancelled');
  g.report(old.id, 'submitting', {}, { fence: 1 });
  assert.equal(g.job(old.id).status, 'outcome_unknown');
  assert.equal(g.job(old.id).fence_override, true);
  assert.ok(g.timeline(old.id).includes('late_fact_after_release'));
  assert.ok(g.ctx.list('owner_alert').some(row => row.kind === 'late_fact_after_release' && row.severity === 'urgent'));
  g.report(old.id, 'result', g.resultData(), { fence: 1 });
  assert.equal(g.job(old.id).status, 'succeeded');
});

test('fact handling never throws: POST_ALREADY_LINKED becomes outcome_unknown with result_conflict (§3.7)', async () => {
  const f = hubFixture();
  const first = await f.schedule(HOUR);
  f.publishNow(f.jobOf(first.id).id, '42');
  const second = await f.schedule(2 * HOUR);
  const job = f.jobOf(second.id);
  f.prepare(job.id);
  f.at(String(job.not_before));
  f.go(job.id);
  f.report(job.id, 'started', { go: 'hub', mode: 'auto' });
  f.report(job.id, 'submitting');
  f.report(job.id, 'submitted', {});
  assert.deepEqual(f.report(job.id, 'result', f.resultData('42')), { status: 'ok' });
  assert.equal(f.job(job.id).status, 'outcome_unknown');
  assert.equal((f.job(job.id).blocker as Row).code, 'result_conflict');
  assert.ok(f.timeline(job.id).includes('fact_conflict'));
  assert.equal(f.task(second.id).status, 'outcome_unknown');
});

test('go: each of the 8 checks, pause before approval with release:false, idempotent resend for running (§5.4.4)', async () => {
  const f = hubFixture();
  const target = await f.schedule(HOUR);
  const job = f.jobOf(target.id);
  f.prepare(job.id);
  assert.deepEqual(f.go(job.id, { fence: 9 }), { go: false, reason: 'fence_lost', release: false });
  assert.deepEqual(f.go(job.id), { go: false, reason: 'too_early', release: false });
  f.at(new Date(Date.parse(String(job.not_before)) - 30_000).toISOString());
  // 4 before 5: a paused post is not treated as an invalid approval.
  const pause = f.run('publishing_pause', { scope_type: 'social_account', scope_id: f.account.id, reason: 'hold' }) as Row;
  assert.equal(f.ctx.get('publish_target', target.id).plan_status, 'paused');
  assert.deepEqual(f.go(job.id), { go: false, reason: 'paused', release: false });
  assert.deepEqual(f.heartbeat([job.id]).jobs[0], { job_id: job.id, fencing_token: 1, hold: true, hold_reason: 'paused', mode: 'auto', resume_token: 0 });
  f.run('publishing_release_pause', {}, { id: pause.id });
  f.ctx.update('connector_device', f.device.id, { paused: true });
  assert.equal((f.go(job.id) as { reason: string }).reason, 'paused');
  f.ctx.update('connector_device', f.device.id, { paused: false });
  // 5: approval no longer valid (the channel was switched back to needs_approval).
  const settings = f.settings();
  f.ctx.update('channel_settings', settings.id, { approval_mode: 'needs_approval', approval_generation: Number(settings.approval_generation) + 1 });
  assert.deepEqual(f.go(job.id), { go: false, reason: 'approval_invalid', release: true });
  f.ctx.update('channel_settings', settings.id, { approval_mode: 'direct', approval_generation: settings.approval_generation });
  // 6: rebound to another machine.
  f.ctx.update('account_execution_binding', f.binding.id, { device_id: f.other.id });
  assert.deepEqual(f.go(job.id), { go: false, reason: 'rebound', release: true });
  f.ctx.update('account_execution_binding', f.binding.id, { device_id: f.device.id });
  // 3: revoked.
  f.ctx.update(JOB, job.id, { revoke: { reason: 'cancelled', requested_at: f.ctx.now } });
  assert.deepEqual(f.go(job.id), { go: false, reason: 'revoked', release: true });
  f.ctx.update(JOB, job.id, { revoke: null });
  // Pass; a resend after the answer was lost gets the same answer.
  const answer = f.go(job.id);
  assert.equal(answer.go, true);
  assert.equal(f.job(job.id).status, 'running');
  assert.equal(f.job(job.id).go_source, 'hub');
  const resend = f.go(job.id) as typeof answer;
  assert.deepEqual([resend.go, (resend as { mode?: string }).mode], [answer.go, (answer as { mode?: string }).mode]);
  // 2: too late; 7: daily cap; 8: outside the window.
  const g = hubFixture();
  const late = g.jobOf((await g.schedule(HOUR)).id);
  g.prepare(late.id);
  g.at(new Date(Date.parse(String(late.not_after)) + 1000).toISOString());
  assert.deepEqual(g.go(late.id), { go: false, reason: 'too_late', release: false });
  const h = hubFixture();
  const one = h.jobOf((await h.schedule(HOUR)).id);
  const two = h.jobOf((await h.schedule(HOUR + 120_000)).id);
  h.ctx.update('channel_settings', h.settings().id, { daily_cap: 1 });   // lowered after both were scheduled
  h.publishNow(one.id);
  h.prepare(two.id);
  h.at(String(h.job(two.id).not_before));
  assert.deepEqual(h.go(two.id), { go: false, reason: 'daily_cap_reached', release: true });
  assert.equal(h.job(two.id).status, 'missed');
  const w = hubFixture();
  const windowed = w.jobOf((await w.schedule(HOUR)).id);
  w.ctx.update('channel_settings', w.settings().id, { window: { start: '00:00', end: '00:30', days: [1, 2, 3, 4, 5, 6, 7] } });
  w.prepare(windowed.id);
  w.at(String(windowed.not_before));
  assert.deepEqual(w.go(windowed.id), { go: false, reason: 'outside_window', release: true });
  assert.equal(w.job(windowed.id).status, 'missed');
  assert.ok(w.ctx.list('worker_job_event').some(row => row.job_id === windowed.id && row.event === 'missed' && (row.detail as Row).reason === 'outside_window'));
});

test('heartbeat v2: hold and mode for pause, revoke, approval loss and risk-ack withdrawal; revoked_jobs; channels; sync_generation (§5.4.1)', async () => {
  const f = hubFixture();
  const target = await f.schedule(HOUR);
  const job = f.jobOf(target.id);
  f.claim();
  const base = f.heartbeat([job.id]);
  assert.equal(base.status, 'online');
  assert.equal(base.protocol, 2);
  assert.deepEqual(base.jobs, [{ job_id: job.id, fencing_token: 1, hold: false, hold_reason: null, mode: 'auto', resume_token: 0 }]);
  assert.equal(base.claimable, 0);
  assert.deepEqual(base.channels.map(channel => [channel.social_account_id, channel.profile_key, channel.effective_mode, channel.expected_identity]),
    [[f.account.id, f.settings().chrome_profile_key, 'auto', 'lurelab']]);
  assert.ok(base.sync_generation >= 1);
  // Withdrawn risk acknowledgement: mode assist from the next heartbeat (§4.5).
  const before = syncGeneration(f.ctx);
  f.run('hub_channels_clear_risk_ack', {}, { id: f.account.id });
  const assist = f.heartbeat([job.id]);
  assert.equal(assist.jobs[0].mode, 'assist');
  assert.ok(assist.sync_generation > before, 'settings changes bump sync_generation');
  assert.ok(deviceSyncState(f.ctx, f.device.id).generation > before, 'and record the affected machine (sync_behind)');
  f.run('hub_channels_ack_risk', { terms_version: RISK_TERMS_VERSION, typed_handle: '@lurelab' }, { id: f.account.id });
  assert.equal(f.heartbeat([job.id]).jobs[0].mode, 'auto');
  // Approval lost → hold approval_invalid.
  const request = f.ctx.get('approval_request', String(f.ctx.get('publish_target', target.id).approval_request_id));
  f.ctx.update('approval_request', request.id, { status: 'invalidated' });
  assert.deepEqual([f.heartbeat([job.id]).jobs[0].hold, f.heartbeat([job.id]).jobs[0].hold_reason], [true, 'approval_invalid']);
  f.ctx.update('approval_request', request.id, { status: 'approved' });
  // Revoke → releasing, revoked_jobs, hold revoked; a heartbeat's released_jobs completes it.
  requestRevoke(f.ctx, f.job(job.id), 'cancelled');
  const revoked = f.heartbeat([job.id]);
  assert.deepEqual(revoked.revoked_jobs, [{ job_id: job.id, reason: 'cancelled' }]);
  assert.deepEqual([revoked.jobs[0].hold, revoked.jobs[0].hold_reason], [true, 'revoked']);
  f.heartbeat([], { released_jobs: [job.id] });
  assert.equal(f.job(job.id).status, 'cancelled');
  assert.deepEqual(f.heartbeat([job.id]).jobs, [], 'ended jobs are not listed');
  // Lost local copy: listed as claimable for recovery.
  const other = f.jobOf((await f.schedule(2 * HOUR)).id);
  f.claim();
  assert.equal(f.heartbeat([]).claimable, 1);
  assert.equal(f.heartbeat([other.id]).claimable, 0);
});

test('offline run with settings older than the machine\'s last sync is recorded and alerted (§5.4.3 started, E1)', async () => {
  const f = hubFixture();
  const target = await f.schedule(HOUR);
  const job = f.jobOf(target.id);
  f.prepare(job.id);
  f.heartbeat([job.id]);   // the machine last saw mode auto, hold false
  f.run('hub_channels_clear_risk_ack', {}, { id: f.account.id });   // then the owner withdrew the risk ack; no heartbeat since
  f.at(String(job.not_before));
  f.report(job.id, 'started', { go: 'offline', mode: 'auto' });
  assert.equal(f.job(job.id).go_source, 'offline');
  assert.ok(f.timeline(job.id).includes('offline_run_used_stale_settings'));
  assert.ok(f.ctx.list('owner_alert').some(row => row.kind === 'offline_run_stale_settings' && row.severity === 'urgent'));
  // A run on current settings is not flagged.
  const g = hubFixture();
  const other = g.jobOf((await g.schedule(HOUR)).id);
  g.prepare(other.id);
  g.heartbeat([other.id]);
  g.at(String(other.not_before));
  g.report(other.id, 'started', { go: 'offline', mode: 'auto' });
  assert.ok(!g.timeline(other.id).includes('offline_run_used_stale_settings'));
});

test('media pending: dispatched without a file, never claimed, cleared when the upload lands (§5.2)', async () => {
  const f = hubFixture();
  const asset = f.ctx.create('asset', { kind: 'video', brand_id: null, ownership: 'owned', origin: 'agent_upload', status: 'uploading', title: 'big.mp4' });
  const version = f.ctx.create('asset_version', { asset_id: asset.id, file_object_id: null, sha256: 'c'.repeat(64), mime_type: 'video/mp4', meta: null });
  f.ctx.update('asset', asset.id, { current_version_id: version.id });
  f.ctx.create('media_upload_session', { media_id: asset.id, bytes: 1_000_000_000, filename: 'big.mp4', status: 'receiving' });
  const clip = await f.variant('Big upload', [{ asset_id: asset.id, asset_version_id: version.id, role: 'primary' }]);
  const target = f.run('publishing_create_target', { social_account_id: f.account.id, content_variant_id: clip.id, scheduled_at: new Date(Date.parse(f.ctx.now) + 2 * HOUR).toISOString(), late_policy: 'skip', grace_minutes: 30 }) as Row;
  f.run('publishing_request_approval', {}, { id: target.id });
  const job = f.jobOf(target.id);
  assert.equal(job.media_pending, true);
  assert.equal((job.payload as { media: Row[] }).media[0].file_id, null);
  assert.equal((job.payload as { media: Row[] }).media[0].bytes, 1_000_000_000);
  assert.deepEqual(f.claim().jobs, []);
  const file = f.ctx.create('file_object', { purpose: 'asset', sha256: 'c'.repeat(64), size_bytes: 1_000_000_000, mime_type: 'video/mp4', scan_status: 'skipped', storage_key: 'k' });
  f.ctx.update('asset_version', version.id, { file_object_id: file.id });
  const { subscribers } = await import('./index.js');
  await subscribers[0].run(f.ctx, { type: 'asset.version.created', data: { asset_id: asset.id } });
  const ready = f.job(job.id);
  assert.equal(ready.media_pending, false);
  assert.equal((ready.payload as { media: Row[] }).media[0].file_id, file.id);
  assert.notEqual(ready.payload_hash, job.payload_hash);
  assert.equal(ready.frozen_hash, job.frozen_hash, 'the frozen hash does not move when the upload completes');
  assert.deepEqual(f.claim().jobs.map(item => item.job_id), [job.id]);
});

test('E10: a changed handle alerts the owner once; the first handle seen is not a change', async () => {
  const f = hubFixture();
  const target = await f.schedule(HOUR);
  const job = f.jobOf(target.id);
  f.claim();
  const prepared = (handle: string) => f.report(job.id, 'prepared', { stage: 'preflight', login: 'verified', identity: 'lurelab', handle, media_ok: true, driver: { provider: 'x', version: 'x@2026.11.1' } });
  prepared('lurelab_new');
  prepared('lurelab_new');
  const alerts = f.ctx.list('owner_alert').filter(row => row.kind === 'handle_changed');
  assert.equal(alerts.length, 1, 'one alert per change, not per report');
  assert.equal(alerts[0].severity, 'normal');
  assert.equal(alerts[0].social_account_id, f.account.id);
  assert.match(String(alerts[0].title), /@lurelab 的名稱改成了 @lurelab_new/);
  assert.match(String(alerts[0].body), /^Mac-B 讀到 X 帳號的名稱從 @lurelab 改成了 @lurelab_new。/);
  // An account that never had a handle learns it without an alert.
  f.ctx.update('social_account', f.account.id, { handle: null });
  prepared('lurelab_third');
  assert.equal(f.ctx.list('owner_alert').filter(row => row.kind === 'handle_changed').length, 1);
  assert.equal(f.ctx.get('social_account', f.account.id).handle, 'lurelab_third');
});

test('E9: latest_worker follows the heartbeat arch; macOS without arch gets arm64 only, Windows gets win-x64', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { configureWorkerHost } = await import('./model.js');
  const { refreshHostCaches } = await import('./host-cache.js');
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-e9-'));
  const sha = (n: string) => n.repeat(64);
  const signature = `${'B'.repeat(85)}Q==`;
  const release = (platform: string, file: string, digit: string, signed = false) => writeFileSync(join(dir, `latest-${platform}.json`),
    JSON.stringify({ version: '0.2.0', platform, file, sha256: sha(digit), bytes: 10, built_at: '2027-01-01T00:00:00.000Z', ...(signed && { signature }) }));
  try {
    configureWorkerHost({ workerDownloadDirectory: dir });
    const f = hubFixture();
    release('mac-x64', 'SmartSell-Worker-0.2.0-mac-x64.zip', 'b');
    await refreshHostCaches(true);
    assert.equal(f.heartbeat().latest_worker, null, 'no arch: arm64 is assumed and only arm64 is offered');
    const intel = f.heartbeat([], { arch: 'x64' }).latest_worker;
    assert.equal(intel?.platform, 'mac-x64');
    assert.equal(intel?.url, '/api/v1/worker-downloads/mac-x64');
    assert.equal(intel?.signature, null, 'S1: a manifest without a release signature is offered with signature null');
    assert.equal(f.ctx.get('connector_device', f.device.id).arch, 'x64', 'the CPU is stored when it changes');
    assert.equal(f.heartbeat().latest_worker?.platform, 'mac-x64', 'a later heartbeat without arch uses the stored CPU');
    release('mac-arm64', 'SmartSell-Worker-0.2.0-mac-arm64.zip', 'a');
    release('win-x64', 'SmartSell-Worker-0.2.0-win-x64.exe', 'c', true);
    await refreshHostCaches(true);
    assert.equal(f.heartbeat([], { arch: 'arm64' }).latest_worker?.platform, 'mac-arm64');
    f.ctx.update('connector_device', f.device.id, { platform: 'win32' });
    assert.equal(f.heartbeat([], { arch: 'x64' }).latest_worker?.platform, 'win-x64');
    assert.equal(f.heartbeat([], { arch: 'x64' }).latest_worker?.signature, signature, 'S1: the release signature is passed through verbatim');
    assert.equal(f.heartbeat([], { arch: 'bogus' }).latest_worker?.platform, 'win-x64', 'an unknown arch value is ignored');
  } finally {
    configureWorkerHost({ workerDownloadDirectory: undefined });
    await refreshHostCaches(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
