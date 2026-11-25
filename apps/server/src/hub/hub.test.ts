import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { Problem } from '@smartsell/contracts';
import { buildApp, isReservedApiPath, RAW_BODY_ROUTE } from '../app.js';
import { configuration, defaultHubDir, HUB_FORBIDDEN_SWITCHES, HubConfigError } from '../config.js';
import { localStore } from '../local.js';
import { MemoryStore } from '../memory.js';
import { productionSemantics } from '../production.js';
import { provideWorkerDownloadDeviceAuth } from '../worker-downloads.js';
import type { Exec } from './exec.js';
import { applyHubEnv, HUB_ENV_KEYS, mergeHubEnv, parseHubEnv, readHubEnvFile } from './hub-env.js';
import { registerHubInfo } from './hub-info.js';
import { dataDirectoryIssue, hubMain, prepareHubEnvironment, runHubChecks } from './startup.js';
import { readHubStatus } from './status-file.js';
import { isSpaPath, safeStaticPath, WEB_CSP, webStatic } from './web-static.js';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const serverRoot = join(repoRoot, 'apps/server');
const hex = () => randomBytes(32).toString('hex');
const ORIGIN = 'https://hub.tail1234.ts.net';
const secret = hex();
const setupToken = hex();

function temp(t: TestContext, prefix = 'smartsell-hub-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function hubEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { SMARTSELL_MODE: 'hub', NODE_ENV: 'production', PUBLIC_ORIGIN: ORIGIN, APP_SECRET: secret, SETUP_TOKEN: setupToken,
    SMARTSELL_HUB_DIR: '/tmp/smartsell-hub-config-fixture', ...overrides };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  return env;
}

const hubCode = (env: NodeJS.ProcessEnv, code: string) => assert.throws(() => configuration(env), (error: unknown) => {
  assert.ok(error instanceof HubConfigError, `expected HubConfigError, got ${String(error)}`);
  assert.equal(error.code, code);
  return true;
});

function comparable(config: ReturnType<typeof configuration>) {
  return JSON.parse(JSON.stringify(config, (_key, value) => value instanceof Set ? [...value].sort()
    : value instanceof Map ? [...value].sort() : value instanceof Uint8Array ? Buffer.from(value).toString('hex') : value));
}

// ---------- configuration (§2.3) ----------

test('hub configuration: a ts.net PUBLIC_ORIGIN yields production semantics with the hub defaults', () => {
  const config = configuration(hubEnv());
  assert.equal(config.mode, 'hub');
  assert.equal(config.hub, true);
  assert.equal(config.production, true);
  assert.deepEqual([...config.origins], [ORIGIN], 'no development origins and no DEV_ORIGINS in hub mode');
  assert.equal(configuration(hubEnv({ DEV_ORIGINS: 'http://127.0.0.1:9999' })).origins.size, 1);
  assert.equal(config.trustProxy, '127.0.0.1');
  assert.equal(config.requestTimeoutMs, 900_000);
  assert.equal(config.maxUploadBytes, 2 * 1024 ** 3);
  assert.equal(config.hubDirectory, '/tmp/smartsell-hub-config-fixture');
  assert.equal(config.statePath, '/tmp/smartsell-hub-config-fixture/smartsell.sqlite');
  assert.equal(config.mediaDirectory, '/tmp/smartsell-hub-config-fixture/media');
  assert.equal(config.workerDownloadDirectory, '/tmp/smartsell-hub-config-fixture/worker-downloads');
  assert.equal(config.driverConfigDirectory, '/tmp/smartsell-hub-config-fixture/driver-config');
  assert.equal(config.webDistDirectory, join(repoRoot, 'apps/web/dist'));
  assert.equal(configuration(hubEnv({ SMARTSELL_WEB_DIST: '/srv/web' })).webDistDirectory, '/srv/web');
  assert.equal(config.secureCookie, true);
  assert.equal(config.localSetupOrigins, undefined);
  assert.equal(config.allowLoopbackWebhook, false);
  assert.equal(config.testTiming, undefined);
  assert.equal(configuration(hubEnv({ SMARTSELL_HUB_DIR: undefined })).hubDirectory, defaultHubDir());
  assert.equal(configuration(hubEnv({ SMARTSELL_HUB_ANY_ORIGIN: '1', PUBLIC_ORIGIN: 'https://hub.example.com' })).origin, 'https://hub.example.com');
});

test('hub configuration rejects non-https, non-ts.net, non-loopback, missing secret and DATABASE_URL', () => {
  hubCode(hubEnv({ PUBLIC_ORIGIN: 'http://hub.tail1234.ts.net' }), 'HUB_PUBLIC_ORIGIN_NOT_HTTPS');
  hubCode(hubEnv({ PUBLIC_ORIGIN: 'https://hub.example.com' }), 'HUB_PUBLIC_ORIGIN_NOT_TAILNET');
  hubCode(hubEnv({ PUBLIC_ORIGIN: undefined }), 'HUB_PUBLIC_ORIGIN_MISSING');
  hubCode(hubEnv({ HOST: '0.0.0.0' }), 'HUB_HOST_NOT_LOOPBACK');
  hubCode(hubEnv({ HOST: '100.64.0.1' }), 'HUB_HOST_NOT_LOOPBACK');
  hubCode(hubEnv({ ROLE: 'api' }), 'HUB_ROLE_NOT_ALL');
  hubCode(hubEnv({ APP_SECRET: undefined }), 'HUB_APP_SECRET_INVALID');
  hubCode(hubEnv({ APP_SECRET: 'abc123' }), 'HUB_APP_SECRET_INVALID');
  hubCode(hubEnv({ APP_SECRET: '0'.repeat(64) }), 'HUB_APP_SECRET_INVALID');
  hubCode(hubEnv({ DATABASE_URL: 'postgresql://fixture/db' }), 'HUB_DATABASE_URL_SET');
  hubCode(hubEnv({ SETUP_TOKEN: 'short-token' }), 'HUB_SETUP_TOKEN_INVALID');
  hubCode(hubEnv({ SETUP_TOKEN: secret }), 'HUB_SETUP_TOKEN_INVALID');
  hubCode(hubEnv({ SMARTSELL_STORE: 'memory' }), 'HUB_STORE_NOT_LOCAL');
  for (const [name, value] of HUB_FORBIDDEN_SWITCHES) hubCode(hubEnv({ [name]: value }), 'HUB_DEV_SWITCH_SET');
  assert.equal(configuration(hubEnv({ SETUP_TOKEN: undefined })).setupToken, undefined, 'SETUP_TOKEN is optional');
  assert.equal(configuration(hubEnv({ HOST: 'localhost' })).host, 'localhost');
  assert.throws(() => configuration(hubEnv({ SMARTSELL_MODE: 'kiosk' })), /SMARTSELL_MODE/);
  // Owner-facing copy is zh-Hant with the next step.
  assert.throws(() => configuration(hubEnv({ PUBLIC_ORIGIN: 'http://hub.tail1234.ts.net' })), /pnpm hub:init/);
});

