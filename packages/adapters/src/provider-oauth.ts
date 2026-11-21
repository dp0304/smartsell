import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AdapterOptions, ExchangeInput, OAuth, ProviderKey, TokenSet } from './adapter-types.ts';
import { AdapterError, form, identifier, json, record, requireText, rows, secureUrl, shopHost, text, url, type Client } from './provider-http.ts';

const routes = {
  meta_instagram: ['https://www.instagram.com/oauth/authorize', 'https://api.instagram.com/oauth/access_token'],
  meta_facebook: ['https://www.facebook.com/v24.0/dialog/oauth', 'https://graph.facebook.com/v24.0/oauth/access_token'],
  tiktok: ['https://www.tiktok.com/v2/auth/authorize/', 'https://open.tiktokapis.com/v2/oauth/token/'],
  youtube: ['https://accounts.google.com/o/oauth2/v2/auth', 'https://oauth2.googleapis.com/token'],
  douyin: ['https://open.douyin.com/platform/oauth/connect/', 'https://open.douyin.com/oauth/access_token/'],
} as const;
export const amazonHost = (region = 'na') => `https://sellingpartnerapi-${region}.amazon.com`;
const lwa = 'https://api.amazon.com/auth/o2/token';
const shopAuth = 'https://auth.tiktok-shops.com/api/v2/token';
const amazonSellerOrigins = new Set(['https://sellercentral.amazon.com', 'https://sellercentral.amazon.co.uk', 'https://sellercentral.amazon.de', 'https://sellercentral.amazon.co.jp']);
function sellerCentral(input?: string) {
  const origin = input ?? 'https://sellercentral.amazon.com';
  if (!amazonSellerOrigins.has(origin)) throw new AdapterError('invalid_input', 'invalid_seller_central_origin');
  return origin;
}
export function verifyShopifyCallback(query: Readonly<Record<string, string>>, secret: string): boolean {
  if (!text(secret) || !/^[a-f\d]{64}$/i.test(query.hmac ?? '')) return false;
  const params = new URLSearchParams();
  for (const key of Object.keys(query).sort()) if (key !== 'hmac') params.append(key, query[key]);
  return timingSafeEqual(createHmac('sha256', secret).update(params.toString()).digest(), Buffer.from(query.hmac, 'hex'));
}
function tokens(value: unknown, fallbackRefresh?: string): TokenSet {
  const body = record(value);
  const first = Array.isArray(body.data) ? record(body.data[0]) : {};
  const data = { ...body, ...record(body.data), ...first };
  const accessToken = text(data.access_token);
  if (!accessToken) throw new AdapterError('platform_rejected', 'missing_access_token');
  const durations = data.expires_in ?? data.access_token_expire_in;
  const expiresIn = Number(durations);
  const scopes = Array.isArray(data.permissions) ? data.permissions.filter((item): item is string => typeof item === 'string') : text(data.scope)?.split(/[,\s]+/).filter(Boolean);
  return { accessToken, refreshToken: text(data.refresh_token) ?? fallbackRefresh, expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : undefined, scopes, externalAccountId: identifier(data.open_id ?? data.user_id) };
}

