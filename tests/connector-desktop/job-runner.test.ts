import assert from 'node:assert/strict';
import { test } from 'node:test';
import { offlineGoAllowed } from '../../apps/connector-desktop/src/runtime/job-runner.ts';
import type { LocalJob } from '../../apps/connector-desktop/src/runtime/job-store.ts';
import { MediaHashMismatch } from '../../apps/connector-desktop/src/runtime/media-cache.ts';
import { XDriver } from '../../apps/connector-desktop/src/drivers/x.ts';
import { defaultSelectors } from '../../apps/connector-desktop/src/drivers/selectors.ts';
import { FakeCdpPage } from './fakes/fake-cdp-page.ts';
import { HubError, MIN, runnerHarness, ScriptedDriver, T0 } from './fakes/runner-harness.ts';

const iso = (ms: number) => new Date(ms).toISOString();

test('timetable: download and preflight at claim, final prepare at not_before - lead, go at not_before, then read-back', async () => {
  const h = runnerHarness();
  try {
    const job = h.job();
    const id = job.job_id;
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(1000);
    assert.deepEqual(h.events_(id), ['prepared']);
    const first = h.reports(id)[0].data;
    assert.equal(first.event === 'prepared' && first.stage, 'preflight');
    assert.equal(h.store.get(id)?.state, 'media_ready');
    assert.match(h.store.get(id)!.media_paths['file-1'], /staging/);
    // Nothing more until 30 minutes before not_before.
    await h.time.advance(89 * MIN);
    assert.deepEqual(h.events_(id), ['prepared']);
    await h.time.advance(1 * MIN + 1000);
    assert.deepEqual(h.events_(id), ['prepared', 'prepared']);
    assert.equal(h.store.get(id)?.state, 'ready');
    assert.equal(h.goCalls.length, 0);
    await h.time.advance(30 * MIN);
    assert.equal(h.goCalls[0], Date.parse(job.not_before));
    assert.deepEqual(h.events_(id), ['prepared', 'prepared', 'started', 'submitting', 'submitted', 'result']);
    const started = h.reports(id).find(report => report.event === 'started')!;
    assert.deepEqual(started.data, { event: 'started', go: 'hub', mode: 'auto' });
    const result = h.reports(id).at(-1)!;
    assert.equal(result.data.event === 'result' && result.data.url, 'https://x.com/fixture_x/status/42');
    assert.deepEqual(h.reports(id).map(report => report.seq), [1, 2, 3, 4, 5, 6]);
    assert.equal(h.driver instanceof ScriptedDriver && h.driver.clicks, 1);
    assert.equal(h.store.get(id)?.state, 'done');
  } finally { await h.cleanup(); }
});

test('preflight is skipped when the channel had a successful check in the last 30 minutes', async () => {
  const h = runnerHarness();
  try {
    h.store.updateState(state => { state.channel_checks['acct-x'] = iso(T0 - 10 * MIN); });
    const job = h.job();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(1000);
    assert.deepEqual(h.events_(job.job_id), []);
    assert.ok(!(h.driver as ScriptedDriver).calls.includes('checkLogin'));
    assert.ok(h.store.get(job.job_id)?.preflight_at);
  } finally { await h.cleanup(); }
});

test('go:paused is retried every 30 s and ends as missed{paused} at not_after; no offline run afterwards', async () => {
  const h = runnerHarness();
  try {
    const job = h.job({ not_after: iso(T0 + 2 * 3600_000 + 3 * MIN) });
    h.setGo([], { go: false, reason: 'paused', release: false });
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(2 * 3600_000 + 5 * MIN);
    const gaps = h.goCalls.slice(1).map((at, index) => at - h.goCalls[index]);
    assert.ok(h.goCalls.length >= 6, `go called ${h.goCalls.length} times`);
    assert.ok(gaps.every(gap => gap === 30_000), `gaps ${gaps}`);
    assert.deepEqual(h.reports(job.job_id).at(-1)!.data, { event: 'missed', reason: 'paused' });
    assert.equal(h.store.get(job.job_id)?.offline_go_disabled, true);
    assert.equal((h.driver as ScriptedDriver).clicks, 0);
  } finally { await h.cleanup(); }
});

