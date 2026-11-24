import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Problem, Row } from '@smartsell/contracts';
import { updateTarget } from '../planning/index.js';
import { hubFixture } from './fixtures.js';
import { createCheckLoginJob, createDryRunJob } from './dispatch.js';
import { forceReleaseText } from './index.js';
import { readBundledClip } from './host-cache.js';
import { configureWorkerHost } from './model.js';
import { resetPresence } from './presence.js';
import { requestRevoke } from './revoke.js';

const HOUR = 3_600_000;
const MIN = 60_000;
const code = (expected: string) => (error: unknown) => { assert.equal((error as Problem).code, expected); return true; };
const agent = { role: 'owner' as const, agentCredentialId: 'agent-credential' };

test('lifecycle: unclaimed and media-pending jobs end as missed; media still uploading at prepare time asks the owner (§5.13 1, 2, 7)', async () => {
  const f = hubFixture();
  const job = f.jobOf((await f.schedule(HOUR)).id);
  f.at(new Date(Date.parse(String(job.not_after)) + 1000).toISOString());
  f.lifecycle();
  assert.equal(f.job(job.id).status, 'missed');
  assert.ok(f.timeline(job.id).includes('missed_unclaimed'));
  assert.equal(f.task(String(job.publish_target_id)).status, 'blocked');
  assert.ok(f.ctx.list('owner_alert').some(row => row.kind === 'missed'));

  const g = hubFixture();
  const asset = g.ctx.create('asset', { kind: 'video', brand_id: null, ownership: 'owned', origin: 'agent_upload', status: 'uploading', title: 'big.mp4' });
  const version = g.ctx.create('asset_version', { asset_id: asset.id, file_object_id: null, sha256: 'c'.repeat(64), mime_type: 'video/mp4', meta: null });
  const clip = await g.variant('Still uploading', [{ asset_id: asset.id, asset_version_id: version.id, role: 'primary' }]);
  const created = g.run('publishing_create_target', { social_account_id: g.account.id, content_variant_id: clip.id, late_policy: 'skip', grace_minutes: 30,
    scheduled_at: new Date(Date.parse(g.ctx.now) + HOUR).toISOString() }) as Row;
  g.run('publishing_request_approval', {}, { id: created.id });
  const pending = g.jobOf(created.id);
  assert.equal(pending.media_pending, true);
  g.at(new Date(Date.parse(String(pending.not_before)) - 31 * MIN).toISOString());
  g.lifecycle();
  assert.equal(g.job(pending.id).status, 'queued');
  g.at(new Date(Date.parse(String(pending.not_before)) - 29 * MIN).toISOString());
  g.lifecycle();
  assert.equal(g.job(pending.id).status, 'needs_owner');
  assert.equal((g.job(pending.id).blocker as Row).code, 'media_unavailable');
  g.at(new Date(Date.parse(String(pending.not_after)) + 1000).toISOString());
  g.lifecycle();
  assert.equal(g.job(pending.id).status, 'missed');
});

