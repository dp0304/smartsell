import assert from 'node:assert/strict';
import test from 'node:test';
import type { Exec, ExecResult } from './exec.js';
import {
  configureServe, createTailscaleMonitor, findTailscale, hostnameLooksPersonal, keyExpiryWarning, MAC_TAILSCALE_APP, parseServeStatus,
  parseTailscaleStatus, serveArgs, serveStatus, tailscaleCandidates, tailscaleStatus, TAILSCALE_TEXT,
} from './tailscale.js';

const statusJson = (overrides: Record<string, unknown> = {}, self: Record<string, unknown> = {}) => JSON.stringify({
  BackendState: 'Running', CertDomains: ['hub.tail1234.ts.net'],
  Self: { DNSName: 'hub.tail1234.ts.net.', HostName: 'hub', KeyExpiry: '2027-05-20T00:00:00Z', ...self }, ...overrides,
});
const serveJson = (proxy = 'http://127.0.0.1:3401', host = 'hub.tail1234.ts.net:443', https = true) =>
  JSON.stringify({ TCP: { '443': { HTTPS: https } }, Web: { [host]: { Handlers: { '/': { Proxy: proxy } } } } });

/** Records every call; answers from a table keyed by the joined argv. The real tailscale binary is never run. */
function fakeExec(answers: Record<string, Partial<ExecResult>>) {
  const calls: string[][] = [];
  const exec: Exec = async (file, args) => {
    calls.push([file, ...args]);
    const answer = answers[[file, ...args].join(' ')] ?? answers[args.join(' ')];
    return { code: 0, stdout: '', stderr: '', ...(answer ?? { code: -1, error: 'ENOENT' }) };
  };
  return { exec, calls };
}

test('parseTailscaleStatus strips the trailing dot and reads key expiry and HTTPS domains', () => {
  const self = parseTailscaleStatus(statusJson());
  assert.equal(self.running, true);
  assert.equal(self.dnsName, 'hub.tail1234.ts.net');
  assert.equal(self.origin, 'https://hub.tail1234.ts.net');
  assert.equal(self.keyExpiry, '2027-05-20T00:00:00Z');
  assert.deepEqual(self.certDomains, ['hub.tail1234.ts.net']);
  assert.equal(parseTailscaleStatus(statusJson({}, { KeyExpiry: undefined })).keyExpiry, null, 'expiry disabled');
  assert.equal(parseTailscaleStatus(statusJson({}, { KeyExpiry: '0001-01-01T00:00:00Z' })).keyExpiry, null);
  const stopped = parseTailscaleStatus(statusJson({ BackendState: 'NeedsLogin' }, { DNSName: '' }));
  assert.equal(stopped.running, false);
  assert.equal(stopped.dnsName, null);
  assert.throws(() => parseTailscaleStatus('not json'), /JSON/);
});

test('parseServeStatus requires 443 HTTPS proxying / to the hub port on this machine', () => {
  assert.deepEqual(parseServeStatus(serveJson(), 3401, 'hub.tail1234.ts.net'), { ok: true });
  assert.equal(parseServeStatus(serveJson('http://localhost:3401/'), 3401).ok, true);
  assert.equal(parseServeStatus(serveJson('http://127.0.0.1:8080'), 3401).ok, false);
  assert.equal(parseServeStatus(serveJson(undefined, 'hub.tail1234.ts.net:8443'), 3401).ok, false);
  assert.equal(parseServeStatus(serveJson(undefined, undefined, false), 3401).ok, false);
  assert.equal(parseServeStatus(serveJson(undefined, 'other.tail1234.ts.net:443'), 3401, 'hub.tail1234.ts.net').ok, false);
  assert.equal(parseServeStatus('{}', 3401).ok, false);
  assert.match(parseServeStatus('{}', 3401).reason!, /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:3401/);
  assert.equal(parseServeStatus(JSON.stringify({ Foreground: { session: JSON.parse(serveJson()) } }), 3401).ok, true);
  assert.equal(parseServeStatus('garbage', 3401).ok, false);
  assert.deepEqual(serveArgs(3401), ['serve', '--bg', '--https=443', 'http://127.0.0.1:3401']);
});

