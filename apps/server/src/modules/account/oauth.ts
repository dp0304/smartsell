import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Context, Data, Row } from '@smartsell/contracts';
import type { Adapter, CapabilityReport, ConnectionCtx, ProviderKey, RawRequest, TokenSet } from '../../../../../packages/adapters/src/adapter-types.ts';
import { audit, fail, find, select, text, time } from './input.ts';

export interface AccountServices {
  adapter?: (provider: ProviderKey, appId?: string) => Adapter | undefined;
  oauthRedirectUri?: (provider: ProviderKey) => string;
  /** Read from a host key manager. Generic record APIs must exclude private AC kinds. */
  encryptionKey?: Uint8Array;
  directPostAudited?: (ctx: Context, connection: Row) => boolean;
  /** Ops/KMS verifies the app is assigned to this tenant and that fixed egress is allowlisted. */
  shopifyApp?: (ctx: Context, appId: string) => { shopDomain: string; egressVerified: boolean; oauthScopes: readonly string[] } | undefined;
}

export const providers = ['meta_instagram', 'meta_facebook', 'tiktok', 'tiktok_shop', 'youtube', 'douyin', 'xiaohongshu', 'shopify', 'shopee', 'lazada', 'amazon_sp', 'file_import'] as const;
export const storeProviders: readonly ProviderKey[] = ['tiktok_shop', 'shopify', 'amazon_sp', 'shopee', 'lazada'];
export const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const connectionFields = ['provider', 'purpose', 'status', 'scopes', 'brand_id', 'expires_at', 'last_verified_at', 'platform_app_id'];
export const publicConnection = (row: Row) => select(row, connectionFields);

export function invalidateConnectionCapabilities(ctx: Context, id: string, status: 'unverified' | 'needs_authorization') {
  for (const row of ctx.list('capability').filter(cap => cap.source === 'account_probe' && cap.connection_id === id)) {
    ctx.update('capability', row.id, { status, checked_at: ctx.now });
  }
}

function key(services: AccountServices) {
  if (services.encryptionKey?.byteLength !== 32) fail('PLATFORM_APP_NOT_READY');
  return services.encryptionKey;
}

function seal(ctx: Context, row: Row, services: AccountServices, payload: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(services), iv);
  cipher.setAAD(Buffer.from(JSON.stringify([ctx.tenantId, ctx.workspaceId, row.id, row.provider])));
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

function open<T>(ctx: Context, row: Row, services: AccountServices, ciphertext: unknown): T {
  try {
    const input = Buffer.from(String(ciphertext), 'base64url');
    const cipher = createDecipheriv('aes-256-gcm', key(services), input.subarray(0, 12));
    cipher.setAAD(Buffer.from(JSON.stringify([ctx.tenantId, ctx.workspaceId, row.id, row.provider])));
    cipher.setAuthTag(input.subarray(12, 28));
    return JSON.parse(Buffer.concat([cipher.update(input.subarray(28)), cipher.final()]).toString('utf8')) as T;
  } catch {
    return fail('CREDENTIAL_UNAVAILABLE');
  }
}

function getAdapter(services: AccountServices, provider: ProviderKey, appId?: string) {
  const adapter = services.adapter?.(provider, appId);
  if (!adapter || adapter.provider !== provider) fail('PLATFORM_APP_NOT_READY');
  return adapter;
}

function requireApp(ctx: Context, provider: ProviderKey, appId?: string) {
  if (!appId) return;
  const app = ctx.get('platform_app', appId);
  if (app.provider !== provider || app.status !== 'active') fail('PLATFORM_APP_NOT_READY');
}

function requireShopifyInstall(ctx: Context, services: AccountServices, appId: string | undefined, shopDomain: unknown) {
  const install = appId ? services.shopifyApp?.(ctx, appId) : undefined;
  if (!install?.egressVerified || typeof shopDomain !== 'string' || install.shopDomain !== shopDomain) fail('PLATFORM_APP_NOT_READY');
  return install;
}

