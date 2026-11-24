// §10.1 S9: --mcp-relay takes no single-instance lock, opens no window, hides the Dock; the smoke check
// touches neither the lock nor a login item; a second resident instance quits.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type * as Electron from 'electron';
import { bootstrap, parseShellArgs, resourcePaths, workerPlatform } from '../../../apps/connector-desktop/src/app/shell.ts';
import { relayArgs } from '../../../apps/connector-desktop/src/app/relay-mode.ts';

function fakeElectron(options: { lock?: boolean } = {}) {
  const calls: string[] = [];
  const record = (name: string) => (..._args: unknown[]) => { calls.push(name); };
  const app = {
    dock: { hide: record('dock.hide') },
    getPath: (name: string) => { calls.push(`getPath:${name}`); return '/fake/userData'; },
    setPath: (name: string, value: string) => { calls.push(`setPath:${name}=${value}`); },
    exit: (code?: number) => { calls.push(`exit:${code}`); },
    quit: record('quit'),
    requestSingleInstanceLock: () => { calls.push('requestSingleInstanceLock'); return options.lock ?? true; },
    whenReady: () => { calls.push('whenReady'); return new Promise(() => {}); },
    enableSandbox: record('enableSandbox'),
    setLoginItemSettings: record('setLoginItemSettings'),
    getLoginItemSettings: () => { calls.push('getLoginItemSettings'); return { openAtLogin: false }; },
    setAppUserModelId: record('setAppUserModelId'),
    getName: () => 'SmartSell Worker', getVersion: () => '0.2.0', isPackaged: false,
    on: record('app.on'),
  };
  const forbidden = (name: string) => class { constructor() { calls.push(`new ${name}`); throw new Error(`${name} must not be created`); } };
  const electron = {
    app, BrowserWindow: forbidden('BrowserWindow'), Tray: forbidden('Tray'), Notification: forbidden('Notification'),
    protocol: { registerSchemesAsPrivileged: record('protocol.registerSchemesAsPrivileged') },
    safeStorage: { isEncryptionAvailable: () => { calls.push('safeStorage'); return true; }, decryptString: () => { calls.push('safeStorage.decrypt'); return ''; } },
    dialog: { showErrorBox: record('dialog.showErrorBox') },
  } as unknown as typeof Electron;
  return { electron, calls };
}

const stdio = () => ({ stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });

test('--mcp-relay: hides the Dock, never takes the single-instance lock, creates no window or tray, exits with relayMain code', async () => {
  const { electron, calls } = fakeElectron();
  let received: { argv: readonly string[]; defaultConfigPath?: string } | undefined;
  const argv = ['/Applications/SmartSell Worker.app/Contents/MacOS/SmartSell Worker', '--mcp-relay', '--hub', 'https://hub.tail1234.ts.net'];
  const result = await bootstrap(electron, { release: {}, argv, appDir: '/fake/dist', platform: 'darwin', stdio: stdio(),
    relayMain: async options => { received = options; return 7; } });
  assert.equal(result, 'relay');
  assert.deepEqual(received?.argv, ['--mcp-relay', '--hub', 'https://hub.tail1234.ts.net']);
  assert.equal(received?.defaultConfigPath, join('/fake/userData', 'agent-relay', 'config.json'));
  assert.ok(calls.includes('dock.hide'));
  assert.ok(calls.includes('exit:7'));
  for (const never of ['requestSingleInstanceLock', 'whenReady', 'new BrowserWindow', 'new Tray', 'setLoginItemSettings', 'safeStorage', 'enableSandbox']) {
    assert.ok(!calls.some(call => call.startsWith(never)), `${never} must not happen in relay mode (calls: ${calls.join(', ')})`);
  }
  assert.ok(calls.indexOf('dock.hide') < calls.indexOf('exit:7'));
});

test('relay mode on Windows (no Dock) still runs and passes the relay flags through', async () => {
  const { electron, calls } = fakeElectron();
  (electron.app as unknown as { dock?: unknown }).dock = undefined;
  const result = await bootstrap(electron, { release: {}, argv: ['C:\\SmartSell Worker.exe', '--mcp-relay', '--config', 'C:\\c.json'], appDir: 'x', platform: 'win32',
    stdio: stdio(), relayMain: async options => { assert.deepEqual(options.argv, ['--mcp-relay', '--config', 'C:\\c.json']); return 0; } });
  assert.equal(result, 'relay');
  assert.ok(!calls.includes('requestSingleInstanceLock'));
  assert.deepEqual(relayArgs(['electron', '.', '--mcp-relay', '--version']), ['--mcp-relay', '--version']);
});

test('--smoke checks the build without the lock, the keychain or a login item and reports JSON', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-smoke-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { electron, calls } = fakeElectron();
  const out = stdio();
  let text = '';
  out.stdout.on('data', chunk => { text += chunk; });
  const appDir = join(import.meta.dirname, '../../../apps/connector-desktop/src');
  const result = await bootstrap(electron, { release: {}, argv: ['app', '--smoke', `--smartsell-user-data=${dir}`, `--smoke-out=${join(dir, 'report.json')}`], appDir, platform: 'darwin', stdio: out });
  assert.equal(result, 'smoke');
  const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(JSON.parse(text).product, 'SmartSell Worker');
  const byName = Object.fromEntries(report.checks.map((item: { name: string; ok: boolean }) => [item.name, item.ok]));
  assert.equal(byName.test_clip, true, 'the bundled 4 s clip matches resources/test-clip.json');
  assert.equal(byName.worker_runtime, true);
  assert.equal(byName.relay_module, true);
  assert.equal(byName.driver_selectors, true, 'the bundled selector table validates');
  assert.equal(byName.heartbeat_arch, ['arm64', 'x64'].includes(process.arch), 'E9 arch for the heartbeat');
  assert.ok(calls.includes(`setPath:userData=${dir}`));
  for (const never of ['requestSingleInstanceLock', 'setLoginItemSettings', 'safeStorage', 'new BrowserWindow', 'new Tray']) assert.ok(!calls.some(call => call.startsWith(never)), never);
  assert.ok(calls.some(call => call.startsWith('exit:')));
});

test('a second resident instance quits instead of starting', async () => {
  const { electron, calls } = fakeElectron({ lock: false });
  const result = await bootstrap(electron, { release: {}, argv: ['app'], appDir: 'x', platform: 'darwin', stdio: stdio() });
  assert.equal(result, 'second_instance');
  assert.ok(calls.includes('requestSingleInstanceLock'));
  assert.ok(calls.includes('quit'));
  assert.ok(!calls.includes('whenReady'));
});

test('shell argument and path helpers', () => {
  assert.deepEqual(parseShellArgs(['app', '--background']), { relay: false, background: true, smoke: false, smokeOut: null, userData: null });
  assert.equal(parseShellArgs(['app', '--smoke', '--smoke-out', '/tmp/r.json']).smokeOut, '/tmp/r.json');
  assert.equal(workerPlatform('darwin', 'arm64'), 'mac-arm64');
  assert.equal(workerPlatform('darwin', 'x64'), 'mac-x64');
  assert.equal(workerPlatform('win32', 'x64'), 'win-x64');
  assert.equal(workerPlatform('linux', 'x64'), null);
  assert.equal(resourcePaths('/a/dist', true, '/R').clip, join('/R', 'resources', 'test-clip.mp4'));
  assert.equal(resourcePaths('/a/dist', false).clip, join('/a', 'resources', 'test-clip.mp4'));
  assert.equal(resourcePaths('/a/dist', true, '/R').relay, join('/R', 'agent-relay', 'smartsell-relay.mjs'));
});
