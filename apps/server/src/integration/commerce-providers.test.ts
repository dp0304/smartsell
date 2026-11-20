import { kernelBackgroundStore } from '../runtime.js';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileStore } from '@smartsell/db';
import Fastify from 'fastify';
import { configuration } from '../config.js';
import { makeContext } from '../context.js';
import { createCommerceProviders, commerceRequestScope } from './commerce-providers.js';
import { operations as commerceOperations } from '../modules/commerce/index.js';

const config = configuration({ PUBLIC_ORIGIN: 'https://smartsell.example' });

function env(name: string, value: unknown, cleanup: (run: () => void) => void) {
  const original = process.env[name];
  process.env[name] = JSON.stringify(value);
  cleanup(() => {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
  });
}

test('store OAuth binds its fixed callback to one workspace and consumes state transactionally', async t => {
  env('SMARTSELL_COMMERCE_PROVIDER_CREDENTIALS', {
    tiktok_shop: { clientId: 'fixture', clientSecret: 'fixture-secret', tiktokShopAuthorizationUrl: 'https://services.tiktokshop.com/open/authorize?service_id=fixture' },
  }, run => t.after(run));
  const dir = await mkdtemp(join(tmpdir(), 'smartsell-commerce-'));
  const store = await fileStore(join(dir, 'state.sqlite'));
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const scope = { tenantId: randomUUID(), workspaceId: randomUUID(), actorId: randomUUID() };
  const shopDomain = 'partner-fixture.myshopify.com';
  const appId = await store.transaction({}, async tx => makeContext(await tx.workspace(scope), scope, 'owner').create('platform_app', {
    provider: 'shopify', distribution: 'partner_custom_distribution', status: 'active', shop_domain: shopDomain,
  }).id);
  env('SMARTSELL_SHOPIFY_APPS', [{ ...scope, appId, shopDomain, egressVerified: true, oauthScopes: ['read_products'], clientId: 'fixture', clientSecret: 'partner-secret', shopifyAuthMode: 'custom_distribution' }], run => t.after(run));
  const requests: string[] = [];
  const host = createCommerceProviders(config, async request => {
    const url = new URL(request.url);
    requests.push(url.hostname);
    if (url.hostname === 'auth.tiktok-shops.com') return { status: 200, body: { code: 0, data: { access_token: 'test-token' } } };
    if (url.hostname === shopDomain) {
      const body = url.pathname.endsWith('access_token')
        ? { access_token: 'shopify-token', scope: 'read_products', expires_in: 3600 }
        : { data: { shop: { id: 'gid://shopify/Shop/1', myshopifyDomain: shopDomain } } };
      return { status: 200, body };
    }
    return { status: 200, body: { code: 0, data: { shops: [{ id: 'shop-test', cipher: 'test-cipher' }] } } };
  });
  host.mountOAuthCallback(app, kernelBackgroundStore(store));
  const unbound = commerceOperations.find(op => op.name === 'commerce_store_create')!;
  const operation = host.bindOperation({ ...unbound, module: 'commerce', mcp: false });
  assert.equal(operation.mcp, false);
  const { shopifyUrl, tiktokUrl } = await store.transaction({ identityWrite: true }, async tx => {
    tx.identity.put(`tenant/${scope.tenantId}`, { status: 'active' });
    tx.identity.put(`workspace/${scope.workspaceId}`, { id: scope.workspaceId, tenantId: scope.tenantId });
    tx.identity.put(`member/${scope.actorId}/${scope.workspaceId}`, { userId: scope.actorId, workspaceId: scope.workspaceId, role: 'owner' });
    const ctx = Object.assign(makeContext(await tx.workspace(scope), scope, 'owner'), {
      agentCredentialId: undefined,
      isActiveWorkspaceMember: (id: string) => id === scope.actorId,
    });
    const brand = ctx.create('brand', { name: 'Test brand' });
    const start = async (provider: string, fields = {}) => await operation.run(ctx, { params: {}, query: {}, body: {
      provider, name: 'Test shop', mode: 'authorize', brand_id: brand.id, default_currency: 'USD', default_locale: 'en-US', ...fields,
    } }) as { authorize_url: string };
    const tiktok = await start('tiktok_shop');
    const shopify = await start('shopify', { platform_app_id: appId });
    return { shopifyUrl: shopify.authorize_url, tiktokUrl: tiktok.authorize_url };
  });
  const state = new URL(tiktokUrl).searchParams.get('state')!;
  const callback = `/api/v1/oauth/callback/tiktok_shop?auth_code=fixture&state=${state}`;
  const changedWorkspace = callback.replace(scope.workspaceId, randomUUID());
  assert.equal((await app.inject(changedWorkspace)).statusCode, 400);
  assert.equal((await app.inject(`${callback}&state=${state}`)).statusCode, 400);
  assert.equal(requests.length, 0);
  const [first, second] = await Promise.all([app.inject(callback), app.inject(callback)]);
  assert.deepEqual([first.statusCode, second.statusCode].sort(), [200, 400]);
  const success = first.statusCode === 200 ? first : second;
  assert.deepEqual(success.json(), { data: { status: 'authorized' } });
  assert.equal(success.headers['referrer-policy'], 'no-referrer');
  assert.equal(success.headers.location, undefined);
  assert.deepEqual(requests, ['auth.tiktok-shops.com', 'open-api.tiktokglobalshop.com']);
  const shopifyAuthorize = new URL(shopifyUrl);
  assert.equal(shopifyAuthorize.hostname, shopDomain);
  assert.equal(shopifyAuthorize.pathname, '/admin/oauth/authorize');
  assert.equal(shopifyAuthorize.searchParams.get('redirect_uri'), 'https://smartsell.example/api/v1/oauth/callback/shopify');
  const shopifyQuery = new URLSearchParams({ code: 'shop-code', host: 'Zml4dHVyZQ==', shop: shopDomain, state: shopifyAuthorize.searchParams.get('state')! });
  const shopifyCallback = '/api/v1/oauth/callback/shopify';
  assert.equal((await app.inject(`${shopifyCallback}?${shopifyQuery}&hmac=${'0'.repeat(64)}`)).statusCode, 400);
  assert.equal(requests.length, 2);
  shopifyQuery.set('hmac', createHmac('sha256', 'partner-secret').update(shopifyQuery.toString()).digest('hex'));
  assert.equal((await app.inject(`${shopifyCallback}?${shopifyQuery}`)).statusCode, 200);
  assert.deepEqual(requests.slice(2), [shopDomain, shopDomain]);
  await store.transaction({ readOnly: true }, async tx => {
    const ctx = makeContext(await tx.workspace(scope), scope, 'owner');
    const connections = ctx.list('connection');
    assert.equal(connections.length, 2);
    assert.ok(connections.every(connection => connection.status === 'active' && connection.sealed_token && !String(connection.sealed_token).includes('token')));
    assert.ok(ctx.list('oauth_flow').every(flow => flow.sealed_verifier === null));
  });
});

