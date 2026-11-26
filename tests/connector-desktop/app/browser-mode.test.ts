// Own-Chrome mode in the App (core-automation-proposal §3.2, step 3): choosing 「用我自己的 Chrome」 restarts the runtime
// with browserMode own_chrome, registers the native messaging host for this data dir's bridge socket and copies the
// extension to a folder Chrome's 「載入未封裝項目」 can open; switching is refused while a post is being published.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { WorkerShell, type WorkerShellDeps } from '../../../apps/connector-desktop/src/app/worker-mode.ts';
import { bridgeSocketPath } from '../../../apps/connector-desktop/src/browser-bridge/bridge.ts';
import type { WorkerRuntime, WorkerRuntimeOptions } from '../../../apps/connector-desktop/src/runtime/worker.ts';
import { appSettings } from '../../../apps/connector-desktop/src/service-settings.ts';

function setup(t: { after(fn: () => unknown): void }, jobs: { state: string }[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ss-browser-mode-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const source = join(dir, 'bundled-extension');
  mkdirSync(source);
  writeFileSync(join(source, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '9.9.9' }));
  writeFileSync(join(source, 'background.js'), '// bg');
  const created: WorkerRuntimeOptions[] = [];
  const registered: { dataDir: string; socketPath: string }[] = [];
  const log: string[] = [];
  const { privateKey } = generateKeyPairSync('ed25519');
  const deps = {
    userData: dir, platform: 'darwin', version: '0.3.0', hostname: 'Mac-B.local',
    vault: { available: () => true, load: () => ({ origin: 'https://hub.example.ts.net', workspace: 'ws', device: 'dev-1', name: 'Mac-B', key: privateKey }), save() {}, clear() {} },
    notifier: { notify: () => true, reset() {} }, power: { onJobsHeld() {}, hold() {}, release() {} },
    posture: { current: () => null, remote: () => null, start() {}, stop() {} }, autostart: { set: () => true, enabled: () => false },
    settings: appSettings(join(dir, 'settings.json')), openExternal: async () => {}, bundledClip: null,
    updates: () => ({ snapshot: () => null, offer() {} }), onChange() {}, log: (message: string) => { log.push(message); },
    extension: { source, installDir: join(dir, 'Documents', 'SmartSell Worker', 'chrome-extension') },
    registerHost: async (options: { dataDir: string; socketPath: string }) => { registered.push(options); return { wrapper: 'w', manifests: ['m'], registry: [] }; },
    createRuntime: (options: WorkerRuntimeOptions) => {
      created.push(options);
      return { options, start() {}, async stop() { log.push('runtime.stop'); }, snapshot: () => ({ channels: [], jobs, machine: null }), store: { state: () => ({}) },
        runner: { views: () => [] }, bridge: undefined } as unknown as WorkerRuntime;
    },
  } as unknown as WorkerShellDeps;
  return { dir, deps, created, registered, log, installDir: join(dir, 'Documents', 'SmartSell Worker', 'chrome-extension') };
}

test('a new Worker runs separate profiles until the owner chooses; the snapshot offers the choice', t => {
  const ctx = setup(t);
  const shell = new WorkerShell(ctx.deps);
  shell.start();
  assert.equal(ctx.created[0].browserMode, 'profiles');
  const browser = shell.snapshot().browser;
  assert.deepEqual([browser.mode, browser.chosen, browser.extension_id], ['profiles', false, 'ghfcogpklmadimibmifjhfhlcncpcncp']);
});

test('choosing own Chrome restarts the runtime in own_chrome, registers the host and copies the extension', async t => {
  const ctx = setup(t);
  const shell = new WorkerShell(ctx.deps);
  shell.start();
  await shell.setBrowserMode('own_chrome');
  assert.equal(ctx.created.at(-1)!.browserMode, 'own_chrome');
  assert.ok(ctx.log.includes('runtime.stop'), 'the old runtime stopped first');
  await new Promise(done => setImmediate(done));
  assert.deepEqual(ctx.registered, [{ dataDir: ctx.dir, socketPath: bridgeSocketPath(ctx.dir) }]);
  assert.equal(JSON.parse(readFileSync(join(ctx.installDir, 'manifest.json'), 'utf8')).version, '9.9.9');
  assert.ok(existsSync(join(ctx.installDir, 'background.js')));
  const snap = shell.snapshot();
  assert.deepEqual([snap.browser.mode, snap.browser.chosen, snap.browser.host_registered, snap.browser.extension_dir], ['own_chrome', true, true, ctx.installDir]);
  assert.match(String(snap.message), /你自己的 Chrome/);
  // The choice survives a restart of the App.
  const again = new WorkerShell(ctx.deps);
  again.start();
  assert.equal(ctx.created.at(-1)!.browserMode, 'own_chrome');
});

test('switching is refused while a post is being published', async t => {
  const ctx = setup(t, [{ state: 'submitting' }]);
  const shell = new WorkerShell(ctx.deps);
  shell.start();
  await assert.rejects(shell.setBrowserMode('own_chrome'), /有貼文正在準備或發布/);
  assert.equal(ctx.created.length, 1, 'no restart');
  await assert.rejects(shell.setBrowserMode('chrome-canary'), /請選擇要用哪個 Chrome/);
});
