import { ADMIN, READ, Problem, type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';
import { startOAuth, storeProviders, type AccountServices } from '../account/oauth.js';
import { currentTiktokCatalogRun, tiktokCatalogBinding } from './catalog-sync.js';
import { bool, channels, conflict, currency, enumValue, identifier, integer, invalid, object, optional, priceSources, providers, purchaseUrl, requirePhase, requirePlatformPhase, scope, strings, text, upsert } from './domain.js';

export const COMMERCE_WRITE = ['owner', 'admin', 'manager', 'editor'] as const;
export interface CommerceServices {
  account?: AccountServices;
  requestSync?: (ctx: Context, store: Row, mode: 'full' | 'incremental', body: Data) => unknown;
  readPromotion?: (ctx: Context, store: Row, externalId: string) => Promise<{ rule: Data; valid_from: string; valid_until: string; codes: readonly string[]; status?: 'ACTIVE' | 'EXPIRED' | 'SCHEDULED' } | null>;
  writeLocalization?: (ctx: Context, store: Row, input: { externalProductId: string; field: string; locale: string; marketId: string | null; text: string; sourceHash: string }) => Promise<{ readbackText: string }>;
  createImport?: (ctx: Context, store: Row, input: Input) => unknown;
}
export function unavailable(message: string): never {
  throw new Problem(503, 'integration_unavailable', message);
}
export function setStoreStatus(ctx: Context, store: Row, status: string, reason: string | null, patch: Data = {}): Row {
  const saved = ctx.update('store', store.id, { ...patch, status, status_reason: reason });
  if (store.status !== status || store.status_reason !== reason) ctx.emit('commerce.store.status_changed', { store_id: store.id, status, status_reason: reason });
  return saved;
}
function checkStoreIdentity(ctx: Context, provider: unknown, externalId: string | null, except?: string): void {
  if (externalId && ctx.list('store').some(row => row.id !== except && row.provider === provider && row.external_store_id === externalId)) conflict('duplicate_store', 'External store ID is already registered');
}
function syncScope(ctx: Context, body: unknown, existing: Data = {}): Data {
  const updated = scope(body, existing);
  if (updated.orders === true || updated.refunds === true) requirePhase(ctx, 'p1');
  return updated;
}
export function attachAuthorizedStore(ctx: Context, storeId: string, connectionId: string, requestedExternalId?: unknown): Row {
  const store = ctx.get('store', storeId);
  const provider = enumValue(store.provider, storeProviders, 'store provider');
  requirePhase(ctx, provider === 'shopify' || provider === 'tiktok_shop' ? 'p0b' : provider === 'lazada' ? 'p2' : 'p1');
  if (store.status === 'disabled') conflict('store_disabled', 'Store is disabled');
  const upgrading = store.status === 'import_only' || store.upgrading_from_import === true;
  const connection = ctx.get('connection', connectionId);
  if (connection.provider !== provider || connection.purpose !== 'store' || connection.brand_id !== store.brand_id || !['active', 'authorized'].includes(String(connection.status)) || (connection.expires_at && Date.parse(String(connection.expires_at)) <= Date.parse(ctx.now))) conflict('connection_mismatch', 'Store requires a current authorized connection for its provider and brand');
  const discovered = Array.isArray(connection.discovered_accounts) ? connection.discovered_accounts : [];
  const ids = discovered.flatMap(value => value && typeof value === 'object' && typeof (value as Data).externalAccountId === 'string' ? [(value as Data).externalAccountId as string] : []);
  const externalId = identifier(requestedExternalId ?? store.external_store_id ?? (ids.length === 1 ? ids[0] : null), 'external_store_id');
  if (!externalId || !ids.includes(externalId) || (store.external_store_id && store.external_store_id !== externalId)) conflict('store_identity_unverified', 'Authorized account does not match the store');
  checkStoreIdentity(ctx, provider, externalId, store.id);
  const rebound = provider === 'tiktok_shop' && store.connection_id !== connection.id;
  return setStoreStatus(ctx, store, 'connecting', null, { external_store_id: externalId, connection_id: connection.id, upgrading_from_import: upgrading,
    ...(rebound && { catalog_binding_revision: Number(store.catalog_binding_revision ?? 0) + 1, catalog_snapshot_run_id: null,
      data_source_id: null, last_snapshot_at: null, last_incremental_at: null }) });
}
function startConnection(ctx: Context, store: Row, body: Data, services: CommerceServices): unknown {
  const provider = enumValue(store.provider, storeProviders, 'store provider');
  requirePhase(ctx, provider === 'shopify' || provider === 'tiktok_shop' ? 'p0b' : provider === 'lazada' ? 'p2' : 'p1');
  if (store.status === 'disabled') conflict('store_disabled', 'Store is disabled');
  const upgrading = store.status === 'import_only' || store.upgrading_from_import === true;
  if (body.connection_id != null) return attachAuthorizedStore(ctx, store.id, text(body.connection_id, 'connection_id'), body.external_store_id);
  if (!services.account) return unavailable('Account authorization service is unavailable');
  const requestedScopes = body.scopes == null ? [] : strings(body.scopes, 'scopes');
  if (requestedScopes.some(value => /write|buyer|recipient|restricted/i.test(value))) invalid('read-only scopes');
  const result = startOAuth(ctx, { brand_id: store.brand_id, platform_app_id: body.platform_app_id, shop_domain: body.shop_domain, scopes: requestedScopes, reconnect_connection_id: store.connection_id ?? undefined }, provider, services.account);
  const pending = provider === 'tiktok_shop' && typeof store.connection_id === 'string' ? {
    catalog_binding_revision: Number(store.catalog_binding_revision ?? 0) + 1,
    catalog_snapshot_run_id: null,
    catalog_pending_verified_at: ctx.get('connection', store.connection_id).last_verified_at ?? null,
    last_snapshot_at: null,
    last_incremental_at: null,
  } : {};
  return { store: setStoreStatus(ctx, store, 'connecting', 'authorization_pending', { upgrading_from_import: upgrading, ...pending }), ...result };
}
export function applyStoreSyncResult(ctx: Context, storeId: string, result: { state: 'full' | 'incremental' | 'degraded' | 'needs_reauth'; reason?: string }): Row {
  const store = ctx.get('store', storeId);
  if (!store.connection_id || store.status === 'disabled') conflict('store_not_connected', 'Store has no active connection');
  if (result.state === 'full') {
    const connection = ctx.get('connection', String(store.connection_id));
    if (!['active', 'authorized'].includes(String(connection.status)) || (connection.expires_at && Date.parse(String(connection.expires_at)) <= Date.parse(ctx.now))) return setStoreStatus(ctx, store, 'needs_reauth', 'connection_invalid');
    return setStoreStatus(ctx, store, 'active', null, { last_snapshot_at: ctx.now, upgrading_from_import: false,
      ...(store.provider === 'tiktok_shop' && { catalog_snapshot_binding: tiktokCatalogBinding(store, connection) }) });
  }
  if (result.state === 'incremental') return ctx.update('store', store.id, { last_incremental_at: ctx.now });
  return setStoreStatus(ctx, store, result.state, optional(result.reason, 'reason'));
}
function updateMarkets(ctx: Context, store: Row, body: Data): Row[] {
  const inputs = Array.isArray(body.markets) ? body.markets : [body];
  if (!inputs.length) invalid('markets');
  const seen = new Set<string>();
  const existing = ctx.list('store_market').filter(row => row.store_id === store.id);
  const changes = inputs.map(value => {
    const input = object(value, 'store_market');
    const market = ctx.get('market', text(input.market_id, 'market_id'));
    if (market.brand_id != null && market.brand_id !== store.brand_id) invalid('market_id');
    const channel = enumValue(input.channel, channels, 'channel');
    const key = JSON.stringify([market.id, channel]);
    if (seen.has(key)) invalid('duplicate store_market');
    seen.add(key);
    if (['tiktok_shop', 'shopee', 'lazada'].includes(String(store.provider)) && (existing.some(row => row.market_id !== market.id) || seen.size > 1 && Array.from(seen).some(item => JSON.parse(item)[0] !== market.id))) invalid('platform store must use one market');
    const previous = existing.find(row => row.market_id === market.id && row.channel === channel);
    const template = 'purchase_url_template' in input ? optional(input.purchase_url_template, 'purchase_url_template') : previous?.purchase_url_template ?? null;
    if (typeof template === 'string') {
      if (/\{[^}]*\}/.test(template.replace(/\{(?:locale|handle|variant_id|product_id)\}/g, ''))) invalid('purchase_url_template');
      purchaseUrl(template.replace(/\{[^}]*\}/g, '1'), store.provider);
    }
    return { previous, patch: {
      store_id: store.id, market_id: market.id, channel, purchase_url_template: template,
      price_source: enumValue(input.price_source ?? previous?.price_source ?? 'store_market_price', priceSources.slice(0, 3), 'price_source'),
      low_stock_threshold: 'low_stock_threshold' in input ? input.low_stock_threshold == null ? null : integer(input.low_stock_threshold, 'low_stock_threshold') : previous?.low_stock_threshold ?? null,
      inventory_locations: 'inventory_locations' in input ? input.inventory_locations == null ? null : strings(input.inventory_locations, 'inventory_locations') : previous?.inventory_locations ?? null,
      snapshot_ttl_minutes: integer(input.snapshot_ttl_minutes ?? previous?.snapshot_ttl_minutes ?? 1440, 'snapshot_ttl_minutes', 1),
      enabled: bool(input.enabled ?? previous?.enabled ?? true, 'enabled'),
    } };
  });
  return changes.map(({ previous, patch }) => upsert(ctx, 'store_market', previous, patch));
}
function catalogStatus(ctx: Context, store: Row, connection?: Row): Data {
  if (store.provider !== 'tiktok_shop') return {};
  const run = typeof store.catalog_snapshot_run_id === 'string'
    ? ctx.list('sync_run').find(row => row.id === store.catalog_snapshot_run_id) : undefined;
  // A callback can replace the grant while keeping the same connection and store IDs.
  const staleSnapshot = Boolean(store.last_snapshot_at) && (!connection || store.catalog_snapshot_binding !== tiktokCatalogBinding(store, connection));
  return {
    catalog_snapshot_run_id: connection && run && currentTiktokCatalogRun(run, store, connection) ? run.id : null,
    ...(staleSnapshot && { last_snapshot_at: null, ...(store.status === 'active' && { status: 'connecting' }) }),
  };
}

