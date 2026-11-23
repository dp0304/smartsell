import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
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
import { zhihuStatsOperations } from './zhihu-stats.ts';

const start = '2026-11-19T12:00:00.000Z';
function fixture(uuid = false) {
  const rows = new Map<string, Row[]>();
  let next = 0;
  const ctx: Context = {
    workspaceId: 'workspace-fixture', tenantId: 'tenant-fixture', actorId: 'admin-fixture', role: 'admin', now: start,
    list: kind => rows.get(kind) ?? [],
    get(kind, id) { const row = ctx.list(kind).find(item => item.id === id); if (!row) throw new Error(`missing ${kind}`); return row; },
    create(kind, values) {
      const row = { ...values, id: uuid ? randomUUID() : `fixture-${++next}`, version: 1, created_at: ctx.now, updated_at: ctx.now };
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
  it('lets an active human administrator replace a departed pairing authorizer without transferring the device', () => {
    const { ctx } = fixture();
    const departed = 'departed-owner';
    const administrator = ctx.actorId;
    const device = ctx.create('connector_device', { owner_id: departed, name: 'Legacy Worker', status: 'active', allow_channel_registration: true });
    const keys = generateKeyPairSync('ed25519');
    const encoded = keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
    ctx.update('connector_device', device.id, { public_key: encoded });
    const store = ctx.create('store', { provider: 'amazon_sp', external_store_id: 'A001LEGACY', status: 'import_only', brand_id: ctx.list('brand')[0].id });
    const binding = ctx.create('worker_catalog_binding', { provider: store.provider, external_store_id: store.external_store_id, store_id: store.id, device_id: device.id });
    const activeWorkspaceMembers = [{ userId: administrator, role: 'admin', scopes: [] as string[] }];
    Object.assign(ctx, { activeWorkspaceMembers });
    const events: { type: string; data: Data }[] = [];
    ctx.emit = (type, data) => { events.push({ type, data }); };
    const request = () => {
      const nonce = randomBytes(18).toString('base64url');
      const raw = Buffer.from(JSON.stringify({ confirmed: true, selections: [{ kind: 'store', platform: 'amazon_sp', external_id: store.external_store_id, observed_at: ctx.now }] }));
      const action = 'channels.register';
      const signature = sign(null, deviceRequestBytes(ctx.workspaceId, device.id, action, ctx.now, nonce, raw), keys.privateKey).toString('base64url');
      return handleDeviceRequest(ctx, action, raw, { device_id: device.id, nonce, timestamp: ctx.now, signature }, { authorizeTask: () => false });
    };
    const input = { params: { id: device.id }, query: {}, body: { enabled: true } };
    const operation = (humanSession: () => boolean) => createOperations({ humanSession }).find(item => item.name === 'account_set_device_channel_registration')!;
    expect(() => request()).toThrow('WORKER_CHANNEL_REGISTRATION_NOT_AUTHORIZED');
    expect(() => operation(() => false).run(ctx, input)).toThrow('HUMAN_SESSION_REQUIRED');
    expect(() => operation(() => true).run({ ...ctx, role: 'manager' }, input)).toThrow('HUMAN_SESSION_REQUIRED');
    expect(operation(() => true).run(ctx, input)).toEqual({ device_id: device.id, allow_channel_registration: true, authorized_by: administrator });
    operation(() => true).run(ctx, input);
    expect(events).toEqual([{ type: 'account.audit.recorded', data: { action: 'account.device.channel_registration_changed', actor_id: administrator,
      occurred_at: ctx.now, device_id: device.id, owner_id: departed, enabled: true, authorized_by: administrator, previous_authorized_by: departed } }]);
    expect(ctx.get('connector_device', device.id)).toMatchObject({ id: device.id, owner_id: departed, public_key: encoded });
    expect(request()).toEqual({ registrations: [{ kind: 'store', platform: store.provider, external_id: store.external_store_id, resource_id: store.id, device_id: device.id }] });
    expect(ctx.get('worker_catalog_binding', binding.id)).toEqual(binding);
    activeWorkspaceMembers[0].role = 'viewer';
    activeWorkspaceMembers[0].scopes.push(`brand:${store.brand_id}`);
    expect(() => request()).toThrow('WORKER_CHANNEL_REGISTRATION_NOT_AUTHORIZED');
  });

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

  it('routes read-only Zhihu tasks to two signed devices and isolates login incidents by owner', async () => {
    const { ctx, call } = fixture(true);
    const app = Fastify();
    const { createSignedHttpTransport, pairOverHttp, SignedDeviceClient } = await import('../../../../connector/src/device-client.ts');
    mountAccountIngress(app, {
      account: {}, connector: { authorizeTask: () => false }, transaction: async (_id, run) => run(ctx),
      oauthWorkspace: async () => undefined, pairingWorkspace: async () => ctx.workspaceId,
      deviceWorkspace: async (_id, hint) => hint === ctx.workspaceId ? hint : undefined, webhookWorkspace: async () => undefined,
    });
    const inject: typeof fetch = async (url, init) => {
      const response = await app.inject({ method: 'POST', url: new URL(String(url)).pathname,
        headers: Object.fromEntries(new Headers(init?.headers)), payload: Buffer.from(init?.body as Uint8Array) });
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    };
    const origin = 'http://127.0.0.1:3000';
    const pair = async (owner: string) => {
      ctx.actorId = owner;
      const { pairing_code } = await call('issue_device_pairing_code', { owned_device_confirmed: true }) as { pairing_code: string };
      const { privateKey } = generateKeyPairSync('ed25519');
      const id = await pairOverHttp(origin, ctx.workspaceId, pairing_code, 'darwin', 'Test computer', privateKey,
        { userInitiated: true, ownsDevice: true }, inject);
      const client = new SignedDeviceClient(ctx.workspaceId, id, privateKey, createSignedHttpTransport(origin, inject), () => Date.parse(ctx.now));
      const headers = (action: string, raw: Buffer) => {
        const nonce = randomBytes(18).toString('base64url');
        const signature = sign(null, deviceRequestBytes(ctx.workspaceId, id, action, ctx.now, nonce, raw), privateKey).toString('base64url');
        return { 'content-type': 'application/json', 'x-smartsell-workspace': ctx.workspaceId, 'x-smartsell-device': id,
          'x-smartsell-timestamp': ctx.now, 'x-smartsell-nonce': nonce, 'x-smartsell-signature': signature };
      };
      return { id, client, headers };
    };
    const op = (owner: string, type: 'create' | 'get' | 'incidents_list', body: Data = {}, id = '') => {
      ctx.actorId = owner;
      return zhihuStatsOperations.find(operation => operation.name === `zhihu_stats_${type}`)!
        .run(ctx, { body, params: { id }, query: {} });
    };
    const queue = async (owner: string, body: Data) => await op(owner, 'create', body) as { id: string };
    const a = 'owner-a', b = 'owner-b';
    try {
      const workerA = await pair(a);
      const workerB = await pair(b);
      const slug = 'test-profile';
      expect(() => op(a, 'create', { device_id: workerB.id, profile_slug: slug })).toThrow('DEVICE_NOT_FOUND');
      expect(() => op(a, 'create', { device_id: workerA.id, profile_slug: 'https://example.invalid/test' })).toThrow('INVALID_INPUT');
      expect(() => op(b, 'create', { device_id: workerB.id, mode: 'login_check', profile_slug: slug })).toThrow('INVALID_INPUT');
      const stats = await queue(a, { device_id: workerA.id, profile_slug: slug });
      expect(() => op(b, 'get', {}, stats.id)).toThrow('ZHIHU_STATS_TASK_NOT_FOUND');
      await expect(workerB.client.claimZhihuStats()).resolves.toBeNull();
      const login = await queue(b, { device_id: workerB.id, mode: 'login_check' });

      const raw = Buffer.from('{}');
      const claimUrl = '/api/v1/device/zhihu-stats/claim';
      const sendClaim = (headers: Record<string, string>) => app.inject({ method: 'POST', url: claimUrl, payload: raw, headers });
      expect((await sendClaim(workerA.headers('claim', raw))).json()).toEqual({ error: { code: 'INVALID_DEVICE_PROOF' } });
      const proof = workerA.headers('zhihu.stats.claim', raw);
      const statsResponse = await sendClaim(proof);
      expect(statsResponse.statusCode).toBe(200);
      const statsClaim = statsResponse.json().data.claim;
      expect(statsClaim).toMatchObject({ id: stats.id, device_id: workerA.id, workspace_id: ctx.workspaceId, profile_slug: slug });
      expect((await sendClaim(proof)).json()).toEqual({ error: { code: 'DEVICE_PROOF_REPLAYED' } });
      const loginClaim = (await workerB.client.claimZhihuStats())!;
      expect(loginClaim).toMatchObject({ id: login.id, device_id: workerB.id, mode: 'login_check' });
      expect(loginClaim).not.toHaveProperty('profile_slug');
      await expect(workerA.client.claimZhihuStats()).resolves.toBeNull();

      const counts = { status: 'completed', profile_slug: slug, followers_text: '1.2 万', upvotes_text: '获得\n3,456 次赞同' } as const;
      const statsReport = { id: stats.id, fencing_token: statsClaim.fencing_token, result: counts };
      const loginReport = { id: login.id, fencing_token: loginClaim.fencing_token, result: { status: 'blocked', reason: 'login_required' } as const };
      await expect(workerB.client.reportZhihuStats(statsReport)).rejects.toMatchObject({ status: 403 });
      await expect(workerA.client.reportZhihuStats({ ...statsReport, fencing_token: statsReport.fencing_token + 1 })).rejects.toMatchObject({ status: 409 });
      await expect(workerA.client.reportZhihuStats({ ...statsReport, result: { ...counts, profile_slug: 'other-profile' } })).rejects.toMatchObject({ status: 422 });
      const badCounts = { ...counts, followers_text: 'not a count' };
      await expect(workerA.client.reportZhihuStats({ ...statsReport, result: badCounts })).rejects.toMatchObject({ status: 422 });
      const extraFields = { ...counts, cookies: 'synthetic-extra-value' };
      await expect(workerA.client.reportZhihuStats({ ...statsReport, result: extraFields })).rejects.toMatchObject({ status: 422 });
      await expect(workerB.client.reportZhihuStats({ ...loginReport, result: counts })).rejects.toMatchObject({ status: 422 });
      await expect(workerA.client.reportZhihuStats(statsReport)).resolves.toEqual({ id: stats.id, status: 'completed' });
      await expect(workerB.client.reportZhihuStats(loginReport)).resolves.toEqual({ id: login.id, status: 'blocked' });
      const completed = await op(a, 'get', {}, stats.id);
      expect(completed).toMatchObject({ status: 'completed', result: counts });
      expect(completed).not.toHaveProperty('fencing_token');
      expect(await op(a, 'incidents_list')).toEqual([]);
      expect(await op(b, 'incidents_list')).toEqual([{ id: login.id, workspace_id: ctx.workspaceId, device_id: workerB.id,
        mode: 'login_check', status: 'blocked', result: loginReport.result, reported_at: ctx.now }]);

      const reportedAt = ctx.now;
      ctx.now = new Date(Date.parse(ctx.now) + 1_000).toISOString();
      await expect(workerB.client.reportZhihuStats(loginReport)).resolves.toEqual({ id: login.id, status: 'blocked' });
      expect(await op(b, 'get', {}, login.id)).toHaveProperty('reported_at', reportedAt);
      await expect(workerB.client.reportZhihuStats({ ...loginReport, result: { status: 'completed' } })).rejects.toMatchObject({ status: 409 });
      const stale = await queue(a, { device_id: workerA.id, profile_slug: slug });
      const staleClaim = (await workerA.client.claimZhihuStats())!;
      ctx.now = staleClaim.lease_expires_at;
      expect(await op(a, 'get', {}, stale.id)).toHaveProperty('status', 'expired');
      await expect(workerA.client.reportZhihuStats({ ...statsReport, id: stale.id, fencing_token: staleClaim.fencing_token })).rejects.toMatchObject({ status: 409 });
      await expect(workerA.client.claimZhihuStats()).resolves.toBeNull();
      const positive = await queue(b, { device_id: workerB.id, mode: 'login_check' });
      const positiveClaim = (await workerB.client.claimZhihuStats())!;
      await expect(workerB.client.reportZhihuStats({ id: positive.id, fencing_token: positiveClaim.fencing_token, result: { status: 'completed' } }))
        .resolves.toEqual({ id: positive.id, status: 'completed' });
      expect(await op(b, 'get', {}, positive.id)).toHaveProperty('result', { status: 'completed' });
      expect(await op(b, 'incidents_list')).toHaveLength(1);
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
    expect(signed('heartbeat', { client_version: 'fixture-v1', include_bindings: true })()).toEqual({
      status: 'online', bindings: { social: { douyin: 1 }, commerce: {} },
    });
    if (scenario === 'report') {
      const other = ctx.create('social_account', { provider: 'douyin', status: 'active', external_account_id: 'other-account' });
      const otherBinding = ctx.create('account_execution_binding', { social_account_id: other.id, device_id: 'another-device', mode: 'connector', connector_channel: 'browser' });
      ctx.create('browser_session', { binding_id: otherBinding.id, device_id: 'another-device', social_account_id: other.id, status: 'pending_identity' });
      const heartbeat = () => signed('heartbeat', { client_version: 'fixture-v1', include_bindings: true, include_browser_work: true })();
      expect(heartbeat()).toEqual({ status: 'online', bindings: { social: { douyin: 1 }, commerce: {} }, browser_work: {
        pending_identity: [{ session_id: session.id, binding_id: binding.id, platform: 'douyin', identity: 'approved-identity' }],
      } });
      const proof = { session_id: session.id, pending_binding_id: binding.id, observed_platform_identity: 'approved-identity' };
      expect(signed('browser.identity', { ...proof, observed_platform_identity: 'other-account' })).toThrow('BROWSER_IDENTITY_RECHECK_STALE');
      expect(ctx.get('browser_session', session.id).status).toBe('pending_identity');
      expect(ctx.list('account_block')).toHaveLength(0);
      expect(signed('browser.identity', proof)()).toEqual({ status: 'verified' });
      expect(signed('browser.identity', proof)).toThrow('BROWSER_IDENTITY_RECHECK_STALE');
      expect(heartbeat()).toMatchObject({ browser_work: { pending_identity: [] } });
    } else {
      expect(signed('browser.identity', { session_id: session.id, observed_platform_identity: 'approved-identity' })()).toEqual({ status: 'verified' });
    }
    await call('enable_auto_mode', { ...config, terms_version: terms.version, risk_acknowledged: true }, account.id, services);
    const revision = { id: 'rev-1', title: 'Fixture', body: 'Text', tags: [], visibility: 'public', media: [{ id: 'media-1', sha256: 'a'.repeat(64) }] };
    const hash = frozenRevisionHash(revision);
    const tokens = { fencing_token: 4, write_slot_token: 12 };
    enqueueConnectorTask(ctx, { schema_version: 1, workspace_id: ctx.workspaceId, attempt_id: 'attempt-fixture', connector_device_id: device_id,
      account_id: account.id, binding_id: binding.id, platform_identity: 'approved-identity', kind: 'douyin.video.publish',
      target: { channel: 'browser', profile_id: session.id, app: 'douyin' }, payload: { revision, approval: { id: 'approval-1', resource_hash: hash }, frozen_hash: hash },
    }, { ...tokens, lease_expires_at: '2026-11-19T12:05:00.000Z' }, services);
    expect(signed('claim', { binding_id: 'wrong-binding' })()).toEqual({ claim: null });
    expect(signed('claim', { channel: 'mobile' })).toThrow('INVALID_DEVICE_BODY');
    const preflight = ctx.create('zhihu_stats_task', { device_id, owner_id: ctx.actorId, mode: 'login_check', status: 'queued' });
    expect(signed('zhihu.stats.claim', {})()).toMatchObject({ claim: { id: preflight.id } });
    expect(signed('claim', { channel: 'browser' })()).toEqual({ claim: null });
    expect(signed('catalog.claim', {})()).toEqual({ job: null });
    ctx.update('zhihu_stats_task', preflight.id, { lease_expires_at: ctx.now });
    const nextPreflight = ctx.create('zhihu_stats_task', { device_id, owner_id: ctx.actorId, mode: 'login_check', status: 'queued' });
    const catalog = ctx.create('worker_catalog_job', { device_id, status: 'claimed', expires_at: '2026-11-19T12:05:00.000Z' });
    expect(signed('claim', { channel: 'browser' })()).toEqual({ claim: null });
    expect(signed('zhihu.stats.claim', {})()).toEqual({ claim: null });
    ctx.update('worker_catalog_job', catalog.id, { status: 'previewed' });
    const mobile = ctx.create('connector_task', { device_id, status: 'queued', binding_id: 'other-binding', lease_expires_at: '2026-11-19T12:05:00.000Z', task: {
      schema_version: 1, workspace_id: ctx.workspaceId, attempt_id: 'mobile-attempt', connector_device_id: device_id,
      account_id: 'mobile-account', binding_id: 'other-binding', platform_identity: 'mobile-identity', kind: 'mobile.verify_app_identity',
      target: { channel: 'mobile', app: 'tiktok', mobile_device_id: 'phone' }, payload: {},
    } });
    expect(signed('claim', { binding_id: 'other-binding', channel: 'browser' })()).toEqual({ claim: null });
    expect(signed('claim', { channel: 'browser' })()).toMatchObject({ claim: { effective_mode: 'auto' } });
    expect(ctx.get('connector_task', mobile.id).status).toBe('queued');
    expect(signed('catalog.claim', {})()).toEqual({ job: null });
    expect(signed('zhihu.stats.claim', {})()).toEqual({ claim: null });
    expect(ctx.get('zhihu_stats_task', nextPreflight.id).status).toBe('queued');
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