test('onBeforeClick refuses after a revocation: no click, released reported', async () => {
  const h = runnerHarness();
  try {
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    const driver = h.driver as ScriptedDriver;
    driver.beforeClick = () => { h.store.update(job.job_id, value => { value.revoked = true; }); };
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(2 * MIN);
    assert.equal(driver.clicks, 0);
    assert.ok(driver.calls.includes('discard'));
    assert.deepEqual(h.events_(job.job_id).slice(-2), ['started', 'released']);
    assert.equal(h.store.get(job.job_id)?.state, 'released');
  } finally { await h.cleanup(); }
});

test('assist: owner wait reports owner_click_required; a revocation while waiting discards the draft and reports released', async () => {
  const h = runnerHarness();
  try {
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    h.setGo([], { go: true, mode: 'assist', server_time: iso(T0) });
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(2 * MIN);
    const blocked = h.reports(job.job_id).find(report => report.event === 'blocked')!;
    assert.equal(blocked.data.event === 'blocked' && blocked.data.blocker.code, 'owner_click_required');
    assert.equal(h.alerts.at(-1)?.kind, 'owner_click');
    assert.match(h.alerts.at(-1)!.body, /Mac-B 的 X @fixture_x 已準備好，等你在 Mac-B 按「發布」/);
    h.store.update(job.job_id, value => { value.revoked = true; });
    h.runner.synced();
    await h.time.advance(10_000);
    assert.equal((h.driver as ScriptedDriver).clicks, 0);
    assert.deepEqual(h.events_(job.job_id).slice(-1), ['released']);
  } finally { await h.cleanup(); }
});

test('assist: nobody clicks before not_after → missed{owner_not_clicked}; an owner click → submitted_by owner', async () => {
  const h = runnerHarness();
  try {
    const late = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 5 * MIN) });
    h.setGo([], { go: true, mode: 'assist', server_time: iso(T0) });
    h.synced();
    h.runner.start();
    h.runner.addClaimed([late]);
    await h.time.advance(6 * MIN);
    assert.deepEqual(h.reports(late.job_id).at(-1)!.data, { event: 'missed', reason: 'owner_not_clicked' });
    const owner = h.job({ job_id: 'job-owner', not_before: iso(h.time.now() + 60_000), not_after: iso(h.time.now() + 20 * MIN) });
    h.runner.addClaimed([owner]);
    await h.time.advance(2 * MIN);
    (h.driver as ScriptedDriver).ownerClicked = true;
    await h.time.advance(10_000);
    const events = h.events_(owner.job_id);
    assert.deepEqual(events.slice(-3), ['submitting', 'submitted', 'result']);
    const result = h.reports(owner.job_id).at(-1)!;
    assert.equal(result.data.event === 'result' && result.data.submitted_by, 'owner');
  } finally { await h.cleanup(); }
});

test('owner-resume blockers are not retried until the hub raises resume_token', async () => {
  const h = runnerHarness();
  try {
    const driver = h.driver as ScriptedDriver;
    driver.prepares.push({ ok: false, blocker: { code: 'risk_prompt', phase: 'prepare', message: '' } });
    const job = h.job({ not_before: iso(T0 + 40 * MIN), not_after: iso(T0 + 70 * MIN) });
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(15 * MIN);
    assert.equal(driver.calls.filter(call => call === 'prepare').length, 1);
    const blocked = h.reports(job.job_id).find(report => report.event === 'prepare_blocked')!;
    assert.equal(blocked.data.event === 'prepare_blocked' && blocked.data.blocker.code, 'risk_prompt');
    assert.match(blocked.data.event === 'prepare_blocked' ? blocked.data.blocker.message : '', /出現平台風控提示，已停止且不會重試/);
    await h.time.advance(10 * MIN);
    assert.equal(driver.calls.filter(call => call === 'prepare').length, 1, 'still not retried');
    h.store.update(job.job_id, value => { value.sync = { ...value.sync, resume_token: 1 }; });
    h.runner.synced();
    await h.time.advance(1000);
    assert.equal(driver.calls.filter(call => call === 'prepare').length, 2);
    assert.equal(h.store.get(job.job_id)?.state, 'ready');
  } finally { await h.cleanup(); }
});

