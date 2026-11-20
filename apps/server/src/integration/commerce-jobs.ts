import { createHash, randomUUID } from 'node:crypto';
import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import type { ConnectionCtx, ProviderKey, SyncPage } from '../../../../packages/adapters/src/adapter-types.ts';
import { normalizeCommerceCatalogPage } from '../../../../packages/adapters/src/catalog.ts';
import { classifyError } from '../../../../packages/adapters/src/provider-http.ts';
import type { SyncPage as CatalogPage } from '../../../../packages/adapters/src/types.ts';
import { commerceRequestScope } from './commerce-providers.js';
import { createShopeeCatalog } from './shopee-catalog.js';
import { connectionContext, type AccountServices } from '../modules/account/oauth.js';
import { metaPauseDrain } from '../modules/ads/meta-pause.js';
import { currentTiktokCatalogRun } from '../modules/commerce/catalog-sync.js';
import { applyStoreSyncResult } from '../modules/commerce/store-operations.js';
import { phase } from '../modules/commerce/domain.js';
import { collectionBudgetState, finishSyncCancellation, receiveVerifiedDelivery, recordCatalogPage, recordStoreTradePage, recordSyncPage, syncCancellationInFlight, updateSyncRun } from '../modules/ingest/sync-operations.js';
import type { Subscriber } from '../operations.js';
import type { BackgroundDrain } from '../runtime.js';

const operations = { products: 'product_read', orders: 'order_read', refunds: 'refund_read' } as const;
type Resource = keyof typeof operations;
const active = new Set(['queued', 'running', 'rate_limited']);
const phaseOrder = ['p0a', 'p0b', 'p1', 'p2'];
const leaseMs = 120_000;
const maximumPages = 10_000;
const cursorHash = (cursor: string) => createHash('sha256').update(cursor).digest('base64url');

function enabled(store: Row, resource: Resource) {
  const scope = (store.sync_scope ?? {}) as Data;
  return resource === 'products' ? scope.products !== false : scope[resource] === true;
}

function routeVerifiedHint(ctx: Context, event: Data) {
  const data = event.payload as Data;
  const { provider, accountId, externalId, app_id: appId, type } = data;
  const isShopify = provider === 'shopify' && /^(products|inventory_levels|inventory_items)\//.test(String(type));
  if (!isShopify && !(provider === 'tiktok_shop' && type === 'product_status_change')) return;
  if (typeof accountId !== 'string' || typeof externalId !== 'string') return;
  const connections = ctx.list('connection').filter(row => row.provider === provider && row.platform_app_id === appId && row.status === 'active');
  for (const store of ctx.list('store')) {
    const connection = connections.find(row => row.id === store.connection_id);
    if (!connection || !enabled(store, 'products') || accountId !== (isShopify ? connection.shop_domain : store.external_store_id)) continue;
    const source = ctx.list('data_source').find(row => row.store_id === store.id && row.connection_id === connection.id &&
      row.provider === provider && row.status === 'active' && Array.isArray(row.resources) && row.resources.includes('products'));
    if (!source) continue;
    receiveVerifiedDelivery(ctx, { sourceId: source.id, resource: 'products', eventId: String(event.id), externalId, transport: 'https' });
  }
}

export const commerceSubscribers: Subscriber[] = [
  { id: 'commerce.webhook', accepts: type => type === 'account.webhook.resync_requested', run: routeVerifiedHint },
];

class SyncUnavailable extends Error {
  constructor(readonly reason: string, readonly errorClass = 'permission_denied') { super(reason); }
}