test('configureServe reports a tailnet without HTTPS certificates with the admin-console instruction', async () => {
  const ok = fakeExec({ 'serve --bg --https=443 http://127.0.0.1:3401': { code: 0 } });
  assert.deepEqual(await configureServe(ok.exec, 'tailscale', 3401), { ok: true });
  assert.deepEqual(ok.calls, [['tailscale', 'serve', '--bg', '--https=443', 'http://127.0.0.1:3401']]);
  for (const stderr of ['error: HTTPS is not enabled for this tailnet', 'Serve is not enabled on your tailnet.\nTo enable, visit: https://login.tailscale.com/f/serve?node=x']) {
    const failing = fakeExec({ 'serve --bg --https=443 http://127.0.0.1:3401': { code: 1, stderr } });
    const result = await configureServe(failing.exec, 'tailscale', 3401);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, 'https_disabled');
    assert.equal(!result.ok && result.message, '請到 Tailscale 管理後台 → DNS → 啟用 MagicDNS 與 HTTPS Certificates，然後重跑 pnpm hub:init');
  }
  const other = fakeExec({ 'serve --bg --https=443 http://127.0.0.1:3401': { code: 1, stderr: 'permission denied' } });
  const result = await configureServe(other.exec, 'tailscale', 3401);
  assert.equal(!result.ok && result.code, 'command_failed');
});

test('findTailscale: macOS App bundle, then PATH; Windows Program Files; explicit SMARTSELL_TAILSCALE_CLI', async () => {
  const none = fakeExec({});
  assert.equal(await findTailscale(none.exec, { platform: 'darwin', env: {}, exists: path => path === MAC_TAILSCALE_APP }), MAC_TAILSCALE_APP);
  assert.equal(none.calls.length, 0);
  const onPath = fakeExec({ 'tailscale version': { code: 0, stdout: '1.90.0' } });
  assert.equal(await findTailscale(onPath.exec, { platform: 'darwin', env: {}, exists: () => false }), 'tailscale');
  assert.equal(await findTailscale(none.exec, { platform: 'darwin', env: {}, exists: () => false }), undefined);
  assert.deepEqual(tailscaleCandidates('win32', { ProgramFiles: 'C:\\Program Files' }), ['C:\\Program Files\\Tailscale\\tailscale.exe', 'tailscale']);
  assert.equal(await findTailscale(none.exec, { platform: 'win32', env: { ProgramFiles: 'D:\\Apps' }, exists: path => path === 'D:\\Apps\\Tailscale\\tailscale.exe' }),
    'D:\\Apps\\Tailscale\\tailscale.exe');
  assert.equal(await findTailscale(none.exec, { platform: 'darwin', env: { SMARTSELL_TAILSCALE_CLI: '/opt/fake' }, exists: path => path === '/opt/fake' }), '/opt/fake');
  assert.equal(await findTailscale(onPath.exec, { platform: 'darwin', env: { SMARTSELL_TAILSCALE_CLI: '/opt/missing' }, exists: () => false }), undefined);
});

test('tailscaleStatus and serveStatus go through the injected exec', async () => {
  const { exec, calls } = fakeExec({ 'status --json': { stdout: statusJson() }, 'serve status --json': { stdout: serveJson() } });
  const self = await tailscaleStatus(exec, '/bin/fake-tailscale');
  assert.equal(self.dnsName, 'hub.tail1234.ts.net');
  assert.deepEqual(await serveStatus(exec, '/bin/fake-tailscale', 3401, self.dnsName), { ok: true });
  assert.deepEqual(calls, [['/bin/fake-tailscale', 'status', '--json'], ['/bin/fake-tailscale', 'serve', 'status', '--json']]);
  const missing = fakeExec({});
  await assert.rejects(tailscaleStatus(missing.exec, 'tailscale'), { code: 'not_found' });
  // Logged out: non-zero exit but JSON on stdout.
  const loggedOut = fakeExec({ 'status --json': { code: 1, stdout: statusJson({ BackendState: 'NeedsLogin' }) } });
  assert.equal((await tailscaleStatus(loggedOut.exec, 'tailscale')).running, false);
});

test('key expiry warning inside 30 days; reminders for personal machine names', () => {
  const now = new Date('2026-11-24T00:00:00Z');
  assert.deepEqual(keyExpiryWarning('2026-12-10T00:00:00Z', now), { days: 16, date: '2026-12-10' });
  assert.equal(keyExpiryWarning('2027-05-20T00:00:00Z', now), null);
  assert.equal(keyExpiryWarning(null, now), null);
  assert.deepEqual(keyExpiryWarning('2026-11-01T00:00:00Z', now), { days: 0, date: '2026-11-01' });
  assert.equal(hostnameLooksPersonal('hub.tail1234.ts.net'), false);
  assert.equal(hostnameLooksPersonal('mac-mini-2.tail1234.ts.net'), false);
  assert.equal(hostnameLooksPersonal('johns-macbook-pro.tail1234.ts.net'), true);
  assert.equal(hostnameLooksPersonal('dpdemac-mini.tail1234.ts.net'), true);
  assert.match(TAILSCALE_TEXT.certificateTransparency('johns-macbook-pro.tail1234.ts.net'), /憑證透明度/);
});

