import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import { exportDevicePublicKey, signDeviceProof } from '../../../../../packages/connector-tasks/src/index.js';
import { bindPlatform } from '../../extensions/platforms.js';
import { MemoryStore } from '../../memory.js';
import { register, type Registry } from '../../registry.js';
import { commands, createAccountModule, deviceCommandBytes, type SignedDeviceCommand } from './index.js';
import type { Context, Fields } from '../types.js';

it('binds the provider identity and reconciles distinct TikTok publication IDs', async () => {
  const request = { tenant_id: 'tenant', workspace_id: 'workspace', account_id: 'internal-id', account_identity: 'external-id',
    platform: 'tiktok', target_id: 'target', attempt_id: 'attempt', fencing_token: 1, client_request_id: 'request', frozen_hash: 'fixture', frozen: {} };
  let postIds = ['111'];
  const adapter = bindPlatform('tiktok', async ({ effect }) => {
    expect(effect).toBe('read');
    return { status: 200, body: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: postIds } } };
  }, {
    connection: async ({ account_id }) => {
      expect(account_id).toBe('internal-id');
      return { accountId: 'external-id', credential: { accountId: 'external-id', state: 'active', accessToken: 'fixture', scopes: ['video.upload'], approvals: ['tiktok_inbox'] } };
    },
    payload: async () => undefined,
  });
  const receipt = JSON.stringify({ provider: 'tiktok', kind: 'tiktok_publish', accountId: 'external-id', id: 'publish-1' });
  await expect(adapter.observe(request, receipt)).resolves.toMatchObject({ status: 'published', external_post_id: '111' });
  postIds = ['111', '222'];
  await expect(adapter.observe(request, receipt)).resolves.toMatchObject({ status: 'unknown' });
});

it('dispatches only the explicitly frozen TikTok inbox operation and reports missing credentials before submission', async () => {
  const request = { tenant_id: 'tenant', workspace_id: 'workspace', account_id: 'internal-id', account_identity: 'external-id',
    platform: 'tiktok', target_id: 'target', attempt_id: 'attempt', fencing_token: 1, client_request_id: 'request', frozen_hash: 'fixture', frozen: { platform_operation: 'upload_draft' } };
  let available = false;
  const writes: string[] = [];
  const adapter = bindPlatform('tiktok', async ({ effect, url }) => {
    if (effect === 'read') return { status: 200, body: { data: { status: 'SEND_TO_USER_INBOX' } } };
    writes.push(new URL(url).pathname);
    return { status: 200, body: { error: { code: 'ok' }, data: { publish_id: 'v_inbox' } } };
  }, {
    connection: async () => ({ accountId: 'external-id', credential: available ? {
      accountId: 'external-id', state: 'active', accessToken: 'fixture', scopes: ['video.upload'], approvals: ['tiktok_inbox'],
      configuration: { verifiedMediaPrefix: 'https://cdn.example/video/' },
    } : undefined }),
    payload: async () => ({ mediaUrl: 'https://cdn.example/video/clip.mp4' }),
  });
  await expect(adapter.submit(request)).resolves.toMatchObject({ status: 'not_submitted', code: 'credential_unavailable' });
  available = true;
  await expect(adapter.submit({ ...request, frozen: {} })).resolves.toMatchObject({ status: 'not_submitted' });
  expect(writes).toEqual([]);
  const receipt = await adapter.submit(request);
  expect(receipt.status).toBe('accepted');
  expect(writes).toEqual(['/v2/post/publish/inbox/video/init/']);
  if (receipt.status !== 'not_submitted') await expect(adapter.observe(request, receipt.receipt_id)).resolves.toMatchObject({ status: 'pending' });
});

