import type { Operation } from '@smartsell/contracts';
import { createImportBatch } from '../ingest/import-operations.js';
import { requestStoreSync } from '../ingest/sync-operations.js';
import { catalogOperations } from './catalog-operations.js';
import { storeOperations, type CommerceServices } from './store-operations.js';
import { tradeOperations } from './trade-operations.js';

export { applyCatalogPage, reconcileStoreCatalog } from './catalog-sync.js';
export { prepareImport, type ImportTemplate, type ImportMetadata, type PreparedImport } from './imports.js';
export { applyStoreSyncResult, attachAuthorizedStore, type CommerceServices } from './store-operations.js';

export function createCommerceOperations(services: CommerceServices = {}): Operation[] {
  return [
    ...storeOperations({
      requestSync: (ctx, store, mode, body) => requestStoreSync(ctx, store, mode === 'full' ? 'reconcile' : 'refresh', body),
      createImport: (ctx, _store, input) => createImportBatch(ctx, input.body, input.idempotencyKey),
      ...services,
    }),
    ...catalogOperations,
    ...tradeOperations(services),
  ];
}

export const operations: Operation[] = createCommerceOperations();

export { commands } from './commands.js';
