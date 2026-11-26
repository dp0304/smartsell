import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { compareWorkerVersions, inspectWorkerRelease } from '../worker-downloads.js';
import { doctorMain, parsePmset, parsePowercfgStandby, runDoctor } from './doctor.js';
import type { Exec, ExecResult } from './exec.js';
import { exportLegacy, exportLegacyMain, exportSnapshot } from './export-legacy.js';
import { readHubEnvFile } from './hub-env.js';
import { hubInit, setupUrl, webDistFresh } from './init.js';
import { placeSelectors, restartCommands, stopStartCommands, updateMain } from './update.js';

const ORIGIN = 'https://hub.tail1234.ts.net';
const hex = () => randomBytes(32).toString('hex');

function temp(t: TestContext, prefix = 'smartsell-tools-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const statusJson = (state = 'Running', dns = 'hub.tail1234.ts.net.', keyExpiry?: string) =>
  JSON.stringify({ BackendState: state, CertDomains: dns ? [dns.replace(/\.$/, '')] : [], Self: { DNSName: dns, HostName: 'hub', ...(keyExpiry ? { KeyExpiry: keyExpiry } : {}) } });
const serveJson = (port = 3401) => JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { 'hub.tail1234.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } } } });

/** A scripted exec: first matching prefix wins; every call is recorded; nothing real is ever run. */
function scripted(rules: [string, Partial<ExecResult>][]) {
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    const line = [file, ...args].join(' ');
    calls.push(line);
    const rule = rules.find(([fragment]) => line.includes(fragment));
    return { code: 0, stdout: '', stderr: '', ...(rule ? rule[1] : { code: -1, error: 'ENOENT' }) };
  };
  return { exec, calls };
}

// ---------- hub:init (§2.5) ----------

test('hub:init configures tailscale serve, writes hub.env 0600 once, and prints the first-run URL', async t => {
  const hubDir = join(temp(t), 'SmartSell Hub');
  const lines: string[] = [];
  const { exec, calls } = scripted([
    ['/fake/tailscale status --json', { stdout: statusJson('Running', 'hub.tail1234.ts.net.', '2026-12-01T00:00:00Z') }],
    ['/fake/tailscale serve --bg --https=443 http://127.0.0.1:3401', { code: 0 }],
    ['/fake/tailscale serve status --json', { stdout: serveJson() }],
  ]);
  const deps = { env: { SMARTSELL_TAILSCALE_CLI: '/fake/tailscale' }, platform: 'darwin' as const, exec, log: (line: string) => lines.push(line),
    exists: (path: string) => path === '/fake/tailscale', now: () => new Date('2026-11-24T00:00:00Z'),
    ask: async () => { throw new Error('no questions expected'); } };
  const result = await hubInit({ hubDir, skipWebBuild: true, workerRelease: false, service: false }, deps);
  assert.equal(result.ok, true, lines.join('\n'));
  assert.equal(result.publicOrigin, ORIGIN);
  const env = readHubEnvFile(hubDir).values;
  assert.match(env.APP_SECRET!, /^[0-9a-f]{64}$/);
  assert.match(env.SETUP_TOKEN!, /^[0-9a-f]{64}$/);
  assert.notEqual(env.APP_SECRET, env.SETUP_TOKEN);
  assert.equal(env.PUBLIC_ORIGIN, ORIGIN);
  assert.equal(env.PORT, '3401');
  assert.equal(statSync(join(hubDir, 'hub.env')).mode & 0o777, 0o600);
  assert.equal(statSync(hubDir).mode & 0o777, 0o700);
  assert.equal(result.setupUrl, `${ORIGIN}/setup#setup-token=${env.SETUP_TOKEN}`);
  assert.equal(lines.at(-1), result.setupUrl);
  assert.ok(calls.includes('/fake/tailscale serve --bg --https=443 http://127.0.0.1:3401'));
  const text = lines.join('\n');
  assert.match(text, /Disable key expiry/);
  assert.match(text, /2026-12-01.*剩 7 天/);
  assert.match(text, /Windows 安裝包只能在 Windows 機器上建置/);
  assert.doesNotMatch(text, /憑證透明度/, 'a neutral name needs no certificate-transparency reminder');

  // Re-running keeps every existing value.
  const again = await hubInit({ hubDir, skipWebBuild: true, workerRelease: false, service: false }, { ...deps, log: () => {} });
  assert.deepEqual(readHubEnvFile(hubDir).values, env);
  assert.equal(again.setupUrl, result.setupUrl);
});

test('hub:init stops with the right instruction when Tailscale is not ready', async t => {
  const hubDir = temp(t);
  const run = async (rules: [string, Partial<ExecResult>][], answer = false) => {
    const lines: string[] = [];
    const { exec } = scripted(rules);
    const result = await hubInit({ hubDir, skipWebBuild: true, workerRelease: false, service: false }, {
      env: { SMARTSELL_TAILSCALE_CLI: '/fake/ts' }, platform: 'darwin', exec, exists: path => path === '/fake/ts',
      log: line => lines.push(line), ask: async () => answer });
    return { result, text: lines.join('\n') };
  };
  const loggedOut = await run([['/fake/ts status', { code: 1, stdout: statusJson('NeedsLogin', '') }]]);
  assert.equal(loggedOut.result.ok, false);
  assert.match(loggedOut.text, /NeedsLogin/);
  const noHttps = await run([['/fake/ts status', { stdout: statusJson() }], ['/fake/ts serve --bg', { code: 1, stderr: 'HTTPS is not enabled for this tailnet' }]]);
  assert.equal(noHttps.result.ok, false);
  assert.match(noHttps.text, /請到 Tailscale 管理後台 → DNS → 啟用 MagicDNS 與 HTTPS Certificates，然後重跑 pnpm hub:init/);
  const personal = await run([['/fake/ts status', { stdout: statusJson('Running', 'johns-macbook-pro.tail1234.ts.net.') }]], false);
  assert.equal(personal.result.ok, false);
  assert.match(personal.text, /憑證透明度/);
  assert.match(personal.text, /hub/);
  const unverified = await run([['/fake/ts status', { stdout: statusJson() }], ['/fake/ts serve --bg', { code: 0 }], ['/fake/ts serve status', { stdout: '{}' }]]);
  assert.equal(unverified.result.ok, false);
  assert.match(unverified.text, /沒有把 443 轉送到/);
  assert.equal(existsSync(join(hubDir, 'hub.env')), false, 'nothing is written before tailscale serve is confirmed');
  const notInstalled = await hubInit({ hubDir, skipWebBuild: true }, { env: {}, platform: 'darwin', exec: scripted([]).exec, exists: () => false, log: () => {} });
  assert.match(notInstalled.message!, /找不到 Tailscale/);
});

test('hub:init runs the Web build, worker:release and service install through exec', async t => {
  const hubDir = temp(t);
  const repo = temp(t, 'smartsell-repo-');
  const { exec, calls } = scripted([
    ['/fake/ts status', { stdout: statusJson() }], ['/fake/ts serve --bg', { code: 0 }], ['/fake/ts serve status', { stdout: serveJson() }],
    ['pnpm --filter @smartsell/web build', { code: 0 }], ['pnpm worker:release', { code: 1 }], ['scripts/hub-service.mjs install', { code: 0 }],
  ]);
  const lines: string[] = [];
  const result = await hubInit({ hubDir }, { env: { SMARTSELL_TAILSCALE_CLI: '/fake/ts' }, platform: 'darwin', exec, repoRoot: repo,
    exists: path => path === '/fake/ts', log: line => lines.push(line), ask: async () => true });
  assert.equal(result.ok, true);
  assert.ok(calls.includes('pnpm --filter @smartsell/web build'));
  assert.ok(calls.includes(`pnpm worker:release --out ${join(hubDir, 'worker-downloads')}`));
  assert.ok(calls.some(line => line.endsWith(`scripts/hub-service.mjs install --hub-dir ${hubDir}`)));
  assert.match(lines.join('\n'), /Worker 安裝包建置失敗/, 'a failed worker:release is reported, not hidden');
  assert.equal(setupUrl('https://a.ts.net', 'x'), 'https://a.ts.net/setup#setup-token=x');
});

test('webDistFresh compares dist/index.html with the Web sources', t => {
  const repo = temp(t);
  mkdirSync(join(repo, 'apps/web/src'), { recursive: true });
  writeFileSync(join(repo, 'apps/web/src/main.tsx'), 'x');
  assert.equal(webDistFresh(repo), false);
  mkdirSync(join(repo, 'apps/web/dist'), { recursive: true });
  writeFileSync(join(repo, 'apps/web/dist/index.html'), 'x');
  const future = new Date(Date.now() + 60_000);
  utimesSync(join(repo, 'apps/web/dist/index.html'), future, future);
  assert.equal(webDistFresh(repo), true);
  const later = new Date(Date.now() + 120_000);
  utimesSync(join(repo, 'apps/web/src/main.tsx'), later, later);
  assert.equal(webDistFresh(repo), false);
});

// ---------- hub:doctor (§2.13) ----------

test('hub:doctor prints one actionable line per problem and exits 1 on errors', async t => {
  const hubDir = temp(t);
  chmodSync(hubDir, 0o700);
  const dist = join(hubDir, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), 'x');
  writeFileSync(join(hubDir, 'hub.env'), `APP_SECRET=${hex()}\nPUBLIC_ORIGIN=${ORIGIN}\nSMARTSELL_WEB_DIST=${dist}\n`, { mode: 0o600 });
  writeFileSync(join(hubDir, 'status.json'), JSON.stringify({ state: 'config_error', message: 'PUBLIC_ORIGIN 必須是 https', at: '2026-11-24T01:00:00Z' }));
  mkdirSync(join(hubDir, 'worker-downloads'));
  const armManifest = { version: '0.2.0', platform: 'mac-arm64', file: 'SmartSell-Worker-0.2.0-arm64.dmg', sha256: 'b'.repeat(64), bytes: 10,
    built_at: '2026-11-24T00:00:00Z' };
  writeFileSync(join(hubDir, 'worker-downloads', 'latest-mac-arm64.json'), JSON.stringify({ ...armManifest, signature: `${'A'.repeat(85)}w==` }));
  writeFileSync(join(hubDir, 'worker-downloads', 'latest-win-x64.json'), '{"version":"x"}');
  const cli = join(hubDir, 'fake-tailscale');
  writeFileSync(cli, '');   // only its existence matters: every call goes through the scripted exec
  const { exec } = scripted([
    ['ffprobe -version', { code: -1, error: 'ENOENT' }],
    [`${cli} status`, { stdout: statusJson('Running', 'hub.tail1234.ts.net.', '2026-12-10T00:00:00Z') }],
    [`${cli} serve status`, { stdout: serveJson() }],
    ['fdesetup status', { stdout: 'FileVault is On.' }],
    ['defaults read', { code: 1 }],
    ['pmset -g', { stdout: 'System-wide power settings:\nCurrently in use:\n standby              1\n sleep                10 (sleep prevented by x)\n disksleep            10\n' }],
    ['launchctl print', { code: 113 }],
  ]);
  let lines: string[] = [];
  const doctor = () => doctorMain(['--hub-dir', hubDir], { exec, platform: 'darwin', env: { SMARTSELL_TAILSCALE_CLI: cli }, home: join(hubDir, 'home'),
    uid: 501, fetch: (async () => { throw new Error('offline'); }) as unknown as typeof fetch, now: () => new Date('2026-11-24T00:00:00Z'),
    freeBytes: () => 4 * 1024 ** 3, log: line => lines.push(line) });
  const code = await doctor();
  assert.equal(code, 1);
  const text = lines.join('\n');
  for (const expected of [
    /\[錯誤\] 狀態檔：設定錯誤，未啟動.*PUBLIC_ORIGIN 必須是 https/,
    /\[錯誤\] 中樞沒有回應 http:\/\/127\.0\.0\.1:3401\/readyz/,
    /\[警告\] 找不到 ffprobe.*brew install ffmpeg/,
    /\[OK\] tailscale serve：443 → http:\/\/127\.0\.0\.1:3401/,
    /\[警告\] 中樞的 Tailscale 節點金鑰將在 2026-12-10 到期（剩 16 天）/,
    /\[警告\] FileVault 已開啟/,
    /\[警告\] 模式一（agent）要等使用者登入後才會啟動/,
    /\[警告\] 中樞會在閒置 10 分鐘後睡眠。.*sudo pmset -c sleep 0 disksleep 0/,
    /\[警告\] 中樞磁碟只剩 4\.0 GB/,
    /\[OK\] Worker 安裝包 mac-arm64：0\.2\.0（SmartSell-Worker-0\.2\.0-arm64\.dmg，已簽章）/,
    /\[警告\] 沒有 mac-x64 的 Worker 安裝包/,
    /\[錯誤\] latest-win-x64\.json 不正確/,
    /\[OK\] HTTPS 憑證已啟用/,
    /\[警告\] 沒有安裝 launchd 服務/,
  ]) assert.match(text, expected);
  for (const line of lines) assert.match(line, /^\[(?:OK|警告|錯誤)\] |^有 \d+ 個錯誤|^沒有錯誤|^全部正常/);
  // S1: a manifest without a release signature is a warning — Workers with a built-in release key refuse it.
  writeFileSync(join(hubDir, 'worker-downloads', 'latest-mac-arm64.json'), JSON.stringify(armManifest));
  lines = [];
  await doctor();
  assert.match(lines.join('\n'), /\[警告\] Worker 安裝包 mac-arm64：0\.2\.0 沒有發行簽章.*pnpm worker:release/);
});

