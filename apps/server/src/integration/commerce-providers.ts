import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ADMIN, Problem, type Context, type Data } from '@smartsell/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AdapterError, createAdapter, TransportError, verifyShopifyCallback, type Adapter, type Credentials, type ProviderKey, type TokenSet, type Transport } from '../../../../packages/adapters/src/official.ts';
import type { Config } from '../config.js';
import { makeContext } from '../context.js';
import type { Membership } from '../identity.js';
import type { BackgroundStore } from '../runtime.js';
import { createOperations, type Services as AccountOperationServices } from '../modules/account/index.js';
import { acceptWebhook, completeOAuth, digest, storeProviders, type AccountServices } from '../modules/account/oauth.js';
import { accountWorkspaceSchedule } from '../modules/account/workspace-maintenance.js';
import { publishDevicePolicy } from './publish-host.js';
import { createCommerceOperations, type CommerceServices } from '../modules/commerce/index.js';
import { bindPromotionReadback } from '../modules/commerce/promotion-readback.js';
import { platformScheduleOperation } from '../modules/planning/schedule-reconciliation.js';
import type { Registered } from '../operations.js';

const providerHosts = {
  meta_instagram: ['api.instagram.com', 'graph.instagram.com'],
  meta_facebook: ['graph.facebook.com'],
  tiktok: ['open.tiktokapis.com'],
  tiktok_shop: ['auth.tiktok-shops.com', 'open-api.tiktokglobalshop.com'],
  youtube: ['oauth2.googleapis.com', 'www.googleapis.com'],
  douyin: ['open.douyin.com'],
  amazon_sp: ['api.amazon.com', 'sellingpartnerapi-na.amazon.com', 'sellingpartnerapi-eu.amazon.com', 'sellingpartnerapi-fe.amazon.com'],
} as const;
type FixedProvider = keyof typeof providerHosts;
const shopDomainPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const callbackPath = '/api/v1/oauth/callback/';
const shopifyWebhookPath = '/api/v1/webhooks/commerce/shopify/';
const flowLifetimeMs = 10 * 60_000;

export function isCommerceOAuthCallback(request: Pick<FastifyRequest, 'method' | 'url'>): boolean {
  return request.method === 'GET' && /^\/api\/v1\/oauth\/callback\/[a-z_]+\/?(?:\?|$)/.test(request.url);
}

export function isShopifyWebhook(request: Pick<FastifyRequest, 'method' | 'url'>): boolean {
  return request.method === 'POST' && request.url.startsWith(shopifyWebhookPath) &&
    uuidPattern.test(request.url.slice(shopifyWebhookPath.length));
}

export const commerceRequestScope = new AsyncLocalStorage<{ signal: AbortSignal; requests: number }>();
const maxResponseBytes = 16 * 1024 * 1024;
const httpsTransport: Transport = async request => {
  const requestTimeout = AbortSignal.timeout(10_000);
  const jobSignal = commerceRequestScope.getStore()?.signal;
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: typeof request.body === 'string' ? request.body : request.body && new Uint8Array(request.body),
      redirect: 'manual',
      signal: jobSignal ? AbortSignal.any([jobSignal, requestTimeout]) : requestTimeout,
    });
    const result = { status: response.status, headers: Object.fromEntries(response.headers.entries()) };
    if (!response.body || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      return result;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxResponseBytes) {
        await reader.cancel();
        throw new TransportError('possibly_sent');
      }
      chunks.push(chunk.value);
    }
    let body: unknown;
    if (size) {
      try { body = JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
      catch { /* Preserve status and headers for empty or non-JSON provider responses. */ }
    }
    return { ...result, body };
  } catch {
    throw new TransportError('possibly_sent');
  }
};

function fixedTransport(hosts: readonly string[], send: Transport): Transport {
  return async request => {
    let url: URL;
    try { url = new URL(request.url); }
    catch { throw new TransportError('not_sent'); }
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !hosts.includes(url.hostname)) {
      throw new TransportError('not_sent');
    }
    const scope = commerceRequestScope.getStore();
    if (scope?.signal.aborted) throw new TransportError('not_sent');
    if (scope) scope.requests++;
    return send({ ...request, url: url.href });
  };
}

