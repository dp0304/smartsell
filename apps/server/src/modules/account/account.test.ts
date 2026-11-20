import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import type { Context, Data, Row } from '@smartsell/contracts';
import { connectionContext, createOperations, completeOAuth, deviceRequestBytes, mountAccountIngress, pairDevice, setOpsHalt, type Services } from './index.ts';
import { enqueueConnectorTask, handleDeviceRequest, reconcileConnectorTask, type ConnectorServices, type DeviceAction } from './connector-service.ts';
import { evaluatePermit, recheckTerms } from './auto-control.ts';
import { reportPhone } from './device-control.ts';
import { frozenRevisionHash } from '../../../../../packages/connector-tasks/src/tasks.ts';
import type { Adapter } from '../../../../../packages/adapters/src/adapter-types.ts';
import { createAdapter } from '../../../../../packages/adapters/src/official.ts';
import { operations as executionOperations } from '../execution/ops.ts';
import { upsertObservedPost } from '../execution/service.ts';

const start = '2026-11-19T12:00:00.000Z';
function fixture() {
  const rows = new Map<string, Row[]>();
  let next = 0;
  const ctx: Context = {
    workspaceId: 'workspace-fixture', tenantId: 'tenant-fixture', actorId: 'admin-fixture', role: 'admin', now: start,
    list: kind => rows.get(kind) ?? [],
    get(kind, id) { const row = ctx.list(kind).find(item => item.id === id); if (!row) throw new Error(`missing ${kind}`); return row; },
    create(kind, values) {
      const row = { ...values, id: `fixture-${++next}`, version: 1, created_at: ctx.now, updated_at: ctx.now };
      rows.set(kind, [...ctx.list(kind), row]); return row;
    },
    update(kind, id, values) {
      const old = ctx.get(kind, id);
      const row = { ...old, ...values, version: old.version + 1, updated_at: ctx.now };
      rows.set(kind, ctx.list(kind).map(item => item.id === id ? row : item)); return row;
    },
    remove: (kind, id) => { rows.set(kind, ctx.list(kind).filter(item => item.id !== id)); },
    emit() {},
  };
  const brand = ctx.create('brand', { status: 'active' });
  const call = (name: string, body: Data = {}, id = '', services: Services = {}) => {
    const operation = createOperations({ humanSession: () => true, ...services }).find(item => item.name === `account_${name}`)!;
    expect(operation.roles).toContain(ctx.role);
    return operation.run(ctx, { params: { id }, body, query: {} });
  };
  return { ctx, call, brand };
}

const terms = { version: 'fixture-v1', text: 'Fixture-only risk terms' };
const config = { max_per_hour: 1, min_interval_seconds: 120, daily_cap: 2, allowed_windows: [{ start: '09:00', end: '17:00' }] };

