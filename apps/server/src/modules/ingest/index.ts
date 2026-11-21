export { checkUse, commands } from './commands.js';

import type { Operation } from '@smartsell/contracts';
import { importOperations } from './import-operations';
import { sourceOperations } from './source-policy';
import { dispatchDueSyncs, qualityOperations, scanCollectionQuality, syncOperations } from './sync-operations';
import { evidenceOperations, purgeExpiredIngestData } from './evidence';
import { amazonPiiSchedule, amazonPiiSubscriber, backgroundAmazonRetentionDays } from './amazon-privacy';

export const operations: Operation[] = [...sourceOperations, ...importOperations, ...syncOperations, ...qualityOperations, ...evidenceOperations];
export { checkUse as checkSourceUse } from './source-policy';
export { dispatchDueSyncs, receiveVerifiedDelivery, recordCatalogPage, recordStoreTradePage, recordSyncPage } from './sync-operations';
export const subscribers = [amazonPiiSubscriber];
export const schedules = [
  amazonPiiSchedule,
  { id: 'ingest.dispatch_due_syncs', intervalMs: 30_000, run: dispatchDueSyncs },
  { id: 'ingest.scan_quality', intervalMs: 3_600_000, run: scanCollectionQuality },
  { id: 'ingest.purge_expired', intervalMs: 86_400_000, async run(ctx: Parameters<typeof purgeExpiredIngestData>[0]) {
    return purgeExpiredIngestData(ctx, await backgroundAmazonRetentionDays(ctx));
  } },
];
export { captureRawRecord, purgeExpiredIngestData, recordMetricEvidence } from './evidence';
