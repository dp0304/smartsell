// §10.1 S9: vault-locked notification; §8.2 start-up (auto-connect, login item after the first pairing); C11 events
// to notifications / power / update; §8.16 add-account through enrollChannel() + registerEnrolledChannel().
import assert from 'node:assert/strict';
import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Notifier } from '../../../apps/connector-desktop/src/app/notify.ts';
import { PowerGuard } from '../../../apps/connector-desktop/src/app/power.ts';
import { UpdateManager } from '../../../apps/connector-desktop/src/app/update.ts';
import { adoptProfileKey, registeredProfileKey, sanitizeMachineName, WorkerShell, type WorkerShellDeps } from '../../../apps/connector-desktop/src/app/worker-mode.ts';
import type { WorkerRuntime, WorkerRuntimeOptions } from '../../../apps/connector-desktop/src/runtime/worker.ts';
import { appSettings } from '../../../apps/connector-desktop/src/service-settings.ts';
import { deviceVault, VaultLockedError, type Pairing, type Vault } from '../../../apps/connector-desktop/src/vault.ts';

const WS = '11111111-2222-3333-4444-555555555555';

function fakeRuntime(options: WorkerRuntimeOptions, log: string[]) {
  const runtime = {
    options, events: options.events!,
    start: () => { log.push('runtime.start'); },
    stop: async () => { log.push('runtime.stop'); },
    emergencyStop: () => { log.push('emergencyStop'); }, resume: () => { log.push('resume'); },
    snapshot: () => ({ connection: 'online', message: null, last_success_at: null, next_retry_at: null, clock_offset_ms: 120, clock_warning: false,
      last_sync_at: null, channels: [{ social_account_id: 'sa-1', provider: 'x', handle: 'makemylure', expected_identity: 'makemylure', profile_key: 'ch-aaaaaaaaaaaa',
        effective_mode: 'assist', paused: false, settings_generation: 1, login_check_requested: false }], machine: null, outbox_depth: 0, emergency_stop: false, driver_config_version: null, jobs: [] }),
    store: { state: () => ({ channel_checks: { 'sa-1': '2026-11-24T07:00:00.000Z' } }), get: () => undefined },
    runner: { views: () => [] }, clock: { now: () => Date.now() },
    profiles: { root: '/p', dirFor: (key: string) => `/p/${key}` }, drivers: { get: () => undefined }, selectors: {}, platformUrl: () => 'http://x', hub: { registerChannels: async () => [] },
  };
  return runtime as unknown as WorkerRuntime;
}

function deps(t: { after(fn: () => unknown): void }, vault: Vault, extra: Partial<WorkerShellDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-shell-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log: string[] = [];
  const shown: { title: string; body: string; url: string | null }[] = [];
  const notifier = new Notifier({ supported: () => true, open: () => {}, create: options => ({ show() { shown.push({ title: options.title, body: options.body, url: null }); }, on() {} }) });
  const blocker = { started: new Set<number>(), start(this: { started: Set<number> }) { this.started.add(1); return 1; }, stop(this: { started: Set<number> }) { this.started.clear(); }, isStarted(this: { started: Set<number> }) { return this.started.has(1); } };
  const power = new PowerGuard(blocker);
  const autostartCalls: boolean[] = [];
  let runtime: WorkerRuntime | undefined;
  const base: WorkerShellDeps = {
    userData: dir, platform: 'darwin', version: '0.2.0', hostname: 'Mac-B.local', vault, notifier, power,
    posture: { current: () => null, remote: () => null, start: () => log.push('posture.start'), stop: () => {} },
    autostart: { set: enabled => { autostartCalls.push(enabled); return true; }, enabled: () => autostartCalls.at(-1) ?? false },
    settings: appSettings(join(dir, 'settings.json')), openExternal: async () => {}, bundledClip: '/clip.mp4',
    updates: (pairing, rt) => new UpdateManager({ currentVersion: '0.2.0', platform: 'darwin', hubOrigin: pairing.origin, dir: join(dir, 'updates'),
      jobs: () => rt.runner.views(), download: async () => new Response('x'), openInstaller: async () => {}, notifier }),
    onChange: () => {}, log: message => log.push(message), vaultRetryMs: 10,
    createRuntime: options => (runtime = fakeRuntime(options, log)),
    ...extra,
  };
  return { deps: base, log, shown, power, blocker, autostartCalls, runtime: () => runtime, dir };
}