test('merchant Shopify app is tenant-bound, has a fixed host, and requires an approved grant', async t => {
  const scope = { tenantId: randomUUID(), workspaceId: randomUUID(), actorId: randomUUID() };
  const appId = randomUUID();
  const shopDomain = 'fixture.myshopify.com';
  env('SMARTSELL_SHOPIFY_APPS', [{ ...scope, appId, shopDomain, egressVerified: true, oauthScopes: ['read_products'], clientId: 'fixture', clientSecret: 'test-secret' }], run => t.after(run));
  let grant = 'write_products';
  let count = 0;
  const { account } = createCommerceProviders(config, async request => {
    count++;
    assert.equal(request.url, `https://${shopDomain}/admin/oauth/access_token`);
    return { status: 200, body: { access_token: 'test-token', expires_in: 3600, scope: grant } };
  });
  const ctx = { ...scope, list: () => [{ id: appId, provider: 'shopify', distribution: 'merchant_custom', shop_domain: shopDomain }] } as unknown as Parameters<NonNullable<typeof account.shopifyApp>>[0];
  assert.equal(account.shopifyApp?.(ctx, appId)?.egressVerified, true);
  assert.equal(account.shopifyApp?.({ ...ctx, tenantId: randomUUID() }, appId), undefined);
  assert.equal(account.shopifyApp?.({ ...ctx, workspaceId: randomUUID() }, appId), undefined);
  const oauth = account.adapter?.('shopify', appId)?.oauth;
  await assert.rejects(oauth!.clientCredentials!({ shopDomain: 'other.myshopify.com' }), /not_sent/);
  assert.equal(count, 0);
  await assert.rejects(oauth!.clientCredentials!({ shopDomain }), /shopify_grant_scope_not_approved/);
  grant = 'read_products';
  const requestScope = { requests: 0, signal: AbortSignal.timeout(2000) };
  const tokens = await commerceRequestScope.run(requestScope, () => oauth!.clientCredentials!({ shopDomain }));
  assert.deepEqual(tokens.scopes, ['read_products']);
  assert.equal(requestScope.requests, 1);
  const cancelled = { requests: 0, signal: AbortSignal.abort() };
  await assert.rejects(commerceRequestScope.run(cancelled, () => oauth!.clientCredentials!({ shopDomain })), /not_sent/);
  assert.equal(cancelled.requests, 0);
});