test('hub:doctor on Windows reads powercfg and the task trigger', async t => {
  const hubDir = temp(t);
  const { exec } = scripted([
    ['powercfg', { stdout: 'Power Setting GUID: 29f6c1db\n    Current AC Power Setting Index: 0x00000708\n    Current DC Power Setting Index: 0x00000384\n' }],
    ['schtasks /Query /TN SmartSell Hub /XML', { stdout: '<Task><Triggers><LogonTrigger/></Triggers></Task>' }],
    ['schtasks /Query', { stdout: 'TaskName: \\SmartSell Hub\nStatus: Running\n' }],
  ]);
  const lines = await runDoctor(['--hub-dir', hubDir], { exec, platform: 'win32', env: { LOCALAPPDATA: hubDir }, home: hubDir, uid: 0,
    fetch: (async () => new Response('{}')) as typeof fetch, freeBytes: () => 50 * 1024 ** 3 });
  const text = lines.map(line => `${line.level} ${line.text}`).join('\n');
  assert.match(text, /warn 中樞接上電源時會在閒置 30 分鐘後睡眠/);
  assert.match(text, /warn 排程工作以登入觸發/);
  assert.match(text, /ok 排程工作「SmartSell Hub」：Running/);
  assert.equal(parsePowercfgStandby('Current AC Power Setting Index: 0x00000000'), 0);
  assert.deepEqual(parsePmset(' sleep                0\n disksleep            0\n'), { sleep: 0, disksleep: 0 });
});

