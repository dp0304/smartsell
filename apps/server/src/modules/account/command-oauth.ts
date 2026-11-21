import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { findPlatform } from '../../extensions/platforms.js';
import type { Context, Fields } from '../types.js';
import { ensure, get, identifier, insert, millis, sha256, update } from './model.js';
import { recordGrant, type ProviderGrant } from './registry.js';

export interface OAuthFlowRequest {
  provider: string;
  brandId: string;
  platformAppId?: string;
}
export interface ConfiguredOAuth {
  authorizationOrigin: string;
  /** The host confirms a tenant-owned Shopify custom app and current fixed egress allowlist. */
  shopifyCustomAppReady?: boolean;
  authorize(input: { state: string; codeChallenge: string }): string;
  /** Exchange, discover identities and stage credentials under the resulting connection revision. */
  exchange(ctx: Context, input: { query: Readonly<Record<string, string>>; codeVerifier: string }): Promise<{
    grant: ProviderGrant;
    saveCredential(connectionId: string, grantRevision: number): Promise<void>;
  }>;
}
export interface CommandOAuthServices {
  flowKey: Uint8Array;
  configure(ctx: Context, request: OAuthFlowRequest): Promise<ConfiguredOAuth | undefined>;
}

export function commandOAuth(services?: CommandOAuthServices) {
  async function configure(ctx: Context, request: OAuthFlowRequest) {
    ensure(services?.flowKey.byteLength === 32, 'PLATFORM_APP_NOT_READY');
    const platform = findPlatform(request.provider);
    ensure(platform?.authStrategy === 'oauth2' && request.provider !== 'lazada', 'provider_authorization_unavailable');
    const app = await services.configure(ctx, request);
    ensure(app && (request.provider !== 'shopify' || (request.platformAppId && app.shopifyCustomAppReady === true)), 'PLATFORM_APP_NOT_READY');
    return { app, key: services.flowKey };
  }
  const aad = (ctx: Context, id: string, provider: string) => Buffer.from(JSON.stringify([ctx.tenantId, ctx.workspaceId, id, provider]));

  return {
    async start(ctx: Context, input: Fields) {
      const request = {
        provider: identifier(input, 'provider'), brandId: identifier(input, 'brand_id'),
        platformAppId: input.platform_app_id === undefined ? undefined : identifier(input, 'platform_app_id'),
      };
      const brand = await ctx.get('workspace', 'brand', request.brandId);
      ensure(brand && (brand.data.status === 'active' || brand.data.status === undefined), 'brand_not_found', 404);
      const { app, key } = await configure(ctx, request);
      const state = randomBytes(32).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const id = sha256(state);
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(aad(ctx, id, request.provider));
      const encrypted = Buffer.concat([cipher.update(verifier, 'utf8'), cipher.final()]);
      const sealed = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
      const codeChallenge = Buffer.from(sha256(verifier), 'hex').toString('base64url');
      let url: URL;
      try { url = new URL(app.authorize({ state, codeChallenge })); }
      catch { ensure(false, 'PLATFORM_APP_NOT_READY'); }
      ensure(url.protocol === 'https:' && url.origin === app.authorizationOrigin && !url.username && !url.password &&
        url.searchParams.getAll('state').length === 1 && url.searchParams.get('state') === state, 'PLATFORM_APP_NOT_READY');
      await insert(ctx, 'oauth_flow', { request, sealed, status: 'pending', started_by: ctx.actorId, expires_at: millis(ctx) + 600_000 }, id);
      return { authorize_url: url.href };
    },
    async complete(ctx: Context, provider: string, query: Readonly<Record<string, string>>) {
      ensure(/^[A-Za-z0-9_-]{43}$/.test(query.state ?? ''), 'OAUTH_STATE_INVALID', 400);
      const flow = await ctx.get('account', 'oauth_flow', sha256(query.state));
      ensure(flow?.data.status === 'pending' && flow.data.request.provider === provider && flow.data.expires_at > millis(ctx), 'OAUTH_STATE_INVALID', 400);
      const request = flow.data.request as OAuthFlowRequest;
      const { app, key } = await configure(ctx, request);
      const brand = await ctx.get('workspace', 'brand', request.brandId);
      ensure(brand && (brand.data.status === 'active' || brand.data.status === undefined), 'brand_not_found', 404);
      if (query.error) {
        await update(ctx, flow, { sealed: null, status: 'denied' });
        return { status: 'denied' } as const;
      }
      const sealed = Buffer.from(flow.data.sealed, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
      decipher.setAAD(aad(ctx, flow.id, provider));
      decipher.setAuthTag(sealed.subarray(12, 28));
      const codeVerifier = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString('utf8');
      await update(ctx, flow, { sealed: null, status: 'exchanged' });
      let result: Awaited<ReturnType<ConfiguredOAuth['exchange']>>;
      try { result = await app.exchange(ctx, { query, codeVerifier }); }
      catch {
        const exchanged = await get(ctx, 'oauth_flow', flow.id);
        await update(ctx, exchanged, { status: 'failed' });
        return { status: 'failed', reason: 'oauth_exchange_failed' } as const;
      }
      ensure(result.grant.provider === provider, 'connection_provider_mismatch');
      const connection = await recordGrant(ctx, result.grant, undefined, { appId: request.platformAppId, flowStartedAt: flow.created_at });
      await result.saveCredential(connection.id, connection.data.grant_revision);
      return { status: 'authorized', connection_id: connection.id } as const;
    },
  };
}
