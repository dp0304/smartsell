// Security audit S7: what one paired machine may write through jobs.report (§5.4.3). A Worker that is paired but malicious
// (or broken) must not report under fences it never held, grow a job without bound, or plant a link on the post.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Problem, Row } from '@smartsell/contracts';
import { configuration } from '../../config.js';
import { updateTarget } from '../planning/index.js';
import { MAX_RECOVERY_CLAIMS_PER_JOB, MAX_REPORTS_PER_JOB, reportJob } from './device-jobs.js';
import { createDryRunJob } from './dispatch.js';
import { hubFixture } from './fixtures.js';
import { forceReleaseText } from './index.js';
import { configureWorkerHost } from './model.js';
import { moveQueuedChannelJobs, requestRevoke } from './revoke.js';

const HOUR = 3_600_000;
const MIN = 60_000;
const code = (expected: string) => (error: unknown) => { assert.equal((error as Problem).code, expected); return true; };
const events = (f: ReturnType<typeof hubFixture>, jobId: string) => f.ctx.list('worker_job_event').filter(row => row.job_id === jobId);

test('S7: a fence above the current one was never issued — facts and lease reports get JOB_FENCE_LOST and open no seq bucket', async () => {
  const f = hubFixture();
  const job = f.jobOf((await f.schedule(HOUR)).id);
  f.prepare(job.id);
  const before = events(f, job.id).length;
  for (const fence of [2, 99, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => f.report(job.id, 'result', f.resultData(), { fence, seq: 1 }), code('JOB_FENCE_LOST'), `fact under fence ${fence}`);
    assert.throws(() => f.report(job.id, 'readback_pending', {}, { fence, seq: 1 }), code('JOB_FENCE_LOST'), `lease report under fence ${fence}`);
  }
  assert.deepEqual(f.job(job.id).seq_by_fence, { 1: 2 }, 'no new sequence bucket');
  assert.equal(events(f, job.id).length, before, 'no event written');
  assert.equal(f.job(job.id).status, 'ready');
});

test('S7: a machine in device_history that never held the fence cannot mark the job succeeded or cancel its replacement', async () => {
  const f = hubFixture();
  const target = await f.schedule(2 * HOUR);
  const job = f.jobOf(target.id);
  // The account moved to Win-C before Mac-B claimed the job: Mac-B stays in device_history, but never held a lease.
  f.ctx.update('account_execution_binding', f.binding.id, { device_id: f.other.id });
  assert.deepEqual(moveQueuedChannelJobs(f.ctx, f.account.id, f.other.id), { moved: 1 });
  assert.deepEqual(f.job(job.id).device_history, [f.device.id, f.other.id]);
  f.claim([], {}, f.other);
  assert.equal(f.job(job.id).fencing_token, 2);
  // Mac-B tries the current fence, the 換機器 fence and the never-claimed fence 0.
  for (const fence of [2, 1, 0]) {
    assert.throws(() => f.report(job.id, 'result', f.resultData(), { fence, seq: 1, machine: f.device }), code('JOB_FENCE_LOST'), `fence ${fence}`);
    assert.throws(() => f.report(job.id, 'submitting', {}, { fence, seq: 1, machine: f.device }), code('JOB_FENCE_LOST'), `fence ${fence}`);
  }
  assert.equal(f.job(job.id).status, 'claimed');
  assert.equal(f.ctx.list('platform_post').length, 0);

  // The post is moved in time: the old job is released and a replacement is dispatched; the owner force-releases the old one.
  updateTarget(f.ctx, f.ctx.get('publish_target', target.id), { scheduled_at: new Date(Date.parse(String(target.scheduled_at)) + 10 * MIN).toISOString() }, true);
  const successor = f.jobOf(target.id);
  assert.notEqual(successor.id, job.id);
  f.run('hub_jobs_force_release', { confirm_text: forceReleaseText('Win-C') }, { id: job.id });
  assert.equal(f.job(job.id).status, 'cancelled');
  // Mac-B's made-up late fact must not turn the old job into outcome_unknown nor cancel the replacement.
  assert.throws(() => f.report(job.id, 'submitting', {}, { fence: 2, seq: 1, machine: f.device }), code('JOB_FENCE_LOST'));
  assert.equal(f.job(job.id).status, 'cancelled');
  assert.notEqual(f.job(successor.id).status, 'cancelled');
  assert.equal(events(f, job.id).some(row => row.event === 'late_fact_after_release'), false);
  // The machine that held the fence still reports its late fact (§5.4.3, E2E-13): the facts win, the replacement is cancelled.
  f.report(job.id, 'submitting', {}, { fence: 2, machine: f.other });
  assert.equal(f.job(job.id).status, 'outcome_unknown');
  assert.equal(f.job(successor.id).status, 'cancelled');
});

