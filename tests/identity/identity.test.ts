import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { enterpriseIdentityOwnsRequestGuard, registerEnterpriseIdentity } from '../../apps/server/src/extensions/enterprise-identity.ts';
import { configuration } from '../../apps/server/src/config.js';
import { configureEnterpriseConnection } from '../../apps/server/src/integration/enterprise-host.js';
import { createServer } from '../../apps/server/src/server.js';
import { fileStore } from '../../packages/db/src/index.js';
import { digest, IdentityError, IdentitySecrets, opaque, TotpIdentity, userSchema,
  type IdentityState, type OidcConnection, type OidcTransport, type SamlConnection, type ScimMember, type ScimMembers,
} from '../../packages/identity/src/index.ts';

const serverRequire = createRequire(new URL('../../apps/server/package.json', import.meta.url));
const Fastify = serverRequire('fastify') as typeof import('../../apps/server/node_modules/fastify');
const identityRequire = createRequire(new URL('../../packages/identity/package.json', import.meta.url));
const { URI } = identityRequire('otpauth') as typeof import('../../packages/identity/node_modules/otpauth');
const { SignedXml } = identityRequire('xml-crypto') as typeof import('../../packages/identity/node_modules/xml-crypto');
const origin = 'https://app.example.test';

class TestState implements IdentityState {
  readonly rows = new Map<string, { version: string; value: unknown }>();
  readonly flows = new Map<string, { binding: string; expiresAt: number; value: unknown }>();
  constructor(private readonly clock = Date.now) {}
  async read<T>(key: string) { return structuredClone(this.rows.get(key) ?? null) as { version: string; value: T } | null; }
  async compareAndSwap<T>(key: string, version: string | null, value: T) {
    if ((this.rows.get(key)?.version ?? null) !== version) return false;
    this.rows.set(key, { version: randomUUID(), value: structuredClone(value) });
    return true;
  }
  async putFlow<T>(key: string, binding: string, expiresAt: number, value: T) {
    assert.ok(!this.flows.has(key));
    this.flows.set(key, { binding, expiresAt, value: structuredClone(value) });
  }
  async takeFlow<T>(key: string, binding: string) {
    const flow = this.flows.get(key);
    if (!flow || flow.binding !== binding || flow.expiresAt <= this.clock()) return null;
    this.flows.delete(key);
    return flow.value as T;
  }
}

const fakeCore = {
  async withReauthenticatedAccount<T>(_request: unknown, password: string, run: (account: { accountId: string; label: string }) => Promise<T>) {
    if (password !== 'test-password') throw new IdentityError();
    return run({ accountId: 'alice', label: 'alice' });
  },
  async issueMfaSession(_request: unknown, _reply: unknown, verify: () => Promise<unknown>) {
    await verify();
    return { issued: true };
  },
};

test('TOTP requires first verification, atomically blocks replay, and erases revoked recovery hashes', async () => {
  let now = Date.now();
  const clock = () => now;
  const state = new TestState(clock);
  const totp = new TotpIdentity(state, new IdentitySecrets(randomBytes(32)), clock);
  const proof = { accountId: 'alice', credentialVersion: 'v1' };
  const enrollment = await totp.enroll(proof.accountId, 'alice');
  const client = URI.parse(enrollment.uri);
  assert.equal((await totp.afterPassword(proof)).required, false);
  await assert.rejects(totp.confirm(proof.accountId, enrollment.enrollmentId, 'wrong'), IdentityError);
  const { recoveryCodes } = await totp.confirm(proof.accountId, enrollment.enrollmentId, client.generate({ timestamp: now }));
  const stored = JSON.stringify([...state.rows.values()]);
  assert.ok(!stored.includes(client.secret.base32) && !stored.includes(recoveryCodes[0]) && stored.includes(digest(recoveryCodes[0])));
  const challenge = async () => {
    const result = await totp.afterPassword(proof);
    assert.ok(result.required);
    return result.challenge;
  };
  await assert.rejects(totp.finish(await challenge(), { totp: client.generate({ timestamp: now }) }), IdentityError);
  now += 30_000;
  const code = client.generate({ timestamp: now });
  const concurrent = await Promise.allSettled((await Promise.all([challenge(), challenge()])).map(id => totp.finish(id, { totp: code })));
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  const recovery = await challenge();
  assert.equal((await totp.finish(recovery, { recoveryCode: recoveryCodes[0] })).method, 'recovery');
  await assert.rejects(totp.finish(recovery, { recoveryCode: recoveryCodes[1] }), IdentityError);
  await assert.rejects(totp.finish(await challenge(), { recoveryCode: recoveryCodes[0] }), IdentityError);
  await totp.revoke('alice', { recoveryCode: recoveryCodes[1] }, 'recovery');
  await assert.rejects(totp.finish(await challenge(), { recoveryCode: recoveryCodes[2] }), IdentityError);
  const expired = await challenge();
  now += 300_001;
  await assert.rejects(totp.finish(expired, { totp: client.generate({ timestamp: now }) }), IdentityError);
  const outstanding = await challenge();
  await totp.revoke('alice', { totp: client.generate({ timestamp: now }) }, 'factor');
  now += 30_000;
  await assert.rejects(totp.finish(outstanding, { totp: client.generate({ timestamp: now }) }), IdentityError);
  assert.equal((await totp.afterPassword(proof)).required, false);
});

