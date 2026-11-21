import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { hash } from '@node-rs/argon2';
import { buildApp } from '../app.js';
import { localStore } from '../local.js';

const requireIdentity = createRequire(new URL('../../../../packages/identity/package.json', import.meta.url));
const { URI } = requireIdentity('otpauth') as typeof import('../../../../packages/identity/node_modules/otpauth');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const username = 'recovery-fixture-owner';
const password = 'original-fixture-password';
const newPassword = '004271';
const session = '/api/v1/session';
const totp = '/api/v1/auth/totp';

function launch(dataFile: string, loginOrigin: string, launchFile: string, env: NodeJS.ProcessEnv = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/recover-local.ts',
    '--data-file', dataFile, '--login-origin', loginOrigin, '--launch-file', launchFile], {
    cwd: new URL('../../../../', import.meta.url), env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const exited = once(child, 'close');
  return {
    exited,
    output: () => output,
    async stop() { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; },
    async link() {
      for (let attempt = 0; attempt < 150 && child.exitCode === null; attempt++) {
        const text = await readFile(launchFile, 'utf8').catch(() => '');
        if (text.endsWith('\n')) return new URL(text.trim());
        await delay(50);
      }
      assert.fail(output || 'The recovery process did not publish a link');
    },
  };
}

function post(origin: string, path: string, input: object, headers: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(input) });
}

function responseCookie(response: Response) {
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  assert(cookie);
  return cookie;
}