function binding(ctx: Context, run: Row, source: Row, account: AccountServices, shopeeCatalog: ReturnType<typeof createShopeeCatalog>) {
  const probe = run.run_type === 'probe';
  const resource = (probe ? 'products' : run.resource) as Resource;
  if (!Object.hasOwn(operations, resource)) throw new SyncUnavailable('manual_import_available', 'unsupported');
  if ((!probe && source.status !== 'active') || (probe && source.status_reason !== 'ip_not_allowed') ||
      (!probe && !(Array.isArray(source.resources) && source.resources.includes(resource)))) throw new SyncUnavailable('source_unavailable');
  const store = ctx.get('store', String(source.store_id));
  if (!enabled(store, resource) || !['connecting', 'degraded', 'active'].includes(String(store.status)) ||
      store.connection_id !== source.connection_id || store.provider !== source.provider ||
      typeof store.external_store_id !== 'string' || typeof source.connection_id !== 'string') throw new SyncUnavailable('source_unavailable');
  const connection = ctx.get('connection', source.connection_id);
  if (connection.purpose !== 'store' || connection.provider !== store.provider || connection.brand_id !== store.brand_id ||
      connection.status !== 'active' || (connection.expires_at && String(connection.expires_at) <= ctx.now)) {
    throw new SyncUnavailable('authorization_required', 'auth_expired');
  }
  const provider = store.provider as ProviderKey;
  if (provider === 'tiktok_shop' && resource === 'products' && !probe && !currentTiktokCatalogRun(run, store, connection)) {
    throw new SyncUnavailable('source_unavailable');
  }
  const appId = typeof connection.platform_app_id === 'string' ? connection.platform_app_id : undefined;
  if (provider === 'shopee') {
    if (resource !== 'products' || phaseOrder.indexOf(phase(ctx)) < phaseOrder.indexOf('p1')) {
      throw new SyncUnavailable('manual_import_available', 'unsupported');
    }
    const app = appId ? ctx.list('platform_app').find(row => row.id === appId) : undefined;
    const shopee = shopeeCatalog(ctx, source, store, connection);
    if (!shopee || (appId && (app?.provider !== provider || app.status !== 'active'))) {
      throw new SyncUnavailable('authorization_required', 'auth_expired');
    }
    return { shopee, connection, store, resource };
  }
  const install = appId ? account.shopifyApp?.(ctx, appId) : undefined;
  if (provider === 'shopify' && (!install?.egressVerified || install.shopDomain !== connection.shop_domain)) {
    throw new SyncUnavailable('authorization_required');
  }
  const adapter = account.adapter?.(provider, appId);
  if (!adapter || adapter.provider !== provider) throw new SyncUnavailable('manual_import_available', 'unsupported');
  let auth: ConnectionCtx;
  try { auth = connectionContext(ctx, connection, account, store.external_store_id); }
  catch { throw new SyncUnavailable('authorization_required', 'auth_expired'); }
  if (provider === 'tiktok_shop' && (auth.externalAccountId !== store.external_store_id || !auth.shopCipher)) {
    throw new SyncUnavailable('authorization_required');
  }
  if (!probe) {
    const capability = adapter.staticMatrix().find(item => item.operation === operations[resource] && item.executor === 'api' && item.readiness === 'implemented');
    if (!capability || phaseOrder.indexOf(capability.phase.toLowerCase()) > phaseOrder.indexOf(phase(ctx))) throw new SyncUnavailable('manual_import_available', 'unsupported');
    const hasScope = (scope: string) => auth.scopes?.includes(scope) && Array.isArray(connection.scopes) && connection.scopes.includes(scope) &&
      (!install || install.oauthScopes.includes(scope));
    if (!capability.requires_scopes?.every(group => group.split('|').some(hasScope))) throw new SyncUnavailable('authorization_required');
    if (provider === 'shopify' && resource === 'products' && (store.sync_scope as Data | undefined)?.inventory === true && !hasScope('read_inventory')) {
      throw new SyncUnavailable('authorization_required');
    }
  }
  return { adapter, auth, connection, store, resource };
}

type Claim = ReturnType<typeof binding> & { run: Row; fence: string; leaseId: string };

function fail(ctx: Context, run: Row, reason: string, errorClass: string, requests: number) {
  if (run.run_type !== 'probe' && (reason === 'authorization_required' || reason === 'manual_import_available')) {
    ctx.update('sync_run', run.id, { fallback: 'file_import' });
  }
  return recordSyncPage(ctx, run.id, { index: Number(run.checkpoint_index) + 1, attempt: Number(run.attempt), requests,
    result: 'failed', error_class: errorClass, error_reason: reason });
}