test('S7: the documented late reports still land — an older fence of the same machine, and facts on a released job', async () => {
  const f = hubFixture();
  const job = f.jobOf((await f.schedule(HOUR)).id);
  f.claim();
  f.claim([]);   // local data loss: fence 2 for the same machine, fence 1 facts still in its outbox
  assert.deepEqual(f.job(job.id).fence_holders, { 1: f.device.id, 2: f.device.id });
  assert.deepEqual(f.report(job.id, 'started', { go: 'offline', mode: 'auto' }, { fence: 1 }), { status: 'ok' });
  assert.equal(f.job(job.id).status, 'running');
  // A job row written before fence_holders existed: its own machine keeps reporting under any issued fence.
  f.ctx.update('worker_job', job.id, { fence_holders: undefined });
  assert.deepEqual(f.report(job.id, 'submitting', {}, { fence: 1 }), { status: 'ok' });
  assert.throws(() => f.report(job.id, 'submitted', {}, { fence: 1, machine: f.other }), code('JOB_FENCE_LOST'), 'not in device_history');
  assert.deepEqual(f.report(job.id, 'result', f.resultData(), { fence: 2 }), { status: 'ok' });
  assert.equal(f.job(job.id).status, 'succeeded');
});

test('S7: at most MAX_REPORTS_PER_JOB reports per job; a duplicate is still answered as duplicate', async () => {
  const f = hubFixture();
  const job = f.jobOf((await f.schedule(HOUR)).id);
  f.claim();
  const first = randomUUID();
  f.report(job.id, 'readback_pending', { attempt: 1, next_at: f.ctx.now }, { event_id: first });
  for (let index = 1; index < MAX_REPORTS_PER_JOB; index++) f.report(job.id, 'readback_pending', { attempt: index + 1 });
  assert.equal(f.job(job.id).report_count, MAX_REPORTS_PER_JOB);
  const count = events(f, job.id).length;
  assert.throws(() => f.report(job.id, 'readback_pending', {}), (error: unknown) => {
    assert.equal((error as Problem).status, 429);
    assert.equal((error as Problem).code, 'JOB_REPORT_LIMIT');
    return true;
  });
  assert.throws(() => f.report(job.id, 'result', f.resultData()), code('JOB_REPORT_LIMIT'));
  assert.equal(events(f, job.id).length, count, 'nothing more is stored');
  assert.deepEqual(f.report(job.id, 'readback_pending', {}, { event_id: first, seq: 1 }), { status: 'duplicate' });
});

test('S7: Worker strings kept on rows are bounded (identity, driver, failure code, readback detail, dry-run trace)', async () => {
  const f = hubFixture();
  const job = f.jobOf((await f.schedule(HOUR)).id);
  f.claim();
  const long = 'a'.repeat(20_000);
  f.report(job.id, 'prepared', { stage: 'preflight', login: 'verified', identity: long, handle: 'lurelab', media_ok: true, driver: { provider: long, version: long } });
  const session = f.ctx.list('browser_session').find(row => row.social_account_id === f.account.id)!;
  assert.equal(String(session.observed_identity).length, 128);
  assert.deepEqual([String((f.job(job.id).driver as Row).provider).length, String((f.job(job.id).driver as Row).version).length], [80, 80]);
  f.report(job.id, 'readback_pending', { attempt: long, next_at: long });
  const readback = events(f, job.id).filter(row => row.event === 'readback_pending').at(-1)!;
  assert.ok(JSON.stringify(readback.detail).length <= 4096, 'event detail is clipped');
  f.report(job.id, 'failed', { code: long, message: long });
  assert.deepEqual(f.job(job.id).failure, { code: 'platform_error', message: 'a'.repeat(500) });

  configureWorkerHost({ bundledClip: { sha256: 'd'.repeat(64), bytes: 1234 } });
  const dry = createDryRunJob(f.ctx, f.account.id, {});
  f.claim();
  assert.equal(f.go(dry.id).go, true);
  f.report(dry.id, 'started', { go: 'hub', mode: 'auto' });
  const step = { step: 'open', ms: 10, matched: 'b'.repeat(1000) };
  f.report(dry.id, 'dry_run_done', { evidence_sha256: [], trace: [...Array.from({ length: 100 }, () => step), 'not-an-object'] });
  const trace = f.job(dry.id).driver_trace as Row[];
  assert.ok(trace.length > 0 && trace.length < 60, `trace kept ${trace.length} steps`);
  assert.ok(JSON.stringify(trace).length <= 16 * 1024);
});

