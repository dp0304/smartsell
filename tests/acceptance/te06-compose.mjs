import { completedReportVersion } from './report-version.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request as forward } from 'node:http';
import { createServer, request as httpsRequest } from 'node:https';
import { parseEnv } from 'node:util';

const [work, project, mode, workbenchUpstream, portalUpstream] = process.argv.slice(2);
const settingsPath = `${work}/compose.env`;
const settings = parseEnv(await readFile(settingsPath, 'utf8'));
const [staff, review] = [settings.PUBLIC_ORIGIN, settings.PORTAL_ORIGIN];
const custom = settings.PORTAL_CUSTOM_ORIGINS?.split(',') ?? [];
const unknown = 'https://unknown.example.test';
const authority = origin => new URL(origin).host;
const routes = new Map([[authority(staff), workbenchUpstream],
  ...[review, ...custom].map(origin => [authority(origin), portalUpstream])]);
for (const upstream of routes.values()) assert.match(upstream, /^127\.0\.0\.1:\d+$/);

const cert = await readFile(`${work}/tls.crt`);
const edge = createServer({ cert, key: await readFile(`${work}/tls.key`) }, (req, res) => {
  const upstream = routes.get(req.headers.host);
  if (!upstream) {
    res.writeHead(421).end();
    return;
  }
  const proxy = forward(`http://${upstream}${req.url}`, { method: req.method, headers: req.headers }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  proxy.on('error', () => res.writeHead(502).end());
  req.pipe(proxy);
});
await new Promise((resolve, reject) => edge.listen(0, '127.0.0.1', resolve).once('error', reject));

async function request(origin, path, { body, status = 200, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const json = body === undefined ? undefined : JSON.stringify(body);
  const response = await new Promise((resolve, reject) => {
    const req = httpsRequest({ hostname: '127.0.0.1', port: edge.address().port, servername: authority(origin), ca: cert,
      path, method, signal: AbortSignal.timeout(10_000), headers: { host: authority(origin),
        ...(json !== undefined && { origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) }), ...headers } }, async res => {
      try {
        const chunks = [];
        for await (const chunk of res) chunks.push(chunk);
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() });
      } catch (error) { reject(error); }
    });
    req.on('error', reject).end(json);
  });
  assert.equal(response.status, status, `${method} ${origin}${path}`);
  return response;
}
const data = response => JSON.parse(response.text).data;
const expiry = () => new Date(Date.now() + 3_600_000).toISOString();
const fragment = href => href.split('#')[1];

function seedSecondTenant(owner) {
  const workspace = randomUUID();
  const tenant = randomUUID();
  // The private deployment setup API provisions only the first tenant.
  execFileSync('docker', ['compose', '--env-file', settingsPath, '--project-name', project, '-f', 'infra/compose.yaml',
    '--profile', 'server', 'exec', '-T', 'postgres', 'psql', '-X', '-U', 'postgres', '-d', 'smartsell', '-v', 'ON_ERROR_STOP=1',
    '-v', `owner=${owner}`, '-v', `tenant=${tenant}`, '-v', `workspace=${workspace}`], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    input: `INSERT INTO smartsell.identity (id, value) VALUES
      ('tenant/' || :'tenant', jsonb_build_object('id', :'tenant', 'status', 'active')),
      ('workspace/' || :'workspace', jsonb_build_object('id', :'workspace', 'tenantId', :'tenant', 'name', 'South')),
      ('member/' || :'owner' || '/' || :'workspace', jsonb_build_object('userId', :'owner', 'workspaceId', :'workspace', 'role', 'owner'));`,
  });
  return workspace;
}

function assertion(origin, email) {
  const payload = Buffer.from(JSON.stringify({ sub: randomUUID(), email, audience: 'client', email_verified: true,
    origin, exp: Math.floor(Date.now() / 1000) + 120, jti: randomBytes(32).toString('base64url') })).toString('base64url');
  return `${payload}.${createHmac('sha256', settings.PORTAL_ASSERTION_KEY).update(`smartsell:portal-session:v1:${payload}`).digest('base64url')}`;
}

