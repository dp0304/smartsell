// The signed device routes over HTTP (§5.4, §6.6, §8.13, §2.10): the real account ingress, the Commands SQLite store and the
// media host, with a storage wrapper that streams slowly so the test can see that no transaction is held while it streams.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { after, before, describe, test } from 'node:test';
import { AUTOMATION_NOTICE_VERSION, RISK_TERMS_VERSION, type Context, type Data, type Row } from '@smartsell/contracts';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { deviceSignatureHeaders } from '../../../../connector/src/device-client.ts';
import { buildApp } from '../../app.js';
import { configuration } from '../../config.js';
import { makeContext } from '../../context.js';
import { mediaStorageFromConfig, prepareAssembledObject, recordAssembledObject } from '../../extensions/media-files.js';
import { commandBackgroundStore } from '../../integration/command-background.js';
import { createCommerceProviders } from '../../integration/commerce-providers.js';
import { createPublishHost } from '../../integration/publish-host.js';
import { workspaceServices } from '../../integration/workspace-services.js';
import { localStore } from '../../local.js';
import { registerOperationRoutes } from '../../operation-server.js';
import { discoverOperations } from '../../operations.js';
import type { Workspace } from '../../identity.js';
import type { Storage } from '../../../../../packages/media-store/src/storage.js';
import { ensureChannelSettings } from '../account/channel-settings.js';
import { createDryRunJob } from './dispatch.js';
import { DRIVER_CONFIG_FILE, refreshHostCaches } from './host-cache.js';
import { JOB, configureWorkerHost } from './model.js';
import { MemoryNonceStore, configureDeviceNonces } from './nonces.js';
import { setJob } from './model.js';

