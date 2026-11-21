/** Example payloads for POST /api/v1/workspaces/:wid/commands/ingest/:action.
 * The command host requires Idempotency-Key and wraps successful results in { data }.
 * Commerce order, refund, catalog and inventory reports use the commerce CSV workflow.
 */
export const ingestionUiExamples = {
  sourceForm: {
    action: 'create_source',
    payload: {
      name: 'Authorized social report', provider: 'file_import', kind: 'file_import', method: 'report_import',
      resources: ['post_metrics'], timezone: 'America/New_York', authorized: true, allowed_uses: { display: true },
    },
  },
  capabilityPanel: { action: 'get_source_capability', payload: { data_source_id: '<source.id>' } },
  refresh: {
    action: 'sync_refresh',
    payload: { data_source_id: '<source.id>', resource: 'post_metrics', from: '2026-11-01T04:00:00Z', to: '2026-11-02T05:00:00Z' },
  },
  claim: { action: 'claim_run', payload: { sync_run_id: '<run.id>' } },
  page: {
    action: 'record_metric_page',
    payload: { sync_run_id: '<run.id>', fencing_token: 1, page_index: 1, last_page: true, records: [
      { subject_id: 'post_123', metric_key: 'views', date: '2026-11-01', availability: 'observed', value: 0 },
      { subject_id: 'post_123', metric_key: 'reach', date: '2026-11-01', availability: 'source_not_provided', value: null },
    ] },
  },
  finish: { action: 'finish_run', payload: { sync_run_id: '<run.id>', fencing_token: 1, status: 'succeeded' } },
  health: { action: 'data_health', payload: { data_source_id: '<source.id>', resource: 'post_metrics' } },
  backfill: {
    action: 'start_backfill',
    payload: { data_source_id: '<source.id>', resources: ['post_metrics'], from: '2026-11-01T04:00:00Z', to: '2026-11-15T05:00:00Z' },
  },
  backfillProgress: { action: 'backfill_status', payload: { operation_id: '<result.operation_id>' } },
  coverage: {
    action: 'get_coverage',
    payload: { data_source_id: '<source.id>', resource: 'post_metrics', from: '2026-11-01T04:00:00Z', to: '2026-11-15T05:00:00Z' },
  },
  evidenceDrawer: { action: 'get_provenance', payload: { observation_id: '<observation.id>' } },
} as const;

/** Display availability independently of the value. An observed 0 is a valid measurement. */
export const metricAvailabilityLabels = {
  observed: '已觀測', not_collected: '未採集', no_permission: '無權限', not_applicable: '不適用',
  sync_failed: '同步失敗', source_not_provided: '來源未提供',
} as const;

/** Freshness uses the successful ingestion timestamp. Platform update time may still be unknown. */
export const ingestionFreshnessLabels = { fresh: '近期已同步', stale: '同步已逾期', not_collected: '尚未同步', unavailable: '無法同步' } as const;