const memoryVault = (initial?: Pairing) => {
  let value = initial;
  return { saved: [] as Pairing[], available: () => true, load: () => value, save(p: Pairing) { value = p; this.saved.push(p); }, clear: () => { value = undefined; } };
};

test('vault locked: OS notification names the machine, tray state is red, retry starts the Worker once unlocked', async t => {
  let locked = true;
  const { privateKey } = generateKeyPairSync('ed25519');
  const pairing: Pairing = { origin: 'https://hub.tail1234.ts.net', workspace: WS, device: 'dev-1', name: 'Mac-B', key: privateKey };
  const vault = { available: () => true, load: () => { if (locked) throw new VaultLockedError('decrypt_failed'); return pairing; }, save() {}, clear() {} };
  const ctx = deps(t, vault);
  const shell = new WorkerShell(ctx.deps);
  shell.start();
  assert.equal(shell.phase, 'vault_locked');
  assert.equal(ctx.shown.length, 1);
  assert.equal(ctx.shown[0].title, 'SmartSell 無法連線');
  assert.match(ctx.shown[0].body, /SmartSell 需要在 Mac-B 允許鑰匙圈存取，否則無法連線/);
  assert.equal(shell.snapshot().connection, 'vault_locked');
  assert.equal(ctx.runtime(), undefined, 'no runtime without the key');
  locked = false;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(shell.phase, 'running', 'the timer retried after the owner allowed the keychain');
  assert.equal(ctx.runtime()?.snapshot().connection, 'online');
  await shell.stop();
});

test('deviceVault: a pairing that cannot be decrypted is VaultLockedError, never "not paired"', t => {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-vault-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let fail = false;
  let stored = '';
  const vault = deviceVault(join(dir, 'pairing.enc'), {
    isEncryptionAvailable: () => true, encryptString: value => { stored = value; return Buffer.from('cipher'); },
    decryptString: () => { if (fail) throw new Error('keychain denied'); return stored; },
  }, 'darwin');
  assert.equal(vault.load(), undefined);
  vault.save({ origin: 'https://hub.tail1234.ts.net', workspace: WS, device: 'dev-1', name: 'Mac-B', key: generateKeyPairSync('ed25519').privateKey });
  fail = true;
  assert.throws(() => vault.load(), (error: unknown) => error instanceof VaultLockedError && error.reason === 'decrypt_failed');
});

test('start-up with a pairing connects automatically through createWorkerRuntime(identity from the vault, bundled clip, posture providers)', async t => {
  const { privateKey } = generateKeyPairSync('ed25519');
  const vault = memoryVault({ origin: 'https://hub.tail1234.ts.net', workspace: WS, device: 'dev-1', name: 'Mac-B', key: privateKey });
  const ctx = deps(t, vault);
  const shell = new WorkerShell(ctx.deps);
  shell.start();
  const options = (ctx.runtime() as unknown as { options: WorkerRuntimeOptions }).options;
  assert.deepEqual({ ...options.identity, privateKey: undefined }, { origin: 'https://hub.tail1234.ts.net', workspaceId: WS, deviceId: 'dev-1', privateKey: undefined, machineName: 'Mac-B' });
  assert.equal((options.identity.privateKey as KeyObject).asymmetricKeyType, 'ed25519');
  assert.equal(options.dataDir, ctx.dir);
  assert.equal(options.bundledClip, '/clip.mp4');
  assert.equal(typeof options.posture, 'function');
  assert.equal(typeof options.remoteAccess, 'function');
  assert.ok(ctx.log.includes('runtime.start'));
  assert.equal(ctx.autostartCalls.length, 0, 'the login item is only set after a pairing');

  // C11 events → OS notifications, the idle-sleep blocker and the update prompt.
  const events = shell.events;
  events.emit('local_alert', { kind: 'blocker', title: 'Mac-B 需要你處理', body: 'Mac-B 的 X @makemylure 出現驗證碼，已停止。', web_url: 'https://hub.tail1234.ts.net/app/w/posts/p1' });
  events.emit('hub_unreachable', { since: '2026-11-24T07:50:00.000Z', jobs_due_2h: 2 });
  events.emit('hub_unreachable', { since: '2026-11-24T07:50:00.000Z', jobs_due_2h: 2 });
  events.emitJobsHeld({ publish_jobs: 1, next_due_at: '2026-11-24T09:00:00.000Z' });
  events.emit('update_available', { version: '0.2.1', url: '/api/v1/worker-downloads/mac-arm64', sha256: 'a'.repeat(64) });
  events.emit('connection', { state: 'device_revoked', next_retry_at: null, last_success_at: null, clock_offset_ms: null, clock_warning: false, message: '此機器已在中樞被撤銷或停用。' });
  assert.deepEqual(ctx.shown.map(item => item.body), [
    'Mac-B 的 X @makemylure 出現驗證碼，已停止。',
    '中樞 10 分鐘連不上，Mac-B 有 2 則貼文待發；到點會依離線規則照發。',
    'SmartSell Worker 0.2.1 可更新。打開 SmartSell Worker 按「更新」（有貼文正在發布時不能更新）。',
    '此機器已在中樞被撤銷或停用。',
  ]);
  assert.equal(ctx.power.active(), true);
  assert.equal(shell.snapshot().update?.available?.version, '0.2.1');
  assert.equal(shell.phase, 'device_revoked');
  const snap = shell.snapshot();
  assert.equal(snap.channels[0].last_login_check_at, '2026-11-24T07:00:00.000Z');
  assert.equal(snap.machine_url, `https://hub.tail1234.ts.net/app/${WS}/machines/dev-1`);
  await shell.stop();
  assert.equal(ctx.power.active(), false);
});

