import assert from 'node:assert/strict';
import test from 'node:test';
import type { Context, Data, Row } from '@smartsell/contracts';
import { describeAction } from './activity.js';
import { viewPeriod } from './calendar.js';
import { channelDetail } from './channels.js';
import { publications } from './home.js';
import { viewWorld, type ViewWorld } from './hub-fixture.js';
import { hubViewOperations } from './hub-views.js';
import { machineSummaries } from './machines.js';
import { listPosts, postDetail, postSummary, postsQuery } from './posts.js';
import { jobTimeline } from './timeline.js';
import { buildOverview, buildToday } from './today.js';

// Wave 6 (G4-web): one test per finding of the views layer. Each scenario is the reviewer's repro; the comment above each
// assertion block says what the code before this wave returned.

const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (w: ViewWorld, ms: number) => new Date(Date.parse(w.ctx.now) + ms).toISOString();
const card = (w: ViewWorld, id: string) => buildToday(w.ctx).attention.find(item => item.id === id);
function view(w: ViewWorld, name: string, query: Record<string, string> = {}) {
  return hubViewOperations.find(item => item.name === name)!.run(w.ctx as Context, { body: {}, params: {}, query }) as unknown;
}
const request = (w: ViewWorld, target: Row) => w.ctx.get('approval_request', String(w.ctx.get('publish_target', target.id).approval_request_id));

test('WV-2 (E34): an approval card offers 核准/駁回 only while the request is pending and before its due_at; afterwards it says the deadline passed', async () => {
  const w = viewWorld();
  const { tiktok } = await w.scheduleBoth(at(w, 5 * 24 * HOUR));
  // A request written before E34 (48 h cap): the request expires days before the post's own deadline.
  w.set('approval_request', request(w, tiktok).id, { due_at: at(w, 48 * HOUR) });
  assert.deepEqual(card(w, `post:${tiktok.id}`)?.actions.map(action => action.kind), ['approve', 'reject', 'open']);
  w.advance(49 * HOUR);
  // Before: the card kept 「請在 11-29 12:30 前核准」 with [approve, reject, open] although the hub refuses the approval.
  let lapsed = card(w, `post:${tiktok.id}`)!;
  assert.deepEqual(lapsed.actions.map(action => action.kind), ['reschedule', 'open']);
  assert.equal(lapsed.detail, '核准期限（11-26 12:00）已過，這則目前不會發出；改期即可重新送審。');
  assert.equal(lapsed.severity, 'urgent');
  assert.deepEqual(postDetail(w.ctx, tiktok.id).actions, ['reschedule', 'cancel']);
  assert.equal(postSummary(w.ctx, tiktok.id).approval_deadline_local, '2026-11-26 12:00', 'the request deadline is shown, also after it passed');
  // The lifecycle scan retires the request (status expired): still no approve.
  w.set('approval_request', request(w, tiktok).id, { status: 'expired' });
  lapsed = card(w, `post:${tiktok.id}`)!;
  assert.deepEqual(lapsed.actions.map(action => action.kind), ['reschedule', 'open']);
  assert.match(lapsed.detail, /^核准期限（11-26 12:00）已過/);
});

