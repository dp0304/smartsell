import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileStore, postgresStore } from '@smartsell/db';
import type { FastifyInstance, HTTPMethods } from 'fastify';
import { buildApp } from '../../app.js';
import { configuration } from '../../config.js';
import { makeContext } from '../../context.js';
import { commandBackgroundStore } from '../../integration/command-background.js';
import { createCommerceProviders } from '../../integration/commerce-providers.js';
import { createPublishHost } from '../../integration/publish-host.js';
import { localStore } from '../../local.js';
import { registerOperationRoutes } from '../../operation-server.js';
import { discoverOperations } from '../../operations.js';
import { PostgresStore } from '../../postgres.js';
import { kernelBackgroundStore, type BackgroundStore } from '../../runtime.js';
import { createServer } from '../../server.js';
import { deviceRequestBytes } from '../account/device-control.js';
import { textCell, workbookFixture } from '../ingest/xlsx-fixture.js';

type Json = Record<string, any>;
const commandPgUrl = process.env.SMARTSELL_WORKER_CATALOG_TEST_COMMAND_PG_URL;
const backgroundPgUrl = process.env.SMARTSELL_WORKER_CATALOG_TEST_BACKGROUND_PG_URL;
const kernelPgUrl = process.env.SMARTSELL_WORKER_CATALOG_TEST_KERNEL_PG_URL;