test('hub mode keeps config.production === true under NODE_ENV=test; only the two test exceptions differ', () => {
  const asTest = configuration(hubEnv({ NODE_ENV: 'test' }));
  assert.equal(asTest.production, true);
  assert.equal(asTest.mode, 'hub');
  assert.deepEqual(comparable(asTest), comparable(configuration(hubEnv({ NODE_ENV: 'production' }))), 'identical to the production hub');
  assert.equal(configuration(hubEnv({ NODE_ENV: undefined })).production, true);

  // Exception 1: plain-HTTP loopback origin with NODE_ENV=test and SMARTSELL_HUB_TEST_HTTP=1.
  const http = configuration(hubEnv({ NODE_ENV: 'test', SMARTSELL_HUB_TEST_HTTP: '1', PUBLIC_ORIGIN: 'http://127.0.0.1:43123', PORT: '43123' }));
  assert.equal(http.origin, 'http://127.0.0.1:43123');
  assert.equal(http.secureCookie, false);
  assert.equal(http.production, true);
  hubCode(hubEnv({ NODE_ENV: 'production', SMARTSELL_HUB_TEST_HTTP: '1', PUBLIC_ORIGIN: 'http://127.0.0.1:43123' }), 'HUB_PUBLIC_ORIGIN_NOT_HTTPS');
  hubCode(hubEnv({ NODE_ENV: 'test', PUBLIC_ORIGIN: 'http://127.0.0.1:43123' }), 'HUB_PUBLIC_ORIGIN_NOT_HTTPS');
  hubCode(hubEnv({ NODE_ENV: 'test', SMARTSELL_HUB_TEST_HTTP: '1', PUBLIC_ORIGIN: 'http://localhost:43123' }), 'HUB_PUBLIC_ORIGIN_NOT_HTTPS');

  // Exception 2: shortened schedules, only under NODE_ENV=test, exposed through config.testTiming.
  const timing = { SMARTSELL_TEST_OFFLINE_STALENESS_SEC: '120', SMARTSELL_TEST_READBACK_SCHEDULE_SEC: '5, 10,20',
    SMARTSELL_TEST_UNREPORTED_GRACE_SEC: '30', SMARTSELL_TEST_PREPARE_LEAD_SEC: '30' };
  assert.deepEqual(configuration(hubEnv({ NODE_ENV: 'test', ...timing })).testTiming,
    { offlineStalenessSec: 120, readbackScheduleSec: [5, 10, 20], unreportedGraceSec: 30, prepareLeadSec: 30 });
  assert.equal(configuration(hubEnv({ NODE_ENV: 'production', ...timing })).testTiming, undefined);
  assert.throws(() => configuration(hubEnv({ NODE_ENV: 'test', SMARTSELL_TEST_PREPARE_LEAD_SEC: 'soon' })), /SMARTSELL_TEST_PREPARE_LEAD_SEC/);

  // traffic-host.ts reads NODE_ENV itself; the hub validates traffic origins with production rules anyway.
  const traffic = JSON.stringify({ 'http://shop.fixture.test': '00000000-0000-4000-8000-000000000001' });
  assert.throws(() => configuration(hubEnv({ NODE_ENV: 'test', SMARTSELL_TRAFFIC_HOSTS: traffic })), /SMARTSELL_TRAFFIC_HOSTS/);
});

test('development and production configuration behave as before', () => {
  const dev = configuration({});
  assert.equal(dev.mode, 'dev');
  assert.equal(dev.hub, false);
  assert.equal(dev.production, false);
  assert.equal(dev.trustProxy, false);
  assert.equal(dev.requestTimeoutMs, 30_000);
  assert.equal(dev.maxUploadBytes, 512 * 1024 ** 2);
  assert.equal(dev.hubDirectory, undefined);
  assert.equal(dev.webDistDirectory, undefined);
  assert.equal(dev.statePath, join(repoRoot, '.local/smartsell.sqlite'));
  assert.ok(dev.origins.has('http://127.0.0.1:5173'));
  assert.equal(configuration({ NODE_ENV: 'test' }).production, false);
  assert.throws(() => configuration({ NODE_ENV: 'production' }), /Production requires/);
  const production = configuration({ NODE_ENV: 'production', DATABASE_URL: 'postgresql://fixture/db', PUBLIC_ORIGIN: 'https://app.example.test', APP_SECRET: hex() });
  assert.equal(production.mode, 'production');
  assert.equal(production.production, true);
  assert.equal(production.trustProxy, false);
  assert.deepEqual([...production.origins], ['https://app.example.test']);
  assert.throws(() => configuration({ SMARTSELL_MAX_UPLOAD_BYTES: String(5 * 1024 ** 3) }), /4 GiB/);
  assert.equal(configuration({ SMARTSELL_MAX_UPLOAD_BYTES: String(3 * 1024 ** 3) }).maxUploadBytes, 3 * 1024 ** 3);
});

test('mediaDirectory follows statePath in every mode (§6.7)', () => {
  assert.equal(configuration({ SMARTSELL_DATA_FILE: '/data/a/state.sqlite' }).mediaDirectory, '/data/a/media');
  assert.equal(configuration({}).mediaDirectory, join(repoRoot, '.local/media'));
  assert.equal(configuration({ SMARTSELL_DATA_FILE: '/data/a/state.sqlite', MEDIA_DIRECTORY: '/media/b' }).mediaDirectory, '/media/b');
  assert.equal(configuration(hubEnv({ SMARTSELL_DATA_FILE: '/hub/data/x.sqlite' })).mediaDirectory, '/hub/data/media');
  assert.equal(configuration(hubEnv()).mediaDirectory, '/tmp/smartsell-hub-config-fixture/media');
});

test('defaultHubDir per platform', () => {
  assert.equal(defaultHubDir('darwin', {}, '/Users/o'), '/Users/o/Library/Application Support/SmartSell Hub');
  assert.equal(defaultHubDir('win32', { LOCALAPPDATA: 'C:\\Users\\o\\AppData\\Local' }, 'C:\\Users\\o'), 'C:\\Users\\o\\AppData\\Local\\SmartSell Hub');
  assert.equal(defaultHubDir('linux', {}, '/home/o'), '/home/o/.local/share/smartsell-hub');
});

// ---------- audit of config.production readers and direct NODE_ENV reads (§2.2) ----------

/** Files that read config.production (design §2.2); in hub mode they all see true. */
const PRODUCTION_READERS = ['bootstrap.ts', 'server.ts', 'runtime.ts', 'operation-server.ts', 'operations.ts', 'oauth.ts',
  'modules/planning/index.ts', 'modules/planning/queries.ts', 'integration/commerce-providers.ts', 'integration/enterprise-host.ts',
  'integration/kernel-runtime.ts', 'integration/portal-host.ts'];

/**
 * Every direct NODE_ENV read under apps/server and packages, with why a hub never takes its development branch. A new
 * read fails this test: route it through config.production (or config.testTiming) instead.
 */
const NODE_ENV_READS: Record<string, string> = {
  'apps/server/src/config.ts': 'defines mode/production; NODE_ENV=test only gates the two hub test exceptions',
  'apps/server/src/bootstrap.ts': 'memory store only with NODE_ENV=test; a hub forces the local store (HUB_STORE_NOT_LOCAL)',
  'apps/server/src/hub/startup.ts': 'hub.ts sets NODE_ENV=production unless it is test',
  'apps/server/src/production.ts': 'productionSemantics(): the config.production rule for modules without a Config (egress, model runtime, lead contacts)',
  'apps/server/src/integration/traffic-host.ts': 'config.ts passes NODE_ENV=production to trafficHostConfig in hub mode',
  'apps/server/dev.ts': 'development entry point; refuses NODE_ENV=production',
  'apps/server/init-local.ts': 'local preview initializer; refuses production',
  'apps/server/recover-local.ts': 'local recovery tool; refuses production',
};