function createStore(ctx: Context, fields: Data) {
  return ctx.create('store', {
    status: 'import_only', status_reason: null, connection_id: null, data_source_id: null,
    last_snapshot_at: null, last_incremental_at: null, ...fields,
  });
}

export function createWorkerStore(ctx: Context, fields: {
  brand_id: string; provider: typeof storeProviders[number]; external_store_id: string; name: string;
}) {
  requirePlatformPhase(ctx, fields.provider);
  checkStoreIdentity(ctx, fields.provider, fields.external_store_id);
  const settings = ctx.list('workspace')[0];
  const store = createStore(ctx, { ...fields, region: null, default_currency: settings?.reporting_currency ?? 'USD',
    default_locale: settings?.default_ui_locale ?? 'en-US', sync_scope: { products: true } });
  ctx.emit('commerce.store.status_changed', { store_id: store.id, status: store.status });
  return store;
}

export function storeOperations(services: CommerceServices): Operation[] {
  return [
    { path: '/stores', method: 'GET', name: 'commerce_store_list', roles: READ, summary: 'List workspace stores', run(ctx, { query }) {
      const connections = new Map(ctx.list('connection').map(row => [row.id, row]));
      return ctx.list('store').filter(row => (!query.provider || query.provider === row.provider) && (!query.brand_id || query.brand_id === row.brand_id))
        .map(store => ({ ...store, ...catalogStatus(ctx, store, connections.get(String(store.connection_id))) }));
    } },
    { path: '/stores', method: 'POST', name: 'commerce_store_create', roles: ADMIN, summary: 'Register an import or authorized store', run(ctx, { body }) {
      const provider = enumValue(body.provider, providers, 'provider');
      requirePlatformPhase(ctx, provider);
      const externalId = identifier(body.external_store_id, 'external_store_id');
      checkStoreIdentity(ctx, provider, externalId);
      const brand = ctx.get('brand', text(body.brand_id, 'brand_id'));
      const mode = enumValue(body.mode ?? 'import', ['import', 'authorize'], 'mode');
      if (mode === 'authorize' && !body.connection_id && !services.account) return unavailable('Account authorization service is unavailable');
      let locale: string;
      try { locale = Intl.getCanonicalLocales(text(body.default_locale, 'default_locale', 35))[0] ?? invalid('default_locale'); } catch { invalid('default_locale'); }
      const store = createStore(ctx, {
        brand_id: brand.id, provider, external_store_id: externalId, name: text(body.name, 'name', 256), default_currency: currency(body.default_currency), default_locale: locale,
        region: optional(body.region, 'region'), sync_scope: syncScope(ctx, body.sync_scope),
      });
      if (mode === 'authorize') return startConnection(ctx, store, body, services);
      ctx.emit('commerce.store.status_changed', { store_id: store.id, status: store.status });
      return store;
    } },
    { path: '/stores/:id', method: 'GET', name: 'commerce_store_get', roles: READ, summary: 'Read store and sync status', run(ctx, { params }) {
      const saved = ctx.get('store', params.id!);
      const connection = ctx.list('connection').find(row => row.id === saved.connection_id);
      const store = { ...saved, ...catalogStatus(ctx, saved, connection) };
      const source = ctx.list('data_source').find(row => store.provider === 'tiktok_shop'
        ? row.kind === 'store' && row.store_id === store.id && row.connection_id === store.connection_id && row.status !== 'disabled'
        : row.id === store.data_source_id || row.store_id === store.id);
      const reauth = connection && (['expired', 'revoked', 'needs_reauth', 'reauthorization_required'].includes(String(connection.status)) || (connection.expires_at && Date.parse(String(connection.expires_at)) <= Date.parse(ctx.now)));
      const status = store.status === 'disabled' ? 'disabled' : reauth ? 'needs_reauth' : source?.status_reason === 'ip_not_allowed' ? 'degraded' : store.status;
      const status_reason = store.status === 'disabled' ? store.status_reason : reauth ? 'connection_invalid' : source?.status_reason === 'ip_not_allowed' ? 'ip_not_allowed' : store.status_reason;
      return { ...store, status, status_reason,
        data_source: source ? { id: source.id, status: source.status, status_reason: source.status_reason } : null,
        initial_snapshot_pending: status === 'connecting' && !store.last_snapshot_at };
    } },
    { path: '/stores/:id', method: 'PATCH', name: 'commerce_store_update', roles: ADMIN, versionKind: 'store', summary: 'Update store settings or disable the source', run(ctx, { params, body }) {
      const store = ctx.get('store', params.id!);
      const patch: Data = {};
      if ('name' in body) patch.name = text(body.name, 'name', 256);
      if ('sync_scope' in body) {
        const previous = object(store.sync_scope ?? {}, 'sync_scope');
        const next = syncScope(ctx, body.sync_scope, previous);
        patch.sync_scope = next;
        if (store.provider === 'tiktok_shop' && ((previous.inventory === true) !== (next.inventory === true) ||
            (previous.products !== false) !== (next.products !== false))) {
          patch.catalog_binding_revision = Number(store.catalog_binding_revision ?? 0) + 1;
        }
      }
      if ('data_source_id' in body) {
        const source = ctx.get('data_source', text(body.data_source_id, 'data_source_id'));
        if (source.store_id !== store.id || source.provider !== store.provider || source.connection_id !== store.connection_id) invalid('data_source_id');
        patch.data_source_id = source.id;
      }
      if ('status' in body && body.status !== 'disabled') invalid('status');
      if (body.status === 'disabled') return setStoreStatus(ctx, store, 'disabled', 'disabled_by_admin', patch);
      return upsert(ctx, 'store', store, patch);
    } },
    { path: '/stores/:id/connect', method: 'POST', name: 'commerce_store_connect', roles: ADMIN, summary: 'Authorize a read-only store connection without changing store identity', run: (ctx, { params, body }) => startConnection(ctx, ctx.get('store', params.id!), body, services) },
    { path: '/stores/:id/sync', method: 'POST', name: 'commerce_store_sync', accepted: true, roles: ADMIN, summary: 'Request an ingest synchronization', run(ctx, { params, body }) {
      const store = ctx.get('store', params.id!);
      if (!store.connection_id || !['connecting', 'degraded', 'active'].includes(String(store.status))) conflict('store_not_connected', 'Store has no active authorization');
      const mode = enumValue(body.mode ?? 'incremental', ['full', 'incremental'], 'mode');
      if (!services.requestSync) return unavailable('Store synchronization worker is unavailable');
      return services.requestSync(ctx, store, mode, Object.fromEntries(['resource', 'from', 'to'].filter(key => body[key] != null).map(key => [key, body[key]])));
    } },
    { path: '/stores/:id/imports', method: 'POST', name: 'commerce_store_import', roles: COMMERCE_WRITE, summary: 'Create an ingest import batch scoped to the store', run(ctx, input) {
      const store = ctx.get('store', input.params.id!);
      const template = enumValue(input.body.template_key ?? 'product_list', ['product_list', 'inventory_list', 'order_list', 'refund_list'], 'template_key');
      requirePlatformPhase(ctx, store.provider);
      if (store.status === 'disabled') conflict('store_disabled', 'Store is disabled');
      if (template === 'inventory_list' && store.provider !== 'shopify') invalid('inventory_list');
      if (template === 'order_list' || template === 'refund_list') {
        requirePhase(ctx, 'p1');
        if (!ADMIN.includes(ctx.role)) throw new Problem(403, 'forbidden', 'Order and refund imports require store administration');
      }
      if (!services.createImport) return unavailable('Import batch service is unavailable');
      return services.createImport(ctx, store, { ...input, body: { ...input.body, template_key: template, store_id: store.id } });
    } },
    { path: '/stores/:id/markets', method: 'GET', name: 'commerce_store_market_list', roles: READ, summary: 'Read store market configurations', run(ctx, { params }) { const store = ctx.get('store', params.id!); return ctx.list('store_market').filter(row => row.store_id === store.id); } },
    { path: '/stores/:id/markets', method: 'PUT', name: 'commerce_store_market_configure', roles: COMMERCE_WRITE, summary: 'Configure price sources and inventory scope by market', run: (ctx, { params, body }) => updateMarkets(ctx, ctx.get('store', params.id!), body) },
  ];
}