export function createOAuth(provider: ProviderKey, options: AdapterOptions, request: Client): OAuth | undefined {
  const route = Object.hasOwn(routes, provider) ? routes[provider as keyof typeof routes] : undefined;
  if (!route && !['shopify', 'tiktok_shop', 'amazon_sp'].includes(provider)) return undefined;
  const credentials = () => {
    const creds = options.credentials;
    if (!creds?.clientId || !creds.clientSecret) throw new AdapterError('unsupported', 'unconfigured');
    return creds;
  };
  const postForm = async (endpoint: string, params: Record<string, string | undefined>, fallbackRefresh?: string) => tokens((await request({ method: 'POST', url: endpoint, ...form(params) })).body, fallbackRefresh);
  const getToken = async (endpoint: string, params: Record<string, string | undefined>, fallbackRefresh?: string) => {
    const { body } = await request({ method: 'GET', url: url(endpoint, params), headers: {} });
    if (provider === 'tiktok_shop') {
      const envelope = record(body);
      if (identifier(envelope.code) !== '0') throw new AdapterError('platform_rejected', 'invalid_shop_token_response');
      return tokens(envelope.data, fallbackRefresh);
    }
    return tokens(body, fallbackRefresh);
  };
  const facebookExchange = async (endpoint: string, shortToken: string, clientId: string, clientSecret: string): Promise<TokenSet> => {
    const long = await getToken(endpoint, { client_id: clientId, client_secret: clientSecret, fb_exchange_token: shortToken, grant_type: 'fb_exchange_token' });
    const permissions = await request({ method: 'GET', url: 'https://graph.facebook.com/v24.0/me/permissions', headers: { authorization: `Bearer ${long.accessToken}` } });
    const scopes = rows(record(permissions.body).data).flatMap(entry => entry.status === 'granted' && typeof entry.permission === 'string' ? [entry.permission] : []);
    return { ...long, scopes };
  };
  function shopifyEndpoint(domain: string | undefined) { return `https://${shopHost(domain)}/admin/oauth/access_token`; }
  function assertShopifyCallback(input: ExchangeInput, secret: string) {
    if (options.credentials?.shopifyAuthMode === 'client_credentials') throw new AdapterError('unsupported', 'client_credentials_mode');
    if (!input.callbackQuery || input.callbackQuery.code !== input.code || input.callbackQuery.shop !== shopHost(input.shopDomain) || !verifyShopifyCallback(input.callbackQuery, secret)) {
      throw new AdapterError('permission_denied', 'invalid_shopify_callback');
    }
  }
  const oauth: OAuth = {
    authorizationUrl(input) {
      const creds = credentials();
      const state = requireText(input.state, 'state_required');
      const redirect_uri = secureUrl(input.redirectUri);
      if (!redirect_uri) throw new AdapterError('invalid_input', 'https_redirect_required');
      const scope = input.scopes.join(provider === 'youtube' ? ' ' : ',');
      const common = { client_id: creds.clientId, redirect_uri, state, scope, response_type: 'code' };
      if (provider === 'shopify') {
        if (creds.shopifyAuthMode === 'client_credentials') throw new AdapterError('unsupported', 'client_credentials_mode');
        return url(`https://${shopHost(input.shopDomain)}/admin/oauth/authorize`, { client_id: creds.clientId, redirect_uri, scope, state });
      }
      if (provider === 'amazon_sp') return url(`${sellerCentral(creds.amazonSellerCentralOrigin)}/apps/authorize/consent`, { application_id: creds.clientId, state, redirect_uri });
      if (provider === 'tiktok_shop') {
        const authorization = secureUrl(creds.tiktokShopAuthorizationUrl);
        if (!authorization || !['services.tiktokshop.com', 'services.us.tiktokshop.com', 'services.uk.tiktokshop.com'].includes(new URL(authorization).host)) throw new AdapterError('unsupported', 'unconfigured');
        return url(authorization, { state });
      }
      if (!route) throw new AdapterError('unsupported');
      if (provider === 'meta_facebook') {
        if (!creds.facebookConfigId) throw new AdapterError('unsupported', 'facebook_config_id_required');
        return url(route[0], { client_id: creds.clientId, config_id: creds.facebookConfigId, state, redirect_uri, response_type: 'code', override_default_response_type: true });
      }
      if (provider === 'meta_instagram') return url(route[0], { ...common, enable_fb_login: 0, force_authentication: 1 });
      if (provider === 'tiktok' || provider === 'douyin') return url(route[0], { client_key: creds.clientId, redirect_uri, scope, state, response_type: 'code' });
      return url(route[0], { ...common, access_type: 'offline', prompt: 'consent', code_challenge: input.codeChallenge, code_challenge_method: input.codeChallenge ? 'S256' : undefined });
    },
    async exchangeCode(input) {
      const creds = credentials();
      const code = requireText(input.code, 'code_required');
      const redirect_uri = secureUrl(input.redirectUri);
      if (!redirect_uri) throw new AdapterError('invalid_input', 'https_redirect_required');
      const common = { client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri, code, grant_type: 'authorization_code' };
      if (provider === 'shopify') {
        assertShopifyCallback(input, creds.clientSecret);
        return tokens((await request({ method: 'POST', url: shopifyEndpoint(input.shopDomain), ...json({ client_id: creds.clientId, client_secret: creds.clientSecret, code, expiring: 1 }) })).body);
      }
      if (provider === 'amazon_sp') {
        const lwaClientId = requireText(creds.amazonLwaClientId, 'amazon_lwa_client_id_required');
        return postForm(lwa, { ...common, client_id: lwaClientId });
      }
      if (provider === 'tiktok_shop') return getToken(`${shopAuth}/get`, { app_key: creds.clientId, app_secret: creds.clientSecret, auth_code: code, grant_type: 'authorized_code' });
      if (!route) throw new AdapterError('unsupported');
      if (provider === 'meta_facebook') {
        const short = await getToken(route[1], { client_id: creds.clientId, client_secret: creds.clientSecret, code, redirect_uri });
        return facebookExchange(route[1], short.accessToken, creds.clientId, creds.clientSecret);
      }
      if (provider === 'meta_instagram') {
        const short = await postForm(route[1], common);
        const long = await getToken('https://graph.instagram.com/access_token', { grant_type: 'ig_exchange_token', client_secret: creds.clientSecret, access_token: short.accessToken });
        return { ...long, refreshToken: long.accessToken, scopes: short.scopes, externalAccountId: short.externalAccountId };
      }
      if (provider === 'tiktok' || provider === 'douyin') return postForm(route[1], { client_key: creds.clientId, client_secret: creds.clientSecret, code, grant_type: 'authorization_code', redirect_uri: provider === 'tiktok' ? redirect_uri : undefined });
      return postForm(route[1], { ...common, code_verifier: input.codeVerifier });
    },
    async refresh(input) {
      const creds = credentials();
      const refresh_token = requireText(input.refreshToken, 'refresh_token_required');
      const common = { client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token, grant_type: 'refresh_token' };
      if (provider === 'shopify') {
        if (creds.shopifyAuthMode === 'client_credentials') throw new AdapterError('unsupported', 'client_credentials_mode');
        return tokens((await request({ method: 'POST', url: shopifyEndpoint(input.shopDomain), ...json(common) })).body, refresh_token);
      }
      if (provider === 'amazon_sp') return postForm(lwa, { ...common, client_id: requireText(creds.amazonLwaClientId, 'amazon_lwa_client_id_required') }, refresh_token);
      if (provider === 'tiktok_shop') return getToken(`${shopAuth}/refresh`, { app_key: creds.clientId, app_secret: creds.clientSecret, refresh_token, grant_type: 'refresh_token' }, refresh_token);
      if (!route) throw new AdapterError('unsupported');
      if (provider === 'meta_instagram') {
        const long = await getToken('https://graph.instagram.com/refresh_access_token', { grant_type: 'ig_refresh_token', access_token: refresh_token });
        return { ...long, refreshToken: long.accessToken };
      }
      if (provider === 'meta_facebook') throw new AdapterError('unsupported', 'facebook_reauthorization_required');
      if (provider === 'tiktok' || provider === 'douyin') return postForm(provider === 'douyin' ? 'https://open.douyin.com/oauth/refresh_token/' : route[1], { client_key: creds.clientId, client_secret: provider === 'tiktok' ? creds.clientSecret : undefined, refresh_token, grant_type: 'refresh_token' }, refresh_token);
      return postForm(route[1], common, refresh_token);
    },
  };
  if (provider === 'shopify') oauth.clientCredentials = async ({ shopDomain }) => {
    const creds = credentials();
    if (creds.shopifyAuthMode !== 'client_credentials') throw new AdapterError('unsupported', 'custom_distribution_mode');
    return postForm(shopifyEndpoint(shopDomain), { client_id: creds.clientId, client_secret: creds.clientSecret, grant_type: 'client_credentials' });
  };
  return oauth;
}