function claimPage(ctx: Context, account: AccountServices, shopeeCatalog: ReturnType<typeof createShopeeCatalog>): Claim | undefined {
  const now = Date.parse(ctx.now);
  const sources = new Map(ctx.list('data_source').filter(source => source.kind === 'store' && source.store_id).map(source => [source.id, source]));
  const leases = new Map(ctx.list('commerce_sync_lease').map(lease => [lease.connection_id, lease]));
  const storeRuns = ctx.list('sync_run').filter(run => sources.has(String(run.data_source_id)));
  for (const run of storeRuns) {
    if (run.status === 'cancel_requested' && !syncCancellationInFlight(ctx, run)) finishSyncCancellation(ctx, run);
  }
  const runs = storeRuns.filter(run => active.has(String(run.status)))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || String(a.window_from).localeCompare(String(b.window_from)) || a.id.localeCompare(b.id));
  const blocked = new Set<unknown>();
  for (const run of runs) {
    const source = sources.get(String(run.data_source_id))!;
    const lease = leases.get(source.connection_id);
    if (blocked.has(source.connection_id) || Number(lease?.expires_at_ms) > now) continue;
    blocked.add(source.connection_id);
    if (run.status === 'rate_limited' && String(run.retry_at) > ctx.now) continue;
    let bound: ReturnType<typeof binding>;
    try {
      bound = binding(ctx, run, source, account, shopeeCatalog);
      if (run.run_type !== 'probe') {
        const budget = collectionBudgetState(ctx, source.id);
        if (budget.blocked) {
          const executorStatus = budget.policy === 'pause' ? 'budget_paused' : 'budget_throttled';
          if (run.executor_status !== executorStatus || run.budget_next_request_at !== budget.next_request_at) {
            updateSyncRun(ctx, run.id, { executor_status: executorStatus, budget_next_request_at: budget.next_request_at });
          }
          continue;
        }
      }
    } catch (error) {
      if (error instanceof SyncUnavailable) fail(ctx, run, error.reason, error.errorClass, 0);
      else if (error instanceof Problem && error.status === 404) fail(ctx, run, 'source_unavailable', 'permission_denied', 0);
      else throw error;
      return;
    }
    const fence = randomUUID();
    const fields = { connection_id: bound.connection.id, sync_run_id: run.id, expires_at_ms: now + leaseMs, fence };
    const leased = lease ? ctx.update('commerce_sync_lease', lease.id, fields) : ctx.create('commerce_sync_lease', fields);
    const started = updateSyncRun(ctx, run.id, { status: 'running', executor_status: 'running', started_at: run.started_at ?? ctx.now, fallback: null, budget_next_request_at: null });
    return { ...bound, run: started, fence, leaseId: leased.id };
  }
}

function retryDate(value: string | undefined, now: number, failures: number) {
  const requested = value && /^\d+$/.test(value) ? now + Number(value) * 1000 : Date.parse(value ?? '');
  const backoff = now + Math.min(60_000, 1000 * 2 ** failures);
  return new Date(Number.isFinite(requested) ? Math.max(backoff, Math.min(requested, now + 86_400_000)) : backoff).toISOString();
}

type PageResult = { page: SyncPage } | { catalog: CatalogPage } | { error: unknown } | { probe: boolean };