test('lifecycle: a claimed job past the window is missed when the hub can prove the machine never ran it, otherwise unreported (§5.6)', async () => {
  // Memory presence: the last contact long before not_before − staleness → missed_machine_off.
  const f = hubFixture();
  const job = f.jobOf((await f.schedule(2 * HOUR)).id);
  f.heartbeat();
  f.prepare(job.id);
  f.at(new Date(Date.parse(String(job.not_after)) + 11 * MIN).toISOString());
  f.lifecycle();
  assert.equal(f.job(job.id).status, 'missed');
  assert.ok(f.timeline(job.id).includes('missed_machine_off'));
  // Recent contact: the machine may have run offline → unreported (not terminal; facts can still arrive).
  const g = hubFixture();
  const recent = g.jobOf((await g.schedule(2 * HOUR)).id);
  g.prepare(recent.id);
  g.at(new Date(Date.parse(String(recent.not_before)) - 5 * MIN).toISOString());
  g.heartbeat([recent.id]);
  g.at(new Date(Date.parse(String(recent.not_after)) + 11 * MIN).toISOString());
  g.lifecycle();
  assert.equal(g.job(recent.id).status, 'unreported');
  assert.ok(g.ctx.list('owner_alert').some(row => row.kind === 'unknown'));
  g.report(recent.id, 'missed', { reason: 'machine_was_off' }, { fence: 1 });
  assert.equal(g.job(recent.id).status, 'missed', 'the machine reports later and settles it');
  // Hub restarted (no memory): the stored last_seen_at carries a 5-minute write error.
  const h = hubFixture();
  const stored = h.jobOf((await h.schedule(2 * HOUR)).id);
  h.prepare(stored.id);
  resetPresence();
  const contact = Date.parse(String(stored.not_before)) - 30 * MIN - 2 * MIN - 5 * MIN - 10_000;
  h.ctx.update('connector_device', h.device.id, { last_seen_at: new Date(contact).toISOString(), last_job_sync_at: null });
  h.at(new Date(Date.parse(String(stored.not_after)) + 11 * MIN).toISOString());
  h.lifecycle();
  assert.equal(h.job(stored.id).status, 'missed');
  const i = hubFixture();
  const close = i.jobOf((await i.schedule(2 * HOUR)).id);
  i.prepare(close.id);
  resetPresence();
  i.ctx.update('connector_device', i.device.id, { last_seen_at: new Date(Date.parse(String(close.not_before)) - 30 * MIN - 4 * MIN).toISOString(), last_job_sync_at: null });
  i.at(new Date(Date.parse(String(close.not_after)) + 11 * MIN).toISOString());
  i.lifecycle();
  assert.equal(i.job(close.id).status, 'unreported', 'within the write error the hub cannot prove it');
  // A releasing job proven not run ends as its revoke says.
  const j = hubFixture();
  const releasing = j.jobOf((await j.schedule(2 * HOUR)).id);
  j.heartbeat();
  j.prepare(releasing.id);
  requestRevoke(j.ctx, j.job(releasing.id), 'superseded');
  j.at(new Date(Date.parse(String(releasing.not_after)) + 11 * MIN).toISOString());
  j.lifecycle();
  assert.equal(j.job(releasing.id).status, 'superseded');
});

test('lifecycle: running without submitting goes unreported; result_pending past the guard goes outcome_unknown (§5.13 4, 5)', async () => {
  const f = hubFixture();
  const job = f.jobOf((await f.schedule(HOUR)).id);
  f.prepare(job.id);
  f.at(String(job.not_before));
  f.go(job.id);
  f.at(new Date(Date.parse(String(job.not_after)) + 9 * MIN).toISOString());
  f.lifecycle();
  assert.equal(f.job(job.id).status, 'running');
  f.advance(2 * MIN);
  f.lifecycle();
  assert.equal(f.job(job.id).status, 'unreported');
  assert.equal(f.task(String(job.publish_target_id)).status, 'outcome_unknown');
  const g = hubFixture();
  const pending = g.jobOf((await g.schedule(HOUR)).id);
  g.prepare(pending.id);
  g.at(String(pending.not_before));
  g.go(pending.id);
  g.report(pending.id, 'started', { go: 'hub', mode: 'auto' });
  g.report(pending.id, 'submitting');
  g.report(pending.id, 'submitted', {});
  g.advance(3510 * 1000 + 29 * MIN);
  g.lifecycle();
  assert.equal(g.job(pending.id).status, 'result_pending', 'the guard waits for the whole read-back schedule plus 30 minutes');
  g.advance(2 * MIN);
  g.lifecycle();
  assert.equal(g.job(pending.id).status, 'outcome_unknown');
});