test('hub:doctor: a public Funnel is an error; backup age; a removed Homebrew node in the plist; a Windows task without the supervisor', async t => {
  const hubDir = temp(t);
  chmodSync(hubDir, 0o700);
  const dist = join(hubDir, 'dist');
  mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), 'x');
  writeFileSync(join(hubDir, 'hub.env'), `APP_SECRET=${hex()}\nPUBLIC_ORIGIN=${ORIGIN}\nSMARTSELL_WEB_DIST=${dist}\n`, { mode: 0o600 });
  const cli = join(hubDir, 'fake-tailscale');
  writeFileSync(cli, '');
  const home = join(hubDir, 'home');
  mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
  const keg = '/opt/homebrew/Cellar/node@24/24.11.0/bin/node';
  writeFileSync(join(home, 'Library/LaunchAgents/com.smartsell.hub.plist'), `<plist><dict><key>ProgramArguments</key><array><string>${keg}</string></array></dict></plist>`);
  mkdirSync(join(hubDir, 'backups'), { mode: 0o700 });
  const old = join(hubDir, 'backups', 'smartsell-2026-11-20.sqlite');
  writeFileSync(old, '');
  utimesSync(old, new Date('2026-11-20T00:00:00Z'), new Date('2026-11-20T00:00:00Z'));
  const funnel = JSON.stringify({ ...JSON.parse(serveJson()), AllowFunnel: { 'hub.tail1234.ts.net:443': true } });
  const { exec } = scripted([
    [`${cli} status`, { stdout: statusJson() }], [`${cli} serve status`, { stdout: funnel }], ['fdesetup status', { stdout: 'FileVault is Off.' }],
    ['defaults read', { stdout: 'owner\n' }], ['pmset -g', { stdout: ' sleep 0\n disksleep 0\n' }], ['launchctl print', { stdout: 'state = running\n' }], ['ffprobe', { code: 0 }],
  ]);
  const doctor = (now: string) => runDoctor(['--hub-dir', hubDir], { exec, platform: 'darwin', env: { SMARTSELL_TAILSCALE_CLI: cli }, home, uid: 501,
    fetch: (async () => new Response('{}')) as typeof fetch, now: () => new Date(now), freeBytes: () => 50 * 1024 ** 3,
    exists: path => path !== keg && existsSync(path) });
  const text = (await doctor('2026-11-24T00:00:00Z')).map(line => `${line.level} ${line.text}`).join('\n');
  assert.match(text, /error 中樞被 Tailscale Funnel 公開到網際網路（https:\/\/hub\.tail1234\.ts\.net）.*tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:3401/);
  assert.match(text, /error 中樞服務設定檔 .*com\.smartsell\.hub\.plist 指向的 Node（\/opt\/homebrew\/Cellar\/node@24\/24\.11\.0\/bin\/node）已不存在/);
  assert.match(text, /warn 最新的資料備份是 96 小時前/);
  writeFileSync(join(hubDir, 'backups', 'smartsell-2026-11-24.sqlite'), '');
  assert.match((await doctor(new Date(Date.now() + 3_660_000).toISOString())).map(line => `${line.level} ${line.text}`).join('\n'), /ok 最新的資料備份：.*smartsell-2026-11-24\.sqlite（1 小時前）/);
  rmSync(join(hubDir, 'backups'), { recursive: true });
  assert.match((await doctor('2026-11-24T00:00:00Z')).map(line => `${line.level} ${line.text}`).join('\n'), /warn 還沒有資料備份/);

  const windows = (xml: string) => runDoctor(['--hub-dir', hubDir], { exec: scripted([['schtasks /Query /TN SmartSell Hub /XML', { stdout: xml }],
    ['schtasks /Query', { stdout: 'Status: Running\n' }], ['powercfg', { stdout: 'Current AC Power Setting Index: 0x00000000' }]]).exec,
  platform: 'win32', env: { LOCALAPPDATA: hubDir }, home: hubDir, uid: 0, fetch: (async () => new Response('{}')) as typeof fetch, freeBytes: () => 50 * 1024 ** 3 });
  const legacy = (await windows('<Task><Triggers><BootTrigger/></Triggers><Actions><Exec><Arguments>--import tsx hub.ts --hub-dir x</Arguments></Exec></Actions></Task>'))
    .map(line => `${line.level} ${line.text}`).join('\n');
  assert.match(legacy, /error 排程工作是舊版設定：中樞啟動後若崩潰，工作排程器不會重新啟動它/);
  const supervised = (await windows('<Task><Triggers><BootTrigger/></Triggers><Actions><Exec><Arguments>--import tsx hub.ts --supervise --hub-dir x</Arguments></Exec></Actions></Task>'))
    .map(line => `${line.level} ${line.text}`).join('\n');
  assert.match(supervised, /ok 排程工作由監督程序執行/);
});