for (const mfa of [false, true]) test(`local recovery updates only the owner and ${mfa ? 'preserves MFA' : 'allows a fresh login'}`,
  { timeout: 20_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'smartsell-recover-'));
    const dataFile = join(directory, 'test.sqlite');
    const launchFile = join(directory, 'launch');
    const store = localStore(dataFile);
    const app = buildApp({ store, registry: new Map(), secureCookie: false, origins: new Set(),
      commandIdentityKey: randomBytes(32), secret: randomBytes(32).toString('hex') }).app;
    const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
    const passwordHash = await hash(password);
    assert(await store.setup({ username, name: 'Owner fixture', workspaceName: 'Existing workspace', passwordHash }, 'setup-fixture'));
    const signIn = (value: string) => fetch(`${origin}${session}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: value }) });
    const initial = await signIn(password);
    assert.equal(initial.status, 200);
    const cookie = responseCookie(initial);
    const browserHash = digest(cookie.split('=')[1]);
    const { data: { user: owner, workspaces: [workspace], csrf_token: csrf } } = await initial.json();
    const member = { id: 'invite-fixture', email: 'member@example.test', role: 'reviewer' as const, tokenHash: 'fixture-invite-token' };
    await store.workspace(browserHash, workspace.id, unit => unit.command({ module: 'fixture', action: 'seed', key: 'seed', fingerprint: '' }, async () => {
      await unit.inviteMember!(member);
      await unit.context.insert('fixture', 'record', { keep: true }, 'record');
      for (const id of ['legacy', 'agent']) await unit.context.insert('mcp_runtime', 'credential', {
        actor_id: owner.id, expires: Date.now() + 60_000,
      }, id);
    }));
    assert(await store.acceptMemberInvitation({ ...member, name: 'Reviewer', passwordHash }));
    const memberCredentials = await store.credentials(member.email);
    assert(memberCredentials);
    await store.issueSession(memberCredentials.id, 'member-session');
    await store.issueSession(owner.id, 'agent-session', undefined, 86_400);

    let generator: ReturnType<typeof URI.parse> | undefined;
    if (mfa) {
      const manage = (path: string, input: object) => fetch(`${origin}${totp}${path}`, {
        method: 'POST', headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(input),
      });
      const response = await manage('/enroll', { password });
      assert.equal(response.status, 200);
      const { data } = await response.json();
      generator = URI.parse(data.uri);
      assert.equal((await manage('/confirm', { password, enrollmentId: data.enrollmentId,
        totp: generator.generate({ timestamp: Date.now() - 30_000 }) })).status, 200);
    }

    const recovery = launch(dataFile, origin, launchFile);
    t.after(() => recovery.stop());
    const link = await recovery.link();
    assert.equal(link.hostname, '127.0.0.1');
    assert.match(link.hash, /^#[A-Za-z0-9_-]{43}$/);
    assert.equal((await stat(launchFile)).mode & 0o777, 0o600);
    const authorization = `Bearer ${link.hash.slice(1)}`;
    const page = await fetch(link.origin);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    assert.doesNotMatch(await page.text(), new RegExp(username));
    assert.equal((await post(link.origin, '/owner', {})).status, 403);
    assert.equal((await post(link.origin, '/reset', { password: newPassword, confirm: newPassword })).status, 403);
    assert.equal((await post(link.origin, '/reset', { password: newPassword, confirm: newPassword },
      { authorization, origin: 'http://other.test' })).status, 403);
    const wrongHost = await new Promise<number | undefined>((resolve, reject) => {
      get(link.origin, { headers: { host: 'example.test' } }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(wrongHost, 403);
    assert.equal((await post(link.origin, '/owner', {}, { authorization, 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await post(link.origin, '/owner', {}, { authorization, 'content-type': 'text/plain' })).status, 415);
    assert.deepEqual(await (await post(link.origin, '/owner', {}, { authorization })).json(), { username });
    const reset = (value: string, confirm = value) => post(link.origin, '/reset', { password: value, confirm }, { authorization });
    assert.equal((await reset('12345')).status, 422);
    assert.equal((await reset('a'.repeat(1025))).status, 422);
    assert.equal((await reset(newPassword, 'different')).status, 422);
    assert.equal((await fetch(`${origin}${session}`, { headers: { cookie } })).status, 200);
    const replacement = mfa ? 'longer recovery fixture password' : newPassword;
    assert.equal((await reset(replacement)).status, 200);
    assert.equal(await reset('another-password').then(result => result.ok, () => false), false);
    assert.equal((await recovery.exited)[0], 0);
    assert.doesNotMatch(recovery.output(), new RegExp(`${username}|${link.hash.slice(1)}|${replacement}`));
    await assert.rejects(stat(launchFile), { code: 'ENOENT' });
    const snapshot = new DatabaseSync(dataFile, { readOnly: true });
    try {
      const { payload } = snapshot.prepare('SELECT payload FROM snapshot WHERE id = 1').get()!;
      const saved = JSON.parse(String(payload));
      // An already-running preview may still read the original session collection.
      assert.equal(new Map(saved.sessions).has(browserHash), false);
    } finally { snapshot.close(); }

    assert.equal((await fetch(`${origin}${session}`, { headers: { cookie } })).status, 401);
    assert.equal((await signIn(password)).status, 401);
    const secondBrowser = await signIn(replacement);
    assert.equal(secondBrowser.status, 200);
    const result = await secondBrowser.json();
    if (generator) {
      assert.equal(result.data.required, true);
      assert.equal(secondBrowser.headers.get('set-cookie'), null);
      const finish = await fetch(`${origin}${totp}/challenge`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challenge: result.data.challenge, totp: generator.generate() }) });
      assert.equal(finish.status, 200);
      const signedIn = await finish.json();
      assert.deepEqual(signedIn.data.user, owner);
      assert.deepEqual(signedIn.data.workspaces, [workspace]);
    } else {
      assert.notEqual(responseCookie(secondBrowser), cookie);
      assert.deepEqual(result.data.user, owner);
      assert.deepEqual(result.data.workspaces, [workspace]);
    }
    assert.equal((await store.session('member-session'))?.user.email, member.email);
    assert.equal((await store.credentials(member.email))?.passwordHash, passwordHash);
    assert.equal((await store.session('setup-fixture')), undefined);
    await store.revokeSession(browserHash); // A stale browser can still send logout.
    for (const [token, credentialId] of [[browserHash, 'legacy'], ['agent-session', 'agent']]) {
      assert.deepEqual(await store.workspace(token, workspace.id, async ({ context }) =>
        (await context.get('fixture', 'record', 'record'))?.data, credentialId), { keep: true });
    }
  });

test('recovery refuses missing, uninitialized, occupied, or unsuitable databases and launch files', { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-recover-refusal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const dataFile = join(directory, 'test.sqlite');
  const launchFile = join(directory, 'launch');
  const origin = 'http://localhost:5174';
  const refused = async (file: string, env?: NodeJS.ProcessEnv, message?: RegExp) => {
    const recovery = launch(file, origin, launchFile, env);
    assert.equal((await recovery.exited)[0], 1);
    if (message) assert.match(recovery.output(), message);
  };
  await refused(dataFile);
  await assert.rejects(stat(dataFile), { code: 'ENOENT' });
  const db = new DatabaseSync(dataFile);
  await chmod(dataFile, 0o600);
  await refused(dataFile);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='snapshot'").get(), undefined);
  db.close();
  const store = localStore(dataFile);
  await refused(dataFile);
  await store.setup({ username, name: 'Owner fixture', workspaceName: 'Existing workspace', passwordHash: await hash(password) }, 'unchanged');
  await refused(dataFile, { NODE_ENV: 'production' });
  await refused(dataFile, { DATABASE_URL: 'postgresql://example.test/fixture' });
  await chmod(dataFile, 0o644);
  await refused(dataFile);
  await chmod(dataFile, 0o600);
  const linked = join(directory, 'symlink.sqlite');
  await symlink(dataFile, linked);
  await refused(linked);
  const lock = new DatabaseSync(dataFile);
  lock.exec('BEGIN IMMEDIATE');
  try { await refused(dataFile, {}, /被占用/); } finally { lock.close(); }
  await assert.rejects(stat(launchFile), { code: 'ENOENT' });
  await writeFile(launchFile, 'original launch file', { mode: 0o600 });
  await refused(dataFile);
  assert.equal(await readFile(launchFile, 'utf8'), 'original launch file');
  assert(await store.session('unchanged'));
  await store.close();
});