async function staffSession(disallowedOrigins) {
  const credentials = { email: 'owner@example.test', password: randomBytes(24).toString('hex') };
  const setup = await request(staff, '/api/v1/setup', { body: { ...credentials, name: 'Owner', workspaceName: 'North' },
    status: 201, headers: { 'x-setup-token': settings.SETUP_TOKEN } });
  const { user, workspaces: [first] } = data(setup);
  for (const origin of disallowedOrigins) {
    await request(staff, '/api/v1/session', { body: credentials, headers: { origin }, status: 403 });
  }
  const login = await request(staff, '/api/v1/session', { body: credentials });
  const [session] = login.headers['set-cookie'];
  assert.match(session, /; Secure(?:;|$)/i);
  const staffCookie = session.split(';')[0];
  const { csrf_token: csrf } = await request(staff, '/api/v1/session/csrf', { headers: { cookie: staffCookie } })
    .then(response => JSON.parse(response.text));
  assert.ok(csrf);
  const employee = (path, { headers, ...options } = {}) => request(staff, path, { ...options,
    headers: { cookie: staffCookie, 'x-csrf-token': csrf, 'idempotency-key': randomUUID(), ...headers } });
  const workspace = (id, path, options) => employee(`/api/v1/workspaces/${id}${path}`, options);
  return { user, first, employee, workspace };
}

async function checkCustomPortals() {
  const [north, south] = custom;
  const workbench = await request(staff, '/');
  const bundle = workbench.text.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
  assert.ok(bundle, 'workbench serves the built Web entry');
  assert.match((await request(staff, bundle)).headers['content-type'], /javascript/);
  assert.equal(data(await request(review, '/api/v1/portal/branding')), null);
  await request(staff, '/api/v1/portal/branding', { status: 404 });
  for (const origin of [north, south]) {
    assert.match((await request(origin, '/')).text, /\/src\/main\.js/);
    for (const asset of ['main.js', 'api.js', 'i18n.js', 'styles.css']) {
      const resource = await request(origin, `/src/${asset}`);
      assert.match(resource.headers['content-type'], asset.endsWith('.js') ? /javascript/ : /text\/css/);
      assert.ok(resource.text.length > 0);
    }
    await request(origin, '/src/missing.js', { status: 404 });
    await request(origin, '/api/v1/portal/branding', { status: 404 });
    await request(origin, '/api/v1/session', { status: 404 });
    await request(origin, '/mcp', { status: 404 });
    const body = { token: 'invalid' };
    await request(origin, '/api/portal/share', { body, status: 403 });
    await request(origin, '/api/portal/share', { body, headers: { origin: review }, status: 403 });
    await request(origin, '/api/portal/creator-submit', { body, headers: { origin: review }, status: 403 });
  }
  for (const path of ['/', '/src/main.js', '/api/v1/portal/branding']) await request(unknown, path, { status: 421 });
  console.log('TE06: TLS Host routing, portal assets and API boundaries passed');

  const { user, first, workspace } = await staffSession([review, north, south]);
  const southId = seedSecondTenant(user.id);
  const branding = (id, portal_origin, label, accent, status = 200) => workspace(id, '/branding', {
    method: 'PUT', body: { portal_origin, label, accent }, status,
  });
  await branding(first.id, unknown, 'Unknown', '#286450', 422);
  for (const [origin, id, label, accent] of [[north, first.id, 'North Studio', '#286450'], [south, southId, 'South Studio', '#314a80']]) {
    await branding(id, origin, label, accent);
    assert.deepEqual(data(await request(origin, '/api/v1/portal/branding')), { label, accent });
  }
  await request(north, '/api/v1/portal/branding', { headers: { 'x-forwarded-host': authority(south) } })
    .then(response => assert.equal(data(response).label, 'North Studio'));

  const portal = (origin, path, options) => request(origin, `/api/v1/portal${path}`, options);
  async function portalSession(origin, id, email) {
    const invite = data(await workspace(id, '/portal-invitations', { body: { audience: 'client', email, expires_at: expiry() } }));
    const invitePage = await request(origin, invite.href.split('#')[0]);
    assert.match(invitePage.text, /\/src\/main\.js/);
    const other = origin === north ? south : north;
    const proof = assertion(origin, email);
    await portal(origin, '/session', { body: { assertion: proof }, headers: { origin: other }, status: 404 });
    await portal(other, '/session', { body: { assertion: proof }, status: 404 });
    const login = await portal(origin, '/session', { body: { assertion: proof }, status: 204 });
    const [session] = login.headers['set-cookie'];
    assert.match(session, /^__Host-smartsell_portal=/);
    for (const attribute of [/; Path=\/(?:;|$)/i, /; Secure(?:;|$)/i, /; HttpOnly(?:;|$)/i]) assert.match(session, attribute);
    assert.doesNotMatch(session, /;\s*Domain=/i);
    const headers = { cookie: session.split(';')[0] };
    await portal(origin, `/invitations/${invite.id}/accept`, { headers, body: { token: fragment(invite.href) } });
    assert.deepEqual(data(await portal(origin, '/workspaces', { headers })), [{ id }]);
    await portal(other, '/me', { headers, status: 401 });
    await portal(review, '/me', { headers, status: 401 });
  }
  await portalSession(north, first.id, 'north-client@example.test');
  await portalSession(south, southId, 'south-client@example.test');

  async function signedShare(origin, other, id, title) {
    const post = async (path, body, headers) => data(await workspace(id, path, { body, headers }));
    const report = await post('/reports', { kind: 'client_monthly', title,
      period: { from: '2026-10-01', to: '2026-11-01' }, sections: [{ key: 'overview', type: 'narrative' }] });
    const receipt = data(await workspace(id, `/reports/${report.id}/versions`, { body: {}, status: 202 }));
    const draft = await completedReportVersion(async path => data(await workspace(id, path)), receipt);
    const revision = await post(`/report-versions/${draft.id}/finalize`, {}, { 'if-match': String(draft.version) });
    const input = { resource_type: 'report', resource_id: report.id, revision_id: revision.id, audience: 'client',
      grantee_type: 'link', permissions: ['view'], expires_at: expiry() };
    const { preview_hash } = await post('/shares/preview', input);
    const share = await post('/shares', { ...input, preview_hash });
    assert.match((await request(origin, share.href.split('#')[0])).text, /\/src\/main\.js/);
    const headers = { authorization: `Share ${fragment(share.href)}` };
    assert.ok((await portal(origin, `/shares/${share.id}`, { headers })).text.includes(title));
    await portal(other, `/shares/${share.id}`, { headers, status: 404 });
    await portal(unknown, `/shares/${share.id}`, { headers, status: 421 });
  }
  await signedShare(north, south, first.id, 'North report');
  await signedShare(south, north, southId, 'South report');
  console.log('TE06: both tenant brands, invitations, host-only sessions and signed shares passed');
}

