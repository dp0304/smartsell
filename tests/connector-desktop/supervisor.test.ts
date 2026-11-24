import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DeviceProtocolClient } from '../../apps/connector/src/device-client.ts';
import { HubClock, systemSource, type ClockSource } from '../../apps/connector-desktop/src/runtime/clock.ts';
import { RuntimeEventBus, type ConnectionEvent } from '../../apps/connector-desktop/src/runtime/events.ts';
import type { JobRunner } from '../../apps/connector-desktop/src/runtime/job-runner.ts';
import { JobStore, type LocalJob } from '../../apps/connector-desktop/src/runtime/job-store.ts';
import { HubError, HubProtocol } from '../../apps/connector-desktop/src/runtime/protocol.ts';
import { backoffDelay, heartbeatArch, Supervisor } from '../../apps/connector-desktop/src/runtime/supervisor.ts';
import { DriverRegistry } from '../../apps/connector-desktop/src/drivers/registry.ts';
import { defaultSelectors, SelectorStore } from '../../apps/connector-desktop/src/drivers/selectors.ts';
import type { ClaimedJob, DevicePosture } from '../../apps/connector-desktop/src/runtime/contracts.ts';
import { FakeHub, startFakeHub } from './fakes/fake-hub.ts';
import { FakeTime } from './fakes/fake-time.ts';
import { publishJob } from './fakes/driver-harness.ts';

const DEVICE = 'dev-mac-b';

function localJob(claimed: ClaimedJob): LocalJob {
  return {
    claimed, state: 'media_ready', media_paths: {}, readback_attempts: 0, offline_go_disabled: false, revoked: false, fence: claimed.fencing_token, next_seq: 1,
    sync: { hold: false, hold_reason: null, mode: claimed.mode, resume_token: 0, machine_paused: false, pause_all: false, channel_paused: false, synced_at: new Date(0).toISOString() },
    last_sync_at: new Date(0).toISOString(),
  };
}

async function setup(options: { source?: ClockSource; posture?: () => DevicePosture | null; log?: (message: string, detail?: object) => void } = {}) {
  const hub = await startFakeHub();
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  hub.addDevice(DEVICE, publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'));
  const clock = new HubClock(options.source ?? systemSource);
  const client = new DeviceProtocolClient({ origin: hub.origin, workspaceId: hub.workspaceId, deviceId: DEVICE, key: privateKey, now: () => clock.now(), localNow: () => clock.localNow() });
  const protocol = new HubProtocol(client, clock, { request: 3000, go: 3000 });
  const root = mkdtempSync(join(tmpdir(), 'smartsell-supervisor-'));
  const store = new JobStore(root);
  const events = new RuntimeEventBus();
  const connection: ConnectionEvent[] = [];
  events.on('connection', event => connection.push(event));
  const calls = { synced: 0, claimed: [] as ClaimedJob[], fenceLost: [] as string[] };
  const runner = {
    synced: () => { calls.synced += 1; },
    addClaimed: (jobs: ClaimedJob[]) => { calls.claimed.push(...jobs); for (const job of jobs) store.put(localJob(job)); },
    fenceLost: (id: string) => { calls.fenceLost.push(id); },
    tick: () => {}, views: () => [],
  } as unknown as JobRunner;
  const selectors = new SelectorStore(join(root, 'driver-config'));
  const ensured: string[] = [];
  const supervisor = new Supervisor({ hub: protocol, store, runner, clock, events, drivers: new DriverRegistry(), selectors, clientVersion: '0.2.0',
    random: () => 0.5, profiles: { ensure: (key: string) => { ensured.push(key); return key; } }, posture: options.posture, log: options.log });
  return { hub, clock, store, events, connection, calls, supervisor, selectors, ensured, root,
    async close() { await supervisor.stop(); await hub.close(); rmSync(root, { recursive: true, force: true }); } };
}

function heldJob(hub: FakeHub, store: JobStore, overrides: Partial<ClaimedJob> = {}) {
  const claimed = publishJob('x', { sha256: 'a'.repeat(64), bytes: 10 }, {}, { fencing_token: 1, ...overrides });
  hub.addJob(DEVICE, claimed, 'claimed');
  store.put(localJob(claimed));
  return claimed;
}

test('backoff: 2, 4, 8, 16, 32, 60 s then 60 s, ±20% jitter, 15 s cap when a job is due within 10 minutes', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 9].map(n => backoffDelay(n, false, () => 0.5)), [2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(backoffDelay(6, false, () => 0), 48000);
  assert.equal(backoffDelay(6, false, () => 1), 72000);
  assert.equal(backoffDelay(6, true, () => 0.5), 15000);
  assert.equal(backoffDelay(1, true, () => 0.5), 2000);
});

