import type { Adapter, AdapterOptions, CapabilityReport, ConnectionCtx, ProviderKey } from './adapter-types.ts';
import { commerceProviders, probeCommerce } from './provider-commerce.ts';
import { AdapterError, classifyError, client } from './provider-http.ts';
import { probeSocial } from './provider-social.ts';
import { createOAuth } from './provider-oauth.ts';
import { createWebhook } from './provider-webhook.ts';
import { providerCatalog } from './provider-catalog.ts';

export type { AdapterOptions, AuthorizationInput, ExchangeInput, OAuth, ProviderKey, RawRequest, RefreshInput, TokenSet } from './adapter-types.ts';

/** Provider authorization, verified identity discovery and webhook verification for AC. */
export function createAuthorizationAdapter(provider: ProviderKey, options: AdapterOptions = {}): Pick<Adapter, 'provider' | 'oauth' | 'probe' | 'webhook' | 'classifyError'> {
  const request = client(provider, options.transport);
  return {
    provider,
    oauth: createOAuth(provider, options, request),
    webhook: createWebhook(provider, options),
    classifyError,
    async probe(connection: ConnectionCtx): Promise<CapabilityReport> {
      const report = { provider, capabilities: providerCatalog[provider].capabilities.map(capability => ({ ...capability, status: 'unverified' as const })) };
      const token = connection.accessToken;
      if (!token?.trim() || !options.transport || !options.credentials?.clientId || !options.credentials?.clientSecret) return { ...report, status: 'unconfigured' };
      const commerce = commerceProviders.has(provider);
      if (!commerce && !['meta_instagram', 'meta_facebook', 'youtube', 'tiktok'].includes(provider)) return { ...report, status: 'unsupported' };
      let accounts = commerce ? await probeCommerce(provider, options, request, connection, token)
        : await probeSocial(provider, request, connection, token);
      if (connection.externalAccountId) accounts = accounts.filter(account => account.externalAccountId === connection.externalAccountId);
      if (!accounts.length) throw new AdapterError('permission_denied', 'platform_identity_unverified');
      return { ...report, status: 'ready', accounts, externalAccountId: accounts.length === 1 ? accounts[0].externalAccountId : undefined };
    },
  };
}
