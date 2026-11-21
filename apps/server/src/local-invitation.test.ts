import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from './app.js';
import { configuration } from './config.js';
import { localStore } from './local.js';
import { discoverOperations } from './operations.js';
import { registerOperationRoutes } from './operation-server.js';

test('file preview persists member invitations and enforces the invited role after reopening', async t => {
  const { operations, loadFailures } = await discoverOperations();
  assert.deepEqual([...loadFailures], []);
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-local-invitation-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const setupToken = 'preview-invitation-test';
  const open = () => {
    const config = configuration({ NODE_ENV: 'test', SETUP_TOKEN: setupToken });
    return buildApp({ ...config, registry: new Map(), store: localStore(join(dir, 'preview.sqlite')),
      operationApi: { config, operations, register: registerOperationRoutes } }).app;
  };
  let app = open();
  try {
    const owner = { email: 'owner@example.test', name: 'Owner', password: 'test-owner-password' };
    const reviewer = { email: 'reviewer@example.test', name: 'Reviewer', password: 'test-reviewer-password' };
    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { 'x-setup-token': setupToken },
      payload: { ...owner, workspaceName: 'Preview' } });
    assert.equal(setup.statusCode, 201, setup.body);
    const { user: ownerUser, workspaces: [{ id: wid }] } = setup.json();
    const ownerCookie = { [setup.cookies[0].name]: setup.cookies[0].value };
    const root = `/api/v1/workspaces/${wid}`;
    const csrf = async (cookies: Record<string, string>) => {
      const response = await app.inject({ url: '/api/v1/session/csrf', cookies });
      assert.equal(response.statusCode, 200, response.body);
      return { 'x-csrf-token': response.json().csrf_token as string };
    };
    const invite = async (cookies: Record<string, string>, email: string, role: string) => app.inject({
      method: 'POST', url: `${root}/members/invite`, cookies, headers: await csrf(cookies), payload: { email, role },
    });
    const created = await invite(ownerCookie, reviewer.email, 'reviewer');
    assert.equal(created.statusCode, 200, created.body);
    const token = created.json().data.invitation_token;
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);

    await app.close();
    app = open();
    const accept = (payload: object) => app.inject({ method: 'POST', url: '/api/v1/member-invitations/accept', payload });
    const wrongEmail = await accept({ ...reviewer, token, email: 'other@example.test' });
    assert.equal(wrongEmail.statusCode, 403, wrongEmail.body);
    assert.equal(wrongEmail.json().error.code, 'invalid_invitation');
    const payload = { ...reviewer, email: ' Reviewer@Example.Test ', token };
    const shortPassword = await accept({ ...payload, password: '123456' });
    assert.equal(shortPassword.statusCode, 422, shortPassword.body);
    assert.match(shortPassword.json().error.message, /at least 12 characters/);
    const responses = await Promise.all([accept(payload), accept(payload)]);
    assert.deepEqual(responses.map(response => response.statusCode).sort(), [204, 403]);
    assert.equal(responses.find(response => response.statusCode === 204)!.cookies.length, 0);
    assert.equal((await app.inject('/api/v1/session')).statusCode, 401);

    await app.close();
    app = open();
    const replay = await accept(payload);
    assert.equal(replay.statusCode, 403, replay.body);
    assert.equal(replay.json().error.code, 'invalid_invitation');
    const login = (password: string) => app.inject({ method: 'POST', url: '/api/v1/session', payload: { email: reviewer.email, password } });
    assert.equal((await login(owner.password)).statusCode, 401);
    const signedIn = await login(reviewer.password);
    assert.equal(signedIn.statusCode, 200, signedIn.body);
    const { user, workspaces } = signedIn.json();
    assert.notEqual(user.id, ownerUser.id);
    assert.equal(user.email, reviewer.email);
    assert.deepEqual(workspaces, [{ id: wid, name: 'Preview', role: 'reviewer' }]);
    const reviewerCookie = { [signedIn.cookies[0].name]: signedIn.cookies[0].value };
    const members = await app.inject({ url: `${root}/members`, cookies: ownerCookie });
    assert.equal(members.statusCode, 200, members.body);
    assert.deepEqual(members.json().data.map(({ user_id, role }: { user_id: string; role: string }) => [user_id, role]).sort(),
      [[ownerUser.id, 'owner'], [user.id, 'reviewer']].sort());
    assert.equal((await app.inject({ url: `${root}/members`, cookies: reviewerCookie })).statusCode, 200);
    assert.equal((await invite(reviewerCookie, 'extra@example.test', 'viewer')).statusCode, 403);
    assert.equal((await invite(ownerCookie, reviewer.email, 'viewer')).statusCode, 409);

    const expiring = await invite(ownerCookie, 'extra@example.test', 'viewer');
    assert.equal(expiring.statusCode, 200, expiring.body);
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 8 * 86_400_000 });
    const expired = await accept({ ...reviewer, email: 'extra@example.test', token: expiring.json().data.invitation_token });
    assert.equal(expired.statusCode, 403, expired.body);
    assert.equal(expired.json().error.code, 'invalid_invitation');
  } finally {
    await app.close();
  }
});
