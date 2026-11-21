import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DesktopConnector } from '../../apps/connector-desktop/src/controller.ts';
import { deviceVault, type Pairing } from '../../apps/connector-desktop/src/vault.ts';
import { parseReceipt } from '../../apps/connector-desktop/src/policy.ts';
import { frozenRevisionHash } from '../../packages/connector-tasks/src/tasks.ts';
import { importDevicePublicKey } from '../../packages/connector-tasks/src/index.ts';

const origin = 'https://workspace.example.test';
const revision = { id: 'revision', title: 'Test', body: 'Offline fixture', tags: [], visibility: 'private', media: [{ id: 'media', sha256: 'a'.repeat(64) }] };
const pair = { workspace: 'workspace', code: 'a'.repeat(32), name: 'Owner desktop', ownsDevice: true };
const account = { observed: 'account-external', confirmed: true };
const receipt = { postId: '123', url: 'https://www.douyin.com/video/123', objectId: 'masked-evidence', sha256: 'b'.repeat(64) };

function fixture() {
  let now = Date.parse('2026-11-20T15:00:00Z');
  let saved: Pairing | undefined;
  let publicKey: ReturnType<typeof createPublicKey>;
  let claimed = false;
  const paths: string[] = [];
  const reports: unknown[] = [];
  const nonces = new Set<string>();
  const urls: string[] = [];
  const controls = { failHeartbeat: false, bindings: undefined as ReturnType<DesktopConnector['snapshot']>['bindings'],
    badScope: false, failReport: 0, ready: undefined as undefined | (() => Promise<void>), hash: 'a'.repeat(64) };
  const catalogFile = { name: 'catalog.csv', size: 35, csv: 'product_id,title\nitem,Fixture product' };
  const catalog = { wrongDevice: false, empty: false, file: async (_signal: AbortSignal) => catalogFile,
    uploads: [] as unknown[], upload: async (_signal: AbortSignal) => Response.json({ data: { import_id: 'import', status: 'previewed' } }) };
  const ok = (data: unknown) => Response.json({ data });
  const client = new DesktopConnector({
    origin, version: '0.1.0', platform: 'darwin', now: () => now,
    vault: { load: () => saved, save: value => { saved = value; }, clear: () => { saved = undefined; }, available: () => true },
    openExternal: async url => { urls.push(url); },
    pickMedia: async () => [{ name: 'fixture.mp4', hash: controls.hash }],
    pickCatalog: signal => catalog.file(signal),
    fetcher: async (input, options) => {
      const url = new URL(String(input));
      assert.equal(url.origin, origin);
      assert.equal(options?.redirect, 'error');
      assert.equal(options?.credentials, 'omit');
      const bytes = Buffer.from(options?.body as Uint8Array);
      const body = JSON.parse(bytes.toString());
      const headers = new Headers(options?.headers);
      const action = ({ '/api/v1/device/heartbeat': 'heartbeat', '/api/v1/device/claim': 'claim', '/api/v1/device/browser-identity': 'browser.identity',
        '/api/v1/device/catalog/claim': 'catalog.claim', '/api/v1/device/catalog/upload': 'catalog.upload',
        '/api/v1/attempts/attempt/ready': 'attempt.ready', '/api/v1/attempts/attempt/device-report': 'attempt.report' } as Record<string, string>)[url.pathname];
      paths.push(url.pathname);
      if (url.pathname === '/api/v1/device/pair') {
        publicKey = importDevicePublicKey(body.public_key);
        const payload = ['smartsell.pair.v1', pair.workspace, pair.code, body.public_key, 'darwin', pair.name];
        assert(verify(null, Buffer.from(JSON.stringify(payload)), publicKey, Buffer.from(body.proof, 'base64url')));
        return ok({ device_id: 'device' });
      }
      assert(action, `unexpected signed action ${url.pathname}`);
      const nonce = headers.get('x-smartsell-nonce')!;
      assert(nonce && !nonces.has(nonce));
      nonces.add(nonce);
      assert.equal(headers.get('x-smartsell-device'), 'device');
      assert.equal(headers.get('x-smartsell-workspace'), pair.workspace);
      const timestamp = headers.get('x-smartsell-timestamp');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const payload = ['smartsell.device.v1', pair.workspace, 'device', action, timestamp, nonce, digest];
      assert(verify(null, Buffer.from(JSON.stringify(payload)), publicKey, Buffer.from(headers.get('x-smartsell-signature')!, 'base64url')));
      if (action === 'heartbeat') {
        assert(body.include_bindings === undefined || body.include_bindings === true);
        return controls.failHeartbeat ? new Response(null, { status: 403 }) : ok({
          status: 'online', ...(body.include_bindings && { bindings: controls.bindings }),
        });
      }
      if (action === 'browser.identity') return ok({ status: 'verified' });
      if (action === 'catalog.claim') {
        assert.deepEqual(body, {});
        return ok({ job: catalog.empty ? null : { id: 'job', store_id: 'store', device_id: catalog.wrongDevice ? 'other-device' : 'device',
          store_name: 'Fixture store', provider: 'shopify', external_store_id: 'fixture.myshopify.com', portal_url: 'https://admin.shopify.com/store/fixture',
          claim_id: 'claim-token', expires_at: new Date(now + 60_000).toISOString() } });
      }
      if (action === 'catalog.upload') {
        catalog.uploads.push(body);
        assert(options?.signal);
        return catalog.upload(options.signal);
      }
      if (action === 'claim') {
        if (claimed) return ok({ claim: null });
        claimed = true;
        const hash = frozenRevisionHash(revision);
        return ok({ claim: { effective_mode: 'auto', fencing_token: 7, write_slot_token: 8, lease_expires_at: new Date(now + 120_000).toISOString(), task: {
          schema_version: 1, kind: 'douyin.video.publish', workspace_id: pair.workspace, attempt_id: 'attempt', connector_device_id: controls.badScope ? 'other-device' : 'device',
          account_id: 'account', binding_id: 'binding', platform_identity: account.observed, target: { channel: 'browser', profile_id: 'session', app: 'douyin' },
          payload: { frozen_hash: hash, approval: { id: 'approval', resource_hash: hash }, revision },
        } } });
      }
      if (action === 'attempt.ready') {
        assert.deepEqual(body, { attempt_id: 'attempt', fencing_token: 7, write_slot_token: 8, observed_platform_identity: account.observed });
        await controls.ready?.();
        return ok({ status: 'verified' });
      }
      reports.push(body);
      if (controls.failReport) return new Response(null, { status: controls.failReport });
      return ok({ status: ['accepted', 'outcome_unknown'].includes(body.kind) ? 'outcome_unknown' : 'completed' });
    },
  });
  async function start() { await client.pair(pair); await client.connect(); }
  async function prepare() { await start(); await client.claim(); await client.openCreator(); await client.selectMedia(); }
  return { client, start, prepare, controls, catalog, paths, reports, urls, get saved() { return saved; }, advance: (ms: number) => { now += ms; } };
}