// ---------- hub:update (§2.13) ----------

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

test('hub:update: a failed Web build never restarts the service', async t => {
  const repo = temp(t, 'smartsell-repo-');
  const hubDir = temp(t);
  let head = OLD;
  const { exec, calls } = scripted([['git rev-parse HEAD', { code: 0 }], ['git pull --ff-only', { code: 0 }], ['git reset --keep', { code: 0 }],
    ['pnpm install --frozen-lockfile', { code: 0 }], ['pnpm --filter @smartsell/agent-relay build', { code: 0 }],
    ['pnpm --filter @smartsell/web exec tsc', { code: 0 }], ['pnpm --filter @smartsell/web exec vite build', { code: 1 }]]);
  const headExec: Exec = async (file, args, options) => {
    if (file === 'git' && args[0] === 'rev-parse') { calls.push('git rev-parse HEAD'); return { code: 0, stdout: `${head}\n`, stderr: '' }; }
    if (file === 'git' && args[0] === 'pull') head = NEW;
    return exec(file, args, options);
  };
  const lines: string[] = [];
  const code = await updateMain(['--hub-dir', hubDir], { exec: headExec, platform: 'darwin', repo, home: hubDir, uid: 501, log: line => lines.push(line),
    daemonInstalled: () => false });
  assert.equal(code, 1);
  assert.ok(!calls.some(line => line.startsWith('launchctl') || line.includes('kickstart')), calls.join('\n'));
  assert.match(lines.join('\n'), /中樞服務沒有重新啟動，舊版本繼續執行/);
  // AO-1: and what runs after the next reboot is the old version too.
  assert.ok(calls.includes(`git reset --keep ${OLD}`), calls.join('\n'));
  const pullFails = scripted([['git rev-parse HEAD', { code: 0, stdout: `${OLD}\n` }], ['git pull --ff-only', { code: 1 }]]);
  assert.equal(await updateMain(['--hub-dir', hubDir], { exec: pullFails.exec, platform: 'darwin', repo, log: () => {} }), 1);
  assert.deepEqual(pullFails.calls, ['git rev-parse HEAD', 'git pull --ff-only'], 'a failed pull changed nothing, so nothing is undone');
  const noHead = scripted([]);
  assert.equal(await updateMain(['--hub-dir', hubDir], { exec: noHead.exec, platform: 'darwin', repo, log: () => {} }), 1);
  assert.deepEqual(noHead.calls, ['git rev-parse HEAD'], 'without a version to return to, nothing is changed');
});