test('5xx and connection errors back off and reconnect; success resets the counter', async () => {
  const s = await setup();
  try {
    s.hub.inject({ action: 'heartbeat', status: 502, times: 2 });
    assert.equal(await s.supervisor.tick(), 2000);
    assert.equal(await s.supervisor.tick(), 4000);
    assert.equal(s.supervisor.state, 'reconnecting');
    s.hub.setDown(true);
    assert.equal(await s.supervisor.tick(), 8000);
    s.hub.setDown(false);
    assert.equal(await s.supervisor.tick(), 15_000);
    assert.equal(s.supervisor.state, 'online');
    assert.equal(s.supervisor.failures, 0);
    assert.equal(s.connection.at(-1)?.state, 'online');
    assert.ok(s.connection.some(event => event.state === 'reconnecting' && event.next_retry_at));
  } finally { await s.close(); }
});

test('503 DEVICE_BUSY waits for Retry-After', async () => {
  const s = await setup();
  try {
    s.hub.inject({ action: 'heartbeat', status: 503, code: 'DEVICE_BUSY', retryAfter: '7' });
    assert.equal(await s.supervisor.tick(), 7000);
  } finally { await s.close(); }
});

test('401 DEVICE_PROOF_EXPIRED corrects the clock from the Date header and retries once', async () => {
  const s = await setup();
  try {
    s.hub.clockOffsetMs = 5 * 60_000;
    assert.equal(await s.supervisor.tick(), 15_000);
    assert.equal(s.supervisor.state, 'online');
    assert.ok(Math.abs(s.clock.offsetMs! - 5 * 60_000) < 2000, `offset ${s.clock.offsetMs}`);
    assert.deepEqual(s.hub.log.filter(entry => entry.action === 'heartbeat').map(entry => entry.status), [401, 200]);
    assert.equal(s.store.state().clock_offset_ms, s.clock.offsetMs, 'the offset is persisted for offline go after a restart');
  } finally { await s.close(); }
});

test('the clock offset follows server_time and the round trip', async () => {
  const s = await setup();
  try {
    s.hub.clockOffsetMs = 40_000;
    await s.supervisor.tick();
    assert.ok(Math.abs(s.clock.offsetMs! - 40_000) < 500, `offset ${s.clock.offsetMs}`);
    assert.equal(s.clock.skewWarning, true, 'more than 30 s is shown as a warning');
  } finally { await s.close(); }
});

test('401 DEVICE_INACTIVE and 403 stop the connection and tell the owner', async () => {
  const s = await setup();
  try {
    s.hub.revokedDevices.add(DEVICE);
    await s.supervisor.tick();
    assert.equal(s.supervisor.state, 'device_revoked');
    assert.equal(s.connection.at(-1)?.message, '此機器已在中樞被撤銷或停用。');
    await s.supervisor.start();
    assert.equal(s.hub.log.filter(entry => entry.action === 'heartbeat').length, 1, 'no more heartbeats once revoked');
  } finally { await s.close(); }
  const t = await setup();
  try {
    t.hub.inject({ action: 'heartbeat', status: 403, code: 'FORBIDDEN' });
    await t.supervisor.tick();
    assert.equal(t.supervisor.state, 'device_revoked');
  } finally { await t.close(); }
});