test('private Fastify exposes TOTP management and core session handoff only', async t => {
  const app = Fastify();
  t.after(() => app.close());
  const hooks = registerEnterpriseIdentity(app, { origin, deployment: 'private', encryptionKey: randomBytes(32), state: new TestState(), core: fakeCore });
  const post = (url: string, payload: object, headers = { origin }) => app.inject({ method: 'POST', url, payload, headers });
  const password = 'test-password';
  assert.equal((await post('/api/v1/auth/totp/enroll', { password }, { origin: 'https://elsewhere.example.test' })).statusCode, 403);
  assert.equal((await post('/api/v1/auth/sso/acme/work/oidc/start', {})).statusCode, 404);
  assert.equal((await app.inject('/api/v1/scim/acme/work/v2/Users')).statusCode, 404);
  const enrollment = (await post('/api/v1/auth/totp/enroll', { password })).json<{ uri: string; enrollmentId: string }>();
  const confirmation = await post('/api/v1/auth/totp/confirm', { password, enrollmentId: enrollment.enrollmentId, totp: URI.parse(enrollment.uri).generate() });
  assert.equal(confirmation.statusCode, 200);
  const gate = await hooks.afterPassword({ accountId: 'alice', credentialVersion: 'v1' });
  assert.ok(gate.required);
  const recoveryCode = confirmation.json<{ recoveryCodes: string[] }>().recoveryCodes[0];
  const completed = await post('/api/v1/auth/totp/challenge', { challenge: gate.challenge, recoveryCode });
  assert.equal(completed.statusCode, 200);
  assert.deepEqual(completed.json(), { issued: true });
});

const samlFormat = 'urn:oasis:names:tc:SAML:2.0:nameid-format:persistent';
const oidcConnection: OidcConnection = {
  tenantId: 'acme', connectionId: 'work', revision: 'v1', protocol: 'oidc', issuer: 'https://idp.example.test',
  authorizationEndpoint: 'https://idp.example.test/authorize', tokenEndpoint: 'https://idp.example.test/token',
  jwksUri: 'https://idp.example.test/jwks', clientId: 'app', signingAlgorithm: 'RS256',
};

function startParams(result: { headers: Record<string, unknown>; statusCode: number }) {
  assert.equal(result.statusCode, 303);
  const redirect = new URL(String(result.headers.location));
  const cookie = String(result.headers['set-cookie']).split(';')[0];
  return { redirect, cookie };
}