function expiresAt(ctx: Context, tokens: TokenSet, fallback: unknown = null) {
  const seconds = tokens.expiresIn;
  if (seconds == null) return fallback;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 315_576_000) fail('INVALID_PLATFORM_EXPIRY');
  return new Date(time(ctx) + seconds * 1000).toISOString();
}

function scopeList(value: unknown): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 40) fail('INVALID_SCOPES', 422);
  return [...new Set(value.map(scope => text(scope, 128)))];
}

export function startOAuth(ctx: Context, body: Data, provider: ProviderKey, services: AccountServices) {
  key(services);
  const appId = body.platform_app_id == null ? undefined : text(body.platform_app_id);
  requireApp(ctx, provider, appId);
  const adapter = getAdapter(services, provider, appId);
  const redirectUri = services.oauthRedirectUri?.(provider);
  if (!adapter.oauth || !redirectUri || new URL(redirectUri).protocol !== 'https:') fail('PLATFORM_APP_NOT_READY');
  const brandId = text(body.brand_id);
  const shopDomain = body.shop_domain == null ? undefined : text(body.shop_domain);
  const shopify = provider === 'shopify' ? requireShopifyInstall(ctx, services, appId, shopDomain) : undefined;
  const reconnectId = body.reconnect_connection_id == null ? undefined : text(body.reconnect_connection_id);
  const reconnect = reconnectId ? ctx.get('connection', reconnectId) : undefined;
  if (reconnect && (reconnect.provider !== provider || reconnect.brand_id !== brandId || reconnect.platform_app_id !== appId || reconnect.shop_domain !== shopDomain)) fail('CONNECTION_MISMATCH');
  const scopes = scopeList(body.scopes ?? shopify?.oauthScopes);
  if (shopify && scopes.some(scope => !shopify.oauthScopes.includes(scope))) fail('PLATFORM_SCOPE_NOT_APPROVED', 422);
  const state = random();
  const verifier = random();
  const flow = ctx.create('oauth_flow', {
    provider, state_hash: digest(state), redirect_uri: redirectUri, brand_id: brandId, platform_app_id: appId,
    reconnect_connection_id: reconnectId, reconnect_version: reconnect?.version, requested_scopes: scopes, shop_domain: shopDomain, status: 'pending',
    expires_at: new Date(time(ctx) + 10 * 60_000).toISOString(), started_by: ctx.actorId,
  });
  ctx.update('oauth_flow', flow.id, { sealed_verifier: seal(ctx, flow, services, verifier) });
  let authorizeUrl: string;
  try {
    authorizeUrl = adapter.oauth.authorizationUrl({ state, redirectUri, scopes, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), shopDomain });
    if (new URL(authorizeUrl).protocol !== 'https:') fail('PLATFORM_APP_NOT_READY');
  } catch {
    return fail('PLATFORM_APP_NOT_READY');
  }
  return { authorize_url: authorizeUrl };
}