const storeConfirmation = { observed: 'fixture.myshopify.com', confirmed: true };

test('claims only this device’s catalog job and signs a confirmed product upload', async () => {
  const f = fixture();
  await assert.rejects(f.client.claimCatalog(), /请先连接/);
  await f.start();
  f.catalog.empty = true;
  await f.client.claimCatalog();
  assert.match(f.client.snapshot().catalogNotice, /暂无/);
  f.catalog.empty = false;
  f.catalog.wrongDevice = true;
  await assert.rejects(f.client.claimCatalog(), /未分配给此设备/);
  f.catalog.wrongDevice = false;
  await f.client.claimCatalog();
  assert.equal(f.client.snapshot().catalog?.externalId, storeConfirmation.observed);
  await assert.rejects(f.client.claim(), /当前任务/);
  await f.client.openCatalogPortal();
  assert.deepEqual(f.urls, ['https://admin.shopify.com/store/fixture']);
  await assert.rejects(f.client.uploadCatalog(storeConfirmation), /请选择|请先选择/);
  await f.client.selectCatalogFile();
  await assert.rejects(f.client.uploadCatalog({ ...storeConfirmation, observed: 'other-shop' }), /实际店铺 ID/);
  await assert.rejects(f.client.uploadCatalog({ ...storeConfirmation, confirmed: false }), /实际店铺 ID/);
  assert.deepEqual(f.catalog.uploads, []);
  await f.client.uploadCatalog(storeConfirmation);
  assert.deepEqual(f.catalog.uploads, [{ job_id: 'job', claim_id: 'claim-token', observed_store_id: storeConfirmation.observed,
    confirmed: true, csv: 'product_id,title\nitem,Fixture product' }]);
  const { catalogResult, activity } = f.client.snapshot();
  assert.deepEqual(catalogResult, { import_id: 'import', status: 'previewed' });
  const { action, catalogProvider, catalogStore, result } = activity[0];
  assert.deepEqual({ action, catalogProvider, catalogStore, result }, {
    action: 'catalogUpload', catalogProvider: 'shopify', catalogStore: 'Fixture store', result: '商品数据已送工作台预览',
  });
  assert(!/catalog\.csv|Fixture product|claim-token|fixture\.myshopify\.com/.test(JSON.stringify(activity)));
  await f.client.claim();
  assert.equal(f.client.snapshot().task?.id, 'attempt');
});