test('pairing: hub address + machine name; the browser grant returns the code; vault saved; login item turned on once', async t => {
  const vault = memoryVault();
  const grants: { origin: string; name: string }[] = [];
  const paired: unknown[][] = [];
  const ctx = deps(t, vault, {
    grant: async (address, name) => { grants.push({ origin: address.origin, name }); return { workspace: WS, code: 'c'.repeat(32) }; },
    pair: async (...args) => { paired.push(args); return 'dev-9'; },
  });
  const shell = new WorkerShell(ctx.deps);
  shell.start();
  assert.equal(shell.phase, 'unpaired');
  await assert.rejects(shell.pair({ hub: 'https://hub.tail1234.ts.net', name: 'Mac-B', owns: false }), /有權管理/);
  const result = await shell.pair({ hub: 'https://hub.tail1234.ts.net/', name: '  Mac-B\u0007 ', owns: true });
  assert.deepEqual(result, { device_id: 'dev-9', name: 'Mac-B' });
  assert.deepEqual(grants, [{ origin: 'https://hub.tail1234.ts.net', name: 'Mac-B' }]);
  assert.deepEqual(paired[0].slice(0, 5), ['https://hub.tail1234.ts.net', WS, 'c'.repeat(32), 'darwin', 'Mac-B']);
  assert.deepEqual(paired[0][6], { userInitiated: true, ownsDevice: true });
  assert.equal(vault.saved[0].device, 'dev-9');
  assert.deepEqual(ctx.autostartCalls, [true]);
  assert.equal(ctx.deps.settings.load().role, 'worker');
  assert.equal(shell.phase, 'running');
  await assert.rejects(shell.pair({ hub: 'https://hub.tail1234.ts.net', name: 'x', owns: true }), /已經配對/);
  await shell.forget();
  assert.equal(shell.phase, 'unpaired');
  assert.equal(vault.load(), undefined);
});

test('pairing with a typed code skips the browser; a rejected code is explained; the owner can switch the login item off', async t => {
  const ctx = deps(t, memoryVault(), {
    grant: async () => assert.fail('a typed code needs no browser'),
    pair: async () => { const { PermitError } = await import('../../../apps/connector/src/permit.ts'); throw new PermitError(403); },
  });
  ctx.deps.settings.save({ autostart: false });
  const shell = new WorkerShell(ctx.deps);
  shell.start();
  await assert.rejects(shell.pair({ hub: 'https://hub.tail1234.ts.net', name: 'Win-C', workspace: WS, code: 'd'.repeat(32), owns: true }), /配對碼可能已過期/);
  assert.equal(shell.phase, 'unpaired');
  assert.equal(sanitizeMachineName('', 'Mac-B.local'), 'Mac-B');
  assert.equal(sanitizeMachineName('x'.repeat(150), 'h').length, 100);
});

