import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { makeContext } from '../../apps/server/src/context.ts';
import { createServer as createOperationsServer } from '../../apps/server/src/server.ts';
import { commerceRequestScope } from '../../apps/server/src/integration/commerce-providers.ts';
import { fileStore } from '../../packages/db/src/index.ts';

const host = '127.0.0.1';
const shopDomain = 'pc01-fixture.myshopify.com';
const externalStoreId = 'gid://shopify/Shop/101';
const accessToken = 'pc01-synthetic-read-only-token';

export async function commerceStoreOptions(config, discovered, fixture = 'catalog') {
  const promotionQuery = fixture === 'promotions' ? (await import('./commerce-promotion-fixture.mjs')).promotionProvider() : undefined;
  const scopes = promotionQuery ? ['read_products', 'read_orders', 'read_discounts'] : ['read_products'];
  const email = 'pc01-owner@example.invalid';
  const password = randomBytes(32).toString('hex');
  const store = await fileStore(config.kernelStatePath);
  const bootstrap = createOperationsServer({ ...discovered, store, config: { ...config, roles: new Set(['api']) } });
  let workspaceId;
  let tenantId;
  let appId;
  try {
    const setup = await bootstrap.inject({ method: 'POST', url: '/api/v1/setup',
      headers: { origin: config.origin, 'x-setup-token': config.setupToken },
      payload: { email, password, name: 'PC01 Owner', workspaceName: 'PC01 catalog sync' } });
    assert.equal(setup.statusCode, 201, setup.body);
    workspaceId = setup.json().data.workspaces[0].id;
    // Only operator-provisioned app configuration is seeded; authorization still runs through the real merchant endpoint.
    ({ tenantId, appId } = await store.transaction({}, async tx => {
      const { tenantId } = tx.identity.get(`workspace/${workspaceId}`);
      const scope = { workspaceId, tenantId, actorId: workspaceId };
      const ctx = makeContext(await tx.workspace(scope), scope, 'owner');
      const app = ctx.create('platform_app', { provider: 'shopify', status: 'active', distribution: 'merchant_custom', shop_domain: shopDomain });
      return { tenantId, appId: app.id };
    }));
  } finally { await bootstrap.close(); }
  process.env.SMARTSELL_SHOPIFY_APPS = JSON.stringify([{ tenantId, workspaceId, appId, shopDomain,
    egressVerified: true, oauthScopes: scopes, clientId: 'pc01-synthetic-client', clientSecret: 'pc01-synthetic-secret' }]);
  process.env.SMARTSELL_COMMERCE_PHASE = promotionQuery ? 'P1' : 'P0b';

  const calls = [];
  const inflight = [];
  const controlToken = randomBytes(32).toString('hex');
  const remote = createServer(async (req, reply) => {
    const path = req.url;
    function json(status, data) { reply.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data)); }
    try {
      if (path?.startsWith('/__pc01/')) {
        if (req.headers.authorization !== `Bearer ${controlToken}`) return json(403, {});
        if (req.method === 'GET' && path === '/__pc01/calls') return json(200, calls);
        if (req.method === 'POST' && ['/__pc01/succeed', '/__pc01/fail'].includes(path) && inflight.length) {
          inflight.shift()(path === '/__pc01/succeed');
          return json(200, {});
        }
        return json(409, {});
      }
      let raw = '';
      for await (const chunk of req) raw += chunk;
      assert.equal(req.method, 'POST');
      if (path === '/admin/oauth/access_token') {
        const params = req.headers['content-type']?.includes('json') ? JSON.parse(raw) : Object.fromEntries(new URLSearchParams(raw));
        assert.equal(params.grant_type, 'client_credentials');
        assert.equal(params.client_id, 'pc01-synthetic-client');
        assert.equal(params.client_secret, 'pc01-synthetic-secret');
        return json(200, { access_token: accessToken, scope: scopes.join(','), expires_in: 3600 });
      }
      assert.equal(req.headers['x-shopify-access-token'], accessToken);
      const { query, variables } = JSON.parse(raw);
      if (query.includes('ProbeShop')) return json(200, { data: { shop: { id: externalStoreId, myshopifyDomain: shopDomain } } });
      const promo = promotionQuery?.(query, variables);
      if (promo) return json(200, promo);
      assert.match(query, /\bproducts\s*\(/);
      assert.doesNotMatch(query, /inventoryQuantity|\borders\s*\(|\bmutation\b/);
      calls.push(variables.after ?? null);
      if (!await new Promise(resolve => inflight.push(resolve))) return json(422, { errors: [{ message: 'Synthetic catalog rejection' }] });
      return json(200, { data: { shop: { currencyCode: 'USD' }, products: {
        nodes: [{ id: 'gid://shopify/Product/101', handle: 'pc01-cup', title: 'Synced PC01 cup', status: 'ACTIVE',
          variants: { nodes: [{ id: 'gid://shopify/ProductVariant/102', sku: 'PC01-CUP', price: '10.00' }], pageInfo: { hasNextPage: false, endCursor: null } } }],
        pageInfo: { hasNextPage: false, endCursor: null },
      } } });
    } catch (error) { json(500, { errors: [{ message: error.message }] }); }
  });
  remote.listen(0, host);
  await once(remote, 'listening');
  const providerOrigin = `http://${host}:${remote.address().port}`;
  const testCommerceTransport = async request => {
    const url = new URL(request.url);
    assert.equal(url.origin, `https://${shopDomain}`);
    assert.match(url.pathname, /^\/admin\/(?:oauth\/access_token|api\/[^/]+\/graphql\.json)$/);
    const reply = await fetch(`${providerOrigin}${url.pathname}`, {
      method: request.method, headers: request.headers, body: request.body,
      redirect: 'error', signal: commerceRequestScope.getStore()?.signal,
    });
    return { status: reply.status, headers: Object.fromEntries(reply.headers), body: await reply.json() };
  };
  return {
    testCommerceTransport,
    browserFixture: { email, password, workspaceId, appId, externalStoreId, providerOrigin, controlToken },
    close() {
      inflight.splice(0).forEach(release => release(false));
      return new Promise(resolve => { remote.close(resolve); remote.closeAllConnections(); });
    },
  };
}