describe('AC workspace and device boundaries', () => {
  it('mounts ingress with raw signature input and rejects untrusted gateway operations', async () => {
    const { ctx } = fixture();
    const app = Fastify();
    const application = ctx.create('platform_app', { provider: 'shopify', status: 'active' });
    ctx.create('connection', { provider: 'shopify', platform_app_id: application.id, status: 'active', shop_domain: 'test.myshopify.com' });
    const adapter = { provider: 'shopify', webhook: {
      verify: ({ rawBody, headers }: { rawBody: Uint8Array; headers: Record<string, string> }) => headers['x-fixture-signature'] === 'fixture' && Buffer.from(rawBody).toString() === '{ "id": 8 }',
      parse: ({ headers }: { headers: Record<string, string> }) => [{ provider: 'shopify', type: 'products/update', externalId: '8',
        accountId: headers['x-shopify-shop-domain'], action: 'resync' }],
    } } as unknown as Adapter;
    mountAccountIngress(app, {
      account: { adapter: () => adapter, shopifyApp: () => ({ egressVerified: true, shopDomain: 'test.myshopify.com', oauthScopes: [] }) },
      connector: { authorizeTask: () => false },
      transaction: async (_id, run) => run(ctx), oauthWorkspace: async () => undefined,
      pairingWorkspace: async () => undefined, deviceWorkspace: async () => undefined,
      webhookWorkspace: async (_provider, endpoint) => endpoint === 'fixture' ? { workspaceId: ctx.workspaceId, appId: application.id } : undefined,
    });
    try {
      const url = '/api/v1/webhooks/shopify/fixture';
      const headers = { 'content-type': 'application/json', 'x-fixture-signature': 'fixture', 'x-shopify-shop-domain': 'test.myshopify.com' };
      const invalid = await app.inject({ method: 'POST', url, headers, payload: '{"id":8}' });
      expect(invalid.statusCode).toBe(401);
      const unrelated = await app.inject({ method: 'POST', url, headers: { ...headers, 'x-shopify-shop-domain': 'other.myshopify.com' }, payload: '{ "id": 8 }' });
      expect(unrelated.json()).toEqual({ data: { accepted: 0 } });
      const valid = await app.inject({ method: 'POST', url, headers, payload: '{ "id": 8 }' });
      expect(valid.json()).toEqual({ data: { accepted: 1 } });
      expect(valid.headers['cache-control']).toBe('no-store');
      const replay = await app.inject({ method: 'POST', url, headers, payload: '{ "id": 8 }' });
      expect(replay.json()).toEqual({ data: { duplicate: true } });
      const duplicateState = await app.inject('/api/v1/oauth/callback/shopify?state=a&state=b&code=fixture');
      expect(duplicateState.statusCode).toBe(400);
      expect(duplicateState.json()).toEqual({ error: { code: 'OAUTH_STATE_INVALID' } });
      const issue = createOperations().find(op => op.name === 'account_issue_device_pairing_code')!;
      expect(() => issue.run(ctx, { body: { owned_device_confirmed: true }, params: {}, query: {} })).toThrow('HUMAN_SESSION_REQUIRED');
    } finally { await app.close(); }
  });
  it('returns only the trusted Meta subscription challenge as plaintext', async () => {
    const { ctx } = fixture();
    const app = Fastify();
    const { createAdapter } = await import('../../../../../packages/adapters/src/official.ts');
    const adapter = createAdapter('meta_instagram', { credentials: { clientId: 'fixture', clientSecret: 'fixture-secret', webhookVerifyToken: 'fixture-verify' } });
    mountAccountIngress(app, {
      account: { adapter: () => adapter }, connector: { authorizeTask: () => false },
      transaction: async (_id, run) => run(ctx), oauthWorkspace: async () => undefined,
      pairingWorkspace: async () => undefined, deviceWorkspace: async () => undefined,
      webhookWorkspace: async (_provider, endpoint) => endpoint === 'fixture' ? { workspaceId: ctx.workspaceId } : undefined,
    });
    try {
      const path = '/api/v1/webhooks/meta_instagram/fixture?hub.mode=subscribe&hub.challenge=12345&hub.verify_token=';
      const failed = await app.inject(path + 'wrong');
      expect(failed.statusCode).toBe(403);
      const confirmed = await app.inject(path + 'fixture-verify');
      expect(confirmed.statusCode).toBe(200);
      expect(confirmed.headers['content-type']).toMatch(/^text\/plain/);
      expect(confirmed.body).toBe('12345');
    } finally { await app.close(); }
  });

  it('pairs a signed CLI client with the real AC HTTP ingress', async () => {
    const { ctx, call } = fixture();
    const app = Fastify();
    const { createSignedHttpTransport, pairOverHttp, SignedDeviceClient } = await import('../../../../connector/src/device-client.ts');
    const { pairing_code } = await call('issue_device_pairing_code', { owned_device_confirmed: true }) as { pairing_code: string };
    mountAccountIngress(app, {
      account: {}, connector: { authorizeTask: () => false }, transaction: async (_id, run) => run(ctx),
      oauthWorkspace: async () => undefined, pairingWorkspace: async () => ctx.workspaceId,
      deviceWorkspace: async id => ctx.list('connector_device').some(row => row.id === id) ? ctx.workspaceId : undefined,
      webhookWorkspace: async () => undefined,
    });
    const inject: typeof fetch = async (url, init) => {
      const response = await app.inject({ method: 'POST', url: new URL(String(url)).pathname,
        headers: Object.fromEntries(new Headers(init?.headers)), payload: Buffer.from(init?.body as Uint8Array) });
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    };
    try {
      const origin = 'http://127.0.0.1:3000';
      const { privateKey } = generateKeyPairSync('ed25519');
      const id = await pairOverHttp(origin, ctx.workspaceId, pairing_code, 'darwin', 'Fixture computer', privateKey,
        { userInitiated: true, ownsDevice: true }, inject);
      const client = new SignedDeviceClient(ctx.workspaceId, id, privateKey, createSignedHttpTransport(origin, inject), () => Date.parse(ctx.now));
      await client.heartbeat('fixture');
      expect(ctx.get('connector_device', id).client_version).toBe('fixture');
      await expect(client.claim('local-binding')).resolves.toBeNull();
      await call('revoke_device', {}, id);
      await expect(client.claim('local-binding')).rejects.toMatchObject({ status: 401 });
    } finally { await app.close(); }
  });

  it('exchanges OAuth once, seals credentials, links the verified identity and revokes locally', async () => {
    const { ctx, call, brand } = fixture();
    const adapter = {
      provider: 'youtube',
      oauth: {
        authorizationUrl({ state, codeChallenge }: { state: string; codeChallenge: string }) { return `https://fixture.invalid/auth?state=${state}&challenge=${codeChallenge}`; },
        async exchangeCode({ codeVerifier }: { codeVerifier: string }) { expect(codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/); return { accessToken: 'fixture-secret', refreshToken: 'fixture-refresh', scopes: [], expiresIn: 300 }; },
      },
      async probe() { return { provider: 'youtube', status: 'ready', capabilities: [
        { operation: 'publish', content_format: 'video', executor: 'api', phase: 'P0a', readiness: 'implemented', status: 'available' },
      ], externalAccountId: 'verified-channel' }; },
    } as unknown as Adapter;
    const services = { adapter: () => adapter, encryptionKey: randomBytes(32), oauthRedirectUri: () => 'https://local.invalid/callback' };
    expect(() => call('start_oauth', { provider: 'youtube', brand_id: brand.id })).toThrow('PLATFORM_APP_NOT_READY');
    const started = await call('start_oauth', { provider: 'youtube', brand_id: brand.id }, '', services) as { authorize_url: string };
    const state = new URL(started.authorize_url).searchParams.get('state')!;
    const result = await completeOAuth(ctx, 'youtube', { state, code: 'fixture-code' }, services);
    expect(result.status).toBe('authorized');
    expect(JSON.stringify(result)).not.toMatch(/fixture-secret|fixture-refresh|sealed_token/);
    expect(JSON.stringify(ctx.list('connection'))).not.toContain('fixture-secret');
    await expect(completeOAuth(ctx, 'youtube', { state, code: 'fixture-code' }, services)).rejects.toThrow('OAUTH_STATE_INVALID');
    const connection = ctx.list('connection')[0];
    const unrelatedBrand = ctx.create('brand', { status: 'active' });
    const otherAccount = await call('register_owned_social_account', { provider: 'youtube', brand_id: unrelatedBrand.id,
      external_account_id: 'verified-channel', display_name: 'Fixture', owned_account_confirmed: true }) as Row;
    expect(() => call('link_accounts', { external_account_ids: ['verified-channel'] }, connection.id)).toThrow('BRAND_MISMATCH');
    expect(ctx.list('social_account_connection')).toHaveLength(0);
    await call('update_social_account', { brand_id: brand.id }, otherAccount.id);
    expect(() => call('link_accounts', { external_account_ids: ['unknown'] }, connection.id)).toThrow('PLATFORM_IDENTITY_UNVERIFIED');
    await call('link_accounts', { external_account_ids: ['verified-channel'] }, connection.id);
    expect(ctx.list('social_account')).toHaveLength(1);
    await call('probe_capabilities', {}, otherAccount.id, services);
    const capability = ctx.list('capability').find(row => row.operation === 'publish' && row.content_format === 'video' && row.executor === 'api');
    expect(capability).toMatchObject({ social_account_id: otherAccount.id, connection_id: connection.id, status: 'available' });
    await call('probe_capabilities', {}, otherAccount.id, services);
    expect(ctx.get('capability', capability!.id).version).toBe(2);
    const next = await call('start_oauth', { provider: 'youtube', brand_id: brand.id }, '', services) as { authorize_url: string };
    await completeOAuth(ctx, 'youtube', { state: new URL(next.authorize_url).searchParams.get('state')!, code: 'second-code' }, services);
    const second = ctx.list('connection').find(row => row.id !== connection.id)!;
    await call('link_accounts', { external_account_ids: ['verified-channel'] }, second.id);
    expect(ctx.list('social_account')).toHaveLength(1);
    expect(ctx.list('social_account_connection').map(row => row.social_account_id)).toEqual([otherAccount.id, otherAccount.id]);
    const post = ctx.create('platform_post', { social_account_id: otherAccount.id, external_post_id: 'historical-post' });
    await call('update_social_account', { display_name: 'Renamed' }, otherAccount.id);
    expect(ctx.get('social_account', String(post.social_account_id))).toMatchObject({ display_name: 'Renamed', external_account_id: 'verified-channel' });
    const fields = { social_account_id: otherAccount.id, operation: 'publish', content_format: 'video', route: [{ executor: 'api' }] };
    const queued = ctx.create('execution_task', { ...fields, status: 'queued' });
    const accepted = ctx.create('execution_task', { ...fields, status: 'accepted' });
    const manual = ctx.create('execution_task', { ...fields, status: 'queued', route: [{ executor: 'manual' }] });
    await call('revoke_connection', {}, second.id);
    expect(ctx.get('execution_task', queued.id).status).toBe('queued');
    await call('revoke_connection', { dry_run: true }, connection.id);
    expect(ctx.get('execution_task', queued.id).status).toBe('queued');
    await call('revoke_connection', {}, connection.id);
    expect(ctx.get('execution_task', queued.id)).toMatchObject({ status: 'blocked', status_reason: 'connection_revoked' });
    expect(ctx.get('execution_task', accepted.id).status).toBe('accepted');
    expect(ctx.get('execution_task', manual.id).status).toBe('queued');
    expect(ctx.get('capability', capability!.id).status).toBe('needs_authorization');
    expect(ctx.get('connection', connection.id).sealed_token).toBeNull();
    expect(ctx.list('social_account_connection')[0].status).toBe('revoked');
  });

  it('blocks a disabled custom app before exchanging or reading credentials', async () => {
    const { ctx, call, brand } = fixture();
    const app = ctx.create('platform_app', { provider: 'youtube', status: 'active' });
    let exchanges = 0;
    const adapter = { provider: 'youtube', oauth: {
      authorizationUrl: ({ state }: { state: string }) => `https://fixture.invalid/auth?state=${state}`,
      async exchangeCode() { exchanges++; return { accessToken: 'fictional-secret' }; },
    } } as unknown as Adapter;
    const services = { adapter: () => adapter, encryptionKey: randomBytes(32), oauthRedirectUri: () => 'https://local.invalid/callback' };
    const started = await call('start_oauth', { provider: 'youtube', brand_id: brand.id, platform_app_id: app.id }, '', services) as { authorize_url: string };
    const state = new URL(started.authorize_url).searchParams.get('state')!;
    ctx.update('platform_app', app.id, { status: 'disabled' });
    expect(await completeOAuth(ctx, 'youtube', { state, code: 'fixture-code' }, services)).toMatchObject({ status: 'failed' });
    expect(ctx.list('oauth_flow')[0].sealed_verifier).toBeNull();
    expect(exchanges).toBe(0);
    const row = ctx.create('connection', { provider: 'youtube', status: 'active', platform_app_id: app.id });
    expect(() => connectionContext(ctx, row, services)).toThrow('PLATFORM_APP_NOT_READY');
  });

  it('seals a Shopify merchant app grant, renews it, and requires verified egress', async () => {
    const { ctx, call, brand } = fixture();
    const app = ctx.create('platform_app', { provider: 'shopify', distribution: 'merchant_custom', status: 'active', shop_domain: 'fixture.myshopify.com' });
    let egressVerified = false;
    let exchanges = 0;
    const adapter = { provider: 'shopify', oauth: {
      async clientCredentials({ shopDomain }: { shopDomain: string }) {
        expect(shopDomain).toBe('fixture.myshopify.com');
        return { accessToken: `merchant-fixture-secret-${++exchanges}`, expiresIn: 86399, scopes: ['read_products'] };
      },
    }, async probe() { return { status: 'ready', externalAccountId: 'shop-fixture' }; } } as unknown as Adapter;
    const services = { privateDeployment: true, adapter: () => adapter, encryptionKey: randomBytes(32),
      shopifyApp: () => ({ shopDomain: 'fixture.myshopify.com', egressVerified, oauthScopes: ['read_products'] }) };
    const connect = () => call('connect_shopify_merchant', { platform_app_id: app.id, brand_id: brand.id }, '', services);
    await expect(connect()).rejects.toThrow('PLATFORM_APP_NOT_READY');
    expect(exchanges).toBe(0);
    egressVerified = true;
    expect(await connect()).toMatchObject({ status: 'active', purpose: 'store', scopes: ['read_products'] });
    const [{ id }] = ctx.list('connection');
    const { refreshConnection } = await import('./oauth.ts');
    expect(await refreshConnection(ctx, id, services)).toMatchObject({ id, status: 'active' });
    expect(ctx.list('connection')).toHaveLength(1);
    expect(JSON.stringify(ctx.get('connection', id))).not.toContain('merchant-fixture-secret');
    expect(connectionContext(ctx, ctx.get('connection', id), services)).toMatchObject({ externalAccountId: 'shop-fixture', accessToken: 'merchant-fixture-secret-2' });
    egressVerified = false;
    expect(() => connectionContext(ctx, ctx.get('connection', id), services)).toThrow('PLATFORM_APP_NOT_READY');
    await expect(refreshConnection(ctx, id, services)).rejects.toThrow('PLATFORM_APP_NOT_READY');
    await expect(call('get_store_capabilities', {}, id, services)).resolves.toMatchObject({
      connection_id: id, reason: 'not_configured_or_unverified', external_account_id: 'shop-fixture',
    });
    const store = ctx.create('store', { connection_id: id });
    expect(await call('revoke_connection', { dry_run: true }, id)).toMatchObject({ store_ids: [store.id] });
    expect(ctx.get('connection', id).status).toBe('active');
    await call('revoke_connection', {}, id);
    await expect(call('get_store_capabilities', {}, id, services)).resolves.toMatchObject({ reason: 'connection_inactive' });
  });

  it('requires a compatible OS and explicit ownership before a phone can be ready', async () => {
    const { ctx, call } = fixture();
    const device = ctx.create('connector_device', { status: 'active', last_seen_at: ctx.now, platform: 'darwin' });
    const report = { platform: 'android', physical: true, emulator: false, cloud: false, hardware_id_hash: 'a'.repeat(64),
      model: 'Fixture phone', serial_suffix: 'ABCD', connection: 'lan', os_version: '10.0', driver_version: 'fixture', connected: true, prerequisites_ready: true };
    expect(() => reportPhone(ctx, device, { ...report, emulator: true }, false)).toThrow('PHYSICAL_DEVICE_REQUIRED');
    const { mobile_device_id: id } = reportPhone(ctx, device, report, false);
    expect(() => call('approve_mobile_device', { owned_device_confirmed: true, model: report.model, serial_suffix: 'WXYZ' }, id)).toThrow('MOBILE_APPROVAL_MISMATCH');
    expect(await call('approve_mobile_device', { owned_device_confirmed: true, model: report.model, serial_suffix: report.serial_suffix }, id))
      .toMatchObject({ status: 'pending_setup' });
    expect(reportPhone(ctx, device, { ...report, os_version: '11.0' }, false).status).toBe('ready');
    const other = ctx.create('connector_device', { status: 'active', last_seen_at: ctx.now, platform: 'darwin' });
    expect(() => reportPhone(ctx, other, report, false)).toThrow('MOBILE_ALREADY_PAIRED');
    expect(() => reportPhone(ctx, device, { ...report, platform: 'ios' }, false)).toThrow('IOS_NOT_CONFIGURED');
  });

  it('keeps unknown reports eligible for later independent verification without counting twice', () => {
    const { ctx } = fixture();
    const binding = ctx.create('account_execution_binding', { connector_mode: 'auto', auto_ack_at: ctx.now, auto_ack_generation: 1 });
    const task = ctx.create('connector_task', { attempt_id: 'unknown-1', binding_id: binding.id, status: 'outcome_unknown', result: { submitted_by: 'auto' } });
    ctx.create('auto_submit_permit', { attempt_id: 'unknown-1', status: 'consumed', auto_ack_at: ctx.now, auto_ack_generation: 1 });
    reconcileConnectorTask(ctx, 'unknown-1', 'unknown');
    reconcileConnectorTask(ctx, 'unknown-1', 'unknown');
    expect(ctx.get('account_execution_binding', binding.id).auto_failure_streak).toBe(1);
    reconcileConnectorTask(ctx, 'unknown-1', 'verified', 'confirmed-post');
    expect(ctx.get('account_execution_binding', binding.id).auto_failure_streak).toBe(0);
    expect(ctx.get('connector_task', task.id)).toMatchObject({ status: 'completed', verified_post_id: 'confirmed-post' });
  });

  it('abandons queued work when disabling the target account', async () => {
    const { ctx, call } = fixture();
    const account = ctx.create('social_account', { status: 'active' });
    const queued = ctx.create('connector_task', { social_account_id: account.id, status: 'queued', lease_expires_at: '2026-11-19T12:05:00.000Z' });
    const claimed = ctx.create('connector_task', { social_account_id: account.id, status: 'claimed', lease_expires_at: '2026-11-19T12:05:00.000Z' });
    await call('disable_social_account', { dry_run: true }, account.id);
    expect(ctx.get('connector_task', queued.id).status).toBe('queued');
    await call('disable_social_account', {}, account.id);
    expect(ctx.get('connector_task', queued.id).status).toBe('abandoned');
    expect(ctx.get('connector_task', claimed.id).status).toBe('claimed');
  });

  it('evaluates overlapping stops, signed terms, local windows and grant counts', () => {
    const { ctx } = fixture();
    const account = ctx.create('social_account', { default_timezone: 'UTC' });
    const binding = ctx.create('account_execution_binding', { ...config, connector_mode: 'auto', auto_ack_terms_version: terms.version });
    expect(evaluatePermit(ctx, binding, account, terms).decision).toBe('granted');
    ctx.create('auto_submit_permit', { social_account_id: account.id, granted_at: ctx.now });
    expect(evaluatePermit(ctx, binding, account, terms)).toMatchObject({ decision: 'deferred', deny_reason: 'hourly_cap', retry_at: '2026-11-19T13:00:00.000Z' });
    setOpsHalt(ctx, 'rule-A', true); setOpsHalt(ctx, 'rule-B', true); setOpsHalt(ctx, 'rule-A', false);
    expect(evaluatePermit(ctx, binding, account, terms)).toMatchObject({ decision: 'denied', deny_reason: 'emergency_halt', halt_source: 'ops' });
    setOpsHalt(ctx, 'rule-B', false);
    expect(evaluatePermit(ctx, binding, account, { ...terms, version: 'fixture-v2' })).toMatchObject({ decision: 'denied', deny_reason: 'terms_version_outdated' });
    recheckTerms(ctx, { ...terms, version: 'fixture-v2' });
    expect(ctx.get('account_execution_binding', binding.id).connector_mode).toBe('assist');
    ctx.now = '2026-11-19T17:00:00.000Z';
    expect(evaluatePermit(ctx, binding, account, terms)).toMatchObject({ decision: 'denied', deny_reason: 'outside_window' });
  });

  it.each(['halt', 'halt-release', 're-sign', 're-sign-before-permit', 'post-consume-block', 'report'] as const)('binds a signed claim to an owned device and handles %s before reconciliation', async scenario => {
    const { ctx, call, brand } = fixture();
    const services: ConnectorServices = { terms: () => terms, connectorConfigured: () => true, authorizeTask: (_ctx, task, fence, slot) => task.attempt_id === 'attempt-fixture' && fence === 4 && slot === 12 };
    const key = generateKeyPairSync('ed25519');
    const encoded = key.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
    const { pairing_code } = await call('issue_device_pairing_code', { owned_device_confirmed: true }) as { pairing_code: string };
    const name = 'fixture PC';
    const proof = sign(null, Buffer.from(JSON.stringify(['smartsell.pair.v1', ctx.workspaceId, pairing_code, encoded, 'darwin', name])), key.privateKey).toString('base64url');
    const request = { pairing_code, public_key: encoded, platform: 'darwin', name, proof };
    const { device_id } = pairDevice(ctx, request);
    expect(() => pairDevice(ctx, request)).toThrow('PAIRING_CODE_INVALID');
    function signed(action: DeviceAction, body: Data) {
      const nonce = randomBytes(16).toString('base64url');
      const bytes = Buffer.from(JSON.stringify(body));
      const signature = sign(null, deviceRequestBytes(ctx.workspaceId, device_id, action, ctx.now, nonce, bytes), key.privateKey).toString('base64url');
      return () => handleDeviceRequest(ctx, action, bytes, { device_id, nonce, timestamp: ctx.now, signature }, services) as Data;
    }
    const beat = signed('heartbeat', { client_version: 'fixture-v1' });
    expect(beat()).toEqual({ status: 'online' });
    expect(beat).toThrow('DEVICE_PROOF_REPLAYED');
    const account = await call('register_owned_social_account', { owned_account_confirmed: true, provider: 'douyin', external_account_id: 'approved-identity', display_name: 'Fixture account', brand_id: brand.id }) as Row;
    const { binding } = await call('set_execution_binding', { mode: 'connector', connector_channel: 'browser', device_id, owned_account_confirmed: true }, account.id) as { binding: Row };
    const session = ctx.list('browser_session')[0];
    expect(signed('browser.identity', { session_id: session.id, observed_platform_identity: 'approved-identity' })()).toEqual({ status: 'verified' });
    await call('enable_auto_mode', { ...config, terms_version: terms.version, risk_acknowledged: true }, account.id, services);
    const revision = { id: 'rev-1', title: 'Fixture', body: 'Text', tags: [], visibility: 'public', media: [{ id: 'media-1', sha256: 'a'.repeat(64) }] };
    const hash = frozenRevisionHash(revision);
    const tokens = { fencing_token: 4, write_slot_token: 12 };
    enqueueConnectorTask(ctx, { schema_version: 1, workspace_id: ctx.workspaceId, attempt_id: 'attempt-fixture', connector_device_id: device_id,
      account_id: account.id, binding_id: binding.id, platform_identity: 'approved-identity', kind: 'douyin.video.publish',
      target: { channel: 'browser', profile_id: session.id, app: 'douyin' }, payload: { revision, approval: { id: 'approval-1', resource_hash: hash }, frozen_hash: hash },
    }, { ...tokens, lease_expires_at: '2026-11-19T12:05:00.000Z' }, services);
    expect(signed('claim', { binding_id: 'wrong-binding' })()).toEqual({ claim: null });
    expect(signed('claim', { binding_id: binding.id })()).toMatchObject({ claim: { effective_mode: 'auto' } });
    const attempt = { ...tokens, attempt_id: 'attempt-fixture', request_hash: hash };
    expect(signed('attempt.permit', attempt)).toThrow('SUBMISSION_NOT_AUTHORIZED');
    signed('attempt.ready', { ...attempt, observed_platform_identity: 'approved-identity' })();
    if (scenario === 're-sign-before-permit') {
      const next = { ...terms, version: 'fixture-v2' };
      services.terms = () => next;
      recheckTerms(ctx, next);
      await call('enable_auto_mode', { ...config, terms_version: next.version, risk_acknowledged: true }, account.id, services);
      expect(signed('attempt.permit', attempt)()).toEqual({ decision: 'denied', deny_reason: 'auto_stopped' });
      expect(ctx.list('auto_submit_permit')).toHaveLength(0);
      return;
    }
    const permit = signed('attempt.permit', attempt)();
    expect(permit.decision).toBe('granted');
    const consume = () => signed('attempt.consume', { ...attempt, permit_id: permit.permit_id })();
    if (scenario === 're-sign') {
      const next = { ...terms, version: 'fixture-v2' };
      services.terms = () => next;
      recheckTerms(ctx, next);
      await call('enable_auto_mode', { ...config, terms_version: next.version, risk_acknowledged: true }, account.id, services);
      expect(consume()).toEqual({ decision: 'denied', deny_reason: 'auto_stopped' });
      return;
    }
    if (scenario === 'post-consume-block') {
      expect(consume()).toEqual({ decision: 'granted' });
      const report = { ...attempt, kind: 'blocked', reason: 'captcha' };
      expect(signed('attempt.report', { ...report, write_slot_token: 99 })).toThrow('CONNECTOR_FENCE_LOST');
      expect(signed('attempt.report', report)()).toEqual({ status: 'outcome_unknown' });
      expect(ctx.list('account_block')[0].kind).toBe('captcha');
      expect(ctx.list('connector_task')[0].result).toMatchObject({ kind: 'outcome_unknown', submitted_by: 'auto' });
      return;
    }
    if (scenario === 'report') {
      expect(consume()).toEqual({ decision: 'granted' });
      const receipt = { ...attempt, kind: 'accepted', submitted_by: 'auto', platform_post_id: 'fictional-post',
        result_url: 'https://www.douyin.com/video/123?tracking=ignored#ignored', evidence: [] };
      expect(signed('attempt.report', receipt)).toThrow('INVALID_EVIDENCE');
      const evidence = [{ kind: 'masked_screenshot', sha256: 'b'.repeat(64), object_id: 'evidence-fixture' }];
      expect(signed('attempt.report', { ...receipt, evidence })).toThrow('EVIDENCE_UNVERIFIED');
      services.verifyEvidence = (_ctx, object) => object.object_id === 'evidence-fixture';
      expect(signed('attempt.report', { ...receipt, evidence })()).toEqual({ status: 'outcome_unknown' });
      expect(ctx.list('connector_task')[0].result).toMatchObject({ result_url: 'https://www.douyin.com/video/123' });
      reconcileConnectorTask(ctx, 'attempt-fixture', 'verified', 'fictional-post');
      expect(ctx.list('connector_task')[0].verification_result).toBe('verified');
      return;
    }
    setOpsHalt(ctx, 'operator-rule', true);
    if (scenario === 'halt-release') setOpsHalt(ctx, 'operator-rule', false);
    expect(consume()).toEqual({ decision: 'denied', deny_reason: 'emergency_halt' });
    expect(signed('attempt.report', { ...attempt, kind: 'blocked', reason: 'captcha' })()).toEqual({ status: 'completed' });
    expect(ctx.get('account_execution_binding', binding.id).connector_mode).toBe('assist');
    expect(ctx.list('account_block')[0].kind).toBe('captcha');
  });
});