test('lifecycle: an expired check_login is queued once more, then failed (§5.12)', async () => {
  const f = hubFixture();
  const job = createCheckLoginJob(f.ctx, f.account.id, { openLoginWindow: true });
  f.claim();
  f.at(new Date(Date.parse(String(f.job(job.id).lease_expires_at)) + 1000).toISOString());
  f.lifecycle();
  assert.equal(f.job(job.id).status, 'queued');
  f.claim([]);
  f.at(new Date(Date.parse(String(f.job(job.id).lease_expires_at)) + 1000).toISOString());
  f.lifecycle();
  assert.equal(f.job(job.id).status, 'failed');
});

test('lifecycle: a live job whose post went back for approval is revoked instead of running out as missed', async () => {
  const f = hubFixture({ approval: 'needs_approval' });
  const target = await f.schedule(2 * HOUR);
  f.run('publishing_approve', { resource_hash: f.ctx.get('approval_request', String(f.ctx.get('publish_target', target.id).approval_request_id)).resource_hash }, { id: target.id });
  const job = f.jobOf(target.id);
  f.claim();
  // Outside the tolerance: the approval is retired and the post waits for the owner again.
  const moved = updateTarget(f.ctx, f.ctx.get('publish_target', target.id), { scheduled_at: new Date(Date.parse(String(target.scheduled_at)) + 5 * HOUR).toISOString() }, true);
  assert.equal(moved.approval_retained, false);
  f.lifecycle();
  assert.equal(f.job(job.id).status, 'releasing');
  assert.equal((f.job(job.id).revoke as Row).reason, 'approval_invalidated');
});

test('§5.14 confirm_result validates the URL against the account and publishes as manual_confirmed (person only)', async () => {
  const f = hubFixture();
  const target = await f.schedule(HOUR);
  const job = f.jobOf(target.id);
  f.prepare(job.id);
  f.at(String(job.not_before));
  f.go(job.id);
  f.report(job.id, 'started', { go: 'hub', mode: 'auto' });
  f.report(job.id, 'submitting');
  f.report(job.id, 'outcome_unknown', { reason: 'readback_exhausted', evidence_sha256: [] });
  assert.throws(() => f.run('hub_posts_confirm_result', { url: 'https://x.com/lurelab/status/77' }, { id: target.id }, agent), code('HUMAN_REQUIRED'));
  assert.throws(() => f.run('hub_posts_confirm_result', { url: 'https://x.com/someone/status/77' }, { id: target.id }), code('INVALID_ARGUMENTS'));
  assert.throws(() => f.run('hub_posts_confirm_result', { url: 'http://x.com/lurelab/status/77' }, { id: target.id }), code('INVALID_ARGUMENTS'));
  assert.throws(() => f.run('hub_posts_confirm_result', { url: 'https://example.com/lurelab/status/77' }, { id: target.id }), code('INVALID_ARGUMENTS'));
  const confirmed = f.run('hub_posts_confirm_result', { url: 'https://twitter.com/LureLab/status/77?s=20' }, { id: target.id }) as Row;
  assert.equal(confirmed.status, 'succeeded');
  const post = f.ctx.get('platform_post', String(f.ctx.get('publish_target', target.id).platform_post_id));
  assert.deepEqual([post.verification, post.external_post_id, post.permalink], ['manual_confirmed', '77', 'https://x.com/LureLab/status/77']);
  assert.ok(f.timeline(job.id).includes('owner_confirmed'));
  assert.equal(f.task(target.id).status, 'published');
  // /i/status/<id> is accepted for X; TikTok needs /video/<id>.
  const g = hubFixture({ provider: 'tiktok' });
  const tt = await g.schedule(HOUR);
  const ttJob = g.jobOf(tt.id);
  g.prepare(ttJob.id);
  g.at(String(ttJob.not_before));
  g.go(ttJob.id);
  g.report(ttJob.id, 'started', { go: 'hub', mode: 'auto' });
  g.report(ttJob.id, 'submitting');
  g.report(ttJob.id, 'outcome_unknown', { reason: 'x', evidence_sha256: [] });
  assert.throws(() => g.run('hub_posts_confirm_result', { url: 'https://www.tiktok.com/@lurelab' }, { id: tt.id }), code('INVALID_ARGUMENTS'));
  g.run('hub_posts_confirm_result', { url: 'https://www.tiktok.com/@lurelab_new/video/7300000000000000001' }, { id: tt.id });
  assert.equal(g.ctx.get('social_account', g.account.id).handle, 'lurelab_new', 'TikTok: the handle is matched, not enforced');
});

