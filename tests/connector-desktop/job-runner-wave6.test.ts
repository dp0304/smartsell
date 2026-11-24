// Wave 6 (G3-worker) runner regressions: WA-2 (owner-click wait holds the machine's publish lock), WA-3 / WE-3
// (go:false invalid_state / too_late dropped silently), WA-6 (terminal facts lost after a cleanup error or a crash),
// WA-8 (the owner-click draft is brought to the front, its alert names the job), WA-10 (an owner click X/TikTok refused
// is an after_submit fact, not "not clicked") and the runner half of WA-1 (read-back measured from the click).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JobReport } from '../../apps/connector-desktop/src/runtime/contracts.ts';
import { HubError, MIN, runnerHarness, ScriptedDriver, T0 } from './fakes/runner-harness.ts';

const iso = (ms: number) => new Date(ms).toISOString();
const otherChannel = { social_account_id: 'acct-x2', handle: 'fixture_x2', display_name: 'Fixture X2', profile_key: 'ch-dddddddddddd', expected_identity: 'fixture_x2' };
const assist = { go: true as const, mode: 'assist' as const, server_time: iso(T0) };
const auto = { go: true as const, mode: 'auto' as const, server_time: iso(T0) };

function blockerOf(report: JobReport | undefined) {
  return report?.data.event === 'blocked' ? report.data.blocker : undefined;
}

test('WA-2: an owner-click wait releases the publish lock, so another account on this machine posts on time (not missed{late})', async () => {
  const h = runnerHarness();
  try {
    const a = h.job({ job_id: 'job-a', not_before: iso(T0 + 1 * MIN), not_after: iso(T0 + 31 * MIN) });
    const b = h.job({ job_id: 'job-b', not_before: iso(T0 + 2 * MIN), not_after: iso(T0 + 12 * MIN) }, { channel: otherChannel });
    h.setGo([], (_call, body) => body.job_id === 'job-a' ? assist : auto);
    h.synced();
    h.runner.start();
    h.runner.addClaimed([a, b]);
    await h.time.advance(3 * MIN);
    assert.deepEqual(h.goJobs, ['job-a', 'job-b'], 'B called go while A waited for the owner');
    assert.equal(h.goCalls[1], T0 + 2 * MIN, 'B went at its not_before');
    assert.deepEqual(h.events_('job-b').slice(-4), ['started', 'submitting', 'submitted', 'result']);
    assert.equal(blockerOf(h.reports('job-a').find(report => report.event === 'blocked'))?.code, 'owner_click_required');
    assert.equal(h.store.get('job-a')?.state, 'running', 'A still waits for the owner');
    assert.ok(h.pins.includes(true), 'A\'s Chrome stays pinned for the owner');
    // A ends honestly at its own not_after.
    await h.time.advance(30 * MIN);
    assert.deepEqual(h.reports('job-a').at(-1)!.data, { event: 'missed', reason: 'owner_not_clicked' });
    assert.ok(!h.events_('job-b').includes('missed'));
  } finally { await h.cleanup(); }
});

test('WA-2: a second assist account gets its own draft and its own owner_click alert while the first waits', async () => {
  const h = runnerHarness();
  try {
    const a = h.job({ job_id: 'job-a', not_before: iso(T0 + 1 * MIN), not_after: iso(T0 + 31 * MIN) });
    const b = h.job({ job_id: 'job-b', not_before: iso(T0 + 2 * MIN), not_after: iso(T0 + 32 * MIN) }, { channel: otherChannel });
    h.setGo([], assist);
    h.synced();
    h.runner.start();
    h.runner.addClaimed([a, b]);
    await h.time.advance(3 * MIN);
    const ownerAlerts = h.alerts.filter(alert => alert.kind === 'owner_click');
    assert.deepEqual(ownerAlerts.map(alert => alert.job_id), ['job-a', 'job-b']);
    assert.equal(blockerOf(h.reports('job-b').find(report => report.event === 'blocked'))?.code, 'owner_click_required');
  } finally { await h.cleanup(); }
});