for (const variant of ['Commands SQLite', 'Operations file', 'Commands PostgreSQL', 'Operations PostgreSQL']) {
  const commands = variant.startsWith('Commands');
  const pg = variant.endsWith('PostgreSQL');
  test(`fixed Worker imports persist through ${variant} and populate Products`, {
    skip: pg && !(commands ? commandPgUrl && backgroundPgUrl : kernelPgUrl),
  }, async t => {
    const dir = await mkdtemp(join(tmpdir(), 'worker-catalog-'));
    const config = configuration({ SETUP_TOKEN: 'worker-catalog-test-setup' });
    const { operations } = await discoverOperations();
    assert.ok(operations.some(op => op.name === 'worker_catalog_request_import'));
    let backgroundStore: BackgroundStore;
    async function open() {
      if (!commands) {
        const store = pg ? await postgresStore(kernelPgUrl!) : await fileStore(join(dir, 'kernel.json'));
        backgroundStore = kernelBackgroundStore(store);
        return createServer({ config, store, operations });
      }
      const store = pg ? new PostgresStore(commandPgUrl!) : localStore(join(dir, 'commands.sqlite'));
      const background = pg ? new PostgresStore(backgroundPgUrl!) : store;
      if (background instanceof PostgresStore) await background.ready('background');
      const providers = createCommerceProviders(config);
      const publishing = createPublishHost(providers.account);
      const bound = operations.map(op => publishing.bindOperation(providers.bindOperation(op)));
      const { app } = buildApp({ ...config, registry: new Map(), store, operationApi: { config, operations: bound, register: registerOperationRoutes } });
      if (background !== store) app.addHook('onClose', () => background.close());
      backgroundStore = commandBackgroundStore(background);
      publishing.mount(app, backgroundStore);
      return app;
    }
    let app: FastifyInstance | undefined;
    t.after(async () => {
      await app?.close();
      await rm(dir, { recursive: true, force: true });
    });
    app = await open();
    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { 'x-setup-token': config.setupToken! }, payload: {
      username: 'catalog-owner', name: 'Owner', password: 'worker-catalog-fixture-1234',
      ...(commands ? { workspaceName: 'Catalog' } : { workspace_name: 'Catalog' }),
    } });
    assert.equal(setup.statusCode, 201, setup.body);
    const wid: string = setup.json().data.workspaces[0].id;
    const cookie = String(setup.headers['set-cookie']).split(';')[0];
    const csrf = await app.inject({ url: '/api/v1/session/csrf', headers: { cookie } });
    const owner = { cookie, 'x-csrf-token': csrf.json().csrf_token, origin: config.origin };
    const root = `/api/v1/workspaces/${wid}`;
    async function req(method: HTTPMethods, path: string, payload?: Json, status = 200, headers = owner) {
      const response = await app!.inject({ method, url: root + path, payload, headers });
      assert.equal(response.statusCode, status, `${method} ${path}: ${response.body}`);
      return status === 204 ? undefined : response.json();
    }
    const brand = (await req('POST', '/brands', { name: 'Test brand', slug: 'test-brand' })).data;
    async function store(provider: string, externalId?: string) {
      return (await req('POST', '/stores', { provider, brand_id: brand.id, external_store_id: externalId, name: externalId ?? 'Legacy shop',
        default_currency: 'USD', default_locale: 'en-US' })).data;
    }
    const shop = await store('shopify', 'north-shop.myshopify.com');
    const secondShop = await store('shopee', '9822034');
    async function pair(name: string) {
      const { pairing_code } = (await req('POST', '/devices/pairing-codes', { owned_device_confirmed: true })).data;
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const public_key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
      const proof = sign(null, Buffer.from(JSON.stringify(['smartsell.pair.v1', wid, pairing_code, public_key, 'darwin', name])), privateKey).toString('base64url');
      const response = await app!.inject({ method: 'POST', url: '/api/v1/device/pair', headers: { 'x-smartsell-workspace': wid },
        payload: { pairing_code, public_key, platform: 'darwin', name, proof } });
      assert.equal(response.statusCode, 200, response.body);
      return { id: response.json().data.device_id as string, privateKey };
    }
    const first = await pair('Export Mac');
    const other = await pair('Other Mac');
    function signed(device: typeof first, action: 'catalog.claim' | 'catalog.upload' | 'heartbeat', data: Json, workspace = wid) {
      const payload = Buffer.from(JSON.stringify(data));
      const at = new Date().toISOString();
      const nonce = randomBytes(18).toString('base64url');
      const proof = sign(null, deviceRequestBytes(workspace, device.id, action, at, nonce, payload), device.privateKey).toString('base64url');
      return { method: 'POST' as const, url: `/api/v1/device/${action.replace('.', '/')}`, payload, headers: {
        'content-type': 'application/json', 'x-smartsell-workspace': workspace, 'x-smartsell-device': device.id,
        'x-smartsell-timestamp': at, 'x-smartsell-nonce': nonce, 'x-smartsell-signature': proof,
      } };
    }
    async function deviceReq(request: ReturnType<typeof signed>, status = 200, code?: string) {
      const response = await app!.inject(request);
      assert.equal(response.statusCode, status, `${request.url}: ${response.body}`);
      if (code) assert.equal(response.json().error.code, code);
      return response.json().data;
    }
    const bindPath = `/stores/${shop.id}/worker`;
    const queuePath = `${bindPath}/imports`;
    const binding = { device_id: first.id, external_store_id: shop.external_store_id };
    await req('POST', queuePath, {}, 409);
    await req('PUT', bindPath, { ...binding, external_store_id: secondShop.external_store_id }, 409);
    for (const portal_url of ['http://admin.shopify.com/', 'https://127.0.0.1/', 'https://admin.shopify.com.evil.test/',
      'https://name:secret@admin.shopify.com/', 'https://@admin.shopify.com/', 'https://admin.shopify.com\\@example.test/']) {
      await req('PUT', bindPath, { ...binding, portal_url }, 422);
    }
    await req('PUT', bindPath, { ...binding, portal_url: 'https://admin.shopify.com/store/other-shop' }, 409);
    const portal = 'https://admin.shopify.com/store/north-shop';
    assert.equal((await req('PUT', bindPath, { ...binding, portal_url: `${portal}/products?access_token=fixture#auth` })).data.portal_url, portal);
    const heartbeat = { client_version: 'fixture', include_bindings: true };
    assert.deepEqual(await deviceReq(signed(other, 'heartbeat', heartbeat)), { status: 'online', bindings: { social: {}, commerce: {} } });
    await req('PUT', `/stores/${secondShop.id}/worker`, { device_id: other.id, external_store_id: secondShop.external_store_id });
    assert.deepEqual(await deviceReq(signed(first, 'heartbeat', heartbeat)), { status: 'online', bindings: { social: {}, commerce: { shopify: 1 } } });
    const grant = commands
      ? (await req('POST', '/agent-connections', { label: 'Catalog agent', client: 'codex' }, 201)).data
      : (await req('POST', '/tokens', { access: 'write', tools: ['worker_catalog_list', 'worker_catalog_request_import', 'worker_catalog_bind'] }, 201)).data;
    const agent = { authorization: `Bearer ${grant.token}` } as unknown as typeof owner;
    if (commands) {
      const rpc = await app.inject({ method: 'POST', url: '/mcp', headers: { ...agent, accept: 'application/json, text/event-stream' }, payload: {
        jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'smartsell_operation_call', arguments: {
          operation: 'worker_catalog_bind', params: { id: shop.id }, body: { ...binding, device_id: other.id },
        } },
      } });
      assert.equal(rpc.json().result.structuredContent.error.code, 'HUMAN_REQUIRED', rpc.body);
      const readOnly = (await req('POST', '/tokens', { access: 'read' }, 201)).data;
      await req('POST', queuePath, {}, 403, { authorization: `Bearer ${readOnly.token}` } as unknown as typeof owner);
    } else await req('PUT', bindPath, { ...binding, device_id: other.id }, 403, agent);

    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    t.mock.timers.tick(91_000);
    assert.equal((await req('GET', '/devices')).data.find((row: Json) => row.id === first.id).online, false);
    const job = (await req('POST', queuePath, {}, 202, agent)).data;
    assert.equal(job.status, 'queued');
    assert.equal((await req('POST', queuePath, {}, 202)).data.id, job.id);
    assert.equal((await req('GET', '/worker-catalog', undefined, 200, agent)).data.jobs[0].id, job.id);
    assert.equal((await deviceReq(signed(other, 'catalog.claim', {}))).job, null);
    await deviceReq(signed(first, 'catalog.claim', {}, randomUUID()), 401);
    const claimRequest = signed(first, 'catalog.claim', {});
    const [original, retry] = await Promise.all([deviceReq(claimRequest), deviceReq(signed(first, 'catalog.claim', {}))]);
    const { job: claim } = original;
    assert.deepEqual(retry.job, claim);
    assert.equal(claim.id, job.id);
    assert.equal(claim.portal_url, portal);
    assert.equal(claim.external_store_id, shop.external_store_id);
    await app.close();
    app = undefined;
    app = await open();
    assert.equal((await req('GET', '/worker-catalog')).data.jobs.find((row: Json) => row.id === job.id).status, 'claimed');
    await deviceReq(claimRequest, 401, 'DEVICE_PROOF_REPLAYED');
    t.mock.timers.tick(91_000);
    assert.equal((await req('GET', '/devices')).data.find((row: Json) => row.id === first.id).online, false);
    assert.equal((await deviceReq(signed(other, 'catalog.claim', {}))).job, null);
    assert.deepEqual((await deviceReq(signed(first, 'catalog.claim', {}))).job, claim);

    const csv = 'Handle,Title,Variant SKU,Variant Price,Variant Inventory Qty,Buyer Email,Body (HTML)\n'
      + `trail-mug,Trail Mug,MUG-008,18.50,17,buyer@example.invalid,${'x'.repeat(256 * 1024)}`;
    const upload = { job_id: job.id, claim_id: claim.claim_id, observed_store_id: shop.external_store_id, confirmed: true, csv };
    await deviceReq(signed(other, 'catalog.upload', upload), 403, 'WORKER_CATALOG_CLAIM_INVALID');
    const wrongShop = signed(first, 'catalog.upload', { ...upload, observed_store_id: secondShop.external_store_id });
    await deviceReq(wrongShop, 409, 'WORKER_CATALOG_STORE_MISMATCH');
    await deviceReq(wrongShop, 401, 'DEVICE_PROOF_REPLAYED');
    await deviceReq(signed(first, 'catalog.upload', { ...upload, confirmed: 'true' }), 422, 'WORKER_CATALOG_CONFIRMATION_REQUIRED');
    await deviceReq(signed(first, 'catalog.upload', { ...upload, csv: 'shipping address,description\nPrivate street,Report' }), 422, 'INVALID_HEADER');
    await deviceReq(signed(first, 'catalog.upload', { ...upload, xlsx_base64: 'invalid' }), 422, 'WORKER_CATALOG_FILE_REQUIRED');
    await deviceReq(signed(first, 'catalog.upload', { ...upload, csv: 'x'.repeat(384 * 1024 + 1) }), 413, 'WORKER_CATALOG_FILE_TOO_LARGE');
    await deviceReq(signed(first, 'heartbeat', { client_version: '1', padding: csv }), 413);
    const genuine = signed(first, 'catalog.upload', upload);
    await deviceReq({ ...genuine, payload: Buffer.from(JSON.stringify({ ...upload, csv: `${csv} ` })) }, 401, 'INVALID_DEVICE_PROOF');
    const uploaded = await deviceReq(genuine);
    await deviceReq(genuine, 401, 'DEVICE_PROOF_REPLAYED');
    assert.deepEqual(await deviceReq(signed(first, 'catalog.upload', upload)), uploaded);
    await deviceReq(signed(first, 'catalog.upload', { ...upload, csv: csv.replace('18.50', '19.50') }), 409, 'WORKER_CATALOG_ALREADY_UPLOADED');
    const previewPath = `/imports/${uploaded.import_id}`;
    const preview = (await req('GET', previewPath)).data;
    assert.equal(preview.stats.valid, 1);
    assert.equal(preview.status, 'awaiting_confirmation');
    assert.equal(preview.store_id, shop.id);
    const rows = await req('GET', `${previewPath}/rows`);
    assert.doesNotMatch(JSON.stringify(rows), /buyer@example|Body \(HTML\)/);
    assert.deepEqual([rows.data[0].normalized.price_minor, rows.data[0].normalized.available], [1850, 17]);
    assert.deepEqual((await req('GET', `/views/products?store_id=${shop.id}`)).data, []);
    assert.equal((await req('POST', `${previewPath}/confirm`, {})).data.status, 'merged');
    const products = (await req('GET', `/views/products?store_id=${shop.id}&q=MUG-008`)).data;
    assert.deepEqual(products.map((row: Json) => [row.title, row.store.id]), [['Trail Mug', shop.id]]);
    assert.equal((await req('GET', '/worker-catalog')).data.jobs.find((row: Json) => row.id === job.id).status, 'imported');

    const xlsx_base64 = await workbookFixture(`<row r="1">${textCell('A1', 'Item ID')}${textCell('B1', 'Item Product Name')}${textCell('C1', 'Variation SKU')}${textCell('D1', 'Current Stock')}</row>` +
      `<row r="2">${textCell('A2', '00042')}${textCell('B2', 'Market Tote')}${textCell('C2', 'TOTE-002')}<c r="D2"><v>7</v></c></row>`);
    const secondJob = (await req('POST', `/stores/${secondShop.id}/worker/imports`, {}, 202)).data;
    assert.equal((await deviceReq(signed(first, 'catalog.claim', {}))).job, null);
    const secondClaim = (await deviceReq(signed(other, 'catalog.claim', {}))).job;
    assert.equal(secondClaim.id, secondJob.id);
    const workbookUpload = await deviceReq(signed(other, 'catalog.upload', { job_id: secondJob.id, claim_id: secondClaim.claim_id,
      observed_store_id: secondShop.external_store_id, confirmed: true, xlsx_base64 }));
    const workbookPath = `/imports/${workbookUpload.import_id}`;
    const workbookRow = (await req('GET', `${workbookPath}/rows`)).data[0];
    assert.deepEqual([workbookRow.normalized.external_product_id, workbookRow.normalized.title, workbookRow.normalized.sku, workbookRow.normalized.available],
      ['00042', 'Market Tote', 'TOTE-002', 7]);
    await req('POST', `${workbookPath}/confirm`, {});
    assert.deepEqual((await req('GET', `/views/products?store_id=${secondShop.id}`)).data.map((row: Json) => row.title), ['Market Tote']);

    const invalidJob = (await req('POST', queuePath, {}, 202)).data;
    const invalidClaim = (await deviceReq(signed(first, 'catalog.claim', {}))).job;
    const invalidUpload = await deviceReq(signed(first, 'catalog.upload', { ...upload, job_id: invalidClaim.id,
      claim_id: invalidClaim.claim_id, csv: 'Handle,Title\n,Product missing its identity' }));
    assert.equal((await req('POST', `/imports/${invalidUpload.import_id}/confirm`, {})).data.status, 'partially_merged');
    const invalidStatus = (await req('GET', '/worker-catalog')).data.jobs.find((row: Json) => row.id === invalidJob.id);
    assert.deepEqual([invalidStatus.status, invalidStatus.error_code], ['failed', 'WORKER_CATALOG_NO_ROWS_MERGED']);

    const next = (await req('POST', queuePath, {}, 202)).data;
    assert.notEqual(next.id, job.id);
    const oldClaim = (await deviceReq(signed(first, 'catalog.claim', {}))).job;
    const oldUpload = { ...upload, job_id: next.id, claim_id: oldClaim.claim_id };
    t.mock.timers.tick(91_000);
    await deviceReq(signed(first, 'catalog.upload', oldUpload), 409, 'WORKER_CATALOG_DEVICE_OFFLINE');
    await deviceReq(signed(first, 'heartbeat', { client_version: '1' }));
    await req('PUT', bindPath, { ...binding, device_id: other.id });
    await deviceReq(signed(first, 'catalog.upload', oldUpload), 409, 'WORKER_CATALOG_BINDING_CHANGED');
    assert.equal((await deviceReq(signed(first, 'catalog.claim', {}))).job, null);
    await req('POST', queuePath, {}, 202);
    const lease = (await deviceReq(signed(other, 'catalog.claim', {}))).job;
    t.mock.timers.tick(15 * 60_000);
    await deviceReq(signed(other, 'heartbeat', { client_version: '1' }));
    await deviceReq(signed(other, 'catalog.upload', { ...upload, job_id: lease.id, claim_id: lease.claim_id }), 410, 'WORKER_CATALOG_EXPIRED');
    assert.equal((await deviceReq(signed(other, 'catalog.claim', {}))).job, null);
    const last = (await req('POST', queuePath, {}, 202)).data;
    const lastClaim = (await deviceReq(signed(other, 'catalog.claim', {}))).job;
    assert.equal(last.id, lastClaim.id);
    await req('POST', `/devices/${other.id}/revoke`, {});
    await deviceReq(signed(other, 'catalog.upload', { ...upload, job_id: last.id, claim_id: lastClaim.claim_id }), 401, 'DEVICE_INACTIVE');
    const final = (await req('GET', '/worker-catalog')).data;
    assert.equal(final.bindings.length, 0);
    const state = Object.fromEntries(final.jobs.map((row: Json) => [row.id, row.status]));
    assert.deepEqual([state[job.id], state[secondJob.id], state[next.id], state[lease.id], state[last.id]],
      ['imported', 'imported', 'cancelled', 'expired', 'cancelled']);
    const legacy = await store('shopify');
    const product = (await req('POST', '/products', { store_id: legacy.id, title: 'Existing catalog item' })).data;
    const legacyPath = `/stores/${legacy.id}`;
    const legacyBind = `${legacyPath}/worker`;
    const legacyBinding = { device_id: first.id, external_store_id: secondShop.external_store_id };
    const duplicate = await req('PUT', legacyBind, { ...legacyBinding, external_store_id: shop.external_store_id }, 409);
    assert.equal(duplicate.error.code, 'duplicate_store');
    await req('PUT', legacyBind, { ...legacyBinding, device_id: other.id }, 409);
    await req('PUT', legacyBind, { ...legacyBinding, portal_url: 'http://127.0.0.1/' }, 422);
    assert.equal((await req('GET', legacyPath)).data.external_store_id, null);
    assert.equal((await req('GET', '/worker-catalog')).data.bindings.length, 0);

    // Simulate an older store with an OAuth association and a missing external ID.
    const linked = await store('shopify');
    const workspace = (await backgroundStore!.workspaces()).find(row => row.id === wid)!;
    await backgroundStore!.transact(workspace, false, (records, scope) => {
      const ctx = makeContext(records, scope, 'owner');
      const connection = ctx.create('connection', { provider: 'shopify', purpose: 'store', brand_id: brand.id, status: 'active' });
      ctx.update('store', linked.id, { connection_id: connection.id });
    });
    await req('PUT', `/stores/${linked.id}/worker`, legacyBinding, 409);
    assert.equal((await req('GET', `/stores/${linked.id}`)).data.external_store_id, null);
    assert.equal((await req('GET', '/worker-catalog')).data.bindings.length, 0);

    const filled = (await req('PUT', legacyBind, legacyBinding)).data;
    assert.deepEqual([filled.store_id, filled.external_store_id], [legacy.id, secondShop.external_store_id]);
    assert.deepEqual((await req('PUT', legacyBind, legacyBinding)).data, filled);
    await req('PUT', legacyBind, { ...legacyBinding, external_store_id: 'different-id' }, 409);
    const saved = (await req('GET', legacyPath)).data;
    assert.deepEqual([saved.id, saved.external_store_id, saved.version, saved.status], [legacy.id, secondShop.external_store_id, legacy.version + 1, 'import_only']);
    const legacyProducts = (await req('GET', `/views/products?store_id=${legacy.id}`)).data;
    assert.deepEqual(legacyProducts.map((row: Json) => [row.id, row.store.id]), [[product.id, legacy.id]]);

    await req('DELETE', `/${commands ? 'agent-connections' : 'tokens'}/${grant.id}`, undefined, 204);
    await req('POST', queuePath, {}, 401, agent);
  });
}
