import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { parseEnv } from 'node:util';
import { checkReportXlsx } from './report-xlsx-smoke.mjs';

const [phase, work, envPath] = process.argv.slice(2);
const base = process.env.SMARTSELL_OPS_WEB_URL;
const portal = process.env.SMARTSELL_OPS_PORTAL_URL;
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
assert.match(portal, /^http:\/\/127\.0\.0\.1:\d+$/);
const settings = parseEnv(await readFile(envPath, 'utf8'));
const sample = Buffer.from('physical backup smoke fixture\n');
const digest = createHash('sha256').update(sample).digest('hex');
const stateFile = `${work}/state.json`;
const state = phase === 'source' ? { password: randomBytes(24).toString('hex') } : JSON.parse(await readFile(stateFile, 'utf8'));
const email = 'ops-smoke@example.invalid';
let cookie;
let csrf;
async function request(path, { endpoint = base, body, status = 200, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) {
  const isPortal = endpoint === portal;
  const requestHeaders = new Headers(headers);
  if (isPortal) requestHeaders.set('host', new URL(settings.PORTAL_ORIGIN).host);
  if (!isPortal && cookie) requestHeaders.set('cookie', cookie);
  if (!isPortal && csrf) requestHeaders.set('x-csrf-token', csrf);
  if (body !== undefined) {
    requestHeaders.set('content-type', 'application/json');
    if (!requestHeaders.has('origin')) requestHeaders.set('origin', isPortal ? settings.PORTAL_ORIGIN : settings.PUBLIC_ORIGIN);
  }
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const signal = AbortSignal.timeout(10_000);
  // fetch substitutes the loopback authority for the portal Host.
  const response = isPortal ? await new Promise((resolve, reject) => {
    const request = httpRequest(`${endpoint}${path}`, { method, signal, headers: Object.fromEntries(requestHeaders) }, incoming => {
      const chunks = [];
      incoming.on('data', chunk => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => resolve(new Response(chunks.length ? Buffer.concat(chunks) : null,
        { status: incoming.statusCode, headers: incoming.headers })));
    });
    request.on('error', reject).end(payload);
  }) : await fetch(`${endpoint}${path}`, { method, redirect: 'manual', signal, headers: requestHeaders, body: payload });
  assert.equal(response.status, status, `${method} ${path.split('?')[0]} (Origin: ${requestHeaders.get('origin') ?? 'absent'})`);
  return response;
}
const json = async (path, options) => (await request(path, options)).json();
const root = () => `/api/v1/workspaces/${state.workspace}`;
const command = async (module, action, body = {}, status = 200) => (await json(`${root()}/commands/${module}/${action}`, {
  body, status, headers: { 'idempotency-key': randomUUID() },
})).data;

if (phase === 'source') {
  const home = await (await request('/')).text();
  const bundle = home.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
  assert.ok(bundle, 'built Web manifest serves a hashed JavaScript entry');
  assert.match((await request(bundle)).headers.get('content-type'), /javascript/);
  assert.match(await (await request('/share', { endpoint: portal })).text(), /客戶門戶/);
  assert.match((await request('/assets/app.js', { endpoint: portal })).headers.get('content-type'), /javascript/);
  assert.match(await (await request(`/s/${randomUUID()}`, { endpoint: portal })).text(), /\/src\/main\.js/);
  await request('/api/v1/session', { endpoint: portal, status: 404 });
  const badShare = { endpoint: portal, body: { token: 'invalid' } };
  await request('/api/portal/share', { ...badShare, headers: { origin: settings.PUBLIC_ORIGIN }, status: 403 });
  await request('/api/portal/share', { ...badShare, status: 404 });
  assert.match(await (await request('/landing/example')).text(), /\/assets\/app\.js/);
  await request(`/api/public/landing/${'a'.repeat(32)}`, { status: 404 });
  console.log('Compose Web bundle, portal routes and isolated API, public page and API routing');
  await request('/api/v1/setup', { body: { email, password: state.password, name: 'Ops Smoke', workspaceName: 'Ops Smoke' },
    headers: { 'x-setup-token': settings.SETUP_TOKEN }, status: 201 });
}
const login = await request('/api/v1/session', { body: { email, password: state.password } });
const session = login.headers.get('set-cookie');
assert.match(session, /; Secure(?:;|$)/i);
cookie = session.split(';')[0];
const profile = await json('/api/v1/session');
const workspace = profile.workspaces.find(row => row.name === 'Ops Smoke')?.id;
assert.ok(workspace);
state.workspace ??= workspace;
assert.equal(state.workspace, workspace);
csrf = (await json('/api/v1/session/csrf')).csrf_token;
assert.ok(csrf);

if (phase === 'source') {
  const health = await command('ops', 'health');
  assert.equal(health.safe_mode, false);
  await checkReportXlsx(request, root());
  const fileSpec = { purpose: 'asset', mime_type: 'text/plain', size_bytes: sample.length, sha256: digest,
    original_filename: 'snapshot-fixture.txt' };
  const ticket = (await json(`${root()}/files/uploads`, { body: fileSpec, headers: { 'idempotency-key': randomUUID() } })).data;
  const completePath = `${root()}/files/uploads/${ticket.id}/complete`;
  await request(completePath, { body: { base64: Buffer.alloc(sample.length).toString('base64') }, status: 422,
    headers: { 'idempotency-key': randomUUID() } });
  const file = (await json(completePath, { body: { base64: sample.toString('base64') }, headers: { 'idempotency-key': randomUUID() } })).data;
  assert.equal(file.sha256, digest);
  state.file = file.id;
  const consent = await command('lifecycle', 'create_consent_text', {
    channel: 'email', purpose: 'service', text: 'Reply to my request', locale: 'en',
  });
  const { page, version } = await command('traffic', 'pages_create_draft', {
    title: 'Physical drill public page', description: 'Public fixture',
    service_contact: { channel: 'email', consent_text_version_id: consent.id },
  });
  await command('traffic', 'publish_landing_page', { page_id: page.id, version_id: version.id, expected_version: page.version });
  state.landing = page.id;
  const delivery = await command('team', 'create_delivery', { title: 'Physical drill delivery', description: 'Recovery report',
    items: [{ title: 'Snapshot report', status: 'ready' }] });
  await command('team', 'publish_delivery', { id: delivery.id, version: delivery.version });
  const preview = await command('team', 'preview_share', { deliveryId: delivery.id });
  const share = await command('team', 'create_share', { deliveryId: delivery.id, previewVersion: preview.previewVersion,
    permissions: ['view'], expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  state.share = share.id;
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
} else {
  const health = await command('ops', 'health');
  assert.equal(health.safe_mode, true);
  await command('execution', 'start_restore_hold', { reason: 'physical recovery drill' });
  console.log('Fresh Compose target reused the physical workspace and booted with persisted safe mode');
  const task = '00000000-0000-4000-8000-000000000003';
  const attempt = '00000000-0000-4000-8000-000000000004';
  const taskPath = `${root()}/execution-tasks/${task}`;
  const detail = async () => (await json(taskPath)).data;
  const receipt = { publish_target_id: '00000000-0000-4000-8000-000000000002',
    permalink: 'https://www.facebook.com/fixture/posts/already-published', external_post_id: 'local-fixture-receipt',
    evidence_file_ids: ['00000000-0000-4000-8000-000000000005'] };
  const before = await detail();
  assert.deepEqual(before.attempts.map(row => [row.id, row.status]), [[attempt, 'unknown']]);
  assert.equal(before.attempt_count, 1);
  assert.deepEqual(before.pending_side_effects, [attempt]);
  const register = async () => (await json(`${root()}/platform-posts/register`, {
    body: receipt, headers: { 'idempotency-key': randomUUID() },
  })).data;
  const post = await register();
  assert.equal((await register()).id, post.id);
  const recovered = await detail();
  assert.equal(recovered.status, 'published');
  assert.equal(recovered.attempt_count, before.attempt_count);
  assert.deepEqual(recovered.attempts.map(row => [row.id, row.status]), [[attempt, 'verified_published']]);
  assert.equal(recovered.attempts[0].submission_started_at, before.attempts[0].submission_started_at);
  assert.equal(recovered.platform_post.external_post_id, receipt.external_post_id);
  assert.equal(recovered.platform_post.verification, 'manual_confirmed');
  assert.deepEqual(recovered.pending_side_effects, []);
  console.log('Restored original attempt linked to the fixture receipt with no new attempts or submission starts');
}
const download = (await json(`${root()}/files/${state.file}/download`)).data;
const signed = new URL(download.url, base);
const path = signed.pathname + signed.search;
const bytes = Buffer.from(await (await request(path)).arrayBuffer());
assert.deepEqual(bytes, sample);
const downloadedDigest = createHash('sha256').update(bytes).digest('hex');
assert.equal(downloadedDigest, digest);
const range = await request(path, { headers: { range: 'bytes=0-7' }, status: 206 });
assert.deepEqual(Buffer.from(await range.arrayBuffer()), sample.subarray(0, 8));
const share = (await json('/api/portal/share-token', { body: { workspaceId: state.workspace, shareId: state.share } })).data;
cookie = undefined;
csrf = undefined;
await request(path, { status: 401 });
const publicPage = await json(`/api/public/landing/${state.landing}`);
assert.match(JSON.stringify(publicPage), /Physical drill public page/);
const shared = await json('/api/portal/share', { endpoint: portal, body: { token: share.token } });
assert.match(JSON.stringify(shared), /Physical drill delivery/);
console.log(`${phase}: published public page and signed portal content are reachable through the Web service`);
console.log(`${phase}: signed file download SHA-256 ${downloadedDigest}; range and session checks passed`);