test('S7: a result link must be https on the job\'s own platform; anything else is dropped from the post, the fact is kept', async () => {
  const bad = [
    'http://x.com/lurelab/status/1861234567890123456',
    'https://evil.example/x.com/lurelab/status/1861234567890123456',
    'https://x.com.evil.example/lurelab/status/1861234567890123456',
    'https://user:pw@x.com/lurelab/status/1861234567890123456',
    'https://x.com:8443/lurelab/status/1861234567890123456',
    'https://www.tiktok.com/@lurelab/video/1861234567890123456',   // another platform's host
    'javascript:alert(1)//x.com',
    `https://x.com/${'a'.repeat(3000)}`,
  ];
  for (const url of bad) {
    const f = hubFixture();
    const target = await f.schedule(HOUR);
    const job = f.jobOf(target.id);
    f.prepare(job.id);
    f.at(String(job.not_before));
    f.go(job.id);
    f.report(job.id, 'started', { go: 'hub', mode: 'auto' });
    f.report(job.id, 'submitting');
    assert.deepEqual(f.report(job.id, 'result', { ...f.resultData('1861234567890123999'), url }), { status: 'ok' }, url);
    const result = f.job(job.id).result as Row;
    assert.equal(f.job(job.id).status, 'succeeded', 'the fact still counts');
    assert.equal(result.url, null, url);
    assert.equal(result.external_post_id, '1861234567890123999');
    const event = events(f, job.id).find(row => row.event === 'result')!;
    assert.equal((event.detail as Row).url_rejected, true);
    assert.equal(f.ctx.list('platform_post').some(row => row.permalink === url), false, 'the link never reaches the post');
    assert.equal(f.task(target.id).status, 'published');
  }
  // A post id that is not the platform's (digits) is dropped; the id is then read from the checked link.
  const id = hubFixture();
  const idJob = id.jobOf((await id.schedule(HOUR)).id);
  id.publishNow(idJob.id);
  const idResult = id.job(idJob.id).result as Row;
  assert.equal(idResult.external_post_id, '1861234567890123456');
  const odd = hubFixture();
  const oddJob = odd.jobOf((await odd.schedule(HOUR)).id);
  odd.prepare(oddJob.id);
  odd.at(String(oddJob.not_before));
  odd.go(oddJob.id);
  odd.report(oddJob.id, 'started', { go: 'hub', mode: 'auto' });
  odd.report(oddJob.id, 'result', { ...odd.resultData('1861234567890123456'), external_post_id: '<img src=x onerror=alert(1)>', published_at: 'x'.repeat(500) });
  assert.equal((odd.job(oddJob.id).result as Row).external_post_id, '1861234567890123456');
  assert.equal((odd.job(oddJob.id).result as Row).published_at, null);
  // X accepts twitter.com; TikTok accepts tiktok.com and www.tiktok.com.
  const x = hubFixture();
  const xjob = x.jobOf((await x.schedule(HOUR)).id);
  x.prepare(xjob.id);
  x.at(String(xjob.not_before));
  x.go(xjob.id);
  x.report(xjob.id, 'started', { go: 'hub', mode: 'auto' });
  x.report(xjob.id, 'result', { ...x.resultData('1861234567890123456'), url: 'https://twitter.com/lurelab/status/1861234567890123456' });
  assert.equal((x.job(xjob.id).result as Row).url, 'https://twitter.com/lurelab/status/1861234567890123456');
  const t = hubFixture({ provider: 'tiktok' });
  const tjob = t.jobOf((await t.schedule(HOUR)).id);
  t.publishNow(tjob.id, '7300000000000000001');
  assert.equal((t.job(tjob.id).result as Row).url, 'https://www.tiktok.com/@lurelab/video/7300000000000000001');
  assert.equal(t.ctx.list('platform_post')[0].permalink, 'https://www.tiktok.com/@lurelab/video/7300000000000000001');
});