test('add account: enrollChannel in a new profile, "偵測到 X @handle" with the automation notice, register only after 加入', async t => {
  const { privateKey } = generateKeyPairSync('ed25519');
  let release!: (value: { provider: 'x'; profileKey: string; identity: string; handle: string; observedAt: string }) => void;
  const registered: unknown[] = [];
  const ctx = deps(t, memoryVault({ origin: 'https://hub.tail1234.ts.net', workspace: WS, device: 'dev-1', name: 'Mac-B', key: privateKey }), {
    enroll: (async (_deps: unknown, provider: string, options: { keepOpen?: boolean }) => {
      assert.equal(provider, 'x');
      assert.equal(options.keepOpen, true, 'the Chrome window stays open for the owner');
      return new Promise(resolve => { release = resolve as never; });
    }) as never,
    register: (async (_hub: unknown, channel: unknown) => { registered.push(channel); return [{ profile_key: 'ch-aaaaaaaaaaaa' }]; }) as never,
  });
  const shell = new WorkerShell(ctx.deps);
  shell.start();
  assert.throws(() => shell.addAccount('youtube'), /X 或 TikTok/);
  const pending = shell.addAccount('x');
  assert.equal(pending?.status, 'waiting_login');
  await assert.rejects(shell.confirmAccount(), /還沒有偵測到/);
  assert.equal(registered.length, 0);
  release({ provider: 'x', profileKey: 'ch-aaaaaaaaaaaa', identity: 'makemylure', handle: 'makemylure', observedAt: '2026-11-24T08:00:00.000Z' });
  await new Promise(resolve => setImmediate(resolve));
  const detected = shell.snapshot().enrollment!;
  assert.equal(detected.status, 'detected');
  assert.equal(detected.label, 'X @makemylure');
  assert.match(detected.notice, /SmartSell 會在這台機器上開啟並操作這個帳號的網頁/);
  assert.equal(registered.length, 0, 'nothing is registered before 加入');
  const done = await shell.confirmAccount();
  assert.deepEqual(done, { profile_key: 'ch-aaaaaaaaaaaa' });
  assert.equal(registered.length, 1);
  assert.equal(shell.snapshot().enrollment?.status, 'registered');
  assert.match(shell.snapshot().enrollment?.note ?? '', /代按發布需要在網頁的帳號頁確認風險/);
  await shell.stop();
});

test('re-registration keeps the hub profile key (S2 ledger 11): moved when the old folder is absent, kept otherwise', async t => {
  const root = mkdtempSync(join(tmpdir(), 'smartsell-profiles-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'ch-new000000000'));
  const closed: string[] = [];
  const profiles = { root, dirFor: (key: string) => join(root, key), close: async (key: string) => { closed.push(key); } };
  assert.match(await adoptProfileKey(profiles, 'ch-new000000000', 'ch-hub000000000'), /沿用中樞記錄/);
  assert.ok(existsSync(join(root, 'ch-hub000000000')) && !existsSync(join(root, 'ch-new000000000')));
  assert.deepEqual(closed, ['ch-new000000000'], 'the enrolment Chrome is closed before the folder moves');
  mkdirSync(join(root, 'ch-new111111111'));
  assert.match(await adoptProfileKey(profiles, 'ch-new111111111', 'ch-hub000000000'), /原本的 Chrome 資料夾/);
  // Chrome did not exit in time (or is in use): the folder stays where it is and the owner is told.
  const stuck = { root, dirFor: (key: string) => join(root, key), close: async () => { throw new Error('still running'); } };
  assert.match(await adoptProfileKey(stuck, 'ch-new111111111', 'ch-zzz000000000'), /沒能改成中樞記錄的名稱/);
  assert.ok(existsSync(join(root, 'ch-new111111111')) && !existsSync(join(root, 'ch-zzz000000000')));
  assert.equal(registeredProfileKey({ registrations: [{ profile_key: 'ch-abcdefabcdef' }] }), 'ch-abcdefabcdef');
  assert.equal(registeredProfileKey([{ profile_key: '../evil' }]), null);
});