describe('signed device routes over HTTP', { concurrency: false }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'smartsell-device-http-'));
  const config = configuration({ SETUP_TOKEN: 'device-http-fixture-token', SMARTSELL_DATA_FILE: join(dir, 'state.sqlite') });
  let app: FastifyInstance;
  let ws: Workspace;
  let background: ReturnType<typeof commandBackgroundStore>;
  let slowMs = 0;
  let streaming = false;
  const devices: { id: string; key: KeyObject }[] = [];
  const enrich = workspaceServices([]);
  const write = <T>(run: (ctx: Context) => T | Promise<T>) => background.transact(ws, false, (records, scope, identity) => run(enrich(makeContext(records, scope, 'owner'), identity)));
  const read = <T>(run: (ctx: Context) => T) => background.transact(ws, true, (records, scope, identity) => run(enrich(makeContext(records, scope, 'owner'), identity)));
  const clip = Buffer.alloc(200_000);
  Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]).copy(clip);
  for (let index = 16; index < clip.length; index++) clip[index] = (index * 7) & 0xff;
  const clipSha = createHash('sha256').update(clip).digest('hex');
  let fileId = '';
  let accountId = '';

  function signed(device: { id: string; key: KeyObject }, method: 'GET' | 'POST' | 'PUT', url: string, action: string, body?: Buffer | Data,
    extra: Record<string, string> = {}, timestamp = Date.now()): InjectOptions {
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
    const headers = { ...deviceSignatureHeaders(device.key, ws.id, device.id, action, payload, timestamp),
      ...(body !== undefined && !Buffer.isBuffer(body) && { 'content-type': 'application/json' }), ...extra };
    return { method, url, headers, ...(method === 'GET' ? {} : { payload }) };
  }
  const heartbeat = (device = devices[0], body: Data = {}) => app.inject(signed(device, 'POST', '/api/v1/device/heartbeat', 'heartbeat',
    { client_version: '0.2.0', protocol: 2, drivers: [], jobs: [], outbox_depth: 0, worker_time: new Date().toISOString(), applied_sync_generation: 0, ...body }));

  before(async () => {
    configureDeviceNonces(new MemoryNonceStore());
    const store = localStore(config.statePath);
    const { operations } = await discoverOperations();
    const providers = createCommerceProviders(config);
    const real = mediaStorageFromConfig(config);
    // Streams in slices so a transaction held while streaming would visibly block a concurrent heartbeat.
    const slow: Storage = { ...real, bucket: real.bucket, write: real.write.bind(real), remove: real.remove.bind(real), async read(key, range) {
      const object = await real.read(key, range);
      if (!slowMs) return object;
      const chunks: Buffer[] = [];
      for await (const chunk of object.stream) chunks.push(chunk as Buffer);
      const all = Buffer.concat(chunks);
      const slices = [all.subarray(0, all.length >> 1), all.subarray(all.length >> 1)];
      return { size: object.size, stream: Readable.from((async function* () {
        streaming = true;
        for (const slice of slices) { await new Promise(done => setTimeout(done, slowMs / 2)); yield slice; }
        streaming = false;
      })()) };
    } };
    const publishing = createPublishHost(providers.account, undefined, undefined, { storage: slow, driverConfigDirectory: join(dir, 'driver-config') });
    configureWorkerHost({ storage: slow, driverConfigDirectory: join(dir, 'driver-config') });
    app = buildApp({ ...config, registry: new Map(), store, operationApi: { config, operations: operations.map(op => publishing.bindOperation(providers.bindOperation(op))), register: registerOperationRoutes } }).app;
    background = commandBackgroundStore(store);
    publishing.mount(app, background);
    const setup = await app.inject({ method: 'POST', url: '/api/v1/setup', headers: { 'x-setup-token': config.setupToken! }, payload: {
      username: 'device-http-owner', name: 'Owner', password: 'synthetic-fixture-user-password', workspaceName: 'Device HTTP' } });
    assert.equal(setup.statusCode, 201, setup.body);
    const workspaceId = setup.json().data.workspaces[0].id as string;
    ws = (await background.workspaces()).find(item => item.id === workspaceId)!;
    const cookie = String(setup.headers['set-cookie']).split(';')[0];
    const csrf = (await app.inject({ url: '/api/v1/session/csrf', headers: { cookie } })).json().csrf_token as string;
    for (const name of ['Mac-B', 'Win-C']) {
      const code = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${ws.id}/devices/pairing-codes`, headers: { cookie, 'x-csrf-token': csrf, origin: config.origin },
        payload: { owned_device_confirmed: true } });
      const pairing = code.json().data.pairing_code as string;
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const public_key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
      const proof = sign(null, Buffer.from(JSON.stringify(['smartsell.pair.v1', ws.id, pairing, public_key, 'darwin', name])), privateKey).toString('base64url');
      const paired = await app.inject({ method: 'POST', url: '/api/v1/device/pair', headers: { 'x-smartsell-workspace': ws.id }, payload: { pairing_code: pairing, public_key, platform: 'darwin', name, proof } });
      assert.equal(paired.statusCode, 200, paired.body);
      devices.push({ id: paired.json().data.device_id, key: privateKey });
    }
    // A channel bound to Mac-B with an uploaded clip, through S5's assembled-upload tail.
    const path = join(dir, 'clip.mp4');
    writeFileSync(path, clip);
    const ids = await write(ctx => {
      const account = ctx.create('social_account', { provider: 'x', status: 'active', brand_id: null, handle: 'lurelab', external_account_id: 'lurelab', display_name: 'Lure Lab' });
      const binding = ctx.create('account_execution_binding', { social_account_id: account.id, mode: 'connector', connector_channel: 'browser', device_id: devices[0].id, connector_mode: 'assist', paused: false });
      ctx.create('browser_session', { binding_id: binding.id, device_id: devices[0].id, social_account_id: account.id, status: 'verified' });
      const settings = ensureChannelSettings(ctx, account.id);
      ctx.update('channel_settings', settings.id, { automation_notice_ack: { at: ctx.now, via: 'web', by: 'owner', version: AUTOMATION_NOTICE_VERSION },
        risk_ack: { at: ctx.now, by_user_id: 'owner', terms_version: RISK_TERMS_VERSION, text_sha256: 'f'.repeat(64) } });
      const asset = ctx.create('asset', { kind: 'video', title: 'clip.mp4', brand_id: null, ownership: 'owned', origin: 'agent_upload', status: 'uploading', current_version_id: null });
      const version = ctx.create('asset_version', { asset_id: asset.id, version_no: 1, sha256: clipSha, mime_type: 'video/mp4', file_object_id: null, meta: null });
      ctx.update('asset', asset.id, { current_version_id: version.id });
      return { account: account.id, asset: asset.id, version: version.id };
    });
    accountId = ids.account;
    const prepared = await prepareAssembledObject(mediaStorageFromConfig(config), { path, sha256: clipSha, size: clip.length, mime: 'video/mp4', filename: 'clip.mp4', workspaceId: ws.id, tenantId: ws.tenantId });
    fileId = (await write(ctx => recordAssembledObject(ctx, prepared, { asset_id: ids.asset, asset_version_id: ids.version, createdBy: 'fixture' }))).file_object_id;
  });

  after(async () => { await app?.close(); rmSync(dir, { recursive: true, force: true }); });

  test('heartbeat v2 answers protocol 2; v1 keeps the old answer; idle heartbeats and claims write nothing (§2.10, §5.4.1)', async () => {
    const v1 = await app.inject(signed(devices[1], 'POST', '/api/v1/device/heartbeat', 'heartbeat', { client_version: '0.1.0' }));
    assert.deepEqual(v1.json().data, { status: 'online' });
    const first = await heartbeat();
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().data.protocol, 2);
    const version = () => read(ctx => [ctx.get('connector_device', devices[0].id).version, ctx.list('device_nonce').length, ctx.list(JOB).length]);
    const before = await version();
    for (let index = 0; index < 3; index++) {
      assert.equal((await heartbeat()).statusCode, 200);
      assert.equal((await app.inject(signed(devices[0], 'POST', '/api/v1/device/jobs/claim', 'jobs.claim', { kinds: ['publish_post'], horizon_minutes: 60, max: 5, held_job_ids: [] }))).statusCode, 200);
    }
    assert.deepEqual(await version(), before, 'no row written by idle heartbeats and claims');
    const online = await read(ctx => (ctx as Context & { presence?: (id: string) => Data | undefined }).presence?.(devices[0].id));
    assert.equal(online?.protocol, 2);
  });

  test('nonces in memory: replay refused, a full store answers 503 DEVICE_BUSY with Retry-After instead of evicting, pre-restart signatures refused', async () => {
    const request = signed(devices[0], 'POST', '/api/v1/device/heartbeat', 'heartbeat', { client_version: '0.2.0', protocol: 2, drivers: [], jobs: [], outbox_depth: 0, worker_time: new Date().toISOString(), applied_sync_generation: 0 });
    assert.equal((await app.inject(request)).statusCode, 200);
    const replay = await app.inject(request);
    assert.equal(replay.statusCode, 401);
    assert.equal(replay.json().error.code, 'DEVICE_PROOF_REPLAYED');
    const tiny = new MemoryNonceStore(2);
    configureDeviceNonces(tiny);
    assert.equal((await heartbeat()).statusCode, 200);
    assert.equal((await heartbeat()).statusCode, 200);
    const busy = await heartbeat();
    assert.equal(busy.statusCode, 503);
    assert.equal(busy.json().error.code, 'DEVICE_BUSY');
    assert.equal(busy.headers['retry-after'], '1');
    assert.equal(tiny.size, 2, 'unexpired nonces are kept');
    configureDeviceNonces(new MemoryNonceStore(50_000, Date.now()));
    const old = await app.inject(signed(devices[0], 'POST', '/api/v1/device/heartbeat', 'heartbeat', { client_version: '0.2.0', protocol: 2, drivers: [], jobs: [],
      outbox_depth: 0, worker_time: new Date().toISOString(), applied_sync_generation: 0 }, {}, Date.now() - 5_000));
    assert.equal(old.statusCode, 401);
    assert.equal(old.json().error.code, 'DEVICE_PROOF_EXPIRED');
  });

  test('media.read: only the assigned machine with the current fence of a live job that lists the file; Range; streamed outside the transaction (§6.6)', async () => {
    const job = await write(ctx => createDryRunJob(ctx, accountId, { media_id: (ctx.list('asset')[0]).id }));
    const claimed = await app.inject(signed(devices[0], 'POST', '/api/v1/device/jobs/claim', 'jobs.claim', { kinds: ['publish_post'], horizon_minutes: 60, max: 5, held_job_ids: [] }));
    assert.equal(claimed.json().data.jobs[0].job_id, job.id);
    const fence = claimed.json().data.jobs[0].fencing_token as number;
    const get = (device: { id: string; key: KeyObject }, f: number, extra: Record<string, string> = {}, file = fileId) =>
      app.inject(signed(device, 'GET', `/api/v1/device/media/${file}`, `media.read:${file}:${job.id}:${f}`, undefined, { 'x-smartsell-job': job.id, 'x-smartsell-fence': String(f), ...extra }));
    const full = await get(devices[0], fence);
    assert.equal(full.statusCode, 200, full.body);
    assert.equal(createHash('sha256').update(full.rawPayload).digest('hex'), clipSha);
    assert.equal(full.headers.etag, `"${clipSha}"`);
    assert.equal(full.headers['cache-control'], 'no-store');
    const partial = await get(devices[0], fence, { range: 'bytes=100000-', 'if-range': `"${clipSha}"` });
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.headers['content-range'], `bytes 100000-199999/200000`);
    assert.deepEqual(partial.rawPayload, clip.subarray(100_000));
    assert.equal((await get(devices[0], fence, { range: 'bytes=100000-', 'if-range': '"stale"' })).statusCode, 200, 'a changed ETag restarts the download');
    assert.equal((await get(devices[1], fence)).json().error.code, 'MEDIA_FORBIDDEN');
    const lost = await get(devices[0], fence + 1);
    assert.equal(lost.statusCode, 409, 'a stale fence is JOB_FENCE_LOST, not 403 (S6 ledger 2)');
    assert.equal(lost.json().error.code, 'JOB_FENCE_LOST');
    assert.equal((await get(devices[0], fence, {}, randomUUID())).json().error.code, 'MEDIA_FORBIDDEN');
    // While the file streams, a heartbeat from the other machine is answered at once: no transaction is held.
    slowMs = 1500;
    const download = get(devices[0], fence);
    await new Promise(done => setTimeout(done, 300));
    assert.equal(streaming, true, 'the stream is in progress');
    const started = Date.now();
    assert.equal((await heartbeat(devices[1])).statusCode, 200);
    assert.ok(Date.now() - started < 1000, `heartbeat answered in ${Date.now() - started} ms during the download`);
    assert.equal(createHash('sha256').update((await download).rawPayload).digest('hex'), clipSha);
    slowMs = 0;
    await write(ctx => setJob(ctx, ctx.get(JOB, job.id), { status: 'cancelled', finished_at: ctx.now }));
    assert.equal((await get(devices[0], fence)).json().error.code, 'MEDIA_FORBIDDEN', 'an ended job has no media access');
  });

  test('evidence: any machine in device_history (fence may differ), JPEG/PNG only, deduplicated, linked to the result (§8.13); SEQ_GAP carries expected', async () => {
    const job = await write(ctx => createDryRunJob(ctx, accountId, {}));
    const claim = await app.inject(signed(devices[0], 'POST', '/api/v1/device/jobs/claim', 'jobs.claim', { kinds: ['publish_post'], horizon_minutes: 60, max: 5, held_job_ids: [] }));
    const fence = claim.json().data.jobs.find((item: Data) => item.job_id === job.id).fencing_token as number;
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4000, 7)]);
    const sha = createHash('sha256').update(jpeg).digest('hex');
    const put = (device: { id: string; key: KeyObject }, bytes: Buffer, f: number, type = 'image/jpeg') =>
      app.inject(signed(device, 'PUT', `/api/v1/device/evidence/${job.id}`, `evidence.upload:${job.id}:${f}`, bytes, { 'content-type': type, 'x-smartsell-fence': String(f) }));
    const stored = await put(devices[0], jpeg, fence + 5);
    assert.equal(stored.statusCode, 200, stored.body);
    assert.equal(stored.json().data.sha256, sha);
    assert.equal((await put(devices[0], jpeg, fence)).json().data.duplicate, true);
    assert.equal((await put(devices[1], jpeg, fence)).json().error.code, 'JOB_FENCE_LOST');
    assert.equal((await put(devices[0], Buffer.from('gif'), fence, 'image/gif')).statusCode, 415);
    const files = await read(ctx => ctx.list('file_object').filter(row => row.purpose === 'evidence' && row.worker_job_id === job.id));
    assert.equal(files.length, 1);
    const report = (seq: number, event: string, data: Data) => app.inject(signed(devices[0], 'POST', '/api/v1/device/jobs/report', 'jobs.report',
      { job_id: job.id, fencing_token: fence, seq, event_id: randomUUID(), event, worker_time: new Date().toISOString(), data: { event, ...data } }));
    const gap = await report(3, 'readback_pending', {});
    assert.equal(gap.statusCode, 409);
    assert.deepEqual([gap.json().error.code, gap.json().error.expected], ['SEQ_GAP', 1]);
    assert.equal((await app.inject(signed(devices[0], 'POST', '/api/v1/device/jobs/go', 'jobs.go', { job_id: job.id, fencing_token: fence }))).json().data.go, true);
    assert.equal((await report(1, 'started', { go: 'hub', mode: 'auto' })).statusCode, 200);
    assert.equal((await report(2, 'dry_run_done', { evidence_sha256: [sha], trace: [] })).statusCode, 200);
    const done = await read(ctx => ctx.get(JOB, job.id));
    assert.equal(done.status, 'succeeded');
    assert.deepEqual((done.result as Row).evidence_sha256, [sha]);
  });

  test('driver-config: an explicit 404 without a selector file; with one, the bytes whose sha256 the heartbeat advertises (§8.11)', async () => {
    const fetch = () => app.inject(signed(devices[0], 'GET', '/api/v1/device/driver-config', 'driver_config.read'));
    const missing = await fetch();
    assert.equal(missing.statusCode, 404);
    assert.equal(missing.json().error.code, 'DRIVER_CONFIG_NOT_FOUND');
    await mkdir(join(dir, 'driver-config'), { recursive: true });
    const bytes = Buffer.from(JSON.stringify({ version: '2026.11.3', x: {}, tiktok: {} }));
    writeFileSync(join(dir, 'driver-config', DRIVER_CONFIG_FILE), bytes);
    await refreshHostCaches(true);
    const served = await fetch();
    assert.equal(served.statusCode, 200);
    assert.deepEqual(served.rawPayload, bytes);
    assert.deepEqual((await heartbeat()).json().data.driver_config, { version: '2026.11.3', sha256: createHash('sha256').update(bytes).digest('hex') });
  });

  test('Worker updates download with a device signature instead of 503 DEVICE_AUTH_UNAVAILABLE (S1 ledger 1)', async () => {
    const response = await app.inject(signed(devices[0], 'GET', '/api/v1/worker-downloads/mac-arm64', 'worker_download.read:mac-arm64'));
    assert.notEqual(response.statusCode, 503, response.body);
    const forged = await app.inject(signed(devices[0], 'GET', '/api/v1/worker-downloads/mac-arm64', 'worker_download.read:win-x64'));
    assert.equal(forged.statusCode, 401);
  });
});