test('WA-2: a later job of the same account waits for that draft outside the lock; other accounts are not held up', async () => {
  const h = runnerHarness();
  try {
    const a = h.job({ job_id: 'job-a', not_before: iso(T0 + 1 * MIN), not_after: iso(T0 + 31 * MIN) });
    const c = h.job({ job_id: 'job-c', not_before: iso(T0 + 2 * MIN), not_after: iso(T0 + 32 * MIN) });
    const b = h.job({ job_id: 'job-b', not_before: iso(T0 + 3 * MIN), not_after: iso(T0 + 13 * MIN) }, { channel: otherChannel });
    h.setGo([], (_call, body) => body.job_id === 'job-a' ? assist : auto);
    h.synced();
    h.runner.start();
    h.runner.addClaimed([a, c, b]);
    await h.time.advance(4 * MIN);
    assert.deepEqual(h.goJobs, ['job-a', 'job-b'], 'C (same Chrome as A) did not take the lock; B went at its time');
    assert.equal(h.events_('job-b').at(-1), 'result');
    // The owner clicks A's Post: A finishes, then C runs.
    (h.driver as ScriptedDriver).ownerClicked = true;
    await h.time.advance(30_000);
    assert.equal(h.events_('job-a').at(-1), 'result');
    assert.deepEqual(h.goJobs, ['job-a', 'job-b', 'job-c']);
    assert.equal(h.events_('job-c').at(-1), 'result');
  } finally { await h.cleanup(); }
});

test('WA-3 / WE-3: go:false invalid_state (the hub is releasing the job) is reported as released, never dropped silently', async () => {
  const h = runnerHarness();
  try {
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    h.setGo([{ go: false, reason: 'invalid_state', release: false }]);
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(2 * MIN);
    assert.deepEqual(h.events_(job.job_id), ['prepared', 'prepared', 'released']);
    assert.equal(h.store.get(job.job_id)?.state, 'released');
    assert.equal((h.driver as ScriptedDriver).clicks, 0);
    assert.ok(!(h.driver as ScriptedDriver).calls.some(call => call.startsWith('publish')));
  } finally { await h.cleanup(); }
});

test('WA-3: go:false too_late is reported as missed{late} so the hub does not wait for a fact', async () => {
  const h = runnerHarness();
  try {
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    h.setGo([{ go: false, reason: 'too_late', release: false }]);
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(2 * MIN);
    assert.deepEqual(h.reports(job.job_id).at(-1)!.data, { event: 'missed', reason: 'late' });
    assert.equal(h.store.get(job.job_id)?.state, 'missed');
    assert.equal(h.alerts.at(-1)?.kind, 'missed');
  } finally { await h.cleanup(); }
});

test('WA-3: go:false fence_lost stays silent (the job belongs to another machine now)', async () => {
  const h = runnerHarness();
  try {
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    h.setGo([{ go: false, reason: 'fence_lost', release: false }]);
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(2 * MIN);
    assert.deepEqual(h.events_(job.job_id), ['prepared', 'prepared']);
    assert.equal(h.store.get(job.job_id)?.state, 'released');
  } finally { await h.cleanup(); }
});