test('heartbeat state is written to disk before last_sync_at moves', async () => {
  const s = await setup();
  try {
    const claimed = heldJob(s.hub, s.store);
    const hubJob = s.hub.job(claimed.job_id);
    hubJob.hold = true; hubJob.hold_reason = 'approval_invalid'; hubJob.mode = 'assist'; hubJob.resume_token = 2;
    s.hub.channels = [{ social_account_id: 'acct-x', provider: 'x', handle: 'fixture_x', expected_identity: 'fixture_x', profile_key: 'ch-aaaaaaaaaaaa',
      effective_mode: 'assist', paused: true, settings_generation: 3, login_check_requested: false }];
    let stateWrites = 0;
    s.store.fault = operation => { if (operation === 'state' && ++stateWrites === 1) throw new Error('disk full'); };
    await s.supervisor.tick();
    assert.equal(s.store.state().last_sync_at, null, 'last_sync_at not advanced when the synced state could not be written');
    s.store.fault = undefined;
    const before = Date.now();
    await s.supervisor.tick();
    const job = s.store.get(claimed.job_id)!;
    assert.deepEqual({ hold: job.sync.hold, reason: job.sync.hold_reason, mode: job.sync.mode, token: job.sync.resume_token, channel: job.sync.channel_paused },
      { hold: true, reason: 'approval_invalid', mode: 'assist', token: 2, channel: true });
    const synced = Date.parse(s.store.state().last_sync_at!);
    assert.ok(synced >= before - 1000);
    assert.ok(Date.parse(job.last_sync_at) >= Date.parse(job.sync.synced_at));
    assert.equal(s.store.state().applied_sync_generation, 1);
    assert.deepEqual(s.ensured, ['ch-aaaaaaaaaaaa'], 'profiles exist for every channel bound to this machine');
    assert.ok(s.calls.synced >= 1);
  } finally { await s.close(); }
});

test('the outbox drains before claim, and evidence is uploaded before the report that cites it', async () => {
  const s = await setup();
  try {
    const claimed = heldJob(s.hub, s.store);
    s.hub.addJob(DEVICE, publishJob('x', { sha256: 'b'.repeat(64), bytes: 10 }, {}, { job_id: 'job-queued', not_before: new Date(Date.now() + 3600_000).toISOString() }));
    const sha = s.store.addEvidence(claimed.job_id, 'before_submit', Buffer.from('jpeg bytes'));
    s.store.enqueue(claimed.job_id, 'started', { event: 'started', go: 'hub', mode: 'auto' }, new Date().toISOString());
    s.store.enqueue(claimed.job_id, 'dry_run_done', { event: 'dry_run_done', evidence_sha256: [sha], trace: [] }, new Date().toISOString());
    await s.supervisor.tick();
    assert.deepEqual(s.hub.actions(), ['heartbeat', 'jobs.report', 'evidence.upload', 'jobs.report', 'jobs.claim']);
    assert.equal(s.hub.evidence.get(claimed.job_id)?.[0].sha256, sha);
    assert.equal(s.store.outboxDepth(), 0);
    const claim = s.hub.log.find(entry => entry.action === 'jobs.claim')!.body as { held_job_ids: string[] };
    assert.deepEqual(claim.held_job_ids, [claimed.job_id]);
    assert.deepEqual(s.calls.claimed.map(job => job.job_id), ['job-queued']);
    assert.equal(s.calls.claimed[0].fencing_token, 2, 'claim bumps the fence');
  } finally { await s.close(); }
});

