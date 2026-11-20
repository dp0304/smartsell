import type { Context, Row } from '@smartsell/contracts';
import { createRequester } from '../../../../packages/adapters/src/adapter-http.ts';
import { fetchCatalog } from '../../../../packages/adapters/src/catalog.ts';
import { createFetchTransport } from '../../../../packages/adapters/src/fetch-transport.ts';
import { TransportError } from '../../../../packages/adapters/src/provider-http.ts';

const origins = {
  SG: 'https://partner.shopeemobile.com',
  CN: 'https://partner.shopeemobile.com.cn',
  BR: 'https://openplatform.shopee.com.br',
} as const;
const catalogPaths = new Set(['/api/v2/product/get_item_list', '/api/v2/product/get_item_base_info', '/api/v2/product/get_model_list']);
const name = 'SMARTSELL_SHOPEE_CATALOG_GRANTS';
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const numericId = /^[1-9]\d{0,19}$/;
const valid = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const secret = (value: unknown): value is string => valid(value, /^\S{1,4096}$/);

interface Grant {
  tenantId: string;
  workspaceId: string;
  connectionId: string;
  storeId: string;
  sourceId: string;
  shopId: string;
  region: keyof typeof origins;
  partnerId: string;
  partnerKey: string;
  accessToken: string;
  expiresAt: string;
}

const fields = new Set<keyof Grant>(['tenantId', 'workspaceId', 'connectionId', 'storeId', 'sourceId', 'shopId',
  'region', 'partnerId', 'partnerKey', 'accessToken', 'expiresAt']);

export function createShopeeCatalog() {
  let input: unknown;
  try { input = JSON.parse(process.env[name] ?? '[]'); }
  catch { throw new Error(`Invalid ${name} JSON`); }
  if (!Array.isArray(input)) throw new Error(`Invalid ${name}`);
  const grants = new Map<string, Grant>();
  for (const entry of input) {
    const region = entry?.region;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).some(key => !fields.has(key as keyof Grant)) ||
        ![entry.tenantId, entry.workspaceId, entry.connectionId, entry.storeId, entry.sourceId].every(id => valid(id, uuid)) ||
        !valid(entry.shopId, numericId) || !valid(entry.partnerId, numericId) || !secret(entry.partnerKey) || !secret(entry.accessToken) ||
        (region !== 'SG' && region !== 'CN' && region !== 'BR') ||
        !valid(entry.expiresAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/) || !Number.isFinite(Date.parse(entry.expiresAt))) {
      throw new Error(`Invalid ${name} entry`);
    }
    const key = JSON.stringify([entry.tenantId, entry.workspaceId, entry.sourceId]);
    if (grants.has(key)) throw new Error(`Duplicate ${name} entry`);
    grants.set(key, entry);
  }

  return (ctx: Context, source: Row, store: Row, connection: Row) => {
    const grant = grants.get(JSON.stringify([ctx.tenantId, ctx.workspaceId, source.id]));
    if (!grant || grant.connectionId !== connection.id || grant.storeId !== store.id || grant.shopId !== store.external_store_id ||
        Date.parse(grant.expiresAt) <= Date.parse(ctx.now) ||
        !Array.isArray(connection.discovered_accounts) || !connection.discovered_accounts.some(account => account?.externalAccountId === grant.shopId)) return;

    const origin = origins[grant.region];
    return async (cursor: string | null, includeInventory: boolean, scope: { signal: AbortSignal; requests: number }) => {
      const send = createFetchTransport({ origins: [origin], timeoutMs: 10_000,
        fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.any([scope.signal, options!.signal!]) }),
      });
      const request = createRequester('shopee', async req => {
        const url = new URL(req.url);
        if (scope.signal.aborted || req.method !== 'GET' || req.effect !== 'read' || !catalogPaths.has(url.pathname) ||
            url.origin !== origin || url.searchParams.get('shop_id') !== grant.shopId) throw new TransportError('not_sent');
        scope.requests++;
        return send({ method: req.method, url: req.url, headers: { ...req.headers }, body: req.body });
      });
      const page = await fetchCatalog('shopee', cursor, {
        accessToken: grant.accessToken, accountId: grant.shopId, state: 'active', expiresAt: Date.parse(grant.expiresAt),
        scopes: Array.isArray(connection.scopes) ? connection.scopes.filter(scope => typeof scope === 'string') : [],
        configuration: { region: grant.region, partnerId: grant.partnerId, partnerKey: grant.partnerKey, shopId: grant.shopId },
      }, request);
      if (!includeInventory) {
        for (const item of page.items) for (const variant of item.variants) delete variant.available;
      }
      return page;
    };
  };
}
