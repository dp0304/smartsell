// §10.1 S9: power.ts holds and releases the blocker from the held jobs; posture detection from fake pmset,
// fdesetup and powercfg output.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PowerGuard } from '../../../apps/connector-desktop/src/app/power.ts';
import {
  parseFdesetup, parseMacAutoLogin, parsePmsetBattery, parsePmsetSleep, parsePowercfgSleepMin, parseRdpEnabled, parseTailscaleDnsName, parseVncListening,
  parseWindowsAutoLogin, postureAdvice, PostureMonitor, readPosture, type Run,
} from '../../../apps/connector-desktop/src/app/posture.ts';
import { RuntimeEventBus } from '../../../apps/connector-desktop/src/runtime/events.ts';

function fakeBlocker() {
  let next = 1;
  const started = new Set<number>();
  const log: string[] = [];
  return {
    log, started,
    start(type: string) { const id = next++; started.add(id); log.push(`start:${type}:${id}`); return id; },
    stop(id: number) { started.delete(id); log.push(`stop:${id}`); },
    isStarted(id: number) { return started.has(id); },
  };
}

test('power: C11 jobs_held acquires prevent-app-suspension while publish jobs are held and releases it at zero', () => {
  const blocker = fakeBlocker();
  const guard = new PowerGuard(blocker);
  const events = new RuntimeEventBus();
  events.on('jobs_held', event => guard.onJobsHeld(event));
  events.emitJobsHeld({ publish_jobs: 0, next_due_at: null });
  assert.equal(guard.active(), false);
  events.emitJobsHeld({ publish_jobs: 2, next_due_at: '2026-11-25T01:00:00.000Z' });
  assert.equal(guard.active(), true);
  assert.deepEqual(blocker.log, ['start:prevent-app-suspension:1']);
  events.emitJobsHeld({ publish_jobs: 1, next_due_at: '2026-11-25T01:00:00.000Z' });
  assert.equal(blocker.log.length, 1, 'still held: no second blocker');
  // A handed-off upload keeps it held after the last job ends.
  guard.hold('upload:u1', true);
  events.emitJobsHeld({ publish_jobs: 0, next_due_at: null });
  assert.equal(guard.active(), true);
  assert.deepEqual(guard.reasons(), ['upload:u1']);
  guard.hold('upload:u1', false);
  assert.equal(guard.active(), false);
  assert.deepEqual(blocker.log, ['start:prevent-app-suspension:1', 'stop:1']);
  guard.hold('publish_jobs', true);
  guard.release();
  assert.equal(guard.active(), false);
});

const PMSET = `System-wide power settings:
Currently in use:
 standby              1
 Sleep On Power Button 1
 hibernatefile        /var/vm/sleepimage
 powernap             1
 networkoversleep     0
 disksleep            10
 sleep                1 (sleep prevented by coreaudiod)
 hibernatemode        3
 ttyskeepawake        1
 displaysleep         10
 tcpkeepalive         1
 lowpowermode         0
 womp                 1
`;
const POWERCFG = `Power Scheme GUID: 381b4222-f694-41f0-9685-ff5bb260df2e  (Balanced)
  Subgroup GUID: 238c9fa8-0aad-41ed-83f4-97be242c8f20  (Sleep)
    Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Sleep after)
      Minimum Possible Setting: 0x00000000
      Maximum Possible Setting: 0xffffffff
      Possible Settings increment: 0x00000001
      Possible Settings units: Seconds
    Current AC Power Setting Index: 0x00000708
    Current DC Power Setting Index: 0x00000384
`;
const POWERCFG_ZH = POWERCFG.replace('Current AC Power Setting Index', '目前的 AC 電源設定索引').replace('Current DC Power Setting Index', '目前的 DC 電源設定索引');