it('completes scoped OAuth once, with PKCE and credential revision fencing', async () => {
  const store = new MemoryStore();
  await store.setup({ email: 'local@example.test', name: 'Owner', passwordHash: 'fixture', workspaceName: 'Test' }, 'fixture');
  const workspaceId = (await store.session('fixture'))!.workspaces[0].id;
  let key = 0;
  function tx<T>(work: (ctx: Context) => Promise<T>): Promise<T> {
    return store.workspace('fixture', workspaceId, async (unit) => await unit.command({ module: 'account', action: 'fixture', key: `oauth-${key++}`, fingerprint: '' }, () => work(unit.context)) as T);
  }
  const brand = await tx((ctx) => ctx.insert('workspace', 'brand', { status: 'active' }));
  const origin = 'https://www.tiktok.com';
  let challenge = '';
  const vault = new Map<string, number>();
  const account = createAccountModule({
    phase: 'P0b',
    credential: async (_ctx, id, subject, revision) => vault.get(id) === revision ? {
      accountId: subject, state: 'active', accessToken: 'fixture', scopes: ['video.upload', 'video.publish'], approvals: ['tiktok_inbox', 'tiktok_direct_post_audit'],
    } : undefined,
    oauth: { flowKey: randomBytes(32), configure: async () => ({
      authorizationOrigin: origin,
      authorize({ state, codeChallenge }) {
        challenge = codeChallenge;
        return `${origin}/v2/auth/authorize/?state=${state}`;
      },
      async exchange(_ctx, { query, codeVerifier }) {
        expect(query.code).toBe('fixture-code');
        expect(createHash('sha256').update(codeVerifier).digest('base64url')).toBe(challenge);
        return {
          grant: { provider: 'tiktok', principalId: 'self', scopes: ['video.upload'], expiresAt: '2099-01-01T00:00:00Z', externalAccountIds: ['self'] },
          async saveCredential(id, revision) { vault.set(id, revision); },
        };
      },
    }) },
  });
  const run = (action: string, input: Fields) => tx((ctx) => account.commands[action].run(ctx, input)) as Promise<Fields>;
  await expect(run('start_oauth', { provider: 'shopify', brand_id: brand.id })).rejects.toMatchObject({ code: 'PLATFORM_APP_NOT_READY' });
  const started = await run('start_oauth', { provider: 'tiktok', brand_id: brand.id });
  const query = { state: new URL(started.authorize_url).searchParams.get('state')!, code: 'fixture-code' };
  const complete = (provider: string) => tx((ctx) => account.internal.completeOAuth(ctx, provider, query)) as Promise<Fields>;
  await expect(complete('youtube')).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
  const { connection_id } = await complete('tiktok');
  await expect(complete('tiktok')).rejects.toMatchObject({ code: 'OAUTH_STATE_INVALID' });
  const social = await run('register_account', { brand_id: brand.id, provider: 'tiktok', name: 'Fixture', default_timezone: 'UTC', external_account_id: 'self', connection_id });
  const resolve = (operation: 'publish' | 'upload_draft') => tx((ctx) => account.internal.resolveOfficialConnection(ctx, { accountId: social.id, externalAccountId: 'self', provider: 'tiktok', operation }));
  await expect(resolve('upload_draft')).resolves.toMatchObject({ credential: { scopes: ['video.upload'] } });
  await expect(resolve('publish')).resolves.not.toHaveProperty('credential');
  await run('revoke_connection', { connection_id });
  await expect(resolve('upload_draft')).resolves.not.toHaveProperty('credential');
});

