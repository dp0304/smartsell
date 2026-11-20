import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const requireIdentity = createRequire(new URL('../../../../packages/identity/package.json', import.meta.url));
const { URI } = requireIdentity('otpauth') as typeof import('../../../../packages/identity/node_modules/otpauth');
const path = '/api/v1/auth/totp';
const password = 'commands-password-fixture';
const credentials = { email: 'owner@example.test', password };

async function freePort() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

const pg = process.env.COMMAND_IDENTITY_TEST_DATABASE_URL;
for (const mode of ['SQLite', 'PostgreSQL'] as const) test(`Commands ${mode}: login aliases, one-time proofs, revocation and restart`,
  { skip: mode === 'PostgreSQL' && !pg, timeout: 60_000 }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'commands-identity-'));
    const state = join(dir, 'preview.sqlite');
    t.after(() => rm(dir, { recursive: true, force: true }));
    const secure = mode === 'PostgreSQL';
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const origin = secure ? 'https://identity.example.test' : base;

    async function launch(port: number) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/command-main.ts'], {
        cwd: new URL('../../../../', import.meta.url),
        env: { ...process.env, NODE_ENV: secure ? 'production' : 'development', PORT: String(port), HOST: '127.0.0.1',
          PUBLIC_ORIGIN: origin, SMARTSELL_ROLES: 'api', SMARTSELL_STORE: secure ? 'postgres' : 'local', SMARTSELL_DATA_FILE: state,
          SMARTSELL_MEDIA_ROOT: join(dir, 'media'), SMARTSELL_OPERATION_API: '0', SMARTSELL_IDENTITY_DEPLOYMENT: 'private',
          IDENTITY_ENCRYPTION_KEY: undefined, DATABASE_URL: secure ? pg : undefined, BACKGROUND_DATABASE_URL: undefined,
          SETUP_TOKEN: '1ee07e3b69f0a1229890e26c1bab32e1a054889764d00dd668f8cce73016d823',
          APP_SECRET: secure ? 'f57ef9374266ea4f889f93b832f76d60451f1181842f20d0a201e8841a209f39' : undefined },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', data => { output += data; });
      child.stderr.on('data', data => { output += data; });
      const exited = once(child, 'exit');
      const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; };
      t.after(stop);
      const url = `http://127.0.0.1:${port}`;
      const end = Date.now() + 15_000;
      let ready = false;
      while (!ready && Date.now() < end && child.exitCode === null) {
        ready = await fetch(`${url}/readyz`).then(res => res.ok, () => false);
        if (!ready) await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert(ready, output);
      return { stop, url };
    }

    async function request(url: string, route: string, status: number, body?: object, headers: Record<string, string> = {}) {
      const response = await fetch(`${url}${route}`, {
        method: body ? 'POST' : 'GET', headers: { origin, ...(body && { 'content-type': 'application/json' }), ...headers },
        body: body && JSON.stringify(body),
      });
      assert.equal(response.status, status, `${route} returned ${response.status}`);
      return { body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    const first = await launch(port);
    const setup = await request(base, '/api/v1/setup', 201, { ...credentials, name: 'Owner', workspaceName: 'Identity QA' },
      { 'x-setup-token': '1ee07e3b69f0a1229890e26c1bab32e1a054889764d00dd668f8cce73016d823' });
    assert(setup.cookie);
    const alternate = await request(base, '/api/v1/session', 200, credentials);
    assert(alternate.cookie);
    const auth = { cookie: setup.cookie, 'x-csrf-token': setup.body.data.csrf_token };
    await request(base, `${path}/enroll`, 403, { password }, { cookie: setup.cookie });
    await request(base, `${path}/enroll`, 401, { password: 'invalid password' }, auth);
    const { body: { data: { enrollmentId, uri } } } = await request(base, `${path}/enroll`, 200, { password }, auth);
    const generator = URI.parse(uri);
    // Confirm in the previous accepted step so the current step can be tested without a wall-clock sleep.
    const totp = generator.generate({ timestamp: Date.now() - 30_000 });
    const { body: { data: { recoveryCodes } } } = await request(base, `${path}/confirm`, 200, { password, enrollmentId, totp }, auth);
    assert.equal(new Set(recoveryCodes).size, 10);
    await request(base, '/api/v1/session', 200, undefined, { cookie: alternate.cookie });

    async function challenge(url: string, alias = '/api/v1/session', headers?: Record<string, string>) {
      const result = await request(url, alias, 200, credentials, headers);
      assert.equal(result.cookie, undefined);
      assert.equal(result.body.data.required, true);
      assert.equal(result.body.user, undefined);
      return result.body.data.challenge as string;
    }
    const pending = await challenge(base, '/api/v1/login', { cookie: alternate.cookie });
    await request(base, '/api/v1/session', 200, undefined, { cookie: alternate.cookie });
    await request(base, '/api/v1/session', 401);
    if (!secure) assert.equal((await stat(`${state}.identity-key`)).mode & 0o077, 0);
    await first.stop();
    const restarted = await launch(port);
    const peer = secure ? (await launch(await freePort())).url : restarted.url;
    const { body: session } = await request(base, '/api/v1/session', 200, undefined, { cookie: setup.cookie });
    auth['x-csrf-token'] = session.data.csrf_token;
    assert.equal((await request(base, path, 200, undefined, auth)).body.data.enabled, true);
    const authn = await request(peer, `${path}/challenge`, 200, { challenge: pending, totp: generator.generate() }, { cookie: alternate.cookie });
    assert(authn.cookie);
    await request(base, '/api/v1/session', 401, undefined, { cookie: alternate.cookie });
    await request(base, '/api/v1/session', 200, undefined, { cookie: setup.cookie });
    await request(base, `${path}/challenge`, 401, { challenge: pending, recoveryCode: recoveryCodes[0] });
    const oldChallenge = await challenge(base);
    const recovery = await Promise.all([challenge(base), challenge(peer)]);
    const results = await Promise.all(recovery.map((challenge, index) => fetch(`${[base, peer][index]}${path}/challenge`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ challenge, recoveryCode: recoveryCodes[0] }),
    })));
    assert.deepEqual(results.map(result => result.status).sort(), [200, 401]);
    await request(base, `${path}/recovery/revoke`, 200, { password, recoveryCode: recoveryCodes[1] }, auth);
    await request(base, `${path}/challenge`, 401, { challenge: oldChallenge, recoveryCode: recoveryCodes[2] });
    const revokeStep = generator.generate({ timestamp: Date.now() + 30_000 });
    await request(base, `${path}/revoke`, 200, { password, totp: revokeStep }, auth);
    assert.equal((await request(base, path, 200, undefined, auth)).body.data.enabled, false);
    assert((await request(base, '/api/v1/login', 200, credentials)).cookie);
  });
