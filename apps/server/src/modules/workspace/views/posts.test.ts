import assert from 'node:assert/strict';
import test from 'node:test';
import { type Context, type Data, type Row } from '@smartsell/contracts';
import { channelOperations } from '../../account/channel-ops.js';
import { hubViewOperations } from './hub-views.js';
import { viewWorld, type ViewWorld } from './hub-fixture.js';
import { jobDetail, listPosts, postDetail, postSummary } from './posts.js';

const MIN = 60_000;
const at = (w: ViewWorld, ms: number) => new Date(Date.parse(w.ctx.now) + ms).toISOString();
const status = (w: ViewWorld, target: Row) => postSummary(w.ctx, target.id).status;
function settings(w: ViewWorld, accountId: string, body: Data) {
  const op = channelOperations.find(item => item.name === 'hub_channels_update_settings')!;
  const row = w.ctx.list('channel_settings').find(item => item.social_account_id === accountId)!;
  return op.run(w.ctx, { body, params: { id: accountId }, query: {}, expectedVersion: row.version });
}
function view(w: ViewWorld, name: string, query: Record<string, string> = {}, params: Record<string, string> = {}) {
  const op = hubViewOperations.find(item => item.name === name)!;
  return op.run(w.ctx as Context, { body: {}, params, query }) as unknown;
}

