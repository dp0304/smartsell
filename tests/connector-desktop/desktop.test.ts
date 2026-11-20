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
  const controls = { failHeartbeat: false, badScope: false, failReport: 0, ready: undefined as undefined | (() => Promise<void>), hash: 'a'.repeat(64) };
  const ok = (data: unknown) => Response.json({ data });
  const client = new DesktopConnector({
    origin, version: '0.1.0', platform: 'darwin', now: () => now,
    vault: { load: () => saved, save: value => { saved = value; }, clear: () => { saved = undefined; }, available: () => true },
    openExternal: async url => { urls.push(url); },
    pickMedia: async () => [{ name: 'fixture.mp4', hash: controls.hash }],
    fetcher: async (input, options) => {
      const url = new URL(String(input));
      assert.equal(url.origin, origin);
      assert.equal(options?.redirect, 'error');
      assert.equal(options?.credentials, 'omit');
      const bytes = Buffer.from(options?.body as Uint8Array);
      const body = JSON.parse(bytes.toString());
      const headers = new Headers(options?.headers);
      const action = ({ '/api/v1/device/heartbeat': 'heartbeat', '/api/v1/device/claim': 'claim', '/api/v1/device/browser-identity': 'browser.identity',
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
      const timestamp = headers.get('x-smartsell-timestamp');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const payload = ['smartsell.device.v1', pair.workspace, 'device', action, timestamp, nonce, digest];
      assert(verify(null, Buffer.from(JSON.stringify(payload)), publicKey, Buffer.from(headers.get('x-smartsell-signature')!, 'base64url')));
      if (action === 'heartbeat') return controls.failHeartbeat ? new Response(null, { status: 403 }) : ok({ status: 'online' });
      if (action === 'browser.identity') return ok({ status: 'verified' });
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
  return { client, start, prepare, controls, paths, reports, urls, get saved() { return saved; }, advance: (ms: number) => { now += ms; } };
}

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
  f.client.disconnect();
  assert.equal(f.client.snapshot().connected, false);
  assert(f.saved);
  f.client.forget();
  assert.equal(f.saved, undefined);
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
  await f.client.retryReport();
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
  await f.client.retryReport();
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
