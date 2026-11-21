import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const uploadScope = 'https://www.googleapis.com/auth/youtube.upload';
const readScope = 'https://www.googleapis.com/auth/youtube.readonly';
const shopDomain = 'ac02-fixture.myshopify.com';
const channel = 'UC-fixture-ac02';
const receipt = 'ac02video01';

// The default Commands entrypoint uses its real provider adapters. Intercept their HTTP transport
// before startup so external traffic can only receive these synthetic replies.
function installPlatformFixture({ uploadScope, readScope, shopDomain, channel, receipt }) {
  const fetchLocal = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input);
    if (url.hostname === '127.0.0.1' && url.protocol === 'http:') return fetchLocal(input, init);
    const { appendFileSync } = await import('node:fs');
    const record = label => appendFileSync(process.env.AC02_JOURNAL, label + '\n');
    const reply = data => Response.json(data);
    const auth = new Headers(init.headers);
    const endpoint = `${init.method} ${url.hostname}${url.pathname}`;
    switch (endpoint) {
      case 'POST oauth2.googleapis.com/token': {
        const body = new URLSearchParams(init.body);
        const code = body.get('code');
        if (body.get('grant_type') !== 'authorization_code' || !['writer', 'reader', 'other'].includes(code) || !body.get('code_verifier')) break;
        record(`youtube-token-${code}`);
        return reply({ access_token: `ac02-token-${code}`, scope: code === 'reader' ? readScope : uploadScope, expires_in: 3600 });
      }
      case 'GET www.googleapis.com/youtube/v3/channels':
        return reply({ items: [{ id: channel, snippet: { title: 'AC02 synthetic channel' } }] });
      case 'POST www.googleapis.com/upload/youtube/v3/videos':
        if (auth.get('authorization') !== 'Bearer ac02-token-writer' || url.searchParams.get('uploadType') !== 'resumable') break;
        record('upload-init');
        url.searchParams.set('upload_id', 'synthetic-ac02-session');
        return new Response(null, { headers: { location: url.href } });
      case 'PUT www.googleapis.com/upload/youtube/v3/videos':
        if (auth.get('authorization') !== 'Bearer ac02-token-writer' || url.searchParams.get('upload_id') !== 'synthetic-ac02-session' || !init.body?.length) break;
        record('upload-submit');
        return reply({ id: receipt });
      case 'GET www.googleapis.com/youtube/v3/videos':
        if (auth.get('authorization') !== 'Bearer ac02-token-reader' || url.searchParams.get('id') !== receipt) break;
        record('read-only-observe');
        return reply({ items: [{ id: receipt, snippet: { channelId: channel }, status: { uploadStatus: 'processed', privacyStatus: 'private' } }] });
      case `POST ${shopDomain}/admin/oauth/access_token`: {
        const body = new URLSearchParams(init.body);
        if (body.get('grant_type') !== 'client_credentials' || body.get('client_id') !== 'fixture' ||
            body.get('client_secret') !== 'fixture-shop-secret' || body.has('scope')) break;
        record('shop-token');
        return reply({ access_token: 'ac02-token-shop', scope: 'read_products', expires_in: 3600 });
      }
      case `POST ${shopDomain}/admin/api/2026-10/graphql.json`:
        if (auth.get('x-shopify-access-token') !== 'ac02-token-shop' || !JSON.parse(init.body).query.includes('ProbeShop')) break;
        record('shop-probe');
        return reply({ data: { shop: { id: 'gid://shopify/Shop/102', name: 'AC02 synthetic shop', myshopifyDomain: shopDomain } } });
    }
    record(`unexpected ${endpoint}`);
    throw new Error('Unexpected provider request in the AC02 fixture');
  };
}