function checkpoint(ctx: Context, claim: Claim, account: AccountServices, shopeeCatalog: ReturnType<typeof createShopeeCatalog>, result: PageResult, requests: number) {
  const lease = ctx.get('commerce_sync_lease', claim.leaseId);
  if (lease.fence !== claim.fence) return;
  ctx.update('commerce_sync_lease', lease.id, { expires_at_ms: 0, fence: null });
  const run = ctx.get('sync_run', claim.run.id);
  if (run.status === 'cancel_requested') { finishSyncCancellation(ctx, run); return; }
  if (run.version !== claim.run.version || !active.has(String(run.status))) return;
  const source = ctx.get('data_source', String(run.data_source_id));
  try {
    const current = binding(ctx, run, source, account, shopeeCatalog);
    if (current.connection.id !== claim.connection.id || current.connection.version !== claim.connection.version ||
        current.store.id !== claim.store.id || current.store.external_store_id !== claim.store.external_store_id ||
        (current.store.sync_scope as Data | undefined)?.inventory !== (claim.store.sync_scope as Data | undefined)?.inventory) {
      if (run.cursor_after) {
        fail(ctx, run, 'authorization_required', 'auth_expired', requests);
        return;
      }
      updateSyncRun(ctx, run.id, { status: 'queued', executor_status: 'awaiting_adapter' });
      return;
    }
  } catch (error) {
    if (error instanceof SyncUnavailable) { fail(ctx, run, error.reason, error.errorClass, requests); return; }
    if (error instanceof Problem && error.status === 404) { fail(ctx, run, 'source_unavailable', 'permission_denied', requests); return; }
    throw error;
  }
  const marker = { index: Number(run.checkpoint_index) + 1, attempt: Number(run.attempt), requests };
  if ('error' in result) {
    const classified = claim.shopee ? classifyError(result.error) : claim.adapter.classifyError(result.error);
    const failures = Number(run.page_failures ?? 0) + 1;
    if (['rate_limited', 'transient'].includes(classified.errorClass) && failures <= 4) {
      recordSyncPage(ctx, run.id, { ...marker, result: 'rate_limited', error_class: classified.errorClass,
        retry_at: retryDate(classified.retryAfter, Date.parse(ctx.now), failures) });
      ctx.update('sync_run', run.id, { page_failures: failures });
      return;
    }
    const accessRejected = ['auth_expired', 'permission_denied'].includes(classified.errorClass);
    const reason = classified.reason === 'ip_not_allowed' ? 'ip_not_allowed' : accessRejected ? 'authorization_required' :
      classified.errorClass === 'unsupported' ? 'manual_import_available' : 'provider_request_failed';
    fail(ctx, run, reason, classified.errorClass, requests);
    return;
  }
  if ('probe' in result) {
    recordSyncPage(ctx, run.id, { ...marker, result: result.probe ? 'succeeded' : 'failed', error_reason: result.probe ? undefined : 'provider_probe_failed' });
    if (result.probe && claim.store.status === 'degraded' && claim.store.status_reason === 'ip_not_allowed') {
      const canRestoreFull = claim.store.provider !== 'tiktok_shop' && claim.store.last_snapshot_at;
      applyStoreSyncResult(ctx, claim.store.id, { state: canRestoreFull ? 'full' : 'incremental' });
    }
    return;
  }
  const page = 'catalog' in result ? result.catalog : result.page;
  const seen = Array.isArray(run.cursor_hashes) ? run.cursor_hashes : [];
  const next = page.nextCursor && cursorHash(page.nextCursor);
  if (page.nextCursor !== null && (!next || page.nextCursor.length > 8192 || seen.includes(next) || seen.length >= maximumPages)) {
    fail(ctx, run, 'invalid_provider_cursor', 'invalid_input', requests);
    return;
  }
  if ('catalog' in result) {
    // Shopee requests NORMAL items only. Never retire unseen merchandise from this feed.
    recordCatalogPage(ctx, run.id, { ...marker, page: result.catalog, authoritative: false });
  } else if (claim.resource === 'products') {
    const includeInventory = (claim.store.sync_scope as Data | undefined)?.inventory === true;
    const provider = String(claim.store.provider);
    const catalog = normalizeCommerceCatalogPage(provider, result.page, includeInventory);
    const full = run.run_type === 'catalog_snapshot';
    const tiktokSnapshot = full && provider === 'tiktok_shop';
    if (tiktokSnapshot) {
      const prior = new Set(Array.isArray(run.seen_product_ids) ? run.seen_product_ids : []);
      const count = prior.size + catalog.items.length;
      const priorTotal = typeof run.catalog_total_count === 'number' ? run.catalog_total_count : undefined;
      const pageTotal = result.page.totalCount;
      const total = priorTotal ?? pageTotal;
      const final = catalog.nextCursor === null;
      if ((!catalog.items.length && !(final && !run.cursor_after && total === 0)) ||
          catalog.items.some(item => prior.has(item.externalId)) ||
          (priorTotal !== undefined && pageTotal !== undefined && priorTotal !== pageTotal) ||
          (total !== undefined && (final ? count !== total : count >= total))) {
        fail(ctx, run, 'provider_page_rejected', 'invalid_input', requests);
        return;
      }
      ctx.update('sync_run', run.id, { catalog_total_count: final ? null : total ?? null });
    }
    // TikTok Shop can establish a usable snapshot for this grant. Only Shopify can retire unseen products.
    recordCatalogPage(ctx, run.id, { ...marker, page: catalog, completesSnapshot: tiktokSnapshot,
      authoritative: full && provider === 'shopify' });
  } else {
    recordStoreTradePage(ctx, run.id, { ...marker, cursor: result.page.nextCursor, rows: result.page.items });
  }
  ctx.update('sync_run', run.id, { page_failures: 0, cursor_hashes: next ? [...seen, next] : [] });
}