/** Global callback gateway resolves the scoped transaction by state hash and serializes each flow. */
export async function completeOAuth(ctx: Context, provider: ProviderKey, query: Readonly<Record<string, string>>, services: AccountServices) {
  const flow = find(ctx, 'oauth_flow', { provider, state_hash: digest(text(query.state)) });
  if (!flow || flow.status !== 'pending' || Date.parse(String(flow.expires_at)) <= time(ctx)) fail('OAUTH_STATE_INVALID', 400);
  const existing = flow.reconnect_connection_id ? ctx.get('connection', String(flow.reconnect_connection_id)) : undefined;
  if (existing && existing.version !== flow.reconnect_version) {
    ctx.update('oauth_flow', flow.id, { status: 'failed', sealed_verifier: null });
    return { status: 'failed', code: 'CONNECTION_CHANGED' };
  }
  const appId = flow.platform_app_id as string | undefined;
  const code = query.code ?? query.auth_code ?? query.spapi_oauth_code;
  const shopDomain = flow.shop_domain as string | undefined;
  const sellerId = query.selling_partner_id;
  let tokens: TokenSet;
  let probe: CapabilityReport;
  let expires: unknown;
  let scopes: string[];
  try {
    requireApp(ctx, provider, appId);
    const adapter = getAdapter(services, provider, appId);
    if (!adapter.oauth) fail('PLATFORM_APP_NOT_READY');
    if (provider === 'shopify') requireShopifyInstall(ctx, services, appId, shopDomain);
    const verifier = open<string>(ctx, flow, services, flow.sealed_verifier);
    tokens = await adapter.oauth.exchangeCode({ code: text(code, 4096), redirectUri: String(flow.redirect_uri), codeVerifier: verifier, shopDomain, sellerId, callbackQuery: query });
    expires = expiresAt(ctx, tokens);
    scopes = scopeList(tokens.scopes);
    probe = await adapter.probe({ accessToken: text(tokens.accessToken, 16384), externalAccountId: tokens.externalAccountId, scopes, shopDomain, sellerId });
  } catch {
    ctx.update('oauth_flow', flow.id, { status: 'failed', sealed_verifier: null });
    return { status: 'failed', code: 'OAUTH_EXCHANGE_FAILED' };
  }
  const accounts = probe.status === 'ready' ? probe.accounts ?? (probe.externalAccountId ? [{ externalAccountId: probe.externalAccountId }] : []) : [];
  if (!tokens.accessToken || !accounts.length) {
    ctx.update('oauth_flow', flow.id, { status: 'failed', sealed_verifier: null });
    return { status: 'failed', code: 'PLATFORM_IDENTITY_UNVERIFIED' };
  }
  const formerIds = existing ? (existing.discovered_accounts as { externalAccountId: string }[]).map(account => account.externalAccountId) : [];
  if (existing && (!formerIds.length || !formerIds.every(id => accounts.some(account => account.externalAccountId === id)))) {
    ctx.update('oauth_flow', flow.id, { status: 'failed', sealed_verifier: null });
    return { status: 'failed', code: 'PLATFORM_IDENTITY_MISMATCH' };
  }
  const values = {
    provider, status: 'active', purpose: storeProviders.includes(provider) ? 'store' : 'social', brand_id: flow.brand_id,
    platform_app_id: flow.platform_app_id, shop_domain: shopDomain, seller_id: sellerId,
    scopes, discovered_accounts: accounts, last_verified_at: ctx.now, expires_at: expires,
  };
  const connection = existing ? ctx.update('connection', existing.id, values) : ctx.create('connection', values);
  const updated = ctx.update('connection', connection.id, { sealed_token: seal(ctx, connection, services, tokens), revoked_at: null });
  if (existing) invalidateConnectionCapabilities(ctx, existing.id, 'unverified');
  ctx.update('oauth_flow', flow.id, { status: 'completed', sealed_verifier: null });
  audit(ctx, 'account.connection.authorized', { connection_id: updated.id, flow_id: flow.id, authorized_by: flow.started_by });
  ctx.emit('account.connection.authorized', { connection_id: updated.id, provider, purpose: updated.purpose });
  return { status: 'authorized', connection: publicConnection(updated) };
}

export function connectionContext(ctx: Context, connection: Row, services: AccountServices, externalId?: string): ConnectionCtx {
  if (connection.status !== 'active' || (connection.expires_at && !(Date.parse(String(connection.expires_at)) > time(ctx)))) fail('AUTH_EXPIRED');
  const appId = connection.platform_app_id as string | undefined;
  requireApp(ctx, connection.provider as ProviderKey, appId);
  const install = connection.provider === 'shopify' ? requireShopifyInstall(ctx, services, appId, connection.shop_domain) : undefined;
  const tokens = open<TokenSet>(ctx, connection, services, connection.sealed_token);
  const accounts = connection.discovered_accounts as NonNullable<CapabilityReport['accounts']>;
  const account = externalId ? accounts.find(item => item.externalAccountId === externalId) : accounts.length === 1 ? accounts[0] : undefined;
  if (!account) fail('PLATFORM_IDENTITY_UNVERIFIED');
  return { accessToken: tokens.accessToken, externalAccountId: account.externalAccountId,
    scopes: install ? tokens.scopes?.filter(scope => install.oauthScopes.includes(scope)) : tokens.scopes, shopDomain: connection.shop_domain as string | undefined,
    sellerId: connection.seller_id as string | undefined, directPostAudited: services.directPostAudited?.(ctx, connection) === true,
    shopCipher: account?.shopCipher, uploadsPlaylistId: account?.uploadsPlaylistId, pageTasks: account?.pageTasks };
}