test('auto-resume blockers are observed read-only on the same tab (no navigation, no reload) and preparation continues', async () => {
  const table = defaultSelectors();
  const page = new FakeCdpPage();
  const step = (id: string) => table.x.steps[id].primary[0].css!;
  page.onGoto = url => {
    page.nodes = [];
    page.add({ css: [step('x.ready'), step('x.textbox')], role: 'textbox', name: 'Post text' });
    page.add({ css: [step('x.identity')], attrs: { href: '/fixture_x' } });
    if (url.endsWith('/compose/post')) page.frames = ['/x/__challenge/arkoselabs.com/fc'];
  };
  const h = runnerHarness({ driver: new XDriver(), page });
  try {
    const job = h.job({ not_before: iso(T0 + 40 * MIN), not_after: iso(T0 + 70 * MIN) });
    h.store.updateState(state => { state.channel_checks['acct-x'] = iso(T0); });
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(10 * MIN + 1000);
    const blocked = h.reports(job.job_id).find(report => report.event === 'prepare_blocked')!;
    assert.equal(blocked.data.event === 'prepare_blocked' && blocked.data.blocker.code, 'captcha');
    assert.match(blocked.data.event === 'prepare_blocked' ? blocked.data.blocker.message : '', /Mac-B 的 X @fixture_x 出現驗證碼，已停止/);
    const navigationsWhileBlocked = page.navigations().length;
    await h.time.advance(5 * MIN);
    assert.equal(page.navigations().length, navigationsWhileBlocked, 'no reload or navigation while waiting');
    assert.equal(page.count('click'), 0, 'never touches the challenge');
    assert.ok(h.pins.includes(true), 'the Chrome window stays open for the owner');
    page.frames = [];
    await h.time.advance(11_000);
    assert.equal(page.navigations().length, navigationsWhileBlocked, 'continues on the same page after the challenge cleared');
    assert.equal(h.store.get(job.job_id)?.state, 'ready');
    assert.deepEqual(h.events_(job.job_id), ['prepare_blocked', 'prepared']);
  } finally { await h.cleanup(); }
});

test('restart recovery: a job found in submitting is only read back, never published again', async () => {
  const first = runnerHarness();
  const job = first.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
  first.store.put({
    claimed: job, state: 'submitting', media_paths: { 'file-1': first.clip.path }, readback_attempts: 0, offline_go_disabled: false, revoked: false,
    fence: 1, next_seq: 4, preflight_at: iso(T0), prepared_at: iso(T0), started_at: iso(T0 + 60_000), submitting_at: iso(T0 + 61_000), go_source: 'hub',
    sync: { hold: false, hold_reason: null, mode: 'auto', resume_token: 0, machine_paused: false, pause_all: false, channel_paused: false, synced_at: iso(T0) },
    last_sync_at: iso(T0),
  });
  const second = runnerHarness({ root: first.root, start: T0 + 2 * MIN });
  try {
    const driver = second.driver as ScriptedDriver;
    driver.readBacks.push({ kind: 'not_yet' });
    second.runner.start();
    await second.time.advance(40_000);
    assert.ok(!driver.calls.some(call => call.startsWith('publish')), 'publish is never called after a crash in submitting');
    assert.equal(driver.clicks, 0);
    assert.equal(second.goCalls.length, 0);
    assert.deepEqual(second.events_(job.job_id), ['readback_pending', 'result']);
    assert.deepEqual(second.reports(job.job_id).map(report => report.seq), [4, 5]);
  } finally { await second.cleanup(); }
});