it('registers Commands and enforces scopes, licensing, revocation and single-use leases', async () => {
  const registry: Registry = new Map();
  register(registry, 'account', commands);
  expect(registry.get('account')?.has('check_capabilities')).toBe(true);
  expect(registry.get('account')?.has('request_submit_permit')).toBe(false);

  const store = new MemoryStore();
  await store.setup({ email: 'local@example.test', name: 'Owner', passwordHash: 'fixture', workspaceName: 'Test' }, 'fixture');
  const session = await store.session('fixture');
  const workspaceId = session!.workspaces[0].id;
  let key = 0;
  function tx<T>(work: (ctx: Context) => Promise<T>): Promise<T> {
    return store.workspace('fixture', workspaceId, async (unit) => {
      return await unit.command({ module: 'account', action: 'fixture', key: `test-${key++}`, fingerprint: '' }, () => work(unit.context)) as T;
    });
  }
  let termsVersion = 'fixture-v1';
  const account = createAccountModule({ leaseKey: generateKeyPairSync('ed25519'), phase: 'P0b', license: async () => ({ social_accounts: 1 }),
    connectorCompatibility: async () => ({ ready: true, allowAuto: true }), authorizeJob: async () => true,
    terms: async () => ({ version: termsVersion, text: { 'zh-Hant': '測試條款', en: 'Fixture terms' } }),
  });
  const run = (action: string, input: Fields) => tx((ctx) => account.commands[action].run(ctx, input)) as Promise<Fields>;
  const brand = await tx((ctx) => ctx.insert('workspace', 'brand', { status: 'active' }));
  const data = { provider: 'tiktok', external_account_id: 'self', name: 'Fixture', brand_id: brand.id, default_timezone: 'UTC', owned_account_confirmed: true };
  const grant = await tx((ctx) => account.internal.recordGrant(ctx, { provider: 'tiktok', principalId: 'self', scopes: ['video.upload'], expiresAt: '2099-01-01T00:00:00Z', externalAccountIds: ['self'] }));
  await expect(run('register_account', { ...data, external_account_id: 'unrelated', connection_id: grant.id })).rejects.toMatchObject({ code: 'account_not_in_grant' });
  const social = await run('register_account', { ...data, connection_id: grant.id });
  await expect(run('register_account', { ...data, external_account_id: 'other' })).rejects.toMatchObject({ code: 'LICENSE_LIMIT' });
  await run('revoke_connection', { connection_id: grant.id });
  const report = await run('check_capabilities', { target: 'social_account', id: social.id });
  expect(report.capabilities.find((cap: Fields) => cap.executor === 'api' && cap.operation === 'upload_draft').available).toBe(false);
  const manual = await run('record_manual_result', { social_account_id: social.id, job_id: 'approved', outcome: 'reported_present', external_ref: 'post-1', note: 'Reported by operator' });
  expect(manual.data.verified).toBe(false);

  const pair = await run('create_pairing_code', { label: 'Test Mac', host_os: 'macos', owned_device_confirmed: true });
  const deviceKey = generateKeyPairSync('ed25519');
  const pairInput = { device_id: pair.device_id, code: pair.code, public_key: exportDevicePublicKey(deviceKey.publicKey), signature: signDeviceProof(pair.challenge, deviceKey.privateKey) };
  await tx((ctx) => account.internal.finishPairing(ctx, pairInput));
  await expect(tx((ctx) => account.internal.finishPairing(ctx, pairInput))).rejects.toMatchObject({ code: 'invalid_pairing' });
  const body = Buffer.from('{}');
  let signed: SignedDeviceCommand;
  await tx(async (ctx) => {
    const request = { deviceId: pair.device_id, action: 'heartbeat' as const, timestamp: ctx.now, nonce: randomBytes(24).toString('base64url') };
    signed = { ...request, signature: sign(null, deviceCommandBytes(ctx.tenantId, ctx.workspaceId, request, body), deviceKey.privateKey).toString('base64url') };
    await expect(account.dispatchDevice(ctx, signed, Buffer.from('{ }'))).rejects.toMatchObject({ code: 'invalid_device_proof' });
    await expect(account.dispatchDevice(ctx, { ...signed, action: 'claim_lease' }, body)).rejects.toMatchObject({ code: 'invalid_device_proof' });
    await expect(account.dispatchDevice(ctx, signed, body)).resolves.toMatchObject({ status: 'online' });
  });
  await expect(tx((ctx) => account.dispatchDevice(ctx, signed, body))).rejects.toMatchObject({ code: 'device_request_replayed' });
  const binding = await run('set_execution_binding', { social_account_id: social.id, mode: 'connector', device_id: pair.device_id, connector_channel: 'browser', workflow: 'manual_handoff', owned_account_confirmed: true, workflow_consent_confirmed: true });
  const input = { binding_id: binding.id, job_id: 'approved', user_requested: true };
  await tx((ctx) => account.internal.reportIdentity(ctx, pair.device_id, { ...input, observed_platform_user_id: 'self' }));
  const claim = () => tx((ctx) => account.internal.claimLease(ctx, pair.device_id, input)) as Promise<Fields>;
  const use = (token: string) => tx((ctx) => account.internal.useLease(ctx, pair.device_id, { ...input, token }));
  const revoked = await claim();
  await run('revoke_lease', { lease_id: revoked.lease_id });
  await expect(use(revoked.token)).rejects.toMatchObject({ code: 'lease_unavailable' });
  const active = await claim();
  await expect(use(active.token)).resolves.toMatchObject({ status: 'manual_required' });
  await expect(use(active.token)).rejects.toMatchObject({ code: 'lease_unavailable' });

  await run('enable_auto_mode', { ...input, terms_version: termsVersion, risk_acknowledged: true, max_per_hour: 2, min_interval_seconds: 300, daily_cap: 5,
    allowed_windows: [{ days: [0, 1, 2, 3, 4, 5, 6], start: '00:00', end: '24:00' }] });
  const permitLease = await claim();
  const permitInput = { ...input, token: permitLease.token };
  const consume = () => tx((ctx) => account.internal.consumeSubmitPermit(ctx, pair.device_id, permitInput));
  await expect(tx((ctx) => account.internal.requestSubmitPermit(ctx, pair.device_id, permitInput))).resolves.toMatchObject({ status: 'granted' });
  await tx((ctx) => account.internal.setOpsHalt(ctx, 'ops-one', true, 'Fixture stop'));
  await run('halt_workspace_auto', { reason: 'Local fixture stop' });
  await run('release_workspace_auto', { reason: 'Local fixture release' });
  await expect(consume()).resolves.toEqual({ status: 'denied', reason: 'emergency_halt' });
  await tx((ctx) => account.internal.setOpsHalt(ctx, 'ops-one', false, 'Fixture release'));
  await expect(consume()).rejects.toMatchObject({ code: 'permit_unavailable' });
  termsVersion = 'fixture-v2';
  await expect(consume()).resolves.toEqual({ status: 'denied', reason: 'terms_version_outdated' });
  await expect(tx((ctx) => account.internal.recheckTerms(ctx))).resolves.toEqual({ count: 1 });
  await expect(consume()).resolves.toEqual({ status: 'denied', reason: 'auto_stopped' });
});