/** Merchant-owned Shopify apps obtain and rotate an expiring token without a browser callback. */
export async function connectShopifyMerchant(ctx: Context, appId: string, brandId: string, services: AccountServices) {
  key(services);
  requireApp(ctx, 'shopify', appId);
  const app = ctx.get('platform_app', appId);
  const install = requireShopifyInstall(ctx, services, appId, app.shop_domain);
  const oauth = getAdapter(services, 'shopify', appId).oauth;
  if (app.distribution !== 'merchant_custom' || !oauth?.clientCredentials) {
    fail('PLATFORM_APP_NOT_READY');
  }
  const existing = find(ctx, 'connection', { provider: 'shopify', platform_app_id: appId, shop_domain: install.shopDomain });
  if (existing?.brand_id && existing.brand_id !== brandId) fail('CONNECTION_MISMATCH');
  let tokens: TokenSet;
  let values: Data;
  try {
    tokens = await oauth.clientCredentials({ shopDomain: install.shopDomain });
    const accessToken = text(tokens.accessToken, 16384);
    const probe = await getAdapter(services, 'shopify', appId).probe({ accessToken, scopes: tokens.scopes, shopDomain: install.shopDomain });
    const accounts = probe.accounts ?? (probe.externalAccountId ? [{ externalAccountId: probe.externalAccountId }] : []);
    const expires = expiresAt(ctx, tokens);
    if (!expires || probe.status !== 'ready' || accounts.length !== 1) fail('PLATFORM_IDENTITY_UNVERIFIED');
    const former = existing?.discovered_accounts as CapabilityReport['accounts'];
    if (former?.length && former[0].externalAccountId !== accounts[0].externalAccountId) fail('PLATFORM_IDENTITY_MISMATCH');
    values = { provider: 'shopify', purpose: 'store', status: 'active', brand_id: brandId, platform_app_id: appId,
      shop_domain: install.shopDomain, scopes: scopeList(tokens.scopes), discovered_accounts: accounts, last_verified_at: ctx.now, expires_at: expires };
  } catch {
    return fail('SHOPIFY_GRANT_UNVERIFIED', 409);
  }
  const row = existing ? ctx.update('connection', existing.id, values) : ctx.create('connection', values);
  const updated = ctx.update('connection', row.id, { sealed_token: seal(ctx, row, services, tokens), revoked_at: null });
  if (existing && (existing.status !== 'active' || JSON.stringify(existing.scopes) !== JSON.stringify(updated.scopes))) {
    invalidateConnectionCapabilities(ctx, row.id, 'unverified');
  }
  const event = existing?.status === 'active' ? 'account.connection.refreshed' : 'account.connection.authorized';
  audit(ctx, event, { connection_id: row.id });
  ctx.emit(event, { connection_id: row.id });
  return publicConnection(updated);
}