interface ConfiguredProvider extends Credentials { oauthScopes?: string[] }
interface ShopifyInstall {
  tenantId: string;
  workspaceId: string;
  appId: string;
  shopDomain: string;
  egressVerified: boolean;
  oauthScopes: string[];
  credentials: Credentials;
}

function envJSON(name: string, fallback: unknown): unknown {
  const value = process.env[name];
  if (!value) return fallback;
  try { return JSON.parse(value); }
  catch { throw new Error(`Invalid ${name} JSON`); }
}
const isObject = (value: unknown): value is Data => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const isUuid = (value: unknown): value is string => typeof value === 'string' && uuidPattern.test(value);
const isScopeList = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 40 &&
  value.every(scope => isText(scope) && scope.length <= 128 && !/[\s,]/.test(scope));

function readProviders(): Map<FixedProvider, ConfiguredProvider> {
  const name = 'SMARTSELL_COMMERCE_PROVIDER_CREDENTIALS';
  const input = envJSON(name, {});
  if (!isObject(input)) throw new Error(`Invalid ${name}`);
  const result = new Map<FixedProvider, ConfiguredProvider>();
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(providerHosts, key) || !isObject(value) || !isText(value.clientId) || !isText(value.clientSecret) ||
      (value.oauthScopes !== undefined && !isScopeList(value.oauthScopes))) throw new Error(`Invalid ${name} provider entry`);
    const provider = key as FixedProvider;
    if (provider === 'amazon_sp' && (!isText(value.amazonRegion) || !['na', 'eu', 'fe'].includes(value.amazonRegion) ||
      !isText(value.amazonMarketplaceId) || !isText(value.amazonLwaClientId))) throw new Error(`Invalid ${name} Amazon credentials`);
    if (provider === 'tiktok_shop' && !isText(value.tiktokShopAuthorizationUrl)) throw new Error(`Invalid ${name} TikTok Shop authorization URL`);
    if (provider === 'meta_facebook' && !isText(value.facebookConfigId)) throw new Error(`Invalid ${name} Facebook config ID`);
    result.set(provider, value as unknown as ConfiguredProvider);
  }
  return result;
}

function readShopifyInstalls(): Map<string, ShopifyInstall> {
  const name = 'SMARTSELL_SHOPIFY_APPS';
  const input = envJSON(name, []);
  if (!Array.isArray(input)) throw new Error(`Invalid ${name}`);
  const result = new Map<string, ShopifyInstall>();
  for (const entry of input) {
    if (!isObject(entry) || !isUuid(entry.tenantId) || !isUuid(entry.workspaceId) || !isUuid(entry.appId) ||
      !isText(entry.shopDomain) || !shopDomainPattern.test(entry.shopDomain) || typeof entry.egressVerified !== 'boolean' ||
      !isScopeList(entry.oauthScopes) || !isText(entry.clientId) || !isText(entry.clientSecret) || result.has(entry.appId)) {
      throw new Error(`Invalid ${name} Shopify app entry`);
    }
    const { appId, tenantId, workspaceId, shopDomain, egressVerified, oauthScopes, clientId, clientSecret } = entry;
    if (!oauthScopes.length || oauthScopes.some(scope => !/^read_[a-z_]+$/.test(scope) || /buyer|recipient|restricted/.test(scope))) {
      throw new Error(`Invalid ${name} read-only OAuth scopes`);
    }
    const shopifyAuthMode = entry.shopifyAuthMode ?? 'client_credentials';
    if (shopifyAuthMode !== 'client_credentials' && shopifyAuthMode !== 'custom_distribution') throw new Error(`Invalid ${name} auth mode`);
    result.set(appId, {
      appId, tenantId, workspaceId, shopDomain, egressVerified, oauthScopes,
      credentials: { clientId, clientSecret, shopifyAuthMode },
    });
  }
  return result;
}

const invalidState = () => new Problem(400, 'OAUTH_STATE_INVALID', 'OAuth state is invalid or has expired');
const humanSession = (ctx: Context) => {
  const session = ctx as Context & { agentCredentialId?: string; isActiveWorkspaceMember?: (id: string) => boolean };
  return Object.hasOwn(ctx, 'agentCredentialId') && session.agentCredentialId === undefined &&
    session.isActiveWorkspaceMember?.(ctx.actorId) === true;
};