export function commerceDrain(account: AccountServices): BackgroundDrain {
  const shopeeCatalog = createShopeeCatalog();
  const drainAds = metaPauseDrain(account);
  return async transact => {
    await drainAds(transact);
    // Claim and checkpoint are separate committed transactions. Network I/O never holds a workspace lock.
    const claim = await transact(ctx => claimPage(ctx, account, shopeeCatalog));
    if (!claim) return;
    const requestScope = { signal: AbortSignal.timeout(90_000), requests: 0 };
    const result = await commerceRequestScope.run(requestScope, async (): Promise<PageResult> => {
      try {
        const probeRun = claim.run.run_type === 'probe';
        const cursor = typeof claim.run.cursor_after === 'string' ? claim.run.cursor_after : null;
        const includeInventory = (claim.store.sync_scope as Data | undefined)?.inventory === true;
        if (claim.shopee) {
          const catalog = await claim.shopee(probeRun ? null : cursor, !probeRun && includeInventory, requestScope);
          return probeRun ? { probe: true } : { catalog };
        }
        if (probeRun) {
          const probe = await claim.adapter.probe(claim.auth);
          return { probe: probe.status === 'ready' && probe.externalAccountId === claim.auth.externalAccountId };
        }
        const iterator = claim.adapter.sync(operations[claim.resource], cursor, { ...claim.auth,
          window: { from: String(claim.run.window_from), to: String(claim.run.window_to) },
          includeInventory,
          objectId: claim.resource !== 'products' && typeof claim.run.external_id === 'string' ? claim.run.external_id : undefined,
        })[Symbol.asyncIterator]();
        try {
          const next = await iterator.next();
          if (next.done) throw new SyncUnavailable('empty_provider_response', 'invalid_input');
          return { page: next.value };
        } finally { await iterator.return?.(); }
      } catch (error) { return { error }; }
    });
    try { await transact(ctx => checkpoint(ctx, claim, account, shopeeCatalog, result, requestScope.requests)); }
    catch (error) {
      if (!(error instanceof Problem) || ![400, 404, 409, 422].includes(error.status)) throw error;
      // If validation rejects a page, its sink and checkpoint roll back together.
      await transact(ctx => {
        const lease = ctx.get('commerce_sync_lease', claim.leaseId);
        if (lease.fence !== claim.fence) return;
        ctx.update('commerce_sync_lease', lease.id, { expires_at_ms: 0, fence: null });
        const run = ctx.get('sync_run', claim.run.id);
        if (run.version === claim.run.version) fail(ctx, run, 'provider_page_rejected', 'invalid_input', requestScope.requests);
      });
    }
  };
}
