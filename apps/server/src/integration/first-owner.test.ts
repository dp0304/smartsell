import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from '../config.js';

const credentials = { username: '店主_One', password: '123456' };
const setupPath = '/api/v1/setup';
const statusPath = `${setupPath}/status`;
const sessionPath = '/api/v1/session';

/** Distinct free ports: all listeners stay open until every port is known, so the OS cannot hand out the same port twice. */
async function freePorts(count: number) {
  const servers = Array.from({ length: count }, () => createServer().listen(0, '127.0.0.1'));
  await Promise.all(servers.map(server => once(server, 'listening')));
  const ports = servers.map(server => {
    const address = server.address();
    assert(address && typeof address !== 'string');
    return address.port;
  });
  await Promise.all(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
  return ports;
}

async function start(entry: string, port: number, webPort: number, directory: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  const child = spawn(process.execPath, ['--import', 'tsx', entry, ...args], {
    cwd: new URL('../../../../', import.meta.url),
    env: { PATH: process.env.PATH, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port),
      SMARTSELL_DATA_FILE: join(directory, 'state'), MEDIA_DIRECTORY: join(directory, 'media'),
      SMARTSELL_VITE_CACHE_DIR: join(directory, 'vite'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await exited;
  };
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const origin = `http://127.0.0.1:${webPort}`;
  try {
    for (let attempt = 0; attempt < 150 && child.exitCode === null; attempt++) {
      const response = await fetch(`${origin}${statusPath}`).catch(() => undefined);
      if (response?.ok) return { origin, stop };
      await delay(100);
    }
    assert.fail(output || 'Setup status did not become available');
  } catch (error) {
    await stop();
    throw error;
  }
}

async function post(origin: string, path: string, input: object, headers?: Record<string, string>) {
  return fetch(`${origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(input),
  });
}

const kernelDatabase = process.env.KERNEL_SETUP_TEST_DATABASE_URL;
for (const mode of ['Commands via Vite', 'Kernel file', 'Kernel PostgreSQL'] as const) {
  const pg = mode === 'Kernel PostgreSQL';
  test(`${mode} creates one owner through the local HTTP entry and persists the username`,
    { skip: pg && !kernelDatabase, timeout: 45_000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'smartsell-first-owner-'));
    const [apiPort, otherPort] = await freePorts(2);
    const webPort = mode === 'Commands via Vite' ? otherPort : apiPort;
    const identityKey = pg ? randomBytes(32).toString('hex') : undefined;
    const launch = () => mode === 'Commands via Vite'
      ? start('apps/server/dev.ts', apiPort, webPort, dir, {}, ['--port', String(webPort), '--no-watch'])
      : start('apps/server/src/kernel-main.ts', apiPort, webPort, dir, {
        SMARTSELL_LOCAL_SETUP: '1', DATABASE_URL: pg ? kernelDatabase : undefined, IDENTITY_ENCRYPTION_KEY: identityKey,
      });
    let service: Awaited<ReturnType<typeof launch>> | undefined;
    t.after(async () => { await service?.stop(); await rm(dir, { recursive: true, force: true }); });
    service = await launch();
    const { origin } = service;
    const status = async (expected: object) => {
      const response = await fetch(`${origin}${statusPath}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { data: expected });
    };
    await status({ initialized: false, token_required: false, registration_enabled: true, password_min_length: 6 });
    assert.equal((await post(origin, setupPath, credentials, { origin: 'https://other.example' })).status, 403);
    assert.equal((await post(origin, setupPath, credentials, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await post(origin, setupPath, credentials, { 'x-forwarded-for': '127.0.0.1' })).status, 403);
    assert.equal((await fetch(`${origin}${setupPath}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials) })).status, 403);
    assert.equal((await post(origin, setupPath, { ...credentials, password: 'short' })).status, 422);
    const outcomes = await Promise.all([post(origin, setupPath, credentials), post(origin, setupPath, credentials)]);
    assert.deepEqual(outcomes.map(result => result.status).sort(), [201, 409]);
    const first = outcomes.find(result => result.status === 201)!;
    const cookie = first.headers.get('set-cookie')?.split(';')[0];
    assert(cookie);
    const setup = await first.json();
    const owner = setup.data;
    const expectedUser = { id: owner.user.id, name: '店主_one', username: '店主_one', email: '' };
    assert.deepEqual(owner.user, expectedUser);
    assert.deepEqual(setup.user, expectedUser);
    assert.equal(owner.workspaces.length, 1);
    assert.equal(owner.workspaces[0].name, 'SmartSell');
    assert.equal(owner.workspaces[0].role, 'owner');
    const session = await fetch(`${origin}${sessionPath}`, { headers: { cookie } });
    assert.equal(session.status, 200);
    const sessionBody = await session.json();
    assert.deepEqual(sessionBody.data.user, expectedUser);
    assert.deepEqual(sessionBody.user, expectedUser);
    await status({ initialized: true, token_required: false, registration_enabled: false, password_min_length: 6 });
    assert.equal((await post(origin, setupPath, { ...credentials, username: 'another-owner' })).status, 409);
    assert.equal((await post(origin, sessionPath, { ...credentials, password: 'incorrect-password' })).status, 401);
    await service.stop();
    service = await launch();
    const login = await post(origin, '/api/v1/login', { ...credentials, username: ' 店主_ＯＮＥ ' });
    assert.equal(login.status, 200);
    const loggedIn = await login.json();
    assert.deepEqual(loggedIn.data.user, expectedUser);
    assert.deepEqual(loggedIn.user, expectedUser);
  });
}

test('local setup configuration requires a private loopback deployment', () => {
  const env = { SMARTSELL_LOCAL_SETUP: '1', DATABASE_URL: 'postgresql://fixture/db' };
  assert(configuration(env).localSetupOrigins?.size);
  assert.equal(configuration({ ...env, HOST: '0.0.0.0' }).localSetupOrigins, undefined);
  assert.equal(configuration({ ...env, PUBLIC_ORIGIN: 'https://public.example' }).localSetupOrigins, undefined);
  assert.equal(configuration({ ...env, SMARTSELL_IDENTITY_DEPLOYMENT: 'saas', PUBLIC_ORIGIN: 'https://127.0.0.1' }).localSetupOrigins, undefined);
  assert.equal(configuration({ ...env, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://127.0.0.1',
    APP_SECRET: randomBytes(32).toString('hex') }).localSetupOrigins, undefined);
});
