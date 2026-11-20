import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createSocket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { configuration } from '../../apps/server/src/config.js';
import { configureEnterpriseConnection } from '../../apps/server/src/integration/enterprise-host.js';
import { createServer } from '../../apps/server/src/server.js';
import { makeContext } from '../../apps/server/src/context.js';
import { workspaceServices } from '../../apps/server/src/integration/workspace-services.js';
import { ensureTask } from '../../apps/server/src/modules/execution/service.js';
import { createExecutionWorker, type Transact } from '../../apps/server/src/modules/execution/worker.js';
import { assessTarget } from '../../packages/domain/src/publishing/index.js';
import { fileStore } from '../../packages/db/src/index.js';
import { digest, opaque, userSchema } from '../../packages/identity/src/index.ts';

const requireIdentity = createRequire(new URL('../../packages/identity/package.json', import.meta.url));
const { URI } = requireIdentity('otpauth') as typeof import('../../packages/identity/node_modules/otpauth');
const identityPath = '/api/v1/auth/totp';
const key = randomBytes(32).toString('hex');
const secret = randomBytes(32).toString('hex');
const setupToken = randomBytes(32).toString('hex');
const password = 'identity-fixture-password';
const credentials = { email: 'owner@example.test', password };
const productionOrigin = 'https://smartsell.example.test';

type Session = { user: { id: string }; workspaces: { id: string }[]; csrf_token: string };
type Request = (path: string, status: number, options?: { method?: string; body?: object | string; headers?: Record<string, string> }) => Promise<Response>;
const cookieOf = (response: Response) => {
  const cookie = response.headers.get('set-cookie');
  assert.ok(cookie);
  return cookie.split(';')[0];
};

function request(base: string, origin: string): Request {
  return async (path, status, options = {}) => {
    const { body, headers, method = body === undefined ? 'GET' : 'POST' } = options;
    const response = await fetch(`${base}${path}`, { method, redirect: 'manual', signal: AbortSignal.timeout(5000),
      headers: { origin, ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
    assert.equal(response.status, status, `${method} ${path}`);
    return response;
  };
}

async function temporaryDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-identity-http-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function freePort() {
  const socket = createSocket();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address === 'object');
  socket.close();
  await once(socket, 'close');
  return address.port;
}

async function startProcess(t: TestContext, directory: string, database?: string) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const origin = database ? productionOrigin : base;
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: database ? 'production' : 'development',
    PORT: String(port), ROLE: database ? 'api,mcp' : 'all', PUBLIC_ORIGIN: origin, APP_SECRET: database ? secret : undefined,
    SETUP_TOKEN: setupToken, DATABASE_URL: database,
    IDENTITY_ENCRYPTION_KEY: database ? key : undefined, SMARTSELL_DATA_FILE: join(directory, 'state.json'), MEDIA_DIRECTORY: join(directory, 'media'),
  };
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/server/src/kernel-main.ts'], { env });
  const exited = once(child, 'close');
  const stop = async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; };
  t.after(stop);
  let output = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000); });
  await ready(child, `http://127.0.0.1:${port}/readyz`, () => output);
  return { http: request(base, origin), stop };
}

async function ready(child: ChildProcess, base: string, output: () => string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && child.exitCode === null) {
    const response = await fetch(base, { signal: AbortSignal.timeout(500) }).catch(() => null);
    if (response?.ok) return;
    await delay(50);
  }
  assert.fail(`Operation server did not become ready: ${output()}`);
}

async function setup(http: Request) {
  const response = await http('/api/v1/setup', 201, { body: { ...credentials, workspaceName: 'Identity test' }, headers: { 'x-setup-token': setupToken } });
  return { session: (await response.json()).data as Session, cookie: cookieOf(response) };
}