test('WV-4 (E35): an active pause is a Today item, held posts carry the pause and are not counted as scheduled', async () => {
  const w = viewWorld();
  const post = await w.schedule(at(w, 2 * HOUR));
  assert.equal(buildToday(w.ctx).counts.scheduled, 1);
  const pause = w.run('publishing_pause', { scope_type: 'workspace', reason: '先全部暫停' }) as Row;
  w.set('pause_switch', pause.id, { created_via: 'agent' });
  // Before: no pause item, the post read 已排程 with no note and counted as scheduled.
  const today = buildToday(w.ctx);
  const item = today.attention.find(entry => entry.id === `pause:${pause.id}`)!;
  assert.deepEqual([item.kind, item.severity, item.blocks_scheduling], ['publishing_paused', 'urgent', false]);
  assert.equal(item.title, '全部發布已暫停：1 則貼文恢復前不會發出');
  assert.equal(item.detail, 'Agent 在 11-24 12:00 暫停（先全部暫停）。最早一則是 11-24 14:00。恢復後，暫停期間排好的貼文會重新送出；已超過遲到上限的會顯示「沒有發出」，可以改期。');
  assert.deepEqual(item.actions, [{ kind: 'open', label: '到設定頁恢復' }]);
  assert.match(item.web_url, /\/settings#st-pause$/);
  assert.equal(today.counts.scheduled, 0);
  const summary = postSummary(w.ctx, post.id) as ReturnType<typeof postSummary> & { pause?: Data };
  assert.equal(summary.status, 'scheduled');
  assert.deepEqual([summary.pause?.scope, summary.pause?.reason, summary.pause?.by, summary.pause?.pause_id], ['workspace', '先全部暫停', 'agent', pause.id]);
  assert.equal((postDetail(w.ctx, post.id).post as unknown as Data).pause !== undefined, true);
  // The Agent's overview reads the same item (E15).
  assert.ok(buildOverview(w.ctx).needs_owner.some(entry => entry.id === `pause:${pause.id}`));
  // A paused machine holds its posts too (machine_paused stays the channel's blocker).
  w.run('publishing_release_pause', {}, { id: pause.id });
  assert.equal(buildToday(w.ctx).attention.some(entry => entry.kind === 'publishing_paused'), false);
  w.set('connector_device', w.device.id, { paused: true, paused_reason: '換網路', paused_by: 'owner', paused_at: w.ctx.now });
  const held = postSummary(w.ctx, post.id) as ReturnType<typeof postSummary> & { pause?: Data };
  assert.deepEqual([held.pause?.scope, held.pause?.reason, held.pause?.by], ['machine', '換網路', 'person']);
  // A channel pause by a person, on a post more than 48 h ahead: a normal item named after the channel.
  w.set('connector_device', w.device.id, { paused: false });
  const far = await w.schedule(at(w, 72 * HOUR));
  const { cancel } = await import('../../planning/index.js');
  cancel(w.ctx, w.ctx.get('publish_target', post.id), 'owner');
  const channelPause = w.run('publishing_pause', { scope_type: 'social_account', scope_id: w.account.id, reason: '檢查文案' }) as Row;
  const item2 = buildToday(w.ctx).attention.find(entry => entry.id === `pause:${channelPause.id}`)!;
  assert.deepEqual([item2.severity, item2.title, item2.channel?.id], ['normal', 'X @lurelab 已暫停：1 則貼文恢復前不會發出', w.account.id]);
  assert.match(item2.detail, /^你在 11-24 12:00 暫停（檢查文案）。最早一則是 11-27 12:00。/);
  assert.equal((postSummary(w.ctx, far.id) as ReturnType<typeof postSummary> & { pause?: Data }).pause?.scope, 'social_account');
});

test('WV-5: the unknown card for an unreported post follows the machine: online asks the owner to check, offline waits', async () => {
  const w = viewWorld();
  const post = await w.schedule(at(w, 30 * MIN));
  const job = w.jobOf(post.id);
  w.prepare(job.id);
  w.at(String(job.not_before));
  w.go(job.id);
  w.report(job.id, 'started', { go: 'hub', mode: 'auto' });
  w.set('worker_job', job.id, { status: 'unreported' });
  w.set('connector_device', w.device.id, { last_seen_at: w.ctx.now });
  assert.equal(postSummary(w.ctx, post.id).machine?.online, true);
  // Before: 「Mac-B 未回報（目前離線），上線後會自動補報。」 while Mac-B was online.
  assert.equal(card(w, `post:${post.id}`)?.detail, 'Mac-B 沒有回報這則的結果。請到平台確認：有就貼上網址，沒有就按「確認沒發出」；系統不會自動重發。');
  w.set('connector_device', w.device.id, { last_seen_at: at(w, -HOUR) });
  assert.equal(card(w, `post:${post.id}`)?.detail, 'Mac-B 未回報（目前離線），上線後會自動補報。');
});

test('WV-6: Today shows every time in the page zone (workspace or ?tz=), the machine 下一則 too', async () => {
  const w = viewWorld();
  w.set('workspace', w.ctx.list('workspace')[0].id, { default_timezone: 'Asia/Taipei' });
  const { x, tiktok } = await w.scheduleBoth('2026-11-25T14:00:00.000Z');
  for (const target of [x, tiktok]) w.set('publish_target', target.id, { schedule_tz: 'America/New_York' });
  // Before: rows showed '2026-11-25 09:00' (New York) under an Asia/Taipei page; ?tz= only moved date and counts.
  const today = buildToday(w.ctx);
  assert.equal(today.timezone, 'Asia/Taipei');
  assert.deepEqual(today.upcoming[0].posts.map(post => post.local_time), ['2026-11-25 22:00', '2026-11-25 22:00']);
  assert.match(today.attention.find(item => item.id === `post:${tiktok.id}`)!.detail, /請在 11-25 22:30 前核准/);
  assert.equal(today.machines.find(machine => machine.name === 'Mac-B')?.next_job?.local_time, '2026-11-25 22:00');
  const ny = buildToday(w.ctx, 'America/New_York');
  assert.deepEqual(ny.upcoming[0].posts.map(post => post.local_time), ['2026-11-25 09:00', '2026-11-25 09:00']);
  assert.equal(ny.machines.find(machine => machine.name === 'Mac-B')?.next_job?.local_time, '2026-11-25 09:00');
  // Every other reader keeps the post's own zone (the Agent appends it, the post page labels it).
  assert.equal(postSummary(w.ctx, x.id).local_time, '2026-11-25 09:00');
  assert.equal(machineSummaries(w.ctx).find(machine => machine.name === 'Mac-B')?.next_job?.local_time, '2026-11-25 22:00', 'machines read in the workspace zone');
});

test('WV-7: 下一則 is the next post still to run, never an older post whose result is unknown or a job being released', async () => {
  const w = viewWorld();
  const old = await w.schedule(at(w, 30 * MIN));
  const oldJob = w.jobOf(old.id);
  w.prepare(oldJob.id);
  w.at(String(oldJob.not_before));
  w.go(oldJob.id);
  w.report(oldJob.id, 'started', { go: 'hub', mode: 'auto' });
  w.report(oldJob.id, 'submitting');
  w.report(oldJob.id, 'outcome_unknown', { reason: 'no_url', evidence_sha256: [] });
  w.advance(20 * HOUR);
  const next = await w.schedule(at(w, 2 * HOUR));
  // Before: next_job pointed at the old post (yesterday 12:30).
  assert.equal(machineSummaries(w.ctx).find(machine => machine.name === 'Mac-B')?.next_job?.post_id, next.id);
  w.set('worker_job', w.jobOf(next.id).id, { status: 'releasing', revoke: { reason: 'cancelled', requested_at: w.ctx.now } });
  assert.equal(machineSummaries(w.ctx).find(machine => machine.name === 'Mac-B')?.next_job, null);
});

test('WV-9: Today offers 恢復 only before the job deadline, as the post page does', async () => {
  const w = viewWorld();
  const post = await w.schedule(at(w, 30 * MIN));
  const job = w.jobOf(post.id);
  w.claim();
  w.report(job.id, 'prepare_blocked', { stage: 'final', blocker: { code: 'platform_error', phase: 'prepare', message: 'error page', at: w.ctx.now } });
  assert.deepEqual(card(w, `post:${post.id}`)?.actions.map(action => action.kind), ['resume', 'open']);
  w.set('worker_job', job.id, { not_after: at(w, -MIN) });
  // Before: 恢復 stayed on the card and the hub answered 409 RESUME_NOT_ALLOWED.
  assert.deepEqual(card(w, `post:${post.id}`)?.actions.map(action => action.kind), ['open']);
  assert.equal(postDetail(w.ctx, post.id).actions.includes('resume'), false);
});

test('F8: posts_list derives the missing bound from the given one and refuses an inverted range', async () => {
  const w = viewWorld();
  const later = await w.schedule('2026-12-10T09:00:00.000Z');
  // Before: {from:'2026-12-10'} kept to = today + 7 (2026-12-01), filtered everything out and answered total 0.
  const fromOnly = listPosts(w.ctx, { from: '2026-12-10' });
  assert.deepEqual([fromOnly.from, fromOnly.to, fromOnly.total, fromOnly.posts[0]?.post_id], ['2026-12-10', '2026-12-17', 1, later.id]);
  // Only `to`: everything from today up to it, or the week before it when it is less than a week away.
  const toOnly = listPosts(w.ctx, { to: '2026-12-10' });
  assert.deepEqual([toOnly.from, toOnly.to, toOnly.total], ['2026-11-24', '2026-12-10', 1]);
  const early = listPosts(w.ctx, { to: '2026-11-26' });
  assert.deepEqual([early.from, early.to, early.total], ['2026-11-19', '2026-11-26', 0]);
  assert.throws(() => listPosts(w.ctx, { from: '2026-12-10', to: '2026-12-01' }),
    (error: { status?: number; code?: string; details?: { issues?: { path: string }[] } }) => error.status === 422 && error.code === 'INVALID_ARGUMENTS' && error.details?.issues?.[0]?.path === 'to');
  assert.equal((view(w, 'views_posts_list', { from: '2026-12-10' }) as { total: number }).total, 1);
});

test('E36: no force release for a job the hub saw start; a never-started job of an offline machine can be released', async () => {
  const w = viewWorld();
  const post = await w.schedule(at(w, 30 * MIN));
  const job = w.jobOf(post.id);
  w.prepare(job.id);
  w.at(String(job.not_before));
  w.go(job.id);
  w.report(job.id, 'started', { go: 'hub', mode: 'auto' });
  w.set('worker_job', job.id, { status: 'unreported' });
  w.set('connector_device', w.device.id, { last_seen_at: at(w, -HOUR) });
  // Before: [confirm_result, mark_not_published, force_release]; the hub now answers 409 POSSIBLY_SENT.
  assert.deepEqual(postDetail(w.ctx, post.id).actions, ['confirm_result', 'mark_not_published']);

  const v = viewWorld();
  const queued = await v.schedule(at(v, 60 * MIN));
  v.claim();
  const { cancel } = await import('../../planning/index.js');
  cancel(v.ctx, v.ctx.get('publish_target', queued.id), 'owner');
  v.set('connector_device', v.device.id, { last_seen_at: at(v, -HOUR) });
  assert.equal(postSummary(v.ctx, queued.id).status, 'cancelling');
  assert.deepEqual(postDetail(v.ctx, queued.id).actions, ['force_release']);
});

test('E37: a rejected post reads 已駁回 with reschedule/cancel, is never an approval card or counted as scheduled, and filters by status', async () => {
  const w = viewWorld();
  const { tiktok } = await w.scheduleBoth(at(w, 3 * HOUR));
  w.run('publishing_reject', { reason: '換一支影片' }, { id: tiktok.id });
  const summary = postSummary(w.ctx, tiktok.id);
  assert.deepEqual([summary.status, summary.approval], ['rejected', 'rejected']);
  assert.deepEqual(postDetail(w.ctx, tiktok.id).actions, ['reschedule', 'cancel']);
  const today = buildToday(w.ctx);
  assert.equal(today.attention.some(item => item.id === `post:${tiktok.id}`), false);
  assert.equal(today.counts.scheduled, 1, 'only the X post');
  assert.deepEqual(postsQuery({ status: 'rejected' }).status, ['rejected']);
  assert.deepEqual(listPosts(w.ctx, { status: ['rejected'] }).posts.map(post => post.post_id), [tiktok.id]);
  assert.equal(channelDetail(w.ctx, w.tiktok.id).next_post, null);
});

test('E41/E36 timeline: retired machine and legacy releases are worded, never as raw event names', async () => {
  const w = viewWorld();
  const post = await w.schedule(at(w, 30 * MIN));
  const job = w.jobOf(post.id);
  for (const outcome of ['requeued', 'unreported', 'cancelled'] as const) {
    w.ctx.create('worker_job_event', { job_id: job.id, event: 'machine_retired', actor: 'human', at: w.ctx.now, detail: { outcome, machine_name: 'Mac-B' } });
  }
  w.ctx.create('worker_job_event', { job_id: job.id, event: 'missed_unclaimed', actor: 'hub', at: w.ctx.now, detail: { reason: 'machine_retired' } });
  const rows = jobTimeline(w.ctx, w.ctx.get('worker_job', job.id), 'Mac-B', 'UTC').filter(row => ['machine_retired', 'missed_unclaimed'].includes(row.event));
  assert.deepEqual(rows.map(row => row.text), [
    '你撤銷了 Mac-B，這則等待新的機器',
    '你撤銷了 Mac-B；它可能已經發出，請到平台確認',
    '你撤銷了 Mac-B，這個工作已結束',
    '沒有發出：機器已撤銷，帳號還沒換到別台機器',
  ]);
});

test('WV-12: the Overview 「本週」 counts phase-1 posts the way Today does (結果不明, 沒有發出)', async () => {
  const w = viewWorld();
  const unknown = await w.schedule(at(w, 30 * MIN));
  const job = w.jobOf(unknown.id);
  w.prepare(job.id);
  w.at(String(job.not_before));
  w.go(job.id);
  w.report(job.id, 'started', { go: 'hub', mode: 'auto' });
  w.report(job.id, 'submitting');
  w.report(job.id, 'outcome_unknown', { reason: 'no_url', evidence_sha256: [] });
  const missed = await w.schedule(at(w, 30 * MIN));
  w.set('worker_job', w.jobOf(missed.id).id, { status: 'missed', finished_at: w.ctx.now });
  assert.deepEqual([postSummary(w.ctx, unknown.id).status, postSummary(w.ctx, missed.id).status], ['unknown', 'missed']);
  // Before: outcome_unknown 0 and failed 0 (the events carry 'unknown' and 'missed').
  const week = publications(w.ctx, viewPeriod(w.ctx, {}, 7), undefined);
  assert.deepEqual([week.outcome_unknown, week.failed], [1, 1]);
});

test('E41: the activity feed words a retired machine', () => {
  assert.deepEqual(describeAction('hub_machines_retire').summary, ['撤銷了機器', 'Retired a machine']);
});