function sourceFiles(dir: string, out: string[] = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.(?:ts|mts|tsx)$/.test(entry.name) && !/\.(?:test|spec)\.|\.d\.ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

test('audit: config.production call sites and direct NODE_ENV reads', t => {
  const serverSources = sourceFiles(join(serverRoot, 'src'));
  const readers = serverSources.filter(path => /\bconfig\??\.production\b/.test(readFileSync(path, 'utf8')))
    .map(path => relative(join(serverRoot, 'src'), path).replaceAll('\\', '/')).filter(path => path !== 'config.ts' && !path.startsWith('hub/'));
  // Readers of config.production are production-safe in hub mode by construction; the list documents them and drift
  // (from streams editing those files) is reported, not failed. The safety-relevant audit is the NODE_ENV one below.
  assert.ok(readers.length >= 8, `expected the documented config.production readers, found ${readers.join(', ')}`);
  const gone = PRODUCTION_READERS.filter(path => !readers.includes(path));
  const extra = readers.filter(path => !PRODUCTION_READERS.includes(path));
  if (gone.length) t.diagnostic(`no longer read config.production: ${gone.join(', ')}`);
  if (extra.length) t.diagnostic(`new config.production readers (production-safe in hub mode): ${extra.join(', ')}`);

  const scanned = [...serverSources, ...readdirSync(serverRoot).filter(name => name.endsWith('.ts')).map(name => join(serverRoot, name)),
    // Packages the hub process loads; agent-relay, sdk and ui run on the laptop or in the browser, not in the hub.
    ...readdirSync(join(repoRoot, 'packages')).filter(pkg => !['agent-relay', 'sdk', 'ui'].includes(pkg))
      .flatMap(pkg => sourceFiles(join(repoRoot, 'packages', pkg, 'src')))];
  const direct = scanned.filter(path => /\bNODE_ENV\b/.test(readFileSync(path, 'utf8'))).map(path => relative(repoRoot, path).replaceAll('\\', '/'));
  const unknown = direct.filter(path => !Object.hasOwn(NODE_ENV_READS, path));
  assert.deepEqual(unknown, [], `direct NODE_ENV reads bypass config.production in hub mode: ${unknown.join(', ')}`);
});

test('audit: the hub never takes a development branch even when started with NODE_ENV=test', () => {
  const env = hubEnv({ NODE_ENV: 'test' });
  const config = configuration(env);
  assert.equal(config.production, true);
  // customer-egress, agent-model-runtime and traffic/landing read productionSemantics(), which is config.production.
  for (const sample of [env, hubEnv({ NODE_ENV: 'production' }), { NODE_ENV: 'test' }, { NODE_ENV: 'development' }]) {
    assert.equal(productionSemantics(sample), configuration(sample).production);
  }
  assert.equal(productionSemantics({ SMARTSELL_MODE: 'hub', NODE_ENV: 'test' }), true);
  assert.equal(config.allowLoopbackWebhook, false);
  assert.equal(config.localSetupOrigins, undefined);
  assert.equal(config.generatedSecret, false, 'bootstrap never derives the development secret');
  for (const [name, value] of HUB_FORBIDDEN_SWITCHES) assert.throws(() => configuration({ ...env, [name]: value }), HubConfigError);
});

// ---------- buildApp: trustProxy, 404 delegation, root guard (§2.4) ----------

function webFixture(t: TestContext) {
  const root = temp(t, 'smartsell-web-');
  const dist = join(root, 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  mkdirSync(join(dist, 'fonts'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>SmartSell</title><div id="root"></div>');
  writeFileSync(join(dist, 'assets', 'index-AbCd1234.js'), 'console.log("app")');
  writeFileSync(join(dist, 'assets', 'plain.css'), 'body{}');
  writeFileSync(join(dist, 'fonts', 'inter.woff2'), 'woff2');
  writeFileSync(join(root, 'hub.env'), 'APP_SECRET=never-served');
  mkdirSync(join(root, 'outside'));
  writeFileSync(join(root, 'outside', 'secret.txt'), 'never-served');
  symlinkSync(join(root, 'outside'), join(dist, 'assets', 'link'));
  return { root, dist };
}

function app(t: TestContext, extra: Partial<Parameters<typeof buildApp>[0]> = {}) {
  const built = buildApp({ origins: new Set([ORIGIN]), setupToken, secureCookie: true, store: new MemoryStore(), registry: new Map(), ...extra });
  t.after(() => built.app.close());
  return built;
}

test('trustProxy 127.0.0.1: request.ip is the X-Forwarded-For client, so login throttling is per tailnet peer', async t => {
  const { app: hub } = app(t, { trustProxy: '127.0.0.1', requestTimeoutMs: 120_000 });
  hub.get('/__ip', async request => ({ ip: request.ip, protocol: request.protocol }));
  const ip = async (remoteAddress: string, forwarded?: string) => (await hub.inject({ url: '/__ip', remoteAddress,
    headers: forwarded ? { 'x-forwarded-for': forwarded, 'x-forwarded-proto': 'https' } : {} })).json();
  assert.deepEqual(await ip('127.0.0.1', '100.101.102.103'), { ip: '100.101.102.103', protocol: 'https' });
  assert.equal((await ip('100.64.0.9', '1.2.3.4')).ip, '100.64.0.9', 'an untrusted peer cannot spoof X-Forwarded-For');
  assert.equal((hub.initialConfig as { requestTimeout?: number }).requestTimeout, 120_000);

  const { app: dev } = app(t);
  dev.get('/__ip', async request => ({ ip: request.ip }));
  assert.equal((await dev.inject({ url: '/__ip', remoteAddress: '127.0.0.1', headers: { 'x-forwarded-for': '100.101.102.103' } })).json().ip, '127.0.0.1');
  assert.equal((dev.initialConfig as { requestTimeout?: number }).requestTimeout, 30_000);

  const login = (forwarded: string) => hub.inject({ method: 'POST', url: '/api/v1/session', remoteAddress: '127.0.0.1',
    headers: { 'x-forwarded-for': forwarded, origin: ORIGIN }, payload: { username: 'nobody', password: 'wrong-password' } });
  for (let attempt = 0; attempt < 10; attempt++) assert.equal((await login('100.64.0.1')).statusCode, 401);
  assert.equal((await login('100.64.0.1')).statusCode, 429);
  assert.equal((await login('100.64.0.2')).statusCode, 401, 'another tailnet peer is not throttled');
});

test('notFound delegation: /api, /mcp, /agent keep the JSON 404; SPA paths get index.html; one 404 handler', async t => {
  const { dist } = webFixture(t);
  const web = webStatic(dist);
  const { app: hub } = app(t, { notFound: web.notFound });
  web.routes(hub);
  assert.throws(() => hub.setNotFoundHandler(() => undefined), /Not found handler already set/, 'Fastify allows one root 404 handler');
  await hub.ready();
  for (const url of ['/api/v1/nope', '/api', '/mcp', '/mcp/x', '/agent/relay.mjs', '/agent', '/unknown', '/app.js', '/setup/extra', '/%61pi/x']) {
    const response = await hub.inject({ url });
    assert.equal(response.statusCode, 404, url);
    assert.deepEqual(response.json(), { error: { code: 'not_found', message: 'Resource not found' } }, url);
  }
  for (const url of ['/', '/setup', '/setup?x=1', '/login', '/worker-connect', '/agent-connect', '/app', '/app/ws/today', '/w/ws/home']) {
    const response = await hub.inject({ url });
    assert.equal(response.statusCode, 200, url);
    assert.match(response.headers['content-type'] as string, /^text\/html/);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['content-security-policy'], WEB_CSP);
    assert.match(response.body, /<title>SmartSell<\/title>/);
  }
  assert.equal((await hub.inject({ method: 'HEAD', url: '/login' })).statusCode, 200);
  assert.equal((await hub.inject({ method: 'DELETE', url: '/setup', headers: { origin: ORIGIN } })).statusCode, 404);
  assert.equal(isReservedApiPath('/api/v1/x?y'), true);
  assert.equal(isReservedApiPath('//api/v1/x'), true);
  assert.equal(isReservedApiPath('/agent-connect'), false);
  assert.equal(isSpaPath('/application'), false);

  // Development mode (no delegate) keeps the JSON 404 for every path.
  const { app: devApp } = app(t);
  assert.equal((await devApp.inject({ url: '/' })).statusCode, 404);
  assert.deepEqual((await devApp.inject({ url: '/setup' })).json(), { error: { code: 'not_found', message: 'Resource not found' } });
});

test('root guard: PUT octet-stream passes; non-JSON POST is 415 unless the route opts in with RAW_BODY_ROUTE', async t => {
  const { app: hub } = app(t, { trustProxy: '127.0.0.1' });
  await hub.register(async scope => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 9 * 1024 * 1024 }, (_request, body, done) => done(null, body));
    const echo = async (request: { body: unknown }) => ({ bytes: (request.body as Buffer).byteLength });
    scope.put('/api/v1/agent/uploads/:id/parts/:n', echo);
    scope.put('/api/v1/device/evidence/:job_id', echo);
    scope.post('/api/v1/fixture/raw', RAW_BODY_ROUTE, echo);
    scope.post('/api/v1/fixture/json-only', echo);
  });
  const bytes = randomBytes(64 * 1024);
  for (const url of ['/api/v1/agent/uploads/u1/parts/0', '/api/v1/device/evidence/j1']) {
    const response = await hub.inject({ method: 'PUT', url, headers: { 'content-type': 'application/octet-stream' }, payload: bytes });
    assert.equal(response.statusCode, 200, url);
    assert.deepEqual(response.json(), { bytes: bytes.length });
  }
  const post = (url: string, origin?: string) => hub.inject({ method: 'POST', url, payload: bytes,
    headers: { 'content-type': 'application/octet-stream', ...(origin ? { origin } : {}) } });
  assert.equal((await post('/api/v1/fixture/json-only')).statusCode, 415);
  assert.equal((await post('/api/v1/fixture/raw')).statusCode, 200);
  assert.equal((await post('/api/v1/fixture/raw', 'https://evil.example')).statusCode, 403, 'the origin check still applies');
  assert.equal((await hub.inject({ method: 'PUT', url: '/api/v1/device/evidence/j1', payload: bytes,
    headers: { 'content-type': 'application/octet-stream', origin: 'https://evil.example' } })).statusCode, 403);
});