async function enroll(http: Request, auth: Awaited<ReturnType<typeof setup>>) {
  const headers = { cookie: auth.cookie, 'x-csrf-token': auth.session.csrf_token };
  assert.equal((await (await http(identityPath, 200, { headers })).json()).data.enabled, false);
  await http(`${identityPath}/enroll`, 403, { body: { password }, headers: { cookie: auth.cookie } });
  await http(`${identityPath}/enroll`, 401, { body: { password: 'wrong-password' }, headers });
  const { data: { enrollmentId, uri } } = await (await http(`${identityPath}/enroll`, 200, { body: { password }, headers })).json();
  const generator = URI.parse(uri);
  // Confirm in the previous window, leaving time for the HTTP request before it expires.
  assert.ok('period' in generator, 'Expected a TOTP enrollment URI');
  const period = generator.period * 1000;
  const remaining = period - Date.now() % period;
  if (remaining < 3000) await delay(remaining + 50);
  const { data: { recoveryCodes } } = await (await http(`${identityPath}/confirm`, 200, {
    body: { password, enrollmentId, totp: generator.generate({ timestamp: Date.now() - period }) }, headers,
  })).json();
  assert.equal(recoveryCodes.length, 10);
  assert.equal((await (await http(identityPath, 200, { headers })).json()).data.enabled, true);
  return { generator, recoveryCodes: recoveryCodes as string[] };
}

async function startLogin(http: Request, path = '/api/v1/login') {
  const response = await http(path, 200, { body: credentials });
  assert.equal(response.headers.get('set-cookie'), null);
  const { data } = await response.json();
  assert.equal(data.required, true);
  return data.challenge as string;
}

async function finishLifecycle(first: Request, second: Request, factor: Awaited<ReturnType<typeof enroll>>, challenge: string) {
  const login = `${identityPath}/challenge`;
  const totpAuth = cookieOf(await second(login, 200, { body: { challenge, totp: factor.generator.generate() } }));
  await first(login, 401, { body: { challenge, recoveryCode: factor.recoveryCodes[0] } });
  const recoveryChallenge = await startLogin(first, '/api/v1/session');
  const recover = { challenge: recoveryChallenge, recoveryCode: factor.recoveryCodes[0] };
  const byRecovery = await second(login, 200, { body: recover });
  const cookie = cookieOf(byRecovery);
  const { data } = await byRecovery.json() as { data: Session };
  await first(login, 401, { body: { challenge: await startLogin(second), recoveryCode: factor.recoveryCodes[0] } });
  const outstanding = await startLogin(first);
  const headers = { cookie, 'x-csrf-token': data.csrf_token };
  await second(`${identityPath}/revoke`, 200, { body: { password, recoveryCode: factor.recoveryCodes[1] }, headers });
  assert.equal((await (await first(identityPath, 200, { headers })).json()).data.enabled, false);
  await first('/api/v1/session', 401, { headers: { cookie: totpAuth } });
  await second(login, 401, { body: { challenge: outstanding, recoveryCode: factor.recoveryCodes[2] } });
  cookieOf(await first('/api/v1/login', 200, { body: credentials }));
}

test('development HTTP TOTP survives process restart and revocation invalidates challenges and other sessions', async t => {
  const directory = await temporaryDirectory(t);
  const first = await startProcess(t, directory);
  const auth = await setup(first.http);
  await first.http('/api/v1/auth/sso/tenant/connection/oidc/start', 404, { method: 'POST' });
  await first.http('/api/v1/scim/tenant/connection/v2/Users', 404);
  const factor = await enroll(first.http, auth);
  await first.http('/api/v1/login', 401, { body: { ...credentials, password: 'wrong-password' } });
  const challenge = await startLogin(first.http);
  await first.stop();
  const second = await startProcess(t, directory);
  await finishLifecycle(second.http, second.http, factor, challenge);
});

const database = process.env.IDENTITY_KERNEL_TEST_DATABASE_URL;
test('production PostgreSQL TOTP and session invalidation are shared across independent API processes', { skip: !database }, async t => {
  const directory = await temporaryDirectory(t);
  const first = await startProcess(t, directory, database);
  const second = await startProcess(t, directory, database);
  const auth = await setup(first.http);
  const factor = await enroll(second.http, auth);
  const challenge = await startLogin(first.http);
  await finishLifecycle(first.http, second.http, factor, challenge);
});

