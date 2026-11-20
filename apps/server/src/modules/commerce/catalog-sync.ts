import type { Context, Data, Row } from '@smartsell/contracts';
import type { SyncPage } from '../../../../../packages/adapters/src/types.js';
import { moneyMinor } from '../ingest/ingest-input.js';
import { conflict, currency, invalid, text } from './domain.js';
import { prepareImport } from './imports.js';
import { change } from './listings.js';

/** A TikTok Shop product cursor belongs to the authorization and scope that queued it. */
export function tiktokCatalogBinding(store: Row, connection: Row): string {
  const scope = store.sync_scope as Data | undefined;
  return JSON.stringify([store.id, store.external_store_id, store.catalog_binding_revision ?? 0,
    connection.id, connection.version, scope?.inventory === true]);
}

export function currentTiktokCatalogRun(run: Row, store: Row, connection: Row): boolean {
  return !(store.status_reason === 'authorization_pending' && store.catalog_pending_verified_at === (connection.last_verified_at ?? null)) &&
    run.catalog_binding === tiktokCatalogBinding(store, connection) &&
    (run.run_type !== 'catalog_snapshot' || store.catalog_snapshot_run_id === run.id);
}

/** Called by ingest inside the transaction that checkpoints an authenticated catalog page. */
export function applyCatalogPage(ctx: Context, storeId: string, page: SyncPage, batchId?: string): Row[] {
  const store = ctx.get('store', storeId);
  return page.items.map(item => {
    const variants = item.variants.map(variant => {
      const amount = variant.price == null ? null : moneyMinor(variant.price, currency(variant.currency ?? store.default_currency));
      // The product CSV represents Shopify options by position.
      return { external_variant_id: variant.externalId, sku: variant.sku, options: variant.selectedOptions?.map(option => option.value),
        price_minor: amount, currency: variant.currency, inventory_quantity: variant.available,
        source_updated_at: variant.sourceUpdatedAt ?? item.sourceUpdatedAt, source_observation: true };
    });
    const data: Data = { external_product_id: item.externalId, handle: item.handle, title: item.title, variants,
      status: 'active', source_updated_at: item.sourceUpdatedAt };
    return prepareImport(ctx, 'product_list', storeId, data, { mode: 'api', batchId })();
  });
}

/** Run only when all pages of an authoritative, unfiltered catalog have been successfully collected. */
export function reconcileStoreCatalog(ctx: Context, storeId: string, seenProductIds: readonly string[]): Row[] {
  const store = ctx.get('store', storeId);
  if (!store.connection_id || !['connecting', 'active', 'degraded'].includes(String(store.status))) conflict('store_not_connected', 'Store has no active authorization');
  // A first upgrade snapshot never infers removal for unmatched imported products.
  if (store.upgrading_from_import === true) return [];
  if (!Array.isArray(seenProductIds)) invalid('seenProductIds');
  const seen = new Set(seenProductIds.map(id => text(id, 'external_product_id')));
  return ctx.list('product').filter(row => row.store_id === store.id && row.status !== 'removed_at_source' && typeof row.external_product_id === 'string' && !seen.has(row.external_product_id) && (row.source as Data | undefined)?.kind === 'store_sync').map(row => {
    const removed = ctx.update('product', row.id, { status: 'removed_at_source' });
    for (const variant of ctx.list('product_variant').filter(item => item.product_id === row.id)) ctx.update('product_variant', variant.id, { status: 'removed_at_source' });
    ctx.emit('commerce.product.removed_at_source', { product_id: row.id, store_id: store.id });
    change(ctx, 'product_removed', 'blocking', { product_id: row.id }, row.status, removed.status);
    return removed;
  });
}