async function waitFor(read, predicate, message) {
  let result;
  for (let index = 0; index < 120; index++) {
    result = await read();
    if (predicate(result)) return result;
    await delay(100);
  }
  assert.fail(`${message}. Last result: ${JSON.stringify(result)}`);
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'smartsell-ac02-'));
  const preload = join(directory, 'no-network.mjs');
  const journal = join(directory, 'provider.log');
  await writeFile(preload, `(${installPlatformFixture})(${JSON.stringify({ uploadScope, readScope, shopDomain, channel, receipt })});`);
  await writeFile(journal, '');
  const children = new Set();
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    assert.equal((await exited)[0], 0);
  }
  t.after(async () => {
    try { await Promise.all([...children].map(stop)); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
  async function workspace(label) {
    const socket = createServer().listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const { port } = socket.address();
    await new Promise((resolve, reject) => socket.close(error => error ? reject(error) : resolve()));
    const base = `http://127.0.0.1:${port}`;
    const dbPath = join(directory, `${label}.sqlite`);
    const setupToken = randomUUID();
    const credentials = { email: `${label}@example.invalid`, password: randomUUID() };
    const secret = createHash('sha256').update(randomUUID()).digest('hex');
    let child, session, ws;
    let shopApps = [];
    async function start(apiOnly = false) {
      // Local configuration requires ROLE=all. Override the validated roles only during the held-worker phase.
      const entrypoint = apiOnly ? ['--input-type=module', '--eval', `
        import { start } from './apps/server/src/bootstrap.ts';
        import { configuration } from './apps/server/src/config.ts';
        const app = await start({ ...configuration(), roles: new Set(['api']) });
        process.once('SIGTERM', () => void app.close().catch(() => { process.exitCode = 1; }));
      `] : ['apps/server/src/command-main.ts'];
      child = spawn(process.execPath, ['--import', 'tsx', '--import', preload, ...entrypoint], {
        env: { PATH: process.env.PATH, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: String(port), PUBLIC_ORIGIN: 'https://ac02.example.invalid',
          SMARTSELL_STORE: 'local', SMARTSELL_DATA_FILE: dbPath, MEDIA_DIRECTORY: join(directory, `${label}-media`), APP_SECRET: secret,
          SETUP_TOKEN: setupToken, AC02_JOURNAL: journal, SMARTSELL_SHOPIFY_APPS: JSON.stringify(shopApps),
          SMARTSELL_COMMERCE_PROVIDER_CREDENTIALS: JSON.stringify({ youtube: { clientId: 'fixture', clientSecret: 'fixture-secret' } }) },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.add(child);
      let logs = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { logs = (logs + data).slice(-8000); });
      await waitFor(async () => {
        assert.equal(child.exitCode, null, logs);
        return fetch(`${base}/healthz`).then(response => response.ok, () => false);
      }, Boolean, 'Commands server failed to listen');
    }
    async function request(method, path, body, { status = 200, headers = session, key, version } = {}) {
      const response = await fetch(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(5000),
        headers: { ...headers, ...(body !== undefined && { 'content-type': 'application/json' }),
          ...(key && { 'idempotency-key': key }), ...(version !== undefined && { 'if-match': String(version) }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await response.text();
      assert.equal(response.status, status, `${method} ${path}: ${raw}`);
      assert.doesNotMatch(raw, /ac02-token-|synthetic-ac02-session|sealed_token/);
      return { result: raw ? JSON.parse(raw) : undefined, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    async function login(account = credentials) {
      const { cookie } = await request('POST', '/api/v1/session', account, { headers: {} });
      const { result } = await request('GET', '/api/v1/session/csrf', undefined, { headers: { cookie } });
      return { cookie, 'x-csrf-token': result.csrf_token };
    }
    const path = (route, workspaceId = ws) => `/api/v1/workspaces/${workspaceId}${route}`;
    const call = async (method, route, body, options) => {
      const { result } = await request(method, path(route), body, options);
      return result.data ?? result.code;
    };
    function snapshot() {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try { return JSON.parse(db.prepare('SELECT payload FROM snapshot WHERE id = 1').get().payload); }
      finally { db.close(); }
    }
    function records(prefix) {
      return snapshot().records.map(([, row]) => row).filter(row => row.module === 'operation_runtime' &&
        row.id.startsWith(prefix) && typeof row.data.value === 'string').map(row => JSON.parse(row.data.value));
    }
    const rows = kind => records(`row/${kind}/`);
    const events = type => records('outbox/').filter(event => event.type === type);
    await start();
    const { result } = await request('POST', '/api/v1/setup', { ...credentials, name: label, workspaceName: label }, {
      status: 201, headers: { 'x-setup-token': setupToken },
    });
    ws = result.workspaces[0].id;
    session = await login();
    return { ws, call, request, path, rows, events, login, tenantId: snapshot().scope.tenantId,
      async restart(apps = shopApps, apiOnly = false) { await stop(child); shopApps = apps; await start(apiOnly); session = await login(); } };
  }
  return { workspace, journal: async () => (await readFile(journal, 'utf8')).trim().split('\n').filter(Boolean) };
}

async function authorize(s, brandId, code, scopes, extra = {}) {
  const before = await s.call('GET', '/connections');
  const start = await s.call('POST', '/connections/oauth/start', { provider: 'youtube', brand_id: brandId, scopes, ...extra });
  const url = new URL(start.authorize_url);
  const state = url.searchParams.get('state');
  assert.equal(state.split('.')[0], s.ws);
  assert.match(url.searchParams.get('code_challenge'), /^[\w-]{43}$/);
  const callback = '/api/v1/oauth/callback/youtube?' + new URLSearchParams({ state, code });
  assert.deepEqual((await s.request('GET', callback)).result.data, { status: 'authorized' });
  await s.request('GET', callback, undefined, { status: 400 });
  const connection = (await s.call('GET', '/connections')).find(row => !before.some(old => old.id === row.id));
  assert.equal(connection.purpose, 'social');
  const [account] = await s.call('POST', `/connections/${connection.id}/accounts/link`, { external_account_ids: [channel] });
  return { connection, account };
}

test('AC02 default product revocation fences queued uploads and retains an accepted receipt across restart', async t => {
  const testHost = await fixture(t);
  const s = await testHost.workspace('ac02-primary');
  const other = await testHost.workspace('ac02-other');
  const put = (route, input) => s.call('POST', route, input);
  const read = route => s.call('GET', route);
  const brand = await put('/brands', { name: 'AC02 brand', slug: 'ac02' });
  const otherBrand = await other.call('POST', '/brands', { name: 'Other AC02 brand', slug: 'other-ac02' });
  const app = await put('/platform-apps', { provider: 'shopify', distribution: 'merchant_custom', shop_domain: shopDomain, scope_version: 'fixture-v1' });
  const otherApp = await other.call('POST', '/platform-apps', { provider: 'shopify', distribution: 'merchant_custom', shop_domain: shopDomain, scope_version: 'fixture-v1' });
  const merchantGrant = { tenantId: s.tenantId, workspaceId: s.ws, appId: app.id, shopDomain, clientId: 'fixture',
    clientSecret: 'fixture-shop-secret', oauthScopes: ['read_products'] };
  const merchant = id => ({ brand_id: brand.id, platform_app_id: id });
  const shopOAuth = (id = app.id, domain = shopDomain) => ({ provider: 'shopify', ...merchant(id), shop_domain: domain });
  await s.call('POST', '/connections/shopify/merchant', merchant(app.id), { status: 409 });
  await s.call('POST', '/connections/oauth/start', shopOAuth(), { status: 409 });
  const activate = { status: 'active', scope_version: 'fixture-v1' };
  await s.restart([{ ...merchantGrant, egressVerified: false }]);
  await s.call('PATCH', `/platform-apps/${app.id}`, activate, { version: app.version, status: 409 });
  await s.call('POST', '/connections/shopify/merchant', merchant(app.id), { status: 409 });
  await s.call('POST', '/connections/oauth/start', shopOAuth(), { status: 409 });
  assert.deepEqual(await testHost.journal(), []);
  const grants = [{ ...merchantGrant, egressVerified: true }];
  await s.restart(grants);
  const activeApp = await s.call('PATCH', `/platform-apps/${app.id}`, activate, { version: app.version });
  assert.ok(activeApp.version > app.version);
  assert.equal(await s.call('PATCH', `/platform-apps/${app.id}`, activate, { version: app.version, status: 409 }), 'VERSION_CONFLICT');
  await other.restart([...grants, { ...grants[0], appId: otherApp.id }]);
  await other.call('PATCH', `/platform-apps/${otherApp.id}`, activate, { version: otherApp.version, status: 409 });
  await other.call('POST', '/connections/shopify/merchant', { brand_id: otherBrand.id, platform_app_id: otherApp.id }, { status: 409 });
  await s.call('POST', '/connections/shopify/merchant', merchant(otherApp.id), { status: 404 });
  await s.call('POST', '/connections/oauth/start', shopOAuth(app.id, 'other-ac02.myshopify.com'), { status: 409 });
  const apps = await read('/platform-apps');
  const readyApp = apps.find(row => row.id === app.id);
  assert.deepEqual([readyApp.status, readyApp.shop_domain, readyApp.egress_verified], ['active', shopDomain, true]);
  assert.equal(await s.call('POST', '/connections/oauth/start', shopOAuth(), { status: 409 }), 'PLATFORM_APP_NOT_READY');
  assert.deepEqual(await testHost.journal(), []);
  const shop = await put('/connections/shopify/merchant', merchant(app.id));
  assert.deepEqual(await testHost.journal(), ['shop-token', 'shop-probe']);
  assert.deepEqual(await read(`/connections/${shop.id}/accounts`), [{ external_account_id: 'gid://shopify/Shop/102', display_name: 'AC02 synthetic shop' }]);
  const store = await put('/stores', { provider: 'shopify', external_store_id: 'gid://shopify/Shop/102', name: 'Synthetic shop',
    mode: 'authorize', brand_id: brand.id, connection_id: shop.id, default_currency: 'USD', default_locale: 'en-US' });
  assert.equal(shop.purpose, 'store');
  assert.equal(shop.platform_app_id, app.id);
  assert.equal((await read(`/stores/${store.id}`)).connection_id, shop.id);
  assert.deepEqual(await read('/social-accounts'), []);
  await s.call('POST', `/connections/${shop.id}/accounts/link`, { external_account_ids: ['gid://shopify/Shop/102'] }, { status: 409 });

  const { connection: writer, account } = await authorize(s, brand.id, 'writer', [uploadScope]);
  const outside = await authorize(other, otherBrand.id, 'other', [uploadScope]);
  assert.notEqual(outside.account.id, account.id);
  const revoke = id => `/connections/${id}/revoke`;
  await other.request('POST', s.path(revoke(writer.id)), {}, { status: 404, headers: await other.login() });
  await other.call('POST', revoke(writer.id), {}, { status: 404 });
  await s.call('POST', revoke(outside.connection.id), {}, { status: 404 });
  const editor = { email: 'ac02-editor@example.invalid', password: randomUUID() };
  const invite = await put('/members/invite', { email: editor.email, role: 'editor' });
  await s.request('POST', '/api/v1/member-invitations/accept', { ...editor, name: 'AC02 editor', token: invite.invitation_token }, { status: 204, headers: {} });
  await s.call('POST', revoke(writer.id), {}, { status: 403, headers: await s.login(editor) });
  const session = await s.login();
  await s.call('POST', revoke(writer.id), {}, { status: 403, headers: { cookie: session.cookie } });
  const probe = `/social-accounts/${account.id}/capabilities/probe`;
  assert.ok((await put(probe, {})).capabilities.some(cap => cap.operation === 'publish' && cap.content_format === 'video' && cap.status === 'available'));
  const payload = execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=160x90:r=24:d=1', '-c:v', 'libx264',
    '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']);
  const ticket = await put('/files/uploads', { purpose: 'asset', mime_type: 'video/mp4', original_filename: 'fixture.mp4',
    size_bytes: payload.length, sha256: createHash('sha256').update(payload).digest('hex') });
  const media = await put(`/files/uploads/${ticket.id}/complete`, { base64: payload.toString('base64') });
  const asset = await put('/assets', { brand_id: brand.id, title: 'Synthetic source', kind: 'video', file_object_id: media.id });
  const rights = await put('/rights-grants', { brand_id: brand.id, grant_type: 'owned', asset_ids: [asset.id], usages: ['organic_social'] });
  await s.call('POST', `/rights-grants/${rights.id}/activate`, {}, { version: rights.version });
  await s.call('PUT', `/execution-settings/workspace/${s.ws}`, { verify_schedule_seconds: [1] });
  async function approvedTask(title) {
    const { variants: [variant] } = await put('/content-items', { brand_id: brand.id, title, variants: [{ platform: 'youtube', format: 'video',
      locale: 'en', title, body_markdown: title, media: [{ asset_version_id: asset.asset_version.id }],
      settings: { platform_options: { youtube: { title, categoryId: '22', madeForKids: false } } } }] });
    const revision = await put(`/content-variants/${variant.id}/revisions`, { base_revision_id: null });
    await s.call('POST', `/content-variants/${variant.id}/readiness`, {}, { version: revision.variant.version });
    const target = await put('/publish-targets', { social_account_id: account.id, content_variant_id: variant.id, variant_revision_id: revision.revision.id,
      schedule_kind: 'asap', visibility: 'private' });
    const submitted = await put(`/publish-targets/${target.id}/submit`, {});
    const approved = await s.call('POST', `/publish-targets/${target.id}/approve`, {}, { version: submitted.version });
    assert.equal(approved.plan_status, 'ready', JSON.stringify(approved.precheck));
    assert.ok(approved.execution_task_id);
    return `/execution-tasks/${approved.execution_task_id}`;
  }
  const acceptedPath = await approvedTask('AC02 accepted fixture');
  const accepted = await waitFor(() => read(acceptedPath), row => row.status === 'accepted', 'Fixture upload never reached accepted');
  const [attempt] = accepted.attempts;
  assert.equal(attempt.receipt, receipt);
  assert.deepEqual(accepted.pending_side_effects, [attempt.id]);
  // Keep the same product API and database while holding the background worker.
  await s.restart(grants, true);
  const queuedPath = await approvedTask('AC02 queued fixture');
  const queued = await read(queuedPath);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.route[0].executor, 'api');
  assert.deepEqual(queued.attempts, []);
  const impact = await put(revoke(writer.id), { dry_run: true });
  assert.deepEqual(impact.social_account_ids, [account.id]);
  assert.deepEqual(impact.store_ids, []);
  assert.deepEqual(new Set(impact.execution_task_ids), new Set([queued.id, accepted.id]));
  assert.equal((await read(queuedPath)).status, 'queued');
  assert.equal((await read('/connections')).find(row => row.id === writer.id).status, 'active');
  const reconnect = await put('/connections/oauth/start', { provider: 'youtube', brand_id: brand.id,
    scopes: [uploadScope], reconnect_connection_id: writer.id });
  const state = new URL(reconnect.authorize_url).searchParams.get('state');
  const callback = state => '/api/v1/oauth/callback/youtube?' + new URLSearchParams({ state, code: 'writer' });
  const tampered = state.slice(0, -1) + (state.endsWith('A') ? 'B' : 'A');
  await s.request('GET', callback(tampered), undefined, { status: 400 });
  const beforeRevoke = await read(queuedPath);
  assert.deepEqual([beforeRevoke.status, beforeRevoke.attempt_count, beforeRevoke.attempts], ['queued', 0, []]);
  const key = randomUUID();
  assert.deepEqual(await s.call('POST', revoke(writer.id), {}, { key }), impact);
  assert.deepEqual((await s.request('GET', callback(state), undefined, { status: 400 })).result.data, { status: 'failed' });
  assert.deepEqual(await s.call('POST', revoke(writer.id), {}, { key }), impact);
  assert.equal(await s.call('POST', revoke(writer.id), { dry_run: true }, { key, status: 422 }), 'IDEMPOTENCY_MISMATCH');
  assert.deepEqual(await put(revoke(writer.id), {}), impact);
  assert.equal(s.events('account.audit.recorded').filter(event => event.payload.action === 'account.connection.revoked' &&
    event.payload.connection_id === writer.id).length, 1);
  assert.equal(s.events('account.connection.revoked').filter(event => event.payload.connection_id === writer.id).length, 1);
  assert.equal(s.rows('connection').find(row => row.id === writer.id).sealed_token, null);
  assert.equal(s.rows('social_account_connection').find(row => row.connection_id === writer.id).status, 'revoked');
  assert.ok(s.rows('capability').some(row => row.connection_id === writer.id && row.operation === 'publish' && row.status === 'needs_authorization'));
  assert.equal((await read('/connections')).find(row => row.id === shop.id).status, 'active');
  assert.equal((await read(`/stores/${store.id}`)).connection_id, shop.id);
  async function assertBlocked() {
    const row = await read(queuedPath);
    assert.deepEqual([row.status, row.status_reason, row.attempt_count, row.platform_post], ['blocked', 'connection_revoked', 0, null]);
    assert.deepEqual(row.attempts, []);
  }
  async function assertPending() {
    const row = await read(acceptedPath);
    assert.equal(row.status, 'accepted');
    assert.deepEqual(row.attempts.map(value => [value.id, value.status, value.receipt, value.client_request_id, value.request_hash, value.fencing_token]),
      [[attempt.id, 'accepted', receipt, attempt.client_request_id, attempt.request_hash, attempt.fencing_token]]);
    assert.deepEqual(row.pending_side_effects, [attempt.id]);
    assert.ok(row.verifications.some(value => value.attempt_id === attempt.id && value.status === 'requested'));
    assert.equal(row.platform_post, null);
  }
  await assertBlocked();
  await assertPending();
  await s.call('POST', `${acceptedPath}/retry`, {}, { status: 409 });
  await s.restart();
  await assertBlocked();
  await assertPending();
  await waitFor(() => read(acceptedPath), row => row.verifications.some(value => value.outcome === 'inconclusive'), 'Revoked grant never reached pending verification');
  await assertPending();
  const beforeReadGrant = ['shop-token', 'shop-probe', 'youtube-token-writer', 'youtube-token-other', 'upload-init', 'upload-submit'];
  assert.deepEqual(await testHost.journal(), beforeReadGrant);
  const { connection: reader, account: linked } = await authorize(s, brand.id, 'reader', [readScope]);
  assert.deepEqual(reader.scopes, [readScope]);
  assert.equal(linked.id, account.id);
  const shopImpact = await put(revoke(shop.id), { dry_run: true });
  assert.deepEqual(shopImpact.store_ids, [store.id]);
  assert.deepEqual(shopImpact.social_account_ids, []);
  assert.deepEqual(shopImpact.execution_task_ids, []);
  assert.deepEqual(await put(revoke(shop.id), {}), shopImpact);
  assert.equal((await read('/connections')).find(row => row.id === reader.id).status, 'active');
  assert.equal(s.rows('connection').find(row => row.id === shop.id).sealed_token, null);
  const published = await waitFor(() => read(acceptedPath), row => row.status === 'published', 'Read-only grant did not verify the original accepted receipt');
  assert.deepEqual(published.attempts.map(value => [value.id, value.receipt]), [[attempt.id, receipt]]);
  assert.equal(published.platform_post.external_post_id, receipt);
  assert.equal(published.platform_post.verification, 'system_verified');
  await s.restart();
  const restored = await read(acceptedPath);
  assert.equal(restored.status, 'published');
  assert.deepEqual(restored.attempts.map(value => [value.id, value.receipt]), [[attempt.id, receipt]]);
  assert.deepEqual(restored.platform_post, published.platform_post);
  await assertBlocked();
  const connections = await read('/connections');
  assert.equal(connections.find(row => row.id === writer.id).status, 'revoked');
  assert.equal(connections.find(row => row.id === reader.id).status, 'active');
  const revokedShop = connections.find(row => row.id === shop.id);
  assert.deepEqual([revokedShop.status, revokedShop.platform_app_id], ['revoked', app.id]);
  assert.equal((await other.call('GET', '/connections')).find(row => row.id === outside.connection.id).status, 'active');
  assert.deepEqual((await other.call('GET', '/social-accounts')).map(row => row.id), [outside.account.id]);
  assert.deepEqual(await testHost.journal(), [...beforeReadGrant, 'youtube-token-reader', 'read-only-observe']);
});