test('posture parsers: pmset, fdesetup, loginwindow, powercfg (English and localized), reg, netstat, tailscale', () => {
  assert.equal(parsePmsetSleep(PMSET), 1);
  assert.equal(parsePmsetSleep(PMSET.replace(' sleep                1', ' sleep                0')), 0);
  assert.equal(parsePmsetSleep('garbage'), null);
  assert.equal(parsePmsetBattery("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t80%; discharging"), true);
  assert.equal(parsePmsetBattery("Now drawing from 'AC Power'"), false);
  assert.equal(parseFdesetup('FileVault is On.\n'), 'on');
  assert.equal(parseFdesetup('FileVault is Off.\n'), 'off');
  assert.equal(parseFdesetup(''), 'unknown');
  assert.equal(parseMacAutoLogin({ code: 0, stdout: 'owner\n', stderr: '' }), 'on');
  assert.equal(parseMacAutoLogin({ code: 1, stdout: '', stderr: 'The domain/default pair of (/Library/Preferences/com.apple.loginwindow, autoLoginUser) does not exist' }), 'off');
  assert.equal(parsePowercfgSleepMin(POWERCFG), 30);
  assert.equal(parsePowercfgSleepMin(POWERCFG_ZH), 30, 'localized labels: AC is the second-to-last value');
  assert.equal(parsePowercfgSleepMin(POWERCFG.replace('0x00000708', '0x00000000')), 0);
  assert.equal(parseWindowsAutoLogin({ code: 0, stdout: '\r\nHKEY_LOCAL_MACHINE\\...\\Winlogon\r\n    AutoAdminLogon    REG_SZ    1\r\n', stderr: '' }), 'on');
  assert.equal(parseWindowsAutoLogin({ code: 0, stdout: '    AutoAdminLogon    REG_SZ    0\r\n', stderr: '' }), 'off');
  assert.equal(parseWindowsAutoLogin({ code: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' }), 'off');
  assert.equal(parseRdpEnabled({ code: 0, stdout: '    fDenyTSConnections    REG_DWORD    0x0\r\n', stderr: '' }), true);
  assert.equal(parseRdpEnabled({ code: 0, stdout: '    fDenyTSConnections    REG_DWORD    0x1\r\n', stderr: '' }), false);
  assert.equal(parseVncListening('tcp4       0      0  *.5900                 *.*                    LISTEN\n'), true);
  assert.equal(parseVncListening('tcp4       0      0  127.0.0.1.5432         *.*                    LISTEN\n'), false);
  assert.equal(parseTailscaleDnsName(JSON.stringify({ Self: { DNSName: 'mac-b.tail1234.ts.net.' } })), 'mac-b.tail1234.ts.net');
});

function fakeRun(outputs: Record<string, { code?: number; stdout?: string; stderr?: string }>): Run & { calls: string[] } {
  const calls: string[] = [];
  const run = (async (file: string, args: string[]) => {
    const line = [file, ...args].join(' ');
    calls.push(line);
    const hit = Object.entries(outputs).find(([prefix]) => line.startsWith(prefix));
    return { code: 0, stdout: '', stderr: '', ...(hit ? hit[1] : { code: 127 }) };
  }) as Run & { calls: string[] };
  run.calls = calls;
  return run;
}

test('posture on macOS: sleep, battery, FileVault forces no auto-login, Screen Sharing gives a vnc:// host', async () => {
  const run = fakeRun({
    '/usr/bin/pmset -g': { stdout: PMSET }, '/usr/bin/fdesetup status': { stdout: 'FileVault is On.' },
    '/usr/bin/defaults read': { stdout: 'owner\n' }, '/usr/bin/sw_vers': { stdout: '15.4.1\n' },
    '/usr/sbin/netstat': { stdout: 'tcp6  0  0  *.5900  *.*  LISTEN\n' },
    tailscale: { stdout: JSON.stringify({ Self: { DNSName: 'mac-b.tail1234.ts.net.' } }) },
  });
  const { posture, remote } = await readPosture({ platform: 'darwin', run, onBattery: () => false, osRelease: '24.4.0' });
  assert.deepEqual(posture, { os: 'darwin', os_version: '15.4.1', sleep_idle_min: 1, on_battery: false, auto_login: 'off', filevault: 'on', power_plan_sleep_min: null });
  assert.deepEqual(remote, { kind: 'vnc', host: 'mac-b.tail1234.ts.net' });
  assert.ok(run.calls.every(call => !/\b(sudo|-a|set|write|enable)\b/.test(call.split(' ').slice(1).join(' ')) || call.includes('defaults read')), 'read-only commands only');
  const codes = postureAdvice(posture, remote).map(item => item.code);
  assert.deepEqual(codes, ['sleep_enabled', 'no_auto_login', 'remote_access']);
  assert.match(postureAdvice(posture, remote)[1].text, /FileVault 已開啟/);
});

test('posture on Windows: powercfg sleep, AutoAdminLogon, Remote Desktop → rdp host; the monitor serves the last reading synchronously', async () => {
  const run = fakeRun({
    'powercfg /query': { stdout: POWERCFG }, 'reg query HKLM\\SOFTWARE': { stdout: '    AutoAdminLogon    REG_SZ    1\r\n' },
    'reg query HKLM\\SYSTEM': { stdout: '    fDenyTSConnections    REG_DWORD    0x0\r\n' },
  });
  const monitor = new PostureMonitor({ platform: 'win32', run, osRelease: '10.0.26100', onBattery: () => true, hostname: () => 'WIN-C', tailscalePaths: [] });
  assert.equal(monitor.current(), null, 'nothing until the first read');
  await monitor.refresh();
  assert.deepEqual(monitor.current(), { os: 'win32', os_version: '10.0.26100', sleep_idle_min: null, on_battery: true, auto_login: 'on', filevault: 'n/a', power_plan_sleep_min: 30 });
  assert.deepEqual(monitor.remote(), { kind: 'rdp', host: 'WIN-C' });
  assert.deepEqual(postureAdvice(monitor.current(), null).map(item => item.code), ['sleep_enabled', 'on_battery']);
  const off = await readPosture({ platform: 'win32', run: fakeRun({ 'powercfg /query': { stdout: POWERCFG.replace('0x00000708', '0x00000000') } }), onBattery: () => false });
  assert.equal(off.posture?.power_plan_sleep_min, 0);
  assert.equal(off.posture?.auto_login, 'off');
  assert.equal(off.remote, null);
});