test('§5.14 retry only before start, resume only for owner-resume blockers, force_release with the exact sentence', async () => {
  const f = hubFixture();
  const target = await f.schedule(HOUR);
  const job = f.jobOf(target.id);
  f.claim();
  f.report(job.id, 'prepare_blocked', { stage: 'preflight', blocker: { code: 'login_expired', phase: 'prepare', message: '', at: f.ctx.now } });
  assert.throws(() => f.run('hub_posts_retry', {}, { id: target.id }, agent), code('HUMAN_REQUIRED'));
  const retried = f.run('hub_posts_retry', {}, { id: target.id }) as Row;
  const fresh = f.jobOf(target.id);
  assert.notEqual(fresh.id, job.id);
  assert.equal(fresh.retry_of_job_id, job.id);
  assert.equal(fresh.waits_for_job_id, job.id);
  assert.equal(retried.previous_job_id, job.id);
  assert.equal(f.job(job.id).status, 'releasing');
  // A started job (assist waiting for the owner's click) cannot be retried.
  const g = hubFixture();
  const gt = await g.schedule(HOUR);
  const started = g.jobOf(gt.id);
  g.prepare(started.id);
  g.at(String(started.not_before));
  g.go(started.id);
  g.report(started.id, 'started', { go: 'hub', mode: 'assist' });
  g.report(started.id, 'blocked', { blocker: { code: 'owner_click_required', phase: 'before_submit', message: '' } });
  assert.throws(() => g.run('hub_posts_retry', {}, { id: gt.id }), code('RETRY_NOT_ALLOWED'));
  assert.throws(() => g.run('hub_jobs_resume', {}, { id: started.id }), code('RESUME_NOT_ALLOWED'));
  // Resume after a risk prompt: blocker cleared, resume_token up, carried by the heartbeat.
  const h = hubFixture();
  const ht = await h.schedule(HOUR);
  const risky = h.jobOf(ht.id);
  h.claim();
  h.report(risky.id, 'prepare_blocked', { stage: 'final', blocker: { code: 'risk_prompt', phase: 'prepare', message: '', at: h.ctx.now } });
  assert.equal((h.job(risky.id).blocker as Row).resumable_by, 'owner');
  assert.throws(() => h.run('hub_jobs_resume', {}, { id: risky.id }, agent), code('HUMAN_REQUIRED'));
  h.run('hub_jobs_resume', {}, { id: risky.id });
  assert.equal(h.job(risky.id).blocker, null);
  assert.equal(h.heartbeat([risky.id]).jobs[0].resume_token, 1);
  // force_release: person only, exact sentence with the machine name; the successor is released.
  const k = hubFixture();
  const kt = await k.schedule(2 * HOUR);
  const old = k.jobOf(kt.id);
  k.claim();
  updateTarget(k.ctx, k.ctx.get('publish_target', kt.id), { scheduled_at: new Date(Date.parse(String(kt.scheduled_at)) + 10 * MIN).toISOString() }, true);
  const successor = k.jobOf(kt.id);
  assert.equal(k.job(old.id).status, 'releasing');
  assert.throws(() => k.run('hub_jobs_force_release', { confirm_text: forceReleaseText('Mac-B') }, { id: old.id }, agent), code('HUMAN_REQUIRED'));
  assert.throws(() => k.run('hub_jobs_force_release', { confirm_text: 'yes' }, { id: old.id }), code('CONFIRM_TEXT_MISMATCH'));
  k.run('hub_jobs_force_release', { confirm_text: '我確認 Mac-B 已關機或已斷網，不會發出這則貼文。' }, { id: old.id });
  assert.equal(k.job(old.id).status, 'cancelled');
  assert.ok(k.job(successor.id).waits_released_at);
  // A late fact after the forced release is still accepted and alerted; the unstarted successor is cancelled.
  k.report(old.id, 'submitting', {}, { fence: 1 });
  assert.equal(k.job(old.id).status, 'outcome_unknown');
  assert.ok(k.timeline(old.id).includes('late_fact_after_release'));
  // E2E-13 (closure-S8): force_release had already released the successor; the late fact still cancels it, so no
  // machine can claim it and post a second time.
  assert.equal(k.job(successor.id).status, 'cancelled');
  assert.ok(k.timeline(successor.id).includes('successor_cancelled_predecessor_posted'));
  assert.equal(k.claim().jobs.some(item => item.job_id === successor.id), false);
});