/** Trusted refresh worker; caller serializes AC writes for this connection across workers. */
export async function refreshConnection(ctx: Context, id: string, services: AccountServices) {
  const row = ctx.get('connection', id);
  if (row.status !== 'active') fail('CONNECTION_INACTIVE');
  requireApp(ctx, row.provider as ProviderKey, row.platform_app_id as string | undefined);
  const appId = row.platform_app_id as string | undefined;
  if (row.provider === 'shopify') {
    requireShopifyInstall(ctx, services, appId, row.shop_domain);
    if (appId && ctx.get('platform_app', appId).distribution === 'merchant_custom') return connectShopifyMerchant(ctx, appId, String(row.brand_id), services);
  }
  const tokens = open<TokenSet>(ctx, row, services, row.sealed_token);
  if (!tokens.refreshToken) fail('REAUTHORIZATION_REQUIRED');
  const adapter = getAdapter(services, row.provider as ProviderKey, row.platform_app_id as string | undefined);
  if (!adapter.oauth) fail('REAUTHORIZATION_REQUIRED');
  try {
    const next = await adapter.oauth.refresh({ refreshToken: tokens.refreshToken, shopDomain: row.shop_domain as string | undefined, sellerId: row.seller_id as string | undefined });
    text(next.accessToken, 16384);
    if (next.externalAccountId && tokens.externalAccountId && next.externalAccountId !== tokens.externalAccountId) {
      ctx.update('connection', id, { status: 'reauthorization_required', sealed_token: null });
      invalidateConnectionCapabilities(ctx, id, 'needs_authorization');
      ctx.emit('account.connection.expired', { connection_id: id, reason: 'identity_mismatch' });
      return { id, status: 'reauthorization_required' };
    }
    const renewed = { ...tokens, ...next, refreshToken: next.refreshToken ?? tokens.refreshToken, scopes: next.scopes ?? tokens.scopes };
    const updated = ctx.update('connection', id, { sealed_token: seal(ctx, row, services, renewed), scopes: scopeList(renewed.scopes),
      expires_at: expiresAt(ctx, next, row.expires_at) });
    if (JSON.stringify(row.scopes) !== JSON.stringify(updated.scopes)) invalidateConnectionCapabilities(ctx, id, 'unverified');
    ctx.emit('account.connection.refreshed', { connection_id: id });
    return publicConnection(updated);
  } catch (error) {
    const classified = adapter.classifyError(error);
    if (classified.errorClass === 'auth_expired' || classified.errorClass === 'permission_denied') {
      ctx.update('connection', id, { status: 'reauthorization_required', sealed_token: null });
      invalidateConnectionCapabilities(ctx, id, 'needs_authorization');
      ctx.emit('account.connection.expired', { connection_id: id });
      return { id, status: 'reauthorization_required' };
    }
    return fail('OAUTH_REFRESH_FAILED', 503);
  }
}

/** The verified event is a resync hint. Routing by external identity belongs to ingress. */
export function acceptWebhook(ctx: Context, provider: ProviderKey, appId: string | undefined, request: RawRequest, services: AccountServices) {
  requireApp(ctx, provider, appId);
  const adapter = getAdapter(services, provider, appId);
  const webhook = adapter.webhook;
  if (!webhook?.verify(request)) fail('WEBHOOK_SIGNATURE_INVALID', 401);
  const hash = digest(request.rawBody);
  if (find(ctx, 'webhook_receipt', { provider, app_id: appId, hash })) return { duplicate: true };
  const connections = ctx.list('connection').filter(row => row.provider === provider &&
    (row.platform_app_id ?? undefined) === appId && row.status === 'active');
  const events = webhook.parse(request).filter(event => {
    if (event.provider !== provider || event.action !== 'resync' || !event.accountId) return false;
    return connections.some(connection => {
      // Shopify signs the body only. Use the workspace-bound installation and its
      // per-shop secret to authenticate the endpoint, then check the header separately.
      if (provider === 'shopify') {
        const install = appId ? services.shopifyApp?.(ctx, appId) : undefined;
        return install?.egressVerified === true && install.shopDomain === event.accountId && connection.shop_domain === event.accountId;
      }
      const accounts = connection.discovered_accounts as CapabilityReport['accounts'];
      return accounts?.some(account => account.externalAccountId === event.accountId) === true;
    });
  });
  if (events.length) ctx.create('webhook_receipt', { provider, app_id: appId, hash });
  for (const event of events) ctx.emit('account.webhook.resync_requested', {
    provider, type: event.type, externalId: event.externalId, accountId: event.accountId, action: 'resync', app_id: appId,
  });
  return { accepted: events.length };
}