test('hub:update: swaps the new dist, places selectors, checks, restarts and waits for /readyz', async t => {
  const repo = temp(t, 'smartsell-repo-');
  const hubDir = temp(t);
  const home = temp(t, 'smartsell-home-');
  mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
  writeFileSync(join(home, 'Library/LaunchAgents/com.smartsell.hub.plist'), '<plist/>');
  mkdirSync(join(repo, 'apps/connector-desktop/src/drivers'), { recursive: true });
  writeFileSync(join(repo, 'apps/connector-desktop/src/drivers/selectors.json'), JSON.stringify({ version: '2026.11.3', x: {} }));
  const staging = join(repo, 'apps/web/dist.staging');
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    const line = [file, ...args].join(' ');
    calls.push(line);
    if (line.includes('vite build')) { mkdirSync(staging, { recursive: true }); writeFileSync(join(staging, 'index.html'), 'new'); }
    return { code: 0, stdout: line === 'git rev-parse HEAD' ? `${OLD}\n` : '', stderr: '' };
  };
  let ready = 0;
  const lines: string[] = [];
  const code = await updateMain(['--hub-dir', hubDir, '--skip-pull'], { exec, platform: 'darwin', repo, home, uid: 501, daemonInstalled: () => false,
    nodePath: '/usr/local/bin/node', fetch: (async () => new Response('{}', { status: ++ready > 1 ? 200 : 503 })) as typeof fetch,
    sleep: async () => {}, log: line => lines.push(line) });
  assert.equal(code, 0, lines.join('\n'));
  assert.equal(readFileSync(join(repo, 'apps/web/dist/index.html'), 'utf8'), 'new');
  assert.equal(existsSync(staging), false);
  assert.equal(JSON.parse(readFileSync(join(hubDir, 'driver-config/selectors.json'), 'utf8')).version, '2026.11.3');
  assert.ok(calls.includes('launchctl kickstart -k gui/501/com.smartsell.hub'));
  assert.ok(calls.some(line => line.includes('hub.ts --check --hub-dir')));
  assert.ok(calls.indexOf('launchctl kickstart -k gui/501/com.smartsell.hub') > calls.findIndex(line => line.includes('--check')));
  assert.deepEqual(restartCommands('win32', 'windows', 0), [['schtasks', '/End', '/TN', 'SmartSell Hub'], ['schtasks', '/Run', '/TN', 'SmartSell Hub']]);
  assert.deepEqual(restartCommands('darwin', 'daemon', 501), [['sudo', 'launchctl', 'kickstart', '-k', 'system/com.smartsell.hub']]);
  assert.ok(!existsSync(join(repo, 'apps/web/dist.previous')), 'the previous Web build is dropped once the new hub answers');
  assert.ok(calls.some(line => line.includes('hub.ts --check --hub-dir') && line.endsWith('--load')), 'AO-1: a real load check, not settings only');
  writeFileSync(join(repo, 'apps/connector-desktop/src/drivers/selectors.json'), 'not json');
  assert.equal(placeSelectors(repo, hubDir).status, 'invalid');
  assert.equal(JSON.parse(readFileSync(join(hubDir, 'driver-config/selectors.json'), 'utf8')).version, '2026.11.3', 'the previous file stays');
});

/**
 * A fake hub machine for hub:update (AO-1): git, pnpm, the build, the service and /readyz, all scripted. `newVersion`
 * decides what the restarted hub does; nothing real is ever run.
 */