test('disconnect aborts file selection and emergency stop aborts upload without discarding the lease', async () => {
  const f = fixture();
  await f.start();
  await f.client.claimCatalog();
  const originalFile = f.catalog.file;
  const reading = Promise.withResolvers<AbortSignal>();
  const finishRead = Promise.withResolvers<void>();
  f.catalog.file = async signal => { reading.resolve(signal); await finishRead.promise; return originalFile(signal); };
  const selection = f.client.selectCatalogFile();
  const readSignal = await reading.promise;
  f.client.disconnect();
  assert(readSignal.aborted);
  finishRead.resolve();
  await assert.rejects(selection, { name: 'AbortError' });
  assert.equal(f.client.snapshot().catalog?.file, undefined);
  await f.client.connect();
  await f.client.selectCatalogFile();
  const send = f.catalog.upload;
  const sending = Promise.withResolvers<AbortSignal>();
  const finishSend = Promise.withResolvers<void>();
  f.catalog.upload = async signal => { sending.resolve(signal); await finishSend.promise; return send(signal); };
  const upload = f.client.uploadCatalog(storeConfirmation);
  const uploadSignal = await sending.promise;
  f.client.stop();
  assert(uploadSignal.aborted);
  finishSend.resolve();
  await assert.rejects(upload, { name: 'AbortError' });
  assert.equal(f.client.snapshot().catalogResult, undefined);
  assert.equal(f.client.snapshot().catalog?.file, undefined);
  assert.equal(f.client.snapshot().catalog?.uploadUnconfirmed, true);
  await f.client.connect();
  f.catalog.file = async signal => ({ ...(await originalFile(signal)), csv: 'sku,title\nnew,New item' });
  await assert.rejects(f.client.selectCatalogFile(), /同一份商品表/);
  f.catalog.file = originalFile;
  await f.client.selectCatalogFile();
  await f.client.uploadCatalog(storeConfirmation);
  assert.deepEqual(f.catalog.uploads[0], f.catalog.uploads[1]);
});

test('expired catalog lease blocks uploads without blocking social claims', async () => {
  const f = fixture();
  await f.start();
  await f.client.claimCatalog();
  await f.client.selectCatalogFile();
  f.advance(60_000);
  assert.equal(f.client.snapshot().catalog?.expired, true);
  await f.client.tick();
  await f.client.tick();
  assert.equal(f.client.snapshot().activity.filter(event => event.action === 'catalogLease').length, 1);
  await assert.rejects(f.client.uploadCatalog(storeConfirmation), /租约已结束/);
  assert.deepEqual(f.catalog.uploads, []);
  await f.client.claim();
  assert.equal(f.client.snapshot().task?.id, 'attempt');
});

test('snapshot probes secure storage only when a service is configured', () => {
  let probes = 0;
  const options = {
    version: '0.1.0', platform: 'darwin' as const,
    vault: {
      load: () => undefined, save: () => {}, clear: () => {},
      available: () => { probes++; return true; },
    },
    openExternal: async () => {}, pickMedia: async () => undefined,
  };
  assert.equal(new DesktopConnector(options).snapshot().secureStorage, false);
  assert.equal(probes, 0);
  assert.equal(new DesktopConnector({ ...options, origin }).snapshot().secureStorage, true);
  assert.equal(probes, 1);
});