test('restart recovery: a job found in running (before submitting) goes through go again and publishes once', async () => {
  const first = runnerHarness();
  const job = first.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
  first.store.put({
    claimed: job, state: 'running', media_paths: { 'file-1': first.clip.path }, readback_attempts: 0, offline_go_disabled: false, revoked: false,
    fence: 1, next_seq: 3, preflight_at: iso(T0), prepared_at: iso(T0), started_at: iso(T0 + 60_000), go_source: 'hub',
    sync: { hold: false, hold_reason: null, mode: 'auto', resume_token: 0, machine_paused: false, pause_all: false, channel_paused: false, synced_at: iso(T0) },
    last_sync_at: iso(T0),
  });
  const second = runnerHarness({ root: first.root, start: T0 + 2 * MIN });
  try {
    second.runner.start();
    await second.time.advance(5_000);
    assert.equal(second.goCalls.length, 1);
    assert.equal((second.driver as ScriptedDriver).clicks, 1);
    assert.deepEqual(second.events_(job.job_id), ['started', 'submitting', 'submitted', 'result']);
  } finally { await second.cleanup(); }
});

test('a machine that wakes after not_after reports missed{machine_was_off} and never publishes', async () => {
  const first = runnerHarness();
  const job = first.job({ not_before: iso(T0 - 40 * MIN), not_after: iso(T0 - 10 * MIN) });
  first.runner.addClaimed([job]);
  await first.time.settle();
  await first.runner.stop();
  first.store.update(job.job_id, value => { value.state = 'ready'; value.prepared_at = iso(T0 - 50 * MIN); value.preflight_at = iso(T0 - 50 * MIN); });
  const second = runnerHarness({ root: first.root });
  try {
    second.runner.start();
    await second.time.advance(1000);
    assert.deepEqual(second.reports(job.job_id).at(-1)!.data, { event: 'missed', reason: 'machine_was_off' });
    assert.equal(second.goCalls.length, 0);
    assert.match(second.alerts.at(-1)!.body, /Mac-B 在 .* 前沒有開始（機器當時沒有開機或沒有連線），這則沒有發出/);
  } finally { await second.cleanup(); }
});

test('offline go: two unreachable go attempts 5 s apart run the job with the last synced mode', async () => {
  const h = runnerHarness();
  try {
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    h.setGo([], new HubError('network', 'down'));
    h.synced(T0);
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(50_000);
    // Last heartbeat said assist (risk acknowledgement withdrawn) after the claim said auto.
    h.store.update(job.job_id, value => { value.sync = { ...value.sync, mode: 'assist' }; });
    h.synced(T0 + 55_000);
    await h.time.advance(20_000);
    assert.equal(h.goCalls.length, 2);
    assert.ok(h.goCalls[1] - h.goCalls[0] >= 5000);
    const started = h.reports(job.job_id).find(report => report.event === 'started')!;
    assert.deepEqual(started.data, { event: 'started', go: 'offline', mode: 'assist' });
    assert.equal((h.driver as ScriptedDriver).lastOptions?.mode, 'assist', 'assist never clicks for the owner');
    assert.equal((h.driver as ScriptedDriver).clicks, 0);
  } finally { await h.cleanup(); }
});

test('offline go is refused after one failure followed by any other response (4xx or 500)', async () => {
  const h = runnerHarness();
  try {
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    h.setGo([new HubError('network', 'down'), new HubError('server', '500', 500), new HubError('network', 'down'), new HubError('client', '400', 400)],
      { go: true, mode: 'auto', server_time: iso(T0) });
    h.synced(T0 + 50_000);
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(60_000 + 30_000);
    const started = h.reports(job.job_id).find(report => report.event === 'started')!;
    assert.deepEqual(started.data, { event: 'started', go: 'hub', mode: 'auto' }, 'only the hub go:true started it');
    assert.equal(h.goCalls.length, 5);
  } finally { await h.cleanup(); }
});