test('§5.4.3 late fact after force_release: a successor the machine already claimed is revoked before it can start (E2E-13)', async () => {
  const k = hubFixture();
  const kt = await k.schedule(2 * HOUR);
  const old = k.jobOf(kt.id);
  k.claim();
  updateTarget(k.ctx, k.ctx.get('publish_target', kt.id), { scheduled_at: new Date(Date.parse(String(kt.scheduled_at)) + 10 * MIN).toISOString() }, true);
  const successor = k.jobOf(kt.id);
  k.run('hub_jobs_force_release', { confirm_text: forceReleaseText('Mac-B') }, { id: old.id });
  // The machine reconnects and claims the released successor before its late facts arrive.
  assert.ok(k.claim([old.id]).jobs.some(item => item.job_id === successor.id));
  assert.equal(k.job(successor.id).status, 'claimed');
  k.report(old.id, 'started', { go: 'offline', mode: 'auto' }, { fence: 1 });
  k.report(old.id, 'submitting', {}, { fence: 1 });
  k.report(old.id, 'submitted', {}, { fence: 1 });
  k.report(old.id, 'result', k.resultData(), { fence: 1 });
  assert.equal(k.job(old.id).status, 'succeeded');
  assert.equal(k.job(successor.id).status, 'releasing');
  assert.equal((k.job(successor.id).revoke as Row).reason, 'superseded');
  assert.ok(k.timeline(successor.id).includes('successor_cancelled_predecessor_posted'));
  k.at(String(k.job(successor.id).not_before));
  assert.equal(k.go(successor.id).go, false, 'go is denied while the successor is being released');
  assert.ok(k.heartbeat([successor.id]).revoked_jobs.some(item => item.job_id === successor.id));
  k.report(successor.id, 'released', {});
  assert.equal(k.job(successor.id).status, 'superseded');
});

test('§5.14 mark_not_published only for an unknown result; dry run is a target-less job that skips approval and limits', async () => {
  const f = hubFixture();
  const target = await f.schedule(HOUR);
  assert.throws(() => f.run('hub_posts_mark_not_published', { confirm: true }, { id: target.id }), code('JOB_INVALID_STATE'));
  assert.throws(() => f.run('hub_posts_mark_not_published', { confirm: false }, { id: target.id }), code('INVALID_ARGUMENTS'));
  configureWorkerHost({ bundledClip: { sha256: 'd'.repeat(64), bytes: 1234 } });
  assert.throws(() => f.run('hub_channels_dry_run', {}, { id: f.account.id }, agent), code('HUMAN_REQUIRED'));
  const dry = f.run('hub_channels_dry_run', {}, { id: f.account.id }) as Row;
  const job = f.job(String(dry.job_id));
  assert.deepEqual([job.dry_run, job.publish_target_id, job.mode], [true, null, 'auto']);
  assert.deepEqual((job.payload as { media: Row[] }).media[0], { file_id: null, bundled: 'test-clip-v1', sha256: 'd'.repeat(64), bytes: 1234, mime: 'video/mp4',
    filename: 'test-clip.mp4', kind: 'video', duration_ms: null, width: null, height: null });
  assert.equal(Date.parse(String(job.not_after)) - Date.parse(String(job.not_before)), 30 * MIN);
  f.ctx.update('channel_settings', f.settings().id, { daily_cap: 1, window: { start: '00:00', end: '00:01', days: [1] } });
  f.claim();
  assert.equal(f.go(job.id).go, true, 'dry run skips approval, daily cap and window');
  f.report(job.id, 'started', { go: 'hub', mode: 'auto' });
  f.report(job.id, 'dry_run_done', { evidence_sha256: [], trace: [{ step: 'open', ms: 10, matched: 'primary' }] });
  assert.equal(f.job(job.id).status, 'succeeded');
  assert.equal((f.job(job.id).result as Row).dry_run, true);
  assert.equal(f.ctx.list('platform_post').length, 0, 'no post');
  assert.throws(() => createDryRunJob(f.ctx, 'missing-account', {}), code('NOT_FOUND'));
});