test('SaaS signed OIDC and SCIM over HTTP issue and revoke actual core sessions, PATs and OAuth grants', async t => {
  const directory = await temporaryDirectory(t);
  const store = await fileStore(join(directory, 'state.json'));
  const config = configuration({ PUBLIC_ORIGIN: productionOrigin, SMARTSELL_IDENTITY_DEPLOYMENT: 'saas', SETUP_TOKEN: setupToken });
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://local-idp.example.test';
  const clientId = 'smartsell-fixture';
  const externalId = 'signed-idp-subject';
  const codes = new Map<string, { nonce: string; challenge: string }>();
  const json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const app = createServer({ config, store, operations: [], identityKey: Buffer.from(key, 'hex'), async testOidcTransport(_scope, url, options) {
    if (url === `${issuer}/jwks`) {
      return Response.json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256' }] });
    }
    assert.equal(url, `${issuer}/token`);
    const form = new URLSearchParams(String(options.body));
    const code = form.get('code') ?? '';
    const flow = codes.get(code);
    codes.delete(code);
    assert.ok(flow);
    assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), flow.challenge);
    const iat = Math.floor(Date.now() / 1000);
    const unsigned = `${json({ alg: 'RS256', kid: 'fixture' })}.${json({ iss: issuer, aud: clientId, sub: externalId, nonce: flow.nonce, iat, exp: iat + 60 })}`;
    return Response.json({ access_token: opaque(), token_type: 'Bearer',
      id_token: `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), keys.privateKey).toString('base64url')}` });
  } });
  t.after(() => app.close());
  const http = request(await app.listen({ host: '127.0.0.1', port: 0 }), productionOrigin);
  const owner = await setup(http);
  const workspaceId = owner.session.workspaces[0].id;
  const tenantId = await store.transaction({ readOnly: true }, ({ identity }) => identity.get<{ tenantId: string }>(`workspace/${workspaceId}`)!.tenantId);
  const token = opaque();
  await configureEnterpriseConnection(store, Buffer.from(key, 'hex'), { tenantId, workspaceId, connectionId: 'fixture', seatLimit: 2,
    scimTokenHash: digest(token), protocol: 'oidc', issuer, clientId, signingAlgorithm: 'RS256',
    authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`, jwksUri: `${issuer}/jwks`,
  });
  const scim = `/api/v1/scim/${tenantId}/fixture/v2/Users`;
  const oidc = `/api/v1/auth/sso/${tenantId}/fixture/oidc`;
  const scimHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' };
  const newUser = { schemas: [userSchema], externalId, userName: credentials.email, active: true };
  const user = await (await http(scim, 201, { headers: scimHeaders, body: newUser })).json();
  assert.notEqual(user.id, owner.session.user.id);
  await http(scim, 409, { headers: scimHeaders, body: { ...newUser, externalId: 'over-seat-limit' } });
  const federatedLogin = async (status: number) => {
    const start = await http(`${oidc}/start`, 303, { method: 'POST' });
    const url = new URL(start.headers.get('location')!);
    const code = opaque();
    codes.set(code, { nonce: url.searchParams.get('nonce')!, challenge: url.searchParams.get('code_challenge')! });
    return http(`${oidc}/callback?${new URLSearchParams({ code, state: url.searchParams.get('state')! })}`, status, { headers: { cookie: cookieOf(start) } });
  };
  const cookie = cookieOf(await federatedLogin(303));
  const { data: session } = await (await http('/api/v1/session', 200, { headers: { cookie } })).json() as { data: Session };
  assert.equal(session.user.id, user.id);
  assert.deepEqual(session.workspaces.map(workspace => workspace.id), [workspaceId]);
  const headers = { cookie, 'x-csrf-token': session.csrf_token };
  const pat = (await (await http(`/api/v1/workspaces/${workspaceId}/tokens`, 201, { headers, body: {} })).json()).data.token;
  const redirect_uri = 'http://127.0.0.1:45123/callback';
  const { client_id } = await (await http('/oauth/register', 201, { body: { redirect_uris: [redirect_uri] } })).json();
  const code_verifier = opaque();
  const authorize = async () => {
    const response = await http('/oauth/authorize', 303, { headers, body: {
      client_id, redirect_uri, workspace_id: workspaceId, response_type: 'code', code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(code_verifier).digest('base64url'),
    } });
    return new URL(response.headers.get('location')!).searchParams.get('code');
  };
  const exchange = (code: string | null, status: number) => http('/oauth/token', status, { body: { grant_type: 'authorization_code', client_id, redirect_uri, code_verifier, code } });
  const oauth = (await (await exchange(await authorize(), 200)).json()).access_token;
  const outstanding = await authorize();
  const bearer = (token: string, status: number) => http(`/api/v1/workspaces/${workspaceId}/catalog`, status, { headers: { authorization: `Bearer ${token}` } });
  const mcp = (credential: string, status: number) => http('/mcp', status, { method: 'POST',
    headers: { authorization: `Bearer ${credential}`, accept: 'application/json, text/event-stream' },
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
  });
  await bearer(pat, 200);
  await bearer(oauth, 200);
  for (const credential of [pat, oauth]) {
    const response = await mcp(credential, 200);
    assert.ok(Array.isArray((await response.json()).result.tools));
  }
  const scope = { tenantId, workspaceId, actorId: owner.session.user.id };
  const enrich = workspaceServices([]);
  const transact: Transact = run => store.transaction({ identityWrite: true }, async tx =>
    run(enrich(makeContext(await tx.workspace(scope), scope, 'owner'), tx.identity)));
  const [preparing, queued] = await transact(ctx => {
    const grant = ctx.create('standing_grant', { grantee_id: user.id, grantee_type: 'user', status: 'active',
      actions: ['planning.target.approve'], valid_from: ctx.now });
    const account = ctx.create('social_account', { provider: 'instagram', status: 'active' });
    const connection = ctx.create('connection', { status: 'active' });
    ctx.create('capability', { social_account_id: account.id, connection_id: connection.id, operation: 'publish',
      content_format: 'text', status: 'available', executors: ['api'] });
    return ['Preparing', 'Queued'].map(label => {
      const item = ctx.create('content_item', { title: label });
      const variant = ctx.create('content_variant', { platform: 'instagram', content_item_id: item.id });
      const revision = ctx.create('content_revision', { variant_id: variant.id, content_hash: label, rendered: { text: label } });
      ctx.update('content_variant', variant.id, { current_revision_id: revision.id });
      const target = ctx.create('publish_target', { social_account_id: account.id, content_item_id: item.id,
        content_variant_id: variant.id, variant_revision_id: revision.id, content_format: 'text', operation: 'publish',
        plan_status: 'ready', schedule_kind: 'asap', snapshot_generation: 1 });
      const { hash } = assessTarget(ctx, target, 'approval');
      const approval = ctx.create('approval_request', { resource_type: 'planning.publish_target', resource_id: target.id,
        resource_hash: hash, status: 'approved', standing_grant_id: grant.id,
        context: { submitted_by: user.id, submitted_by_type: 'user' } });
      return ensureTask(ctx, ctx.update('publish_target', target.id, { frozen_hash: hash, approval_request_id: approval.id }));
    });
  });
  assert.equal(preparing.status, 'queued');
  assert.equal(queued.status, 'queued');
  let submissions = 0;
  const worker = createExecutionWorker(transact, [{ provider: 'instagram',
    async prepare(request) {
      assert.equal(request.task_id, preparing.id);
      await http(`${scim}/${user.id}`, 200, { method: 'PATCH', headers: scimHeaders, body: {
        schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }],
      } });
      for (const credential of [pat, oauth]) await mcp(credential, 401);
    },
    async submit() { submissions++; return { status: 'accepted', reference: 'local-fixture' }; },
    async observe() { return { status: 'inconclusive' }; },
  }]);
  await worker.dispatch(preparing.id);
  await worker.dispatch(queued.id);
  assert.equal(submissions, 0);
  await transact(ctx => {
    for (const task of [preparing, queued]) assert.equal(ctx.get('execution_task', task.id).status_reason, 'approval_invalid');
    const attempts = ctx.list('execution_attempt');
    assert.deepEqual(attempts.map(row => [row.task_id, row.status]), [[preparing.id, 'abandoned']]);
    assert.ok(attempts.every(row => !row.side_effect_possible && !row.submission_started_at));
    assert.equal(ctx.list('account_write_slot')[0].holder_id, null);
  });
  await http('/api/v1/session', 401, { headers });
  await bearer(pat, 401);
  await bearer(oauth, 401);
  await exchange(outstanding, 400);
  await federatedLogin(401);
  await http('/api/v1/session', 200, { headers: { cookie: owner.cookie } });
  const authorization = { authorization: scimHeaders.authorization };
  await http(`${scim}/${user.id}`, 204, { method: 'DELETE', headers: authorization });
  await http(`${scim}/${user.id}`, 404, { headers: authorization });
});