export type AccountConnectorServices = Pick<AccountOperationServices, 'terms' | 'connectorConfigured' | 'platformLimits'>;

export function createCommerceProviders(config: Config, testTransport?: Transport, connector?: AccountConnectorServices) {
  const configured = readProviders();
  const shopifyInstalls = readShopifyInstalls();
  const key = process.env.SMARTSELL_COMMERCE_ENCRYPTION_KEY;
  if (key !== undefined && !/^[0-9a-f]{64}$/i.test(key)) throw new Error('SMARTSELL_COMMERCE_ENCRYPTION_KEY must be a 32-byte hex key');
  const encryptionKey = key ? Buffer.from(key, 'hex') : createHmac('sha256', config.secret).update('smartsell/commerce-credentials/v1').digest();
  const stateKey = createHmac('sha256', config.secret).update('smartsell/commerce-oauth-state/v1').digest();
  const signature = (provider: ProviderKey, value: string) => createHmac('sha256', stateKey).update(`${provider}/${value}`).digest('base64url');
  const phaseValue = (process.env.SMARTSELL_COMMERCE_PHASE ?? 'P2').toUpperCase();
  if (phaseValue !== 'P0A' && phaseValue !== 'P0B' && phaseValue !== 'P1' && phaseValue !== 'P2') throw new Error('Invalid SMARTSELL_COMMERCE_PHASE');
  const phase = phaseValue === 'P0A' ? 'P0a' : phaseValue === 'P0B' ? 'P0b' : phaseValue;
  const send = !config.production && testTransport ? testTransport : httpsTransport;
  const byProvider = new Map<ProviderKey, Adapter>();
  for (const [provider, credentials] of configured) {
    byProvider.set(provider, createAdapter(provider, { credentials, phase, transport: fixedTransport(providerHosts[provider], send) }));
  }
  const byShopifyApp = new Map<string, Adapter>();
  for (const install of shopifyInstalls.values()) {
    if (!install.egressVerified) continue;
    const adapter = createAdapter('shopify', {
      credentials: install.credentials, phase, transport: fixedTransport([install.shopDomain], send),
    });
    const oauth = adapter.oauth!;
    const checkGrant = (tokens: TokenSet) => {
      if (!tokens.scopes?.length || tokens.scopes.some(scope => !install.oauthScopes.includes(scope))) {
        throw new AdapterError('permission_denied', 'shopify_grant_scope_not_approved');
      }
      return tokens;
    };
    adapter.oauth = {
      authorizationUrl: oauth.authorizationUrl,
      exchangeCode: async input => checkGrant(await oauth.exchangeCode(input)),
      refresh: async input => checkGrant(await oauth.refresh(input)),
      clientCredentials: install.credentials.shopifyAuthMode === 'client_credentials'
        ? async input => checkGrant(await oauth.clientCredentials!(input)) : undefined,
    };
    byShopifyApp.set(install.appId, adapter);
  }
  const account: AccountServices = {
    adapter: (provider, appId) => provider === 'shopify' ? (appId ? byShopifyApp.get(appId) : undefined) : byProvider.get(provider),
    oauthRedirectUri: provider => new URL(`${callbackPath}${provider}`, config.origin).href,
    encryptionKey,
    shopifyApp(ctx, appId) {
      const install = shopifyInstalls.get(appId);
      if (!install || install.tenantId !== ctx.tenantId || install.workspaceId !== ctx.workspaceId) return;
      const app = ctx.list('platform_app').find(row => row.id === appId);
      const distribution = install.credentials.shopifyAuthMode === 'client_credentials' ? 'merchant_custom' : 'partner_custom_distribution';
      if (app?.provider !== 'shopify' || app.shop_domain !== install.shopDomain || app.distribution !== distribution) return;
      return { shopDomain: install.shopDomain, egressVerified: install.egressVerified, oauthScopes: [...install.oauthScopes] };
    },
  };
  const connectorPolicy = connector ?? publishDevicePolicy(process.env.SMARTSELL_CONNECTOR_APPROVALS, process.env.SMARTSELL_CONNECTOR_TERMS);
  const accountSchedule = accountWorkspaceSchedule(account, () => connectorPolicy.terms?.());
  const accountOps = new Map(createOperations({ ...account, ...connectorPolicy, humanSession, privateDeployment: config.identityDeployment === 'private' }).map(op => [op.name, op]));
  const commerceOps = new WeakMap<CommerceServices, Map<string, ReturnType<typeof createCommerceOperations>[number]>>();
  const defaultServices: CommerceServices = {};
  const readPromotion = bindPromotionReadback(account);

  function bindOperation(op: Registered, services: CommerceServices = defaultServices): Registered {
    if (op.module === 'planning' && op.name === platformScheduleOperation) {
      return { ...op, run: (ctx, input) => op.run(Object.assign(ctx, { planningAccountServices: account }), input) };
    }
    let owning;
    if (op.module === 'account') owning = accountOps.get(op.name);
    if (op.module === 'commerce') {
      let registered = commerceOps.get(services);
      if (!registered) {
        registered = new Map(createCommerceOperations({ readPromotion, ...services, account }).map(item => [item.name, item]));
        commerceOps.set(services, registered);
      }
      owning = registered.get(op.name);
    }
    if (!owning) return op;
    const { run, external } = owning;
    const accountStart = op.name === 'account_start_oauth';
    const commerceStart = op.name === 'commerce_store_connect' || op.name === 'commerce_store_create';
    if (!accountStart && !commerceStart) return { ...op, run, ...(external === undefined ? {} : { external }) };
    return { ...op, async run(ctx, input) {
      const mayStart = accountStart || (!input.body.connection_id && (op.name !== 'commerce_store_create' || input.body.mode === 'authorize'));
      if (!mayStart) return run(ctx, input);
      if (!humanSession(ctx)) throw new Problem(403, 'HUMAN_SESSION_REQUIRED', 'A workspace session is required');
      if (accountStart && typeof input.body.brand_id === 'string' && input.body.brand_id.trim()) ctx.get('brand', input.body.brand_id.trim());
      const provider = (op.name === 'commerce_store_connect' ? ctx.get('store', input.params.id!).provider : input.body.provider) as ProviderKey;
      const appId = input.body.platform_app_id;
      const install = provider === 'shopify' && typeof appId === 'string' ? account.shopifyApp?.(ctx, appId) : undefined;
      const scopes = install?.oauthScopes ?? configured.get(provider as FixedProvider)?.oauthScopes;
      if (scopes && Array.isArray(input.body.scopes) && input.body.scopes.some(scope => !scopes.includes(scope as string))) {
        throw new Problem(422, 'PLATFORM_SCOPE_NOT_APPROVED', 'A requested scope is unavailable for this app');
      }
      const body = { ...input.body };
      if (scopes && body.scopes == null) body.scopes = [...scopes];
      if (install && body.shop_domain == null) body.shop_domain = install.shopDomain;
      const result = await run(ctx, { ...input, body });
      if (!isObject(result) || typeof result.authorize_url !== 'string') return result;
      // Add authenticated workspace routing to the opaque provider state. Store the hash of the
      // exact state the provider receives so all callback checks (including Shopify HMAC) see it unchanged.
      const url = new URL(result.authorize_url);
      const nonce = url.searchParams.get('state');
      if (!nonce || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw invalidState();
      const flow = ctx.list('oauth_flow').find(row => row.provider === provider && row.state_hash === digest(nonce));
      if (!flow) throw invalidState();
      const expires = Date.parse(ctx.now) + flowLifetimeMs;
      const routing = `${ctx.workspaceId}.${expires}.${nonce}`;
      const state = `${routing}.${signature(provider, routing)}`;
      ctx.update('oauth_flow', flow.id, { state_hash: digest(state) });
      url.searchParams.set('state', state);
      return { ...result, authorize_url: url.href };
    } };
  }

  function mountOAuthCallback(app: FastifyInstance, store: BackgroundStore) {
    app.get<{ Params: { provider: string } }>(`${callbackPath}:provider`, { exposeHeadRoute: false }, async (request, reply) => {
      reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer');
      const provider = request.params.provider as ProviderKey;
      if (provider !== 'shopify' && !byProvider.has(provider)) throw invalidState();
      if (provider === 'shopify' && !byShopifyApp.size) throw invalidState();
      const query: Record<string, string> = Object.create(null);
      const queryStart = request.url.indexOf('?');
      if (queryStart < 0 || request.url.length - queryStart > 8192) throw invalidState();
      for (const [name, value] of new URLSearchParams(request.url.slice(queryStart + 1))) {
        if (Object.hasOwn(query, name)) throw invalidState();
        query[name] = value;
      }
      const parts = (query.state ?? '').split('.');
      const [workspaceId, expires, nonce, mac] = parts;
      if (parts.length !== 4 || !isUuid(workspaceId) || !/^\d{13}$/.test(expires ?? '') || Number(expires) <= Date.now() ||
        !/^[A-Za-z0-9_-]{43}$/.test(nonce ?? '') || !/^[A-Za-z0-9_-]{43}$/.test(mac ?? '') ||
        !timingSafeEqual(Buffer.from(mac!), Buffer.from(signature(provider, parts.slice(0, 3).join('.'))))) throw invalidState();
      const workspace = (await store.workspaces()).find(row => row.id === workspaceId);
      if (!workspace) throw invalidState();
      const result = await store.transact(workspace, false, (records, scope, identity) => {
        const ctx = makeContext(records, scope, 'admin', request.id);
        const flow = ctx.list('oauth_flow').find(row => row.provider === provider && row.state_hash === digest(query.state!));
        if (flow?.status !== 'pending' || !(Date.parse(String(flow.expires_at)) > Date.parse(ctx.now)) || !isUuid(flow.started_by)) throw invalidState();
        const member = identity?.get<Membership>(`member/${flow.started_by}/${workspaceId}`);
        if (!member || !ADMIN.includes(member.role)) throw invalidState();
        if (storeProviders.includes(provider) && !ctx.list('brand').some(row => row.id === flow.brand_id)) throw invalidState();
        if (provider === 'shopify') {
          const install = typeof flow.platform_app_id === 'string' ? shopifyInstalls.get(flow.platform_app_id) : undefined;
          if (!install || query.shop !== install.shopDomain || !verifyShopifyCallback(query, install.credentials.clientSecret)) throw invalidState();
        }
        return completeOAuth(ctx, provider, query, account);
      });
      if (result.status !== 'authorized') reply.code(400);
      return { data: { status: result.status } };
    });
  }

  function mountShopifyWebhook(app: FastifyInstance, store: BackgroundStore) {
    if (!byShopifyApp.size) return;
    void app.register(async scope => {
      scope.removeContentTypeParser('application/json');
      scope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
      scope.post<{ Params: { appId: string }; Body: Buffer }>(`${shopifyWebhookPath}:appId`, { bodyLimit: 1024 * 1024 }, async request => {
        const install = shopifyInstalls.get(request.params.appId);
        const reject = () => new Problem(401, 'WEBHOOK_SIGNATURE_INVALID', 'Webhook signature is invalid');
        if (!install?.egressVerified || !Buffer.isBuffer(request.body)) throw reject();
        const headers = Object.fromEntries(Object.entries(request.headers).map(([key, value]) => [key, typeof value === 'string' ? value : undefined]));
        const payload = { headers, rawBody: request.body };
        const webhook = account.adapter?.('shopify', install.appId)?.webhook;
        if (headers['x-shopify-shop-domain'] !== install.shopDomain || !webhook?.verify(payload)) throw reject();
        const workspace = (await store.workspaces()).find(row => row.id === install.workspaceId && row.tenantId === install.tenantId);
        if (!workspace) throw reject();
        return store.transact(workspace, false, (records, workspaceScope) =>
          acceptWebhook(makeContext(records, workspaceScope, 'admin', request.id), 'shopify', install.appId, payload, account));
      });
    });
  }

  return { account, accountSchedule, bindOperation, mountOAuthCallback, mountShopifyWebhook };
}
