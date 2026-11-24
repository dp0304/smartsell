import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ProfileError, Profiles, type BrowserHandle } from '../../apps/connector-desktop/src/runtime/profiles.ts';
import type { JobsHeldEvent } from '../../apps/connector-desktop/src/runtime/events.ts';
import { FakeCdpPage } from './fakes/fake-cdp-page.ts';
import { MIN, runnerHarness, ScriptedDriver, T0 } from './fakes/runner-harness.ts';

function launcher() {
  const launched: { dir: string; handle: BrowserHandle & { closed: boolean } }[] = [];
  return {
    launched,
    launch: (dir: string) => {
      const handle = { closed: false, async openPage() { return new FakeCdpPage(); }, close() { handle.closed = true; } };
      launched.push({ dir, handle });
      return handle;
    },
  };
}

test('one 0700 profile per channel, a lock file, an in-process mutex and idle close unless pinned', async () => {
  const root = mkdtempSync(join(tmpdir(), 'smartsell-profiles-'));
  try {
    let now = 0;
    const fake = launcher();
    const profiles = new Profiles({ root, launch: fake.launch, idleMs: 10 * MIN, now: () => now });
    const first = await profiles.acquire('ch-aaaaaaaaaaaa');
    assert.equal(first.dir, join(root, 'ch-aaaaaaaaaaaa'));
    if (process.platform !== 'win32') assert.equal(statSync(first.dir).mode & 0o777, 0o700);
    assert.ok(existsSync(join(first.dir, '.smartsell.lock')));
    let secondGranted = false;
    const second = profiles.acquire('ch-aaaaaaaaaaaa').then(lease => { secondGranted = true; return lease; });
    await new Promise(done => setTimeout(done, 20));
    assert.equal(secondGranted, false, 'a second driver waits for the first');
    first.release();
    const lease = await second;
    assert.equal(fake.launched.length, 1, 'same Chrome reused');
    lease.pin(true);
    lease.release();
    now += 11 * MIN;
    profiles.closeIdle();
    assert.equal(fake.launched[0].handle.closed, false, 'pinned (owner must act) stays open');
    lease.pin(false);
    profiles.closeIdle();
    assert.equal(fake.launched[0].handle.closed, true);
    assert.equal(existsSync(join(first.dir, '.smartsell.lock')), false);
    const other = await profiles.acquire('ch-bbbbbbbbbbbb');
    assert.notEqual(other.dir, first.dir, 'channels never share a profile');
    other.release();
    assert.throws(() => profiles.dirFor('../escape'), /Invalid Chrome profile key/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('close(key): refused while a driver holds it; closes Chrome, waits for the exit, removes the lock; a pin ends at the next lease', async () => {
  const root = mkdtempSync(join(tmpdir(), 'smartsell-profiles-'));
  try {
    const exits: number[] = [];
    let exitedOk = true;
    const launched: (BrowserHandle & { closed: boolean })[] = [];
    const profiles = new Profiles({ root, idleMs: 0, now: () => 0, launch: () => {
      const handle = { closed: false, async openPage() { return new FakeCdpPage(); }, close() { handle.closed = true; },
        async exited(ms: number) { exits.push(ms); return exitedOk; } };
      launched.push(handle);
      return handle;
    } });
    const lease = await profiles.acquire('ch-enrol0000000');
    await assert.rejects(profiles.close('ch-enrol0000000'), (error: unknown) => error instanceof ProfileError && error.code === 'profile_in_use');
    assert.equal(launched[0].closed, false, 'a held profile is never closed under a driver');
    lease.pin(true);
    lease.release();
    await profiles.close('ch-enrol0000000');
    assert.equal(launched[0].closed, true);
    assert.equal(exits.length, 1, 'waits for the Chrome process to exit');
    assert.equal(existsSync(join(root, 'ch-enrol0000000', '.smartsell.lock')), false);
    assert.deepEqual(profiles.running(), []);
    await profiles.close('ch-unknown00000');
    // The next lease relaunches; a pin left by the owner's window does not survive the Worker taking the profile again.
    const again = await profiles.acquire('ch-enrol0000000');
    assert.equal(launched.length, 2);
    again.pin(true);
    again.release();
    profiles.closeIdle();
    assert.equal(launched[1].closed, false, 'pinned for the owner');
    (await profiles.acquire('ch-enrol0000000')).release();
    profiles.closeIdle();
    assert.equal(launched[1].closed, true, 'unpinned after the new lease, so the idle close applies');
    const stuck = await profiles.acquire('ch-stuck0000000');
    stuck.release();
    exitedOk = false;
    await assert.rejects(profiles.close('ch-stuck0000000'), /沒有在時限內關閉/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a profile held by another live process is profile_in_use (auto-resume blocker)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'smartsell-profiles-'));
  try {
    const profiles = new Profiles({ root, launch: launcher().launch });
    const dir = profiles.ensure('ch-cccccccccccc');
    writeFileSync(join(dir, '.smartsell.lock'), JSON.stringify({ pid: process.ppid, host: hostname() }));
    await assert.rejects(profiles.acquire('ch-cccccccccccc'), (error: unknown) => error instanceof ProfileError && error.code === 'profile_in_use');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('jobs_held tracks unfinished publish jobs for the power blocker (C11)', async () => {
  const h = runnerHarness();
  const held: JobsHeldEvent[] = [];
  h.events.on('jobs_held', event => held.push(event));
  try {
    const job = h.job({ not_before: new Date(T0 + 60_000).toISOString(), not_after: new Date(T0 + 31 * MIN).toISOString() });
    h.synced();
    h.runner.start();
    h.runner.addClaimed([job]);
    await h.time.advance(1000);
    assert.ok(held.some(event => event.publish_jobs === 1 && event.next_due_at === job.not_before), JSON.stringify(held));
    await h.time.advance(2 * MIN);
    assert.deepEqual(held.at(-1), { publish_jobs: 0, next_due_at: null });
  } finally { await h.cleanup(); }
});

test('check_login: open_login_window waits read-only for the owner, then reports verified', async () => {
  const h = runnerHarness();
  try {
    const driver = h.driver as ScriptedDriver;
    driver.login = { state: 'login_required', identity: null, handle: null, evidence_sha256: [] };
    const base = h.job();
    const check = { ...base, job_id: 'job-check', kind: 'check_login' as const, not_before: new Date(T0).toISOString(), not_after: new Date(T0 + 10 * MIN).toISOString(),
      payload: { schema: 'smartsell.worker.check_login.v1' as const, provider: 'x' as const, channel: base.payload.channel, open_login_window: true } };
    h.runner.start();
    h.runner.addClaimed([check]);
    await h.time.advance(30_000);
    assert.deepEqual(h.events_('job-check'), []);
    assert.ok(h.page.calls.some(call => call.method === 'bringToFront'), 'the login page is brought to the front');
    driver.login = { state: 'verified', identity: 'fixture_x', handle: 'fixture_x', evidence_sha256: [] };
    driver.cleared = true;
    await h.time.advance(11_000);
    const report = h.reports('job-check').at(-1)!;
    assert.deepEqual(report.data, { event: 'login_state', state: 'verified', identity: 'fixture_x', handle: 'fixture_x', evidence_sha256: [] });
    assert.ok(h.store.state().channel_checks['acct-x']);
  } finally { await h.cleanup(); }
});