test('the monitor re-checks serve status and keeps the last snapshot', async () => {
  let serve = serveJson();
  const exec: Exec = async (_file, args) => args[0] === 'status' ? { code: 0, stdout: statusJson(), stderr: '' }
    : { code: 0, stdout: serve, stderr: '' };
  const monitor = createTailscaleMonitor({ exec, port: 3401, findBinary: async () => '/fake', now: () => new Date('2026-11-24T10:00:00Z') });
  assert.deepEqual(monitor.snapshot(), { serve_ok: null, key_expiry: null, checked_at: null });
  assert.deepEqual(await monitor.refresh(), { serve_ok: true, key_expiry: '2027-05-20T00:00:00Z', checked_at: '2026-11-24T10:00:00.000Z' });
  serve = '{}';
  const after = await monitor.refresh();
  assert.equal(after.serve_ok, false);
  assert.equal(monitor.snapshot().serve_ok, false);
  const missing = createTailscaleMonitor({ exec, port: 3401, findBinary: async () => undefined });
  assert.equal((await missing.refresh()).serve_ok, false);
  monitor.start();
  monitor.stop();
});

test('SEC-3 (E46): Tailscale Funnel that reaches the hub is reported; serve_ok keeps its §2.7 meaning', async () => {
  const host = 'hub.tail1234.ts.net';
  const withFunnel = (config: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(serveJson()), ...config });
  // The verifier's PoC: before E46 this was { ok: true } and nothing anywhere warned.
  assert.deepEqual(parseServeStatus(withFunnel({ AllowFunnel: { [`${host}:443`]: true } }), 3401, host),
    { ok: true, funnel: true, funnel_host_port: `${host}:443` });
  assert.deepEqual(parseServeStatus(withFunnel({ AllowFunnel: { [`${host}:443`]: false } }), 3401, host), { ok: true });
  // A public port that serves something else does not expose the hub; one that proxies to it does.
  const other = { TCP: { '443': { HTTPS: true }, '8443': { HTTPS: true } }, Web: { [`${host}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3401' } } },
    [`${host}:8443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8080' } } } }, AllowFunnel: { [`${host}:8443`]: true } };
  assert.deepEqual(parseServeStatus(JSON.stringify(other), 3401, host), { ok: true });
  const exposed = { ...other, Web: { ...other.Web, [`${host}:8443`]: { Handlers: { '/api': { Proxy: 'localhost:3401' } } } } };
  assert.equal(parseServeStatus(JSON.stringify(exposed), 3401, host).funnel_host_port, `${host}:8443`);
  assert.equal(parseServeStatus(JSON.stringify({ TCP: { '10000': { TCPForward: '127.0.0.1:3401' } }, AllowFunnel: { [`${host}:10000`]: true } }), 3401, host).funnel, true);
  assert.equal(parseServeStatus(JSON.stringify({ Foreground: { s1: { ...JSON.parse(serveJson()), AllowFunnel: { [`${host}:443`]: true } } } }), 3401, host).funnel, true);
  // The instruction: re-running serve on 443 makes it tailnet-only again; another port is turned off by its own command.
  assert.match(TAILSCALE_TEXT.funnelOn(`${host}:443`, 'http://127.0.0.1:3401'), /公開到網際網路（https:\/\/hub\.tail1234\.ts\.net）.*tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:3401/);
  assert.match(TAILSCALE_TEXT.funnelOn(`${host}:8443`, 'http://127.0.0.1:3401'), /https:\/\/hub\.tail1234\.ts\.net:8443.*tailscale funnel --https=8443 off/);
  // The hub's own monitor (hub/info, setup wizard data) carries it and logs it once.
  const lines: string[] = [];
  const exec: Exec = async (_file, args) => ({ code: 0, stdout: args[0] === 'status' ? statusJson() : withFunnel({ AllowFunnel: { [`${host}:443`]: true } }), stderr: '' });
  const monitor = createTailscaleMonitor({ exec, port: 3401, findBinary: async () => '/fake', now: () => new Date('2026-11-24T10:00:00Z'), log: line => lines.push(line) });
  const snapshot = await monitor.refresh();
  assert.equal(snapshot.serve_ok, true);
  assert.equal(snapshot.funnel_on, true);
  assert.match(snapshot.funnel_warning!, /Tailscale Funnel/);
  await monitor.refresh();
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^\[警告\] 中樞被 Tailscale Funnel 公開到網際網路/);
});