test('409 JOB_FENCE_LOST drops only that job\'s lease reports; facts are still delivered (renumbered on SEQ_GAP)', async () => {
  const s = await setup();
  try {
    const claimed = heldJob(s.hub, s.store);
    s.hub.job(claimed.job_id).claimed.fencing_token = 2; // re-claimed elsewhere: our fence 1 is stale
    s.store.enqueue(claimed.job_id, 'prepared', { event: 'prepared', stage: 'final', login: 'verified', identity: 'fixture_x', handle: 'fixture_x', media_ok: true, driver: { provider: 'x', version: 'x@t' } }, new Date().toISOString());
    s.store.enqueue(claimed.job_id, 'started', { event: 'started', go: 'offline', mode: 'auto' }, new Date().toISOString());
    s.store.enqueue(claimed.job_id, 'readback_pending', { event: 'readback_pending', attempt: 1, next_at: new Date().toISOString() }, new Date().toISOString());
    s.store.enqueue(claimed.job_id, 'submitting', { event: 'submitting' }, new Date().toISOString());
    await s.supervisor.flushOutbox();
    const delivered = s.hub.job(claimed.job_id).reports;
    assert.deepEqual(delivered.map(report => report.event), ['started', 'submitting']);
    assert.deepEqual(delivered.map(report => report.seq), [1, 2]);
    assert.equal(s.store.outboxDepth(), 0);
    assert.deepEqual(s.calls.fenceLost, [claimed.job_id]);
    assert.ok(s.hub.log.some(entry => entry.status === 409), 'saw the 409');
  } finally { await s.close(); }
});

test('SEQ_GAP resends from expected; SEQ_CONFLICT drops the entry', async () => {
  const s = await setup();
  try {
    const claimed = heldJob(s.hub, s.store);
    s.store.update(claimed.job_id, job => { job.next_seq = 3; }); // entries 1–2 were lost locally
    s.store.enqueue(claimed.job_id, 'started', { event: 'started', go: 'hub', mode: 'auto' }, new Date().toISOString());
    s.store.enqueue(claimed.job_id, 'submitting', { event: 'submitting' }, new Date().toISOString());
    await s.supervisor.flushOutbox();
    assert.deepEqual(s.hub.job(claimed.job_id).reports.map(report => [report.event, report.seq]), [['started', 1], ['submitting', 2]]);
    assert.equal(s.store.get(claimed.job_id)?.next_seq, 3);

    s.hub.job(claimed.job_id).seq_by_fence[1] = 9;
    s.store.update(claimed.job_id, job => { job.next_seq = 5; });
    s.store.enqueue(claimed.job_id, 'submitted', { event: 'submitted' }, new Date().toISOString());
    await s.supervisor.flushOutbox();
    assert.equal(s.store.outboxDepth(), 0, 'conflicting entry dropped');
    assert.equal(s.hub.job(claimed.job_id).reports.length, 2);
  } finally { await s.close(); }
});

test('a duplicate report counts as delivered', async () => {
  const s = await setup();
  try {
    const claimed = heldJob(s.hub, s.store);
    const entry = s.store.enqueue(claimed.job_id, 'started', { event: 'started', go: 'hub', mode: 'auto' }, new Date().toISOString());
    s.hub.job(claimed.job_id).event_ids.add(entry.event_id);
    await s.supervisor.flushOutbox();
    assert.equal(s.store.outboxDepth(), 0);
  } finally { await s.close(); }
});