test('derivePostStatus through postSummary: every Worker stage, cancelling and the approval deadline', async () => {
  const w = viewWorld();
  const post = await w.schedule(at(w, 60 * MIN));
  const job = () => w.jobOf(post.id);
  assert.equal(status(w, post), 'scheduled');
  w.prepare(job().id);
  assert.equal(status(w, post), 'ready');
  w.at(String(job().not_before));
  assert.equal(w.go(job().id).go, true);
  w.report(job().id, 'started', { go: 'hub', mode: 'auto' });
  assert.equal(status(w, post), 'publishing');
  w.report(job().id, 'submitting');
  assert.equal(status(w, post), 'publishing');
  w.report(job().id, 'submitted', {});
  assert.equal(status(w, post), 'confirming');
  w.report(job().id, 'result', w.resultData());
  const summary = postSummary(w.ctx, post.id);
  assert.deepEqual([summary.status, summary.url, summary.machine?.name, summary.route_kind, summary.mode, summary.approval],
    ['published', 'https://x.com/lurelab/status/1861234567890123456', 'Mac-B', 'machine', 'auto', 'approved_by_channel_policy']);
  assert.equal(summary.channel.label, 'X @lurelab');
  assert.match(summary.web_url, /^https:\/\/hub\.example\.ts\.net\/app\/ws-[^/]+\/posts\//);
});

test('a claimed post that is cancelled shows cancelling, then cancelled; a captcha shows needs_owner with the machine and account', async () => {
  const w = viewWorld();
  const cancelled = await w.schedule(at(w, 60 * MIN));
  w.claim();
  const { cancel } = await import('../../planning/index.js');
  cancel(w.ctx, w.ctx.get('publish_target', cancelled.id), 'owner');
  assert.equal(status(w, cancelled), 'cancelling');
  const detail = postDetail(w.ctx, cancelled.id);
  assert.ok(detail.actions.length === 0 || detail.actions.every(action => action === 'force_release'));
  w.report(w.jobOf(cancelled.id).id, 'released');
  assert.equal(status(w, cancelled), 'cancelled');

  const blocked = await w.schedule(at(w, 120 * MIN));
  const job = w.jobOf(blocked.id);
  w.claim();
  w.report(job.id, 'prepare_blocked', { stage: 'preflight', blocker: { code: 'captcha', phase: 'prepare', message: 'captcha', at: w.ctx.now } });
  const summary = postSummary(w.ctx, blocked.id);
  assert.equal(summary.status, 'needs_owner');
  assert.equal(summary.blocker?.code, 'captcha');
  assert.match(summary.blocker!.message, /Mac-B 的 X @lurelab 出現驗證碼/);
  assert.deepEqual(postDetail(w.ctx, blocked.id).actions, ['retry', 'cancel']);
});

test('an unapproved post past its deadline is missed (not_approved); a revoked job after an approval change is not shown as cancelled', async () => {
  const w = viewWorld();
  const { tiktok } = await w.scheduleBoth(at(w, 10 * MIN));
  const pending = postSummary(w.ctx, tiktok.id);
  assert.deepEqual([pending.status, pending.approval, pending.mode], ['awaiting_approval', 'awaiting_owner', 'assist']);
  assert.equal(pending.approval_deadline_local, '2026-11-24 12:40');
  assert.deepEqual(postDetail(w.ctx, tiktok.id).actions, ['approve', 'reject', 'reschedule', 'cancel']);
  w.advance(45 * MIN);
  const lapsed = postSummary(w.ctx, tiktok.id);
  assert.deepEqual([lapsed.status, lapsed.missed_reason], ['missed', 'not_approved']);

  // A job revoked because the approval became invalid (§5.10) is shown by the post's own state, never as cancelled.
  const v = viewWorld();
  const post = await v.schedule(at(v, 60 * MIN));
  v.claim();
  assert.equal(status(v, post), 'scheduled');
  const job = v.jobOf(post.id);
  v.set('worker_job', job.id, { status: 'releasing', revoke: { reason: 'approval_invalidated', requested_at: v.ctx.now } });
  v.set('publish_target', post.id, { plan_status: 'awaiting_approval' });
  assert.equal(status(v, post), 'awaiting_approval');
  v.set('worker_job', job.id, { status: 'cancelled' });
  assert.equal(status(v, post), 'awaiting_approval');
});

test('E23: switching a direct channel to needs_approval withdraws a claimed job at once and shows awaiting approval', async () => {
  const v = viewWorld();
  const post = await v.schedule(at(v, 60 * MIN));
  v.claim();
  const job = v.jobOf(post.id);
  assert.equal(status(v, post), 'scheduled');
  settings(v, v.account.id, { approval_mode: 'needs_approval' });
  const after = v.ctx.get('worker_job', job.id);
  assert.equal(after.status, 'releasing');
  assert.equal((after.revoke as Data).reason, 'approval_invalidated');
  assert.equal(v.ctx.get('publish_target', post.id).plan_status, 'awaiting_approval');
  assert.equal(status(v, post), 'awaiting_approval');
});

test('E17: a force-released job on a post that was not cancelled is a missed run, and a cancelled post stays cancelled', async () => {
  const { derivePostStatus } = await import('@smartsell/contracts');
  const base = { plan_status: 'ready', has_platform_post: false, job_status: 'cancelled' as const };
  assert.equal(derivePostStatus(base), 'scheduled');
  assert.equal(derivePostStatus({ ...base, job_force_released: true }), 'missed');
  assert.equal(derivePostStatus({ ...base, plan_status: 'cancelled', job_force_released: true }), 'cancelled');
  assert.equal(derivePostStatus({ ...base, has_platform_post: true, job_force_released: true }), 'published');
});

test('an outcome_unknown post offers confirm / mark not published; assist posts carry the owner click window', async () => {
  const w = viewWorld();
  const post = await w.schedule(at(w, 30 * MIN));
  const job = w.jobOf(post.id);
  w.prepare(job.id);
  w.at(String(job.not_before));
  w.go(job.id);
  w.report(job.id, 'started', { go: 'hub', mode: 'auto' });
  w.report(job.id, 'submitting');
  w.report(job.id, 'outcome_unknown', { reason: 'no_url', evidence_sha256: [] });
  const detail = postDetail(w.ctx, post.id);
  assert.equal(detail.post.status, 'unknown');
  assert.deepEqual(detail.actions, ['confirm_result', 'mark_not_published']);
  assert.ok(detail.task!.timeline.some(row => row.event === 'outcome_unknown' && /不會自動重發/.test(row.text)));
  assert.equal(jobDetail(w.ctx, job.id).machine.name, 'Mac-B');

  const a = viewWorld();
  a.set('channel_settings', a.settings().id, { risk_ack: null });
  const assisted = await a.schedule(at(a, 60 * MIN));
  const owner = postSummary(a.ctx, assisted.id).owner_action;
  assert.equal(owner?.machine.name, 'Mac-B');
  assert.equal(owner?.from_local, '2026-11-24 13:00');
  assert.equal(owner?.until_local, '2026-11-24 13:30');
});

test('views_posts_list filters by local date, status, channel and machine, and refuses unknown parameters', async () => {
  const w = viewWorld();
  const { x, tiktok } = await w.scheduleBoth('2026-11-25T01:00:00.000Z');
  const all = listPosts(w.ctx, { from: '2026-11-25', to: '2026-11-25' });
  assert.deepEqual(all.posts.map(post => post.post_id).sort(), [x.id, tiktok.id].sort());
  assert.deepEqual(listPosts(w.ctx, { status: ['awaiting_approval'] }).posts.map(post => post.post_id), [tiktok.id]);
  assert.deepEqual(listPosts(w.ctx, { machine_id: w.device.id }).posts.map(post => post.post_id), [x.id]);
  assert.deepEqual(listPosts(w.ctx, { channel_id: w.tiktok.id }).posts.map(post => post.post_id), [tiktok.id]);
  const rest = view(w, 'views_posts_list', { from: '2026-11-25', status: 'scheduled,awaiting_approval' }) as { total: number };
  assert.equal(rest.total, 2);
  for (const [name, query] of [['views_posts_list', { platform: 'x' }], ['views_posts_list', { status: 'later' }], ['views_today', { date: '2026-11-25' }],
    ['views_machines_list', { offline: 'true' }], ['views_channels_list', { provider: 'instagram' }], ['views_overview', { brand: 'b' }]] as const) {
    assert.throws(() => view(w, name, query as Record<string, string>), (error: { status?: number; code?: string }) => error.status === 422 && error.code === 'INVALID_ARGUMENTS', `${name} ${JSON.stringify(query)}`);
  }
  assert.throws(() => view(w, 'views_post_get', { full: '1' }, { id: x.id }), (error: { status?: number }) => error.status === 422);
  assert.throws(() => postSummary(w.ctx, '00000000-0000-4000-8000-000000000000'), (error: { status?: number; code?: string }) => error.status === 404 && error.code === 'POST_NOT_FOUND');
});
