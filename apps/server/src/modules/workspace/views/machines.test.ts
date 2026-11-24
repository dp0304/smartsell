import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { bumpSyncGeneration } from '../../worker/model.js';
import { viewWorld } from './hub-fixture.js';
import { WEB_URL_KINDS, webPath, webUrl } from './links.js';
import { machineDetail, machineSummaries, machineWarnings } from './machines.js';

test('machine warnings: sleep, auto login, clock skew, outdated driver and sync_behind (zh-Hant for the web, en for the Agent)', () => {
  const w = viewWorld();
  w.set('connector_device', w.device.id, { posture: { os: 'darwin', os_version: '15.1', sleep_idle_min: 10, on_battery: false, auto_login: 'off', filevault: 'on', power_plan_sleep_min: null },
    clock_offset_ms: 45_000, drivers: [{ provider: 'x', version: 'x@2026.11.1', health: 'outdated', step: 'compose' }] });
  const device = () => w.ctx.get('connector_device', w.device.id);
  assert.deepEqual(machineWarnings(w.ctx, device()).map(warning => warning.code), ['sleep_enabled', 'no_auto_login', 'clock_skew', 'driver_outdated']);
  assert.deepEqual(machineWarnings(w.ctx, device()).map(warning => warning.message), [
    'Mac-B 閒置 10 分鐘會睡眠。Worker 持有排程時會阻止閒置睡眠，但闔上螢幕或手動睡眠仍會錯過。',
    'Mac-B 重開機後要有人登入，Worker 才會啟動（FileVault 已開啟）。',
    'Mac-B 的時鐘差了 45 秒。',
    'X 的頁面可能改版（在「compose」找不到元素）。',
  ]);
  assert.equal(machineWarnings(w.ctx, device(), 'en')[0].message, 'Mac-B sleeps after 10 min idle.');
  // sync_behind needs the live presence: the hub knows what the machine applied only from its heartbeat.
  w.presence.set(w.device.id, { applied_sync_generation: 0, last_seen_at: '2026-11-24T11:58:00.000Z' });
  bumpSyncGeneration(w.ctx, [w.device.id], 'settings_changed');
  assert.equal(machineWarnings(w.ctx, device()).some(warning => warning.code === 'sync_behind'), false, 'within one minute it is just the next heartbeat');
  w.advance(90_000);
  const behind = machineWarnings(w.ctx, device()).find(warning => warning.code === 'sync_behind');
  assert.equal(behind?.message, 'Mac-B 還沒收到你 12:00 的變更（最後連線 11:58）。');
  w.presence.set(w.device.id, { applied_sync_generation: 99 });
  assert.equal(machineWarnings(w.ctx, device()).some(warning => warning.code === 'sync_behind'), false);
});

test('machine summary and detail: channels, queue, next job, history and online state from presence', async () => {
  const w = viewWorld();
  const first = await w.schedule('2026-11-24T13:00:00.000Z');
  await w.schedule('2026-11-24T15:00:00.000Z');
  w.claim();
  const [mac, win] = machineSummaries(w.ctx);
  assert.deepEqual([mac.name, mac.online, mac.channels.map(row => [row.handle, row.login]), mac.queue], ['Mac-B', true, [['lurelab', 'verified']], { queued: 0, ready: 2, running: 0, needs_owner: 0 }]);
  assert.deepEqual([mac.next_job?.post_id, mac.next_job?.local_time], [first.id, '2026-11-24 13:00']);
  assert.deepEqual([win.name, win.channels.map(row => row.provider)], ['Win-C', ['tiktok']]);
  const detail = machineDetail(w.ctx, w.device.id);
  assert.equal(detail.upcoming.length, 2);
  assert.equal(detail.upcoming[0].web_url, webUrl(w.ctx, 'post', first.id));
  w.set('connector_device', w.device.id, { last_seen_at: '2026-11-24T11:00:00.000Z' });
  assert.equal(machineSummaries(w.ctx)[0].online, false);
  w.presence.set(w.device.id, { last_seen_at: w.ctx.now });
  assert.equal(machineSummaries(w.ctx)[0].online, true, 'In-memory presence wins over the 5-minute row write (§2.10)');
  w.set('connector_device', w.device.id, { paused: true });
  assert.equal(machineSummaries(w.ctx)[0].online, false);
  assert.deepEqual(machineSummaries(w.ctx, { includeOffline: false }).map(row => row.name), ['Win-C']);
  assert.throws(() => machineDetail(w.ctx, 'nope'), (error: { status?: number }) => error.status === 404);
});

test('every web_url kind maps to a route that routes.tsx defines (not the catch-all redirect)', () => {
  const source = readFileSync(new URL('../../../../../web/src/view/routes.tsx', import.meta.url), 'utf8');
  const routes = [...source.matchAll(/<Route\s+(?:index|path="([^"]+)")/g)].map(match => match[1] ?? '');
  const matches = (path: string) => routes.some(route => {
    const pattern = new RegExp(`^${route.split('/').map(part => part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/')}$`);
    return route !== '*' && pattern.test(path);
  });
  for (const kind of WEB_URL_KINDS) {
    const path = webPath(kind, '5b1e2c3d-4f5a-4b6c-8d7e-9f0a1b2c3d4e', '2026-11-23').split('?')[0].replace(/^\//, '');
    assert.ok(matches(path), `${kind} → /${path} must be a defined route`);
  }
  const w = viewWorld();
  assert.equal(webUrl(w.ctx, 'calendar'), `https://hub.example.ts.net/app/${w.ctx.workspaceId}/calendar?view=week&week=2026-11-23`);
});
