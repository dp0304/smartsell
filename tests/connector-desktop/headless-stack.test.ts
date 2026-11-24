// The whole Worker runtime as the headless runner runs it: pairing, add-channel,
// heartbeat v2, claim, signed media download, preflight, prepare, go, the X and
// TikTok drivers in headless Chrome against the fixture pages, read-back and
// evidence upload — against an in-process fake hub (S3 builds the real one).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { addChannel, parseArgs, pair } from '../../apps/connector-desktop/src/headless/runner.ts';
import { FileVault } from '../../apps/connector-desktop/src/headless/file-vault.ts';
import { createWorkerRuntime, type WorkerRuntime } from '../../apps/connector-desktop/src/runtime/worker.ts';
import { startPlatformFixtures, type PlatformFixtures } from '../fixtures/platforms/server.ts';
import { chromePathSync, makeClip, publishJob } from './fakes/driver-harness.ts';
import { startFakeHub, type FakeHub } from './fakes/fake-hub.ts';

const executable = chromePathSync();

async function until(check: () => boolean, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (check()) return; await new Promise(done => setTimeout(done, 200)); }
  assert.fail(`timed out waiting for ${label}`);
}

describe('headless Worker against a fake hub and the fixture platforms', { skip: executable ? false : 'Google Chrome is not installed', concurrency: false }, () => {
  let hub: FakeHub;
  let fixtures: PlatformFixtures;
  const machines: { name: string; dir: string; runtime?: WorkerRuntime; profileKey?: string; deviceId?: string }[] = [
    { name: 'Mac-B', dir: mkdtempSync(join(tmpdir(), 'smartsell-mac-b-')) },
    { name: 'Win-C', dir: mkdtempSync(join(tmpdir(), 'smartsell-win-c-')) },
  ];
  const saved = { ...process.env };

  before(async () => {
    hub = await startFakeHub();
    fixtures = await startPlatformFixtures({ uploadMs: 600, xProcessingMs: 600 });
    Object.assign(process.env, {
      SMARTSELL_TEST_MODE: '1', SMARTSELL_CHROME_PATH: executable, SMARTSELL_TEST_PLATFORM_ORIGINS: JSON.stringify(fixtures.origins),
      SMARTSELL_TEST_PREPARE_LEAD_SEC: '3', SMARTSELL_TEST_READBACK_SCHEDULE_SEC: '1,2,3', SMARTSELL_TEST_BLOCKER_POLL_SEC: '1',
    });
  });
  after(async () => {
    for (const machine of machines) { await machine.runtime?.stop(); }
    await new Promise(done => setTimeout(done, 800));
    for (const machine of machines) rmSync(machine.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    await fixtures?.close();
    await hub?.close();
    process.env = saved;
  });

  test('pair and add-channel register each machine and its channel with a fresh profile', async () => {
    for (const [index, machine] of machines.entries()) {
      const code = hub.issuePairingCode();
      machine.deviceId = await pair(parseArgs(['--data-dir', machine.dir, '--name', machine.name, 'pair', '--hub', hub.origin, '--workspace', hub.workspaceId, '--code', code, '--platform', 'darwin']));
      const vault = new FileVault(machine.dir).load()!;
      assert.equal(vault.machine_name, machine.name);
      const added = await addChannel(parseArgs(['--data-dir', machine.dir, 'add-channel', '--provider', index === 0 ? 'x' : 'tiktok']));
      machine.profileKey = added.profileKey;
      assert.match(added.profileKey, /^ch-[0-9a-f]{12}$/);
    }
    const registered = hub.registrations as { platform: string; external_id: string; handle?: string; profile_key: string; automation_notice_version: string }[];
    assert.deepEqual(registered.map(item => [item.platform, item.external_id, item.handle]), [['x', 'fixture_x', 'fixture_x'], ['tiktok', '7234567890123456789', 'fixture_tt']]);
    assert.deepEqual(registered.map(item => item.profile_key), machines.map(machine => machine.profileKey));
    assert.ok(registered.every(item => item.automation_notice_version === 'automation-notice-2026-11'));
  });

  test('two machines publish at the scheduled time: one X and one TikTok post, URL back at the hub, media hash intact', async () => {
    const clipDir = mkdtempSync(join(tmpdir(), 'smartsell-clip-'));
    try {
      const clip = makeClip(clipDir, 'video.mp4', 400_000);
      hub.media.set('file-video', { bytes: readFileSync(clip.path) });
      const notBefore = Date.now() + 12_000;
      const jobs = machines.map((machine, index) => {
        const provider = index === 0 ? 'x' as const : 'tiktok' as const;
        const job = publishJob(provider, clip, {
          media: [{ file_id: 'file-video', sha256: clip.sha256, bytes: clip.bytes, mime: 'video/mp4', filename: 'video.mp4', kind: 'video', duration_ms: 20000, width: 1080, height: 1920 }],
        }, { job_id: `job-${provider}`, fencing_token: 0, not_before: new Date(notBefore).toISOString(), not_after: new Date(notBefore + 3 * 60_000).toISOString() });
        job.payload.channel.profile_key = machine.profileKey!;
        hub.addJob(machine.deviceId!, job);
        return job;
      });
      hub.channels = [];
      for (const machine of machines) {
        const vault = new FileVault(machine.dir).load()!;
        machine.runtime = createWorkerRuntime({
          dataDir: machine.dir, identity: { origin: vault.origin, workspaceId: vault.workspace_id, deviceId: vault.device_id, privateKey: vault.private_key_pem, machineName: vault.machine_name },
          clientVersion: '0.2.0', headless: true, heartbeatMs: 500,
        });
        machine.runtime.start();
      }
      await until(() => jobs.every(job => hub.job(job.job_id).status === 'succeeded'), 120_000, 'both jobs succeeded');
      const x = hub.job('job-x'), tiktok = hub.job('job-tiktok');
      assert.match(String(x.result?.url), /^https:\/\/x\.com\/fixture_x\/status\/\d+$/);
      assert.match(String(tiktok.result?.url), /^https:\/\/www\.tiktok\.com\/@fixture_tt\/video\/\d+$/);
      for (const job of [x, tiktok]) {
        const events = job.reports.map(report => report.event);
        assert.deepEqual(events.filter(event => event !== 'readback_pending'), ['prepared', 'prepared', 'started', 'submitting', 'submitted', 'result'], events.join(','));
        assert.deepEqual(job.reports.map(report => report.seq), job.reports.map((_, index) => index + 1));
        assert.equal(job.go_source, 'hub');
        const started = Date.parse(job.reports.find(report => report.event === 'started')!.worker_time);
        assert.ok(started >= notBefore - 1000 && started <= notBefore + 15_000, `started ${started - notBefore} ms after not_before`);
        const evidence = (job.result!.evidence_sha256 as string[]);
        assert.ok(evidence.length >= 2);
        assert.ok(evidence.every(sha => hub.evidence.get(job.claimed.job_id)?.some(item => item.sha256 === sha)), 'evidence uploaded before the result');
      }
      const posts = fixtures.posts();
      assert.equal(posts.filter(post => post.platform === 'x').length, 1);
      assert.equal(posts.filter(post => post.platform === 'tiktok').length, 1);
      assert.ok(posts.every(post => post.media_sha256 === createHash('sha256').update(readFileSync(clip.path)).digest('hex')));
    } finally { rmSync(clipDir, { recursive: true, force: true }); }
  });

  test('captcha: the job waits for the owner without reloading the page, then publishes', async () => {
    const machine = machines[0];
    fixtures.setScenario('x', 'captcha');
    const clip = { sha256: createHash('sha256').update(hub.media.get('file-video')!.bytes).digest('hex'), bytes: hub.media.get('file-video')!.bytes.length };
    const notBefore = Date.now() + 6_000;
    const job = publishJob('x', clip, {
      caption: { text: 'Captcha case', title: null },
      media: [{ file_id: 'file-video', sha256: clip.sha256, bytes: clip.bytes, mime: 'video/mp4', filename: 'video.mp4', kind: 'video', duration_ms: 20000, width: 1080, height: 1920 }],
    }, { job_id: 'job-captcha', fencing_token: 0, not_before: new Date(notBefore).toISOString(), not_after: new Date(notBefore + 3 * 60_000).toISOString() });
    job.payload.channel.profile_key = machine.profileKey!;
    const alerts: string[] = [];
    machine.runtime!.events.on('local_alert', event => alerts.push(event.body));
    hub.addJob(machine.deviceId!, job);
    await until(() => hub.job('job-captcha').status === 'needs_owner', 60_000, 'needs_owner');
    const blocked = hub.job('job-captcha').reports.find(report => report.event === 'prepare_blocked')!;
    assert.equal(blocked.data.event === 'prepare_blocked' && blocked.data.blocker.code, 'captcha');
    assert.ok(alerts.some(body => body.includes('Mac-B 的 X @fixture_x 出現驗證碼')), alerts.join('\n'));
    const loads = fixtures.pageLoads();
    await new Promise(done => setTimeout(done, 4000));
    assert.deepEqual(fixtures.pageLoads(), loads, 'no reload while waiting for the owner');
    assert.equal(fixtures.posts().filter(post => post.text === 'Captcha case').length, 0);
    fixtures.setScenario('x', 'ok');
    await until(() => hub.job('job-captcha').status === 'succeeded', 60_000, 'published after the captcha cleared');
    assert.equal(fixtures.posts().filter(post => post.text === 'Captcha case').length, 1);
  });

  test('hub down at the scheduled time: the Worker runs offline on time and delivers every fact after recovery', async () => {
    const machine = machines[0];
    const bytes = hub.media.get('file-video')!.bytes;
    const clip = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    const notBefore = Date.now() + 9_000;
    const job = publishJob('x', clip, {
      caption: { text: 'Offline case', title: null },
      media: [{ file_id: 'file-video', sha256: clip.sha256, bytes: clip.bytes, mime: 'video/mp4', filename: 'video.mp4', kind: 'video', duration_ms: 20000, width: 1080, height: 1920 }],
    }, { job_id: 'job-offline', fencing_token: 0, not_before: new Date(notBefore).toISOString(), not_after: new Date(notBefore + 3 * 60_000).toISOString() });
    job.payload.channel.profile_key = machine.profileKey!;
    hub.addJob(machine.deviceId!, job);
    await until(() => hub.job('job-offline').status === 'ready', 30_000, 'final prepare before the outage');
    hub.setDown(true);
    await until(() => fixtures.posts().some(post => post.text === 'Offline case'), 60_000, 'posted while the hub is down');
    const created = Date.parse(fixtures.posts().find(post => post.text === 'Offline case')!.created_at);
    assert.ok(created - notBefore < 25_000, `posted ${created - notBefore} ms after not_before`);
    hub.setDown(false);
    await until(() => hub.job('job-offline').status === 'succeeded', 60_000, 'facts delivered after recovery');
    const offline = hub.job('job-offline');
    assert.equal(offline.go_source, 'offline');
    const events = offline.reports.map(report => report.event).filter(event => event !== 'readback_pending');
    assert.deepEqual(events.slice(-4), ['started', 'submitting', 'submitted', 'result']);
    assert.deepEqual(offline.reports.map(report => report.seq), offline.reports.map((_, index) => index + 1));
    assert.equal(fixtures.posts().filter(post => post.text === 'Offline case').length, 1);
  });

  test('result unknown is never re-posted: created_hidden ends as outcome_unknown with exactly one post', async () => {
    const machine = machines[0];
    fixtures.setScenario('x', 'created_hidden');
    const bytes = hub.media.get('file-video')!.bytes;
    const clip = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    const job = publishJob('x', clip, {
      caption: { text: 'Hidden case', title: null },
      media: [{ file_id: 'file-video', sha256: clip.sha256, bytes: clip.bytes, mime: 'video/mp4', filename: 'video.mp4', kind: 'video', duration_ms: 20000, width: 1080, height: 1920 }],
    }, { job_id: 'job-hidden', fencing_token: 0, not_before: new Date(Date.now() + 4000).toISOString(), not_after: new Date(Date.now() + 3 * 60_000).toISOString() });
    job.payload.channel.profile_key = machine.profileKey!;
    hub.addJob(machine.deviceId!, job);
    await until(() => hub.job('job-hidden').status === 'outcome_unknown', 120_000, 'outcome_unknown');
    const events = hub.job('job-hidden').reports.map(report => report.event);
    assert.deepEqual(events.filter(event => event === 'readback_pending').length, 3);
    assert.equal(events.at(-1), 'outcome_unknown');
    assert.equal(fixtures.posts().filter(post => post.text === 'Hidden case').length, 1);
    fixtures.setScenario('x', 'ok');
  });

  test('dry run with the bundled clip stops before Post and reports dry_run_done', async () => {
    const machine = machines[1];
    const bundled = mkdtempSync(join(tmpdir(), 'smartsell-bundled-'));
    try {
      const clip = makeClip(bundled, 'test-clip.mp4', 20_000);
      await machine.runtime!.stop();
      const vault = new FileVault(machine.dir).load()!;
      machine.runtime = createWorkerRuntime({
        dataDir: machine.dir, identity: { origin: vault.origin, workspaceId: vault.workspace_id, deviceId: vault.device_id, privateKey: vault.private_key_pem, machineName: vault.machine_name },
        clientVersion: '0.2.0', headless: true, heartbeatMs: 500, bundledClip: clip.path,
      });
      machine.runtime.start();
      const job = publishJob('tiktok', clip, {
        media: [{ file_id: null, bundled: 'test-clip-v1', sha256: clip.sha256, bytes: clip.bytes, mime: 'video/mp4', filename: 'test-clip.mp4', kind: 'video', duration_ms: 4000, width: 720, height: 1280 }],
        publish_target_id: null, execution_task_id: null, frozen_hash: null,
      }, { job_id: 'job-dry', fencing_token: 0, dry_run: true, not_before: new Date().toISOString(), not_after: new Date(Date.now() + 30 * 60_000).toISOString() });
      job.payload.channel.profile_key = machine.profileKey!;
      const before = fixtures.posts().length;
      hub.addJob(machine.deviceId!, job);
      await until(() => hub.job('job-dry').status === 'succeeded', 90_000, 'dry run done');
      const done = hub.job('job-dry').reports.at(-1)!;
      assert.equal(done.event, 'dry_run_done');
      assert.ok(done.data.event === 'dry_run_done' && done.data.trace.length > 3);
      assert.equal(fixtures.posts().length, before);
      assert.ok(!hub.log.some(entry => entry.action === 'media.read' && entry.path.includes('null')), 'the bundled clip is never downloaded');
    } finally { rmSync(bundled, { recursive: true, force: true }); }
  });
});