test('offline go rules (§5.7): every condition has a positive and a negative case', () => {
  const notBefore = T0, notAfter = T0 + 30 * MIN;
  const base: LocalJob = {
    claimed: { ...runnerHarnessJob(), not_before: iso(notBefore), not_after: iso(notAfter) },
    state: 'waiting_go', media_paths: {}, readback_attempts: 0, offline_go_disabled: false, revoked: false, fence: 1, next_seq: 1, prepared_at: iso(T0 - MIN),
    sync: { hold: false, hold_reason: null, mode: 'auto', resume_token: 0, machine_paused: false, pause_all: false, channel_paused: false, synced_at: iso(T0 - MIN) },
    last_sync_at: iso(T0 - MIN),
  };
  const state = { last_sync_at: iso(T0 - 5 * MIN), successes: [] as { social_account_id: string; local_date: string }[] };
  const ok = (job: LocalJob, at = T0 + MIN, s = state, trusted = true) => offlineGoAllowed(job, s, at, trusted, 30 * MIN);
  assert.deepEqual(ok(base), { ok: true });
  const cases: [string, LocalJob, number?, typeof state?, boolean?][] = [
    ['stale_sync', base, T0 + MIN, { ...state, last_sync_at: iso(T0 - 40 * MIN) }],
    ['clock_unknown', base, T0 + MIN, state, false],
    ['outside_time', base, T0 - 1000],
    ['outside_time', base, notAfter + 1000, { ...state, last_sync_at: iso(notAfter) }],
    ['not_ready', { ...base, state: 'media_ready' }],
    ['not_ready', { ...base, blocker: { code: 'captcha' } as LocalJob['blocker'] }],
    ['revoked', { ...base, revoked: true }],
    ['hold', { ...base, sync: { ...base.sync, hold: true, hold_reason: 'approval_invalid' } }],
    ['paused', { ...base, sync: { ...base.sync, machine_paused: true } }],
    ['paused', { ...base, sync: { ...base.sync, pause_all: true } }],
    ['paused', { ...base, sync: { ...base.sync, channel_paused: true } }],
    ['offline_go_disabled', { ...base, offline_go_disabled: true }],
    ['hub_absent', { ...base, hub_absent: 1 }],
    ['daily_cap', base, T0 + MIN, { ...state, successes: Array.from({ length: 10 }, () => ({ social_account_id: 'acct-x', local_date: '2026-11-25' })) }],
  ];
  for (const [reason, job, at, s, trusted] of cases) assert.deepEqual(ok(job, at, s, trusted), { ok: false, reason }, reason);
  const windowed = { ...base, claimed: { ...base.claimed, payload: { ...base.claimed.payload, limits: { daily_cap: 10, window: { start: '09:00', end: '10:00', days: [1, 2, 3, 4, 5, 6, 7] } } } } } as LocalJob;
  // T0 is 08:00 in Asia/Shanghai.
  assert.deepEqual(ok(windowed), { ok: false, reason: 'outside_window' });
  assert.deepEqual(ok({ ...windowed, claimed: { ...windowed.claimed, not_before: iso(T0), not_after: iso(T0 + 3 * 3600_000) } }, T0 + 90 * MIN, { ...state, last_sync_at: iso(T0 + 85 * MIN) }), { ok: true });
});

function runnerHarnessJob() {
  const h = runnerHarness();
  const job = h.job();
  void h.cleanup();
  return job;
}

test('a go:false other than too_early disables offline go until a later go:true', async () => {
  const h = runnerHarness();
  try {
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 5 * MIN) });
    h.setGo([{ go: false, reason: 'paused', release: false }], new HubError('network', 'down'));
    h.synced(T0 + 59_000);
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(6 * MIN);
    assert.ok(!h.events_(job.job_id).includes('started'), 'never ran offline');
    assert.deepEqual(h.reports(job.job_id).at(-1)!.data, { event: 'missed', reason: 'paused' });
  } finally { await h.cleanup(); }
});

test('headless --dry-run never clicks a real job and reports an explicit non-success', async () => {
  const h = runnerHarness({ settings: { localDryRun: true } });
  try {
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(2 * MIN);
    assert.ok((h.driver as ScriptedDriver).calls.includes('publish:auto:dry'));
    assert.equal((h.driver as ScriptedDriver).clicks, 0);
    const blocked = h.reports(job.job_id).at(-1)!;
    assert.equal(blocked.event, 'blocked');
    assert.equal(blocked.data.event === 'blocked' && blocked.data.blocker.code, 'owner_stopped');
  } finally { await h.cleanup(); }
});

test('hub dry-run job: stops before the click and reports dry_run_done with the driver trace', async () => {
  const h = runnerHarness();
  try {
    const job = h.job({ dry_run: true, not_before: iso(T0), not_after: iso(T0 + 30 * MIN) });
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(5_000);
    assert.equal((h.driver as ScriptedDriver).clicks, 0);
    const done = h.reports(job.job_id).at(-1)!;
    assert.equal(done.event, 'dry_run_done');
    assert.ok(done.data.event === 'dry_run_done' && Array.isArray(done.data.trace));
  } finally { await h.cleanup(); }
});