function fixture() {
  const records = new Map<string, ScimMember>();
  const credentials = new Set<string>();
  const scimToken = opaque();
  const secondToken = opaque();
  const connections = new Map<string, OidcConnection | SamlConnection>([
    ['acme/work', { ...oidcConnection, scimTokenHash: digest(scimToken) }],
    ['other/work', { ...oidcConnection, tenantId: 'other', scimTokenHash: digest(secondToken) }],
  ]);
  const key = (scope: { tenantId: string; connectionId: string }) => `${scope.tenantId}/${scope.connectionId}`;
  const members: ScimMembers = {
    async create(scope, input) {
      if (connections.get(key(scope))?.revision !== scope.revision) throw new IdentityError();
      const member = { id: randomUUID(), ...input };
      records.set(`${key(scope)}/${member.id}`, member);
      return member;
    },
    async get(scope, id) { return records.get(`${key(scope)}/${id}`) ?? null; },
    async list(scope, options) {
      const filter = options.filter;
      const found = [...records].filter(([id, value]) => id.startsWith(`${key(scope)}/`) && (!filter || value[filter.field] === filter.value)).map(([, value]) => value);
      return { total: found.length, members: found.slice(options.startIndex - 1, options.startIndex - 1 + options.count) };
    },
    async update(scope, id, input, expectedExternalId) {
      if (connections.get(key(scope))?.revision !== scope.revision) throw new IdentityError();
      const member = await this.get(scope, id);
      if (!member) return null;
      if (expectedExternalId !== undefined && member.externalId !== expectedExternalId) throw new IdentityError(400, 'externalId is immutable');
      Object.assign(member, input);
      if (!member.active) for (const suffix of ['session', 'pat', 'oauth']) credentials.delete(`${key(scope)}/${id}/${suffix}`);
      return member;
    },
    async remove(scope, id) { return Boolean(await this.update(scope, id, { active: false })); },
  };
  const app = Fastify();
  app.addHook('onRequest', async (request, reply) => {
    if (request.method !== 'GET' && !enterpriseIdentityOwnsRequestGuard(request) && request.headers.origin !== origin) {
      return reply.code(403).send();
    }
  });
  const transport = { fetch: (async () => { throw new Error('Unexpected IdP request'); }) as OidcTransport };
  registerEnterpriseIdentity(app, { origin, deployment: 'saas', encryptionKey: randomBytes(32), state: new TestState(), core: fakeCore,
    enterprise: {
      connection: async scope => connections.get(key(scope)) ?? null,
      transport: (...args) => transport.fetch(...args), members,
      async issueFederatedSession(_request, _reply, proof) {
        if (connections.get(key(proof))?.revision !== proof.revision) throw new IdentityError();
        const member = [...records].find(([id, member]) => id.startsWith(`${key(proof)}/`) && member.externalId === proof.subject)?.[1];
        if (!member?.active) throw new IdentityError();
        credentials.add(`${key(proof)}/${member.id}/session`);
        return { issued: true };
      },
    },
  });
  return { app, transport, connections, credentials, scimToken, secondToken, members };
}

const user = { schemas: [userSchema], externalId: 'subject', userName: 'not-used-for-login@example.test', active: true };
const scimPath = '/api/v1/scim/acme/work/v2/Users';
const oidcPath = '/api/v1/auth/sso/acme/work/oidc';