test('revocations are persisted, updates announced once, and a rejected selector file marks drivers unknown', async () => {
  const s = await setup();
  try {
    const claimed = heldJob(s.hub, s.store);
    s.hub.job(claimed.job_id).revoke = 'cancelled';
    s.hub.job(claimed.job_id).status = 'releasing';
    s.hub.latestWorker = { version: '0.2.1', platform: 'mac-arm64', url: '/api/v1/worker-downloads/mac-arm64', sha256: 'f'.repeat(64) };
    const updates: string[] = [];
    const platforms: (string | undefined)[] = [];
    s.events.on('update_available', event => { updates.push(event.version); platforms.push(event.platform); });
    const broken = Buffer.from(JSON.stringify({ ...defaultSelectors(), version: '2026.12.1', x: { steps: {}, patterns: {} } }));
    s.hub.driverConfig = { bytes: broken, version: '2026.12.1', sha256: createHash('sha256').update(broken).digest('hex') };
    await s.supervisor.tick();
    await s.supervisor.tick();
    assert.equal(s.store.get(claimed.job_id)?.revoked, true);
    assert.deepEqual(updates, ['0.2.1']);
    assert.deepEqual(platforms, ['mac-arm64'], 'update_available carries latest_worker.platform (C11 review suggestion 3)');
    assert.equal(s.hub.log.filter(entry => entry.action === 'driver_config.read').length, 1, 'a rejected version is not downloaded again');
    const drivers = (s.hub.log.filter(entry => entry.action === 'heartbeat').at(-1)!.body as { drivers: { health: string }[] }).drivers;
    assert.ok(drivers.every(driver => driver.health === 'unknown'));
    const good = Buffer.from(JSON.stringify({ ...defaultSelectors(), version: '2026.12.2' }));
    s.hub.driverConfig = { bytes: good, version: '2026.12.2', sha256: createHash('sha256').update(good).digest('hex') };
    await s.supervisor.tick();
    assert.equal(s.selectors.version, '2026.12.2');
    assert.equal(s.store.state().driver_config?.version, '2026.12.2');
  } finally { await s.close(); }
});

test('E9: heartbeat v2 carries arch (arm64 | x64 from process.arch); other CPUs omit it', async () => {
  assert.equal(heartbeatArch('arm64'), 'arm64');
  assert.equal(heartbeatArch('x64'), 'x64');
  assert.equal(heartbeatArch('ia32'), undefined);
  const s = await setup();
  try {
    await s.supervisor.tick();
    const body = s.hub.log.filter(entry => entry.action === 'heartbeat').at(-1)!.body as { arch?: string };
    assert.equal(body.arch, heartbeatArch(process.arch));
  } finally { await s.close(); }
});

test('events: on() returns a disposer that removes only that listener (C11 review suggestion 2)', () => {
  const events = new RuntimeEventBus();
  const seen: string[] = [];
  const stop = events.on('jobs_changed', () => seen.push('a'));
  events.on('jobs_changed', () => seen.push('b'));
  events.emit('jobs_changed', { jobs: [] });
  stop();
  events.emit('jobs_changed', { jobs: [] });
  assert.deepEqual(seen, ['a', 'b', 'b']);
});

test('posture is sent when it changes and at least every 30 minutes', async () => {
  let posture: DevicePosture = { os: 'darwin', os_version: '15.6', sleep_idle_min: 0, on_battery: false, auto_login: 'off', filevault: 'on', power_plan_sleep_min: null };
  const s = await setup({ posture: () => posture });
  try {
    await s.supervisor.tick();
    await s.supervisor.tick();
    posture = { ...posture, on_battery: true };
    await s.supervisor.tick();
    s.store.updateState(state => { state.posture_sent_at = new Date(Date.now() - 31 * 60_000).toISOString(); });
    await s.supervisor.tick();
    const sent = s.hub.log.filter(entry => entry.action === 'heartbeat').map(entry => 'posture' in (entry.body as object));
    assert.deepEqual(sent, [true, false, true, true]);
  } finally { await s.close(); }
});

test('after 10 minutes without a heartbeat and with a job due in 2 hours, the shell gets hub_unreachable once', async () => {
  const time = new FakeTime(Date.now());
  const s = await setup({ source: time });
  try {
    heldJob(s.hub, s.store, { not_before: new Date(time.now() + 3600_000).toISOString(), not_after: new Date(time.now() + 5400_000).toISOString() });
    const alerts: { since: string; jobs_due_2h: number }[] = [];
    s.events.on('hub_unreachable', event => alerts.push(event));
    s.hub.setDown(true);
    for (let minute = 0; minute < 14; minute++) { await s.supervisor.tick(); time.jump(60_000); }
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].jobs_due_2h, 1);
  } finally { await s.close(); }
});

// ---------- WA-4: evidence that can never be sent must not stall the outbox ----------

