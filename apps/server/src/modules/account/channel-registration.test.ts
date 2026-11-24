import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { postgresStore } from '@smartsell/db';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { buildApp } from '../../app.js';
import { configuration } from '../../config.js';
import { commandBackgroundStore } from '../../integration/command-background.js';
import { createCommerceProviders } from '../../integration/commerce-providers.js';
import { createPublishHost } from '../../integration/publish-host.js';
import { localStore } from '../../local.js';
import { registerOperationRoutes } from '../../operation-server.js';
import { discoverOperations } from '../../operations.js';
import { PostgresStore } from '../../postgres.js';
import { createServer } from '../../server.js';
import { deviceRequestBytes } from './device-control.js';

const kernelPg = process.env.SMARTSELL_CHANNEL_TEST_KERNEL_PG_URL;
const commandPg = process.env.SMARTSELL_CHANNEL_TEST_COMMAND_PG_URL;
const backgroundPg = process.env.SMARTSELL_CHANNEL_TEST_BACKGROUND_PG_URL;
const path = '/api/v1/device/channels/register';

for (const backend of ['Commands SQLite', 'Operations PostgreSQL', 'Commands PostgreSQL']) {
  const kernel = backend.startsWith('Operations');
  const pg = backend.endsWith('PostgreSQL');
  test(`signed Worker channel registration through ${backend}`, { skip: pg && !(kernel ? kernelPg : commandPg && backgroundPg) }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'worker-channels-'));
    const config = configuration({ SETUP_TOKEN: 'worker-channels-fixture-token' });
    const { operations } = await discoverOperations();
    const operationStore = kernel ? await postgresStore(kernelPg!) : undefined;
    let app: FastifyInstance | undefined;
    t.after(async () => {
      try { await app?.close(); } finally { await rm(dir, { recursive: true, force: true }); }
    });
    if (operationStore) {
      app = createServer({ config, store: operationStore, operations });
    } else {
      const store = pg ? new PostgresStore(commandPg!) : localStore(join(dir, 'channels.sqlite'));
      const background = pg ? new PostgresStore(backgroundPg!) : store;
      const providers = createCommerceProviders(config);
      const publishing = createPublishHost(providers.account);
      const bound = operations.map(op => publishing.bindOperation(providers.bindOperation(op)));
      app = buildApp({ ...config, registry: new Map(), store, operationApi: { config, operations: bound, register: registerOperationRoutes } }).app;
      if (background !== store) app.addHook('onClose', () => background.close());
      if (background instanceof PostgresStore) await background.ready('background');
      publishing.mount(app, commandBackgroundStore(background));
    }
    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { 'x-setup-token': config.setupToken! }, payload: {
      username: 'channels-owner', name: 'Channel Owner', password: 'synthetic-fixture-user-password',
      ...(kernel ? { workspace_name: 'Worker channel fixture' } : { workspaceName: 'Worker channel fixture' }),
    } });
    assert.equal(setup.statusCode, 201, setup.body);
    const { user, workspaces: [{ id: workspaceId }] }: { user: { id: string }; workspaces: { id: string }[] } = setup.json().data;
    const cookie = String(setup.headers['set-cookie']).split(';')[0];
    const csrf = await app.inject({ url: '/api/v1/session/csrf', headers: { cookie } });
    const owner = { cookie, 'x-csrf-token': csrf.json().csrf_token, origin: config.origin };
    const otherWorkspace = randomUUID();
    if (operationStore) await operationStore.transaction({ identityWrite: true }, ({ identity }) => {
      const original = identity.get<{ tenantId: string }>(`workspace/${workspaceId}`)!;
      identity.put(`workspace/${otherWorkspace}`, { id: otherWorkspace, tenantId: original.tenantId, name: 'Separate workspace' });
      identity.put(`member/${user.id}/${otherWorkspace}`, { userId: user.id, workspaceId: otherWorkspace, role: 'owner' });
    });
    async function req(method: HTTPMethods, route: string, payload?: Record<string, unknown>, status = 200, workspace = workspaceId) {
      const response = await app!.inject({ method, url: `/api/v1/workspaces/${workspace}${route}`, headers: owner, payload });
      assert.equal(response.statusCode, status, `${method} ${route}: ${response.body}`);
      return response.json().data;
    }
    async function pair(name: string, allow?: boolean) {
      const { pairing_code } = await req('POST', '/devices/pairing-codes', {
        owned_device_confirmed: true, ...(allow !== undefined && { allow_channel_registration: allow }),
      });
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const public_key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
      const proof = sign(null, Buffer.from(JSON.stringify(['smartsell.pair.v1', workspaceId, pairing_code, public_key, 'darwin', name])), privateKey).toString('base64url');
      const response = await app!.inject({ method: 'POST', url: '/api/v1/device/pair', headers: { 'x-smartsell-workspace': workspaceId },
        payload: { pairing_code, public_key, platform: 'darwin', name, proof } });
      assert.equal(response.statusCode, 200, response.body);
      return { id: response.json().data.device_id as string, privateKey };
    }
    const first = await pair('Fixed One', true);
    const second = await pair('Fixed Two', true);
    const legacy = await pair('Existing CLI');
    function signed(device: typeof first, body: Record<string, unknown>, { workspace = workspaceId, signedWorkspace = workspace, action = 'channels.register',
      timestamp = new Date().toISOString(), url = path }: { workspace?: string; signedWorkspace?: string; action?: string; timestamp?: string; url?: string } = {}) {
      const payload = Buffer.from(JSON.stringify(body));
      const nonce = randomBytes(18).toString('base64url');
      const signature = sign(null, deviceRequestBytes(signedWorkspace, device.id, action, timestamp, nonce, payload), device.privateKey).toString('base64url');
      return { method: 'POST' as const, url, payload, headers: {
        'content-type': 'application/json', 'x-smartsell-workspace': workspace, 'x-smartsell-device': device.id,
        'x-smartsell-timestamp': timestamp, 'x-smartsell-nonce': nonce, 'x-smartsell-signature': signature,
      } };
    }
    async function send(request: ReturnType<typeof signed>, status = 200, code?: string) {
      const response = await app!.inject(request);
      assert.equal(response.statusCode, status, response.body);
      if (code) assert.equal(response.json().error.code, code);
      return response.json().data;
    }
    const now = new Date().toISOString();
    const tiktok = { kind: 'social', platform: 'tiktok', external_id: '1010101010', display_name: 'Fixture TikTok', observed_at: now };
    const amazon = { kind: 'store', platform: 'amazon_sp', external_id: 'A001TESTSELLER', observed_at: now, portal_url: 'https://sellercentral.amazon.com.mx/settings/account' };
    const input = (...selections: Record<string, unknown>[]) => ({ confirmed: true, selections });
    assert.deepEqual(await req('GET', '/brands'), []);
    assert.deepEqual(await req('GET', '/stores'), []);
    assert.deepEqual(await send(signed(legacy, { client_version: '1.0.0' }, { action: 'heartbeat', url: '/api/v1/device/heartbeat' })), { status: 'online' });
    await send(signed(legacy, input(tiktok)), 403, 'WORKER_CHANNEL_REGISTRATION_NOT_AUTHORIZED');
    await send(signed(first, { ...input(tiktok), confirmed: false }), 422);
    await send(signed(first, input({ ...tiktok, cookies: ['synthetic'] })), 422, 'INVALID_WORKER_CHANNEL_INPUT');
    await send(signed(first, input({ ...tiktok, portal_url: 'https://www.tiktok.com/?token=synthetic' })), 422, 'WORKER_CHANNEL_PORTAL_INVALID');
    await send(signed(first, input({ ...amazon, external_id: 'https://sellercentral.amazon.com.mx/' })), 422);
    await send(signed(first, input({ ...tiktok, kind: 'store' })), 422);
    await send(signed(first, input({ ...tiktok, observed_at: '2000-01-01T00:00:00Z' })), 422, 'WORKER_CHANNEL_OBSERVATION_EXPIRED');
    await send(signed(first, input({ ...tiktok, observed_at: '2026-02-30T00:00:00Z' })), 422);
    await send(signed(first, input(tiktok), { timestamp: '2000-01-01T00:00:00.000Z' }), 401, 'DEVICE_PROOF_EXPIRED');
    await send(signed(first, input(tiktok), { action: 'heartbeat' }), 401, 'INVALID_DEVICE_PROOF');
    await send(signed(first, input(tiktok), { signedWorkspace: otherWorkspace }), 401, 'INVALID_DEVICE_PROOF');
    await send(signed(first, input(tiktok), { workspace: otherWorkspace, signedWorkspace: workspaceId }), operationStore ? 404 : 401);
    const tampered = signed(first, input(tiktok));
    tampered.payload = Buffer.from(JSON.stringify(input(amazon)));
    await send(tampered, 401, 'INVALID_DEVICE_PROOF');
    assert.deepEqual(await req('GET', '/brands'), []);

    const request = signed(first, input(tiktok, amazon, tiktok));
    const [initial, retry] = await Promise.all([send(request), send(signed(first, input(tiktok, amazon)))]);
    assert.deepEqual(retry, initial);
    await send(request, 401, 'DEVICE_PROOF_REPLAYED');
    const [social, store] = initial.registrations;
    for (const [entry, selection] of [[social, tiktok], [store, amazon]]) {
      assert.match(entry.resource_id, /^[0-9a-f-]{36}$/);
      // Hub channels (phase1-design §8.16) also return the hub's Chrome profile key for the Worker to adopt.
      assert.deepEqual(entry, { kind: selection.kind, platform: selection.platform, external_id: selection.external_id,
        resource_id: entry.resource_id, device_id: first.id, ...(selection.kind === 'social' && { profile_key: entry.profile_key }) });
    }
    assert.match(social.profile_key, /^ch-[0-9a-f]{12}$/);
    // phase1-design §3.9: with no brand yet, Worker channels go into a brand named after the workspace.
    const [brand] = await req('GET', '/brands');
    assert.equal(brand.name, 'Worker channel fixture');
    const [account] = await req('GET', '/social-accounts');
    assert.equal(account.id, social.resource_id);
    assert.equal(account.brand_id, brand.id);
    assert.equal(account.owner_id, user.id);
    const [session] = await req('GET', '/browser-sessions');
    assert.equal(session.social_account_id, account.id);
    assert.equal(session.device_id, first.id);
    assert.equal(session.status, 'verified');
    const [commerce] = await req('GET', '/stores');
    assert.equal(commerce.id, store.resource_id);
    assert.equal(commerce.brand_id, brand.id);
    assert.equal(commerce.status, 'import_only');
    assert.deepEqual(await req('GET', '/worker-catalog'), { jobs: [], bindings: [{ store_id: commerce.id, device_id: first.id,
      device_name: 'Fixed One', external_store_id: amazon.external_id, portal_url: 'https://sellercentral.amazon.com.mx/' }] });
    assert.deepEqual(await send(signed(first, { client_version: '1.0.0', include_bindings: true }, { action: 'heartbeat', url: '/api/v1/device/heartbeat' })),
      { status: 'online', bindings: { social: { tiktok: 1 }, commerce: { amazon_sp: 1 } } });

    const shop = { ...amazon, platform: 'tiktok_shop', external_id: tiktok.external_id, portal_url: undefined };
    await send(signed(second, input(shop, amazon)), 409, 'WORKER_CHANNEL_ALREADY_BOUND');
    assert.equal((await req('GET', '/stores')).length, 1);
    await send(signed(second, input(tiktok)), 409, 'WORKER_CHANNEL_ALREADY_BOUND');
    await send(signed(second, input({ ...shop, portal_url: 'https://login.example.test/' })), 422, 'WORKER_CATALOG_PORTAL_INVALID');
    assert.equal((await req('GET', '/stores')).length, 1);
    const shopRegistration = (await send(signed(second, input(shop)))).registrations[0];
    assert.notEqual(shopRegistration.resource_id, account.id);
    assert.equal(shopRegistration.platform, 'tiktok_shop');
    assert.equal((await req('GET', '/brands')).length, 1);

    const existingBrand = await req('POST', '/brands', { name: 'Unrelated brand', slug: 'unrelated-brand' });
    const unrelated = { ...tiktok, external_id: '1010101020' };
    const existingAccount = await req('POST', '/social-accounts', { provider: unrelated.platform, external_account_id: unrelated.external_id,
      display_name: 'Existing account', brand_id: existingBrand.id, owned_account_confirmed: true });
    await send(signed(first, input(unrelated)), 403, 'WORKER_CHANNEL_BRAND_SCOPE');
    await req('PUT', `/social-accounts/${existingAccount.id}/execution-binding`, { mode: 'connector', connector_channel: 'browser',
      device_id: first.id, owned_account_confirmed: true });
    assert.equal((await send(signed(first, input(unrelated)))).registrations[0].resource_id, existingAccount.id);
    const shopify = { ...amazon, platform: 'shopify', external_id: 'fixture-shop', portal_url: undefined };
    const competing = await Promise.all([first, second].map(device => app!.inject(signed(device, input(shopify)))));
    assert.deepEqual(competing.map(response => response.statusCode).sort(), [200, 409]);
    const winner = competing[0].statusCode === 200 ? first : second;
    const won = competing.find(response => response.statusCode === 200)!.json().data.registrations[0];
    assert.equal(won.device_id, winner.id);
    const uppercase = (await send(signed(winner, input({ ...shopify, external_id: 'FIXTURE-SHOP' })))).registrations[0];
    assert.equal(uppercase.resource_id, won.resource_id);
    assert.equal(uppercase.external_id, 'FIXTURE-SHOP');
    assert.equal((await req('GET', '/stores')).filter((row: { provider: string }) => row.provider === 'shopify').length, 1);
    const catalog = await req('GET', '/worker-catalog');
    assert.equal(catalog.bindings.find((row: { store_id: string }) => row.store_id === won.resource_id).portal_url, 'https://admin.shopify.com/store/fixture-shop');
    await req('POST', `/devices/${second.id}/disable`, {});
    await send(signed(second, input(shop)), 401, 'DEVICE_INACTIVE');
    await req('PUT', `/devices/${second.id}/channel-registration`, { enabled: true }, 409);

    const legacyStore = await req('POST', '/stores', { provider: 'amazon_sp', name: 'Existing shop', brand_id: existingBrand.id,
      external_store_id: 'A002TESTSELLER', default_currency: 'USD', default_locale: 'en-US' });
    await req('PUT', `/stores/${legacyStore.id}/worker`, { device_id: legacy.id, external_store_id: legacyStore.external_store_id });
    const beforeGrant = await req('GET', '/worker-catalog');
    const grantPath = `/devices/${legacy.id}/channel-registration`;
    const csrfFailure = await app.inject({ method: 'PUT', url: `/api/v1/workspaces/${workspaceId}${grantPath}`,
      headers: { cookie, origin: config.origin }, payload: { enabled: true } });
    assert.equal(csrfFailure.statusCode, 403);
    await req('PUT', grantPath, { enabled: true, owner_id: randomUUID() }, 422);
    assert.deepEqual(await req('PUT', grantPath, { enabled: true }), { device_id: legacy.id, allow_channel_registration: true, authorized_by: user.id });
    assert.deepEqual(await req('GET', '/worker-catalog'), beforeGrant);
    const legacySelection = { ...amazon, external_id: legacyStore.external_store_id };
    assert.equal((await send(signed(legacy, input(legacySelection)))).registrations[0].resource_id, legacyStore.id);
    await req('PUT', grantPath, { enabled: false });
    await send(signed(legacy, input(legacySelection)), 403, 'WORKER_CHANNEL_REGISTRATION_NOT_AUTHORIZED');
    assert.deepEqual(await req('GET', '/worker-catalog'), beforeGrant);
    await req('PUT', grantPath, { enabled: true });
    if (operationStore) {
      assert.deepEqual(await req('GET', '/social-accounts', undefined, 200, otherWorkspace), []);
      assert.deepEqual(await req('GET', '/stores', undefined, 200, otherWorkspace), []);
      assert.deepEqual(await req('GET', '/worker-catalog', undefined, 200, otherWorkspace), { bindings: [], jobs: [] });
      await operationStore.transaction({ identityWrite: true }, ({ identity }) => {
        identity.put(`member/${user.id}/${workspaceId}`, { userId: user.id, workspaceId, role: 'viewer', scopes: [`brand:${brand.id}`] });
      });
      await send(signed(first, input(tiktok)), 403, 'WORKER_CHANNEL_REGISTRATION_NOT_AUTHORIZED');
      await req('PUT', grantPath, { enabled: true }, 403);
    }
  });
}