async function checkLegacyPortal() {
  const { first, workspace, employee } = await staffSession([review]);
  const legacy = async (action, body) => data(await workspace(first.id, `/commands/team/${action}`, { body }));
  const delivery = await legacy('create_delivery', { title: 'Default portal delivery', description: 'Synthetic legacy report',
    items: [{ title: 'Report', status: 'ready' }] });
  await legacy('publish_delivery', { id: delivery.id, version: delivery.version });
  const preview = await legacy('preview_share', { deliveryId: delivery.id });
  const share = await legacy('create_share', { deliveryId: delivery.id, previewVersion: preview.previewVersion,
    permissions: ['view'], expiresAt: expiry() });
  const { token } = data(await employee('/api/portal/share-token', { body: { workspaceId: first.id, shareId: share.id } }));
  assert.match((await request(review, '/share')).text, /客戶門戶/);
  assert.match((await request(review, '/creator')).text, /客戶門戶/);
  assert.match((await request(review, '/assets/app.js')).headers['content-type'], /javascript/);
  const body = { token };
  assert.match((await request(review, '/api/portal/share', { body })).text, /Default portal delivery/);
  await request(review, '/api/portal/share', { status: 405 });
  await request(review, '/api/portal/share', { body, headers: { origin: '' }, status: 403 });
  await request(staff, '/api/portal/share', { body, headers: { origin: review }, status: 403 });
  await request(review, '/api/portal/share', { body, headers: { origin: staff }, status: 403 });
  await request(review, '/api/portal/creator-submit', { body: { token: 'invalid' }, status: 404 });
  await request(review, '/api/v1/session', { status: 404 });
  await request(unknown, '/share', { status: 421 });
  console.log('TE06: default portal legacy routes and workbench Origin isolation passed');
}

try {
  if (mode === 'operations') await checkCustomPortals();
  else await checkLegacyPortal();
} finally {
  await new Promise((resolve, reject) => edge.close(error => error ? reject(error) : resolve()));
}