test('S9 ledger 3: a dry run names the bundled clip with its manifest hash, size and dimensions', async () => {
  const f = hubFixture();
  const clip = await readBundledClip();
  assert.ok(clip, 'apps/connector-desktop/resources/test-clip.json is readable');
  configureWorkerHost({ bundledClip: clip });
  const job = f.job(String((f.run('hub_channels_dry_run', {}, { id: f.account.id }) as Row).job_id));
  assert.deepEqual((job.payload as { media: Row[] }).media[0], { file_id: null, bundled: 'test-clip-v1', sha256: clip!.sha256, bytes: clip!.bytes, mime: 'video/mp4',
    filename: 'test-clip.mp4', kind: 'video', duration_ms: 4000, width: 720, height: 1280 });
});

test('S3 review: releasing a pause after the scheduled time but within the lateness limit keeps the post and its job', async () => {
  const f = hubFixture();
  const target = await f.schedule(HOUR);
  const job = f.jobOf(target.id);
  f.prepare(job.id);
  const pause = f.run('publishing_pause', { scope_type: 'social_account', scope_id: f.account.id, reason: 'hold' }) as Row;
  f.at(new Date(Date.parse(String(target.scheduled_at)) + 5 * MIN).toISOString());
  f.run('publishing_release_pause', {}, { id: pause.id });
  assert.equal(f.ctx.get('publish_target', target.id).plan_status, 'ready');
  assert.equal(f.jobOf(target.id).id, job.id, 'the held job is kept (pause never revokes)');
  assert.equal(f.go(job.id).go, true, 'and runs late within its window');
});

test('lifecycle: a successor waiting on a predecessor that turned outcome_unknown is cancelled with an urgent alert (§5.13 8)', async () => {
  const f = hubFixture();
  const target = await f.schedule(2 * HOUR);
  const old = f.jobOf(target.id);
  f.prepare(old.id);
  updateTarget(f.ctx, f.ctx.get('publish_target', target.id), { scheduled_at: new Date(Date.parse(String(target.scheduled_at)) + 10 * MIN).toISOString() }, true);
  const successor = f.jobOf(target.id);
  assert.equal(successor.waits_for_job_id, old.id);
  // The old job ran offline before it learned of the revoke: its facts arrive while it is still releasing.
  f.at(String(old.not_before));
  f.report(old.id, 'started', { go: 'offline', mode: 'auto' });
  f.report(old.id, 'submitting');
  f.report(old.id, 'outcome_unknown', { reason: 'readback_exhausted', evidence_sha256: [] });
  f.lifecycle();
  assert.equal(f.job(successor.id).status, 'cancelled');
  assert.ok(f.timeline(successor.id).includes('successor_cancelled_predecessor_posted'));
  assert.ok(f.ctx.list('owner_alert').some(row => row.kind === 'late_fact_after_release' && row.severity === 'urgent'));
  assert.equal(f.jobOf(target.id).id, old.id, 'the post follows the job that may have posted');
});