test('requires ownership, verifies signed browser handoff even for an auto claim, and submits evidence references only', async () => {
  const f = fixture();
  await assert.rejects(f.client.pair({ ...pair, ownsDevice: false }));
  assert.deepEqual(f.paths, []);
  await f.prepare();
  assert.deepEqual(f.urls, ['https://creator.douyin.com/']);
  await f.client.confirm(account);
  assert(f.client.snapshot().task?.until);
  await f.client.finish({ result: 'submitted', receipt });
  assert.deepEqual(f.reports, [{ kind: 'accepted', submitted_by: 'human', platform_post_id: '123', result_url: receipt.url,
    evidence: [{ kind: 'masked_screenshot', object_id: receipt.objectId, sha256: receipt.sha256 }], attempt_id: 'attempt', fencing_token: 7 }]);
  assert.equal(f.client.snapshot().task, undefined);
  const [{ id, ...report }, handoff] = f.client.snapshot().activity;
  assert(id > handoff.id);
  assert.deepEqual(report, { action: 'report', tone: 'warning', result: '人工提交已回填，发布结果待核实',
    app: 'douyin', kind: 'douyin.video.publish', time: '2026-11-20T15:00:00.000Z' });
  assert.equal(handoff.result, '已交接，等待人工提交');
  const activity = JSON.stringify(f.client.snapshot().activity);
  for (const privateValue of [pair.code, account.observed, receipt.objectId, receipt.url, revision.body, 'fixture.mp4']) {
    assert(!activity.includes(privateValue));
  }
  f.client.disconnect();
  assert.equal(f.client.snapshot().connected, false);
  assert(f.saved);
  f.client.forget();
  assert.equal(f.saved, undefined);
  assert.deepEqual(f.client.snapshot().activity.map(event => event.action), ['forget']);
});

test('rejects a claim for another device and reports an account mismatch before any ready request', async () => {
  const wrongScope = fixture();
  wrongScope.controls.badScope = true;
  await wrongScope.start();
  await assert.rejects(wrongScope.client.claim(), /scope mismatch/);
  assert.equal(wrongScope.client.snapshot().task, undefined);
  const f = fixture();
  await f.prepare();
  await f.client.confirm({ ...account, observed: 'different-user' });
  assert.equal(f.paths.some(path => path.endsWith('/ready')), false);
  assert.equal((f.reports[0] as { reason: string }).reason, 'identity_mismatch');
});

test('blocks media mismatch and requires an observed identity for the browser session', async () => {
  const f = fixture();
  f.controls.hash = 'c'.repeat(64);
  await f.prepare();
  await f.client.confirm(account);
  assert.equal((f.reports[0] as { reason: string }).reason, 'media_unverified');
  assert(!f.paths.some(path => path.endsWith('/ready')));
  await assert.rejects(f.client.verifySession({ session: 'session', observed: account.observed, confirmed: false }));
  await f.client.verifySession({ session: 'session', ...account });
  assert.equal(f.paths.at(-1), '/api/v1/device/browser-identity');
});

test('emergency stop invalidates an in-flight ready and requires explicit resumed activity', async () => {
  const f = fixture();
  await f.prepare();
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  f.controls.ready = async () => { entered.resolve(); await resume.promise; };
  const confirm = f.client.confirm(account);
  await entered.promise;
  f.client.stop();
  resume.resolve();
  await assert.rejects(confirm, { name: 'AbortError' });
  assert.equal(f.client.snapshot().connected, false);
  assert.equal(f.client.snapshot().task?.until, undefined);
  const count = f.paths.length;
  await f.client.tick();
  await assert.rejects(f.client.claim());
  assert.equal(f.paths.length, count);
  await f.client.retryReport();
  assert.equal((f.reports[0] as { kind: string }).kind, 'blocked');
});