test('S7: a late result fact after release is checked the same way', async () => {
  const g = hubFixture();
  const old = g.jobOf((await g.schedule(HOUR)).id);
  g.prepare(old.id);
  requestRevoke(g.ctx, g.job(old.id), 'cancelled');
  g.heartbeat([], { released_jobs: [old.id] });
  assert.equal(g.job(old.id).status, 'cancelled');
  g.report(old.id, 'result', { ...g.resultData(), url: 'https://phish.example/x.com/status/1' }, { fence: 1 });
  assert.equal(g.job(old.id).status, 'succeeded');
  assert.equal((g.job(old.id).result as Row).url, null);
  assert.equal((g.job(old.id).result as Row).external_post_id, '1861234567890123456');
});

test('S7: loopback fixture result links are accepted only in test mode (config.testTiming.platformOrigins)', async () => {
  const fixtureUrl = 'http://127.0.0.1:4555/x/lurelab/status/1861234567890123456';
  async function resultWith(url: string) {
    const f = hubFixture();
    const job = f.jobOf((await f.schedule(HOUR)).id);
    f.prepare(job.id);
    f.at(String(job.not_before));
    f.go(job.id);
    f.report(job.id, 'started', { go: 'hub', mode: 'auto' });
    f.report(job.id, 'result', { ...f.resultData(), url });
    return (f.job(job.id).result as Row).url;
  }
  try {
    configureWorkerHost({ testTiming: { platformOrigins: { x: 'http://127.0.0.1:4555' } } });
    assert.equal(await resultWith(fixtureUrl), fixtureUrl);
    assert.equal(await resultWith('http://127.0.0.1:4556/x/lurelab/status/1'), null, 'another loopback port is not the fixture');
  } finally {
    configureWorkerHost({ testTiming: undefined });
  }
  assert.equal(await resultWith(fixtureUrl), null, 'outside test mode the fixture origin is just an http link');

  // config.ts sets platformOrigins only under NODE_ENV=test, from the Worker's own switch, and only for loopback.
  const origins = JSON.stringify({ x: 'http://127.0.0.1:4555/x', tiktok: 'http://127.0.0.1:4555/tiktok' });
  assert.deepEqual(configuration({ NODE_ENV: 'test', SMARTSELL_TEST_PLATFORM_ORIGINS: origins }).testTiming,
    { platformOrigins: { x: 'http://127.0.0.1:4555', tiktok: 'http://127.0.0.1:4555' } });
  assert.equal(configuration({ NODE_ENV: 'development', SMARTSELL_TEST_PLATFORM_ORIGINS: origins }).testTiming, undefined);
  assert.throws(() => configuration({ NODE_ENV: 'test', SMARTSELL_TEST_PLATFORM_ORIGINS: JSON.stringify({ x: 'https://x.com' }) }), /loopback/);
});

test('S7: reportJob checks fences before anything is stored (direct call, as the device route does)', async () => {
  const f = hubFixture();
  const job = f.jobOf((await f.schedule(HOUR)).id);
  f.claim();
  assert.throws(() => reportJob(f.ctx, f.device, { job_id: job.id, fencing_token: 5, seq: 1, event_id: randomUUID(), event: 'outcome_unknown', worker_time: f.ctx.now, data: {} }),
    code('JOB_FENCE_LOST'));
  assert.equal(f.job(job.id).report_count, undefined);
  assert.equal(f.job(job.id).status, 'claimed');
});

test('S7: a machine claiming the same job in a loop stops getting it after MAX_RECOVERY_CLAIMS_PER_JOB; the fence map stays small', async () => {
  const f = hubFixture();
  const job = f.jobOf((await f.schedule(HOUR)).id);
  f.claim();
  const claimed = () => events(f, job.id).filter(row => row.event === 'claimed').length;
  const first = claimed();
  // Not listing the job as held is a restart: it is handed out again under a new fence, up to the limit.
  for (let index = 0; index < MAX_RECOVERY_CLAIMS_PER_JOB + 20; index++) f.claim([]);
  assert.equal(f.job(job.id).recovery_claims, MAX_RECOVERY_CLAIMS_PER_JOB);
  assert.equal(claimed(), first + MAX_RECOVERY_CLAIMS_PER_JOB, 'no more claimed events past the limit');
  const fence = Number(f.job(job.id).fencing_token);
  assert.ok(Object.keys(f.job(job.id).fence_holders as object).length <= 32);
  // The machine still reports under its current fence.
  f.report(job.id, 'prepared', { stage: 'preflight' }, { fence, seq: 1 });
});