function updateMachine(t: TestContext, options: { fail?: string; newVersionStarts?: boolean; newVersionWrites?: boolean; plistNode?: string } = {}) {
  const repo = temp(t, 'smartsell-repo-');
  const hubDir = temp(t);
  chmodSync(hubDir, 0o700);
  const home = temp(t, 'smartsell-home-');
  const plist = join(home, 'Library/LaunchAgents/com.smartsell.hub.plist');
  mkdirSync(join(home, 'Library/LaunchAgents'), { recursive: true });
  writeFileSync(plist, `<plist><dict><key>ProgramArguments</key>\n  <array>\n    <string>${options.plistNode ?? '/opt/homebrew/opt/node@24/bin/node'}</string>\n  </array></dict></plist>`);
  mkdirSync(join(repo, 'apps/web/dist'), { recursive: true });
  writeFileSync(join(repo, 'apps/web/dist/index.html'), 'old');
  mkdirSync(join(repo, 'apps/connector-desktop/src/drivers'), { recursive: true });
  writeFileSync(join(repo, 'apps/connector-desktop/src/drivers/selectors.json'), JSON.stringify({ version: '2026.11.9' }));
  mkdirSync(join(hubDir, 'driver-config'), { mode: 0o700 });
  writeFileSync(join(hubDir, 'driver-config/selectors.json'), JSON.stringify({ version: '2026.11.1' }), { mode: 0o600 });
  // The live data: an old-format snapshot.
  const data = join(hubDir, 'smartsell.sqlite');
  const db = new DatabaseSync(data);
  db.exec(`CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL); INSERT INTO snapshot VALUES (1, '{"format":1}')`);
  db.close();
  chmodSync(data, 0o600);
  const staging = join(repo, 'apps/web/dist.staging');
  let head = OLD;
  let serving: 'old' | 'new' | 'none' = 'old';
  let failed = false;
  const calls: string[] = [];
  const exec: Exec = async (file, args) => {
    const line = [file, ...args].join(' ');
    calls.push(line);
    // The step under test fails once (the rollback's own install of the old lockfile then succeeds).
    if (options.fail && !failed && line.includes(options.fail)) { failed = true; return { code: 1, stdout: '', stderr: '' }; }
    if (line === 'git rev-parse HEAD') return { code: 0, stdout: `${head}\n`, stderr: '' };
    if (line === 'git pull --ff-only') head = NEW;
    if (line.startsWith('git reset --keep ')) head = args[2]!;
    if (line.includes('vite build')) { mkdirSync(staging, { recursive: true }); writeFileSync(join(staging, 'index.html'), 'new'); }
    if (line.includes('kickstart') || (line.startsWith('launchctl bootstrap') && head === NEW)) {
      serving = options.newVersionStarts === false ? 'none' : 'new';
      if (options.newVersionWrites) {
        const live = new DatabaseSync(data);
        live.prepare('UPDATE snapshot SET payload = ? WHERE id = 1').run('{"format":2}');
        live.close();
      }
    } else if (line.startsWith('launchctl bootout')) serving = 'none';
    else if (line.startsWith('launchctl bootstrap')) serving = 'old';
    return { code: 0, stdout: '', stderr: '' };
  };
  const fetcher = (async () => new Response('{}', { status: serving === 'none' ? 503 : 200 })) as typeof fetch;
  const lines: string[] = [];
  const update = (argv: string[] = []) => updateMain(['--hub-dir', hubDir, ...argv], { exec, platform: 'darwin', repo, home, uid: 501,
    daemonInstalled: () => false, nodePath: '/opt/homebrew/opt/node@24/bin/node', fetch: fetcher, sleep: async () => {}, isAlive: () => false,
    now: () => new Date('2026-11-24T09:00:00Z'), log: line => lines.push(line), exists: path => path !== '/opt/homebrew/Cellar/node@24/24.11.0/bin/node',
    writeFile: (path, content) => writeFileSync(path, content) });
  const payload = () => {
    const live = new DatabaseSync(data, { readOnly: true });
    try { return (live.prepare('SELECT payload FROM snapshot WHERE id = 1').get() as { payload: string }).payload; } finally { live.close(); }
  };
  return { repo, hubDir, home, plist, data, calls, lines, update, payload, head: () => head, serving: () => serving,
    web: () => readFileSync(join(repo, 'apps/web/dist/index.html'), 'utf8'),
    selectors: () => JSON.parse(readFileSync(join(hubDir, 'driver-config/selectors.json'), 'utf8')).version };
}

test('AO-1 (a): install fails after the pull moved the checkout: source and dependencies go back, nothing restarts', async t => {
  const m = updateMachine(t, { fail: 'pnpm install --frozen-lockfile' });
  assert.equal(await m.update(), 1);
  assert.equal(m.head(), OLD, 'the next reboot runs the old version, not half-installed new source');
  assert.ok(m.calls.includes(`git reset --keep ${OLD}`));
  assert.ok(m.calls.some(line => line.includes('install --frozen-lockfile --offline')), 'dependencies reinstalled from the store, offline');
  assert.ok(!m.calls.some(line => line.includes('kickstart')));
  assert.equal(m.web(), 'old');
  assert.equal(m.selectors(), '2026.11.1');
  assert.ok(readdirSync(join(m.hubDir, 'backups')).some(name => /^pre-update-20261124T090000Z\.sqlite$/.test(name)), 'the data was copied first');
  assert.match(m.lines.join('\n'), /\[失敗\] 2\/6 安裝相依套件失敗.*\n[\s\S]*中樞服務沒有重新啟動，舊版本繼續執行；原始碼與相依套件已回到更新前的版本（aaaaaaaaaaaa）/);
});

test('AO-1 (b): the new code fails to load: the live Web app and selectors stay old, the source goes back, no restart', async t => {
  const m = updateMachine(t, { fail: '--load' });
  assert.equal(await m.update(), 1);
  assert.equal(m.web(), 'old', 'the running hub never serves the new Web app against its old API');
  assert.equal(m.selectors(), '2026.11.1');
  assert.equal(m.head(), OLD);
  assert.ok(!m.calls.some(line => line.includes('kickstart')));
  assert.match(m.lines.join('\n'), /4\/6 新版本的設定、程式或資料檢查沒有通過/);
});

test('AO-1: a new version that does not come up is stopped and rolled back, with the data copy restored and the changed file kept', async t => {
  const m = updateMachine(t, { newVersionStarts: false, newVersionWrites: true });
  assert.equal(await m.update(), 1);
  const order = m.calls.filter(line => /kickstart|bootout|bootstrap|reset --keep/.test(line));
  assert.deepEqual(order, ['launchctl kickstart -k gui/501/com.smartsell.hub', 'launchctl bootout gui/501/com.smartsell.hub', `git reset --keep ${OLD}`,
    `launchctl bootstrap gui/501 ${m.plist}`]);
  assert.equal(m.head(), OLD);
  assert.equal(m.web(), 'old');
  assert.equal(m.selectors(), '2026.11.1');
  assert.equal(m.payload(), '{"format":1}', 'the old code gets data it can read');
  const aside = readdirSync(m.hubDir).find(name => name.startsWith('smartsell.sqlite.failed-update-'));
  assert.ok(aside, 'what the new version wrote is kept, not deleted');
  assert.equal(m.serving(), 'old');
  const text = m.lines.join('\n');
  assert.match(text, /新版本在 60 秒內沒有回應/);
  assert.match(text, /新版本改過資料，已換回更新前的備份；新版本寫過的資料保留在 .*failed-update-/);
  assert.match(text, /\[已回復\] 中樞已回到更新前的版本 aaaaaaaaaaaa 並在執行中/);
  // A new version that fails without touching the data leaves the data file alone.
  const n = updateMachine(t, { newVersionStarts: false });
  assert.equal(await n.update(), 1);
  assert.equal(readdirSync(n.hubDir).some(name => name.includes('failed-update')), false);
  assert.match(n.lines.join('\n'), /資料沒有被新版本改過，保留原樣/);
});