test('WA-4: a screenshot over 4 MiB is marked rejected and logged; its report and every later fact still reach the hub', async () => {
  const logs: { message: string; detail?: object }[] = [];
  const s = await setup({ log: (message, detail) => logs.push({ message, detail }) });
  try {
    const a = heldJob(s.hub, s.store, { job_id: 'job-aaaa-1111' });
    const b = heldJob(s.hub, s.store, { job_id: 'job-bbbb-2222' });
    const big = s.store.addEvidence(a.job_id, 'after_submit', Buffer.alloc(Math.floor(4.5 * 1024 * 1024), 7));
    const small = s.store.addEvidence(a.job_id, 'before_submit', Buffer.from('jpeg bytes'));
    s.store.enqueue(a.job_id, 'started', { event: 'started', go: 'hub', mode: 'auto' }, new Date().toISOString());
    s.store.enqueue(a.job_id, 'outcome_unknown', { event: 'outcome_unknown', reason: 'readback_exhausted', evidence_sha256: [small, big] }, new Date().toISOString());
    s.store.enqueue(b.job_id, 'started', { event: 'started', go: 'hub', mode: 'auto' }, new Date().toISOString());
    await s.supervisor.tick();
    assert.deepEqual(s.hub.events(a.job_id), ['started', 'outcome_unknown']);
    assert.deepEqual(s.hub.events(b.job_id), ['started']);
    assert.equal(s.store.outboxDepth(), 0);
    assert.deepEqual(s.hub.evidence.get(a.job_id)?.map(item => item.sha256), [small], 'the small one is still uploaded');
    assert.equal(s.store.evidence(a.job_id).find(record => record.sha256 === big)?.rejected, true);
    assert.ok(logs.some(entry => entry.message === 'evidence not sent' && /too large/.test(String((entry.detail as { reason?: string }).reason))));
  } finally { await s.close(); }
});

test('WA-4: a screenshot whose file is gone (ENOENT) is rejected instead of blocking the outbox', async () => {
  const logs: { message: string; detail?: object }[] = [];
  const s = await setup({ log: (message, detail) => logs.push({ message, detail }) });
  try {
    const a = heldJob(s.hub, s.store, { job_id: 'job-cccc-3333' });
    const sha = s.store.addEvidence(a.job_id, 'after_submit', Buffer.from('jpeg bytes'));
    rmSync(join(s.store.evidenceDir, a.job_id, '1.jpg'));
    s.store.enqueue(a.job_id, 'started', { event: 'started', go: 'hub', mode: 'auto' }, new Date().toISOString());
    s.store.enqueue(a.job_id, 'outcome_unknown', { event: 'outcome_unknown', reason: 'readback_exhausted', evidence_sha256: [sha] }, new Date().toISOString());
    await s.supervisor.tick();
    assert.deepEqual(s.hub.events(a.job_id), ['started', 'outcome_unknown']);
    assert.equal(s.store.outboxDepth(), 0);
    assert.ok(logs.some(entry => entry.message === 'evidence not sent' && /ENOENT/.test(String((entry.detail as { reason?: string }).reason))));
  } finally { await s.close(); }
});

test('WA-4: HubProtocol reports a local evidence refusal (size, ids) as a client error, never as an unreachable hub', async () => {
  const clock = new HubClock(systemSource);
  const client = { uploadEvidence() { throw new TypeError('Invalid fencing token'); } } as unknown as DeviceProtocolClient;
  const protocol = new HubProtocol(client, clock);
  await assert.rejects(protocol.uploadEvidence('job-1', 1, Buffer.alloc(5 * 1024 * 1024), 'image/jpeg'),
    (error: unknown) => error instanceof HubError && error.kind === 'client' && error.code === 'EVIDENCE_TOO_LARGE' && !error.unreachable);
  await assert.rejects(protocol.uploadEvidence('job-1', 0, Buffer.from('x'), 'image/jpeg'),
    (error: unknown) => error instanceof HubError && error.kind === 'client' && !error.unreachable);
});