// ---------- static files (§2.6) ----------

test('static files: hashed assets are immutable, MIME by extension, and nothing escapes dist', async t => {
  const { root, dist } = webFixture(t);
  const web = webStatic(dist);
  const { app: hub } = app(t, { notFound: web.notFound });
  web.routes(hub);
  const hashed = await hub.inject({ url: '/assets/index-AbCd1234.js' });
  assert.equal(hashed.statusCode, 200);
  assert.equal(hashed.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(hashed.headers['content-type'], 'text/javascript; charset=utf-8');
  const plain = await hub.inject({ url: '/assets/plain.css' });
  assert.equal(plain.headers['cache-control'], 'public, max-age=0, must-revalidate');
  assert.equal(plain.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal((await hub.inject({ url: '/fonts/inter.woff2' })).headers['content-type'], 'font/woff2');
  assert.equal((await hub.inject({ method: 'HEAD', url: '/assets/plain.css' })).statusCode, 200);
  for (const url of ['/assets/../../hub.env', '/assets/%2e%2e/%2e%2e/hub.env', '/assets/..%2f..%2fhub.env', '/assets/%2E%2E%5C%2E%2E%5Chub.env',
    '/assets/..\\..\\hub.env', '/assets/link/secret.txt', '/assets/.hidden', '/assets/', '/assets/%00index.js', '/fonts/../index.html',
    '/assets//etc/passwd', '/assets/C:%5Cwindows']) {
    const response = await hub.inject({ url });
    assert.ok(response.statusCode === 404 || response.statusCode === 400, `${url} → ${response.statusCode}`);
    assert.doesNotMatch(response.body, /never-served/, url);
  }
  assert.equal(safeStaticPath(join(dist, 'assets'), '../index.html'), undefined);
  assert.equal(safeStaticPath(join(dist, 'assets'), 'link/secret.txt'), undefined, 'symlinks out of dist are refused');
  assert.ok(safeStaticPath(join(dist, 'assets'), 'plain.css'));
  assert.equal(readFileSync(join(root, 'hub.env'), 'utf8'), 'APP_SECRET=never-served');

  const favicon = await hub.inject({ url: '/favicon.ico' });
  assert.equal(favicon.statusCode, 204, 'no favicon in dist → 204, not 404 (A23)');
  writeFileSync(join(dist, 'favicon.ico'), 'ico');
  const present = await hub.inject({ url: '/favicon.ico' });
  assert.equal(present.statusCode, 200);
  assert.equal(present.headers['content-type'], 'image/x-icon');

  rmSync(join(dist, 'index.html'));
  const missing = await hub.inject({ url: '/setup' });
  assert.equal(missing.statusCode, 503, 'an unbuilt Web app is an explicit error, never an empty page');
  assert.equal(missing.json().error.code, 'web_not_built');
});

// ---------- /api/v1/hub/info (§2.7, §2.12) ----------

test('GET /api/v1/hub/info requires a session and reports origin, tailscale and Worker downloads', async t => {
  const downloads = temp(t, 'smartsell-downloads-');
  const pkg = randomBytes(2048);
  writeFileSync(join(downloads, 'SmartSell-Worker-0.2.0-arm64.dmg'), pkg);
  writeFileSync(join(downloads, 'latest-mac-arm64.json'), JSON.stringify({ version: '0.2.0', platform: 'mac-arm64', file: 'SmartSell-Worker-0.2.0-arm64.dmg',
    sha256: 'a'.repeat(64), bytes: pkg.length, built_at: '2026-11-24T00:00:00Z' }));
  writeFileSync(join(downloads, 'SmartSell-Worker-win-x64.exe'), 'legacy');
  const config = configuration(hubEnv({ SMARTSELL_WORKER_DOWNLOAD_DIR: downloads }));
  const { app: hub, requireSession } = app(t, { trustProxy: '127.0.0.1', workerDownloadDirectory: downloads });
  let snapshot: ReturnType<Parameters<typeof registerHubInfo>[1]['tailscale']['snapshot']> = { serve_ok: true, key_expiry: null, checked_at: '2026-11-24T10:00:00.000Z' };
  registerHubInfo(hub, { config, requireSession, version: '0.2.0', tailscale: { snapshot: () => snapshot } });
  assert.equal((await hub.inject({ url: '/api/v1/hub/info' })).statusCode, 401);
  const setup = await hub.inject({ method: 'POST', url: '/api/v1/setup', headers: { origin: ORIGIN, 'x-setup-token': setupToken },
    payload: { username: 'owner', password: 'a disposable fixture password', workspaceName: 'Shop' } });
  assert.equal(setup.statusCode, 201);
  const cookie = String(setup.headers['set-cookie']).split(';')[0];
  const info = await hub.inject({ url: '/api/v1/hub/info', headers: { cookie, origin: ORIGIN } });
  assert.equal(info.statusCode, 200);
  const { data, ...top } = info.json();
  assert.deepEqual(data, top, 'the same object is mirrored under data');
  assert.deepEqual(top, {
    mode: 'hub', public_origin: ORIGIN, version: '0.2.0', request_origin_ok: true,
    // E46 (SEC-3): funnel_on/funnel_warning added for the setup wizard.
    tailscale: { serve_ok: true, key_expiry: null, checked_at: '2026-11-24T10:00:00.000Z', funnel_on: false, funnel_warning: null },
    latest_worker: { version: '0.2.0', platforms: ['mac-arm64'] },
    worker_downloads: [
      { platform: 'mac-arm64', url: '/api/v1/worker-downloads/mac-arm64', version: '0.2.0', sha256: 'a'.repeat(64) },
      { platform: 'win-x64', url: '/api/v1/worker-downloads/win-x64', version: null, sha256: null },
    ],
  });
  // E46: a Funnel that exposes the hub reaches the wizard with the owner sentence that turns it off.
  snapshot = { ...snapshot, funnel_on: true, funnel_warning: '中樞被 Tailscale Funnel 公開到網際網路（https://hub.tail1234.ts.net）' };
  assert.deepEqual((await hub.inject({ url: '/api/v1/hub/info', headers: { cookie, origin: ORIGIN } })).json().tailscale, { serve_ok: true,
    key_expiry: null, checked_at: '2026-11-24T10:00:00.000Z', funnel_on: true, funnel_warning: '中樞被 Tailscale Funnel 公開到網際網路（https://hub.tail1234.ts.net）' });
  snapshot = { serve_ok: null, key_expiry: null, checked_at: null };
  assert.equal((await hub.inject({ url: '/api/v1/hub/info', headers: { cookie, origin: ORIGIN } })).json().tailscale.funnel_on, null, 'not checked yet');
  assert.equal((await hub.inject({ url: '/api/v1/hub/info', headers: { cookie, host: 'hub.tail1234.ts.net' } })).json().request_origin_ok, true);
  assert.equal((await hub.inject({ url: '/api/v1/hub/info', headers: { cookie, host: '127.0.0.1:3401' } })).json().request_origin_ok, false);
  assert.equal((await hub.inject({ url: '/api/v1/hub/info', headers: { cookie, origin: 'http://127.0.0.1:5173' } })).json().request_origin_ok, false);

  // Worker downloads: the session path, then a device-signed request through the S3 hook.
  const download = await hub.inject({ url: '/api/v1/worker-downloads/mac-arm64', headers: { cookie } });
  assert.equal(download.statusCode, 200);
  assert.equal(download.headers['content-type'], 'application/x-apple-diskimage');
  assert.equal(download.headers['x-smartsell-sha256'], 'a'.repeat(64));
  assert.equal(download.rawPayload.length, pkg.length);
  const deviceHeaders = { 'x-smartsell-device': 'd1', 'x-smartsell-timestamp': new Date().toISOString(), 'x-smartsell-nonce': 'n'.repeat(22),
    'x-smartsell-signature': 's'.repeat(86), 'x-smartsell-workspace': '00000000-0000-4000-8000-000000000001' };
  const unavailable = await hub.inject({ url: '/api/v1/worker-downloads/mac-arm64', headers: deviceHeaders });
  assert.equal(unavailable.statusCode, 503, 'no fake success when signed downloads are not wired');
  assert.equal(unavailable.json().error.code, 'DEVICE_AUTH_UNAVAILABLE');
  const actions: string[] = [];
  provideWorkerDownloadDeviceAuth(hub, async (_request, action) => {
    actions.push(action);
    if (actions.length > 1) throw new Problem(401, 'INVALID_DEVICE_PROOF', 'Invalid device proof');
    return { device_id: 'd1' };
  });
  assert.equal((await hub.inject({ url: '/api/v1/worker-downloads/mac-arm64', headers: deviceHeaders })).statusCode, 200);
  assert.equal((await hub.inject({ url: '/api/v1/worker-downloads/mac-arm64', headers: deviceHeaders })).statusCode, 401);
  assert.deepEqual(actions, ['worker_download.read:mac-arm64', 'worker_download.read:mac-arm64']);
  assert.equal((await hub.inject({ url: '/api/v1/worker-downloads/mac-arm64' })).statusCode, 401, 'no session, no signature');

  // A manifest that does not match the file on disk is never served.
  writeFileSync(join(downloads, 'SmartSell-Worker-0.2.0-arm64.dmg'), pkg.subarray(0, 100));
  const incomplete = await hub.inject({ url: '/api/v1/worker-downloads/mac-arm64', headers: { cookie } });
  assert.equal(incomplete.statusCode, 503);
  assert.equal(incomplete.json().error.code, 'WORKER_PACKAGE_INCOMPLETE');
  assert.deepEqual((await hub.inject({ url: '/api/v1/worker-downloads', headers: { cookie } })).json().data.map((item: { platform: string }) => item.platform), ['win-x64']);
});

// ---------- hub.env (§2.5 step 1) ----------

test('hub.env: only allow-listed keys are read, existing env wins, merge keeps values and mode 0600', t => {
  const parsed = parseHubEnv([
    '# comment', '', 'APP_SECRET=abc', 'PUBLIC_ORIGIN="https://hub.tail1234.ts.net"', 'export PORT=3401', 'HOST=0.0.0.0',
    'DATABASE_URL=postgres://x', 'NODE_ENV=development', 'SMARTSELL_MODE=dev', 'APP_SECRET=second', 'not a pair',
    'SMARTSELL_DATA_FILE=/Users/o/Library/Application Support/SmartSell Hub/smartsell.sqlite',
  ].join('\n'));
  assert.deepEqual(parsed.values, { APP_SECRET: 'abc', PUBLIC_ORIGIN: 'https://hub.tail1234.ts.net', PORT: '3401',
    SMARTSELL_DATA_FILE: '/Users/o/Library/Application Support/SmartSell Hub/smartsell.sqlite' });
  assert.deepEqual(parsed.ignored, ['HOST', 'DATABASE_URL', 'NODE_ENV', 'SMARTSELL_MODE']);
  assert.deepEqual(parsed.invalidLines, [11]);
  assert.deepEqual([...HUB_ENV_KEYS].sort(), ['APP_SECRET', 'MEDIA_DIRECTORY', 'PORT', 'PUBLIC_ORIGIN', 'SETUP_TOKEN', 'SMARTSELL_DATA_FILE',
    'SMARTSELL_MAX_UPLOAD_BYTES', 'SMARTSELL_WEB_DIST']);

  const env: NodeJS.ProcessEnv = { PORT: '9999' };
  assert.deepEqual(applyHubEnv(parsed.values, env), ['APP_SECRET', 'PUBLIC_ORIGIN', 'SMARTSELL_DATA_FILE']);
  assert.equal(env.PORT, '9999', 'an already-set variable is not overridden');
  assert.equal(env.HOST, undefined);

  const dir = temp(t);
  const first = mergeHubEnv(dir, { APP_SECRET: 'one', SETUP_TOKEN: 'two', PUBLIC_ORIGIN: ORIGIN, PORT: '3401' });
  assert.deepEqual(first.added, ['APP_SECRET', 'SETUP_TOKEN', 'PUBLIC_ORIGIN', 'PORT']);
  if (process.platform !== 'win32') assert.equal(statSync(first.path).mode & 0o777, 0o600);
  const second = mergeHubEnv(dir, { APP_SECRET: 'changed', SETUP_TOKEN: 'changed', PUBLIC_ORIGIN: 'https://other.tail1.ts.net', MEDIA_DIRECTORY: '/m' });
  assert.deepEqual(second.kept, ['APP_SECRET', 'SETUP_TOKEN', 'PUBLIC_ORIGIN']);
  assert.deepEqual(second.added, ['MEDIA_DIRECTORY']);
  assert.deepEqual(readHubEnvFile(dir).values, { APP_SECRET: 'one', SETUP_TOKEN: 'two', PUBLIC_ORIGIN: ORIGIN, PORT: '3401', MEDIA_DIRECTORY: '/m' });
  assert.throws(() => mergeHubEnv(dir, { SMARTSELL_WEB_DIST: 'a\nHOST=0.0.0.0' }), /換行/);
});

test('prepareHubEnvironment: fixed hub mode, NODE_ENV=production unless test, and a group-readable hub.env is an error', t => {
  const dir = temp(t);
  writeFileSync(join(dir, 'hub.env'), `APP_SECRET=${secret}\nHOST=0.0.0.0\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'development', SMARTSELL_MODE: 'other' };
  const prepared = prepareHubEnvironment(['--hub-dir', dir], env, 'darwin');
  assert.equal(env.NODE_ENV, 'production');
  assert.equal(env.SMARTSELL_MODE, 'hub');
  assert.equal(env.SMARTSELL_HUB_DIR, dir);
  assert.equal(env.APP_SECRET, secret);
  assert.equal(env.HOST, undefined, 'HOST is not an allowed hub.env key');
  assert.deepEqual(prepared.issues.map(issue => issue.code), ['HUB_ENV_IGNORED_KEYS']);
  const testEnv: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  prepareHubEnvironment(['--hub-dir', dir], testEnv, 'darwin');
  assert.equal(testEnv.NODE_ENV, 'test');
  if (process.platform !== 'win32') {
    chmodSync(join(dir, 'hub.env'), 0o644);
    assert.ok(prepareHubEnvironment(['--hub-dir', dir], {}, 'darwin').issues.some(issue => issue.code === 'HUB_ENV_NOT_PRIVATE'));
  }
});

// ---------- startup checks and status.json (§2.5 steps 4–6) ----------

const okExec: Exec = async () => ({ code: 0, stdout: '', stderr: '' });
const missingExec: Exec = async () => ({ code: -1, stdout: '', stderr: '', error: 'ENOENT' });

test('data directory check: 0700 on POSIX; Windows skips mode bits and requires %LOCALAPPDATA%', () => {
  const dir = (mode: number) => () => ({ mode, isDirectory: () => true });
  assert.equal(dataDirectoryIssue('/hub', { platform: 'darwin', stat: dir(0o40700) }), undefined);
  assert.equal(dataDirectoryIssue('/hub', { platform: 'darwin', stat: dir(0o40755) })?.code, 'HUB_DIR_NOT_PRIVATE');
  assert.match(dataDirectoryIssue('/hub', { platform: 'linux', stat: dir(0o40750) })!.message, /chmod 700/);
  const local = 'C:\\Users\\o\\AppData\\Local';
  assert.equal(dataDirectoryIssue('C:\\Users\\o\\AppData\\Local\\SmartSell Hub', { platform: 'win32', env: { LOCALAPPDATA: local }, stat: dir(0o40777) }),
    undefined, 'Windows has no POSIX mode bits; 0777 is not an error there');
  assert.equal(dataDirectoryIssue('c:\\users\\o\\appdata\\local\\SmartSell Hub', { platform: 'win32', env: { LOCALAPPDATA: local }, stat: dir(0o40777) }), undefined);
  assert.equal(dataDirectoryIssue('D:\\Shared\\SmartSell Hub', { platform: 'win32', env: { LOCALAPPDATA: local }, stat: dir(0o40700) })?.code, 'HUB_DIR_NOT_PRIVATE');
  assert.equal(dataDirectoryIssue('C:\\Users\\o\\AppData\\LocalLow\\x', { platform: 'win32', env: { LOCALAPPDATA: local }, stat: dir(0o40700) })?.code, 'HUB_DIR_NOT_PRIVATE');
  assert.equal(dataDirectoryIssue('/missing', { platform: 'darwin', stat: () => undefined })?.code, 'HUB_DIR_MISSING');
});

test('runHubChecks: missing Web dist is an error, missing ffprobe only a warning', async t => {
  const dir = temp(t);
  chmodSync(dir, 0o700);
  const { dist } = webFixture(t);
  const config = { hubDirectory: dir, statePath: join(dir, 'smartsell.sqlite'), webDistDirectory: dist };
  assert.deepEqual(await runHubChecks(config, { exec: okExec }), []);
  const issues = await runHubChecks({ ...config, webDistDirectory: join(dir, 'nope') }, { exec: missingExec });
  assert.deepEqual(issues.map(issue => [issue.level, issue.code]), [['error', 'HUB_WEB_NOT_BUILT'], ['warn', 'HUB_FFPROBE_MISSING']]);
});

function hubDirFixture(t: TestContext, values: Record<string, string>) {
  const dir = temp(t);
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, 'hub.env'), Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
  return dir;
}

test('a configuration error writes status.json and returns config_error (exit code 0); --check does not touch status.json', async t => {
  const dir = hubDirFixture(t, { APP_SECRET: secret, PUBLIC_ORIGIN: 'http://hub.tail1234.ts.net' });
  const lines: string[] = [];
  const start = async () => { throw new Error('start must not be called on a configuration error'); };
  const result = await hubMain(['--hub-dir', dir], { env: {}, exec: okExec, log: line => lines.push(line), start: start as never,
    now: () => new Date('2026-11-24T10:00:00.000Z') });
  assert.equal(result.outcome, 'config_error');
  const status = readHubStatus(dir);
  assert.equal(status.status, 'ok');
  assert.equal(status.status === 'ok' && status.value.state, 'config_error');
  assert.equal(status.status === 'ok' && status.value.code, 'HUB_PUBLIC_ORIGIN_NOT_HTTPS');
  assert.equal(status.status === 'ok' && status.value.at, '2026-11-24T10:00:00.000Z');
  assert.match(lines.join('\n'), /PUBLIC_ORIGIN 必須是 https/);

  const unknownArgument = await hubMain(['--hub-dir', dir, '--bogus'], { env: {}, exec: okExec, log: () => {}, start: start as never });
  assert.equal(unknownArgument.outcome, 'config_error', 'bad arguments exit 0 too, never a restart loop');

  rmSync(join(dir, 'status.json'));
  const checked = await hubMain(['--check', '--hub-dir', dir], { env: {}, exec: okExec, log: () => {}, start: start as never });
  assert.equal(checked.outcome, 'check_failed');
  assert.equal(readHubStatus(dir).status, 'missing');
});

test('hubMain wiring: start receives notFound and beforeListen mounts static files and /api/v1/hub/info', async t => {
  const { dist } = webFixture(t);
  const dir = hubDirFixture(t, { APP_SECRET: secret, SETUP_TOKEN: setupToken, PUBLIC_ORIGIN: ORIGIN, PORT: '3401', SMARTSELL_WEB_DIST: dist });
  let instance: FastifyInstance | undefined;
  const env: NodeJS.ProcessEnv = { SMARTSELL_TAILSCALE_CLI: join(dir, 'no-such-tailscale') };
  const result = await hubMain(['--hub-dir', dir], {
    env, exec: okExec, log: () => {},
    start: (async (config: ReturnType<typeof configuration>, hooks: Parameters<typeof import('../bootstrap.js').start>[1] = {}) => {
      assert.equal(config.hub, true);
      assert.equal(config.statePath, join(dir, 'smartsell.sqlite'));
      const built = buildApp({ origins: config.origins, setupToken: config.setupToken, secureCookie: config.secureCookie, store: new MemoryStore(),
        registry: new Map(), trustProxy: config.trustProxy, requestTimeoutMs: config.requestTimeoutMs, notFound: hooks.notFound });
      await hooks.beforeListen?.(built.app, { config, requireSession: built.requireSession });
      await built.app.ready();
      instance = built.app;
      return built.app;
    }) as never,
  });
  assert.equal(result.outcome, 'running');
  // §6.7: media follows the data file through config.mediaDirectory (S5 reads it); the hub no longer bridges it through env.
  assert.equal(result.outcome === 'running' && result.config.mediaDirectory, join(dir, 'media'));
  assert.equal(env.MEDIA_DIRECTORY, undefined, 'no MEDIA_DIRECTORY bridge');
  assert.equal(env.NODE_ENV, 'production');
  const status = readHubStatus(dir);
  assert.equal(status.status === 'ok' && status.value.state, 'running');
  assert.equal((await instance!.inject({ url: '/' })).statusCode, 200);
  assert.equal((await instance!.inject({ url: '/api/v1/hub/info' })).statusCode, 401);
  assert.equal((await instance!.inject({ url: '/api/v1/nothing' })).statusCode, 404);
  if (result.outcome === 'running') await result.stop();
  const stopped = readHubStatus(dir);
  assert.equal(stopped.status === 'ok' && stopped.value.state, 'stopped');
});

test('AO-1: --check --load loads the code and decodes a copy of the data; a plain --check does not; the live file is untouched', async t => {
  const { dist } = webFixture(t);
  const dir = hubDirFixture(t, { APP_SECRET: secret, SETUP_TOKEN: setupToken, PUBLIC_ORIGIN: ORIGIN, SMARTSELL_WEB_DIST: dist });
  const start = async () => { throw new Error('a check never starts the hub'); };
  const failing = async () => ['publishing 的操作載入失敗：Cannot find module ./new-helper.js'];
  const lines: string[] = [];
  // The old --check returned "checked" before any server module was loaded (startup.ts); it still does without --load.
  assert.equal((await hubMain(['--check', '--hub-dir', dir], { env: {}, exec: okExec, log: () => {}, start: start as never, loadModules: failing })).outcome, 'checked');
  const broken = await hubMain(['--check', '--hub-dir', dir, '--load'], { env: {}, exec: okExec, log: line => lines.push(line), start: start as never, loadModules: failing });
  assert.equal(broken.outcome, 'check_failed');
  assert.equal(broken.outcome === 'check_failed' && broken.issues.find(issue => issue.level === 'error')?.code, 'HUB_LOAD_FAILED');
  assert.match(lines.join('\n'), /這個版本的中樞程式載入失敗：publishing 的操作載入失敗/);
  // Data the new code cannot decode: refused, and only a private copy was opened.
  const data = join(dir, 'smartsell.sqlite');
  const db = new DatabaseSync(data);
  db.exec("CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL); INSERT INTO snapshot VALUES (1, 'not the snapshot format')");
  db.close();
  chmodSync(data, 0o600);
  const before = readFileSync(data);
  const unreadable = await hubMain(['--check', '--hub-dir', dir, '--load'], { env: {}, exec: okExec, log: () => {}, start: start as never, loadModules: async () => [] });
  assert.equal(unreadable.outcome === 'check_failed' && unreadable.issues.find(issue => issue.level === 'error')?.code, 'HUB_DATA_UNREADABLE');
  assert.deepEqual(readFileSync(data), before, 'the live data file is never opened for writing');
  assert.deepEqual(readdirSync(join(dir, 'backups')).filter(name => name.startsWith('.load-check-')), [], 'the copy is removed');
});

// ---------- the real entry point as a process ----------

function run(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 60_000) {
  return new Promise<{ code: number | null; output: string }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(serverRoot, 'hub.ts'), ...args], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`hub.ts timed out:\n${output}`)); }, timeoutMs);
    child.once('exit', code => { clearTimeout(timer); resolvePromise({ code, output }); });
  });
}

const baseEnv = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'C.UTF-8' });

test('hub.ts process: a configuration error exits 0 with status.json; --check exits 1', async t => {
  const dir = hubDirFixture(t, { PUBLIC_ORIGIN: ORIGIN });   // no APP_SECRET
  const result = await run(['--hub-dir', dir], baseEnv());
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /APP_SECRET/);
  const status = readHubStatus(dir);
  assert.equal(status.status === 'ok' && status.value.state, 'config_error');
  assert.equal(status.status === 'ok' && status.value.code, 'HUB_APP_SECRET_INVALID');
  const check = await run(['--check', '--hub-dir', dir], baseEnv());
  assert.equal(check.code, 1, check.output);
});

async function freePort() {
  return new Promise<number>((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolvePromise(port));
    });
  });
}

test('hub.ts process: boots the real server with production semantics under NODE_ENV=test (E2E configuration)', async t => {
  const { dist } = webFixture(t);
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const dir = hubDirFixture(t, { APP_SECRET: secret, SETUP_TOKEN: setupToken, PUBLIC_ORIGIN: origin, PORT: String(port), SMARTSELL_WEB_DIST: dist });
  // A fake Tailscale CLI: the test never runs the real binary.
  const fakeCli = join(dir, 'fake-tailscale');
  writeFileSync(fakeCli, `#!/bin/sh\nif [ "$1" = "status" ]; then echo '{"BackendState":"Running","Self":{"DNSName":"hub.tail1234.ts.net."}}'; exit 0; fi\n` +
    `if [ "$1" = "serve" ]; then echo '{"TCP":{"443":{"HTTPS":true}},"Web":{"hub.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:${port}"}}}}}'; exit 0; fi\nexit 1\n`, { mode: 0o755 });
  const child = spawn(process.execPath, ['--import', 'tsx', join(serverRoot, 'hub.ts'), '--hub-dir', dir], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...baseEnv(), NODE_ENV: 'test', SMARTSELL_HUB_TEST_HTTP: '1', SMARTSELL_TAILSCALE_CLI: fakeCli } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = new Promise<number | null>(resolvePromise => child.once('exit', code => resolvePromise(code)));
  t.after(() => { child.kill('SIGKILL'); });
  let ready = false;
  for (let attempt = 0; attempt < 120 && !ready; attempt++) {
    if (child.exitCode !== null) break;
    ready = await fetch(`${origin}/readyz`).then(response => response.ok, () => false);
    if (!ready) await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
  }
  assert.ok(ready, `hub did not become ready:\n${output}`);
  const status = readHubStatus(dir);
  assert.equal(status.status === 'ok' && status.value.state, 'running', output);
  const page = await fetch(`${origin}/setup`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-security-policy'), WEB_CSP);
  assert.equal((await fetch(`${origin}/api/v1/hub/info`)).status, 401);
  assert.equal((await fetch(`${origin}/api/v1/nope`)).status, 404);
  assert.equal((await fetch(`${origin}/assets/index-AbCd1234.js`)).headers.get('cache-control'), 'public, max-age=31536000, immutable');
  // Production semantics: setup needs the token; development origins are rejected.
  const setupStatus = await (await fetch(`${origin}/api/v1/setup/status`)).json();
  assert.equal(setupStatus.data.token_required, true);
  const devOrigin = await fetch(`${origin}/api/v1/session`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:5173' },
    body: JSON.stringify({ username: 'x', password: 'y' }) });
  assert.equal(devOrigin.status, 403);
  const setup = await fetch(`${origin}/api/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json', origin, 'x-setup-token': setupToken },
    body: JSON.stringify({ username: 'owner', password: 'a disposable fixture password', workspaceName: 'Shop' }) });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get('set-cookie')!.split(';')[0];
  assert.doesNotMatch(setup.headers.get('set-cookie')!, /Secure/, 'test HTTP exception turns Secure cookies off');
  const info = await (await fetch(`${origin}/api/v1/hub/info`, { headers: { cookie, origin } })).json();
  assert.equal(info.mode, 'hub');
  assert.equal(info.public_origin, origin);
  assert.equal(info.request_origin_ok, true);
  assert.equal(info.tailscale.serve_ok, true, `checked through the fake CLI: ${JSON.stringify(info.tailscale)}\n${output}`);
  assert.doesNotMatch(output, /FST_ERR_REP_ALREADY_SENT|Reply was already sent/, 'every route sends exactly one reply');
  assert.ok(existsSync(join(dir, 'smartsell.sqlite')), 'data lives in the hub directory');
  assert.equal(statSync(join(dir, 'smartsell.sqlite')).mode & 0o077, 0);
  child.kill('SIGTERM');
  const code = await Promise.race([exited, new Promise(resolvePromise => setTimeout(() => resolvePromise('timeout'), 20_000))]);
  assert.equal(code, 0, `graceful stop:\n${output}`);
  const stopped = readHubStatus(dir);
  assert.equal(stopped.status === 'ok' && stopped.value.state, 'stopped');
});

test('AO-1: the real hub.ts --check --load loads every module with production semantics and reads the data copy', async t => {
  const { dist } = webFixture(t);
  const dir = hubDirFixture(t, { APP_SECRET: secret, SETUP_TOKEN: setupToken, PUBLIC_ORIGIN: ORIGIN, SMARTSELL_WEB_DIST: dist });
  const store = localStore(join(dir, 'smartsell.sqlite'));
  await store.setup({ username: 'owner', name: 'Owner', workspaceName: 'Shop', passwordHash: 'unused' }, 'a'.repeat(64));
  await store.close();
  const result = await run(['--check', '--hub-dir', dir, '--load'], baseEnv(), 120_000);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /程式與資料都能以這個版本載入/);
});

test('AO-2: hub.ts --supervise ends with the hub on a configuration error (exit 0, no restart loop)', async t => {
  const dir = hubDirFixture(t, { PUBLIC_ORIGIN: ORIGIN });   // no APP_SECRET
  const result = await run(['--supervise', '--hub-dir', dir], baseEnv());
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /不再重新啟動/);
  const status = readHubStatus(dir);
  assert.equal(status.status === 'ok' && status.value.state, 'config_error');
});

test('AO-2: under the supervisor the hub stops gracefully when the supervisor is stopped, and when it is killed outright', async t => {
  const { dist } = webFixture(t);
  for (const how of ['SIGTERM', 'SIGKILL'] as const) {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const dir = hubDirFixture(t, { APP_SECRET: secret, SETUP_TOKEN: setupToken, PUBLIC_ORIGIN: origin, PORT: String(port), SMARTSELL_WEB_DIST: dist });
    const supervisor = spawn(process.execPath, ['--import', 'tsx', join(serverRoot, 'hub.ts'), '--supervise', '--hub-dir', dir], { cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'], env: { ...baseEnv(), NODE_ENV: 'test', SMARTSELL_HUB_TEST_HTTP: '1', SMARTSELL_TAILSCALE_CLI: join(dir, 'no-cli') } });
    let output = '';
    supervisor.stdout.on('data', chunk => { output += chunk; });
    supervisor.stderr.on('data', chunk => { output += chunk; });
    const exited = new Promise<number | null>(resolvePromise => supervisor.once('exit', code => resolvePromise(code)));
    t.after(() => { supervisor.kill('SIGKILL'); });
    let ready = false;
    for (let attempt = 0; attempt < 120 && !ready; attempt++) {
      ready = await fetch(`${origin}/readyz`).then(response => response.ok, () => false);
      if (!ready) await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
    }
    assert.ok(ready, `supervised hub did not become ready:\n${output}`);
    const running = readHubStatus(dir);
    assert.ok(running.status === 'ok' && running.value.pid && running.value.pid !== supervisor.pid, 'the hub runs as a child of the supervisor');
    supervisor.kill(how);   // SIGKILL stands in for `schtasks /End` (TerminateProcess): no handler runs in the supervisor
    let stopped = false;
    for (let attempt = 0; attempt < 60 && !stopped; attempt++) {
      const status = readHubStatus(dir);
      stopped = status.status === 'ok' && status.value.state === 'stopped';
      if (!stopped) await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    }
    assert.ok(stopped, `${how}: the hub did not stop with its supervisor:\n${output}`);
    if (how === 'SIGTERM') assert.equal(await exited, 0, output);
  }
});

test('docs/hub-setup.md exists and names every hub command', () => {
  const doc = readFileSync(join(repoRoot, 'docs/hub-setup.md'), 'utf8');
  for (const command of ['install-hub.sh', 'install-hub.ps1', 'pnpm hub:init', 'pnpm hub:service install', 'pnpm hub:update', 'pnpm hub:doctor',
    'pnpm hub:export-legacy', 'RAW_BODY_ROUTE']) assert.ok(doc.includes(command), command);
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  for (const script of ['hub', 'hub:init', 'hub:service', 'hub:update', 'hub:doctor', 'hub:export-legacy', 'worker:release', 'test:e2e-phase1', 'real-model-check']) {
    assert.ok(pkg.scripts[script], script);
  }
  for (const target of Object.values(pkg.scripts).flatMap(script => script.match(/(?:apps|scripts)\/[\w/.-]+\.(?:ts|mjs)/g) ?? [])) {
    if (/hub|scripts\/(?:install-hub|hub-)/.test(target)) assert.ok(existsSync(resolve(repoRoot, target)), target);
  }
  assert.ok(dirname(fileURLToPath(import.meta.url)).endsWith(join('src', 'hub')));
});
