// §10.1 S9: update prompt — version comparison, SHA-256 check, a running job blocks the update.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compareVersions, offeredPackage, updateGate, UpdateManager } from '../../../apps/connector-desktop/src/app/update.ts';
import type { LocalJobView } from '../../../apps/connector-desktop/src/runtime/events.ts';

const NOW = Date.parse('2026-11-24T08:00:00Z');
const PACKAGE = Buffer.from('fake dmg bytes for the update test');
const SHA = createHash('sha256').update(PACKAGE).digest('hex');
const job = (state: string, notBefore: string, label = 'X @makemylure'): LocalJobView => ({
  job_id: `job-${state}`, kind: 'publish_post', provider: 'x', channel_label: label, state, not_before: notBefore, not_after: notBefore, blocker: null, dry_run: false,
  social_account_id: 'acct-x', profile_key: 'ch-aaaaaaaaaaaa',
});

function manager(t: { after(fn: () => unknown): void }, options: { jobs?: LocalJobView[]; body?: Buffer; status?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const notified: string[] = [];
  const opened: string[] = [];
  const downloads: URL[] = [];
  const offeredPackages: (string | null)[] = [];
  let jobs = options.jobs ?? [];
  const updates = new UpdateManager({
    currentVersion: '0.2.0', platform: 'darwin', hubOrigin: 'https://hub.tail1234.ts.net', dir, now: () => NOW, jobs: () => jobs,
    notifier: { notify: input => { notified.push(`${input.key}:${input.body}`); return true; } },
    download: async (url, _signal, offered) => { downloads.push(url); offeredPackages.push(offered); return new Response(new Uint8Array(options.body ?? PACKAGE), { status: options.status ?? 200, headers: { 'content-type': 'application/x-apple-diskimage', 'content-length': String((options.body ?? PACKAGE).length) } }); },
    openInstaller: async path => { opened.push(path); },
  });
  return { updates, dir, notified, opened, downloads, offeredPackages, setJobs: (value: LocalJobView[]) => { jobs = value; } };
}

test('version comparison: numeric parts, pre-releases before releases, garbage never newer', () => {
  assert.equal(compareVersions('0.2.1', '0.2.0'), 1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.2.0', '0.2.0'), 0);
  assert.equal(compareVersions('0.2.0-beta.2', '0.2.0'), -1);
  assert.equal(compareVersions('0.2.0-beta.10', '0.2.0-beta.2'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('latest', '0.2.0'), 0);
});

test('offer: only a newer version is announced, with one OS notification per version and a tray badge', t => {
  const { updates, notified } = manager(t);
  assert.equal(updates.offer({ version: '0.2.0', url: '/api/v1/worker-downloads/mac-arm64', sha256: SHA }), false, 'same version');
  assert.equal(updates.offer({ version: '0.1.9', url: '/api/v1/worker-downloads/mac-arm64', sha256: SHA }), false, 'older');
  assert.equal(updates.snapshot().available, null);
  assert.equal(updates.offer({ version: '0.2.1', url: '/api/v1/worker-downloads/mac-arm64', sha256: SHA }), true);
  updates.offer({ version: '0.2.1', url: '/api/v1/worker-downloads/mac-arm64', sha256: SHA });
  assert.deepEqual(notified, ['update:0.2.1:SmartSell Worker 0.2.1 可更新。打開 SmartSell Worker 按「更新」（有貼文正在發布時不能更新）。']);
  assert.deepEqual(updates.snapshot().available, { version: '0.2.1' });
  assert.match(updates.snapshot().keychain_notice!, /永遠允許/);
});

test('offer: an Intel Mac is never prompted with the arm64 package (guard against a hub without E9 arch selection)', t => {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-update-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const updates = new UpdateManager({ currentVersion: '0.2.0', platform: 'darwin', platformKey: 'mac-x64', hubOrigin: 'https://hub.tail1234.ts.net', dir,
    jobs: () => [], download: async () => new Response('x'), openInstaller: async () => {} });
  assert.equal(updates.offer({ version: '0.2.1', url: '/api/v1/worker-downloads/mac-arm64', sha256: SHA }), false);
  assert.equal(updates.offer({ version: '0.2.1', url: '/api/v1/worker-downloads/mac-x64', sha256: SHA }), true);
  // E9: heartbeat latest_worker.platform (C11 update_available.platform) wins over the URL shape.
  assert.equal(updates.offer({ version: '0.2.2', url: '/api/v1/worker-downloads/latest', sha256: SHA, platform: 'mac-arm64' }), false);
  assert.equal(updates.offer({ version: '0.2.2', url: '/api/v1/worker-downloads/latest', sha256: SHA, platform: 'mac-x64' }), true);
});

test('offeredPackage: the hub\'s platform field first, then the download URL', () => {
  assert.equal(offeredPackage({ version: '1.0.0', url: '/api/v1/worker-downloads/win-x64', sha256: SHA }), 'win-x64');
  assert.equal(offeredPackage({ version: '1.0.0', url: '/x?y', sha256: SHA, platform: 'mac-x64' }), 'mac-x64');
  assert.equal(offeredPackage({ version: '1.0.0', url: '/api/v1/worker-downloads/other', sha256: SHA }), null);
});

test('install: blocked while a job is running/submitting/result_pending; a job due within 30 minutes needs confirmation', async t => {
  const { updates, downloads, setJobs } = manager(t, { jobs: [job('submitting', '2026-11-24T07:59:00Z')] });
  updates.offer({ version: '0.2.1', url: '/api/v1/worker-downloads/mac-arm64', sha256: SHA });
  const blocked = await updates.install();
  assert.equal(blocked.ok, false);
  assert.equal(!blocked.ok && blocked.code, 'JOB_RUNNING');
  assert.match(!blocked.ok ? blocked.message : '', /X @makemylure/);
  assert.equal(updates.snapshot().blocked, true);
  assert.equal(downloads.length, 0, 'nothing downloaded while a post may be in flight');
  for (const state of ['running', 'result_pending']) assert.equal(updateGate([job(state, '2026-11-24T07:00:00Z')], NOW).blocked, true, state);
  setJobs([job('ready', '2026-11-24T08:20:00Z')]);
  const warn = await updates.install();
  assert.equal(!warn.ok && warn.code, 'DUE_SOON');
  assert.equal(downloads.length, 0);
  const done = await updates.install({ confirmDueSoon: true });
  assert.equal(done.ok, true);
  assert.equal(downloads.length, 1);
  setJobs([job('ready', '2026-11-24T10:00:00Z')]);
  assert.equal(updateGate([job('ready', '2026-11-24T10:00:00Z')], NOW).dueSoon.length, 0, 'a job two hours away does not warn');
});

test('install: SHA-256 is verified before the installer opens; a mismatch deletes the download', async t => {
  const good = manager(t);
  good.updates.offer({ version: '0.2.1', url: '/api/v1/worker-downloads/mac-arm64', sha256: SHA });
  const result = await good.updates.install();
  assert.equal(result.ok, true);
  assert.equal(good.downloads[0].href, 'https://hub.tail1234.ts.net/api/v1/worker-downloads/mac-arm64');
  assert.deepEqual(good.offeredPackages, ['mac-arm64'], 'the signed action names the offered package');
  assert.equal(good.opened.length, 1);
  assert.ok(good.opened[0].endsWith('SmartSell-Worker-0.2.1.dmg'));
  assert.deepEqual(readFileSync(good.opened[0]), PACKAGE);

  const bad = manager(t, { body: Buffer.from('tampered bytes') });
  bad.updates.offer({ version: '0.2.1', url: '/api/v1/worker-downloads/mac-arm64', sha256: SHA });
  const mismatch = await bad.updates.install();
  assert.equal(!mismatch.ok && mismatch.code, 'HASH_MISMATCH');
  assert.equal(bad.opened.length, 0, 'never opened');
  assert.deepEqual(readdirSync(bad.dir), [], 'the bad file is removed');
  assert.equal(bad.updates.snapshot().phase, 'failed');
});

test('install: a package URL on another origin is refused; an HTTP error is reported, not hidden', async t => {
  const foreign = manager(t);
  foreign.updates.offer({ version: '0.2.1', url: 'https://evil.example/pkg.dmg', sha256: SHA });
  const refused = await foreign.updates.install();
  assert.equal(!refused.ok && refused.code, 'BAD_URL');
  assert.equal(foreign.downloads.length, 0);
  const missing = manager(t, { status: 404 });
  missing.updates.offer({ version: '0.2.1', url: '/api/v1/worker-downloads/mac-arm64', sha256: SHA });
  const failed = await missing.updates.install();
  assert.equal(!failed.ok && failed.code, 'DOWNLOAD_FAILED');
  assert.equal(existsSync(join(missing.dir, 'SmartSell-Worker-0.2.1.dmg')), false);
  const none = manager(t);
  assert.equal((await none.updates.install()).ok, false);
});