test('failed heartbeat stops handoff and preserves an unknown outcome', async () => {
  const f = fixture();
  await f.prepare();
  await f.client.confirm(account);
  f.controls.failHeartbeat = true;
  await f.client.tick();
  assert.equal(f.client.snapshot().connected, false);
  assert.equal(f.client.snapshot().task?.pending, 'outcome_unknown');
  assert.equal(f.client.snapshot().connectionIssue, 'authorization');
  assert.equal(f.client.snapshot().activity[0].action, 'heartbeat');
  assert.equal(f.client.snapshot().activity[0].tone, 'error');
  await f.client.retryReport();
  assert.equal(f.client.snapshot().activity[0].result, '已回填，结果未知');
  assert.deepEqual(f.reports, [{ kind: 'outcome_unknown', attempt_id: 'attempt', fencing_token: 7 }]);
});

test('supports corrected evidence after 422 and retries an unacknowledged report unchanged', async () => {
  const f = fixture();
  await f.prepare();
  await f.client.confirm(account);
  f.controls.failReport = 422;
  await assert.rejects(f.client.finish({ result: 'submitted', receipt }), /证据/);
  f.controls.failReport = 503;
  await assert.rejects(f.client.finish({ result: 'submitted', receipt: { ...receipt, objectId: 'corrected' } }), /回填未获确认/);
  f.controls.failReport = 0;
  assert.equal(f.client.snapshot().activity[0].tone, 'error');
  await f.client.retryReport();
  assert.equal(f.client.snapshot().activity[0].action, 'retry');
  assert.deepEqual(f.reports[2], f.reports[1]);
  assert.notDeepEqual(f.reports[1], f.reports[0]);
});

test('does not accept completion after the handoff window or keep stale leases', async () => {
  const f = fixture();
  await f.prepare();
  await f.client.confirm(account);
  f.advance(60_000);
  await f.client.finish({ result: 'submitted', receipt });
  assert.equal((f.reports[0] as { kind: string }).kind, 'outcome_unknown');
  const expired = fixture();
  await expired.prepare();
  expired.advance(120_000);
  await expired.client.tick();
  assert.equal(expired.client.snapshot().task, undefined);
  assert.equal(expired.client.snapshot().connected, false);
});

test('activity is bounded and does not record routine successful heartbeats', async () => {
  const f = fixture();
  await f.start();
  await f.client.tick();
  assert.deepEqual(f.client.snapshot().activity.map(event => event.action), ['connect', 'pair']);
  await f.client.claim();
  assert.equal(f.client.snapshot().task?.binding, 'binding');
  for (let i = 0; i < 31; i++) f.client.stop();
  const { activity, connectionIssue } = f.client.snapshot();
  assert.equal(connectionIssue, 'stopped');
  assert.equal(activity.length, 30);
  assert(activity.every(event => event.action === 'stop'));
  assert.equal(activity[0].id, activity.at(-1)!.id + 29);
});

test('accepts only canonical HTTPS post links without credentials, tracking, or an ID mismatch', () => {
  assert.equal(parseReceipt(receipt, 'douyin', '123').platform_post_id, '123');
  for (const url of ['https://www.douyin.com.example.test/video/123', 'https://www.douyin.com/video/123?token=secret', 'https://www.douyin.com/video/999', 'https://user@www.douyin.com/video/123']) {
    assert.throws(() => parseReceipt({ ...receipt, url }, 'douyin'));
  }
});

test('vault only writes ciphertext and fails closed when OS storage is unavailable', () => {
  const dir = mkdtempSync(join(import.meta.dirname, '.vault-'));
  try {
    const path = join(dir, 'pairing');
    let available = true;
    let plaintext = '';
    const safe = {
      isEncryptionAvailable: () => available,
      encryptString: (value: string) => { plaintext = value; return Buffer.from('ciphertext'); },
      decryptString: (value: Buffer) => { assert.equal(String(value), 'ciphertext'); return plaintext; },
    };
    const vault = deviceVault(path, safe, 'darwin');
    const { privateKey: key } = generateKeyPairSync('ed25519');
    vault.save({ key, origin, workspace: 'workspace', device: 'device', name: 'Offline' });
    assert.equal(readFileSync(path, 'utf8'), 'ciphertext');
    assert.deepEqual(vault.load()?.key.export({ format: 'der', type: 'pkcs8' }), key.export({ format: 'der', type: 'pkcs8' }));
    available = false;
    assert.throws(() => vault.load());
    assert.throws(() => vault.save({ key, origin, workspace: 'workspace', device: 'device', name: 'Offline' }));
    vault.clear();
    assert.equal(vault.load(), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