test('emergency stop: pending jobs report owner_stopped, a job already submitting reports outcome_unknown', async () => {
  const h = runnerHarness();
  try {
    const pending = h.job({ job_id: 'job-pending' });
    h.synced();
    h.runner.start();
    h.runner.addClaimed([pending]);
    await h.time.advance(1000);
    const submitting = h.job({ job_id: 'job-submitting' });
    h.store.put({ ...h.store.get(pending.job_id)!, claimed: submitting, state: 'submitting', next_seq: 1, submitting_at: iso(T0) });
    h.runner.emergencyStop();
    await h.time.advance(1000);
    const blocked = h.reports(pending.job_id).find(report => report.event === 'blocked')!;
    assert.equal(blocked.data.event === 'blocked' && blocked.data.blocker.code, 'owner_stopped');
    assert.equal(h.reports(submitting.job_id).at(-1)!.event, 'outcome_unknown');
    await h.time.advance(3 * 3600_000);
    assert.equal(h.goCalls.length, 0, 'nothing runs until the owner resumes');
  } finally { await h.cleanup(); }
});

test('media hash mismatch fails the job before any browser step', async () => {
  const h = runnerHarness();
  try {
    h.failMedia(new MediaHashMismatch('a'.repeat(64)));
    const job = h.job();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(1000);
    assert.deepEqual(h.events_(job.job_id), ['failed']);
    const failed = h.reports(job.job_id)[0].data;
    assert.equal(failed.event === 'failed' && failed.code, 'media_hash_mismatch');
    assert.deepEqual((h.driver as ScriptedDriver).calls, []);
  } finally { await h.cleanup(); }
});

test('read-back follows the schedule, reports readback_pending each time and ends with outcome_unknown', async () => {
  const h = runnerHarness();
  try {
    const driver = h.driver as ScriptedDriver;
    for (let index = 0; index < 5; index++) driver.readBacks.push({ kind: 'not_yet' });
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(2 * MIN);
    await h.time.advance(30_000 + 60_000 + 120_000 + 5_000);
    const events = h.events_(job.job_id);
    assert.deepEqual(events.slice(-4), ['readback_pending', 'readback_pending', 'readback_pending', 'outcome_unknown']);
    assert.equal(driver.clicks, 1, 'read-back never clicks again');
    assert.equal(driver.calls.filter(call => call === 'readBack').length, 4);
  } finally { await h.cleanup(); }
});

test('a platform error after the click is reported as a fact and never retried', async () => {
  const h = runnerHarness();
  try {
    const driver = h.driver as ScriptedDriver;
    driver.publishImpl = async (_ctx, _job, opts) => {
      await opts.onBeforeClick();
      driver.clicks += 1;
      return { kind: 'blocked', blocker: { code: 'platform_error', phase: 'after_submit', message: 'TikTok 回報錯誤' } };
    };
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(30 * MIN);
    assert.equal(driver.clicks, 1);
    assert.deepEqual(h.events_(job.job_id).slice(-3), ['started', 'submitting', 'blocked']);
    assert.equal(h.store.get(job.job_id)?.state, 'done');
    assert.ok(!driver.calls.includes('readBack'));
    assert.equal(h.pins.at(-1), true, 'the window stays open for the owner (TikTok: the uploaded video waits for the owner\'s Post click)');
    assert.equal(h.page.navigations().length, 0, 'nothing navigates that window away afterwards');
  } finally { await h.cleanup(); }
});

test('go:false revoked releases the job without running it', async () => {
  const h = runnerHarness();
  try {
    const job = h.job({ not_before: iso(T0 + 60_000), not_after: iso(T0 + 31 * MIN) });
    h.setGo([{ go: false, reason: 'revoked', release: true }]);
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(2 * MIN);
    assert.deepEqual(h.events_(job.job_id).slice(-1), ['released']);
    assert.equal((h.driver as ScriptedDriver).clicks, 0);
  } finally { await h.cleanup(); }
});