test('AO-1: a good update keeps a data copy, swaps after the load check and drops the previous Web build', async t => {
  const m = updateMachine(t);
  assert.equal(await m.update(), 0, m.lines.join('\n'));
  assert.equal(m.head(), NEW);
  assert.equal(m.web(), 'new');
  assert.equal(m.selectors(), '2026.11.9');
  const check = m.calls.findIndex(line => line.endsWith('--load'));
  assert.ok(check > m.calls.findIndex(line => line.includes('vite build')) && check < m.calls.findIndex(line => line.includes('kickstart')));
  assert.match(m.lines.at(-1)!, /中樞已更新並在執行中.*更新前的資料備份留在 .*pre-update-/);
  assert.deepEqual(stopStartCommands('win32', 'windows', 0, 'C:\\Users\\o'), { stop: [['schtasks', '/End', '/TN', 'SmartSell Hub']], start: [['schtasks', '/Run', '/TN', 'SmartSell Hub']] });
});

test('AO-3: hub:update rewrites a service file whose Homebrew node was removed instead of kickstarting a dead path', async t => {
  const m = updateMachine(t, { plistNode: '/opt/homebrew/Cellar/node@24/24.11.0/bin/node' });
  assert.equal(await m.update(), 0, m.lines.join('\n'));
  assert.ok(!m.calls.some(line => line.includes('kickstart')));
  assert.ok(m.calls.includes(`launchctl bootstrap gui/501 ${m.plist}`));
  assert.match(readFileSync(m.plist, 'utf8'), /<string>\/opt\/homebrew\/opt\/node@24\/bin\/node<\/string>/);
  assert.match(m.lines.join('\n'), /服務設定檔指向的 Node（\/opt\/homebrew\/Cellar\/node@24\/24\.11\.0\/bin\/node）已不存在/);
});

// ---------- hub:export-legacy (§2.11) ----------

test('hub:export-legacy opens the old SQLite read-only and drops sessions, credentials, hashes and ciphertext', t => {
  const dir = temp(t);
  const from = join(dir, 'smartsell.sqlite');
  const op = (kind: string, id: string, value: unknown) => [`["operation_runtime","record","row/${kind}/${id}"]`,
    { id: `row/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`, module: 'operation_runtime', kind: 'record', data: { value: JSON.stringify(value) }, version: 1 }];
  const entity = (module: string, kind: string, id: string, data: Record<string, unknown>) => [JSON.stringify([module, kind, id]), { id, module, kind, data, version: 1 }];
  const snapshot = {
    records: [
      entity('workspace', 'brand', 'b1', { name: 'Shop', private_payload: { key: 'x' }, nested: { token_hash: 'h', ok: 1 } }),
      entity('mcp_runtime', 'credential', 'c1', { actor_id: 'a' }),
      entity('auth', 'session_record', 's1', { user: 'a' }),
      op('connector_device', 'd1', { id: 'd1', name: 'Mac-B', public_key: 'pk', private_key: 'never', pairing_code: 'never' }),
      op('social_account', 'a1', { id: 'a1', handle: 'makemylure', access_token: 'never', refresh_token: 'never', secret_ciphertext: 'never' }),
      op('device_nonce', 'n1', { nonce: 'never' }),
      op('session', 'x', { id: 'x' }),
      ['["operation_runtime","record","outbox/1"]', { id: 'outbox/1', module: 'operation_runtime', kind: 'record', data: { value: '{"never":1}' } }],
      ['["operation_runtime","record","job/1"]', { id: 'job/1', module: 'operation_runtime', kind: 'record', data: { value: '{"never":1}' } }],
      ['["operation_runtime","revision","ws"]', { id: 'ws', module: 'operation_runtime', kind: 'revision', data: {} }],
    ],
    responses: [], sessions: [['hash', { userId: 'a', expires: 1 }]], audit: [], events: [], outbox: [],
    user: { id: 'a', email: 'o@example.test', passwordHash: 'never' },
  };
  const db = new DatabaseSync(from);
  db.exec('CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)');
  db.prepare('INSERT INTO snapshot VALUES (1, ?)').run(JSON.stringify(snapshot));
  db.close();
  const digest = () => createHash('sha256').update(readFileSync(from)).digest('hex');
  const before = digest();
  mkdirSync(join(dir, 'media', 'objects'), { recursive: true });
  writeFileSync(join(dir, 'media', 'objects', 'a.mp4'), 'video');
  writeFileSync(join(dir, 'outside.txt'), 'never');
  symlinkSync(join(dir, 'outside.txt'), join(dir, 'media', 'objects', 'link.txt'));

  const out = join(dir, 'export');
  const result = exportLegacy({ from, out, now: new Date('2026-11-24T00:00:00Z') });
  assert.equal(digest(), before, 'the source database is untouched');
  const exported = readFileSync(result.exportPath, 'utf8');
  assert.doesNotMatch(exported, /never/);
  const parsed = JSON.parse(exported);
  assert.equal(parsed.exported_at, '2026-11-24T00:00:00.000Z');
  assert.equal(parsed.source, from);
  assert.deepEqual(Object.keys(parsed.kinds).sort(), ['connector_device', 'social_account', 'workspace.brand']);
  assert.deepEqual(parsed.kinds['workspace.brand'][0].data, { name: 'Shop', nested: { ok: 1 } });
  assert.deepEqual(parsed.kinds.connector_device[0], { id: 'd1', name: 'Mac-B', public_key: 'pk' });
  assert.deepEqual(parsed.kinds.social_account[0], { id: 'a1', handle: 'makemylure' });
  assert.equal(result.mediaFiles, 1);
  assert.equal(readFileSync(join(out, 'media', 'objects', 'a.mp4'), 'utf8'), 'video');
  assert.equal(existsSync(join(out, 'media', 'objects', 'link.txt')), false, 'symlinks are not followed');
  assert.equal(statSync(result.exportPath).mode & 0o777, 0o600);
  assert.throws(() => exportLegacy({ from, out }), /不是空的/);
  assert.equal(exportLegacyMain([], () => {}), 2);
  assert.equal(exportLegacyMain(['--from', join(dir, 'missing.sqlite'), '--out', join(dir, 'x')], () => {}), 1);
  assert.deepEqual(exportSnapshot(JSON.stringify({ records: [] })).kinds, {});
});