test('signed OIDC code flow checks PKCE, browser, state, tenant, nonce, expiry, signature and active SCIM membership', async t => {
  const { app, transport, connections, credentials, scimToken, secondToken } = fixture();
  t.after(() => app.close());
  const headers = { authorization: `Bearer ${scimToken}`, 'content-type': 'application/scim+json' };
  const created = await app.inject({ method: 'POST', url: scimPath, headers, payload: user });
  assert.equal(created.statusCode, 201);
  const id = created.json<{ id: string }>().id;
  assert.equal((await app.inject({ url: scimPath, headers: { authorization: `Bearer ${secondToken}` } })).statusCode, 401);
  assert.equal((await app.inject({ url: `/api/v1/scim/other/work/v2/Users/${id}`, headers: { authorization: `Bearer ${secondToken}` } })).statusCode, 404);
  const filter = new URLSearchParams({ filter: 'externalId eq "subject"' });
  assert.equal((await app.inject({ url: `${scimPath}?${filter}`, headers })).json().totalResults, 1);

  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const badKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const json = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  async function begin(scenario?: 'nonce' | 'expiry' | 'signature' | 'issuer' | 'audience') {
    const { redirect, cookie } = startParams(await app.inject({ method: 'POST', url: `${oidcPath}/start`, headers: { origin } }));
    transport.fetch = async (_scope, url, options) => {
      if (url === oidcConnection.jwksUri) return Response.json({ keys: [{ ...keys.publicKey.export({ format: 'jwk' }), kid: 'local', alg: 'RS256' }] });
      if (url !== oidcConnection.tokenEndpoint) return new Response(null, { status: 404 });
      const form = new URLSearchParams(String(options.body));
      const verifier = form.get('code_verifier');
      const pkce = verifier && createHash('sha256').update(verifier).digest('base64url');
      if (pkce !== redirect.searchParams.get('code_challenge') || form.get('redirect_uri') !== `${origin}${oidcPath}/callback`) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      const now = Math.floor(Date.now() / 1000);
      const data = `${json({ alg: 'RS256', kid: 'local' })}.${json({
        iss: scenario === 'issuer' ? 'https://wrong.example.test' : oidcConnection.issuer,
        aud: scenario === 'audience' ? 'wrong' : oidcConnection.clientId,
        sub: 'subject', exp: now + (scenario === 'expiry' ? -600 : 60), iat: now,
        nonce: scenario === 'nonce' ? opaque() : redirect.searchParams.get('nonce'),
      })}`;
      const signature = sign('RSA-SHA256', Buffer.from(data), scenario === 'signature' ? badKeys.privateKey : keys.privateKey);
      return Response.json({ access_token: opaque(), token_type: 'Bearer', id_token: `${data}.${signature.toString('base64url')}` });
    };
    const url = `${oidcPath}/callback?${new URLSearchParams({ code: opaque(), state: redirect.searchParams.get('state')! })}`;
    return { url, cookie };
  }
  for (const scenario of ['nonce', 'expiry', 'signature', 'issuer', 'audience'] as const) {
    const { url, cookie } = await begin(scenario);
    assert.equal((await app.inject({ url, headers: { cookie } })).statusCode, 401, scenario);
  }
  const stale = await begin();
  connections.set('acme/work', { ...oidcConnection, revision: 'v2', scimTokenHash: digest(scimToken) });
  assert.equal((await app.inject({ url: stale.url, headers: { cookie: stale.cookie } })).statusCode, 401);
  const { url, cookie } = await begin();
  assert.equal((await app.inject({ url, headers: { cookie: `__Host-smartsell_sso=${opaque()}` } })).statusCode, 401);
  assert.equal((await app.inject({ url: `${url}&state=${opaque()}`, headers: { cookie } })).statusCode, 401);
  assert.equal((await app.inject({ url: url.replace('/acme/', '/other/'), headers: { cookie } })).statusCode, 401);
  assert.equal((await app.inject({ url, headers: { cookie } })).statusCode, 200);
  assert.equal((await app.inject({ url, headers: { cookie } })).statusCode, 401);
  credentials.add(`acme/work/${id}/pat`);
  credentials.add(`acme/work/${id}/oauth`);
  credentials.add('other/work/unrelated/pat');
  const disabled = await app.inject({ method: 'PATCH', url: `${scimPath}/${id}`, headers, payload: {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'replace', path: 'active', value: false }],
  } });
  assert.equal(disabled.statusCode, 200);
  assert.equal(disabled.json().active, false);
  assert.deepEqual([...credentials], ['other/work/unrelated/pat']);
  const after = await begin();
  assert.equal((await app.inject({ url: after.url, headers: { cookie: after.cookie } })).statusCode, 401);
});

