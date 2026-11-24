// §8.2 resident mode: login item per OS (never set for real in tests), background start detection, tray model.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Autostart, loginItemSettings, usesMainAppService, type LoginItemSettingsInput } from '../../../apps/connector-desktop/src/app/autostart.ts';
import { trayModel, trayPixels } from '../../../apps/connector-desktop/src/app/tray.ts';
import { Notifier, safeWebUrl } from '../../../apps/connector-desktop/src/app/notify.ts';

function fakeApp(state: { openAtLogin?: boolean; wasOpenedAtLogin?: boolean } = {}) {
  const set: LoginItemSettingsInput[] = [];
  return { set, setLoginItemSettings: (value: LoginItemSettingsInput) => { set.push(value); }, getLoginItemSettings: () => ({ openAtLogin: state.openAtLogin ?? false, wasOpenedAtLogin: state.wasOpenedAtLogin }) };
}

test('login item: SMAppService on macOS 13+, hidden legacy item before, --background on Windows', () => {
  assert.equal(usesMainAppService('darwin', '22.1.0'), true);
  assert.equal(usesMainAppService('darwin', '21.6.0'), false);
  assert.deepEqual(loginItemSettings('darwin', '24.4.0', true), { openAtLogin: true, type: 'mainAppService' });
  assert.deepEqual(loginItemSettings('darwin', '21.6.0', true), { openAtLogin: true, openAsHidden: true });
  assert.deepEqual(loginItemSettings('win32', '10.0.26100', true, 'C:\\SmartSell Worker.exe'), { openAtLogin: true, args: ['--background'], path: 'C:\\SmartSell Worker.exe' });
  assert.deepEqual(loginItemSettings('win32', '10.0', false), { openAtLogin: false, args: ['--background'] });
});

test('SMARTSELL_NO_LOGIN_ITEM=1 never touches the real login item; otherwise the setting is applied', () => {
  const app = fakeApp();
  const logs: string[] = [];
  assert.equal(new Autostart(app, { platform: 'darwin', osRelease: '24.0.0', env: { SMARTSELL_NO_LOGIN_ITEM: '1' }, log: message => logs.push(message) }).set(true), false);
  assert.equal(app.set.length, 0);
  assert.match(logs[0], /suppressed/);
  assert.equal(new Autostart(app, { platform: 'darwin', osRelease: '24.0.0', env: {} }).set(true), true);
  assert.deepEqual(app.set, [{ openAtLogin: true, type: 'mainAppService' }]);
  assert.equal(new Autostart(app, { platform: 'linux', osRelease: '6', env: {} }).set(true), false);
});

test('background start: --background, wasOpenedAtLogin, or an SMAppService login item right after boot', () => {
  assert.equal(new Autostart(fakeApp(), { platform: 'win32', osRelease: '10' }).startedInBackground(['app.exe', '--background'], 9999), true);
  assert.equal(new Autostart(fakeApp({ wasOpenedAtLogin: true }), { platform: 'darwin', osRelease: '21.0.0' }).startedInBackground(['app'], 9999), true);
  assert.equal(new Autostart(fakeApp({ openAtLogin: true }), { platform: 'darwin', osRelease: '24.0.0' }).startedInBackground(['app'], 60), true);
  assert.equal(new Autostart(fakeApp({ openAtLogin: true }), { platform: 'darwin', osRelease: '24.0.0' }).startedInBackground(['app'], 3600), false);
  assert.equal(new Autostart(fakeApp(), { platform: 'darwin', osRelease: '24.0.0' }).startedInBackground(['app'], 60), false);
});

test('tray: red when the vault is locked or the machine revoked, badge for an update, countdown while reconnecting', () => {
  const base = { role: 'worker' as const, machineName: 'Mac-B', jobs: 0, needsOwner: 0, emergencyStop: false, updateVersion: null };
  assert.equal(trayModel({ ...base, connection: 'online' }).tone, 'ok');
  const locked = trayModel({ ...base, connection: 'vault_locked' });
  assert.equal(locked.tone, 'error');
  assert.match(locked.items[0].label, /鑰匙圈/);
  assert.equal(trayModel({ ...base, connection: 'device_revoked' }).tone, 'error');
  const now = Date.parse('2026-11-24T10:00:00Z');
  assert.match(trayModel({ ...base, connection: 'reconnecting', nextRetryAt: '2026-11-24T10:00:08Z', now }).items[0].label, /8 秒後重試/);
  const update = trayModel({ ...base, connection: 'online', updateVersion: '0.2.1' });
  assert.equal(update.badge, true);
  assert.ok(update.items.some(item => item.id === 'update' && item.label.includes('0.2.1')));
  assert.equal(trayPixels('ok', true).template, false, 'a coloured badge is not a template image');
  assert.equal(trayPixels('ok', false).template, true);
  const stopped = trayModel({ ...base, connection: 'online', emergencyStop: true, jobs: 2, needsOwner: 1 });
  assert.ok(stopped.items.some(item => item.id === 'resume'));
  assert.match(stopped.items[1].label, /1 則要你處理/);
  assert.equal(trayModel({ ...base, role: 'agent', connection: 'agent_unauthorized' }).tone, 'error');
});

test('notifier: one notification per key, history of 20, only https or loopback links are opened', () => {
  const shown: string[] = [];
  const notifier = new Notifier({ supported: () => true, open: () => {}, create: options => ({ show() { shown.push(options.title); }, on() {} }) });
  assert.equal(notifier.notify({ title: 'a', body: 'b', key: 'k' }), true);
  assert.equal(notifier.notify({ title: 'a', body: 'b', key: 'k' }), false);
  notifier.reset('k');
  assert.equal(notifier.notify({ title: 'a', body: 'b', key: 'k' }), true);
  for (let index = 0; index < 30; index++) notifier.notify({ title: `n${index}`, body: '' });
  assert.equal(notifier.history().length, 20);
  assert.equal(safeWebUrl('javascript:alert(1)'), null);
  assert.equal(safeWebUrl('http://evil.example/x'), null);
  assert.equal(safeWebUrl('https://hub.tail1234.ts.net/app/w'), 'https://hub.tail1234.ts.net/app/w');
  const unsupported = new Notifier({ supported: () => false, open: () => {}, create: () => assert.fail('no OS notifications here') });
  assert.equal(unsupported.notify({ title: 'x', body: 'y' }), false);
  assert.equal(unsupported.history().length, 1, 'still listed in the window');
});