// ---------- worker release manifests ----------

test('latest-<platform>.json is validated before it is advertised', async t => {
  const dir = temp(t);
  const write = (value: unknown) => writeFileSync(join(dir, 'latest-mac-x64.json'), typeof value === 'string' ? value : JSON.stringify(value));
  const valid = { version: '0.2.1', platform: 'mac-x64', file: 'SmartSell-Worker-0.2.1-x64.dmg', sha256: 'c'.repeat(64), bytes: 5, built_at: '2026-11-24T00:00:00Z' };
  assert.equal((await inspectWorkerRelease(dir, 'mac-x64')).status, 'missing');
  write(valid);
  assert.equal((await inspectWorkerRelease(dir, 'mac-x64')).status, 'ok');
  for (const broken of [{ ...valid, file: '../hub.env' }, { ...valid, file: 'x.sh' }, { ...valid, platform: 'mac-arm64' }, { ...valid, sha256: 'xyz' },
    { ...valid, version: 'latest' }, { ...valid, bytes: 0 }, 'not json']) {
    write(broken);
    assert.equal((await inspectWorkerRelease(dir, 'mac-x64')).status, 'invalid', JSON.stringify(broken));
  }
  // S1: the release signature is optional (manifests from before S1), shape-checked, and passed through verbatim.
  const signature = `${'A'.repeat(85)}w==`;
  write({ ...valid, signature });
  const signed = await inspectWorkerRelease(dir, 'mac-x64');
  assert.equal(signed.status === 'ok' && signed.release.signature, signature);
  write(valid);
  const unsigned = await inspectWorkerRelease(dir, 'mac-x64');
  assert.equal(unsigned.status === 'ok' && 'signature' in unsigned.release, false);
  for (const bad of ['', 'not base64!', 'A'.repeat(88), 42, null]) {
    write({ ...valid, signature: bad });
    assert.equal((await inspectWorkerRelease(dir, 'mac-x64')).status, 'invalid', JSON.stringify(bad));
  }
  assert.ok(compareWorkerVersions('0.10.0', '0.9.9') > 0);
  assert.ok(compareWorkerVersions('0.2.0-beta.1', '0.2.0') < 0);
  assert.equal(compareWorkerVersions('1.0.0', '1.0.0'), 0);
});

// ---------- install-hub (§2.13) ----------

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

test('install-hub.sh prints the exact install command for missing software and changes nothing', { skip: process.platform !== 'darwin' }, t => {
  const bin = temp(t, 'smartsell-bin-');
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const name of ['brew', 'corepack']) writeFileSync(join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: temp(t, 'smartsell-home-') };
  assert.equal(spawnSync('bash', ['-n', join(repoRoot, 'scripts/install-hub.sh')]).status, 0, 'shell syntax');
  const result = spawnSync('bash', [join(repoRoot, 'scripts/install-hub.sh'), '--check-only'], { env, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /\[缺少\] ffmpeg \/ ffprobe：請執行  brew install ffmpeg/);
  assert.match(result.stdout, /\[OK\] Node\.js 24/);
  assert.match(result.stderr, /\[失敗\] 命令：前置軟體檢查\n\s+原因：缺少上面標示的軟體\n\s+下一步：依上面的命令安裝後，重跑/);
  assert.equal(spawnSync('bash', [join(repoRoot, 'scripts/install-hub.sh'), '--nope'], { env }).status, 2);
  const ps1 = readFileSync(join(repoRoot, 'scripts/install-hub.ps1'));
  assert.deepEqual([...ps1.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Windows PowerShell 5.1 reads zh-Hant correctly');
  const text = ps1.toString('utf8');
  for (const command of ['winget install --id Git.Git -e', 'winget install --id OpenJS.NodeJS -e --version 24.*', 'winget install --id Gyan.FFmpeg -e',
    'winget install --id Tailscale.Tailscale -e', "'hub:init'", "'hub:service', 'install'", "'install', '--frozen-lockfile'"]) assert.ok(text.includes(command), command);
});