test('signed SAML response and assertion use the tenant ACS, persistent subject and single request', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'smartsell-saml-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = await fileStore(join(directory, 'state.json'));
  const identityKey = randomBytes(32);
  const config = configuration({ PUBLIC_ORIGIN: origin, SMARTSELL_IDENTITY_DEPLOYMENT: 'saas' });
  const app = createServer({ config, store, identityKey, operations: [] });
  t.after(() => app.close());
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const setup = await fetch(`${base}/api/v1/setup`, { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.test', password: 'saml-test-password', workspaceName: 'SAML test' }),
  });
  assert.equal(setup.status, 201);
  const { data } = await setup.json();
  const workspaceId: string = data.workspaces[0].id;
  const tenantId = await store.transaction({ readOnly: true }, ({ identity }) => identity.get<{ tenantId: string }>(`workspace/${workspaceId}`)!.tenantId);
  const privatePath = join(directory, 'private.pem');
  const certPath = join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', privatePath, '-out', certPath,
    '-days', '1', '-subj', '/CN=smartsell-test-idp'], { stdio: 'ignore' });
  const privateKey = readFileSync(privatePath, 'utf8');
  const certificate = readFileSync(certPath, 'utf8');
  const scimToken = opaque();
  const connection = { tenantId, workspaceId, connectionId: 'saml', protocol: 'saml', seatLimit: 2, scimTokenHash: digest(scimToken),
    issuer: 'urn:test-idp', entryPoint: 'https://saml.example.test/login', entityId: 'urn:smartsell:acme:saml',
    idpCert: certificate, nameIdFormat: samlFormat };
  await configureEnterpriseConnection(store, identityKey, connection);
  const scim = await fetch(`${base}/api/v1/scim/${tenantId}/saml/v2/Users`, { method: 'POST',
    headers: { authorization: `Bearer ${scimToken}`, 'content-type': 'application/scim+json' }, body: JSON.stringify(user),
  });
  assert.equal(scim.status, 201);
  const { id } = await scim.json();
  const path = `/api/v1/auth/sso/${tenantId}/saml/saml`;
  const callback = `${origin}${path}/callback`;
  function signed(xml: string, element: string, prefix: string) {
    const location = `//*[local-name()='${element}']`;
    const signer = new SignedXml({ privateKey, signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#' });
    signer.addReference({ xpath: location, digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'] });
    signer.computeSignature(xml, { prefix, location: { reference: `${location}/*[local-name()='Issuer']`, action: 'after' } });
    return signer.getSignedXml();
  }
  const run = async (scenario?: 'recipient' | 'audience' | 'expiry' | 'destination' | 'unsigned' | 'request') => {
    const start = await fetch(`${base}${path}/start`, { method: 'POST', headers: { origin }, redirect: 'manual' });
    assert.equal(start.status, 303);
    const redirect = new URL(start.headers.get('location')!);
    const cookie = start.headers.get('set-cookie')!.split(';')[0];
    const request = inflateRawSync(Buffer.from(redirect.searchParams.get('SAMLRequest')!, 'base64')).toString();
    const requestId = scenario === 'request' ? '_another-request' : /\bID="([^"]+)"/.exec(request)?.[1];
    assert.ok(requestId);
    const now = Date.now();
    const issued = new Date(now).toISOString();
    const expires = new Date(now + (scenario === 'expiry' ? -60_000 : 60_000)).toISOString();
    const recipient = scenario === 'recipient' ? 'https://wrong.example.test' : callback;
    const destination = scenario === 'destination' ? 'https://wrong.example.test' : callback;
    const audience = scenario === 'audience' ? 'urn:wrong' : connection.entityId;
    const assertion = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${issued}"><saml:Issuer>${connection.issuer}</saml:Issuer><saml:Subject><saml:NameID Format="${samlFormat}">subject</saml:NameID><saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData InResponseTo="${requestId}" Recipient="${recipient}" NotOnOrAfter="${expires}"/></saml:SubjectConfirmation></saml:Subject><saml:Conditions NotOnOrAfter="${expires}"><saml:AudienceRestriction><saml:Audience>${audience}</saml:Audience></saml:AudienceRestriction></saml:Conditions><saml:AuthnStatement AuthnInstant="${issued}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement></saml:Assertion>`;
    const response = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomUUID()}" Version="2.0" IssueInstant="${issued}" Destination="${destination}" InResponseTo="${requestId}"><saml:Issuer>${connection.issuer}</saml:Issuer><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>${scenario === 'unsigned' ? assertion : signed(assertion, 'Assertion', 'ds')}</samlp:Response>`;
    const encoded = Buffer.from(signed(response, 'Response', 'ds')).toString('base64');
    return () => fetch(`${base}${path}/callback`, { method: 'POST', redirect: 'manual', headers: { cookie, origin: 'https://saml.example.test' },
      body: new URLSearchParams({ RelayState: redirect.searchParams.get('RelayState')!, SAMLResponse: encoded }),
    });
  };
  for (const scenario of ['recipient', 'audience', 'expiry', 'destination', 'unsigned', 'request'] as const) {
    const send = await run(scenario);
    assert.equal((await send()).status, 401, scenario);
  }
  const send = await run();
  const result = await send();
  assert.equal(result.status, 303);
  const cookie = result.headers.get('set-cookie')!.split(';')[0];
  const session = await fetch(`${base}/api/v1/session`, { headers: { cookie } });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).data.user.id, id);
  assert.equal((await send()).status, 401);
});