test('WA-6: a cache cleanup error after the read-back still queues the result fact', async () => {
  const h = runnerHarness();
  try {
    let throws = 1;
    h.media.release = () => { if (throws-- > 0) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' }); };
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(2 * MIN);
    assert.deepEqual(h.events_(job.job_id).slice(-2), ['submitted', 'result']);
    assert.equal(h.store.get(job.job_id)?.state, 'done');
    assert.equal(h.store.get(job.job_id)?.pending_report, undefined);
    assert.ok(h.logs.some(entry => entry.message === 'media cache release failed'));
  } finally { await h.cleanup(); }
});

test('WA-6: a crash between the final state and the outbox write is repaired on restart, exactly once', async () => {
  const first = runnerHarness();
  const job = first.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
  let crashed = false;
  first.store.fault = operation => {
    if (operation === 'outbox' && !crashed && first.store.get(job.job_id)?.pending_report?.event === 'result') { crashed = true; throw new Error('power cut'); }
  };
  first.synced();
  first.runner.start();
  first.runner.addClaimed([job]);
  await first.time.advance(2 * MIN);
  assert.ok(crashed);
  assert.equal(first.store.get(job.job_id)?.state, 'done');
  assert.ok(!first.events_(job.job_id).includes('result'), 'the fact is not in the outbox yet');
  await first.runner.stop();
  first.store.fault = undefined;
  const second = runnerHarness({ root: first.root, start: T0 + 3 * MIN });
  try {
    second.runner.start();
    await second.time.settle();
    const results = second.reports(job.job_id).filter(report => report.event === 'result');
    assert.equal(results.length, 1);
    assert.equal(results[0].data.event === 'result' && results[0].data.url, 'https://x.com/fixture_x/status/42');
    assert.equal(results[0].event_id, first.store.get(job.job_id)?.pending_report?.event_id ?? results[0].event_id);
    assert.equal(second.store.get(job.job_id)?.pending_report, undefined);
    await second.runner.stop();
    const third = runnerHarness({ root: first.root, start: T0 + 4 * MIN });
    third.runner.start();
    await third.time.settle();
    assert.equal(third.reports(job.job_id).filter(report => report.event === 'result').length, 1, 'never queued twice');
    await third.runner.stop();
  } finally { await second.cleanup(); }
});

test('WA-6: a crash after the outbox write but before the pending fact is cleared does not send it twice', async () => {
  const first = runnerHarness();
  const job = first.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
  first.synced();
  first.runner.start();
  first.runner.addClaimed([job]);
  await first.time.advance(2 * MIN);
  await first.runner.stop();
  // Put the pending record back as if the process died right after the outbox file was written.
  const sent = first.reports(job.job_id).find(report => report.event === 'result')!;
  first.store.update(job.job_id, value => { value.pending_report = { event_id: sent.event_id, event: 'result', data: sent.data, at: sent.worker_time }; });
  const second = runnerHarness({ root: first.root, start: T0 + 3 * MIN });
  try {
    second.runner.start();
    await second.time.settle();
    assert.equal(second.reports(job.job_id).filter(report => report.event === 'result').length, 1);
    assert.equal(second.store.get(job.job_id)?.pending_report, undefined);
  } finally { await second.cleanup(); }
});

test('WA-8: the owner-click draft comes to the front and its alert names the job (the notification opens that Chrome)', async () => {
  const h = runnerHarness();
  try {
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    h.setGo([], assist);
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(2 * MIN);
    assert.equal(h.page.count('bringToFront'), 1);
    const alert = h.alerts.find(item => item.kind === 'owner_click');
    assert.equal(alert?.job_id, job.job_id);
    const view = h.runner.views().find(item => item.job_id === job.job_id);
    assert.deepEqual([view?.state, view?.blocker?.code], ['running', 'owner_click_required']);
  } finally { await h.cleanup(); }
});

test('WA-10: an owner click the platform refused ends as an after_submit fact (outcome unknown), not missed{owner_not_clicked}', async () => {
  const h = runnerHarness();
  try {
    const driver = h.driver as ScriptedDriver;
    driver.publishImpl = async (ctx, _job, opts) => {
      await opts.onOwnerWait?.({ code: 'owner_click_required', phase: 'before_submit', message: '' });
      await ctx.sleep(60_000);
      return { kind: 'blocked', blocker: { code: 'platform_error', phase: 'after_submit', message: 'X 回報錯誤' } };
    };
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 5 * MIN) });
    h.setGo([], assist);
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(6 * MIN);
    const last = h.reports(job.job_id).at(-1)!;
    assert.deepEqual([last.event, blockerOf(last)?.code, blockerOf(last)?.phase], ['blocked', 'platform_error', 'after_submit']);
    assert.ok(!h.events_(job.job_id).includes('missed'));
    assert.equal(h.store.get(job.job_id)?.state, 'done');
  } finally { await h.cleanup(); }
});

test('WA-1: read-back is measured from the click (submitting), not the later confirmation, and gets the pre-click known ids', async () => {
  const h = runnerHarness();
  try {
    const driver = h.driver as ScriptedDriver;
    let clickedAt = 0;
    driver.publishImpl = async (ctx, _job, opts) => {
      if (!await opts.onBeforeClick()) return { kind: 'aborted' };
      clickedAt = ctx.now();
      await ctx.sleep(50_000); // TikTok confirmation can take up to a minute
      return { kind: 'submitted', submitted_by: 'auto', hint: { known_ids: ['7400000000000000001'] }, evidence_sha256: [] };
    };
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(3 * MIN);
    const hint = driver.readBackHints[0];
    assert.equal(hint.submittedAt, clickedAt);
    assert.deepEqual(hint.known_ids, ['7400000000000000001']);
    assert.equal(h.events_(job.job_id).at(-1), 'result');
  } finally { await h.cleanup(); }
});

test('WA-3: an unreachable hub at go is still the offline path (not released)', async () => {
  const h = runnerHarness();
  try {
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    h.setGo([], new HubError('network', 'down'));
    h.synced(T0 + 50_000);
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(70_000);
    assert.ok(!h.events_(job.job_id).includes('released'));
    assert.deepEqual(h.reports(job.job_id).find(report => report.event === 'started')?.data, { event: 'started', go: 'offline', mode: 'auto' });
  } finally { await h.cleanup(); }
});
